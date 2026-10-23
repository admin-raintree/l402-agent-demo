// A small explicit-state model checker in the style of TLC: breadth-first search over every
// reachable state of a model, checking invariants in each state and returning the shortest
// trace to a violation. `eventually` checks that from every reachable state some state
// satisfying the goal can still be reached (TLA+'s []<>-style "nothing gets stuck", as AG EF).

export type Step<S> = { action: string; next: S };

export type Model<S> = {
	init: S[];
	next(s: S): Step<S>[];
	invariants: Record<string, (s: S) => boolean>;
	/** Goals that must stay reachable from every state. */
	eventually?: Record<string, (s: S) => boolean>;
};

export type Violation = { property: string; trace: string[] };
export type Result = { states: number; violations: Violation[] };

export function check<S>(model: Model<S>, maxStates = 500_000): Result {
	const key = (s: S) => JSON.stringify(s);
	const parent = new Map<string, { from?: string; action?: string; state: S }>();
	const edges = new Map<string, string[]>();
	const queue: string[] = [];
	for (const s of model.init) if (!parent.has(key(s))) { parent.set(key(s), { state: s }); queue.push(key(s)); }
	const violations: Violation[] = [];
	const found = new Set<string>();
	const trace = (k: string) => {
		const out: string[] = [];
		for (let n = parent.get(k); n?.from !== undefined; n = parent.get(n.from)) out.unshift(n.action!);
		return out;
	};
	for (let i = 0; i < queue.length; i++) {
		if (parent.size > maxStates) throw new Error(`state space exceeds ${maxStates}`);
		const k = queue[i], s = parent.get(k)!.state;
		for (const [name, holds] of Object.entries(model.invariants))
			if (!found.has(name) && !holds(s)) { found.add(name); violations.push({ property: name, trace: trace(k) }); }
		const out: string[] = [];
		for (const { action, next } of model.next(s)) {
			const nk = key(next);
			out.push(nk);
			if (!parent.has(nk)) { parent.set(nk, { from: k, action, state: next }); queue.push(nk); }
		}
		edges.set(k, out);
	}
	for (const [name, goal] of Object.entries(model.eventually ?? {})) {
		// Backward fixpoint: states that can reach the goal.
		const reach = new Set([...parent.keys()].filter(k => goal(parent.get(k)!.state)));
		for (let changed = true; changed;) {
			changed = false;
			for (const [k, out] of edges) if (!reach.has(k) && out.some(n => reach.has(n))) { reach.add(k); changed = true; }
		}
		const stuck = queue.find(k => !reach.has(k));
		if (stuck) violations.push({ property: name, trace: trace(stuck) });
	}
	return { states: parent.size, violations };
}
