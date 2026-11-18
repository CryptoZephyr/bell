# Bell

Bell matches people who want to swap ETH and USDC across Base and Unichain at one fair price, settled within seconds of a bell, with no bridge, no solver and no server. Anything unmatched fills against a real Uniswap v4 pool on the trader's own chain, and never outside the trader's own price limit.

Testnet only. Built for the Reactive Omni Buildathon, track Every Second Counts. Nothing here has been audited, and nothing here holds real money.

## How it works

1. A trader places an order on the desk contract of their chain (Base Sepolia or Unichain Sepolia). Placing moves no funds. The money stays in the trader's wallet.
2. One reactive contract on Reactive Lasna, the referee, hears every order on both chains and keeps one combined book.
3. A timer rings the bell about every two minutes while orders exist. The referee prices the round from the latest swap on the Unichain reference pool, a real Uniswap v4 USDC/WETH pool.
4. Orders whose own limit allows that price are matched first in, first out. The referee pulls each trader's funds into their desk, then pays each matched trader on the other side's chain.
5. Whatever is left unmatched goes into the Uniswap v4 pool on the trader's own chain, stopped at the trader's limit. The part the pool can't fill inside the limit goes straight back.
6. If a pull fails, only that order drops. Everyone else settles in the same round. A trader can cancel until the desk pulls their funds.

A round-drift guard skips a round if the reference price moves more than 10% inside one bell window. Orders carry to the next bell.

## Contracts

| Contract | Chain | Address |
| --- | --- | --- |
| BellReferee | Reactive Lasna (5318007) | `0x5269Affe9288ab7a2E7B14Aed4E0D4D1fBE396F2` |
| BellDesk | Base Sepolia (84532) | `0x6ca550AB0aE6b2299350049F38cbDAE2767cb43E` |
| BellDesk | Unichain Sepolia (1301) | `0x7B1e4FA115838EfE6D339D19CCFd2b14df8c0Eb1` |

The reference pool is the Uniswap v4 USDC/WETH 0.05% pool on Unichain Sepolia, pool id `0x71fba4ef34765b317417131bb7cef92bd4c43405babf9386cacdd10cf8641422`. The pools on both chains carry liquidity of our own for testing, recorded in `deployments/pools.json`. It is test liquidity on real Uniswap v4 pools. It is not market depth.

Earlier deployments are kept in `deployments/bell-v1.json` to `deployments/bell-v4.json` and `deployments/bell-v5-rc1.json`. The current record is `deployments/bell.json` (v5).

## Run it

```bash
git clone --recurse-submodules https://github.com/CryptoZephyr/bell.git
cd bell
npm install          # also links the Reactive library as @reactive/src
npx hardhat test     # local suite, uses a stand-in for the Reactive system contract
```

Live testing and deployment need a funded testnet key in `BELL_PRIVATE_KEY`. Never commit a key.

```bash
STAGE=referee npx hardhat run scripts/deploy.js --network lasna
STAGE=desk:baseSepolia npx hardhat run scripts/deploy.js --network baseSepolia
STAGE=desk:unichainSepolia npx hardhat run scripts/deploy.js --network unichainSepolia
STAGE=configure npx hardhat run scripts/deploy.js --network lasna
AMOUNT=1.0 npx hardhat run scripts/fund-reserves.js --network lasna
node scripts/live-v5.js status
```

The referee runs on reserves held by the Reactive system contract. Keep at least 1 REACT deposited with `depositTo`, because a contract in debt stops hearing events.

## Layout

- `contracts/BellDesk.sol` holds orders and moves money only for the referee's callbacks.
- `contracts/BellReferee.sol` is the book, the pricing rule, the guard and the two-step settlement.
- `contracts/test/` holds test-only stand-ins and a harness. None of it is deployed.
- `scripts/` deploys, funds, aligns pool prices and drives live test rounds.
- `deployments/` holds the address records.
- `docs/EVIDENCE.md` lists the live gate evidence with transaction hashes.

## Limits, stated plainly

- Testnet only. No audit.
- The reference price is one pool's last swap. On a thin test pool it is cheap to move. The traders' own limits and the drift guard bound the damage, they don't remove the risk.
- The book holds at most 6 orders. A live 8-order round needed 717,911 gas to settle against the 900k reaction cap, so the cap is set below that with headroom.
- A failed payout or swap is reported and not retried.
- A callback that runs out of gas has no rescue path, and neither does a desk's ETH.
- Funds stranded on the retired v2 desks are unrecoverable: 0.806315 USDC on the Base desk and 0.001 WETH on each desk.
