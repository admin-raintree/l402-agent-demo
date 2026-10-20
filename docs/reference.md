# Configuration and operations

Use this reference to configure the viewer, recover requests, manage stored state, and run checks. For the payment sequence, follow the [12-step walkthrough](README.md).

[Back to the project](../README.md) · [Configuration](#use-an-existing-running-local-network) · [Payment boundaries](#payment-controls-and-boundaries) · [Checks](#verify) · [MCP tools](#mcp-tools) · [Stored state](#state-and-limits)

## Local demo behavior

`bun run demo` creates a fresh temporary regtest network, funds a buyer channel, and starts the seller, Aperture, and dashboard. It uses the labeled historical market snapshot, not live market data. No real funds are used.

The bundled mining seller is a test fixture. It sells hashprice for 10 sats, break-even data for 50 sats, and a report for 1,000 sats. No mining calculations or research planner run in the dashboard. Before payment, spending checks include a 10-sat maximum routing fee. Actual fee enforcement depends on the wallet backend. Previously purchased credentials can be reused without another payment; the dashboard labels this.

Ctrl-C stops the local network. Its state and logs remain in the printed temporary directory. Each `demo` run creates a separate network; it does not restore a previous network or overwrite `.demo`.

## Use an existing running local network

```sh
export L402_DEMO_DIR=/absolute/path/to/the/running/regtest-workspace
export L402_STATE_DIR="$L402_DEMO_DIR/agent"
bun run dashboard
```

`L402_PROVIDER_URL` defaults to `http://127.0.0.1:8700`. `PORT` defaults to `8787`. The dashboard binds only to `127.0.0.1`, rejects unexpected Host headers, and requires same-origin JSON for mutations. Use the exact displayed URL, not a `localhost` alias.

`L402_DAILY_BUDGET_SATS` defaults to `5000`; `L402_AUTO_APPROVE_SATS` defaults to `100`. Users can reduce these limits for a request but cannot increase them through the interface. Request budgets apply across days; the shared daily allowance also includes unresolved reservations from earlier days.

Only one dashboard may own a state directory. A completed request cannot run again; create another request to fetch the resource again and reuse its paid credential. Restarting the dashboard marks active requests interrupted and expires approval prompts. Select **Resume and reconcile** to recover. An uncertain wallet payment remains reserved until wallet evidence resolves it; the server does not send it again automatically.

## Follow a request

Select a saved request, then choose **Start request**. The interface follows four stages: request the resource, review its cost, pay, and receive the response. The current stage explains the next action; approval controls appear when needed. Free responses and saved credentials skip unnecessary payment stages.

Progress comes from buyer-side request, approval, payment, and delivery records. It is not an independent seller feed. Switching requests changes the whole flow; changing the new-request form does not alter a saved request’s budget.

## Payment controls and boundaries

- The dashboard creates an immutable request budget, approval ceiling, and approved resource path. Its MCP child is bound to that request through `L402_TASK_ID`.
- SQLite checks both request and daily limits inside the reservation transaction. Concurrent processes sharing the same wallet, policy, and state directory share the allowance.
- Authorization, settlement, and delivery are distinct. A paid invoice does not establish that a useful resource arrived.
- The store verifies preimages and records settlement and credentials atomically. Invalid proofs and rejected credentials block automatic repurchase.
- Responses are bounded to 64 KiB and displayed as escaped text. Provider content cannot issue payment instructions. The viewer does not validate its usefulness or accuracy.
- Request records retain the response. Events contain state changes and timings, not wallet credentials or payment proofs.
- The viewer performs GET requests only. The original MCP tool still supports POST, where retries do not guarantee exactly-once provider execution.

The dashboard is a trusted local application, not a multi-user hosted service or an operating-system sandbox. A process with wallet credentials or filesystem access can bypass application controls. Do not give an untrusted agent those capabilities. The existing unbound MCP configuration retains its daily policy; a dashboard request budget applies only to MCP processes bound to that request.

## Verify

```sh
bun test
bun run verify:local
```

The first command includes 100,000 seeded accounting sequences, concurrent processes, crash recovery, hostile responses, and request authorization checks. The second creates an isolated regtest network, runs real Lightning payments, reconciles buyer and seller histories, and verifies a complete dashboard resource purchase and a subscription renewal. It retains logs and stops its daemons on exit.

Browser checks use an existing Playwright installation and Google Chrome:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/node_modules/playwright bun run test:browser
```

If Playwright is available through normal module resolution, omit `PLAYWRIGHT_MODULE`. `PLAYWRIGHT_CHANNEL` defaults to `chrome`. The check uses a mock wallet, exercises the browser workflow, and writes screenshots to its printed temporary directory. It does not install a browser or dependencies.

To test the litd account allowance independently of the MCP policy:

```sh
bun run build:litd
bun run verify:litd
```

It builds litd v0.17.7 without the web UI, starts a fresh network whose buyer lnd accepts RPC middleware, and runs litd in remote mode. It then sends payments directly with a 100-sat account macaroon. Port 8443 and the ports used by `up` must be free.

See [verification results](../VERIFICATION.md) for measurements, the recovery matrix, and limits of the evidence.

## MCP tools

The existing [`.mcp.json`](../.mcp.json) configuration remains available. The server exposes:

- `l402_discover`: discover services and advertised prices.
- `l402_fetch`: fetch a resource, enforce spending limits, request human approval when needed, and reuse paid credentials.
- `l402_wallet`: reconcile wallet activity and inspect spending and receipts.
- `l402_subscribe`: ask the human once for a standing approval (a cap per period, including fees, for a number of periods) to one provider's service.
- `l402_subscriptions`: list subscriptions or cancel one. A cancelled subscription keeps its paid credential until that credential expires.

With a subscription, `l402_fetch` renews an expired credential at most once per period without prompting; the daily budget still applies. Request-bound dashboard processes do not use subscriptions. See [Subscriptions](subscriptions.md).

The `lnd` backend is restricted to the local regtest configuration. Wavelength integration uses its REST API; live settlement and independent fee enforcement remain unverified.

To configure a dedicated Wavelength test wallet, set `L402_WALLET=wavelength`, `WAVELENGTH_URL`, `WAVELENGTH_MACAROON_PATH`, and `WAVELENGTH_TLS_CERT`. Use a macaroon restricted to `PrepareSend`, `Send`, `List`, and `Balance`. Wallet setup and scoped-macaroon details are in the upstream Wavelength documentation; the tested API contract is recorded in [VERIFICATION.md](../VERIFICATION.md).

## State and limits

State defaults to `<L402_DEMO_DIR>/agent`, or `.demo/agent` when no directory is configured. `L402_STATE_DIR` overrides it. The directory is owner-only; `payments.sqlite` stores request records, payment reservations, receipts, credentials, and telemetry. Stop all writers before backing up the directory, including SQLite sidecar files. Legacy `receipts.jsonl` and `tokens.json` import once and remain unchanged.

`scripts/up.sh` refuses a nonempty network directory. Set `L402_DEMO_DIR` to a new empty directory instead of deleting existing work. `scripts/down.sh` stops the processes associated with that directory.

Existing research records remain readable as archived records; they cannot authorize new purchases. Their receipts, reservations, credentials, and budget charges remain intact. Use `l402_wallet` to reconcile old pending payments. The existing `tasks` table, `/api/tasks` routes, and `L402_TASK_ID` name remain for payment-reference compatibility.

See [verification limits](../VERIFICATION.md#limits-of-the-evidence) for the unverified live-wallet and user-comprehension checks.
