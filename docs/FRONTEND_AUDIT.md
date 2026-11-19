# Frontend audit: commit 4f67bf4

Audit of `frontend/` at commit 4f67bf4, 18 Nov 2026, against `DESIGN_SYSTEM.md (proposal)` and the truth rules in `Frontend.md` (both in Notion). Read-only: this PR adds the report and its evidence and changes no app code. The fixes are left for a separate change.

The audit was first run on 8aadf68. The build session pushed 4f67bf4 (phone layout fixes and a new way of finding a wallet's orders) while it was running, so everything below was run again on 4f67bf4. One finding (the landing hero card missing its Bell corner) is already fixed there and is listed as fixed.

## Status

- H1, H2 and H3 are fixed on branch `fix/paid-truth` (PR #2). See [`audit/fix-paid-truth/`](audit/fix-paid-truth/) for the verification screenshots, and `frontend/tests/paid-truth.mjs` for the unit tests.
- M3 is fixed in 4f67bf4.
- M5 is fixed on main (19 Nov 2026). `#/states` exists only in development builds. In production it opens the landing page and the gallery's code isn't in the bundle.
- Every other Medium and Low finding below is still open.

## Method

- `npm ci`, typecheck and production build.
- Every screen rendered against live testnet data at 390px and 1280px, in light and dark: 7 screens, 28 screenshots in [`docs/audit/frontend-4f67bf4/`](audit/frontend-4f67bf4/). They were made with [`capture.mjs`](audit/frontend-4f67bf4/capture.mjs) against `vite preview`.
- The repo's own `tests/axe.mjs` and `tests/keys.mjs`, run with live data.
- A read of the chain, round, order, button and style code, and the desk contract's accounting.

## Verdict

The build is clean and close to the design. The serious problems are in what the app tells a trader about their money. Refunded orders can show as paid, and "Paid" and "Settled" can appear before the payout lands on the other chain. Fix the three High items before any demo. The rest is polish.

## What passed

- Typecheck and production build pass.
- No generic libraries. The runtime dependencies are `react`, `react-dom` and `viem` only. Fonts are self-hosted.
- `src/styles/tokens.css` matches the design system's values exactly, in both modes. The theme is applied before the first frame (`index.html`).
- Contract addresses come from `deployments/bell.json` (`src/chain/config.ts`), not copies.
- Raw units never reach the screen (`src/chain/format.ts`).
- axe: zero violations on 7 screens, at phone and desktop width, in light and dark.
- Keyboard pass: every focused control shows a visible focus ring, and the sheet returns focus.
- No horizontal overflow on any screen at 390px or 1280px, and no page errors.
- Live data loads. The Bell screen read the Uniswap price (800.69 USDC per ETH) and the real book.
- No testnet strip, no DoraHacks, no blue accent and no banned words. Reduced motion is handled (`src/styles/base.css:43`). Polite and assertive live regions exist (`src/app/Shell.tsx:29-30`). Hold to join works, with a keyboard confirm.

## High: truth rules (fix before any demo)

### H1. Refunded orders show as Paid

`src/chain/account.ts:152` marks an order settled (ticket step 3, Paid) when `closedOf == collectedOf`. On the desk, `refundOrder` also sets `closedOf = collectedOf` (`contracts/BellDesk.sol:191`), the same as `closeOrder` (`contracts/BellDesk.sol:175`). So a trader whose order was unwound and refunded is told they were paid.

Fix direction: derive the outcome from events. `Paid` or `Swapped` to the trader's address on the counterparty desk means paid. `Refunded` to the trader means refunded. For dropped orders, use the referee's `OrderDropped` reason.

### H2. "Paid" appears before the payout lands

- `src/ui/BellCard.tsx:91` and `:95` force both chain nodes to "Paid" whenever the round state is `done`. `done` comes from the Lasna `Settled` event (`src/chain/round.ts`, `markStateOf`), which only means the payouts were requested.
- `src/ui/BellCard.tsx:55` counts a desk's `Closed` event as Paid. `closeOrder` is a separate callback, and it can land before the payment.
- The ticket's Paid step (H1) uses the trader's own desk closing. That says nothing about the payout on the counterparty's chain.

Fix direction: a chain shows Paid only when its `Paid` or `Swapped` event to the round's traders is confirmed.

### H3. The speed number can be wrong

- "Settled in N seconds" falls back to the Lasna settle time when payout seconds are missing (`src/screens/Bell.tsx:48`, `:83`, `src/ui/LastBell.tsx:16`). The Lasna time is shorter than the real payout time.
- `payoutSeconds` counts `Closed` and `Refunded` events too, from any round within 90 seconds of the bell (`src/chain/round.ts:251`, `:255`).

Fix direction: match legs to the round's orders, count only `Paid` and `Swapped`, and show "Settling" instead of a number until the last payout is confirmed.

## Medium

| # | Finding | Where |
| --- | --- | --- |
| M1 | Buttons without an explicit glyph show a success tick ("Watch a live round", Activity's "Place an order", "Disconnect", the cancel button). | `src/ui/Button.tsx:86` |
| M2 | Two main actions per screen. The header's Signal "Connect wallet" competes with the page's own Signal "Connect wallet" on Trade, Activity and Receipt. Make the header button secondary. | `src/app/Shell.tsx:138` |
| M3 | Fixed in 4f67bf4. The landing hero card was missing its Bell corner and radius. It now carries the `bc bc-card` classes. | `src/screens/Landing.tsx:33` |
| M4 | Unlimited approval (`maxUint256`) while the copy says "Approve USDC once". The hardened desk only pulls what each order commits to, but say so in the approve step, or approve a capped amount. | `src/screens/Trade.tsx:98` |
| M5 | Fixed 19 Nov 2026. The States gallery shipped in production at `#/states`, with sample numbers (Buy 0.0120 ETH at 2,450 USDC). Now gated behind `import.meta.env.DEV`. | `src/app/App.tsx:25` |
| M6 | 60/30/10 drift. Contracts and Help in light mode have no Ink card and look washed out. The phone landing page in light mode is roughly half Ink, well over 30%. | `contracts-*-light.png`, `help-*-light.png`, `landing-phone-light.png` |
| M7 | Help uses native `details`/`summary` with the browser's default triangle, which the design bans. | `src/screens/HelpScreen.tsx:9` |
| M8 | In dark mode the selected half of the Buy/Sell switch (Midnight) is hard to tell from the track. | `trade-*-dark.png` |

## Low

| # | Finding | Where |
| --- | --- | --- |
| L1 | The Paid status mark draws a white tick on light Mint in dark mode, which is nearly invisible. | `src/styles/screens.css:61` |
| L2 | Landing step cards alternate the cut corner (step 2 at the bottom-right), but design section 6c says landing steps aren't a pair. | `landing-*.png` |
| L3 | On desktop the footer silhouette rises behind the link columns instead of sitting below them (design section 9b). | `*-desktop-*.png` |
| L4 | Contracts page: Copy buttons are outline pills and explorer links are plain text, where the spec has icon actions and explorer chips. The rule text "two open orders, 15 minutes" is hard-coded, though `MAX_ORDERS_PER_TRADER` and `ORDER_TTL` are already read from the referee. | `src/screens/Contracts.tsx:53` |
| L5 | The loading skeleton is a plain block, not shaped like the content. | `states-*.png` |
| L6 | Activity's empty-state button sits on the card's bottom edge. | `activity-phone-*.png` |
| L7 | Copy says "every couple of minutes" on Landing and "about every 3 minutes" elsewhere. Pick one. | `src/screens/Landing.tsx:13` |
| L8 | One 550 kB JavaScript bundle. Split viem and the wallet code so phones load faster. | `npm run build` output |
| L9 | The footer "Help" link is 36px wide. That passes WCAG 2.2 AA (24px) but is below the design's 44px target. | `tests/keys.mjs` notes |

## Not tested

- Wallet flows (connect, wrap, approve, hold to join, cancel) with a real wallet.
- A receipt for a real order.
- The living mark and the chain nodes during a real bell.
- TalkBack and VoiceOver, which need real devices.
- Performance on a real phone.

## Suggested order

1. H1 to H3 together, since they're one change to how outcomes and payouts are read.
2. M1, M2 and M5.
3. A live round on testnet with a wallet, to check the paid moment end to end.
4. The remaining Medium and Low items.
