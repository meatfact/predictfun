import { PredictOrders } from "./orders";

async function main() {
    const ordersBot = new PredictOrders();
    await ordersBot.initialize();

    console.log("Fetching one page of open orders to check keys...");
    const response = await ordersBot.getOpenOrdersRecursively(undefined, []);

    if (response.success && response.data && response.data.length > 0) {
        const order = response.data[0];
        console.log("Top level keys:", Object.keys(order));
        if (order.order) console.log("Order object keys:", Object.keys(order.order));

        const hasHash = order.hash || order.orderHash || (order.order && (order.order.hash || order.order.orderHash));
        console.log("Has hash?", !!hasHash, hasHash);
    } else {
        console.log("No open orders found to check.");
    }
}

main().catch(console.error);
