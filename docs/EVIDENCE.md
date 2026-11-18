# Live evidence, v5

All on testnet, 18 Nov 2026. Transactions on Lasna are at `https://lasna.reactscan.net/tx/<hash>`, on Base Sepolia at `https://sepolia.basescan.org/tx/<hash>` and on Unichain Sepolia at `https://sepolia.uniscan.xyz/tx/<hash>`. USDC amounts are written with decimals.

Two deployments carry this evidence. V5-1 to V5-6 and gates 10 and 11 ran on v5-rc1 (contracts at commit 4f7731a, MAX_BOOK 12): referee `0x16713C0097B4c57a51326F3062E9328c067FCc0f`, Base desk `0xd4dcaA8D8922c95587751A3042dfFDCdDC063233`, Unichain desk `0x9e72a8896dd5a4c15AFFFF0c408B2Bced606A3E2`. That showed MAX_BOOK has to be 6, so the final v5 set was redeployed with it and gate 13 ran there: referee `0x5269Affe9288ab7a2E7B14Aed4E0D4D1fBE396F2`, Base desk `0x6ca550AB0aE6b2299350049F38cbDAE2767cb43E`, Unichain desk `0x7B1e4FA115838EfE6D339D19CCFd2b14df8c0Eb1`. The two sets differ only by that one constant.

The pools on both chains were moved to 800 USDC per WETH and carry a position of our own, test liquidity on real Uniswap v4 pools and not market depth. See `deployments/pools.json`.

| Gate | Result | What happened | Key transactions |
| --- | --- | --- | --- |
| V5-1 | PASS | 67 local tests, `check_rc_source` OK on both contracts, `get_rc_health` HEALTHY, 9 of 9 subscriptions | configure `0x387f4f5b446396c04478b0b072f44bc34f5ce301e26b9b4bd7b8b3d1423fedc2` |
| V5-2 | PASS | Buyer limit 801, pool near 800. Of 1.600973 USDC pulled, 0.067076 was used for 0.0000838 WETH and 1.533897 came back in the same desk transaction | bell `0x66040f29cdfcb6a2c5cf2b40324221c8aeaaf1587a039f05fa7b59337d463b9a`, swap (Base) `0xbfecc36c5f9016d3c10744cb655d2262a0ac5256441c33aab7ec97865849e3ad` |
| V5-3 | PASS | Reference moved 800 to 900. First bell voided and re-anchored, the next bell cleared at 900 | void `0xd3901e18f9d03101af2a05287fc469459fb45497dc49300c7ef29b4983e22170`, clear `0xc3f08159efd5247a04d09ba6fcc1edacde943d62ba1435685f6c14d39d4a3c7e`, settle `0xe2b9209c90599183d9e681750361754885f8eda0e779a6ecb2bf1844179756cd` |
| V5-4 | PASS | One buyer revoked approval. Its pull failed, it dropped alone, and the other two settled in the same Lasna transaction | bell `0x426266d6730cf6356773136f2645d1d244c03e00d15a06faec36c7b512a6064d`, settle and unwind `0xd661fb9eb729baea0df0b0d84825bec1837831390f94d93f8eeaf082cb705838` |
| V5-4 extra | PASS | Lost Base delivery. After the 300 second timeout the next bell dropped the two missing orders and settled the survivor | expiry bell `0x8154b3c7e63a06d3cfee2b3a1370310193b2d25e42f2476ad0120d1d021d8e04` |
| V5-5 | PASS | Cancel before the bell dropped the order with no pull | cancel (Base) `0x34800786ea084db9391284c5716bd613cdbe04e4458edefb13c7baf9ae439786`, drop `0x7751c228dbbf9ab3c8b593254e1319182e92ceebed0a516be44a7b9e7970bca6` |
| V5-6 | Measured | Live 8 orders, 7 pairs: bell 364,590 gas, settle 717,911 gas. MAX_BOOK set to 6 | bell `0x826de8b5c375d7c011cae36e9c0b251257adad593e9efc0e3ef2c3e956ea44c0`, settle `0x0f9085c5e98e517c6ebe9e4b958482f8e0a82c7dff76f60c2f463d6c62da79d7` |
| V5-6 live, 6 orders | PASS | The new book limit, run live on the final set: 4 traders, both chains, 6 eligible, 5 pairs, 1 pool remainder swap, all pulls and payouts ok, 6 orders closed. Bell 319,327 gas, settle 577,320 gas (64% of the 900k cap) | bell `0x09d23700d3144214e778f4541de6b1dd466b0cefc1008d08425f395e85497143`, settle `0x16255e2072d0440c892ecf8f2f4d794604aaf0d18a1947874b0bcb1b2fb06f58` |
| V5-7, gates 10 and 11 | PASS | Timer-driven bell one block after the Cron100 tick, priced and settled at the pool price at the bell (795.309095) | same round as V5-6 |
| V5-7, gate 13 | PASS (final v5) | 4 traders, buyers and sellers on both chains, 0.0005 WETH each. Bell one block after the tick at 798.136090, 2 pairs, all 4 pulls and all payouts ok, dust refunded. Bell 325,314 gas, settle 402,655 gas | bell `0x9475aa184102d2fcf2c54c84d0efd3be688394c8bff9d256c0a3bccc3627369d`, settle `0xaa811d9cc7beb0a9d5715dadf310b1ad724079d6e1fa3139e88579064b81deb9` |
| Gate 16 | PASS | Three demo runs on the final set, by script. Base buyer, Unichain seller, one match plus a pool-filled leftover. Bell to first pull 1 to 2 s, bell to last payout 5 to 6 s, Lasna settled 2 s after the bell | run 1 bell `0x96ad9e61f4fc40c20bbf4a689143c000659f4fce38e6bbbdc8ebf206b2d92d85`, run 2 bell `0x1bb5b7f7be9d649881d4d491d0fb071ec98bf3bfb4ebd2781d4ef877c77e777c`, run 3 bell `0x6c79e4fa9d402c65f9c484cb7e8f375cd9909a28f30a0b0ae8cc27097eff06d8` |
| Gate 15 | NOT RUN | Frontend truth. Frontend work is on hold by the owner's instruction | none |

