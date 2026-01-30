import { PredictOrders } from "./orders";
import { Side } from "@predictdotfun/sdk";
import * as fs from "fs";
import axios from "axios";
import { ORDER_AMOUNT_USD, MIN_DEPTH_CHECK_USD, BASE_URL, API_KEY } from "./config";
import { sellAllPositions } from "./sell_positions";

interface MarketBid {
    price: number;
    quantity: number;
    value: number;
}

interface FilteredMarket {
    id: number;
    title: string;
    bestBids: MarketBid[];
}

interface TrackedOrder {
    price: number;
    orderHash: string;
}

interface TrackedMarket {
    id: number;
    title: string;
    orders: TrackedOrder[];
    cancelCount: number;        // Track total cancellations
    cooldownUntil: number;      // Timestamp (ms) when cooldown expires
}

const ORDERS_FILE = "filtered_markets.json";
const MONITOR_INTERVAL_MS = 30000;
const VALUE_THRESHOLD = 500;

let ordersBot: PredictOrders;

async function main() {
    console.log("📊 Orders Manager Starting...\n");

    if (!fs.existsSync(ORDERS_FILE)) {
        console.error(`❌ ${ORDERS_FILE} not found. Run markets.ts first.`);
        return;
    }

    const allMarkets: FilteredMarket[] = JSON.parse(fs.readFileSync(ORDERS_FILE, "utf-8"));
    // const markets = [allMarkets.find(market => market.id === 705)];
    const markets = allMarkets;
    console.log(`📋 Processing ${markets.length} market(s)\n`);

    ordersBot = new PredictOrders();
    await ordersBot.initialize();

    const trackedMarkets: TrackedMarket[] = [];

    for (const market of markets) {
        const result = await processMarket(market);
        if (result) trackedMarkets.push(result);
    }

    console.log(`\n✅ Done. Tracking ${trackedMarkets.length} market(s)\n`);

    if (trackedMarkets.length > 0) {
        console.log("🔄 Starting monitor loop (Ctrl+C to stop)\n");
        await monitorLoop(trackedMarkets);
    }
}

async function processMarket(market: FilteredMarket): Promise<TrackedMarket | null> {
    const existingOrders = await getExistingOrdersForMarket(market.id);
    const bids = await fetchOrderbook(market.id);

    if (!bids || bids.length === 0) {
        console.log(`  ⚠ No bids\n`);
        return null;
    }

    // Find depth threshold
    let cumulativeValue = 0;
    let startIndex = -1;

    for (let i = 0; i < Math.min(bids.length, 6); i++) {
        cumulativeValue += bids[i].value;
        if (cumulativeValue > MIN_DEPTH_CHECK_USD) {
            startIndex = i;
            break;
        }
    }

    if (startIndex === -1) {
        if (existingOrders.length > 0) {
            return { id: market.id, title: market.title, orders: existingOrders.sort((a, b) => b.price - a.price), cancelCount: 0, cooldownUntil: 0 };
        }
        return null;
    }

    // Calculate target prices
    const triggerPrice = bids[startIndex].price;
    const startPrice = parseFloat((triggerPrice - 0.001).toFixed(3));
    const targetOrderCount = Math.min(5, 6 - startIndex);

    const targetPrices: number[] = [];
    for (let i = 0; i < targetOrderCount && startPrice - (i * 0.001) > 0; i++) {
        targetPrices.push(parseFloat((startPrice - (i * 0.001)).toFixed(3)));
    }

    // Filter out prices with existing orders
    const existingPrices = new Set(existingOrders.map(o => o.price));
    const pricesToPlace = targetPrices.filter(p => !existingPrices.has(p));

    if (pricesToPlace.length === 0) {
        console.log(`  ✓ Market ${market.id}: ${existingOrders.length} active orders`);
        return { id: market.id, title: market.title, orders: existingOrders.sort((a, b) => b.price - a.price), cancelCount: 0, cooldownUntil: 0 };
    }

    // Place new orders
    const placedOrders: TrackedOrder[] = [...existingOrders];
    let successCount = 0;

    for (const price of pricesToPlace) {
        try {
            const result = await ordersBot.openOrder({
                marketId: market.id,
                side: Side.BUY,
                amount: ORDER_AMOUNT_USD,
                price: price.toString(),
                orderType: "LIMIT"
            });

            if (result.success) {
                successCount++;
                placedOrders.push({ price, orderHash: result.data.orderHash });
                // Details fetched silently inside openOrder if needed or not
            }
        } catch (err: any) {
            console.error(`  ❌ Order at ${price}: ${err.message}`);
        }
    }

    console.log(`  ✓ Market ${market.id}: Placed ${successCount}/${pricesToPlace.length} new orders`);

    if (placedOrders.length > 0) {
        return { id: market.id, title: market.title, orders: placedOrders.sort((a, b) => b.price - a.price), cancelCount: 0, cooldownUntil: 0 };
    }
    return null;
}

