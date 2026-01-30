/**
 * Cancel orders module for Predict.fun API.
 * Uses the SDK to cancel orders on-chain, grouped by isNegRisk and isYieldBearing.
 */
import { Wallet, JsonRpcProvider } from "ethers";
import { OrderBuilder, ChainId, Order } from "@predictdotfun/sdk";
import axios from "axios";
import * as dotenv from "dotenv";
import { getAuthJWT } from "./auth";
import { OrderStorage } from "./order_storage";
import { log } from "console";

dotenv.config();

// Configuration
const API_KEY = process.env.PREDICT_API_KEY || "";
const PRIVATE_KEY = process.env.PREDICT_PRIVATE_KEY || "";
const ACCOUNT_ADDRESS = process.env.PREDICT_ACCOUNT_ADDRESS || "";
const NETWORK = process.env.PREDICT_NETWORK || "mainnet";
const RPC_URL = process.env.RPC_PROVIDER_URL || "https://bsc-dataseed.binance.org";

const API_URLS: Record<string, string> = {
    mainnet: "https://api.predict.fun",
    testnet: "https://api-testnet.predict.fun",
};

const BASE_URL = API_URLS[NETWORK] || API_URLS.mainnet;

// Types
interface OrderData {
    order: any;  // Use any for now since Order type doesn't have hash
    id: string;
    marketId: number;
    isNegRisk: boolean;
    isYieldBearing: boolean;
    status: string;
    [key: string]: any;
}

interface GroupedOrders {
    regular: any[];
    negRisk: any[];
    regularYieldBearing: any[];
    negRiskYieldBearing: any[];
}

interface CancelResult {
    success: boolean;
    results?: any;
    message?: string;
}

export class PredictCancelOrders {
    private apiKey: string;
    private accountAddress: string;
    private baseUrl: string;
    private builder: OrderBuilder | null = null;
    private jwtToken: string = "";
    private storage: OrderStorage;

    constructor() {
        this.apiKey = API_KEY;
        this.accountAddress = ACCOUNT_ADDRESS;
        this.baseUrl = BASE_URL;
        this.storage = new OrderStorage();
    }

    /**
     * Initialize the OrderBuilder (must be called before using cancel methods)
     */
    async initialize(): Promise<void> {
        const provider = new JsonRpcProvider(RPC_URL);
        const signer = new Wallet(PRIVATE_KEY).connect(provider);

        // Create OrderBuilder instance
        this.builder = await OrderBuilder.make(ChainId.BnbMainnet, signer, {
            predictAccount: ACCOUNT_ADDRESS,
        });

        // Get JWT token using the separate auth module
        this.jwtToken = await getAuthJWT(
            this.builder,
            this.apiKey,
            this.accountAddress,
            this.baseUrl
        );
        console.log(`Authenticated as ${ACCOUNT_ADDRESS}`);
    }



    /**
     * Get headers for API requests
     */
    private getHeaders(): Record<string, string> {
        return {
            "x-api-key": this.apiKey,
            Authorization: `Bearer ${this.jwtToken}`,
            "Content-Type": "application/json",
        };
    }

    /**
     * Fetch all open orders for the current account
     */
    async getOpenOrders(): Promise<OrderData[]> {
        const response = await axios.get(`${this.baseUrl}/v1/orders`, {
            headers: this.getHeaders(),
            params: { status: "OPEN" },
        });

        if (!response.data.success) {
            throw new Error(`Failed to get orders: ${JSON.stringify(response.data)}`);
        }

        return response.data.data;
    }

    /**
     * Group orders by isNegRisk and isYieldBearing properties
     */
    private groupOrdersByType(orders: OrderData[]): GroupedOrders {
        const grouped: GroupedOrders = {
            regular: [],              // isNegRisk=false, isYieldBearing=false
            negRisk: [],              // isNegRisk=true, isYieldBearing=false
            regularYieldBearing: [],  // isNegRisk=false, isYieldBearing=true
            negRiskYieldBearing: [],  // isNegRisk=true, isYieldBearing=true
        };

        for (const orderData of orders) {
            const isNegRisk = orderData.isNegRisk || false;
            const isYieldBearing = orderData.isYieldBearing || false;
            const order = orderData.order;

            if (isYieldBearing) {
                if (isNegRisk) {
                    grouped.negRiskYieldBearing.push(order);
                } else {
                    grouped.regularYieldBearing.push(order);
                }
            } else {
                if (isNegRisk) {
                    grouped.negRisk.push(order);
                } else {
                    grouped.regular.push(order);
                }
            }
        }

        return grouped;
    }

