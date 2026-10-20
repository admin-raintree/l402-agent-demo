# L402 subscriptions

Subscriptions add recurring payments to the MCP wallet. A seller sells a 30-day credential. The buyer grants a standing approval once, and the wallet renews within that approval without asking again.

Status: the buyer side is implemented in the unbound MCP server ([`agent/subscription.ts`](../agent/subscription.ts), [`agent/store.ts`](../agent/store.ts), [`agent/server.ts`](../agent/server.ts)). The wallet can pay through a litd account macaroon ([below](#paying-through-a-litd-account)). Dashboard requests and manifest subscription terms are not implemented.

[Back to the project](../README.md) · [Configuration](reference.md) · [Verification results](../VERIFICATION.md)

## Seller: a 30-day credential

Aperture v0.5.0 already supports expiring credentials through each service's `timeout` setting. Source:

1. `timeout` is a per-service count of seconds ([`proxy/service.go:93`](https://github.com/lightninglabs/aperture/blob/v0.5.0/proxy/service.go#L93)).
2. At startup, services with `timeout > 0` are added to the limiter's timeout map ([`services.go:41-43`](https://github.com/lightninglabs/aperture/blob/v0.5.0/services.go#L41-L43)).
3. When minting a challenge, Aperture adds a caveat `<service>_valid_until=<unix time>`, set to now plus `timeout` ([`services.go:97-112`](https://github.com/lightninglabs/aperture/blob/v0.5.0/services.go#L97-L112), [`l402/service.go:138-152`](https://github.com/lightninglabs/aperture/blob/v0.5.0/l402/service.go#L138-L152), [`mint/mint.go:276-284`](https://github.com/lightninglabs/aperture/blob/v0.5.0/mint/mint.go#L276-L284)).
4. Verification rejects the credential once that time passes. It also rejects a later caveat that extends an earlier expiry ([`mint/mint.go:344`](https://github.com/lightninglabs/aperture/blob/v0.5.0/mint/mint.go#L344), [`l402/satisfier.go:123-180`](https://github.com/lightninglabs/aperture/blob/v0.5.0/l402/satisfier.go#L123-L180)). A rejected credential gets a fresh 402 challenge.

Observed on regtest by [`scripts/subscription-smoke.ts`](../scripts/subscription-smoke.ts): with `timeout: 4`, the minted macaroon carried `services`, `hashprice_capabilities`, and `hashprice_valid_until` set to mint time plus 4 seconds. The same service without a timeout carried no expiry caveat. After expiry, Aperture answered the old credential with a fresh 402.

So `timeout: 2592000` gives each paid credential a 30-day life, starting when the challenge is minted, not when the invoice is paid.

Use an explicit static `price` for subscription services. In v0.5.0 the limiter keys `timeout`, `capabilities` and `constraints` by the configured service name, tier and price ([`services.go:35-39`](https://github.com/lightninglabs/aperture/blob/v0.5.0/services.go#L35-L39)). The mint looks them up with the name and price of the challenge, and skips any service it cannot find. Two configurations miss the lookup:

1. `dynamicprice`: the challenge is named after the service plus the request path ([`proxy/service.go:184-190`](https://github.com/lightninglabs/aperture/blob/v0.5.0/proxy/service.go#L184-L190)) and priced by the pricer, so neither matches.
2. No `price`: the limiter is built before `prepareServices` applies the default price of 1, so it holds price 0 while the challenge has price 1.

Observed on regtest with v0.5.0 and a stub pricer: in both cases the macaroon carried only `services`, with no `_valid_until`, `_capabilities` or constraint caveat. A credential minted this way never expires. Aperture master fixed this in [`771f371`](https://github.com/lightninglabs/aperture/commit/771f371ba5dcd4f11b864b0caa4ae5c233d9cc4a), which keys by name and tier. No tagged release contains that fix yet. The same check against master minted every caveat. Evidence, commands and a backport patch: [VERIFICATION.md](../VERIFICATION.md#aperture-dynamicprice-and-the-timeout-caveat) and [`docs/upstream/`](upstream/).

Optionally, and not implemented, the discovery manifest can state the terms, so the buyer can check an invoice against the advertised offer:

```json
"pricing": { "model": "subscription", "price_msat": 500000, "period_seconds": 2592000 }
```

The current manifest parser strips unknown fields, so older buyers ignore `period_seconds`. The buyer still trusts the macaroon caveat over the manifest. A credential that expires before the buyer's period ends is not renewed until the next period; access lapses in between.

## Buyer: a standing approval

`l402_subscribe` asks the human once, through the existing elicitation prompt, regardless of the auto-approval limit. It refuses a cap below the advertised price plus the 10-sat maximum fee, a cap above the daily budget, and a second active subscription to the same service. The record:

| Field | Example |
|---|---|
| Provider origin, node pubkey, service | `http://127.0.0.1:8700`, manifest `node_pubkey`, `report` |
| Cap per period, including maximum fees | 1,010 sats |
| Period, count, start | 30 days, 6 periods, approval time |
| State | `scheduled`, `active`, `cancelled`, or `expired` (computed from status and time) |

Period *k* covers `start + k × period` to the start of period *k+1*, measured from the approval time, not from the seller's caveat. The cap therefore limits spending per buyer period, whatever credential lifetime the seller chooses. `l402_subscriptions` lists each subscription's state, current period, period spend, and credential expiry, and cancels one by ID.

### When a renewal happens

A renewal is triggered lazily, in `l402_fetch`. It happens when a request with the subscription's saved credential returns 402 and the wallet confirms the credential has expired. The wallet reads the earliest plaintext `_valid_until` caveat from the macaroon; a credential with no expiry, or one it cannot parse, is never treated as lapsed. A 402 before that time is a rejected credential. It keeps today's behavior, blocking automatic repurchase, so a seller cannot drain the approval with early 402s. Proactive renewal on a timer would avoid an expired-credential gap, but it needs a scheduler, and it can pay for periods nobody uses. It is left out.

### How renewals use the reservation path

Renewal reuses [`Store.reserve`](../agent/store.ts) with two changes:

1. **A key per period.** Today a purchase key is `origin service`, and any paid or pending receipt for that key blocks repayment. A renewal uses `origin service #sub-<id>/<k>` instead. Earlier periods do not block the new one, and the credential lookup picks the newest period.
2. **Standing approval replaces the prompt, not the limits.** Inside the same `IMMEDIATE` transaction, `reserve` loads the approval. It checks that the approval is `active`, the current time falls within period *k*, and *k* is below the period count. It checks that the provider, node and service match. Node binding needs both the manifest's `node_pubkey` and a payee node in the wallet's quote. lnd supplies one; Wavelength's preview does not, so with Wavelength the node is not checked. Settled plus pending spending for period *k*, plus the new principal and maximum fee, must fit the cap. The daily budget check (`decide`) still applies. The receipt records `approval: "standing"` and the approval ID.

Fee handling is unchanged. The reservation holds the principal plus the maximum fee, and settlement replaces it with the actual charge.

### Stopping two renewals for one period

Two MCP processes can both see an expired credential at the same moment. Both reservations take SQLite's write lock in turn. The second finds the first's paid or pending purchase under the same period key and gets "purchase already recorded; reconcile". A `renewals(subscription_id, period, payment_hash)` table with `PRIMARY KEY (subscription_id, period)` is written in the same transaction, as a database-level backstop for any path that skips the key check. In [the tests](../agent/subscription.test.ts), eight independent processes racing for one period produce one reservation.

### Renewal outcome unknown

A renewal with an unknown outcome stays `pending`, as any purchase does today. It counts against the period cap and the daily budget, and reconciliation goes through `wallet.lookup`. Period *k* cannot start another renewal while one is pending. If the wallet never resolves the payment, the subscription lapses for that period instead of paying twice. The pending payment does not block the next period: period *k+1* can renew while period *k* is unresolved, so a late settlement can charge both periods, each within its own cap. If late proof arrives, the credential is stored and the period resumes. A confirmed failure releases the reservation and deletes the period's `renewals` row, so a fresh invoice can be paid.

### Cancellation and expiry

Cancellation sets `status = cancelled` in a transaction. Because `reserve` checks the status inside its own transaction, a racing renewal is either reserved before the cancellation or refused after it. Cancellation does not recall a payment already submitted. Payments are buyer-pushed, so the seller needs no cancellation step; the current credential simply stays valid until its caveat expires. After the last period, `reserve` refuses and the subscription reports `expired`. Changing a cap or provider requires a new approval. A new `l402_subscribe` after cancellation or expiry starts fresh periods. It reuses any credential still valid from an earlier subscription to the same service, rather than paying again.

## What each layer enforces

The [litd allowance check](../VERIFICATION.md#litd-account-allowance) observed the account layer directly. It refused payments over the balance, counted the maximum fee, held five concurrent payments to the balance, and enforced the same limits on lnd's own RPC port.

| Control | Application (SQLite policy) | litd account |
|---|---|---|
| Provider, service, node binding | Yes | No; it debits any invoice |
| Per-period cap and period count | Yes | No periodic refill; one balance and an optional expiration date |
| One renewal per period | Yes, period key plus primary key | No |
| Human or standing approval | Yes | No |
| Total ceiling including maximum fees | Yes, if the wallet honors its fee cap | Yes, observed on regtest |
| Concurrent spenders | Yes, within one state directory | Yes, observed with five payments |
| Process holding credentials bypasses the app | Not enforced | Still enforced; its own RPC port is covered; observed with a second MCP state directory and direct lncli |

## Paying through a litd account

The lnd wallet reads three optional variables. Without them, it uses the demo buyer node and its `agent-pay` macaroon, as before.

| Variable | Through litd | Default |
|---|---|---|
| `L402_LND_MACAROON` | the account macaroon from `litcli accounts create --save_to` | `$L402_DEMO_DIR/agent-pay.macaroon` |
| `L402_LND_RPCSERVER` | `127.0.0.1:8443` (litd), or `127.0.0.1:10019` (lnd's own port, still intercepted) | `127.0.0.1:10019` |
| `L402_LND_TLSCERT` | `$L402_DEMO_DIR/lit/tls.cert` (or lnd's certificate for lnd's port) | `$L402_DEMO_DIR/buyer/tls.cert` |

Create the account for the subscription's lifetime total (cap × periods). Set it to expire when the subscription ends: `litcli accounts create <sats> --expiration_date <unix> --save_to <file>`. The application enforces the fine-grained rules. The account is the backstop if the application or its state is bypassed.

Observed on regtest by [`scripts/litd-subscription-smoke.ts`](../scripts/litd-subscription-smoke.ts), run from `bun run verify:litd`:

- The account macaroon covers all four lncli calls the wallet makes: `decodepayreq`, `payinvoice`, `listpayments` and `channelbalance`.
- `channelbalance` reports the account's virtual balance, not channel liquidity: 40 sats while the real channel held about 2,000,000. `l402_wallet`'s `balance_sat` is therefore the remaining allowance.
- `listpayments` returns only the account's payments.
- A 40-sat account (cap 20 × 2 periods) paid both renewals with one prompt; 40 → 20 sats, matching the receipts.
- A second MCP state directory, with no subscription and auto-approval at 100 sats, approved a 50-sat purchase without a prompt. litd refused it with `account balance insufficient`. A direct `lncli payinvoice` on lnd's own port (11 sats, 10-sat fee limit) was refused the same way.
- After the expiration date, a 5-sat payment that fit the balance was refused with `account … has expired`, and `channelbalance` failed with the same error.

The four-call coverage, the virtual balance, and the expiry errors were first seen in a manual probe on the same versions, then asserted by the script.

Consequences:

1. **An over-allowance refusal is a confirmed failure.** litd rejects a payment that exceeds the account balance with `account balance insufficient`, while checking the request, before lnd runs it. No HTLC can have left. The lnd wallet throws `PaymentFailed` for that error, so the purchase is recorded as `failed` and its reservation is released (0 sats reserved in the test).
2. **Unused fee reserve stays spendable.** The account is sized at cap × periods, and each cap includes a 10-sat maximum fee. Renewals that pay no routing fee leave that headroom in the account, 20 sats in the test, until expiry. Anyone holding the macaroon can spend it on any invoice. *Inferred from the balance arithmetic*: a payment that fit the 20 sats was not attempted before expiry.
3. **After expiry, `l402_wallet` fails, and an expiry refusal stays pending.** The balance call is refused. Reconciliation through `listpayments` is presumably refused too (not tested), so pending payments from that account cannot be resolved through it. A payment refused with `account <id> has expired` stays a pending reservation with retries blocked. litd checks expiry on every message its interceptor sees (`accounts/interceptor.go:112` in v0.17.7), including each streamed `SendPaymentV2` update. So an account that expires mid-payment can produce this error after HTLCs were sent, and the error alone cannot show that nothing left.
4. **Pagination through litd.** `listpayments` filters out other macaroons' payments but keeps lnd's unfiltered offsets, so a page can be empty while later pages hold account payments. The wallet's lookup keeps paging while `last_index_offset` advances, and stops on an empty page whose offset does not advance (lnd returns 0 once no payments remain). *Tested against a fake lncli only*: no live run had more than 100 non-account payments in front of an account payment.

A tighter backstop is to fund one period at a time with `litcli accounts credit`, from an operator process outside the agent. That needs a scheduler.

The account does not know about periods, providers or approvals. Its balance is virtual, so the node operator must keep the real channel liquidity behind it.

## Verify

`bun test agent/subscription.test.ts` covers period math, macaroon parsing, cap and fee limits, one renewal per period, failure and pending outcomes, provider and node binding, cancellation, expiry, a cross-process race, and an MCP flow against a mock provider. `bun run verify:local` adds the regtest subscription smoke. It approves 20 sats per 12-second period with auto-approval at zero, then pays twice with one prompt. It refuses a second renewal within a period, honors cancellation, and reconciles both payments with buyer and seller records. `bun run verify:litd` repeats the subscription through a litd account macaroon and tests the backstop. `bun test agent/lnd-wallet.test.ts` checks the `L402_LND_*` overrides and the unchanged defaults, litd's refusal handling, and lookup paging past empty filtered pages.