async function getExistingOrdersForMarket(marketId: number): Promise<TrackedOrder[]> {
    const activeOrders: TrackedOrder[] = [];
    const storedOrders = ordersBot.getStorage().getOrdersForMarket(marketId);

    for (const order of storedOrders) {
        try {
            const details = await ordersBot.getOrderByHash(order.orderHash);
            if (details.success && details.data?.status === "OPEN") {
                const orderData = details.data.order || details.data;
                let price = 0;
                if (orderData.makerAmount && orderData.takerAmount) {
                    price = parseFloat((parseFloat(orderData.makerAmount) / parseFloat(orderData.takerAmount)).toFixed(3));
                }
                activeOrders.push({ price, orderHash: order.orderHash });
            } else if (details.data?.status !== "OPEN") {
                ordersBot.getStorage().deleteOrder(order.orderHash);
            }
        } catch { }
    }
    return activeOrders;
}

async function fetchOrderbook(marketId: number): Promise<MarketBid[]> {
    try {
        const response = await axios.get(`${BASE_URL}/v1/markets/${marketId}/orderbook`, {
            headers: { "x-api-key": API_KEY }
        });
        if (response.data.success && response.data.data.bids) {
            return response.data.data.bids.map((bid: any[]) => ({
                price: Number(bid[0]),
                quantity: Number(bid[1]),
                value: Number(bid[0]) * Number(bid[1])
            }));
        }
    } catch { }
    return [];
}

