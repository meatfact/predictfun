import axios from "axios";
import * as fs from "fs";
import { BASE_URL, API_KEY } from "./config";

interface Market {
    id: number;
    title: string;
    [key: string]: any;
}

async function fetchOrderbook(marketId: number) {
    try {
        console.log(`Fetching orderbook for market ${marketId}...`);
        const response = await axios.get(`${BASE_URL}/v1/markets/${marketId}/orderbook`, {
            headers: { "x-api-key": API_KEY }
        });

        if (response.data.success) {
            console.log("Orderbook fetched successfully.");
            console.log(JSON.stringify(response.data.data, null, 2));
            return response.data.data;
        } else {
            console.error(`Failed to fetch orderbook: ${response.data.message}`);
        }
    } catch (error: any) {
        console.error("Error fetching orderbook:", error.message || error);
    }
}

async function main() {
    try {
        const marketsRaw = fs.readFileSync("filtered_markets.json", "utf-8");
        const markets: Market[] = JSON.parse(marketsRaw);

        if (markets.length === 0) {
            console.log("No markets found in filtered_markets.json");
            return;
        }

        const firstMarket = markets[0];
        console.log(`First market: [${firstMarket.id}] ${firstMarket.title}`);

        await fetchOrderbook(firstMarket.id);

    } catch (error: any) {
        console.error("Error reading markets file:", error.message);
    }
}

if (require.main === module) {
    main().catch(console.error);
}
