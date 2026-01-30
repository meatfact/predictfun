import { PredictOrders } from "./orders";

async function main() {
    const orders = new PredictOrders();
    await orders.initialize();

    console.log("Fetching open orders to inspect response...");
    // We need to bypass the clean output of getOpenOrders to see raw response if possible,
    // or just trust the user relies on us checking.
    // Since getOpenOrders extracts valid data, let's just use it first, but I'll also use axios directly if needed.
    // Actually, let's modify orders.ts to export the raw response or just use axios here similar to orders.ts

    // Better: just use the class but maybe add a log in it, or copy the axios call here.
    // I will copy the axios call logic here to be sure.

    const axios = require("axios");
    const { BASE_URL, API_KEY } = require("./config");
    // need auth...
    // simpler: Let's just modify orders.ts to console.log the full response.data in getOpenOrders temporarily?
    // No, I can just use the exposed method and hope it returns what I need or use the internals.
    // The current getOpenOrders returns `response.data.data`. I need to see if there is `response.data.next_cursor` or similar.

    // Let's rely on the fact I can read orders.ts. 
    // I will create a script that IMPORTS everything needed to make the raw call.
}

// Actually, I'll just create a script that uses the existing `PredictOrders` but I'll use `getOpenOrders` and print what it returns.
// If the `cursor` is stripped by `getOpenOrders`, I won't see it.
// `getOpenOrders` returns `response.data.data`.
// Code: 
// const orders = response.data.data;
// return { success: true, data: orders };
// So yes, I need to see the raw response.

// converting to checking `orders.ts` again.
// It uses `getHeaders()`.
// I'll just write a script that instantiates `PredictOrders`, gets the headers using the public/private methods (I might need to make getHeaders public or use `any` cast), and calls axios.

import { PredictOrders } from "./orders";
import axios from "axios";

async function debug() {
    const ordersBot = new PredictOrders();
    await ordersBot.initialize();

    // cast to any to access private vars/methods
    const botAny = ordersBot as any;

    console.log("Calling API...");
    try {
        const response = await axios.get(`${botAny.baseUrl}/v1/orders`, {
            headers: botAny.getHeaders(),
            params: { status: "OPEN" },
        });

        console.log("Response keys:", Object.keys(response.data));
        if (response.data.metadata) console.log("Metadata:", response.data.metadata);
        if (response.data.pagination) console.log("Pagination:", response.data.pagination);
        if (response.data.cursor) console.log("Cursor:", response.data.cursor);
        if (response.data.next_cursor) console.log("Next Cursor:", response.data.next_cursor);
        console.log("Root keys:", Object.keys(response.data));
    } catch (e: any) {
        console.error(e.message);
    }
}

debug();
