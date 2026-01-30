/**
 * Configuration for Predict.fun API
 */
import * as dotenv from "dotenv";

dotenv.config();

// API Configuration
export const API_KEY = process.env.PREDICT_API_KEY || "";
export const PRIVATE_KEY = process.env.PREDICT_PRIVATE_KEY || "";
export const ACCOUNT_ADDRESS = process.env.PREDICT_ACCOUNT_ADDRESS || "";
export const NETWORK = process.env.PREDICT_NETWORK || "mainnet";
export const RPC_URL = process.env.RPC_PROVIDER_URL || "https://bsc-dataseed.binance.org";

// API Base URLs
const API_URLS: Record<string, string> = {
    mainnet: "https://api.predict.fun",
    testnet: "https://api-testnet.predict.fun",
};

export const BASE_URL = API_URLS[NETWORK] || API_URLS.mainnet;

// Market filtering
export const MIN_LIQUIDITY_USD = 30_000;
export const MIN_VOLUME_USD = 100_000; // Filter markets with volume below this threshold
export const MIN_ORDERBOOK_VALUE_USD = 3_000; // Filter markets with top 6 bids value below this threshold
export const MIN_BID_PRICE = 0.09; // Minimum price for the bids considered (or generally for the market valid bids)

// Order placement configuration
export const ORDER_AMOUNT_USD = "1"; // Amount per order in USD
export const MIN_DEPTH_CHECK_USD = 500; // Cumulative value threshold to start placing orders

// Validate required config
export function validateConfig(): void {
    const errors: string[] = [];

    if (!API_KEY) {
        errors.push("PREDICT_API_KEY is not set");
    }
    if (!PRIVATE_KEY) {
        errors.push("PREDICT_PRIVATE_KEY is not set");
    }
    if (!ACCOUNT_ADDRESS) {
        errors.push("PREDICT_ACCOUNT_ADDRESS is not set");
    }

    if (errors.length > 0) {
        throw new Error("Configuration errors:\n" + errors.join("\n"));
    }
}
