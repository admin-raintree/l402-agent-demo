// Checks the actual RC2 gateway. Payment requires --pay and a test-network invoice.
import { strict as assert } from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { wavelengthWallet } from "../agent/wallet";

const url = process.env.WAVELENGTH_URL?.replace(/\/$/, "");
assert(url, "Set WAVELENGTH_URL to a running waved HTTP gateway");
assert(process.env.WAVELENGTH_MACAROON_PATH, "Set WAVELENGTH_MACAROON_PATH to a scoped test-wallet macaroon");
const macaroon = readFileSync(process.env.WAVELENGTH_MACAROON_PATH).toString("hex");
const tlsCertPath = process.env.WAVELENGTH_TLS_CERT;
const tls = tlsCertPath ? { ca: readFileSync(tlsCertPath, "utf8") } : undefined;
const headers = { "content-type": "application/json", macaroon };
const args = process.argv.slice(2);
assert(args.length <= 1 && args.every(arg => ["--pay", "--reconcile"].includes(arg)), "Use --pay or --reconcile");

const infoResponse = await fetch(`${url}/v1/daemon/get-info`, {
	headers, method: "POST", body: "{}", tls, signal: AbortSignal.timeout(15_000),
});
assert(infoResponse.ok, `GetInfo failed: HTTP ${infoResponse.status}`);
const info = await infoResponse.json();
assert.equal(info.version, "0.2.0-rc2", "Expected the pinned Wavelength release candidate");
assert(["regtest", "signet", "testnet", "testnet4", "simnet"].includes(info.network), "Only test networks are allowed");
assert.equal(info.wallet_state, "WALLET_STATE_READY", "Create/unlock the test wallet first");
console.log(`Wavelength ${info.version} (${info.commit}), ${info.network}; operator connected: ${info.server_connected}`);

const unauthorized = await fetch(`${url}/v1/wallet/balance`, {
	method: "POST", body: "{}", headers: { "content-type": "application/json" }, tls,
	signal: AbortSignal.timeout(15_000),
});
// RC2 maps the missing-macaroon gRPC error to HTTP 500/code 2.
const authError = await unauthorized.json();
assert(!unauthorized.ok, "Gateway must refuse requests without a macaroon");
assert.match(authError.message, /expected 1 macaroon, got 0/, "Expected an authentication rejection");

const wallet = wavelengthWallet({ url, macaroonHex: macaroon, tlsCertPath });
const before = await wallet.balanceSat();
assert(Number.isSafeInteger(before) && before >= 0, "Invalid wallet balance");
assert.deepEqual(await wallet.lookup({ paymentHash: randomBytes(32).toString("hex"), amountSat: 1 }), { state: "unknown" });
await assert.rejects(wallet.quote("not-a-bolt11-invoice", 10), /invoice|decode|checksum/i);
console.log(`PASS: authentication, balance (${before} sats), unknown-payment lookup, invalid-invoice rejection`);

// An invoice from `wavecli recv --offchain` on this Ark is unsuitable for
// L402: an in-Ark transfer need not reveal a Lightning payment preimage.
if (process.env.WAVELENGTH_IN_ARK_INVOICE_FILE) {
	const invoice = readFileSync(process.env.WAVELENGTH_IN_ARK_INVOICE_FILE, "utf8").trim();
	await assert.rejects(wallet.quote(invoice, 10), /confirmed Lightning settlement rail/);
	console.log("PASS: same-Ark invoice refused before payment");
}

if (args.includes("--reconcile")) {
	const paymentHash = (process.env.WAVELENGTH_TEST_PAYMENT_HASH ?? "").toLowerCase();
	assert(/^[0-9a-f]{64}$/i.test(paymentHash), "Set WAVELENGTH_TEST_PAYMENT_HASH to the existing payment hash");
	const status = await wallet.lookup({ paymentHash, amountSat: 0 });
	assert.equal(status.state, "paid", `Existing payment is ${status.state}; no new payment was sent`);
	if (status.state === "paid") {
		assert(status.result.preimage && /^[0-9a-f]{64}$/i.test(status.result.preimage), "Missing settlement preimage");
		assert.equal(createHash("sha256").update(Buffer.from(status.result.preimage, "hex")).digest("hex"), paymentHash.toLowerCase());
		assert(Number.isSafeInteger(status.result.feeSat) && status.result.feeSat >= 0 && status.result.feeSat <= 10, "Invalid settlement fee");
		console.log(`PASS: reconciled ${paymentHash}; verified preimage and ${status.result.feeSat}-sat fee without submitting a payment`);
	}
} else if (!args.includes("--pay")) {
	console.log("Payment settlement and preimage recovery NOT TESTED (use --pay with a funded test wallet and WAVELENGTH_TEST_INVOICE_FILE).");
} else {
	assert(info.server_connected, "Operator must be connected before a payment test");
	assert(process.env.WAVELENGTH_TEST_INVOICE_FILE, "Set WAVELENGTH_TEST_INVOICE_FILE to a fresh external Lightning invoice");
	const invoice = readFileSync(process.env.WAVELENGTH_TEST_INVOICE_FILE, "utf8").trim();
	const maxSats = Number(process.env.WAVELENGTH_TEST_MAX_SATS ?? 10000);
	assert(Number.isSafeInteger(maxSats) && maxSats > 10, "Invalid WAVELENGTH_TEST_MAX_SATS");
	const quote = await wallet.quote(invoice, 10);
	assert(Number.isSafeInteger(quote.amountSat) && quote.amountSat > 0, "Invalid invoice amount");
	assert(quote.amountSat + 10 <= maxSats, "Invoice plus fee reserve exceeds the test spending cap");
	assert(before >= quote.amountSat + 10, "Insufficient test-wallet balance");
	console.log(`Submitting ${quote.amountSat}-sat test payment ${quote.paymentHash}; if pending, reconcile with wavecli activity before retrying`);
	const result = await wallet.pay(invoice, quote, 10);
	assert(result.preimage && /^[0-9a-f]{64}$/i.test(result.preimage), "Settlement did not provide a Lightning preimage");
	assert.equal(createHash("sha256").update(Buffer.from(result.preimage, "hex")).digest("hex"), quote.paymentHash);
	assert(Number.isSafeInteger(result.feeSat) && result.feeSat >= 0 && result.feeSat <= 10, "Invalid settlement fee");
	assert.deepEqual(await wallet.lookup(quote), { state: "paid", result });
	console.log(`PASS: paid ${quote.amountSat} sats + ${result.feeSat} sats fee; verified preimage and reconciled payment history`);
}