Gates 12 and 14 are covered by V5-2 and V5-4.

Late delivery, observed live. Base Sepolia stopped including user transactions for about 2 hours. When it recovered, the stalled callbacks of the V5-4 round landed late. One order's late pull failed. Its trader's approval was in place, so the likely cause is that the order had been frozen by the refund request, though the logs don't prove the order of arrival. The other order's pull succeeded because its trader's approval had just landed, and the desk then refunded the 0.8 USDC from its own record. The desk ended with 0 USDC.

Gas, local table with a stand-in system contract, worst case with the most pairs: 4 orders settle 285k, 8 orders 464k, 12 orders 644k, 16 orders 823k, 24 orders 1.18M. The live system adds about 10.6k gas per callback, which is why the live 8-order settle is 1.55 times the local number. With 11k per callback added, the local table predicted 395k for the 4-order settle and the live round used 403k. For the 6-order book the estimate was about 562k for the worst case and the live round used 577k, 3% above it, so the estimate is good to a few percent and the 900k cap still has 36% headroom at 6 orders.

Earlier evidence (gates 10 to 14 on v2 and v3, failure cases on v4) is kept in the project's test notes.

Demo run latency (block timestamps, good to about 2 s because the chain clocks differ): run 1 first pull 1 s, last payout 5 s. Runs 2 and 3 first pull 2 s, last payout 6 s. In run 1 the Base pool filled the leftover at about 820 per ETH because earlier buyer leftovers had pushed our thin pool up. The pool was re-aligned to the reference before runs 2 and 3, which filled at about 799. Measured with `scripts/latency-v5.js`.
