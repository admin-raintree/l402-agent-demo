import { expect, test } from "bun:test";
import { assessResponse, qualitySchema } from "./quality";

const now = new Date("2026-10-21T12:00:00Z");
const rules = qualitySchema.parse({ required_fields: ["market.price", "active"], freshness: { max_age_seconds: 60 } });
const data = { market: { price: 0 }, active: false, as_of: "2026-10-21T11:59:00Z" };

test("required paths accept zero and false and freshness includes the exact age boundary", () => {
	expect(assessResponse(data, 200, rules, now)).toMatchObject({ status: "passed", usable: true, age_seconds: 60, reasons: [] });
	expect(assessResponse({ ...data, as_of: "2026-10-21T04:59:00-07:00" }, 200, rules, now).usable).toBe(true);
});

test("missing, null, nested and inherited fields are checked without evaluating paths", () => {
	const requirements = qualitySchema.parse({ required_fields: ["market.price", "absent", "constructor", "items.0.value"] });
	const result = assessResponse({ market: { price: null }, items: [{ value: false }] }, 200, requirements, now);
	expect(result.reasons).toEqual(["missing_required_field:market.price", "missing_required_field:absent", "missing_required_field:constructor"]);
	expect(result.usable).toBe(false);
});

for (const timestamp of [undefined, null, 1792584000, "yesterday", "2026-10-21", "2026-10-21T11:59:00", "2026-02-30T12:00:00Z"]) {
	test(`rejects invalid freshness timestamp ${String(timestamp)}`, () => {
		expect(assessResponse({ ...data, as_of: timestamp }, 200, rules, now).reasons).toEqual(["invalid_timestamp:as_of"]);
	});
}

test("stale and future timestamps fail independently of HTTP success", () => {
	expect(assessResponse({ ...data, as_of: "2026-10-21T11:58:59Z" }, 200, rules, now).reasons).toEqual(["stale_timestamp:as_of"]);
	expect(assessResponse({ ...data, as_of: "2026-10-21T12:00:01Z" }, 200, rules, now).reasons).toEqual(["future_timestamp:as_of"]);
});

test("malformed or non-object bodies cannot pass configured checks", () => {
	for (const body of ["{invalid", "resource", null, 0, true])
		expect(assessResponse(body, 200, rules, now)).toMatchObject({ status: "failed", usable: false, reasons: ["expected_json_object_or_array"] });
});

test("unconfigured success is unchecked; HTTP and transport failures are unusable", () => {
	expect(assessResponse("resource", 200, undefined, now)).toMatchObject({ status: "not_checked", usable: null });
	expect(assessResponse(data, 503, rules, now)).toMatchObject({ status: "failed", usable: false, reasons: ["http_status:503"] });
	expect(assessResponse(undefined, null, rules, now).reasons).toEqual(["response_unavailable"]);
	expect(assessResponse(undefined, 200, rules, now, true).usable).toBe(false);
});

test("rejects empty or malformed requirements before a fetch", () => {
	for (const input of [{}, { required_fields: [] }, { required_fields: ["a..b"] }, { freshness: { max_age_seconds: -1 } },
		{ freshness: { max_age_seconds: 0.5 } }, { required_field: ["typo"] }])
		expect(qualitySchema.safeParse(input).success).toBe(false);
});
