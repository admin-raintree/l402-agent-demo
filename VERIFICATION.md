# Verify payment recovery and spending limits

The resource-viewer cleanup passed 58 tests on 2026-10-15 in 42.47 seconds. Browser interaction checks and both local Lightning smoke tests passed. The mining planner and its calculation benchmarks were removed; those benchmarks did not establish research quality or product value.

## Resource viewer checks

| Check | Observed result | Boundary |
|---|---|---|
| Generated accounting | 100,000 seeded sequences; 800,000 transitions; 281,882 accepted reservations; zero observed allowance or authorization violations | Simulated accounting, assuming the wallet honors its fee cap. |
| Concurrent request budget | Eight independent processes competed for one allowance; one reservation succeeded | Shared local SQLite state. |
| Approval and delivery | Approve, decline, stop, credential reuse, withheld responses, oversized responses, and uncertain payments passed | Mock wallet and HTTP provider. Provider content is displayed, not evaluated for quality. |
| Resource boundary | Cross-origin paths, traversal, fragments, altered provider, and excessive limits rejected | Configured provider plus an immutable resource path. |
| Legacy records | Original research data stays readable; new purchases from those records are blocked | Existing tables and payment references remain intact. |
| Real Lightning purchase | Approved 1,000 sats; zero routing fee; response retained; buyer and seller histories agreed | Isolated regtest, test coins only. |
| Browser workflow | Create, decline, stop, resume, keyboard approval, raw response display, and polling focus passed | Installed headless Chrome; mock wallet. |
| Accessibility checks | Field/action names, table scopes, document language, heading, live status, keyboard operation, and mobile overflow passed | Desktop 1440×1050 and mobile 390×844; no full WCAG audit or user study. |

Authorization, payment, and delivery remain separate. Successful delivery means an HTTP response arrived; it does not mean the provider supplied accurate or useful content. The viewer escapes response text and never treats it as payment instructions. Responses remain bounded to 64 KiB.

## Recovery matrix

| Failure point | Expected and tested behavior |
|---|---|
| Before or inside reservation commit | No partial reservation survives. |
| After reservation, before known wallet outcome | Fee-inclusive reservation survives; no automatic resend. |
| During settlement commit | Credential and charge commit together or neither commits. |
| After wallet send / during lookup | Restart reconciles through wallet history without a second send. |
| Awaiting dashboard approval | Restart expires the old prompt; resuming requires a fresh approval. |
| Dashboard with an unresolved payment | Record survives; resuming reconciles settlement and reuses proof. |
| After a delivered response | Request, response, and receipt survive process termination. |
| Paid but withheld or oversized response | Request stays blocked; charge remains visible and retries reuse the credential. |
| Stop while awaiting approval | No payment is sent. Already submitted payments might still settle. |

Telemetry retains state events and durations. Tests check that dashboard payment records do not expose macaroons or payment preimages. Old pending payments can be reconciled through `l402_wallet`; archived research records cannot start new fetches.

## Reproduce

1. Run `bun install --frozen-lockfile`.
2. Run `bun test`.
3. Run `bun run build:binaries` if `.bin` is absent.
4. Run `bun run verify:local` for an isolated network and both smoke tests.
5. Run `PLAYWRIGHT_MODULE=/path/to/installed/playwright bun run test:browser`. Chrome must already be installed, or select an installed channel through `PLAYWRIGHT_CHANNEL`.

`up` now refuses a nonempty state directory. The verification command creates a fresh temporary directory and keeps startup and smoke testing in the same shell. Existing `.demo` state is preserved.

Test output: `/tmp/l402-cleanup-tests.log`. Regtest output: `/tmp/l402-cleanup-regtest.log`; network state: `/var/folders/gh/h0w35ykj38g704395y8_wz400000gn/T/l402-regtest.lF0hdc`. Browser output: `/tmp/l402-cleanup-browser.log`. Screenshots: `/var/folders/gh/h0w35ykj38g704395y8_wz400000gn/T/l402-browser-RxSTfx`. Local temporary evidence can be removed by the operating system.

The sandbox prevented local HTTP listeners; the suite passed when rerun with local-server permission. Bundling `dashboard/server.ts` passed. This is a compilation check, not a TypeScript type check. Prose was reviewed manually; an automated grammar checker was not run.

## Versions and source checks

| Component | Verified source or runtime |
|---|---|
| Bun | 1.4.2 |
| lnd | v0.21.3-beta, commit `572b561bf05f03dfe6135110970c4d858c3482dc` |
| Aperture | v0.5.0, commit `311220b15b04c06ecabd52c78fde8f5d6ea73c82` |
| btcd | v0.26.2, commit `05585e037ba0690572208dbc46d121a49cc0c4c9` |
| Wavelength contract | `rpc/wavewalletrpc/wallet.proto` at `2c4f1ee`; no running daemon verified |

