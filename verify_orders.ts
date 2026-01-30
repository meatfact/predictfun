import { PredictOrders } from "./orders";

async function main() {
    const orders = new PredictOrders();
    await orders.initialize();

    console.log("Fetching all open orders recursively...");
    const result = await orders.getOpenOrdersRecursively();

    if (result.success) {
        console.log(`\n✅ Successfully fetched ${result.data.length} orders.`);
        // Print first 5 and last 5 IDs to verify variety if many
        if (result.data.length > 0) {
            console.log("First 3 orders:", result.data.slice(0, 3).map((o: any) => o.id || o.orderId));
            if (result.data.length > 3) {
                console.log("Last 3 orders:", result.data.slice(-3).map((o: any) => o.id || o.orderId));
            }
        }
    } else {
        console.error("❌ Failed to fetch orders:", result.error);
    }
}

main().catch(console.error);
