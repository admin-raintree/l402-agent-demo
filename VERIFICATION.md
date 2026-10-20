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
4. Run `bun run verify:local` for an isolated network and the payment, resource, and subscription smoke tests.
5. Run `PLAYWRIGHT_MODULE=/path/to/installed/playwright bun run test:browser`. Chrome must already be installed, or select an installed channel through `PLAYWRIGHT_CHANNEL`.
6. Run `bun run build:litd`, then `bun run verify:litd` for the litd account allowance check and the subscription through a litd account.

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
| Lightning Terminal (litd, litcli) | v0.17.7, commit `8976aa881d427cc50c4c3b67956e7a271caa6b54`; built with `litd_no_ui` and release tags; remote mode; Go 1.27.2 |
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

## Subscriptions

On 2026-10-19, `bun test` passed 67 tests in 134.53 seconds: the original 58 plus 9 in `agent/subscription.test.ts`. The seeded accounting result is unchanged (281,882 reservations). `bun run verify:local` passed all three smoke tests, including the new subscription smoke.

| Check | Observed result | Boundary |
|---|---|---|
| Aperture `timeout` caveat | `timeout: 4` minted `hashprice_valid_until` at mint time plus 4 s; the service without a timeout had no expiry caveat; Aperture answered the expired credential with a fresh 402 | Live regtest Aperture v0.5.0, static pricing. Dynamic pricing not tested. |
| Standing approval | One prompt at subscription time with auto-approval at 0; two renewals paid without prompts; receipts record `approval: "standing"` | Regtest; 20 sats per 12-second period. |
| One renewal per period | Expired credential inside period 0 refused; renewal paid at the start of period 1. Eight racing processes produced one reservation for one period | Live regtest plus local SQLite. |
| Cancellation and expiry | After cancel, the paid credential kept working until its expiry, then no renewal. Expired and scheduled states refuse | Live regtest plus unit tests. |
| Limits | Cap includes the maximum fee; daily budget still applies; provider, service, node, period, and key must match; pending blocks and confirmed failure frees the period | Unit tests with injected clocks. |
| Early 402 | A 402 before the credential's own expiry is treated as a rejection and pays nothing | MCP test against a mock provider. |
| Reconciliation | Both renewals settled; preimages hash to payment hashes; fees and seller invoices match receipts | Live regtest. |

