# Statecharts and model checking

These charts show what the MCP server does for each tool, from the agent's call to the outcome. They were drawn from [`agent/server.ts`](../agent/server.ts) and [`agent/store.ts`](../agent/store.ts). The models in [`models/`](../models) then explored every interleaving of the flows within small bounds. Colors:

- **Grey**: works, and the models found no violation.
- **Red**: a bug the model checker found. Each one is now fixed.
- **Green**: the fix.
- **Amber**: a known, documented trade-off.

`bun test models` explores each model to exhaustion. Tests that turn each fix back off check that the checker still finds the counterexample.

## l402_fetch: one-off purchase

```mermaid
flowchart TD
    classDef bug fill:#fde2e1,stroke:#c0392b,color:#7b241c
    classDef fixed fill:#dff5e3,stroke:#1e8449,color:#145a32
    classDef gap fill:#fdf2d0,stroke:#b7950b,color:#7d6608
    start([agent calls l402_fetch]) --> disc{manifest available?}
    disc -->|yes| named[service = manifest name]
    disc -->|no| outage["service = URL path<br/>a credential bought under the manifest name is not found"]:::bug
    outage -->|with the fix| known["service = the name the ledger recorded for this path"]:::fixed
    named --> rec[reconcile unresolved payments]
    known --> rec
    rec --> tok{credential held?}
    tok -->|"under service or path key (fix)"| reuse[send it; never repay, even on 402]
    tok -->|no| ex{payment pending or paid without proof?}
    ex -->|yes| report[report payment state; funds stay reserved]
    ex -->|no| req[request without credential]
    req -->|not 402| done[return the response]
    req -->|402| chal{L402 challenge, test network?}
    chal -->|no| refuse1[refuse]
    chal -->|yes| quote[wallet decodes invoice]
    quote --> node{payee matches manifest node?}
    node -->|no| refuse2[refuse]
    node -->|yes| policy{"price + 10-sat fee vs max_sats, daily budget, task cap"}
    policy -->|over| refuse3[refuse]
    policy -->|over auto-approve| ask{human approves?}
    ask -->|no| declined[declined]
    ask -->|yes| reserve
    policy -->|within auto-approve| reserve["Store.reserve: one transaction rechecks all limits and repayment"]
    reserve --> pay[wallet pays]
    pay -->|"settled + valid preimage"| cred[save credential] --> deliver[retry with credential]
    pay -->|PaymentFailed| release[release reservation]
    pay -->|"transport error or crash"| pending[keep reservation until wallet evidence]
```

The model found the red path in three steps: buy `/data`, take the manifest down, then fetch `/data` again. The service key changed from `data` to `/data`, so the server paid a second time while holding a credential the provider accepted. The reverse order did the same, because a credential bought during an outage was stored under the path. With the fix, the server looks the service name up in the ledger, both keys are checked, and `Store.reserve` blocks a repayment under either name.

## l402_fetch: with a subscription

```mermaid
flowchart TD
    classDef bug fill:#fde2e1,stroke:#c0392b,color:#7b241c
    classDef fixed fill:#dff5e3,stroke:#1e8449,color:#145a32
    start([subscription exists for the service]) --> held{which credentials are held?}
    held -->|"subscription credential only (old)"| oldpay["one-off credential ignored<br/>renewal pays while access is valid"]:::bug
    held -->|"subscription, then one-off (fix)"| each[try each credential, newest first]:::fixed
    each -->|accepted| reuse[return the response]
    each -->|402 before its encoded expiry| reject[rejected; repayment blocked]
    each -->|402 after expiry| next[try the next credential]
    next -->|all lapsed| pend{"another payment for the service unresolved?"}
    pend -->|"yes (fix)"| wait[report it; do not pay alongside it]:::fixed
    pend -->|"no check (old)"| race["pays while a one-off payment is in flight;<br/>both credentials end up valid"]:::bug
    pend -->|no| state{subscription active?}
    state -->|"scheduled, cancelled, expired"| refused[refuse renewal]
    state -->|active| period{already paid this period?}
    period -->|yes| refused2[refuse: one renewal per period]
    period -->|no| renew["standing renewal: capped at cap_sats_per_period,<br/>daily budget and task cap still apply"]
```

