// Spending policy for an agent wallet: pay small amounts automatically, ask a human
// above a threshold, and refuse anything past the per-call cap or daily budget.

export type Policy = { autoApproveSats: number; dailyBudgetSats: number };

export type Receipt = {
	ts: string;
	task_id?: string;
	url: string;
	service: string;
	amount_sat: number;
	fee_sat: number;
	payment_hash: string;
	preimage?: string;
	approval: "auto" | "human" | "standing" | "none";
	subscription_id?: string;
	outcome: "paid" | "pending" | "failed" | "declined" | "refused";
	proof_of_payment?: boolean;
	wallet?: "lnd" | "wavelength";
	reason?: string;
};

export type Decision = { kind: "pay" } | { kind: "ask" | "refuse"; reason: string };

/** Today's settled cost plus every unresolved reservation, including earlier days. */
export function spentToday(ledger: Receipt[], now = new Date()): number {
	const day = now.toISOString().slice(0, 10);
	return ledger
		.filter((r) => r.outcome === "pending" || (r.outcome === "paid" && r.ts.slice(0, 10) === day))
		.reduce((sum, r) => sum + r.amount_sat + r.fee_sat, 0);
}

export function decide(amountSats: number, maxSats: number, spent: number, policy: Policy, feeLimitSats = 0): Decision {
	if (![amountSats, maxSats, spent, policy.autoApproveSats, policy.dailyBudgetSats, feeLimitSats].every(n => Number.isSafeInteger(n) && n >= 0))
		return { kind: "refuse", reason: "invalid spending policy, amount, or fee limit" };
	if (amountSats <= 0)
		return { kind: "refuse", reason: "invoice has no fixed amount; refusing to pay an open-ended invoice" };
	const cost = amountSats + feeLimitSats;
	if (cost > maxSats) return { kind: "refuse", reason: `price plus maximum fees ${cost} sats exceeds max_sats ${maxSats}` };
	if (spent + cost > policy.dailyBudgetSats)
		return {
			kind: "refuse",
			reason: `would exceed the daily budget: ${spent} of ${policy.dailyBudgetSats} sats already charged or reserved`,
		};
	if (cost > policy.autoApproveSats)
		return { kind: "ask", reason: `price plus maximum fees ${cost} sats is above the ${policy.autoApproveSats}-sat auto-approve limit` };
	return { kind: "pay" };
}

/** Parse `WWW-Authenticate: L402 macaroon="…", invoice="…"` (LSAT is the legacy name). */
export function parseChallenge(header: string | null): { macaroon: string; invoice: string } | undefined {
	const m = header?.match(/(?:L402|LSAT) macaroon="([^"]+)", ?invoice="([^"]+)"/);
	return m ? { macaroon: m[1], invoice: m[2] } : undefined;
}
