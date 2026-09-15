import { expect, test } from "bun:test";
import { decide, parseChallenge, type Receipt, spentToday } from "./policy";

const policy = { autoApproveSats: 100, dailyBudgetSats: 1050 };

test("pays small amounts, asks above the threshold, refuses past caps", () => {
	expect(decide(10, 100, 0, policy)).toEqual({ kind: "pay" });
	expect(decide(1000, 2000, 10, policy).kind).toBe("ask");
	expect(decide(1000, 500, 0, policy).kind).toBe("refuse");
	expect(decide(50, 100, 1010, policy).kind).toBe("refuse");
	expect(decide(0, 100, 0, policy).kind).toBe("refuse");
});

test("counts only paid receipts from the current UTC day, including fees", () => {
	const r = (ts: string, outcome: Receipt["outcome"], amount_sat: number, fee_sat = 0): Receipt => ({
		ts, outcome, amount_sat, fee_sat, url: "", service: "", payment_hash: "", approval: "auto",
	});
	const ledger = [
		r("2026-09-16T01:00:00Z", "paid", 10, 1),
		r("2026-09-16T02:00:00Z", "declined", 1000),
		r("2026-09-15T23:59:59Z", "paid", 500),
	];
	expect(spentToday(ledger, new Date("2026-09-16T12:00:00Z"))).toBe(11);
});

test("parses Aperture's L402 challenge", () => {
	const h = 'LSAT macaroon="AgEE", invoice="lnbcrt1", L402 macaroon="AgEF", invoice="lnbcrt2"';
	expect(parseChallenge(h)).toEqual({ macaroon: "AgEE", invoice: "lnbcrt1" });
	expect(parseChallenge(null)).toBeUndefined();
});