Two traces led here. In the first, the agent buys the resource once, subscribes, and fetches again: the old code checked only subscription credentials, so it paid for a renewal immediately, and refused after cancellation even though the one-off credential still worked. The second appeared only after fixing the first two bugs. A one-off payment is pending when the agent subscribes, and the subscription pays for period 0. The pending payment then settles, so the agent holds a valid one-off credential. In period 1, the expired subscription credential is tried first, and the server renews while the one-off credential still works. The fix tries every held credential and refuses to pay while any payment for the service is unresolved.

## l402_subscribe and l402_subscriptions

```mermaid
stateDiagram-v2
    [*] --> Asking: l402_subscribe (manifest lists the resource, cap fits price + fee and daily budget)
    Asking --> [*]: human declines or cannot be asked
    Asking --> Active: human approves once
    Active --> Active: next period
    Active --> Cancelled: l402_subscriptions cancel
    Active --> Expired: last period ends
    Cancelled --> [*]: held credential works until its own expiry
    Expired --> [*]
    note right of Active
        One renewal per period. A new subscription is refused while one is active or scheduled.
    end note
```

## Payment settlement

```mermaid
stateDiagram-v2
    classDef gap fill:#fdf2d0,stroke:#b7950b,color:#7d6608
    [*] --> Pending: Store.reserve (amount + 10-sat fee reserved)
    Pending --> Paid: settled with valid preimage (credential saved, actual fee charged)
    Pending --> PaidNoProof: settled, preimage missing or wrong
    PaidNoProof --> Paid: a later lookup reveals the preimage
    Pending --> Failed: PaymentFailed or wallet lookup says failed (reservation released)
    Pending --> Pending: reply lost or crash, and reconcile finds no outcome yet
    Pending --> Stuck: crash before the wallet records the send
    class Stuck gap
    Failed --> [*]: service can buy a new invoice
    Paid --> [*]
```

The checker confirms that a failed row never hides a settled payment, and that the service is paid for at most once. Its liveness check reports one known trace (amber): if the process dies before the wallet records the send, the wallet can never report an outcome, so the reservation stays forever. The README documents this trade-off: keeping the funds reserved is safer than guessing that no payment happened. Turning off "release only on wallet evidence" produces a double payment within seven steps.

## Budgets across agents

```mermaid
flowchart LR
    a[agent A: check policy on a snapshot] --> ap[waits up to 150 s for a human]
    b[agent B: checks and reserves meanwhile] --> r
    ap --> r["Store.reserve: BEGIN IMMEDIATE,<br/>recheck daily + task + approval"]
    r -->|fits| res[reserved]
    r -->|no longer fits| ref[refused, nothing sent]
    res --> s["settles for at most the reserved amount"]
    m[midnight UTC] -.->|"resets settled daily spend only;<br/>pending and task spend persist"| r
```

With two agents, human approval, settlement fees from 0 to 10 sats, and midnight, the model found no way to exceed the daily budget, exceed the task cap, or pay above auto-approval without a human. Without the recheck in `Store.reserve`, a stale snapshot overspends in five steps.

## Read-only tools

- `l402_discover` fetches the manifest and caches it for later fetches.
- `l402_preview` uses the same service resolution and held-credential lookup as `l402_fetch`, never calls resources or the wallet, and reserves nothing.
- `l402_task` and `l402_wallet` reconcile unresolved payments, then report from the ledger.

## Not modeled

- The provider rejecting a credential early. The server blocks repayment in that case, and tests cover it.
- Disk or power loss. Process crashes are modeled.
- A manifest that renames a service between purchases. The ledger lookup covers outages, not renames.
- The payee-node check while discovery is down. Without a manifest, there is no node to compare against.