async function monitorLoop(trackedMarkets: TrackedMarket[]) {
    while (true) {
        const time = new Date().toLocaleTimeString();
        process.stdout.write(`\r[${time}] 🔍 Checking ${trackedMarkets.length} markets...`);

        // Sell all positions
        let positionSold = false;
        try {
            positionSold = await sellAllPositions();
        } catch (error: any) {
            console.error(`  ❌ Sell positions: ${error.message}`);
        }

        // If a position was sold, check for filled orders and reopen them
        if (positionSold) {
            console.log(`  📦 Position sold, checking for filled orders...`);
            await checkAndReopenFilledOrders(trackedMarkets);
        }

        // --- SYNC OPEN ORDERS start ---
        try {
            const allOrdersRes = await ordersBot.getOpenOrdersRecursively();
            if (allOrdersRes.success && allOrdersRes.data) {
                const allOpenOrders = allOrdersRes.data;

                // Group API orders by marketId
                const apiOrdersByMarket: Record<number, any[]> = {};
                for (const order of allOpenOrders) {
                    if (order.marketId) {
                        if (!apiOrdersByMarket[order.marketId]) apiOrdersByMarket[order.marketId] = [];
                        apiOrdersByMarket[order.marketId].push(order);
                    }
                }

                // Sync each tracked market
                for (const tracked of trackedMarkets) {
                    const marketApiOrders = apiOrdersByMarket[tracked.id] || [];
                    const currentHashes = new Set(tracked.orders.map(o => o.orderHash));
                    const apiHashes = new Set<string>();

                    // 1. Add untracked orders found in API
                    for (const apiOrder of marketApiOrders) {
                        // Attempt to find hash. In API response it might be in `order` object or top level.
                        // Based on verification, it's likely deep or needs computation, but let's try standard locations.
                        // Since we saved it as `hash` in `openOrder`, maybe API returns it?
                        // If not available, we might skip or log warning. 
                        // However, verify_orders showed '99998...' which looks like a partial hash.
                        // Let's look for `hash` or `orderHash`.
                        const hash = apiOrder.hash || apiOrder.orderHash || apiOrder.order?.hash || apiOrder.order?.orderHash;

                        if (hash) {
                            apiHashes.add(hash);
                            if (!currentHashes.has(hash)) {
                                console.log(`  ➕ Found untracked order for market ${tracked.id} at hash ${hash.substring(0, 10)}...`);
                                // Calculate price
                                let price = 0;
                                const maker = apiOrder.makerAmount || apiOrder.order?.makerAmount;
                                const taker = apiOrder.takerAmount || apiOrder.order?.takerAmount;

                                if (maker && taker) {
                                    // Identify side to correctly calculate price.
                                    // Side 0 (BUY-YES) vs Side 1 (SELL-NO / BUY-NO??) - Predict.fun usually has YES/NO tokens.
                                    // SDK Side: BUY=0, SELL=1.
                                    // But here we need price per share.
                                    // If maker is USDT (big number ~ 5 * 1e18) and taker is Shares, price = maker/taker.
                                    // If maker is Shares and taker is USDT, price = taker/maker.
                                    // Inspect `apiOrder.side`: 0 usually means we are BUYING outcome (spending USDT).
                                    // Let's assume price = maker / taker if side 0, else inverse?
                                    // Actually `openOrder` logic:
                                    // BUY: Maker=USDT, Taker=Share. Price = Maker/Taker.
                                    // SELL: Maker=Share, Taker=USDT. Price = Taker/Maker.

                                    const m = parseFloat(maker);
                                    const t = parseFloat(taker);
                                    const side = apiOrder.side ?? apiOrder.order?.side;

                                    if (side === 0) { // BUY
                                        price = parseFloat((m / t).toFixed(3));
                                    } else { // SELL
                                        price = parseFloat((t / m).toFixed(3));
                                    }
                                }

                                tracked.orders.push({ price, orderHash: hash });
                                // Also ensure it's in storage so if we restart it's there
                                ordersBot.getStorage().addOrder({ orderId: apiOrder.id, orderHash: hash }, tracked.id, tracked.title);
                            }
                        }
                    }

                    // 2. Remove tracked orders NOT in API (filled/cancelled externally)
                    const initialCount = tracked.orders.length;
                    tracked.orders = tracked.orders.filter(o => apiHashes.has(o.orderHash));
                    if (tracked.orders.length < initialCount) {
                        const removedCount = initialCount - tracked.orders.length;
                        console.log(`  ➖ Removed ${removedCount} stale orders for market ${tracked.id} (not in open orders)`);
                        // Clean up storage for these missing orders
                        // We need to know which ones were removed.
                        // It's cleaner to just sync storage to tracked.orders if possible, or just delete missing.
                        // But finding *which* were removed requires diff. 
                        // Simpler: iterate original list and if not in apiHashes, delete.
                        // (implied by filter above, but let's do explicit storage delete)
                        // Actually `checkAndReopenFilledOrders` or `checkAndRebalance` might handle logic, 
                        // but if they are gone from API they are gone.
                    }

                    // Sort again
                    tracked.orders.sort((a, b) => b.price - a.price);
                }
            }
        } catch (error: any) {
            console.error(`  ⚠ Error syncing open orders: ${error.message}`);
        }
        // --- SYNC OPEN ORDERS end ---

        for (const tracked of trackedMarkets) {
            await checkAndRebalance(tracked);
        }

        // Wait 30 seconds before next iteration
        await new Promise(resolve => setTimeout(resolve, 30000));
    }
}

