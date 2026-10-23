// Two agents sharing one ledger (two MCP processes on one SQLite database) buy within the daily
// budget, the auto-approval limit, and one shared task cap. Each agent checks policy with a snapshot,
// may wait on a human prompt while the other agent spends, then reserves in Store.reserve's
// transaction, and settles for at most the reserved amount. Midnight resets settled daily spending only.
import type { Model, Step } from "./check";

export type BudgetFixes = {
	/** Store.reserve re-runs the daily, approval, and task checks inside its transaction. */
	recheckInReserve: boolean;
};

type Agent = { phase: "idle" | "approving" | "approved" | "reserved"; cost: number; human: boolean; tries: number };
export type BudgetState = {
	agents: Agent[];
	/** Settled today and lifetime, plus unresolved reservations. */
	paidToday: number;
	paidTotal: number;
	reserved: number;
	midnights: number;
	/** A reservation that skipped a required approval. */
	unapproved: boolean;
};

const DAILY = 100, AUTO = 55, TASK = 150, FEE = 10, MAX_TRIES = 2;
const PRICES = [50, 40];

export function budgetModel(fix: BudgetFixes): Model<BudgetState> {
	const spent = (s: BudgetState) => s.paidToday + s.reserved;
	const lifetime = (s: BudgetState) => s.paidTotal + s.reserved;
	const fits = (s: BudgetState, cost: number) => spent(s) + cost <= DAILY && lifetime(s) + cost <= TASK;
	const set = (s: BudgetState, i: number, a: Partial<Agent>, rest: Partial<BudgetState> = {}): BudgetState =>
		({ ...s, ...rest, agents: s.agents.map((x, j) => j === i ? { ...x, ...a } : x) });
	return {
		init: [{ agents: PRICES.map(() => ({ phase: "idle", cost: 0, human: false, tries: 0 })),
			paidToday: 0, paidTotal: 0, reserved: 0, midnights: 0, unapproved: false }],
		next(s) {
			const out: Step<BudgetState>[] = [];
			s.agents.forEach((a, i) => {
				const cost = PRICES[i] + FEE;
				if (a.phase === "idle" && a.tries < MAX_TRIES) {
					// decide() and checkTask() in l402_fetch, against a snapshot that may go stale.
					if (!fits(s, cost)) out.push({ action: `agent ${i} refused`, next: set(s, i, { tries: a.tries + 1 }) });
					else out.push({ action: `agent ${i} passes policy`, next: set(s, i, { tries: a.tries + 1, cost,
						phase: cost > AUTO ? "approving" : "approved", human: false }) });
				}
				if (a.phase === "approving") {
					out.push({ action: `human approves agent ${i}`, next: set(s, i, { phase: "approved", human: true }) });
					out.push({ action: `human declines agent ${i}`, next: set(s, i, { phase: "idle" }) });
				}
				if (a.phase === "approved") {
					const ok = !fix.recheckInReserve || (fits(s, a.cost) && (a.cost <= AUTO || a.human));
					out.push(ok
						? { action: `agent ${i} reserves ${a.cost}`, next: set(s, i, { phase: "reserved" },
							{ reserved: s.reserved + a.cost, unapproved: s.unapproved || (a.cost > AUTO && !a.human) }) }
						: { action: `agent ${i} reservation refused`, next: set(s, i, { phase: "idle" }) });
				}
				if (a.phase === "reserved") for (const fee of [0, FEE]) {
					const actual = a.cost - FEE + fee;
					out.push({ action: `agent ${i} settles for ${actual}`, next: set(s, i, { phase: "idle" },
						{ reserved: s.reserved - a.cost, paidToday: s.paidToday + actual, paidTotal: s.paidTotal + actual }) });
				}
				if (a.phase === "reserved")
					out.push({ action: `agent ${i} payment fails`, next: set(s, i, { phase: "idle" }, { reserved: s.reserved - a.cost }) });
			});
			if (s.midnights < 1) out.push({ action: "midnight UTC", next: { ...s, paidToday: 0, midnights: 1 } });
			return out;
		},
		invariants: {
			"daily spending plus reservations stay within the daily budget": s => spent(s) <= DAILY,
			"lifetime task spending plus reservations stay within the task cap": s => lifetime(s) <= TASK,
			"payments above the auto-approval limit were approved by a human": s => !s.unapproved,
		},
	};
}
