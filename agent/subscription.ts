// Standing approvals for recurring L402 purchases. A human approves "up to capSat per period
// to this provider's service, for N periods" once; renewals then pay within that approval.
// Periods are measured from the approval, not from the seller's credential lifetime.

export type Subscription = {
	id: string;
	origin: string;
	service: string;
	/** Payee node from the provider's manifest; renewals to another node are refused. */
	nodePubkey?: string;
	/** Most one period may cost, including maximum routing fees. */
	capSat: number;
	periodSeconds: number;
	periods: number;
	startsAt: string;
	createdAt: string;
	status: "active" | "cancelled";
	cancelledAt?: string;
};

export type SubscriptionState = "scheduled" | "active" | "cancelled" | "expired";

const elapsed = (sub: Subscription, now: Date) => now.getTime() - Date.parse(sub.startsAt);

/** Index of the period containing `now`, or undefined outside the approved schedule. */
export function periodAt(sub: Subscription, now: Date): number | undefined {
	const ms = elapsed(sub, now);
	if (ms < 0) return undefined;
	const k = Math.floor(ms / (sub.periodSeconds * 1000));
	return k < sub.periods ? k : undefined;
}

export function periodStart(sub: Subscription, k: number): Date {
	return new Date(Date.parse(sub.startsAt) + k * sub.periodSeconds * 1000);
}

export function subscriptionState(sub: Subscription, now: Date): SubscriptionState {
	if (sub.status === "cancelled") return "cancelled";
	if (elapsed(sub, now) < 0) return "scheduled";
	return periodAt(sub, now) === undefined ? "expired" : "active";
}

/** Each period buys its own credential, so earlier periods never block a renewal. */
export const periodKey = (sub: Pick<Subscription, "id" | "origin" | "service">, k: number) =>
	`${sub.origin} ${sub.service} #sub-${sub.id}/${k}`;

/** First-party caveat identifiers of a version-2 binary macaroon, as Aperture mints them. */
export function macaroonCaveats(encoded: string): string[] {
	const b = Buffer.from(encoded, "base64");
	let i = 0;
	if (b[i++] !== 2) throw new Error("unsupported macaroon version");
	const field = (): { type: number; value?: Buffer } => {
		if (i >= b.length) throw new Error("truncated macaroon");
		const type = b[i++];
		if (type === 0) return { type };
		let length = 0;
		for (let shift = 0; ; shift += 7) {
			if (i >= b.length || shift > 28) throw new Error("malformed macaroon length");
			const byte = b[i++];
			length += (byte & 0x7f) * 2 ** shift;
			if (!(byte & 0x80)) break;
		}
		if (i + length > b.length) throw new Error("truncated macaroon");
		const value = b.subarray(i, i + length);
		i += length;
		return { type, value };
	};
	while (field().type !== 0);
	const caveats: string[] = [];
	for (let f = field(); f.type !== 0; f = field()) {
		let id: string | undefined;
		for (; f.type !== 0; f = field()) if (f.type === 2) id = f.value!.toString("utf8");
		if (id !== undefined) caveats.push(id);
	}
	return caveats;
}

/**
 * Earliest `<service>_valid_until` expiry (Unix seconds) in an `L402 <macaroon>:<preimage>`
 * credential. Undefined when the credential carries no expiry or cannot be parsed, so the
 * caller treats a 402 as a rejection rather than a lapse.
 */
export function credentialExpiry(credential: string): number | undefined {
	const macaroon = credential.replace(/^(?:L402|LSAT) /, "").split(":")[0];
	let caveats: string[];
	try { caveats = macaroonCaveats(macaroon); } catch { return undefined; }
	const expiries = caveats.map(c => c.match(/^[^=\s]+_valid_until=(\d+)$/)?.[1]).filter(Boolean).map(Number);
	return expiries.length ? Math.min(...expiries) : undefined;
}
