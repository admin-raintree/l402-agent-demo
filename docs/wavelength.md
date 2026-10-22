# Wavelength backend

The Wavelength backend pays L402 invoices from a self-custodial Ark wallet through a [Wavelength](https://github.com/lightninglabs/wavelength) daemon (`waved`), its operator, and its swap service. See the [README](../README.md) for how payments, limits, and reconciliation work; this page covers setup and verification against RC2 on signet.

The litd account ceiling applies only to the lnd backend. With Wavelength, only this app's spending policy limits what the agent can pay.

## TLS trust configuration

[`bunfig.toml`](../bunfig.toml) configures a bundled public CA file for package installation and loads [`tools/security/tls-preload.mjs`](../tools/security/tls-preload.mjs) for runtime TLS. The preload sets the default CA list and supplies the bundled CA file to `fetch` and WebSocket connections that do not name their own CA.

A request that passes its own `tls.ca` keeps it. The Wavelength adapter does this with `WAVELENGTH_TLS_CERT`, so a private or self-signed HTTPS gateway trusts only that certificate. [`tools/security/tls-preload.test.ts`](../tools/security/tls-preload.test.ts) checks this under the preload against a self-signed local gateway. The verified signet setup still uses the loopback HTTP gateway; HTTPS was checked only against that local test gateway.

## Checking Wavelength RC2

Build the pinned daemon and CLI with the wallet API and swap runtime enabled:

```sh
bun run build:wavelength
```

Use a separate signet wallet, following the [Wavelength setup guide](https://github.com/lightninglabs/wavelength/blob/v0.2.0-rc2/docs/daemon_cli_guide.md). Keep its HTTP gateway on loopback. The agent needs only `PrepareSend`, `Send`, `List`, and `Balance`; the verification command also needs `GetInfo`. Bake a scoped credential after creating and unlocking the test wallet:

```sh
# WAVE_DIR is the data directory of your running signet waved instance.
.bin/wavecli --network=signet --datadir="$WAVE_DIR" bakemacaroon \
  uri:/waverpc.DaemonService/GetInfo \
  uri:/wavewalletrpc.WalletService/PrepareSend \
  uri:/wavewalletrpc.WalletService/Send \
  uri:/wavewalletrpc.WalletService/List \
  uri:/wavewalletrpc.WalletService/Balance \
  --save-to="$WAVE_DIR/agent.macaroon"

export WAVELENGTH_URL=http://127.0.0.1:10031
export WAVELENGTH_MACAROON_PATH="$WAVE_DIR/agent.macaroon"
bun run verify:wavelength
```

This checks the actual daemon version and test network, authentication, balance, activity lookup, and malformed-invoice rejection. Optionally set `WAVELENGTH_IN_ARK_INVOICE_FILE` to a text file containing an invoice from `wavecli recv --offchain` on the same Ark to check that the adapter refuses a payment without a confirmed Lightning settlement rail.

For signet funding, `wavecli recv --onchain` returns a boarding address accepted by the [faucet linked from Wavelength’s network guide](https://robinet.eldamar.icu/). Keep `waved` running while the deposit confirms and joins the operator’s scheduled batch; an on-chain confirmation alone does not make the balance spendable. Inspect `wavecli ark rounds list` and `wavecli balance`. The public signet operator currently requires Lightning pay swaps of at least 1,000 sats.

To test settlement, fund the wallet with test coins and set `WAVELENGTH_TEST_INVOICE_FILE` to a fresh invoice from an external Lightning receiver on the same test network. Then run `bun run verify:wavelength --pay`. The command caps invoice plus fee reserve at 10,000 sats (`WAVELENGTH_TEST_MAX_SATS` overrides this), allows at most 10 sats in fees, verifies the preimage against the payment hash, and reconciles the payment through activity history. It refuses mainnet. Server-credit spending and top-ups remain disabled.

Verified on 2026-10-21: a fresh 1,500-sat payment settled with a 1-sat fee entirely on RC2 `952e6ca` with the local acknowledgment patch applied. Preimage verification, completed payment history, and reconciliation after restarting the same binary passed. Incoming change reached `ReceiveCompleted` without the protobuf error. Authentication and input-rejection checks also passed. See the [verification record](../patches/README.md) for hashes, earlier refunds, and balance reconciliation.

This validates the Wavelength wallet adapter against a live signet daemon. It does not establish a complete signet MCP → Aperture → paid HTTP resource flow; the full HTTP purchase flow is exercised separately on local regtest with lnd.

RC2 also sends an internal OOR acknowledgment over REST despite having no corresponding RPC. This produces the protobuf `SendIncomingAckRequest` error independently of Lightning settlement. The optional [local patch](../patches/README.md) fixes that path and includes a regression test:

```sh
WAVELENGTH_RC2_ACK_FIX=1 bun run build:wavelength
# Run .bin/waved-rc2-local with your existing test-wallet arguments.
```

After a timeout, inspect `wavecli activity --kind send` and keep the daemon running for settlement/recovery. A timeout is not proof of failure. To verify a previously submitted payment without sending another one:

```sh
WAVELENGTH_TEST_PAYMENT_HASH=77c1eda91eea1525f08e8a1bee6e07b4565b93f44ca68843b12500d345f8b2e2 \
  bun run verify:wavelength --reconcile
```
