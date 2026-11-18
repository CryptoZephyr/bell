# Contract review and hardening (18 Nov 2026)

Scope: `BellDesk.sol` and `BellReferee.sol` at the v5 contracts (commit a16c280) and the hardened set that followed (commit 63a52f2). Testnet only. This is the build team's own review. It is not an audit, and nothing here should be read as one.

Method:
- Slither 0.11.6 on a clean build, test code excluded.
- A seeded random-book test that builds random books on both chains, sometimes revokes a trader's approval, rings the bell, and checks the invariants a settlement must keep (see below).
- Reading the settlement paths for abuse cases, then measuring the ones that looked expensive on the live testnet.

## Invariants checked

`test/BellReferee.test.js`, "random books keep the books balanced". 40 seeded books of 2 to 6 orders across both chains, 39 rounds rang, 10 approvals revoked mid-book, 43 ineligible orders carried. After every round:

1. each token on each desk is back at its starting balance,
2. the total of each token across every known holder is unchanged, so no payout went to a wrong address,
3. the round is not left pulling,
4. every order still open was not eligible at the settle price.

No violation was found, before or after the hardening.

## Findings

| # | Finding | Severity (testnet / mainnet) | Status |
| --- | --- | --- | --- |
| F1 | Anyone can place orders for free, and every order costs the referee a reaction. One place and cancel cycle from a funded wallet cost 0.056 REACT (measured live, including the next timer tick), so about 20 cycles empty 1.14 REACT of reserves. A contract in debt stops hearing events. | Medium / High | Partly fixed, rest accepted |
| F2 | Book slots could be held for free. An order with a limit far from the market is never eligible, so it is never pulled and never expires. Six of them jam the book. | Medium / High | Fixed |
| F3 | The desk pulled whatever amount the referee asked for, so a referee bug could take more than a trader committed to. | Low / Medium | Fixed |
| F4 | The swap callback ignored the result of the token transfer into the pool and of `settle()`. Slither rated the transfer High. It could not lose funds, because PoolManager reverts an unsettled swap and the desk reports `ok = false`, but it was not checked. | Low | Fixed |
| F5 | The reference price is the last swap of one thin pool, with no staleness check. A trader can move it inside other traders' limits. The drift guard only stops a jump inside one bell window. | Medium / High | Accepted for testnet |
| F6 | Revoking an approval after placing is not watched. The pull fails at the bell, the order drops, and the others settle, but each such order costs the referee callbacks. | Low | Bounded by F1 and F2 fixes |
| F7 | A settling reaction that exceeds the 900k gas cap would fail, and the expiry retry would fail the same way, which would jam the book. There is no rescue path. | Low (cap keeps headroom) / High | Accepted, bounded by the 6-order cap |
| F8 | Desk funds are commingled. Payouts and swaps are bounded by the desk balance, not by the order, so correctness relies on the one immutable referee. | Info | Accepted by design |
| F9 | Reserves held by the system contract cannot be withdrawn (the Reactive docs: reserves can only be spent on fees). | Info | Operational note |
| F10 | The Base pool is our own and thin. Remainders there fill at the Base pool price, which drifts with our own trades (one live fill was at 820 against a 798 reference, inside the buyer's limit). | Info | Operational note |

## What changed (commit 63a52f2)

Desk:
- `place` now rejects an order the trader cannot pay for right now (balance and allowance for the cost at the order's own limit, or the WETH for a sell), an order under `MIN_QTY` (0.00001 WETH), and values above 128 bits. A rejected order emits no event, so the referee spends nothing on it. Verified live: an unfunded order and a dust order both reverted (`NotFunded`, `OrderTooSmall`) and the referee's reserves did not move.
- `collect` can never pull more than the order committed to: a buyer's cost at the order's own limit, a seller's quantity, counting all pulls for that order. A late pull on a frozen order still reports `ok = false`.
- The swap callback reverts if the token transfer fails or `settle()` does not equal the amount owed.

Referee:
- One wallet may hold at most 2 open orders (`MAX_ORDERS_PER_TRADER`). A third is dropped as "too many open orders".
- An order older than 30 minutes (`ORDER_TTL`, 1800 s) is dropped at the next bell as "expired", and the timer turns off if the book empties. The desk is not told. The trader can still cancel there, and the referee ignores that event.
- The bell costs about 16k gas more for the expiry check. The worst 6-order settle is unchanged at an estimated 562k.

## What the fixes do not do

F1 is not solved. A funded wallet can still place and cancel in a loop, and every cycle costs the referee about 0.056 REACT. The checks make each spam order cost the attacker real funds in their wallet and remove the free case, but they add no price. On a mainnet this needs an economic cost per order (a fee or a bond) and an alarm on reserves. On this testnet it is an accepted risk, and the mitigation is operational: keep reserves above 1 REACT and watch them.

F5 is not solved either. The price is one pool's last swap. A mainnet version needs a time-weighted price or more than one pool, and a staleness rule. A staleness rule would void most testnet rounds, because these pools are quiet, so it was left out on purpose.

## Slither results

Before the hardening: 1 High (the ignored transfer), 7 Medium reentrancy and 5 uninitialized-local reports, 1 unused-return. After, on a clean build: no High. The remaining Medium reports are:
- 9 reentrancy reports in the referee. They are calls to the Reactive system contract made before a state write. That contract is trusted and only records the request, and desk callbacks run in separate transactions, so there is no reentry path. Reviewed and not changed.
- 1 reentrancy report in the desk's `collect`: the trusted USDC or WETH `transferFrom` runs before the pulled amount is recorded. The desk's pulls are callable only by the callback proxy, so nothing can re-enter. Reviewed and not changed.
- 6 uninitialized locals. They are counters and flags that start at zero on purpose.

## Live checks on the hardened set

Referee `0xE0e7ee9D6aC8b05Beb2fC76c7459B00c2869C19c`, Base desk `0xE2db2CE531Ba083A608c0c368CCF97461C522864`, Unichain desk `0x6669a7EC40E9A6688b7C0c0c8147c4b6a59cE2F4`. `get_rc_health` HEALTHY with 1.5 REACT, 9 of 9 subscriptions, `check_rc_source` OK on both contracts, and the new constants read back from the deployed code.

- Unfunded order refused, no reserve cost: done (see above).
- Per-wallet cap: one wallet placed 3 orders and the referee dropped the third as "too many open orders".
- Expiry after 30 minutes: see the test notes.
- A normal two-chain round on the hardened set: see the test notes.

## Not done

- Cutting settle gas so the book can hold more than 6 orders (merging the per-order close callbacks into the payouts). It is a capacity change and not a security fix.
- A rescue path for a callback that runs out of gas.
- An outside audit.
