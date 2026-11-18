// Bell frontend behavior. Three screens: Trade, Live round, Receipt. No backend, reads the chains directly.
(function () {
  const B = window.BELL;
  const E = window.ethers;
  const C = window.BellChain;
  const $ = (id) => document.getElementById(id);

  const text = (el, s) => { el.textContent = s; };
  function td(parent, content) {
    const cell = document.createElement("td");
    if (content instanceof Node) cell.appendChild(content); else cell.textContent = content;
    parent.appendChild(cell);
    return cell;
  }
  function table(headers, rows) {
    const t = document.createElement("table");
    const h = t.createTHead().insertRow();
    for (const x of headers) { const th = document.createElement("th"); th.textContent = x; h.appendChild(th); }
    const b = t.createTBody();
    for (const r of rows) { const tr = b.insertRow(); for (const c of r) td(tr, c); }
    return t;
  }
  function link(label, chainId, tx) {
    const a = document.createElement("a");
    a.href = C.txUrl(chainId, tx); a.target = "_blank"; a.rel = "noopener"; a.textContent = label;
    return a;
  }

  // ---- tabs ----
  const tabs = ["trade", "round", "receipt"];
  function showTab(name) {
    for (const t of tabs) $(t).hidden = t !== name;
    document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    if (name === "round") refreshRound();
  }
  document.querySelectorAll("nav button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

  // ---- wallet ----
  let browser = null, signer = null, account = null;
  async function connect() {
    if (!window.ethereum) { text($("tradeStatus"), "No wallet found. Install a browser wallet to place orders. The Live round and Receipt screens work without one."); return; }
    browser = new E.BrowserProvider(window.ethereum);
    await browser.send("eth_requestAccounts", []);
    signer = await browser.getSigner();
    account = await signer.getAddress();
    text($("account"), C.short(account));
    $("receiptAddr").value = $("receiptAddr").value || account;
    await refreshTrade();
    refreshMyOrders();
  }
  $("connect").addEventListener("click", () => connect().catch((e) => text($("tradeStatus"), "Wallet: " + (e.shortMessage || e.message))));

  async function ensureChain(chainId) {
    const net = await browser.getNetwork();
    if (Number(net.chainId) === chainId) return;
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: B.chains[chainId].hex }] });
    browser = new E.BrowserProvider(window.ethereum);
    signer = await browser.getSigner();
  }

  // ---- trade ----
  const parseEth = (s) => { try { return E.parseEther(String(s).trim()); } catch { return null; } };
  const parsePct = (s) => { const n = Number(String(s).trim()); return Number.isFinite(n) && n >= 0 && n <= 50 ? n : null; };

  function currentOrder(refPrice) {
    const qty = parseEth($("amount").value);
    const pct = parsePct($("protection").value);
    if (!qty || qty <= 0n || pct === null || !refPrice) return null;
    const isBuy = $("side").value === "buy";
    const bps = BigInt(Math.round(pct * 100));
    const limit = isBuy ? (refPrice * (10000n + bps)) / 10000n : (refPrice * (10000n - bps)) / 10000n;
    // A buyer pulls the cost at the settle price, at most the limit. A seller pulls the ETH.
    const need = isBuy ? (qty * limit + 10n ** 18n - 1n) / 10n ** 18n : qty;
    return { chainId: Number($("chain").value), isBuy, qty, limit, need };
  }

  let refPriceCache = null;
  async function refreshTrade() {
    try { refPriceCache = (await C.poolPrice(B.referenceChainId)).price; } catch (e) { refPriceCache = null; }
    const o = currentOrder(refPriceCache);
    if (!refPriceCache) { text($("quote"), "Could not read the Uniswap reference price."); return; }
    if (!o) { text($("quote"), `Reference price ${C.fmtUsd(refPriceCache)} USDC per ETH. Enter an amount and a protection between 0 and 50.`); return; }
    const where = o.isBuy ? "pay up to" : "receive at least";
    text($("quote"), `Reference price ${C.fmtUsd(refPriceCache)} USDC per ETH. Your protection limit is ${C.fmtUsd(o.limit)}. You ${where} that per ETH, on a match or in the pool.`);

    const tokenKey = o.isBuy ? "usdc" : "weth";
    $("wrap").hidden = o.isBuy || !account;
    $("approve").hidden = true;
    if (!account) { text($("approvalState"), "Connect a wallet to approve and join."); return; }
    const tk = C.token(o.chainId, tokenKey);
    const [bal, allowance] = await Promise.all([tk.balanceOf(account), tk.allowance(account, B.chains[o.chainId].desk)]);
    const sym = o.isBuy ? "USDC" : "WETH";
    const dec = (v) => (o.isBuy ? C.fmtUsd(v) : C.fmtEth(v));
    if (bal < o.need) text($("approvalState"), `You need ${dec(o.need)} ${sym} on ${B.chains[o.chainId].name} and have ${dec(bal)}.`);
    else if (allowance < o.need) { text($("approvalState"), `One-time approval needed: the desk must be allowed to pull your ${sym}. Funds stay in your wallet until the bell.`); $("approve").hidden = false; }
    else text($("approvalState"), `Approved. ${dec(o.need)} ${sym} stays in your wallet until the bell.`);
  }
  ["chain", "side", "amount", "protection"].forEach((id) => $(id).addEventListener("input", () => refreshTrade()));

  $("wrap").addEventListener("click", async () => {
    try {
      const o = currentOrder(refPriceCache); if (!o) return;
      await ensureChain(o.chainId);
      const weth = C.token(o.chainId, "weth", signer);
      text($("tradeStatus"), "Wrapping ETH… confirm in your wallet.");
      const tx = await weth.deposit({ value: o.qty });
      await tx.wait();
      text($("tradeStatus"), "Wrapped.");
      refreshTrade();
    } catch (e) { text($("tradeStatus"), "Wrap failed: " + (e.shortMessage || e.message)); }
  });

  $("approve").addEventListener("click", async () => {
    try {
      const o = currentOrder(refPriceCache); if (!o) return;
      await ensureChain(o.chainId);
      const tk = C.token(o.chainId, o.isBuy ? "usdc" : "weth", signer);
      text($("tradeStatus"), "Approving… confirm in your wallet.");
      const tx = await tk.approve(B.chains[o.chainId].desk, E.MaxUint256);
      await tx.wait();
      text($("tradeStatus"), "Approved.");
      refreshTrade();
    } catch (e) { text($("tradeStatus"), "Approval failed: " + (e.shortMessage || e.message)); }
  });

  $("tradeForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!account) { await connect().catch(() => {}); if (!account) return; }
    try {
      await refreshTrade();
      const o = currentOrder(refPriceCache);
      if (!o) { text($("tradeStatus"), "Check the amount and protection."); return; }
      await ensureChain(o.chainId);
      const d = C.desk(o.chainId, signer);
      text($("tradeStatus"), "Placing your order… confirm in your wallet.");
      const tx = await d.place(o.isBuy, o.limit, o.qty);
      const r = await tx.wait();
      const ev = r.logs.map((l) => { try { return d.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "OrderPlaced");
      const msg = document.createDocumentFragment();
      msg.append(`Order ${ev ? "#" + ev.args.orderId : ""} placed. It is not filled yet. It fills only when the desk closes it after the bell. `, link("order transaction", o.chainId, r.hash));
      $("tradeStatus").replaceChildren(msg);
      refreshMyOrders();
    } catch (e) { text($("tradeStatus"), "Order failed: " + (e.shortMessage || e.message)); }
  });

  async function refreshMyOrders() {
    if (!account) return;
    const box = $("myOrders");
    text(box, "Reading your orders from the chains…");
    try {
      const rows = await C.myOrders(account);
      if (!rows.length) { text(box, "No orders from this wallet on the v5 desks."); return; }
      const t = table(["Chain", "Order", "Side", "ETH", "Limit (USDC)", "Status", ""], rows.map((r) => {
        const cancel = document.createElement("span");
        if (r.canCancel) {
          const b = document.createElement("button"); b.textContent = "Cancel";
          b.addEventListener("click", async () => {
            try {
              await ensureChain(r.chainId);
              text($("tradeStatus"), "Cancelling… confirm in your wallet.");
              const tx = await C.desk(r.chainId, signer).cancel(r.deskOrderId);
              await tx.wait();
              text($("tradeStatus"), "Cancelled. If your funds were already pulled this is too late and the trade goes through.");
              refreshMyOrders();
            } catch (e) { text($("tradeStatus"), "Cancel failed: " + (e.shortMessage || e.message)); }
          });
          cancel.appendChild(b);
        }
        return [r.chain, link("#" + r.deskOrderId, r.chainId, r.tx), r.isBuy ? "buy" : "sell", C.fmtEth(r.qty), C.fmtUsd(r.limit), r.status, cancel];
      }));
      box.replaceChildren(t);
    } catch (e) { text(box, "Could not read your orders: " + (e.shortMessage || e.message)); }
  }

  // ---- live round ----
  const STAGES = { quiet: "quiet", open: "open", bell: "bell", settling: "settling", done: "done" };
  let roundTimer = null, countdownTimer = null, secondsLeft = null;

  async function refreshRound() {
    const sum = $("roundSummary");
    try {
      const r = await C.liveRound();
      const parts = [];
      parts.push(`Stage: ${STAGES[r.stage]}.`);
      parts.push(`Uniswap reference price: ${C.fmtUsd(r.referencePrice)} USDC per ETH.`);
      if (r.stage === "quiet") parts.push("Market quiet. The next bell starts when someone places an order.");
      sum.replaceChildren();
      const p1 = document.createElement("p"); p1.textContent = parts.slice(0, 2).join(" ");
      sum.appendChild(p1);
      if (r.stage === "quiet") { const q = document.createElement("p"); q.textContent = parts[2]; sum.appendChild(q); }
      const cd = document.createElement("p"); cd.id = "countdown"; sum.appendChild(cd);
      secondsLeft = r.secondsToBell && !r.pulling ? r.secondsToBell : null;
      renderCountdown();
      if (r.stage === "done" && r.lastSettled) {
        const d = document.createElement("p");
        d.append(`Last round settled ${r.lastSettled.args.pairCount} pair(s) at ${C.fmtUsd(r.lastSettled.args.price)} USDC per ETH. `, link("settling transaction", "lasna", r.lastSettled.tx));
        sum.appendChild(d);
      }
      const meta = document.createElement("p"); meta.className = "muted";
      meta.textContent = `Lasna block ${r.block}. Round ${r.roundId}. Book ${r.book.length} of ${r.maxBook}.`;
      sum.appendChild(meta);

      $("book").replaceChildren(r.book.length
        ? table(["#", "Chain", "Side", "ETH", "Limit (USDC)", "Trader"], r.book.map((o, i) => [String(i + 1), o.chain, o.isBuy ? "buy" : "sell", C.fmtEth(o.qty), C.fmtUsd(o.limit), C.short(o.trader)]))
        : Object.assign(document.createElement("p"), { textContent: "The book is empty." }));

      const ev = [...r.events].reverse().slice(0, 25);
      $("events").replaceChildren(ev.length
        ? table(["Block", "Event", "Detail", "Proof"], ev.map((e) => {
          const detail = e.name === "OrderDropped" ? `order ${e.args.bookId}: ${e.args.reason}`
            : e.name === "BellVoid" ? e.args.reason
            : e.name === "BellRang" ? `price ${C.fmtUsd(e.args.price)}, ${e.args.eligibleCount} eligible, ${e.args.pairCount} pair(s)`
            : e.name === "Settled" ? `${e.args.pairCount} pair(s) at ${C.fmtUsd(e.args.price)}`
            : e.name === "RoundOpened" ? `anchor ${C.fmtUsd(e.args.price)}`
            : e.name === "Unwound" ? `order ${e.args.failedBookId} pull failed`
            : e.name === "PullsExpired" ? `${e.args.missing} pull(s) missing` : "";
          return [String(e.block), e.name, detail, link("tx", "lasna", e.tx)];
        }))
        : Object.assign(document.createElement("p"), { textContent: "No recent referee events." }));
    } catch (e) { text(sum, "Could not read the round: " + (e.shortMessage || e.message)); }
  }
  function renderCountdown() {
    const el = $("countdown"); if (!el) return;
    el.textContent = secondsLeft === null ? "" : `Next bell in about ${Math.max(0, secondsLeft)} s.`;
  }
  function startRoundTimers() {
    clearInterval(roundTimer); clearInterval(countdownTimer);
    roundTimer = setInterval(() => { if (!$("round").hidden) refreshRound(); }, 8000);
    countdownTimer = setInterval(() => { if (secondsLeft !== null) { secondsLeft -= 1; renderCountdown(); } }, 1000);
  }

  // ---- receipt ----
  $("receiptForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const addr = $("receiptAddr").value.trim();
    const out = $("receiptOut");
    if (!E.isAddress(addr)) { text(out, "Enter a valid wallet address."); return; }
    text(out, "Reading the receipt from the chains. This can take a moment…");
    try {
      const r = await C.receipt(E.getAddress(addr));
      const frag = document.createDocumentFragment();
      const h1 = document.createElement("h3"); h1.textContent = "What you got"; frag.appendChild(h1);
      frag.appendChild(r.received.length
        ? table(["Chain it landed on", "What", "Amount", "Proof"], r.received.map((x) => {
          const amt = x.token === "USDC" ? C.fmtUsd(x.amount) + " USDC" : x.token === "WETH" ? C.fmtEth(x.amount) + " WETH" : x.amount.toString() + " (raw units)";
          const detail = x.kind === "pool swap" ? `pool swap (used ${x.used}, returned ${x.refunded} raw units)` : x.kind;
          return [x.chain, detail, amt, link("tx", x.chainId, x.tx)];
        }))
        : Object.assign(document.createElement("p"), { textContent: "No payouts to this wallet yet. A placed order is not a fill." }));
      const h2 = document.createElement("h3"); h2.textContent = "Savings against a direct Uniswap swap"; frag.appendChild(h2);
      const s = document.createElement("p");
      s.textContent = r.matchedUsdc > 0n
        ? `Matched trades worth about ${C.fmtUsd(r.matchedUsdc)} USDC paid no pool fee. A direct swap pays 0.05%, so about ${C.fmtUsd(r.feeSavedUsdc)} USDC. Price impact is not counted.`
        : "No matched trades for this wallet yet, so no fee saving to show.";
      frag.appendChild(s);
      const h3 = document.createElement("h3"); h3.textContent = "How this settled"; frag.appendChild(h3);
      for (const o of r.how) {
        const p = document.createElement("p");
        p.append(`${o.chain} order #${o.id}: `);
        o.links.forEach((l, i) => { if (i) p.append(" → "); p.append(link(l.label, l.chainId, l.tx)); });
        frag.appendChild(p);
      }
      if (!r.how.length) frag.appendChild(Object.assign(document.createElement("p"), { textContent: "No orders from this wallet on the v5 desks." }));
      out.replaceChildren(frag);
    } catch (e) { text(out, "Could not read the receipt: " + (e.shortMessage || e.message)); }
  });

  startRoundTimers();
  refreshTrade();
  if (window.ethereum && window.ethereum.selectedAddress) connect().catch(() => {});
})();
