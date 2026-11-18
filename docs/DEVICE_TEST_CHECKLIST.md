# Device and screen reader checklist (tests D-01, D-02, D-03, D-05)

These need a real phone, a wallet app and a screen reader, so they cannot be run from the cloud container. Allow about 45 minutes. Send back the results in the table at the bottom, with a screenshot named `TESTID-device-theme.png` (for example `D-01-android-dark.png`).

App: https://bell-gold-six.vercel.app (testnet only, use test funds). Contract addresses are on the app's Contracts and proof page.

## Before you start

1. Test wallet with at least 0.001 test ETH and 1 test USDC on Base Sepolia and Unichain Sepolia (Circle faucet for USDC, the links on the Trade screen for ETH). The repo's test wallets are in `~/.config/bell-testnet/wallets.json` on the tester machine. Do not paste private keys into chat or screenshots.
2. A second wallet that sells, so a round has two sides (a seller needs about 0.001 WETH, the app wraps ETH for you).
3. Check the referee has at least 1 REACT before a run: `ONCE=1 MIN=1 node scripts/watch-reserves.js`.

## D-01 Android, Chrome, then the MetaMask in-app browser

1. Open the app in Chrome. Landing loads, the countdown or "Market quiet" shows, nothing sideways-scrolls.
2. Tap Connect wallet, pick the wallet. Confirm the amber Testnet tag shows on the wallet button.
3. Trade: Buy ETH 0.0005 on Base. If asked, tap Approve (watch the button show real step names), then hold the orange button for a bit more than half a second. A short tap must do nothing.
4. Watch the Bell tab: the mark changes, the countdown matches the clock time, then Settling, then Paid in a few seconds. Paid must never appear before the payout shows on the explorer.
5. Open Activity, then the receipt. Check the amounts and that every explorer link opens.
6. Repeat step 1 to 5 inside the MetaMask app's built-in browser.

## D-02 iPhone, Safari, then a wallet app browser

Same as D-01 on an iPhone. Extra checks: the bottom tab bar does not sit under the home bar, the pinned Hold to join button is not hidden by the tab bar, and pulling down to refresh does not break the page.

## D-03 Desktop, two browsers, two wallet extensions

Chrome with MetaMask, and Firefox or Safari with Rabby or Coinbase Wallet. Connect, place one order, cancel one order from Activity, switch the account in the wallet and see the app follow, switch network and see the Switch to button.

## D-05 Screen readers

TalkBack (Android) and VoiceOver (iPhone), on Trade and Bell.

- Every control has a spoken name (Connect wallet, Buy ETH, Sell ETH, Amount, Protection, the chain cards, Hold to join).
- Hold to join: double tap should open the confirm sheet instead of needing a hold. Confirm it.
- During a round you hear short announcements such as "Bell rang" and "Settled", not the countdown every second.
- Dialogs (connect sheet, account sheet) trap focus and return it on close.

## Results

| Test | Device and browser | Wallet | Pass or fail | What you saw | Screenshot |
| --- | --- | --- | --- | --- | --- |
| D-01 | | | | | |
| D-02 | | | | | |
| D-03 | | | | | |
| D-05 | | | | | |
