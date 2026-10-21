import { z } from "zod";

const fieldPath = z.string().min(1).max(200).refine(path => path.split(".").every(Boolean), "Use nonempty dot-separated field names");
export const qualitySchema = z.object({
	required_fields: z.array(fieldPath).min(1).max(100).optional()
		.describe("Dot-separated JSON paths that must exist and be non-null; zero and false are valid"),
	freshness: z.object({
		field: fieldPath.default("as_of"),
		max_age_seconds: z.number().int().nonnegative().safe(),
	}).optional().describe("Require a timezone-qualified ISO timestamp no older than this limit; future timestamps fail"),
}).strict().refine(value => value.required_fields !== undefined || value.freshness !== undefined,
	"Specify required_fields or freshness");
export type QualityRequirements = z.infer<typeof qualitySchema>;
export type QualityResult = {
	status: "passed" | "failed" | "not_checked";
	usable: boolean | null;
	checked_at: string;
	requirements?: QualityRequirements;
	reasons: string[];
	age_seconds?: number;
};
export type ResponseCheck = {
	id: string;
	task_id?: string;
	payment_hash?: string;
	url: string;
	method: "GET" | "POST";
	http_status: number | null;
	resource_delivered: boolean;
	reused_paid_token: boolean;
	quality: QualityResult;
};

function field(body: unknown, path: string): unknown {
	let value = body;
	for (const key of path.split(".")) {
		if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
		value = (value as Record<string, unknown>)[key];
	}
	return value;
}

/** Passing checks establishes only the requested shape and reported age, not factual accuracy. */
export function assessResponse(body: unknown, httpStatus: number | null, requirements?: QualityRequirements,
	now = new Date(), bodyUnavailable = false): QualityResult {
	const result: QualityResult = { status: "not_checked", usable: null, checked_at: now.toISOString(), requirements, reasons: [] };
	if (httpStatus === null || bodyUnavailable) result.reasons.push("response_unavailable");
	if (httpStatus !== null && (httpStatus < 200 || httpStatus >= 300)) result.reasons.push(`http_status:${httpStatus}`);
	if (result.reasons.length === 0 && requirements) {
		if (body === null || typeof body !== "object") result.reasons.push("expected_json_object_or_array");
		else {
			for (const path of requirements.required_fields ?? [])
				if (field(body, path) == null) result.reasons.push(`missing_required_field:${path}`);
			if (requirements.freshness) {
				const { field: path, max_age_seconds } = requirements.freshness;
				const timestamp = field(body, path);
				if (!z.iso.datetime({ offset: true }).safeParse(timestamp).success)
					result.reasons.push(`invalid_timestamp:${path}`);
				else {
					result.age_seconds = (now.getTime() - Date.parse(timestamp as string)) / 1000;
					if (!Number.isFinite(result.age_seconds)) result.reasons.push(`invalid_timestamp:${path}`);
					else if (result.age_seconds < 0) result.reasons.push(`future_timestamp:${path}`);
					else if (result.age_seconds > max_age_seconds) result.reasons.push(`stale_timestamp:${path}`);
				}
			}
		}
	}
	if (result.reasons.length) { result.status = "failed"; result.usable = false; }
	else if (requirements) { result.status = "passed"; result.usable = true; }
	return result;
}
