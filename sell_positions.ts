/**
 * Module to fetch positions and sell them with market orders
 */
import { Wallet, JsonRpcProvider } from "ethers";
import { OrderBuilder, ChainId, Side } from "@predictdotfun/sdk";
import axios from "axios";
import * as dotenv from "dotenv";

dotenv.config();

const PRIVATE_KEY = process.env.PREDICT_PRIVATE_KEY!;
const API_KEY = process.env.PREDICT_API_KEY!;
const ACCOUNT_ADDRESS = process.env.PREDICT_ACCOUNT_ADDRESS!;
const RPC_URL = process.env.RPC_PROVIDER_URL || "https://bsc-dataseed.binance.org/";
const BASE_URL = "https://api.predict.fun";

interface Position {
    marketId: number;
    marketTitle: string;
    tokenId: string;
    sharesRaw: string;
    sharesOwned: number;
    outcome: string;
    isNegRisk: boolean;
    isYieldBearing: boolean;
    feeRateBps: number;
}

// Cached OrderBuilder instance
let cachedOrderBuilder: OrderBuilder | null = null;
let cachedJwtToken: string | null = null;

async function getOrderBuilder(): Promise<OrderBuilder> {
    if (!cachedOrderBuilder) {
        const provider = new JsonRpcProvider(RPC_URL);
        const signer = new Wallet(PRIVATE_KEY, provider);
        cachedOrderBuilder = await OrderBuilder.make(ChainId.BnbMainnet, signer, {
            predictAccount: ACCOUNT_ADDRESS
        });
    }
    return cachedOrderBuilder;
}

async function getJwtToken(orderBuilder: OrderBuilder): Promise<string> {
    // Refresh token if not cached
    if (!cachedJwtToken) {
        cachedJwtToken = await getAuthJWT(orderBuilder);
    }
    return cachedJwtToken;
}

/**
 * Sell all positions - exported function to be called from other modules
 * @returns true if at least 1 position was found and sold, false otherwise
 */
export async function sellAllPositions(): Promise<boolean> {
    try {
        const orderBuilder = await getOrderBuilder();
        const jwtToken = await getJwtToken(orderBuilder);
        const positions = await getPositions(jwtToken);

        if (positions.length === 0) return false;

        for (const pos of positions) {
            await sellPosition(orderBuilder, pos, jwtToken);
        }
        return true;
    } catch (error: any) {
        // Token might be expired, clear cache and retry once
        if (error.response?.status === 401) {
            cachedJwtToken = null;
            const orderBuilder = await getOrderBuilder();
            const jwtToken = await getJwtToken(orderBuilder);
            const positions = await getPositions(jwtToken);
            if (positions.length === 0) return false;
            for (const pos of positions) {
                await sellPosition(orderBuilder, pos, jwtToken);
            }
            return true;
        } else {
            console.error(`Error in sellAllPositions:`, error.message);
            return false;
        }
    }
}

async function sellPosition(orderBuilder: OrderBuilder, pos: Position, jwtToken: string) {
    try {
        const orderbookResponse = await axios.get(
            `${BASE_URL}/v1/markets/${pos.marketId}/orderbook`,
            { headers: { "x-api-key": API_KEY } }
        );
        const book = orderbookResponse.data.data;

        const quantityWei = BigInt(pos.sharesRaw);
        const orderAmounts = orderBuilder.getMarketOrderAmounts(
            { side: Side.SELL, quantityWei },
            book
        );

        const order = orderBuilder.buildOrder("MARKET", {
            maker: ACCOUNT_ADDRESS,
            signer: ACCOUNT_ADDRESS,
            side: Side.SELL,
            tokenId: pos.tokenId,
            makerAmount: orderAmounts.makerAmount,
            takerAmount: orderAmounts.takerAmount,
            nonce: 0n,
            feeRateBps: pos.feeRateBps,
        });

        const typedData = orderBuilder.buildTypedData(order, {
            isNegRisk: pos.isNegRisk,
            isYieldBearing: pos.isYieldBearing
        });

        const signedOrder = await orderBuilder.signTypedDataOrder(typedData);
        const hash = orderBuilder.buildTypedDataHash(typedData);

        const response = await axios.post(
            `${BASE_URL}/v1/orders`,
            {
                data: {
                    order: { ...signedOrder, hash },
                    pricePerShare: orderAmounts.pricePerShare.toString(),
                    strategy: "MARKET",
                    slippageBps: "500",
                },
            },
            {
                headers: {
                    "x-api-key": API_KEY,
                    "Authorization": `Bearer ${jwtToken}`,
                    "Content-Type": "application/json",
                },
            }
        );

        if (!response.data.success) {
            console.error(`Failed to sell position:`, response.data);
        }
    } catch (error: any) {
        console.error(`Error selling position:`, error.response?.data || error.message);
    }
}

async function getAuthJWT(orderBuilder: OrderBuilder): Promise<string> {
    const msgResponse = await axios.get(`${BASE_URL}/v1/auth/message`, {
        headers: { "x-api-key": API_KEY },
    });
    const message = msgResponse.data.data.message;
    const signature = await orderBuilder.signPredictAccountMessage(message);

    const jwtResponse = await axios.post(
        `${BASE_URL}/v1/auth`,
        { signer: ACCOUNT_ADDRESS, message, signature },
        { headers: { "x-api-key": API_KEY, "Content-Type": "application/json" } }
    );

    return jwtResponse.data.data.token;
}

async function getPositions(jwtToken: string): Promise<Position[]> {
    const response = await axios.get(`${BASE_URL}/v1/positions`, {
        headers: {
            "x-api-key": API_KEY,
            "Authorization": `Bearer ${jwtToken}`,
        },
    });

    if (!response.data.success || !response.data.data) return [];

    return response.data.data
        .map((p: any) => ({
            marketId: p.market?.id,
            marketTitle: p.market?.title || `Market ${p.market?.id}`,
            tokenId: p.outcome?.onChainId,
            sharesRaw: p.amount || "0",
            sharesOwned: parseFloat(p.amount || "0") / 1e18,
            outcome: p.outcome?.name || "Unknown",
            isNegRisk: p.market?.isNegRisk || false,
            isYieldBearing: p.market?.isYieldBearing || false,
            feeRateBps: p.market?.feeRateBps || 200,
        }))
        .filter((p: Position) => p.sharesOwned > 0 && p.marketId && p.tokenId);
}

// Run directly if executed as script
if (require.main === module) {
    sellAllPositions().catch(console.error);
}
