// Chain reads for the Bell frontend. Everything comes from chain state. There is no backend.
// Truth rules (Frontend.md): a placed order is never shown as filled, numbers come only from chain state,
// and every proof link points to a real transaction.
(function () {
  const B = window.BELL;
  const E = window.ethers;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const providers = {};
  function prov(key, url) {
    if (!providers[key]) providers[key] = new E.JsonRpcProvider(url, undefined, { staticNetwork: true, batchMaxCount: 1 });
    return providers[key];
  }
  const lasna = () => prov("lasna", B.lasna.rpc);
  const chainProv = (id) => prov(String(id), B.chains[id].rpc);
  const referee = () => new E.Contract(B.referee, [...B.abi.referee, "function bookIdOf(bytes32) view returns (uint256)"], lasna());
  const desk = (id, runner) => new E.Contract(B.chains[id].desk, B.abi.desk, runner || chainProv(id));
  const token = (id, which, runner) => new E.Contract(B.chains[id][which], B.abi.erc20, runner || chainProv(id));

  // Retry a read a few times. Public RPCs are rate limited and sometimes serve stale data.
  async function retry(fn, tries = 4) {
    let last;
    for (let i = 0; i < tries; i++) {
      try { return await fn(); } catch (e) { last = e; await sleep(500 * (i + 1)); }
    }
    throw last;
  }

  async function logsChunked(contract, filter, from, to, step) {
    const out = [];
    for (let f = from; f <= to; f += step) {
      const t = Math.min(f + step - 1, to);
      out.push(...(await retry(() => contract.queryFilter(filter, f, t))));
    }
    return out;
  }

  // ---- prices (USDC micro-units per 1 WETH, USDC is currency0 in every pool) ----
  const priceAtSqrt = (s) => (s === 0n ? 0n : ((10n ** 18n) << 192n) / (s * s));
  const sqrtAtPrice = (p) => isqrt(((10n ** 18n) << 192n) / p);
  function isqrt(n) {
    if (n < 2n) return n;
    let x = n, y = (n + 1n) / 2n;
    while (y < x) { x = y; y = (x + n / y) / 2n; }
    return x;
  }

  function poolId(chainId) {
    const c = B.chains[chainId];
    return E.keccak256(E.AbiCoder.defaultAbiCoder().encode(["address", "address", "uint24", "int24", "address"], [c.usdc, c.weth, 500, c.tickSpacing, E.ZeroAddress]));
  }

  async function poolPrice(chainId) {
    const c = B.chains[chainId];
    const pm = new E.Contract(c.poolManager, B.abi.poolManager, chainProv(chainId));
    const slot = BigInt(E.keccak256(E.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [poolId(chainId), 6])));
    const raw = BigInt(await retry(() => pm.extsload(E.toBeHex(slot, 32))));
    const sqrt = raw & ((1n << 160n) - 1n);
    return { sqrt, price: priceAtSqrt(sqrt) };
  }

  const fmtUsd = (micro) => (Number(micro) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
  const fmtEth = (wei) => E.formatEther(wei);
  const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
  const txUrl = (chainId, hash) => (chainId === "lasna" ? B.lasna.explorer : B.chains[chainId].explorer) + hash;

  // ---- live round ----
  async function liveRound() {
    const ref = referee();
    const lp = lasna();
    const block = await retry(() => lp.getBlockNumber());
    const [cronOn, pulling, openPrice, settlePrice, roundId, maxBook] = await Promise.all([
      retry(() => ref.cronOn()), retry(() => ref.pulling()), retry(() => ref.openPrice()),
      retry(() => ref.settlePrice()), retry(() => ref.roundId()), retry(() => ref.MAX_BOOK()),
    ]);

    const book = [];
    for (let i = 0; i < Number(maxBook); i++) {
      let id;
      try { id = await ref.openIds(i); } catch { break; }
      const o = await retry(() => ref.orders(id));
      book.push({
        bookId: id, trader: o.trader, chainId: Number(o.chainId), chain: B.chains[Number(o.chainId)].name,
        isBuy: o.isBuy, deskOrderId: Number(o.deskOrderId), limit: o.limit, qty: o.qty,
      });
    }

    const head = await retry(() => lp.getBlock(block));
    const back = await retry(() => lp.getBlock(Math.max(block - 100, B.refereeDeployBlock)));
    const secPerBlock = block > back.number ? (head.timestamp - back.timestamp) / (block - back.number) : 2;
    const blocksToTick = B.bellEveryBlocks - (block % B.bellEveryBlocks);

    const events = await logsChunked(ref, "*", Math.max(B.refereeDeployBlock, block - 600), block, 300);
    const parsed = events
      .map((l) => ({ name: l.fragment ? l.fragment.name : "?", args: l.args, block: l.blockNumber, tx: l.transactionHash }))
      .sort((a, b) => a.block - b.block);
    const last = (name) => [...parsed].reverse().find((e) => e.name === name);
    const lastBell = last("BellRang");
    const lastSettled = last("Settled");

    let stage;
    if (pulling && lastBell && lastBell.block >= block - 4) stage = "bell";
    else if (pulling) stage = "settling";
    else if (book.length > 0) stage = "open";
    else if (lastSettled && block - lastSettled.block <= 150) stage = "done";
    else stage = "quiet";

    const ref1 = await poolPrice(B.referenceChainId);
    return {
      block, stage, cronOn, pulling, openPrice, settlePrice, roundId, maxBook: Number(maxBook), book,
      secondsToBell: cronOn || book.length > 0 ? Math.round((blocksToTick + 1) * secPerBlock) : null,
      referencePrice: ref1.price,
      events: parsed.filter((e) => ["BellRang", "BellVoid", "Settled", "Unwound", "PullsExpired", "OrderDropped", "RoundOpened"].includes(e.name)),
      lastSettled,
    };
  }

  // ---- a trader's orders ----
  async function myOrders(trader) {
    const ref = referee();
    const rows = [];
    for (const idStr of Object.keys(B.chains)) {
      const chainId = Number(idStr);
      const c = B.chains[chainId];
      const d = desk(chainId);
      const head = await retry(() => chainProv(chainId).getBlockNumber());
      const placed = await logsChunked(d, d.filters.OrderPlaced(null, trader), c.deskDeployBlock, head, 20000);
      for (const p of placed) {
        const id = p.args.orderId;
        const [collectedOf, closedOf, frozen] = await Promise.all([
          retry(() => d.collectedOf(id)), retry(() => d.closedOf(id)), retry(() => d.frozen(id)),
        ]);
        const key = E.keccak256(E.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [chainId, id]));
        const bookId = await retry(() => ref.bookIdOf(key));
        let inBook = false;
        if (bookId > 0n) inBook = (await retry(() => ref.orders(bookId))).open;
        const cancelled = (await retry(() => d.queryFilter(d.filters.OrderCancelled(id), c.deskDeployBlock, head))).length > 0;
        // Truth rule: "settled" means the desk closed the order after paying it. Nothing else counts as filled.
        let status;
        if (closedOf > 0n && closedOf === collectedOf) status = "settled";
        else if (collectedOf > 0n) status = "funds pulled, settling";
        else if (cancelled) status = "cancelled";
        else if (inBook) status = "in the book, waiting for the bell";
        else if (frozen) status = "dropped";
        else status = "placed, referee has not heard it yet";
        rows.push({
          chainId, chain: c.name, deskOrderId: Number(id), isBuy: p.args.isBuy, limit: p.args.price, qty: p.args.qty,
          tx: p.transactionHash, status, canCancel: !frozen && collectedOf === 0n && !cancelled,
        });
      }
    }
    return rows;
  }

  // ---- receipt ----
  async function receipt(trader) {
    const ref = referee();
    const lp = lasna();
    const lhead = await retry(() => lp.getBlockNumber());
    const refEvents = await logsChunked(ref, "*", B.refereeDeployBlock, lhead, 1000);
    const refParsed = refEvents.map((l) => ({ name: l.fragment ? l.fragment.name : "?", args: l.args, block: l.blockNumber, tx: l.transactionHash }));
    const settled = refParsed.filter((e) => e.name === "Settled");
    const tsCache = {};
    const ts = async (prv, key, n) => (tsCache[key + n] ??= (await retry(() => prv.getBlock(n))).timestamp);
    for (const s of settled) s.ts = await ts(lp, "lasna", s.block);

    const out = { trader, orders: [], received: [], feeSavedUsdc: 0n, matchedUsdc: 0n, how: [] };
    for (const idStr of Object.keys(B.chains)) {
      const chainId = Number(idStr);
      const c = B.chains[chainId];
      const prv = chainProv(chainId);
      const d = desk(chainId);
      const head = await retry(() => prv.getBlockNumber());
      const q = (f) => logsChunked(d, f, c.deskDeployBlock, head, 20000);
      const [placed, collected, paid, swapped, refunded, closed] = await Promise.all([
        q(d.filters.OrderPlaced(null, trader)), q(d.filters.Collected(null, trader)), q(d.filters.Paid(null, trader)),
        q(d.filters.Swapped(trader)), q(d.filters.Refunded(null, trader)), q(d.filters.Closed()),
      ]);
      const mine = new Set(placed.map((p) => p.args.orderId.toString()));
      for (const p of placed) out.orders.push({ chainId, chain: c.name, id: Number(p.args.orderId), isBuy: p.args.isBuy, limit: p.args.price, qty: p.args.qty, tx: p.transactionHash });

      // The token of a payout is read from the ERC20 Transfer to the trader in the same transaction.
      const tokenOf = async (txHash) => {
        const r = await retry(() => prv.getTransactionReceipt(txHash));
        for (const lg of r.logs) {
          const addr = lg.address.toLowerCase();
          const which = addr === c.usdc.toLowerCase() ? "usdc" : addr === c.weth.toLowerCase() ? "weth" : null;
          if (!which) continue;
          try {
            const p = token(chainId, which).interface.parseLog(lg);
            if (p && p.name === "Transfer" && p.args.to.toLowerCase() === trader.toLowerCase()) return { which, amount: p.args.value };
          } catch {}
        }
        return null;
      };
      const settleFor = async (blockNumber) => {
        const t = await ts(prv, String(chainId), blockNumber);
        let best = null;
        for (const s of settled) { const dt = Math.abs(s.ts - t); if (dt <= 120 && (!best || dt < best.dt)) best = { s, dt }; }
        return best ? best.s : null;
      };

      for (const e of paid) {
        if (!e.args.ok) continue;
        const t = await tokenOf(e.transactionHash);
        if (!t) continue;
        const s = await settleFor(e.blockNumber);
        let valueUsdc = 0n;
        if (t.which === "usdc") valueUsdc = t.amount;
        else if (s) valueUsdc = (t.amount * s.args.price) / 10n ** 18n;
        // A payout of a few raw units is the rounding dust the referee returns to a buyer, not a trade.
        const dust = t.which === "usdc" && t.amount <= 10n;
        out.received.push({ chainId, chain: c.name, kind: dust ? "rounding dust refund" : "matched trade", token: t.which === "usdc" ? "USDC" : "WETH", amount: t.amount, tx: e.transactionHash, price: s ? s.args.price : null });
        if (dust) continue;
        // A matched trade pays no pool fee. The saving shown is that fee, and slippage is not counted.
        if (valueUsdc > 0n && t.amount > 1000n) { out.matchedUsdc += valueUsdc; out.feeSavedUsdc += (valueUsdc * BigInt(B.poolFeePpm)) / 1000000n; }
      }
      for (const e of swapped) {
        if (!e.args.ok) continue;
        out.received.push({ chainId, chain: c.name, kind: "pool swap", token: e.args.sellWeth ? "USDC" : "WETH", amount: e.args.amountOut, tx: e.transactionHash, used: e.args.amountUsed, refunded: e.args.refunded });
      }
      for (const e of refunded) {
        if (!e.args.ok) continue;
        out.received.push({ chainId, chain: c.name, kind: "refund", token: "—", amount: e.args.amount, tx: e.transactionHash });
      }

      // How each order settled: the order, the reactive transactions and the desk legs, all real transactions.
      for (const p of placed) {
        const id = p.args.orderId;
        const added = refParsed.find((e) => e.name === "OrderAdded" && Number(e.args.chainId) === chainId && e.args.deskOrderId === id);
        const dropped = added ? refParsed.find((e) => e.name === "OrderDropped" && e.args.bookId === added.args.bookId) : null;
        const bell = dropped ? [...refParsed].reverse().find((e) => e.name === "BellRang" && e.block <= dropped.block) : null;
        out.how.push({
          chain: c.name, id: Number(id),
          links: [
            { label: "your order", chainId, tx: p.transactionHash },
            added && { label: "referee added it", chainId: "lasna", tx: added.tx },
            bell && { label: "bell", chainId: "lasna", tx: bell.tx },
            dropped && { label: `referee: ${dropped.args.reason}`, chainId: "lasna", tx: dropped.tx },
            ...collected.filter((e) => mine.has(e.args.orderId.toString()) && e.args.orderId === id).map((e) => ({ label: `pull (${e.args.ok ? "ok" : "failed"})`, chainId, tx: e.transactionHash })),
            ...closed.filter((e) => e.args.orderId === id).map((e) => ({ label: "closed on the desk", chainId, tx: e.transactionHash })),
          ].filter(Boolean),
        });
      }
    }
    return out;
  }

  window.BellChain = { liveRound, myOrders, receipt, poolPrice, desk, token, chainProv, priceAtSqrt, sqrtAtPrice, fmtUsd, fmtEth, short, txUrl, retry };
})();