Not covered: dashboard requests with subscriptions, manifest subscription terms, and real 30-day periods. Paying through a litd account macaroon is covered [below](#litd-account-subscription). Timing tests use second-scale periods.

## litd account allowance

On 2026-10-19, `bun run verify:litd` passed four consecutive runs on a fresh regtest network. litd v0.17.7 ran in remote mode against the pinned buyer lnd, started with `--rpcmiddleware.enable`. Payments used an account-restricted macaroon with `lncli payinvoice`, bypassing the MCP policy. Only litd's account interceptor could refuse them.

| Check | Observed result |
|---|---|
| 101 sats, fee limit 0, through litd | Rejected: `account balance insufficient`. Seller invoice `OPEN`, 0 paid; account 100 → 100; no buyer payment record. |
| 101 sats against lnd's own RPC port | Same rejection. lnd forwarded the request to litd's interceptor without passing through litd's proxy. |
| 95 sats, 10-sat fee limit | Rejected. The account checks the principal plus the maximum fee, not the principal alone. |
| Five concurrent 30-sat payments, 10-sat fee limits (200 sats requested) | Two payments were held in flight by seller hold invoices; three were rejected while those two were outstanding. After settlement: two invoices `SETTLED`, three `OPEN`; 60 sats spent, 0 fees; account 100 → 40. |
| 31 sats, 10-sat fee limit, after concurrency | Rejected; balance stayed 40. |

Each run gave the same result. The interceptor reserves each payment's principal plus its maximum fee, and refunds the unused fee at settlement.

Source reading, not an observed race: `accounts/checkers.go` `checkSend` calls `CheckBalance` (read lock) and then `AssociatePayment` (write lock) separately. lndclient's `RegisterRPCMiddleware` handles intercepted requests one at a time on a single stream, which closes that window in practice. Five concurrent payments were tested; larger fan-out was not.

The script keeps the account macaroon in the owner-only state directory and preimages in memory. It prints neither. Build litd with `bun run build:litd`. Logs from the four runs were written to session scratch files, not committed paths.

## litd account subscription

On 2026-10-19, the MCP wallet paid a subscription through a litd account macaroon. The `L402_LND_*` overrides pointed lncli at litd (`127.0.0.1:8443`, `lit/tls.cert`). Checks run:

- `bun test`: 72 tests passed in 67.93 s. That is the previous 67 plus 5 in `agent/lnd-wallet.test.ts`, which pin the default lncli arguments and the overrides.
- `bun run verify:local`: passed the payment, resource and subscription smokes. `subscription-smoke.ts` now starts its Aperture through the shared `scripts/timed-aperture.ts`.
- `bun run verify:litd`: passed twice in a row. Each run included the allowance check and the new [`scripts/litd-subscription-smoke.ts`](scripts/litd-subscription-smoke.ts). An earlier attempt failed before any check ran: another session's regtest network was using the same fixed ports.

Both passing runs gave the same results. The second run added the direct `lndWallet.pay` check in the second-directory row:

| Check | Observed result |
|---|---|
| Wallet calls through the account | `decodepayreq`, `payinvoice`, `listpayments` and `channelbalance` all succeeded with the account macaroon. |
| `channelbalance` | 40 sats: the account's virtual balance. The real channel held 1,998,996 sats. `l402_wallet` reported `balance_sat` 20 after the renewals. |
| Account | 40 sats (20-sat cap × 2 periods), with an expiration date set at creation to 2 × 12 s + 10 s. It therefore expired about 8 s after the subscription's last period ended. |
| Subscription | One prompt (auto-approval 0). Periods 0 and 1 each paid 10 + 0 sats under the standing approval. |
| Second MCP state directory | No subscription; auto-approval 100, daily budget 1,000. It approved a 50-sat purchase without a prompt. The MCP result was `pending` ("payment unresolved"), with 60 sats reserved in that directory. Seller invoice `OPEN`, no buyer payment record, account unchanged at 20. The same `lndWallet.pay` call on a fresh 50-sat invoice failed with `error validating account balance: account balance insufficient`. |
| Direct lncli on lnd's port | 11 sats with a 10-sat fee limit (21 > 20): `account balance insufficient`; invoice `OPEN`; balance 20. |
| After expiry | A 5-sat payment with fee limit 0 (it fits the 20-sat balance): `account <id> has expired`. The wallet's `channelbalance` failed with the same error. |
| Reconciliation | Account 40 → 20 = the sum of the two receipts including fees. Both buyer payments `SUCCEEDED`; preimages hash to the payment hashes; seller invoices `SETTLED` for 10 sats each. |

Observed in a manual probe on the same versions, not asserted by the script: `listpayments` through the account returned only the account's payments, but `last_index_offset` still counted the payments it filtered out. A one-payment page past an admin payment came back empty, with offsets 2 → 2.

Inferred, not tested:

- The 20 sats left in the account are the unused fee reserve. Any holder of the macaroon could spend them on any invoice until expiry. A payment that fit them was not attempted.
- The wallet's `listpayments` lookup stops at the first empty page. Through litd it could report `unknown` for an account payment behind more than 100 payments from other macaroons.
- After expiry, reconciliation through `listpayments` is probably refused too, like `channelbalance`.

The application records a litd refusal as an unresolved payment, not a failure. It keeps the reservation and blocks retries, as for a lost response. This is safe but needs manual cleanup. The account macaroon stays in the owner-only state directory. Logs were scanned for macaroon and preimage values; none were found.

## Limits of the evidence

The model assumes that a wallet honors the requested fee cap and truthfully reports terminal outcomes. It cannot prove a remote wallet's enforcement. SIGKILL tests exercise process failure, not disk loss or power-loss durability. Pending reservations can remain indefinitely when the wallet cannot establish an outcome. Separate state directories cannot coordinate spending. Rejected or expired credentials deliberately block automatic repurchase.

Human comprehension testing, CPU/heap profiling, and live Wavelength settlement were not run. The litd check used regtest and local test coins only. No new latency benchmark was run. The suite does not prove exactly-once execution of a provider's HTTP operations or guarantee delivery after payment.
