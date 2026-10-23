// Runs every model to exhaustion. Each fixed configuration must satisfy its properties, and turning a
// fix off must produce the counterexample it prevents, so a model that checks nothing fails here.
import { expect, test } from "bun:test";
import { check } from "./check";
import { budgetModel } from "./budget.model";
import { credentialModel } from "./credentials.model";
import { settlementModel } from "./settlement.model";

const NO_DOUBLE_PAY = "never pays while holding an accepted credential or awaiting another payment";
const properties = (r: ReturnType<typeof check>) => r.violations.map(v => v.property);

test("credentials: the agent never pays while holding access the provider accepts", () => {
	expect(check(credentialModel({ serviceAliases: true, plainInSubscription: true })).violations).toEqual([]);
	const outage = check(credentialModel({ serviceAliases: false, plainInSubscription: true })).violations;
	expect(outage).toEqual([{ property: NO_DOUBLE_PAY, trace: ["fetch → pay data (one-off purchase) → paid", "manifest goes down",
		"fetch → pay /data (one-off purchase) → paid"] }]);
	const subscribe = check(credentialModel({ serviceAliases: true, plainInSubscription: false })).violations;
	expect(subscribe).toEqual([{ property: NO_DOUBLE_PAY, trace: ["fetch → pay data (one-off purchase) → paid", "subscribe",
		"fetch → pay sub#0 (standing renewal) → paid"] }]);
});

test("settlement: only wallet evidence settles or releases a reservation", () => {
	const fixed = check(settlementModel({ failOnlyOnEvidence: true }));
	// Known and documented: if the process dies before the wallet records the send, the wallet can never
	// report an outcome, so the reservation is kept forever rather than risk a payment that did happen.
	expect(fixed.violations).toEqual([{ property: "every reservation can still resolve",
		trace: ["fetch reserves a new invoice", "wallet reply lost"] }]);
	expect(properties(check(settlementModel({ failOnlyOnEvidence: false })))).toEqual(expect.arrayContaining([
		"a failed row never hides a settled payment", "the service is paid for at most once"]));
});

test("budgets: concurrent agents, prompts, and midnight never overspend", () => {
	expect(check(budgetModel({ recheckInReserve: true })).violations).toEqual([]);
	expect(properties(check(budgetModel({ recheckInReserve: false })))).toEqual(expect.arrayContaining([
		"daily spending plus reservations stay within the daily budget", "lifetime task spending plus reservations stay within the task cap"]));
});