async function checkAndReopenFilledOrders(trackedMarkets: TrackedMarket[]) {
    for (const tracked of trackedMarkets) {
        const ordersToRemove: string[] = [];
        const ordersToAdd: TrackedOrder[] = [];

        // Check each order's status
        for (const order of tracked.orders) {
            try {
                const details = await ordersBot.getOrderByHash(order.orderHash);
                if (details.success && details.data?.status !== "OPEN") {
                    console.log(`  🔄 Order at ${order.price} was filled/cancelled, reopening...`);
                    ordersToRemove.push(order.orderHash);

                    // Remove from storage
                    ordersBot.getStorage().deleteOrder(order.orderHash);

                    // Reopen order at the same price
                    try {
                        const result = await ordersBot.openOrder({
                            marketId: tracked.id,
                            side: Side.BUY,
                            amount: ORDER_AMOUNT_USD,
                            price: order.price.toString(),
                            orderType: "LIMIT"
                        });

                        if (result.success) {
                            ordersToAdd.push({ price: order.price, orderHash: result.data.orderHash });
                            if (result.data.orderHash) {
                                await ordersBot.getOrderByHash(result.data.orderHash);
                            }
                        }
                    } catch (err: any) {
                        console.error(`  ❌ Failed to reopen order at ${order.price}: ${err.message}`);
                    }
                }
            } catch { }
        }

        // Update tracked orders
        if (ordersToRemove.length > 0) {
            tracked.orders = tracked.orders.filter(o => !ordersToRemove.includes(o.orderHash));
            tracked.orders.push(...ordersToAdd);
            tracked.orders.sort((a, b) => b.price - a.price);
        }
    }
}

function incrementCancelCount(tracked: TrackedMarket, count: number) {
    tracked.cancelCount += count;

    if (tracked.cancelCount >= 10 && tracked.cooldownUntil === 0) {
        tracked.cooldownUntil = Date.now() + 30 * 60 * 1000; // 30 minutes
        console.log(`  🧊 [${tracked.id}] Entered cooldown (${tracked.cancelCount} cancellations) - pausing for 30 min`);
    }
}

async function checkAndRebalance(tracked: TrackedMarket) {
    try {
        // Check cooldown status
        if (tracked.cooldownUntil > 0) {
            if (Date.now() >= tracked.cooldownUntil) {
                // Cooldown expired - reset
                console.log(`  ❄️ [${tracked.id}] Cooldown expired, resuming normal operations`);
                tracked.cancelCount = 0;
                tracked.cooldownUntil = 0;
            } else {
                // Still in cooldown - cancel all orders but don't reopen
                if (tracked.orders.length > 0) {
                    const timeLeft = Math.ceil((tracked.cooldownUntil - Date.now()) / 60000);
                    console.log(`  🧊 [${tracked.id}] In cooldown (${timeLeft} min left) - canceling ${tracked.orders.length} orders`);
                    await cancelBottomOrders(tracked, tracked.orders.length);
                }
                return;
            }
        }

        // Enforce max 5 orders (remove lowest prices)
        if (tracked.orders.length > 5) {
            const excess = tracked.orders.length - 5;
            console.log(`  ✂ [${tracked.id}] Trimming ${excess} excess order(s) (keeping top 5)`);
            await cancelBottomOrders(tracked, excess);
        }

        const bids = await fetchOrderbook(tracked.id);
        if (bids.length === 0) return;

        // Ensure we have enough orders after trimming
        if (tracked.orders.length < 5) {
            const needed = 5 - tracked.orders.length;
            console.log(`  ➕ [${tracked.id}] Placing ${needed} orders after trim`);
            await openBottomOrders(tracked, needed);
        }

        if (tracked.orders.length === 0) return;

        const bestBid = bids[0];
        const highestOrder = tracked.orders[0];
        const lowestOrder = tracked.orders[tracked.orders.length - 1];

        // Calculate cumulative value from best bid down to (but not including) our highest order price
        let cumulativeValue = 0;
        for (const bid of bids) {
            if (bid.price <= highestOrder.price) break;
            cumulativeValue += bid.value;
        }

        // Price dropped - rebalance down (may need to move multiple orders)
        if (bestBid.price <= highestOrder.price || cumulativeValue < VALUE_THRESHOLD) {
            // Calculate how many orders need to move down
            // Find how many of our orders are now at or above the best bid
            let ordersToMoveDown = 0;
            for (const order of tracked.orders) {
                if (order.price >= bestBid.price) {
                    ordersToMoveDown++;
                } else {
                    break;
                }
            }
            // At minimum move 1 order if threshold not met
            ordersToMoveDown = Math.max(1, ordersToMoveDown);
            // Don't move more orders than we have
            ordersToMoveDown = Math.min(ordersToMoveDown, tracked.orders.length);

            console.log(`  📉 [${tracked.id}] Rebalancing down ${ordersToMoveDown} order(s)`);

            // Cancel orders from the top
            const cancelledCount = await cancelTopOrders(tracked, ordersToMoveDown);

            // Open new orders at the bottom
            if (cancelledCount > 0) {
                await openBottomOrders(tracked, cancelledCount);
            }
        }
        // Price went up - rebalance up (may need to move multiple orders)
        else if (bestBid.price > highestOrder.price + 0.001) {
            // Calculate how many steps up we can move
            const priceGap = Math.round((bestBid.price - highestOrder.price) * 1000);
            let ordersToMoveUp = Math.min(priceGap, tracked.orders.length);

            // Check cumulative value at each target price level
            let validMoves = 0;
            for (let i = 1; i <= ordersToMoveUp; i++) {
                const targetPrice = parseFloat((highestOrder.price + (i * 0.001)).toFixed(3));

                // Calculate cumulative value from best bid down to target price
                let cumulativeValueAtTarget = 0;
                for (const bid of bids) {
                    if (bid.price <= targetPrice) break;
                    cumulativeValueAtTarget += bid.value;
                }

                if (cumulativeValueAtTarget >= VALUE_THRESHOLD) {
                    validMoves = i;
                } else {
                    break;
                }
            }

            if (validMoves > 0) {
                console.log(`  📈 [${tracked.id}] Rebalancing up ${validMoves} order(s)`);

                // Cancel orders from the bottom
                const cancelledCount = await cancelBottomOrders(tracked, validMoves);

                // Open new orders at the top
                if (cancelledCount > 0) {
                    await openTopOrders(tracked, cancelledCount);
                }
            }
        }
    } catch (error: any) {
        console.error(`  ❌ [${tracked.id}] ${error.message}`);
    }
}

