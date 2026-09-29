// Wallet backends. The policy layer needs three things from a wallet: read an invoice
// before paying it, pay it and get the preimage back, and report a balance.
//   lnd:        shells out to lncli with a baked pay-only macaroon.
//   wavelength: calls a Wavelength (waved) daemon's wallet REST API, so the agent pays
//               from a self-custodial Ark wallet without running a Lightning node.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type Quote = {
	amountSat: number;
	paymentHash: string;
	/** Payee node. Known for lnd; Wavelength's preview does not expose it. */
	destination?: string;
	/** Wavelength's settlement rail, e.g. SEND_RAIL_IN_ARK or SEND_RAIL_LIGHTNING. */
	rail?: string;
	intentId?: string;
};

/** A payment that left the wallet. `preimage` is missing only when settlement never revealed one. */
export type Paid = { feeSat: number; preimage?: string };

/** Thrown when a payment was sent but has not settled or failed yet; its sats may still leave the wallet. */
export class PaymentPending extends Error {}

export type Wallet = {
	name: "lnd" | "wavelength";
	quote(invoice: string, feeLimitSat: number): Promise<Quote>;
	pay(invoice: string, quote: Quote, feeLimitSat: number): Promise<Paid>;
	balanceSat(): Promise<number>;
};

export function lndWallet(root: string, demo: string): Wallet {
	async function lncli(...args: string[]): Promise<string> {
		const p = Bun.spawn(
			[
				resolve(root, ".bin/lncli"),
				"--network=regtest",
				"--rpcserver=127.0.0.1:10019",
				`--tlscertpath=${demo}/buyer/tls.cert`,
				`--macaroonpath=${demo}/agent-pay.macaroon`,
				...args,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
		if (code !== 0) throw new Error(`lncli ${args[0]} failed: ${(err || out).trim()}`);
		return out;
	}
	return {
		name: "lnd",
		async quote(invoice) {
			const d = JSON.parse(await lncli("decodepayreq", invoice));
			return { amountSat: Math.ceil(Number(d.num_msat) / 1000), paymentHash: d.payment_hash, destination: d.destination };
		},
		async pay(invoice, _quote, feeLimitSat) {
			const out = await lncli("payinvoice", "--force", "--json", `--fee_limit=${feeLimitSat}`, invoice);
			const status = [...out.matchAll(/"status":\s*"(\w+)"/g)].at(-1)?.[1];
			const preimage = out.match(/"payment_preimage":\s*"([0-9a-f]{64})"/)?.[1];
			if (status !== "SUCCEEDED" || !preimage) throw new Error(`payment did not succeed (status ${status ?? "unknown"})`);
			return { preimage, feeSat: Number([...out.matchAll(/"fee_sat":\s*"(\d+)"/g)].at(-1)?.[1] ?? 0) };
		},
		async balanceSat() {
			return Number(JSON.parse(await lncli("channelbalance")).local_balance?.sat ?? 0);
		},
	};
}

type WavelengthOptions = {
	/** waved HTTP/JSON gateway, e.g. https://localhost:10031 */
	url: string;
	/** Hex macaroon, sent in the `macaroon` header. Bake one scoped to PrepareSend, Send, List, and Balance. */
	macaroonHex?: string;
	/** waved's self-signed TLS certificate (PEM). */
	tlsCertPath?: string;
	pollMs?: number;
	timeoutMs?: number;
};

type Entry = {
	id: string;
	status: string;
	fee_sat: string | number;
	failure_reason?: string;
	progress?: { payment_hash?: string; preimage?: string };
};

export function wavelengthWallet(o: WavelengthOptions): Wallet {
	const ca = o.tlsCertPath ? readFileSync(o.tlsCertPath, "utf8") : undefined;
	const pollMs = o.pollMs ?? 500;
	const timeoutMs = o.timeoutMs ?? 90_000;

	async function rpc<T>(path: string, body: unknown): Promise<T> {
		const res = await fetch(`${o.url}/v1/wallet/${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", ...(o.macaroonHex ? { macaroon: o.macaroonHex } : {}) },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(15_000),
			...(ca ? { tls: { ca } } : {}),
		});
		const text = await res.text();
		if (!res.ok) throw new Error(`wavelength ${path} failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
		return JSON.parse(text) as T;
	}

	return {
		name: "wavelength",
		async quote(invoice, feeLimitSat) {
			// PrepareSend validates the invoice and previews the payment without moving funds.
			const p = await rpc<{
				send_intent_id: string;
				amount_sat: string | number;
				payment_hash: string;
				rail: string;
			}>("prepare-send", { invoice, max_fee_sat: feeLimitSat });
			return { amountSat: Number(p.amount_sat), paymentHash: p.payment_hash, rail: p.rail, intentId: p.send_intent_id };
		},
		async pay(_invoice, quote) {
			if (!quote.intentId) throw new Error("no prepared send intent");
			// Send consumes the single-use intent, so a retry cannot pay the same preview twice.
			await rpc("send", { send_intent_id: quote.intentId });
			// Send returns before settlement. Swap-backed send entries use the payment hash as their
			// id, and the preimage appears on the entry once the swap reveals it.
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				const { entries = [] } = await rpc<{ entries?: Entry[] }>("list", {
					view: "LIST_VIEW_ACTIVITY",
					kinds: ["ENTRY_KIND_SEND"],
					limit: 50,
				});
				const e = entries.find((x) => x.id === quote.paymentHash || x.progress?.payment_hash === quote.paymentHash);
				if (e?.status === "ENTRY_STATUS_FAILED") throw new Error(`payment failed: ${e.failure_reason || "no reason given"}`);
				if (e?.status === "ENTRY_STATUS_COMPLETE")
					return { feeSat: Number(e.fee_sat ?? 0), preimage: e.progress?.preimage || undefined };
				if (Date.now() > deadline)
					throw new PaymentPending(`payment still pending after ${timeoutMs / 1000}s; check the Wavelength wallet before retrying`);
				await Bun.sleep(pollMs);
			}
		},
		async balanceSat() {
			return Number((await rpc<{ confirmed_sat: string | number }>("balance", {})).confirmed_sat);
		},
	};
}

export function walletFromEnv(root: string, demo: string, env = process.env): Wallet {
	if ((env.L402_WALLET ?? "lnd") === "lnd") return lndWallet(root, demo);
	if (env.L402_WALLET !== "wavelength") throw new Error(`unknown L402_WALLET ${env.L402_WALLET}`);
	if (!env.WAVELENGTH_URL) throw new Error("L402_WALLET=wavelength needs WAVELENGTH_URL");
	return wavelengthWallet({
		url: env.WAVELENGTH_URL.replace(/\/$/, ""),
		macaroonHex: env.WAVELENGTH_MACAROON_PATH ? readFileSync(env.WAVELENGTH_MACAROON_PATH).toString("hex") : undefined,
		tlsCertPath: env.WAVELENGTH_TLS_CERT,
	});
}