The pinned [Wavelength protocol](https://github.com/lightninglabs/wavelength/blob/2c4f1ee/rpc/wavewalletrpc/wallet.proto) returns `activity.entries`, `activity.has_more`, and `activity.next_cursor` for activity listings. The previous fixture used an incorrect top-level `entries` field. Recovery now follows cursors and rejects malformed pagination.

[Aperture v0.5.0](https://github.com/lightninglabs/aperture/blob/v0.5.0/README.md) already documents its admin API. Its checked-out `go.mod` requires Go 1.26. The README prerequisites now reflect that requirement. No dependency versions were upgraded.

## Test and smoke-test coverage

The test suite covers:

- Seeds 1–100,000: 800,000 accounting transitions and 281,882 reservations. An independent model checks fees, declines for insufficient allowance, unresolved outcomes, confirmed failures, settlement, retries, and UTC midnight. These are simulated accounting sequences, not 100,000 live network payments.
- SIGKILL before, inside, and after reservation transactions, and inside and after settlement transactions. A reopened database must contain either the committed state or the previous state, never a token without its charge.
- MCP process termination after sending, during wallet lookup, and after settlement. A restarted client must retrieve the resource without another send.
- Concurrent MCP processes sharing a state directory; lost send responses; unavailable wallet history; decline, cancel, unsupported elicitation, and disconnect.
- Invalid proof, rejected credentials, excessive price, unsupported settlement rails, paginated history, and repeated cursors.
- Legacy import without deleting source files; late proof recovery without charging a new day.

The smoke test uses real regtest Lightning payments through Aperture. It checks automatic payment, credential reuse, per-call refusal, human decline and approval, and daily-budget refusal. It also queries buyer payment history and seller invoices, verifies preimages independently, and compares amounts and fees with receipts.

An initial smoke run found a startup race: an active channel did not yet provide a usable route. Startup now waits for a successful route query before reporting readiness.

## Remaining live checks

### Wavelength signet

Needed: a dedicated funded signet `waved`, its scoped macaroon and TLS certificate paths, a signet Aperture URL, seller invoice-read access, and a test spending allowance. Neither `waved` nor live credentials were available for this run.

The official [test-network guide](https://github.com/lightninglabs/wavelength/blob/main/docs/signet.md) lists public Ark and swap endpoints. Their publication does not establish availability or compatibility with the pinned API.

1. Verify the daemon version and RPC response shapes against the pinned contract. Configure the wallet using the README environment variables and a fresh state directory.
2. Discover a dedicated test service, then fetch it with an explicit `max_sats` that includes maximum fees.
3. Compare the ledger payment hash with wallet activity and the seller's settled invoice. Verify the preimage hash and successful resource response.
4. Restart the MCP process and repeat the fetch. Require credential reuse and an unchanged count of settled wallet payments.
5. Repeat with a dropped response and confirm that recovery does not send again. Compare the actual wallet outflow, including swap fees, against the approved maximum.

### litd allowance

Needed: a regtest litd instance with account middleware enabled, an account-restricted macaroon, seller invoice access, and a funded route. No litd binary or configured account was available for this run.

The official [LND Accounts documentation](https://docs.lightning.engineering/lightning-network-tools/lightning-terminal/accounts) describes enforcement of account balance including fees and concurrent in-flight payments. It does not replace daily rollover or human approval.

1. Create a dedicated 100-sat account with `litcli accounts create 100 --save_to /path/to/account.macaroon`.
2. Create a 101-sat invoice on a separate regtest node. Attempt to pay it directly with `lncli --macaroonpath=/path/to/account.macaroon`, using the account middleware's RPC endpoint and TLS configuration.
3. Require rejection, an unpaid seller invoice, and an unchanged account balance. This bypasses the MCP policy and tests the independent enforcement boundary.
4. Attempt concurrent payments whose combined principal and maximum fees exceed 100 sats. Reconcile account balance, pending payments, and seller invoices; require total committed spending to stay within the allowance.

## Limits of the evidence

The model assumes that a wallet honors the requested fee cap and truthfully reports terminal outcomes. It cannot prove a remote wallet's enforcement. SIGKILL tests exercise process failure, not disk loss or power-loss durability. Pending reservations can remain indefinitely when the wallet cannot establish an outcome. Separate state directories cannot coordinate spending. Rejected or expired credentials deliberately block automatic repurchase.

Human comprehension testing, CPU/heap profiling, live Wavelength settlement, and litd bypass tests were not run. No new latency benchmark was run. The suite does not prove exactly-once execution of a provider's HTTP operations or guarantee delivery after payment.
