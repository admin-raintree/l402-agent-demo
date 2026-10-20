# Draft: request a release containing 771f371

Not filed. Draft for lightninglabs/aperture, written 2026-10-19.

Upstream master already fixed this bug in [`771f371`](https://github.com/lightninglabs/aperture/commit/771f371ba5dcd4f11b864b0caa4ae5c233d9cc4a) ("aperture: apply service restrictions to dynamic tokens", authored 2026-09-24, landed on master 2026-10-06). No tag contains that commit; v0.5.0 is the latest tag. A new bug report would be a duplicate, so this draft asks for a release or a v0.5.x backport instead. Because the fix and its explanation are already public on master, a public issue does not disclose anything new. Contacting the maintainers directly is still an option.

---

**Title:** Release or backport 771f371: v0.5.0 mints dynamic-price and default-price L402s without timeout, capabilities or constraints

**Body:**

In v0.5.0, an L402 minted for a service that uses `dynamicprice`, or for a static service with no configured `price`, carries only the `services` caveat. The service's `timeout`, `capabilities` and `constraints` are dropped without a log message, so with a `timeout` set the credential never expires. Master fixed this in 771f371, but no release includes that commit yet. Could you tag a release that includes it, or backport it to a v0.5.x tag?

Cause in v0.5.0: `staticServiceLimiter` keys its `capabilities`, `constraints` and `timeouts` maps by `l402.Service{Name, Tier, Price}` from the config (`services.go:35-39`). The mint looks them up with the service it is minting for:

- Dynamic pricing: the name is `ResourceName(path)` = service name + request path (`proxy/service.go:184-190`), and the price is whatever the pricer quoted (`proxy/proxy.go:287`, `auth/authenticator.go:97-101`). Neither the name nor the price matches the key.
- No configured price: `newStaticServiceLimiter` runs in `createProxy` (`aperture.go:1641`) before `proxy.New` → `prepareServices` sets the default price of 1 (`proxy/service.go:394-397`), so the key has price 0 and the challenge has price 1.

All three lookups `continue` when there is no match (`services.go:68-70, 85-87, 102-104`).

**Reproduction against v0.5.0** (`311220b`), regtest, a stub `pricesrpc` server that returns 25 sats for every path, and four services, each with `timeout: 3600`, `capabilities: "read"` and one constraint:

| Service | Config | Invoice | Caveats on the challenge macaroon |
|---|---|---|---|
| `stat` | `price: 10` | 10 sat | `services=stat:0`, `stat_capabilities`, `stat_region`, `stat_valid_until=now+3600s` |
| `nopr` | no `price` | 1 sat | `services=nopr:0` only |
| `dyn` | `dynamicprice`, no `price` | 25 sat | `services=dyn/dyn/v1/x:0` only |
| `dynp` | `dynamicprice`, `price: 25` (same as quoted) | 25 sat | `services=dynp/dynp/v1/x:0` only |

The same config on master `08c10f5` gives all four services their capabilities, constraint and `_valid_until` caveats. Dynamic tokens carry `<service><path>_valid_until`, which matches `NewTimeoutSatisfier(params.TargetService)`.

A unit test that mints through `mint.New` with `newStaticServiceLimiter` fails on v0.5.0 for the default-price case and all three dynamic cases. The same test passes on master and on v0.5.0 with the attached patch. The patch is a minimal backport of the keying change only. It leaves out 771f371's duplicate-name check, its `=` refusal and its README upgrade notes. Test: `services_price_test.go` in the patch.

Tokens already minted by v0.5.0 keep the missing caveats. Revoke them through the admin API, as master's README upgrade notes describe.
