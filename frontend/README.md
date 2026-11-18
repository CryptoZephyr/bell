# Bell frontend (behavior only)

Three screens, no backend, no build step. The page reads Base Sepolia, Unichain Sepolia and Reactive Lasna directly. Visual design is the owner's: `style.css` is layout only, and the markup in `index.html` and the rendering in `app.js` are meant to be restyled or replaced.

```bash
cd frontend
python3 -m http.server 8765    # then open http://localhost:8765
```

- Trade: pick a chain, side, amount and protection against the Uniswap price. The page shows the limit it will place, asks for the one-time approval, and places the order on the desk. It also wraps ETH and cancels an order that has not been pulled.
- Live round: the stage (quiet, open, bell, settling, done), a countdown to the next bell, the combined book tagged by chain, the Uniswap reference price, and recent referee events with proof links.
- Receipt: for any wallet, what it received and on which chain, the pool fee a match saved (slippage is not counted), and a link chain from the order to the bell, the settlement and the desk payouts.

Truth rules, from the project notes: a placed order is never shown as filled (only a desk `Closed` event after payment counts), every number comes from chain state, and every proof link is a real transaction.

`config.js` holds the v5 addresses. They come from `deployments/bell.json`, so update both together if the set is redeployed. `vendor/ethers.umd.min.js` is a copy of ethers 6 from `node_modules`.

Checked in a headless browser against the live testnets: the Live round and a Receipt load with no console errors, and the Trade flow (approve, place, see the order in the book, cancel) ran end to end with a local test wallet. A real browser wallet has not been tried.
