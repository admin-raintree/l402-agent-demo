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
