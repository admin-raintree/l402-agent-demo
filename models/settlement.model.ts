// One purchase's settlement: the ledger row (Store.reserve/finish), the wallet's own record of the
// payment, and the l402_fetch process that sends it. The process may crash or lose the wallet's reply
// at any point, and reconcile() (run by any fetch, l402_task, or l402_wallet, in any process) reads the
// wallet's history. A confirmed failure frees the service for a new invoice, which is a new payment.
import type { Model, Step } from "./check";

export type SettlementFixes = {
	/** Release the reservation only on wallet evidence (PaymentFailed or a failed lookup), not on any error. */
	failOnlyOnEvidence: boolean;
};

type Ledger = "none" | "pending" | "paid_no_proof" | "paid" | "failed";
/** The wallet's record of the current invoice. `settled_no_proof` is Wavelength before it reveals the preimage. */
type WalletRecord = "none" | "in_flight" | "settled_no_proof" | "settled" | "failed";
export type SettlementState = {
	ledger: Ledger;
	wallet: WalletRecord;
	process: "idle" | "reserved" | "sent";
	invoices: number;
	settledPayments: number;
	crashes: number;
};

const MAX_INVOICES = 2, MAX_CRASHES = 1;
const settled = (w: WalletRecord) => w === "settled" || w === "settled_no_proof";

export function settlementModel(fix: SettlementFixes): Model<SettlementState> {
	// Store.finish: a pending row settles or fails; a settled row without proof can still gain one.
	const finish = (l: Ledger, w: WalletRecord): Ledger => {
		if (w === "failed") return l === "pending" ? "failed" : l;
		if (w === "settled") return l === "pending" || l === "paid_no_proof" ? "paid" : l;
		if (w === "settled_no_proof") return l === "pending" ? "paid_no_proof" : l;
		return l;
	};
	return {
		init: [{ ledger: "none", wallet: "none", process: "idle", invoices: 0, settledPayments: 0, crashes: 0 }],
		next(s) {
			const out: Step<SettlementState>[] = [];
			// A new invoice is only bought when no paid or pending row exists for the service.
			if (s.process === "idle" && (s.ledger === "none" || s.ledger === "failed") && s.invoices < MAX_INVOICES)
				out.push({ action: "fetch reserves a new invoice", next: { ...s, ledger: "pending", wallet: "none", process: "reserved", invoices: s.invoices + 1 } });
			if (s.process === "reserved")
				out.push({ action: "wallet accepts the send", next: { ...s, wallet: "in_flight", process: "sent" } });
			if (s.wallet === "in_flight") {
				out.push({ action: "payment settles", next: { ...s, wallet: "settled", settledPayments: s.settledPayments + 1 } });
				out.push({ action: "payment settles, preimage not yet shown", next: { ...s, wallet: "settled_no_proof", settledPayments: s.settledPayments + 1 } });
				out.push({ action: "payment fails", next: { ...s, wallet: "failed" } });
			}
			if (s.wallet === "settled_no_proof") out.push({ action: "wallet reveals the preimage", next: { ...s, wallet: "settled" } });
			if (s.process === "sent" && (settled(s.wallet) || s.wallet === "failed"))
				out.push({ action: "wallet replies; fetch records it", next: { ...s, ledger: finish(s.ledger, s.wallet), process: "idle" } });
			if (s.process !== "idle") {
				// A transport error: only a confirmed PaymentFailed (or later lookup) may release the funds.
				out.push({ action: "wallet reply lost", next: { ...s, process: "idle",
					ledger: !fix.failOnlyOnEvidence && s.ledger === "pending" ? "failed" : s.ledger } });
				if (s.crashes < MAX_CRASHES) out.push({ action: "process crashes", next: { ...s, process: "idle", crashes: s.crashes + 1 } });
			}
			const reconciled = finish(s.ledger, s.wallet);
			if (reconciled !== s.ledger) out.push({ action: `reconcile reads wallet: ${s.wallet}`, next: { ...s, ledger: reconciled } });
			return out;
		},
		invariants: {
			"a failed row never hides a settled payment": s => !(s.ledger === "failed" && settled(s.wallet)),
			"a paid row always has a settled payment": s => !(s.ledger.startsWith("paid") && !settled(s.wallet)),
			"the service is paid for at most once": s => s.settledPayments <= 1,
		},
		eventually: {
			"every reservation can still resolve": s => s.ledger !== "pending",
		},
	};
}
