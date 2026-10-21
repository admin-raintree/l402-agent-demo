# Wavelength RC2 acknowledgment fix

`wavelength-rc2-local-ack.patch` targets Wavelength `v0.2.0-rc2`
(`952e6caaa71df43b5ef36159bf67caada8508a6c`). It is a local patch,
not an upstream release.

RC2's incoming OOR actor queues `SendIncomingAckRequest` to `serverconn`
after materializing a received VTXO. That message's `ToProto` returns an
internal `Any` containing persistence TLV, with type URL
`type.lightninglabs.dev/wavelength/oor/SendIncomingAckRequest`. It is not a
registered protobuf message, and `OORMailboxService` defines no `IncomingAck`
RPC. The REST transport's protobuf JSON encoder therefore fails before
sending the event. Retrying cannot resolve that type.

The patch completes this local acknowledgment without enqueueing an
unsupported network message. It preserves the existing validation,
materialization, ledger updates, and terminal snapshot. It does not change
submit/finalize transport, suppress transport errors, register a fake type,
or bypass preimage verification.

The regression test fails on unmodified RC2 because the actor queues an
outbound message. The patched OOR package passes, including its full incoming
materialization and ledger assertions.

Build and test it from the demo root:

```sh
WAVELENGTH_RC2_ACK_FIX=1 bun run build:wavelength
```

The build uses a temporary source archive, applies the patch, runs `go test
./oor`, and writes `.bin/waved-rc2-local`. `GetInfo` identifies its commit as
`952e6ca+local-ack`. The original checkout and `.bin/waved` stay unchanged.
Use the patched executable with the same test-wallet arguments as `waved`.

Live signet verification on 2026-10-21: the patched daemon materialized both
payment change and a cooperative refund, reaching `ReceiveCompleted` without
any `SendIncomingAckRequest` errors. The earlier successful Lightning payment
also passed preimage and history reconciliation after restarting into this
build. A subsequent invoice was rejected by the receiver with
`FAILURE_REASON_INCORRECT_PAYMENT_DETAILS` and refunded; that is separate from
the acknowledgment fix.

A fresh payment then succeeded entirely on the actual patched build at
2026-10-21 13:58–13:59 America/Los_Angeles:

- Rebuilt with the command above; both patch files applied and `go test ./oor -count=1` passed.
- Binary SHA-256: `3e6c5bea6fb1824b8cfc18f71d83800159571129d6253b68659ea30d6d1d88da`.
- Patch SHA-256: `3ea19531348f2c214c667923b9850062b96dc3705c7df019c8a56d17a09d3814`.
- Running daemon reported `0.2.0-rc2`, `952e6ca+local-ack`, and `signet` before submission.
- Fresh external ArkFaucet Lightning invoice: 1,500 sats, settled with a 1-sat fee.
- Payment hash: `77c1eda91eea1525f08e8a1bee6e07b4565b93f44ca68843b12500d345f8b2e2`.
- `verify:wavelength --pay` passed preimage SHA-256 verification and payment-history reconciliation. History reported `ENTRY_STATUS_COMPLETE` / `WALLET_ENTRY_PHASE_CONFIRMED`.
- Incoming change session `d6992d08…` reached `ReceiveCompleted`. Neither the payment-run log nor the restart log contained `SendIncomingAckRequest` or `unable to resolve`.
- Restarting the same patched binary and running `verify:wavelength --reconcile` for this hash passed without another payment submission.
- Balance decreased from 998,244 to 996,743 sats, exactly 1,501 sats, with zero pending incoming/outgoing balance and no pending send entries.

Raw build, payment, restart, and activity evidence is retained locally under
the ignored `.demo/wavelength-rc2-check/` directory. Wallet credentials and
raw wallet data are not part of this patch or the proposed upstream PR.