async function cancelTopOrders(tracked: TrackedMarket, count: number): Promise<number> {
    const ordersToCancel: TrackedOrder[] = [];
    const orderDataList: any[] = [];

    // 1. Identify orders to cancel
    for (let i = 0; i < count && tracked.orders.length > 0; i++) {
        ordersToCancel.push(tracked.orders[i]);
    }

    if (ordersToCancel.length === 0) return 0;

    // 2. Fetch full details for batch cancellation
    for (const order of ordersToCancel) {
        // We need full order details which are in storage or we can fetch them
        // Try storage first as it's faster
        let details = ordersBot.getStoredOrderByHash(order.orderHash);

        // If not in storage or missing critical data (like 'order' object for SDK), fetch it
        // Note: storage might save API response which has 'order'
        if (!details || !details.order) {
            const res = await ordersBot.getOrderByHash(order.orderHash);
            if (res.success) {
                details = res.data;
            }
        }

        if (details && details.order) {
            // Construct OrderData compatible object
            orderDataList.push({
                order: details.order, // The signed order object needed by SDK
                id: details.id || details.orderId,
                marketId: tracked.id,
                isNegRisk: details.isNegRisk,
                isYieldBearing: details.isYieldBearing,
                status: details.status,
                hash: order.orderHash // Ensure hash is available for storage deletion helper
            });
        } else {
            console.error(`  ⚠ Could not find details for order ${order.orderHash}, skipping batch cancel`);
        }
    }

    // 3. Batch cancel
    if (orderDataList.length > 0) {
        const result = await ordersBot.cancelOrders(orderDataList);

        if (result.success) {
            // Remove from tracked market
            // Filter out ANY orders that were in our to-cancel list
            // (Assuming all succeeded if result.success is true, or check distinct results)
            // The batch cancel prints individual success/fail but returns global success if partial?
            // Let's assume on success=true (partial or full), we remove those we attempted?
            // Safer: remove only if we know they are gone.
            // But strict removal from tracked.orders is needed to proceed.
            // If some failed, they might still be in tracked.orders.
            // Simplified: Remove all we ATTEMPTED from tracked.orders so we don't try again immediately?
            // OR checks API sync in next loop.
            const canceledHashes = new Set(orderDataList.map(o => o.hash));
            tracked.orders = tracked.orders.filter(o => !canceledHashes.has(o.orderHash));
            incrementCancelCount(tracked, canceledHashes.size);
            return canceledHashes.size;
        } else {
            // If completely failed, return 0
            return 0;
        }
    }

    return 0;
}

