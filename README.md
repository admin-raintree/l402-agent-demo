# L402 agent wallet with a spending policy

An MCP server that lets an AI agent buy L402 services within human-controlled spending limits. It supports lnd and [Wavelength](https://github.com/lightninglabs/wavelength), with durable payment reservations and recovery after crashes.

Verified with real regtest payments through [Aperture](https://github.com/lightninglabs/aperture) v0.5.0 and lnd v0.21.3-beta. Built by Zachary Roth for Lightning Labs.

## What it does

- Discovers services and prices through `/.well-known/l402.json`.
- Automatically approves up to 100 sats, asks a person above that, and enforces per-call and daily limits. All limits include maximum fees.
- Reserves the invoice amount plus 10 sats before sending. SQLite prevents competing processes from spending the same shared allowance.
- Verifies payment preimages, reuses credentials, and reconciles uncertain payments without sending again.
- Reports payment, proof, and resource delivery separately through MCP. Claude Code configuration is included in `.mcp.json`.

The sample service sells mining economics from [mempool.space](https://mempool.space): `hashprice` for 10 sats, `breakeven` for 50 sats, and `report` for 1,000 sats.

## Run it

Requires Go 1.26+ and Bun; verified with Bun 1.4.2. **`up` resets `.demo`**, so preserve any existing demo state first. Run these commands in one terminal session:

```bash
bun install --frozen-lockfile
bun run build:binaries
bun run up
bun run smoke
bun run down
```

`bun test` runs 35 tests, including 10,000 seeded accounting sequences, crash recovery, and scripted MCP clients. It needs no external network. The smoke test checks real payments against buyer history and seller invoices.

Set `L402_AUTO_APPROVE_SATS` (default `100`) and `L402_DAILY_BUDGET_SATS` (default `5000`) in `.mcp.json`. Pass `max_sats` to `l402_fetch` to cap each purchase, including maximum fees.

## Use Wavelength

Live Wavelength settlement remains unverified. Build `waved` with `make install-wavewalletrpc`, enable `rpc.gateway.enabled=true`, and create a restricted macaroon:

```bash
wavecli bakemacaroon \
  uri:/wavewalletrpc.WalletService/PrepareSend \
  uri:/wavewalletrpc.WalletService/Send \
  uri:/wavewalletrpc.WalletService/List \
  uri:/wavewalletrpc.WalletService/Balance \
  --save-to agent-pay.macaroon
```

Add these variables to the MCP server's `env`:

```json
{
  "L402_WALLET": "wavelength",
  "WAVELENGTH_URL": "https://localhost:10031",
  "WAVELENGTH_MACAROON_PATH": "/path/to/agent-pay.macaroon",
  "WAVELENGTH_TLS_CERT": "/path/to/waved/tls.cert"
}
```

The client requires `SEND_RAIL_LIGHTNING`; same-Ark and unknown rails are refused. Tests follow the wallet API at commit `2c4f1ee`, including paginated `activity.entries`.

## State and recovery

State lives in `L402_STATE_DIR` (default `.demo/agent`). Stop older servers before upgrading. Existing `receipts.jsonl` and `tokens.json` are imported once into `payments.sqlite` and left unchanged. New receipts are available through `l402_wallet`; JSONL is no longer updated. Stop all servers before backing up the state directory, including SQLite sidecar files.

Confirmed failures release reservations. Confirmed settlements record actual fees and verified credentials atomically. Unknown payments remain reserved across restarts and UTC midnight, potentially indefinitely. Legacy pending receipts need operator investigation because they lack the original challenge.

## Limits

- The lnd backend is regtest-only. Wavelength signet settlement, fee enforcement, and litd allowances still need live verification.
- Processes must share one local state directory, wallet, and policy to share a budget.
- Wallet credentials are restricted, and state storage is owner-only. The lnd backend checks the payee against the manifest when supplied; Wavelength exposes no payee for that check.
- Invalid proof or a rejected credential blocks automatic repurchase. Token expiry caveats are not interpreted. HTTP retries do not guarantee exactly-once POST execution.
- Payment does not guarantee delivery or a refund. MPP challenges and quote endpoints are unsupported.

See [verification results and remaining live checks](VERIFICATION.md) for evidence, pinned versions, and signet and litd prerequisites.
