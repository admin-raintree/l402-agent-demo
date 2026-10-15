# Verify payment recovery and spending limits

On 2026-10-15, all 35 automated tests and the real regtest smoke test passed. The checks cover reservations, recovery, approval, and resource delivery. Live Wavelength signet payments and litd enforcement remain unverified.

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

## Run the local checks

1. Run `bun install --frozen-lockfile`.
2. Run `bun test`.
3. Run `bun run build:binaries` if `.bin` is absent.
4. Run `bun run up`, then `bun run smoke`, then `bun run down` in the same persistent terminal session.

`up` resets `.demo`. Preserve any existing demo state before invoking it. Automated execution environments may terminate background daemons when a shell exits; keep startup and smoke testing in the same shell.

The test suite covers:

- Seeds 1–10,000: 80,000 accounting transitions and 32,354 reservations. An independent model checks fees, declines for insufficient allowance, unresolved outcomes, confirmed failures, settlement, retries, and UTC midnight. These are simulated accounting sequences, not 10,000 live network payments.
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

Human comprehension testing, performance profiling, live Wavelength settlement, and litd bypass tests were not run. The suite does not prove exactly-once execution of a provider's HTTP operations or guarantee delivery after payment.
