# Response quality checks

Details for the `quality` option of `l402_fetch`. The [README](../README.md#response-quality) has an example and the result states.

## Field and freshness rules

Required fields use dot-separated paths, including array indices such as `items.0.price`. Each must exist as an own property and be non-null; zero, false, and empty strings are valid. These are presence checks, not type or value checks. Freshness requires an ISO timestamp with an explicit timezone (`Z` or an offset); the field defaults to `as_of`. Missing, invalid, future, or older-than-allowed timestamps fail. Age is measured when the body is read; the exact maximum age is accepted. The provider supplies the timestamp, so passing does not establish factual accuracy or independent provenance.

## Results and records

`resource_delivered` still describes successful HTTP/body delivery. A response can have `paid: true` and `resource_delivered: true` but `quality.usable: false`. The bundled fixed-market snapshot will fail a short freshness window; its timestamp is preserved rather than replaced with the current time.

Each authenticated response attempt, including credential reuse and failed delivery, gets a `response_check_id` and an append-only assessment linked to its payment hash (when known) and the current fetch's task ID. `l402_task.response_checks` shows that task's history; `l402_wallet.recent_response_checks` shows the latest eight assessments. The records store metadata and check results, not response bodies or credentials. Legacy credentials may lack a payment hash, and historical purchases or crashes before recording an assessment have no inferred quality result. Free responses are checked and returned but are not stored in paid-response history.

Quality failures do not refund spending, release settled charges, invalidate credentials, or authorize another payment. Later calls may reuse the credential and assess a different response; earlier assessments and payment receipts remain unchanged.
