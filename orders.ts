/**
 * Orders module for Predict.fun API.
 * Handles opening orders and fetching order details by hash.
 */
import { Wallet, JsonRpcProvider } from "ethers";
import { OrderBuilder, ChainId, Side, OrderStrategy, Order } from "@predictdotfun/sdk";
import axios from "axios";
import * as dotenv from "dotenv";
import { getAuthJWT } from "./auth";
import { OrderStorage } from "./order_storage";
import {
    API_KEY,
    PRIVATE_KEY,
    ACCOUNT_ADDRESS,
    NETWORK,
    RPC_URL,
    BASE_URL,
    validateConfig,
} from "./config";

dotenv.config();

// Types
interface OpenOrderParams {
    marketId: number;
    side: Side; // Side.BUY (YES) or Side.SELL (NO)
    amount: string; // Amount in USD (e.g., "10")
    price: string; // Price between 0 and 1 (e.g., "0.65")
    orderType?: OrderStrategy; // "LIMIT" or "MARKET"
    isNegRisk?: boolean;
    isYieldBearing?: boolean;
}

interface OrderResponse {
    success: boolean;
    data?: any;
    error?: any;
    message?: string;
}

interface OrderDetailsResponse {
    success: boolean;
    data?: any;
    error?: any;
}

export interface OrderData {
    order: any;
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

export interface CancelResult {
    success: boolean;
    results?: any;
    message?: string;
}

export class PredictOrders {
    private apiKey: string;
    private accountAddress: string;
    private baseUrl: string;
    private builder: OrderBuilder | null = null;
    private jwtToken: string = "";
    private storage: OrderStorage;