    /**
     * Cancel multiple orders, automatically grouping by isNegRisk and isYieldBearing
     */
    async cancelOrders(orders: OrderData[]): Promise<CancelResult> {
        if (!this.builder) {
            throw new Error("OrderBuilder not initialized. Call initialize() first.");
        }

        if (!orders || orders.length === 0) {
            console.log("No orders to cancel");
            return { success: true, message: "No orders to cancel" };
        }

        // Group orders by type
        const grouped = this.groupOrdersByType(orders);

        const results: any = {};
        let allSuccess = true;

        // Helper to remove orders from storage
        const removeOrdersFromStorage = (orders: any[]) => {
            if (!orders || orders.length === 0) return;
            for (const order of orders) {
                if (order && order.hash) {
                    this.storage.deleteOrder(order.hash);
                }
            }
        };

        // Cancel regular orders (isNegRisk=false, isYieldBearing=false)
        if (grouped.regular.length > 0) {
            console.log(`Cancelling ${grouped.regular.length} regular orders...`);
            const result = await this.builder.cancelOrders(grouped.regular, {
                isNegRisk: false,
                isYieldBearing: false,
            });
            results.regular = result;
            const success = result && result.success !== false;
            if (!success) {
                allSuccess = false;
                console.log(`  → Regular: ✗`);
            } else {
                console.log(`  → Regular: ✓`);
                removeOrdersFromStorage(grouped.regular);
            }
        }

        // Cancel negRisk orders (isNegRisk=true, isYieldBearing=false)
        if (grouped.negRisk.length > 0) {
            console.log(`Cancelling ${grouped.negRisk.length} negRisk orders...`);
            const result = await this.builder.cancelOrders(grouped.negRisk, {
                isNegRisk: true,
                isYieldBearing: false,
            });
            results.negRisk = result;
            const success = result && result.success !== false;
            if (!success) {
                allSuccess = false;
                console.log(`  → NegRisk: ✗`);
            } else {
                console.log(`  → NegRisk: ✓`);
                removeOrdersFromStorage(grouped.negRisk);
            }
        }

        // Cancel regularYieldBearing orders (isNegRisk=false, isYieldBearing=true)
        if (grouped.regularYieldBearing.length > 0) {
            console.log(`Cancelling ${grouped.regularYieldBearing.length} regularYieldBearing orders...`);
            try {
                const result = await this.builder.cancelOrders(grouped.regularYieldBearing, {
                    isNegRisk: false,
                    isYieldBearing: true,
                });
                results.regularYieldBearing = result;
                const success = result && result.success !== false;
                if (!success) {
                    allSuccess = false;
                    console.log(`  → RegularYieldBearing: ✗`);
                } else {
                    console.log(`  → RegularYieldBearing: ✓`);
                    removeOrdersFromStorage(grouped.regularYieldBearing);
                }
            } catch (error) {
                console.error("Error cancelling regularYieldBearing orders:", error);
                results.regularYieldBearing = { success: false, error: error };
                allSuccess = false;
                console.log(`  → RegularYieldBearing: ✗`);
            }
        }

        // Cancel negRiskYieldBearing orders (isNegRisk=true, isYieldBearing=true)
        if (grouped.negRiskYieldBearing.length > 0) {
            console.log(`Cancelling ${grouped.negRiskYieldBearing.length} negRiskYieldBearing orders...`);
            const result = await this.builder.cancelOrders(grouped.negRiskYieldBearing, {
                isNegRisk: true,
                isYieldBearing: true,
            });
            results.negRiskYieldBearing = result;
            const success = result && result.success !== false;
            if (!success) {
                allSuccess = false;
                console.log(`  → NegRiskYieldBearing: ✗`);
            } else {
                console.log(`  → NegRiskYieldBearing: ✓`);
                removeOrdersFromStorage(grouped.negRiskYieldBearing);
            }
        }

        return {
            success: allSuccess,
            results,
        };
    }

    /**
     * Cancel ALL open orders for the current account
     */
    async cancelAllOpenOrders(): Promise<CancelResult> {
        console.log("Fetching open orders...");
        const openOrders = await this.getOpenOrders();

        if (!openOrders || openOrders.length === 0) {
            console.log("No open orders to cancel");
            return { success: true, message: "No open orders" };
        }

        console.log(`Found ${openOrders.length} open orders`);
        return this.cancelOrders(openOrders);
    }

    /**
     * Cancel specific orders by their hashes
     */
    async cancelOrdersByHashes(orderHashes: string[]): Promise<CancelResult> {
        // Fetch all open orders and filter by hash
        const openOrders = await this.getOpenOrders();

        const ordersToCancel = openOrders.filter((order) =>
            orderHashes.includes(order.order.hash)
        );

        if (ordersToCancel.length === 0) {
            console.log("No matching orders found");
            return { success: true, message: "No matching orders" };
        }

        console.log(`Found ${ordersToCancel.length} orders to cancel`);
        return this.cancelOrders(ordersToCancel);
    }
}

// Example usage
async function main() {
    const canceller = new PredictCancelOrders();
    await canceller.initialize();

    // Option 1: Cancel all open orders
    const result = await canceller.cancelAllOpenOrders();

    // Option 2: Cancel specific orders by hash
    // const result = await canceller.cancelOrdersByHashes([
    //     "0xe065f622dc505a9e0f89f819c948d3202d6490add227f5f03b5e98a8ec7b70b3",
    // ]);

    // Option 3: Get open orders first, then decide which to cancel
    // const openOrders = await canceller.getOpenOrders();
    // console.log(`\nOpen orders: ${openOrders.length}`);
    // for (const order of openOrders) {
    //   console.log(`  - ${order.id}: ${order.order.hash.substring(0, 30)}...`);
    // }

    console.log("\nResult:", result);
}

// Run if this file is executed directly
if (require.main === module) {
    main().catch(console.error);
}