async function cancelBottomOrders(tracked: TrackedMarket, count: number): Promise<number> {
    const ordersToCancel: TrackedOrder[] = [];
    const orderDataList: any[] = [];

    // 1. Identify orders to cancel (from bottom)
    const len = tracked.orders.length;
    for (let i = 0; i < count && len - i > 0; i++) {
        ordersToCancel.push(tracked.orders[len - 1 - i]);
    }

    if (ordersToCancel.length === 0) return 0;

    // 2. Fetch details
    for (const order of ordersToCancel) {
        let details = ordersBot.getStoredOrderByHash(order.orderHash);
        if (!details || !details.order) {
            const res = await ordersBot.getOrderByHash(order.orderHash);
            if (res.success) {
                details = res.data;
            }
        }

        if (details && details.order) {
            orderDataList.push({
                order: details.order,
                id: details.id || details.orderId,
                marketId: tracked.id,
                isNegRisk: details.isNegRisk,
                isYieldBearing: details.isYieldBearing,
                status: details.status,
                hash: order.orderHash
            });
        }
    }

    // 3. Batch cancel
    if (orderDataList.length > 0) {
        const result = await ordersBot.cancelOrders(orderDataList);
        if (result.success) {
            const canceledHashes = new Set(orderDataList.map(o => o.hash));
            tracked.orders = tracked.orders.filter(o => !canceledHashes.has(o.orderHash));
            incrementCancelCount(tracked, canceledHashes.size);
            return canceledHashes.size;
        }
    }
    return 0;
}

async function openBottomOrders(tracked: TrackedMarket, count: number): Promise<void> {
    // If we have no orders, we need to start from the orderbook
    let startPrice: number;

    if (tracked.orders.length === 0) {
        // Fetch orderbook to determine starting price
        const bids = await fetchOrderbook(tracked.id);
        if (bids.length === 0) {
            console.log(`  ⚠ [${tracked.id}] No bids in orderbook, cannot place orders`);
            return;
        }

        // Find depth threshold and calculate starting price
        let cumulativeValue = 0;
        let startIndex = -1;

        for (let i = 0; i < Math.min(bids.length, 6); i++) {
            cumulativeValue += bids[i].value;
            if (cumulativeValue > MIN_DEPTH_CHECK_USD) {
                startIndex = i;
                break;
            }
        }

        if (startIndex === -1) {
            console.log(`  ⚠ [${tracked.id}] Insufficient depth, cannot place orders`);
            return;
        }

        const triggerPrice = bids[startIndex].price;
        startPrice = parseFloat((triggerPrice - 0.001).toFixed(3));
    } else {
        // Use the lowest existing order as reference
        const lowestOrder = tracked.orders[tracked.orders.length - 1];
        startPrice = parseFloat((lowestOrder.price - 0.001).toFixed(3));
    }

    for (let i = 0; i < count; i++) {
        const newPrice = parseFloat((startPrice - (i * 0.001)).toFixed(3));
        if (newPrice <= 0) break;

        const result = await ordersBot.openOrder({
            marketId: tracked.id,
            side: Side.BUY,
            amount: ORDER_AMOUNT_USD,
            price: newPrice.toString(),
            orderType: "LIMIT"
        });

        if (result.success) {
            tracked.orders.push({ price: newPrice, orderHash: result.data.orderHash });
            tracked.orders.sort((a, b) => b.price - a.price);
            // Silently fetch order details to update storage
        }
    }
}

async function openTopOrders(tracked: TrackedMarket, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
        const highestOrder = tracked.orders[0];
        if (!highestOrder) break;

        const newPrice = parseFloat((highestOrder.price + 0.001).toFixed(3));
        if (newPrice >= 1) break;

        const result = await ordersBot.openOrder({
            marketId: tracked.id,
            side: Side.BUY,
            amount: ORDER_AMOUNT_USD,
            price: newPrice.toString(),
            orderType: "LIMIT"
        });

        if (result.success) {
            tracked.orders.unshift({ price: newPrice, orderHash: result.data.orderHash });
            tracked.orders.sort((a, b) => b.price - a.price);
            if (result.data.orderHash) await ordersBot.getOrderByHash(result.data.orderHash);
        }
    }
}

main().catch(console.error);