    constructor(storageFilePath: string = "orders.json") {
        this.apiKey = API_KEY;
        this.accountAddress = ACCOUNT_ADDRESS;
        this.baseUrl = BASE_URL;
        this.storage = new OrderStorage(storageFilePath);
    }
    // ... (re-added methods)
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
                    // console.log(`✓ Order ${order.hash.substring(0, 10)}... removed from storage`);
                }
            }
        };

        // Cancel regular orders (isNegRisk=false, isYieldBearing=false)
        if (grouped.regular.length > 0) {
            // console.log(`Cancelling ${grouped.regular.length} regular orders...`);
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
                // console.log(`  → Regular: ✓`);
                removeOrdersFromStorage(grouped.regular);
            }
        }

        // Cancel negRisk orders (isNegRisk=true, isYieldBearing=false)
        if (grouped.negRisk.length > 0) {
            // console.log(`Cancelling ${grouped.negRisk.length} negRisk orders...`);
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
                // console.log(`  → NegRisk: ✓`);
                removeOrdersFromStorage(grouped.negRisk);
            }
        }

        // Cancel regularYieldBearing orders (isNegRisk=false, isYieldBearing=true)
        if (grouped.regularYieldBearing.length > 0) {
            // console.log(`Cancelling ${grouped.regularYieldBearing.length} regularYieldBearing orders...`);
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
                    // console.log(`  → RegularYieldBearing: ✓`);
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
            // console.log(`Cancelling ${grouped.negRiskYieldBearing.length} negRiskYieldBearing orders...`);
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
                // console.log(`  → NegRiskYieldBearing: ✓`);
                removeOrdersFromStorage(grouped.negRiskYieldBearing);
            }
        }

        return {
            success: allSuccess,
            results,
        };
    }

    /**
     * Initialize the OrderBuilder (must be called before using order methods)
     */
    async initialize(): Promise<void> {
        validateConfig();

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
        console.log(`✓ Authenticated as ${ACCOUNT_ADDRESS}`);
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
     * Fetch market data including tokenId and feeRateBps
     * @private
     */
    private async getMarketData(marketId: number, side: Side) {
        try {
            const response = await axios.get(`${this.baseUrl}/v1/markets/${marketId}`, {
                headers: this.getHeaders(),
            });

            if (!response.data.success) {
                throw new Error(`Failed to fetch market data: ${JSON.stringify(response.data)}`);
            }

            const market = response.data.data;

            // Debug: log the market structure to see what we're getting
            console.log("Market data structure:", JSON.stringify(market, null, 2));

            // Get the tokenId for the specific side (YES or NO)
            // The API returns onChainId inside the outcomes array
            let tokenId: string;
            if (side === Side.BUY) {
                // Side.BUY (0) corresponds to "Yes" outcome (index 0)
                tokenId = market.outcomes?.find((o: any) => o.name === "Yes")?.onChainId || market.outcomes?.[0]?.onChainId;
            } else {
                // Side.SELL (1) corresponds to "No" outcome (index 1)
                tokenId = market.outcomes?.find((o: any) => o.name === "No")?.onChainId || market.outcomes?.[1]?.onChainId;
            }

            if (!tokenId) {
                throw new Error(`Could not find tokenId for side ${side === Side.BUY ? "BUY (YES)" : "SELL (NO)"}. Market data: ${JSON.stringify(market)}`);
            }

            const feeRateBps = market.feeRateBps || 0;
            const isNegRisk = market.isNegRisk || false;
            const isYieldBearing = market.isYieldBearing || false;
            const title = market.title;

            return { tokenId, feeRateBps, isNegRisk, isYieldBearing, title };
        } catch (error: any) {
            throw new Error(`Failed to get market data: ${error.message}`);
        }
    }

    /**
     * Open a new order on Predict.fun
     */
    async openOrder(params: OpenOrderParams): Promise<OrderResponse> {
        if (!this.builder) {
            throw new Error("OrderBuilder not initialized. Call initialize() first.");
        }

        try {
            // Step 1: Fetch market data (tokenId, feeRateBps, etc.)
            const marketData = await this.getMarketData(params.marketId, params.side);
            // console.log(`✓ Fetched market data`);

            // Use params or market data for negRisk/yieldBearing
            const isNegRisk = params.isNegRisk ?? marketData.isNegRisk;
            const isYieldBearing = params.isYieldBearing ?? marketData.isYieldBearing;

            // Step 2: Convert amounts to wei (assuming 18 decimals for USDT)
            const pricePerShareWei = BigInt(Math.floor(parseFloat(params.price) * 1e18));
            const quantityWei = BigInt(Math.floor(parseFloat(params.amount) / parseFloat(params.price) * 1e18));

            // Step 3: Calculate order amounts using SDK helper
            let orderAmounts;
            if (params.orderType === "MARKET") {
                // For MARKET orders, we need the orderbook
                const bookResponse = await axios.get(
                    `${this.baseUrl}/v1/markets/${params.marketId}/orderbook`,
                    { headers: this.getHeaders() }
                );
                const book = bookResponse.data.data;

                orderAmounts = this.builder.getMarketOrderAmounts(
                    {
                        side: params.side,
                        quantityWei: quantityWei,
                    },
                    book
                );
            } else {
                // LIMIT order
                orderAmounts = this.builder.getLimitOrderAmounts({
                    side: params.side,
                    pricePerShareWei: pricePerShareWei,
                    quantityWei: quantityWei,
                });
            }

            // console.log(`✓ Calculated order amounts (price: ${orderAmounts.pricePerShare})`);


            // Precision handling: makerAmount must be multiple of 1e13
            const PRECISION = 10000000000000n; // 1e13
            let makerAmount = orderAmounts.makerAmount;
            const remainder = makerAmount % PRECISION;
            if (remainder !== 0n) {
                makerAmount = makerAmount - remainder;
            }

            // Recalculate takerAmount to strict consistency with pricePerShare
            // This ensures Maker/Taker vs Price check passes AND Limit Condition passes
            let takerAmount = orderAmounts.takerAmount;
            const price = orderAmounts.pricePerShare;

            if (params.side === Side.BUY) {
                // BUY: Maker=USDT, Taker=Share. Price=USDT/Share.
                // Taker = Maker / Price.
                // We strictly need Real Price (Maker/Taker) <= Limit Price.
                // Maker/Taker <= Price  =>  Maker <= Taker * Price  =>  Taker >= Maker/Price.
                // So Taker = Ceil(Maker * 1e18 / Price).
                takerAmount = (makerAmount * 1000000000000000000n + price - 1n) / price;
            } else {
                // SELL: Maker=Share, Taker=USDT. Price=USDT/Share.
                // Taker = Maker * Price.
                // We strictly need Real Price (Taker/Maker) >= Limit Price.
                // Taker/Maker >= Price  =>  Taker >= Maker * Price.
                // So Taker = Ceil(Maker * Price / 1e18).
                takerAmount = (makerAmount * price + 1000000000000000000n - 1n) / 1000000000000000000n;
            }

            // Step 4: Build the order
            const order = this.builder.buildOrder(params.orderType || "LIMIT", {
                maker: this.accountAddress,
                signer: this.accountAddress,
                side: params.side,
                tokenId: marketData.tokenId,
                makerAmount: makerAmount,
                takerAmount: takerAmount,
                nonce: 0n,
                feeRateBps: marketData.feeRateBps,
            });

            // Step 5: Build typed data for the order
            const typedData = this.builder.buildTypedData(order, {
                isNegRisk: isNegRisk,
                isYieldBearing: isYieldBearing,
            });

            // Step 6: Sign the order
            const signedOrder = await this.builder.signTypedDataOrder(typedData);

            // Step 7: Compute the order hash
            const hash = this.builder.buildTypedDataHash(typedData);

            // console.log(`✓ Order created and signed (hash: ${hash.substring(0, 30)}...)`);

            // Step 8: Submit the order to the API in the correct format
            const createOrderBody: any = {
                data: {
                    order: { ...signedOrder, hash },
                    pricePerShare: price.toString(), // Use original price
                    strategy: params.orderType || "LIMIT",
                },
            };

            // Add slippage for MARKET orders
            if (params.orderType === "MARKET") {
                createOrderBody.data.slippageBps = "200"; // 2% slippage
            }

            const response = await axios.post(
                `${this.baseUrl}/v1/orders`,
                createOrderBody,
                { headers: this.getHeaders() }
            );

            if (!response.data.success) {
                throw new Error(`Failed to submit order: ${JSON.stringify(response.data)}`);
            }

            const orderData = response.data.data;
            // The API returns orderId, not id, OR sometimes id (being safe)
            const orderId = orderData.orderId || orderData.id;

            console.log(`✓ Order submitted (ID: ${orderId}, Hash: ${hash.substring(0, 10)}...)`);

            // Save minimal info to storage
            this.storage.addOrder(
                {
                    orderId: orderId,
                    orderHash: hash,
                },
                params.marketId,
                marketData.title || orderData.marketTitle || `Market ${params.marketId}`
            );

            return {
                success: true,
                data: {
                    orderId: orderId,
                    orderHash: hash,
                    ...orderData,
                },
            };
        } catch (error: any) {
            if (error.response) {
                const errorLog = {
                    status: error.response.status,
                    data: error.response.data,
                    timestamp: new Date().toISOString()
                };
                const fs = require('fs');
                fs.appendFileSync('error_log.json', JSON.stringify(errorLog, null, 2) + "\n");
                console.error(`✗ Error opening order: Status ${error.response.status}`, JSON.stringify(error.response.data, null, 2));
            } else {
                console.error(`✗ Error opening order:`, error.message || error);
            }
            return {
                success: false,
                error: error.response?.data?.message || error.message || error,
                message: "Failed to open order",
            };
        }
    }

    /**
     * Get order details by hash from the API
     */
    async getOrderByHash(orderHash: string): Promise<OrderDetailsResponse> {
        try {
            console.log(`\nFetching order details for hash: ${orderHash.substring(0, 30)}...`);

            const response = await axios.get(
                `${this.baseUrl}/v1/orders/${orderHash}`,
                { headers: this.getHeaders() }
            );

            if (!response.data.success) {
                throw new Error(`Failed to get order: ${JSON.stringify(response.data)}`);
            }

            const orderDetails = response.data.data;
            // console.log(`✓ Order details fetched successfully (ID: ${orderDetails.id})`);

            // Update storage with full order details
            this.storage.updateOrderDetails(orderHash, orderDetails);

            return {
                success: true,
                data: orderDetails,
            };
        } catch (error: any) {
            console.error(`✗ Error fetching order:`, error.message || error);
            return {
                success: false,
                error: error.message || error,
            };
        }
    }

    /**
     * Get all open orders for the current account
     */
    async getOpenOrders(): Promise<OrderDetailsResponse> {
        try {
            const response = await axios.get(`${this.baseUrl}/v1/orders`, {
                headers: this.getHeaders(),
                params: { status: "OPEN" },
            });

            if (!response.data.success) {
                throw new Error(`Failed to get orders: ${JSON.stringify(response.data)}`);
            }

            const orders = response.data.data;
            console.log(`✓ Found ${orders.length} open orders`);

            return {
                success: true,
                data: orders,
            };
        } catch (error: any) {
            console.error(`✗ Error fetching open orders:`, error.message || error);
            return {
                success: false,
                error: error.message || error,
            };
        }
    }

    /**
     * Get all open orders recursively using cursor pagination
     */
    async getOpenOrdersRecursively(cursor?: string, accumulatedOrders: any[] = []): Promise<OrderDetailsResponse> {
        try {
            const params: any = { status: "OPEN" };
            if (cursor) {
                params.after = cursor;
            }

            const response = await axios.get(`${this.baseUrl}/v1/orders`, {
                headers: this.getHeaders(),
                params: params,
            });

            if (!response.data.success) {
                throw new Error(`Failed to get orders: ${JSON.stringify(response.data)}`);
            }

            const orders = response.data.data;
            const nextCursor = response.data.cursor; // API returns 'cursor' for the next page

            accumulatedOrders.push(...orders);

            if (nextCursor) {
                // Add a small delay to avoid rate limits if getting many pages
                await new Promise(resolve => setTimeout(resolve, 200));
                return this.getOpenOrdersRecursively(nextCursor, accumulatedOrders);
            }

            return {
                success: true,
                data: accumulatedOrders,
            };
        } catch (error: any) {
            console.error(`✗ Error fetching open orders recursively:`, error.message || error);
            // Return what we have so far if it fails? Or just fail.
            // Failing is safer to avoid thinking we have partial view as full view.
            return {
                success: false,
                error: error.message || error,
                data: accumulatedOrders.length > 0 ? accumulatedOrders : undefined
            };
        }
    }

    /**
     * Cancel an order by hash
     */
    async cancelOrder(orderHash: string): Promise<OrderResponse> {
        try {
            console.log(`\nCanceling order: ${orderHash.substring(0, 20)}...`);

            const response = await axios.post(
                `${this.baseUrl}/v1/orders/remove`,
                { orderHash },
                { headers: this.getHeaders() }
            );
            console.log('1')
            console.log(response);

            if (response.data.success) {
                // console.log(`✓ Order canceled successfully`);

                // Remove from storage
                this.storage.deleteOrder(orderHash);
                // console.log(`✓ Order removed from storage`);

                return {
                    success: true,
                    data: response.data.data,
                    message: "Order canceled successfully",
                };
            } else {
                throw new Error(response.data.message || "Failed to cancel order");
            }
        } catch (error: any) {
            console.error(`✗ Error canceling order:`, error.message || error);
            return {
                success: false,
                error: error.message || error,
                message: "Failed to cancel order",
            };
        }
    }

    /**
     * Get all positions for the current account
     */
    async getPositions(): Promise<OrderDetailsResponse> {
        try {
            console.log("\nFetching positions...");
            const response = await axios.get(`${this.baseUrl}/v1/positions`, {
                headers: this.getHeaders(),
            });

            if (!response.data.success) {
                throw new Error(`Failed to get positions: ${JSON.stringify(response.data)}`);
            }

            const positions = response.data.data;
            console.log(`✓ Found ${positions.length} position(s)`);

            return {
                success: true,
                data: positions,
            };
        } catch (error: any) {
            console.error(`✗ Error fetching positions:`, error.message || error);
            return {
                success: false,
                error: error.message || error,
            };
        }
    }

    /**
     * Get order details by ID from storage
     */
    getStoredOrderById(orderId: string) {
        return this.storage.getOrderById(orderId);
    }

    /**
     * Get order details by hash from storage
     */
    getStoredOrderByHash(orderHash: string) {
        return this.storage.getOrderByHash(orderHash);
    }

    /**
     * Get all stored markets
     */
    getAllStoredMarkets() {
        return this.storage.getAllMarkets();
    }

    /**
     * Get order storage instance for direct access
     */
    getStorage(): OrderStorage {
        return this.storage;
    }
}

// Example usage
async function main() {
    const orders = new PredictOrders();
    await orders.initialize();

    // Example 1: Open a new order
    // const result = await orders.openOrder({
    //     marketId: 874,
    //     side: Side.BUY,  // Side.BUY for YES, Side.SELL for NO
    //     amount: "5",
    //     price: "0.5",
    //     orderType: "LIMIT",  // "LIMIT" or "MARKET"
    // });
    // console.log("\nOrder Result:", result);

    // Example 2: Get order details by hash
    // const orderHash = "0xe065f622dc505a9e0f89f819c948d3202d6490add227f5f03b5e98a8ec7b70b3";
    // const orderDetails = await orders.getOrderByHash(orderHash);
    // console.log("\nOrder Details:", orderDetails);

    // Example 3: Get all open orders
    const openOrders = await orders.getOpenOrders();
    console.log("\nOpen Orders:", openOrders);

    // Example 4: Get stored order from local storage
    // const storedOrder = orders.getStoredOrderByHash(orderHash);
    // console.log("\nStored Order:", storedOrder);
}

// Run if this file is executed directly
if (require.main === module) {
    main().catch(console.error);
}
