# Live evidence, v5

All on testnet, 18 Nov 2026. Transactions on Lasna are at `https://lasna.reactscan.net/tx/<hash>`, on Base Sepolia at `https://sepolia.basescan.org/tx/<hash>` and on Unichain Sepolia at `https://sepolia.uniscan.xyz/tx/<hash>`. USDC amounts are written with decimals.

Deployment under test (v5-rc1, contracts at commit 4f7731a, MAX_BOOK 12 at deploy): referee `0x16713C0097B4c57a51326F3062E9328c067FCc0f`, Base desk `0xd4dcaA8D8922c95587751A3042dfFDCdDC063233`, Unichain desk `0x9e72a8896dd5a4c15AFFFF0c408B2Bced606A3E2`. The final v5 set is redeployed with MAX_BOOK 6 when Base Sepolia accepts transactions again.

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
| V5-7, gates 10 and 11 | PASS | Timer-driven bell one block after the Cron100 tick, priced and settled at the pool price at the bell (795.309095) | same round as V5-6 |
| V5-7, gate 13 | BLOCKED | Needs buyers and sellers on both chains. Base Sepolia has not included user transactions since about Lasna block 8611000 | none yet |

Gates 12 and 14 are covered by V5-2 and V5-4.

Gas, local table with a stand-in system contract, worst case with the most pairs: 4 orders settle 285k, 8 orders 464k, 12 orders 644k, 16 orders 823k, 24 orders 1.18M. The live system adds about 10.6k gas per callback, which is why the live 8-order settle is 1.55 times the local number.

Earlier evidence (gates 10 to 14 on v2 and v3, failure cases on v4) is kept in the project's test notes.
