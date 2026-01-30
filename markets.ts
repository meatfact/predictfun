import axios from "axios";
import * as fs from "fs";
import { BASE_URL, API_KEY, MIN_LIQUIDITY_USD, MIN_VOLUME_USD, MIN_ORDERBOOK_VALUE_USD, MIN_BID_PRICE } from "./config";

interface Market {
    id: number;
    title: string;
    status: string;
    [key: string]: any;
}

interface MarketStats {
    totalLiquidityUsd: number;
    volumeTotalUsd: number;
    volume24hUsd: number;
}

interface Orderbook {
    marketId: number;
    bids: Array<[number, number]>; // [price, quantity]
    asks: Array<[number, number]>;
}

const CONCURRENCY_LIMIT = 5;

async function fetchAllMarkets(): Promise<Market[]> {
    const allMarkets: Market[] = [];
    let cursor: string | null = null;
    let hasMore = true;

    try {
        console.log("Fetching all markets...");

        while (hasMore) {
            const params: any = { limit: 100 };
            if (cursor) {
                params.after = cursor;
            }

            console.log(`Fetching page with cursor: ${cursor || "start"}`);
            const response = await axios.get(`${BASE_URL}/v1/markets`, {
                headers: { "x-api-key": API_KEY },
                params: params
            });

            if (!response.data.success) {
                throw new Error(`Failed to fetch markets: ${response.data.message}`);
            }

            const markets = response.data.data;
            allMarkets.push(...markets);
            console.log(`Fetched ${markets.length} markets. Total so far: ${allMarkets.length}`);

            if (response.data.cursor) {
                cursor = response.data.cursor;
            } else {
                hasMore = false;
            }
        }

        return allMarkets;
    } catch (error: any) {
        console.error("Error fetching markets:", error.message || error);
        return allMarkets;
    }
}

async function getMarketStats(marketId: number): Promise<MarketStats | null> {
    try {
        const response = await axios.get(`${BASE_URL}/v1/markets/${marketId}/stats`, {
            headers: { "x-api-key": API_KEY }
        });

        if (response.data.success) {
            return response.data.data as MarketStats;
        }
        return null;
    } catch (error: any) {
        return null;
    }
}

async function getMarketOrderbook(marketId: number): Promise<Orderbook | null> {
    try {
        const response = await axios.get(`${BASE_URL}/v1/markets/${marketId}/orderbook`, {
            headers: { "x-api-key": API_KEY }
        });

        if (response.data.success) {
            return response.data.data as Orderbook;
        }
        return null;
    } catch (error: any) {
        return null;
    }
}

async function filterMarkets(markets: Market[]): Promise<Market[]> {
    // 1. Filter by status 'REGISTERED'
    console.log("Filtering markets with status 'REGISTERED'...");
    const registeredMarkets = markets.filter((market) => market.status === "REGISTERED");
    console.log(`Found ${registeredMarkets.length} REGISTERED markets.`);

    // 2. Filter by Stats & Orderbook
    console.log(`Filtering by:`);
    console.log(`  - Liquidity > $${MIN_LIQUIDITY_USD}`);
    console.log(`  - Volume > $${MIN_VOLUME_USD}`);
    console.log(`  - Top 6 Bids Value > $${MIN_ORDERBOOK_VALUE_USD}`);
    console.log(`  - Top 6 Bids Price > ${MIN_BID_PRICE}`);

    const finalMarkets: Market[] = [];

    // Process in chunks to avoid rate limits
    for (let i = 0; i < registeredMarkets.length; i += CONCURRENCY_LIMIT) {
        const chunk = registeredMarkets.slice(i, i + CONCURRENCY_LIMIT);
        const promises = chunk.map(async (market) => {
            // Check Stats first (cheaper/faster check)
            const stats = await getMarketStats(market.id);
            if (!stats) return null;

            if (stats.totalLiquidityUsd > MIN_LIQUIDITY_USD && stats.volumeTotalUsd > MIN_VOLUME_USD) {

                // Check Orderbook (expensive check)
                const orderbook = await getMarketOrderbook(market.id);
                if (!orderbook || !orderbook.bids) return null;

                // Process top 6 bids
                let bidSum = 0;
                let minBidPriceMet = true;
                const topBids = orderbook.bids.slice(0, 6);
                const processedBids: { price: number; quantity: number; value: number }[] = [];

                for (const bid of topBids) {
                    const price = Number(bid[0]);
                    const quantity = Number(bid[1]);

                    if (price <= MIN_BID_PRICE) {
                        minBidPriceMet = false;
                        break;
                    }
                    const value = price * quantity;
                    bidSum += value;
                    processedBids.push({ price, quantity, value });
                }

                if (minBidPriceMet && bidSum > MIN_ORDERBOOK_VALUE_USD) {
                    // Attach extra data
                    return { ...market, stats, orderbookValue: bidSum, bestBids: processedBids };
                }
            }
            return null;
        });

        const results = await Promise.all(promises);
        results.forEach((res) => {
            if (res) finalMarkets.push(res);
        });

        if ((i + CONCURRENCY_LIMIT) % 20 === 0) {
            console.log(`Processed ${Math.min(i + CONCURRENCY_LIMIT, registeredMarkets.length)} / ${registeredMarkets.length} markets...`);
        }
    }

    return finalMarkets;
}

async function saveMarketsToFile(markets: Market[], filename: string) {
    try {
        fs.writeFileSync(filename, JSON.stringify(markets, null, 2));
        console.log(`Saved ${markets.length} markets to ${filename}`);
    } catch (error: any) {
        console.error("Error saving to file:", error.message);
    }
}

async function main() {
    const markets = await fetchAllMarkets();
    console.log(`\nTotal markets fetched: ${markets.length}`);

    const filteredMarkets = await filterMarkets(markets);
    console.log(`Markets after all filters: ${filteredMarkets.length}`);

    await saveMarketsToFile(filteredMarkets, "filtered_markets.json");
}

if (require.main === module) {
    main().catch(console.error);
}
