// Spending policy for an agent wallet: pay small amounts automatically, ask a human
// above a threshold, and refuse anything past the per-call cap or daily budget.

export type Policy = { autoApproveSats: number; dailyBudgetSats: number };

export type Receipt = {
	ts: string;
	url: string;
	service: string;
	amount_sat: number;
	fee_sat: number;
	payment_hash: string;
	preimage?: string;
	approval: "auto" | "human" | "none";
	outcome: "paid" | "declined" | "refused";
	reason?: string;
};

export type Decision = { kind: "pay" } | { kind: "ask" | "refuse"; reason: string };

/** Sats paid (amount plus routing fees) on the current UTC day. */
export function spentToday(ledger: Receipt[], now = new Date()): number {
	const day = now.toISOString().slice(0, 10);
	return ledger
		.filter((r) => r.outcome === "paid" && r.ts.slice(0, 10) === day)
		.reduce((sum, r) => sum + r.amount_sat + r.fee_sat, 0);
}

export function decide(amountSats: number, maxSats: number, spent: number, policy: Policy): Decision {
	if (!Number.isInteger(amountSats) || amountSats <= 0)
		return { kind: "refuse", reason: "invoice has no fixed amount; refusing to pay an open-ended invoice" };
	if (amountSats > maxSats) return { kind: "refuse", reason: `price ${amountSats} sats exceeds max_sats ${maxSats}` };
	if (spent + amountSats > policy.dailyBudgetSats)
		return {
			kind: "refuse",
			reason: `would exceed the daily budget: ${spent} of ${policy.dailyBudgetSats} sats already spent today`,
		};
	if (amountSats > policy.autoApproveSats)
		return { kind: "ask", reason: `price ${amountSats} sats is above the ${policy.autoApproveSats}-sat auto-approve limit` };
	return { kind: "pay" };
}

/** Parse `WWW-Authenticate: L402 macaroon="…", invoice="…"` (LSAT is the legacy name). */
export function parseChallenge(header: string | null): { macaroon: string; invoice: string } | undefined {
	const m = header?.match(/(?:L402|LSAT) macaroon="([^"]+)", ?invoice="([^"]+)"/);
	return m ? { macaroon: m[1], invoice: m[2] } : undefined;
}
