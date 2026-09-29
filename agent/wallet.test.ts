// Drives the Wavelength backend against a fake waved gateway that follows
// wavewalletrpc's JSON shapes (proto field names, enum names as strings).
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { PaymentPending, wavelengthWallet } from "./wallet";

const preimage = "11".repeat(32);
const hash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
let entry: Record<string, unknown> = {};
let listCalls = 0;
const seen: { path: string; macaroon: string | null; body: unknown }[] = [];

const fake = Bun.serve({
	port: 0,
	async fetch(req) {
		const path = new URL(req.url).pathname.replace("/v1/wallet/", "");
		seen.push({ path, macaroon: req.headers.get("macaroon"), body: await req.json() });
		if (path === "prepare-send")
			return Response.json({ send_intent_id: "intent-1", amount_sat: "1000", payment_hash: hash, rail: "SEND_RAIL_LIGHTNING" });
		if (path === "send") return Response.json({ entry: { id: hash, status: "ENTRY_STATUS_PENDING" }, actual_amount_sat: "1000" });
		if (path === "list") {
			listCalls++;
			// First poll: still pending. Afterwards: whatever the test set.
			return Response.json({ entries: [listCalls === 1 ? { id: hash, status: "ENTRY_STATUS_PENDING" } : entry] });
		}
		if (path === "balance") return Response.json({ confirmed_sat: "250000" });
		return new Response("not found", { status: 404 });
	},
});
afterAll(() => fake.stop());

const wallet = (timeoutMs = 2000) =>
	wavelengthWallet({ url: `http://localhost:${fake.port}`, macaroonHex: "abcd", pollMs: 5, timeoutMs });
const reset = (e: Record<string, unknown>) => {
	entry = e;
	listCalls = 0;
	seen.length = 0;
};

test("prepares, sends the single-use intent, and returns the preimage once the swap reveals it", async () => {
	reset({ id: hash, status: "ENTRY_STATUS_COMPLETE", fee_sat: "3", progress: { payment_hash: hash, preimage } });
	const w = wallet();
	const q = await w.quote("lnbcrt1...", 10);
	expect(q).toEqual({ amountSat: 1000, paymentHash: hash, rail: "SEND_RAIL_LIGHTNING", intentId: "intent-1" });
	expect(await w.pay("lnbcrt1...", q, 10)).toEqual({ feeSat: 3, preimage });
	expect(seen.map((s) => s.path)).toEqual(["prepare-send", "send", "list", "list"]);
	expect(seen[0].body).toEqual({ invoice: "lnbcrt1...", max_fee_sat: 10 });
	expect(seen[1].body).toEqual({ send_intent_id: "intent-1" });
	expect(seen.every((s) => s.macaroon === "abcd")).toBe(true);
	expect(await w.balanceSat()).toBe(250000);
});

test("reports a settled payment with no preimage instead of inventing proof", async () => {
	reset({ id: hash, status: "ENTRY_STATUS_COMPLETE", fee_sat: "0", progress: { payment_hash: hash, preimage: "" } });
	const w = wallet();
	expect(await w.pay("x", await w.quote("x", 10), 10)).toEqual({ feeSat: 0, preimage: undefined });
});

test("surfaces a failed payment", async () => {
	reset({ id: hash, status: "ENTRY_STATUS_FAILED", failure_reason: "no route" });
	const w = wallet();
	await expect(w.pay("x", await w.quote("x", 10), 10)).rejects.toThrow("payment failed: no route");
});

test("times out as PaymentPending so the caller can count the sats as possibly spent", async () => {
	reset({ id: hash, status: "ENTRY_STATUS_PENDING" });
	const w = wallet(30);
	await expect(w.pay("x", await w.quote("x", 10), 10)).rejects.toBeInstanceOf(PaymentPending);
});
