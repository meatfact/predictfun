/**
 * Order storage module for tracking orders in a JSON file.
 * Orders are grouped by market. Each market has market_id, market_title, and an orders array.
 */
import * as fs from "fs";

interface Order {
    orderId: string;
    orderHash: string;
    updated_at?: string;
    [key: string]: any;
}

interface Market {
    market_id: number;
    market_title: string;
    orders: Order[];
}

/**
 * Manages order storage in a JSON file.
 * 
 * Structure:
 * [
 *   {
 *     "market_id": 874,
 *     "market_title": "Will Gold be above $4,400 on January 30th, 2026?",
 *     "orders": [
 *       {
 *         "orderId": "2711373",
 *         "orderHash": "0x..."
 *         // More fields added later via updateOrderDetails
 *       }
 *     ]
 *   }
 * ]
 */
export class OrderStorage {
    private filepath: string;

    constructor(filepath: string = "orders.json") {
        this.filepath = filepath;
        this.ensureFileExists();
    }

    /**
     * Create the JSON file if it doesn't exist
     */
    private ensureFileExists(): void {
        if (!fs.existsSync(this.filepath)) {
            this.writeMarkets([]);
            console.log(`Created new order storage file: ${this.filepath}`);
        }
    }

    /**
     * Read all markets from the JSON file
     */
    private readMarkets(): Market[] {
        try {
            const data = fs.readFileSync(this.filepath, "utf-8");
            return JSON.parse(data);
        } catch (error) {
            if (error instanceof SyntaxError) {
                console.log(`Warning: Invalid JSON in ${this.filepath}, resetting to empty list`);
                return [];
            }
            console.log(`Error reading markets: ${error}`);
            return [];
        }
    }

    /**
     * Write markets to the JSON file
     */
    private writeMarkets(markets: Market[]): void {
        fs.writeFileSync(this.filepath, JSON.stringify(markets, null, 2), "utf-8");
    }

    /**
     * Find a market by its ID
     */
    private findMarket(markets: Market[], marketId: number): Market | null {
        return markets.find((m) => m.market_id === marketId) || null;
    }

    /**
     * Add a new order to the storage (minimal info only)
     */
    addOrder(orderData: any, marketId: number, marketTitle: string): void {
        const markets = this.readMarkets();

        // Create minimal order record (only orderId and orderHash)
        const orderRecord: Order = {
            orderId: orderData.orderId,
            orderHash: orderData.orderHash,
        };

        // Find or create market entry
        const market = this.findMarket(markets, marketId);

        if (market) {
            // Add order to existing market
            market.orders.push(orderRecord);
        } else {
            // Create new market entry
            const newMarket: Market = {
                market_id: marketId,
                market_title: marketTitle,
                orders: [orderRecord],
            };
            markets.push(newMarket);
        }

        this.writeMarkets(markets);
        console.log(`✓ Order saved to ${this.filepath} (ID: ${orderData.orderId}, Market: ${marketId})`);
    }

    /**
     * Update an order with full details from getOrderByHash API response
     */
    updateOrderDetails(orderHash: string, details: any): boolean {
        const markets = this.readMarkets();

        for (const market of markets) {
            for (const order of market.orders) {
                if (order.orderHash === orderHash) {
                    // Update order with all details from API
                    Object.assign(order, details);
                    order.updated_at = new Date().toISOString();
                    this.writeMarkets(markets);
                    console.log(`✓ Order ${orderHash.substring(0, 20)}... updated with details`);
                    return true;
                }
            }
        }

        console.log(`Warning: Order ${orderHash.substring(0, 20)}... not found`);
        return false;
    }

    /**
     * Get all markets with their orders from storage
     */
    getAllMarkets(): Market[] {
        return this.readMarkets();
    }

    /**
     * Get a specific market by its ID
     */
    getMarketById(marketId: number): Market | null {
        const markets = this.readMarkets();
        return this.findMarket(markets, marketId);
    }

    /**
     * Get all orders for a specific market
     */
    getOrdersForMarket(marketId: number): Order[] {
        const market = this.getMarketById(marketId);
        return market ? market.orders : [];
    }

    /**
     * Get a specific order by its hash
     */
    getOrderByHash(orderHash: string): Order | null {
        const markets = this.readMarkets();
        for (const market of markets) {
            const order = market.orders.find((o) => o.orderHash === orderHash);
            if (order) return order;
        }
        return null;
    }

    /**
     * Get a specific order by its ID
     */
    getOrderById(orderId: string): Order | null {
        const markets = this.readMarkets();
        for (const market of markets) {
            const order = market.orders.find((o) => o.orderId === orderId);
            if (order) return order;
        }
        return null;
    }

    /**
     * Delete an order from storage by its hash
     */
    deleteOrder(orderHash: string): boolean {
        const markets = this.readMarkets();

        for (const market of markets) {
            const originalCount = market.orders.length;
            market.orders = market.orders.filter((o) => o.orderHash !== orderHash);

            if (market.orders.length < originalCount) {
                // Remove market if no orders left
                const filteredMarkets = market.orders.length === 0
                    ? markets.filter((m) => m.market_id !== market.market_id)
                    : markets;

                this.writeMarkets(filteredMarkets);
                console.log(`✓ Order ${orderHash.substring(0, 20)}... deleted`);
                return true;
            }
        }

        console.log(`Warning: Order ${orderHash.substring(0, 20)}... not found`);
        return false;
    }

    /**
     * Get the total number of orders across all markets
     */
    getOrdersCount(): number {
        const markets = this.readMarkets();
        return markets.reduce((count, market) => count + market.orders.length, 0);
    }

    /**
     * Get the total number of markets in storage
     */
    getMarketsCount(): number {
        return this.readMarkets().length;
    }

    /**
     * Clear all markets and orders from storage (use with caution!)
     */
    clearAll(): void {
        this.writeMarkets([]);
        console.log(`✓ All data cleared from ${this.filepath}`);
    }
}
