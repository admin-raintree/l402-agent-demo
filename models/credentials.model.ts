// Which credential l402_fetch reuses, and when it pays, for one provider resource (/data, which the
// manifest names service "data"). Mirrors the l402_fetch handler in agent/server.ts and the repayment
// guard in Store.reserve. The environment may take the manifest down, expire any credential, move the
// subscription through its periods, cancel it, and leave a payment unresolved for later reconciliation.
import type { Model, Step } from "./check";

export type CredentialFixes = {
	/** Resolve the service from the ledger when discovery fails, and check pathname-keyed records. */
	serviceAliases: boolean;
	/** In the subscription branch, also try a credential bought without a subscription, and wait on any unresolved payment. */
	plainInSubscription: boolean;
};

type Outcome = "paid" | "pending" | "failed";
type Purchase = { key: string; service: string; outcome: Outcome; period: number | null };
type Token = { key: string; period: number | null; expired: boolean };
export type CredentialState = {
	manifest: boolean;
	sub: "none" | "active" | "cancelled";
	/** Current subscription period; `periods` means the schedule has ended. */
	period: number;
	purchases: Purchase[];
	tokens: Token[];
	fetches: number;
	expiries: number;
	/** First safety violation the fetch logic committed, if any. */
	bad: string | null;
};

const PERIODS = 2, MAX_FETCHES = 4, MAX_EXPIRIES = 2;
const PATH = "/data", NAMED = "data";

export function credentialModel(fix: CredentialFixes): Model<CredentialState> {
	const put = (s: CredentialState, t: Token) =>
		[...s.tokens.filter(x => x.key !== t.key), t].sort((a, b) => a.key.localeCompare(b.key));
	const token = (s: CredentialState, key: string) => s.tokens.find(t => t.key === key);
	const forKey = (s: CredentialState, key: string) => s.purchases.find(p => p.key === key && p.outcome !== "failed");

	function fetch(s: CredentialState): Step<CredentialState>[] {
		const done = (action: string, next: Partial<CredentialState> = {}) => [{ action, next: { ...s, fetches: s.fetches + 1, ...next } }];
		// serviceFor(url): the manifest's name, else (fixed) the name the ledger recorded for this path.
		const known = fix.serviceAliases && s.purchases.some(p => p.service === NAMED) ? NAMED : PATH;
		const service = s.manifest ? NAMED : known;
		const plainToken = () => token(s, service) ?? (fix.serviceAliases ? token(s, PATH) : undefined);
		const pay = (key: string, period: number | null, why: string): Step<CredentialState>[] => {
			const bad = s.bad ?? (s.tokens.some(t => !t.expired) ? `paid (${why}) while holding a credential the provider accepts` :
				s.purchases.some(p => p.outcome === "pending") ? `paid (${why}) while another payment for the service is unresolved` : null);
			const base = { ...s, fetches: s.fetches + 1, bad };
			return (["paid", "pending", "failed"] as const).map(outcome => ({
				action: `fetch → pay ${key} (${why}) → ${outcome}`,
				next: { ...base, purchases: [...s.purchases, { key, service, outcome, period }],
					tokens: outcome === "paid" ? put(s, { key, period, expired: false }) : s.tokens },
			}));
		};
		if (s.sub !== "none" && service === NAMED) {
			const subToken = s.tokens.filter(t => t.period !== null).sort((a, b) => b.period! - a.period!)[0];
			const held = fix.plainInSubscription ? [subToken, plainToken()].filter(t => t !== undefined) : subToken ? [subToken] : [];
			// Every credential here carries an expiry, so a 402 on an expired one moves on to the next, then may renew.
			if (held.some(t => !t.expired)) return done("fetch → reuse credential");
			if (fix.plainInSubscription && s.purchases.some(p => p.outcome === "pending")) return done("fetch → report unresolved payment");
			if (s.sub !== "active" || s.period >= PERIODS) return done("fetch → refused: subscription not active");
			const key = `sub#${s.period}`;
			const existing = forKey(s, key);
			if (existing?.outcome === "paid" && subToken?.period === s.period) return done("fetch → refused: already renewed");
			if (existing) return done("fetch → report existing payment");
			return pay(key, s.period, "standing renewal");
		}
		const held = plainToken();
		if (held) return done(held.expired ? "fetch → credential rejected, repayment blocked" : "fetch → reuse credential");
		if (forKey(s, service) ?? (fix.serviceAliases ? forKey(s, PATH) : undefined)) return done("fetch → report existing payment");
		// Store.reserve blocks a repayment when a paid or pending receipt names the same service.
		const blocked = s.purchases.some(p => p.period === null && p.outcome !== "failed" &&
			(p.service === service || (fix.serviceAliases && p.service === PATH)));
		if (blocked) return done("fetch → refused: previous payment exists");
		return pay(service, null, "one-off purchase");
	}

	return {
		init: [{ manifest: true, sub: "none", period: 0, purchases: [], tokens: [], fetches: 0, expiries: 0, bad: null }],
		next(s) {
			const out: Step<CredentialState>[] = [{ action: s.manifest ? "manifest goes down" : "manifest comes back", next: { ...s, manifest: !s.manifest } }];
			if (s.fetches < MAX_FETCHES) out.push(...fetch(s));
			if (s.sub === "none" && s.manifest) out.push({ action: "subscribe", next: { ...s, sub: "active", period: 0 } });
			if (s.sub === "active") out.push({ action: "cancel subscription", next: { ...s, sub: "cancelled" } });
			if (s.sub !== "none" && s.period < PERIODS) out.push({ action: "period ends", next: { ...s, period: s.period + 1 } });
			if (s.expiries < MAX_EXPIRIES) for (const t of s.tokens) if (!t.expired)
				out.push({ action: `credential ${t.key} expires`, next: { ...s, expiries: s.expiries + 1, tokens: put(s, { ...t, expired: true }) } });
			s.purchases.forEach((p, i) => {
				if (p.outcome !== "pending") return;
				for (const outcome of ["paid", "failed"] as const) out.push({ action: `reconcile ${p.key} → ${outcome}`, next: { ...s,
					purchases: s.purchases.map((q, j) => j === i ? { ...q, outcome } : q),
					tokens: outcome === "paid" ? put(s, { key: p.key, period: p.period, expired: false }) : s.tokens } });
			});
			return out;
		},
		invariants: {
			"never pays while holding an accepted credential or awaiting another payment": s => s.bad === null,
			"at most one renewal per period": s => [...Array(PERIODS).keys()]
				.every(k => s.purchases.filter(p => p.period === k && p.outcome !== "failed").length <= 1),
		},
	};
}
