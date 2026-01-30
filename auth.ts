/**
 * Authentication module for Predict.fun API
 */
import axios from "axios";
import { OrderBuilder } from "@predictdotfun/sdk";

/**
 * Get a JWT token for authentication with the Predict API.
 * 
 * @param builder - An OrderBuilder instance configured with a Predict account
 * @param apiKey - Your Predict API key
 * @param accountAddress - Your Predict account address
 * @param baseUrl - The API base URL (mainnet or testnet)
 * @returns The JWT token string
 */
export async function getAuthJWT(
    builder: OrderBuilder,
    apiKey: string,
    accountAddress: string,
    baseUrl: string
): Promise<string> {
    // Step 1: Send GET auth/message request
    const messageResponse = await axios.get(
        `${baseUrl}/v1/auth/message`,
        {
            headers: { "x-api-key": apiKey },
        }
    );

    if (!messageResponse.data) {
        throw new Error("Failed to get auth message");
    }

    // Step 2: Retrieve the message to sign
    const message = messageResponse.data.data.message;

    // Step 3: Sign the message using the SDK function for Predict accounts
    // The standard signMessage won't work for Predict accounts
    const signature = await builder.signPredictAccountMessage(message);

    // Step 4: Build the body data to request the JWT via POST auth
    const body = {
        signer: accountAddress,
        message: message,
        signature: signature,
    };

    // Step 5: Send the POST auth request
    const jwtResponse = await axios.post(
        `${baseUrl}/v1/auth`,
        body,
        {
            headers: {
                "Content-Type": "application/json",
                "x-api-key": apiKey,
            },
        }
    );

    if (!jwtResponse.data.success) {
        throw new Error(`Failed to authenticate: ${JSON.stringify(jwtResponse.data)}`);
    }

    // Step 6: Fetch the JWT token
    const jwt = jwtResponse.data.data.token;

    return jwt;
}
