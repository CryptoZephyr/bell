// The Trade screen (sections 5, 7, 13). First-time guide, Buy or Sell, chain cards, amount, protection, the line that says
// where you will be paid, and one reactive button that always says the one next step.
import { useMemo, useRef, useState } from "react";
import { formatUnits, maxUint256 } from "viem";
import { useRoundCtx } from "../app/RoundContext";
import { useWallet, friendlyWalletError, type Friendly } from "../wallet/wallet";
import { useAnnounce, useSheets } from "../app/Shell";
import { useBalances } from "../app/account";
import { useOrders } from "../app/OrdersContext";
import { Button, type ButtonState } from "../ui/Button";
import { Sheet } from "../ui/Sheet";
import { HelpButton } from "../ui/Help";
import { Mark } from "../ui/Mark";
import { ChainMark, IconAlert, IconCheck, IconKey, IconPlus, IconWallet, IconArrowUpRight } from "../ui/Icons";
import { clock, countdown, fmtEth, fmtPrice, fmtUsdc, parseEthInput } from "../chain/format";
import { DESKS, DESK_CHAIN_IDS, type DeskChainId } from "../chain/config";
import { deskAbi, erc20Abi } from "../chain/abi";
import { planTrade, type Stage } from "../chain/trade";
import { href } from "../app/router";

const MIN_QTY = 10n ** 13n; // the desk's smallest order, 0.00001 ETH (BellDesk.MIN_QTY)

type Op = { state: ButtonState; label: string; progress: number; error: Friendly | null; doneLabel: string | null };
const IDLE: Op = { state: "idle", label: "", progress: 0.15, error: null, doneLabel: null };

function trimEth(wei: bigint): string {
  const s = formatUnits(wei, 18);
  const [w, f = ""] = s.split(".");
  const t = f.slice(0, 6).replace(/0+$/, "");
  return t ? `${w}.${t}` : w;
}

export function Trade() {
  const r = useRoundCtx();
  const w = useWallet();
  const { openConnect } = useSheets();
  const announce = useAnnounce();
  const bal = useBalances();
  const ordersCtx = useOrders();
  const mine = { data: ordersCtx.orders, refresh: ordersCtx.refresh };

  const [isBuy, setIsBuy] = useState(true);
  const [chainId, setChainId] = useState<DeskChainId>(84532);
  const [amount, setAmount] = useState("");
  const [prot, setProt] = useState(2); // percent, default Normal 2%
  const [confirm, setConfirm] = useState(false);
  const [op, setOp] = useState<Op>(IDLE);
  const placing = useRef(false);

  const d = DESKS[chainId];
  const qty = parseEthInput(amount);
  const book = r.snap?.book ?? [];
  const openOrders = w.address ? book.filter((o) => o.trader.toLowerCase() === w.address!.toLowerCase()).length : 0;

  const plan = useMemo(
    () => planTrade({
      connected: w.status === "connected" && !!w.address,
      walletChainId: w.chainId,
      chainId,
      isBuy,
      qty,
      minQty: MIN_QTY,
      protectionBps: Math.round(prot * 100),
      refPrice: r.snap?.referencePrice ?? null,
      balances: bal.data ? bal.data[chainId] : null,
      openOrders,
      maxOrders: r.snap?.maxPerWallet ?? 2,
    }),
    [w.status, w.address, w.chainId, chainId, isBuy, qty, prot, r.snap?.referencePrice, r.snap?.maxPerWallet, bal.data, openOrders],
  );

  const sym = isBuy ? "USDC" : "WETH";
  const worstText = plan.limit ? `${isBuy ? "Worst price" : "Worst price"} ${fmtPrice(plan.limit)} USDC` : "";

  // ---- actions: each one reports the real step on the button ----
  const run = async (doneLabel: string, fn: (step: (l: string, p: number) => void) => Promise<void>) => {
    if (placing.current) return;
    placing.current = true;
    setOp({ state: "working", label: "Waiting for your wallet", progress: 0.15, error: null, doneLabel });
    try {
      await fn((label, progress) => setOp((o) => ({ ...o, state: "working", label, progress })));
      setOp({ state: "success", label: doneLabel, progress: 1, error: null, doneLabel });
      announce(doneLabel);
      await Promise.all([bal.refresh(), mine.refresh(), r.refresh()]);
      setTimeout(() => setOp((o) => (o.state === "success" && o.doneLabel === "Order placed" ? o : IDLE)), 1400);
    } catch (e) {
      const f = friendlyWalletError(e);
      setOp({ state: "failure", label: "", progress: 0.15, error: f, doneLabel: null });
      announce(f.text, true);
      setTimeout(() => setOp((o) => (o.state === "failure" ? { ...o, state: "idle" } : o)), 420);
    } finally {
      placing.current = false;
    }
  };

  const doWrap = () => run("Wrapped", (step) => w.write({ chainId, address: d.weth, abi: erc20Abi, functionName: "deposit", value: plan.wrapAmount!, onStep: step }).then(() => {}));
  const doApprove = () => run("Approved", (step) =>
    w.write({ chainId, address: isBuy ? d.usdc : d.weth, abi: erc20Abi, functionName: "approve", args: [d.desk, maxUint256], onStep: step }).then(() => {}));
  const doJoin = () => {
    setConfirm(false);
    if (!qty || !plan.limit) return;
    run("Order placed", (step) => w.write({ chainId, address: d.desk, abi: deskAbi, functionName: "place", args: [isBuy, plan.limit!, qty], onStep: step }).then(() => {}));
  };
  const doSwitch = () => run("Switched", async () => { await w.switchTo(chainId); });

  // ---- the first-time guide ----
  const returning = (mine.data?.length ?? 0) > 0;
  const guideNow = plan.stage === "connect" ? 1 : plan.stage === "join" || plan.stage === "bad-amount" || plan.stage === "too-small" || plan.stage === "too-many" ? 3 : 2;
  const showGuide = !returning && plan.stage !== "no-price";
  const guide = [
    { n: 1, label: "Connect your wallet" },
    { n: 2, label: `Approve ${sym} once` },
    { n: 3, label: "Join the bell" },
  ];
  // Step 3 shows before an amount is typed, so a first-time trader sees the whole path.
  const stepNow = w.status !== "connected" ? 1 : plan.stage === "approve" || plan.stage === "wrap" || plan.stage === "switch" || plan.stage === "no-token" || plan.stage === "no-gas" ? 2 : 3;
  void guideNow;

  // ---- the next bell, always shown as a clock time and a countdown ----
  const bellLine =
    r.snap?.nextBellAt && r.secondsLeft !== null
      ? `Next bell at ${clock(r.snap.nextBellAt)}, in ${countdown(r.secondsLeft)}`
      : "No bell is running. Placing an order starts the next one.";

  // ---- the max chip ----
  const maxWei = (() => {
    const b = bal.data?.[chainId];
    if (!b) return null;
    if (!isBuy) return b.weth;
    const price = plan.limit ?? r.snap?.referencePrice;
    return price ? (b.usdc * 10n ** 18n) / price : null;
  })();

  const staleWarn = r.snap?.priceAgeSeconds !== null && r.snap?.priceAgeSeconds !== undefined && r.snap.priceAgeSeconds > 180;

  // ---- the primary control ----
  let control: React.ReactNode = null;
  let message: React.ReactNode = null;
  const chainLabel = d.key === "base" ? "Base" : "Unichain";
  const working = op.state === "working";
  const showSuccessLink = op.state === "success" && op.doneLabel === "Order placed";

  const stageButton = (stage: Stage): React.ReactNode => {
    switch (stage) {
      case "connect": return <Button label="Connect wallet" glyph={<IconWallet />} onPress={openConnect} />;
      case "switch": return <Button label={`Switch to ${d.name}`} glyph={<ChainMark chain={d.key} size={22} />} state={op.state} progress={op.progress} onPress={doSwitch} />;
      case "wrap": return <Button label={working ? op.label : `Wrap ${fmtEth(plan.wrapAmount!)} ETH`} glyph={<IconPlus />} state={op.state} progress={op.progress} onPress={doWrap} />;
      case "approve": return <Button label={working ? op.label : `Approve ${sym} once`} glyph={<IconKey />} state={op.state} progress={op.progress} onPress={doApprove} />;
      case "join": return (
        <Button
          hold
          label={working ? op.label : op.state === "success" ? "Order placed" : "Hold to join the bell"}
          glyph={<Mark height={24} tone="current" gap={0} />}
          state={op.state}
          progress={op.progress}
          onHoldComplete={doJoin}
          onKeyboardActivate={() => setConfirm(true)}
        />
      );
      default: return null;
    }
  };

  if (showSuccessLink) {
    control = <Button href={href.bell} label="Watch your bell" glyph={<Mark height={24} tone="current" gap={0} />} />;
  } else if (plan.stage === "bad-amount") {
    message = <p className="field-hint">{isBuy ? "Enter how much ETH you want to buy." : "Enter how much ETH you want to sell."}</p>;
  } else if (plan.stage === "too-small") {
    message = <p className="field-error"><IconAlert size={18} /> That order is too small. The smallest is 0.00001 ETH. Raise the amount to place it.</p>;
  } else if (plan.stage === "too-many") {
    message = <p className="field-error"><IconAlert size={18} /> You already have {r.snap?.maxPerWallet ?? 2} open orders. Cancel one, or wait for the bell, to place another.</p>;
  } else if (plan.stage === "no-price") {
    message = <p className="field-error"><IconAlert size={18} /> We can't read the Uniswap price right now. Nothing was sent. We're retrying.</p>;
  } else if (plan.stage === "no-token") {
    const need = plan.need ?? 0n;
    const have = plan.have ?? 0n;
    message = (
      <div className="stack">
        <p className="field-error"><IconAlert size={18} /> {isBuy
          ? `You need ${fmtUsdc(need)} USDC on ${chainLabel} and you have ${fmtUsdc(have)}.`
          : `You need ${fmtEth(need)} ETH on ${chainLabel} and you have ${fmtEth(have)}.`}</p>
        <a className="btn secondary bc bc-btn" href={isBuy ? d.faucetUsdc : d.faucetEth} target="_blank" rel="noopener noreferrer"><span className="label">{isBuy ? "Get test USDC" : "Get test ETH"}</span><IconArrowUpRight size={18} /></a>
      </div>
    );
  } else if (plan.stage === "no-gas") {
    message = (
      <div className="stack">
        <p className="field-error"><IconAlert size={18} /> You need a little {d.name} ETH for gas.</p>
        <a className="btn secondary bc bc-btn" href={d.faucetEth} target="_blank" rel="noopener noreferrer"><span className="label">Get test ETH</span><IconArrowUpRight size={18} /></a>
      </div>
    );
  } else {
    control = stageButton(plan.stage);
  }

  const errorLine = op.error && (
    <p className="field-error" role="alert"><IconAlert size={18} /> <span>{op.error.text} {op.error.next}</span></p>
  );

  const converted = qty && plan.limit
    ? `${fmtUsdc((qty * plan.limit) / 10n ** 18n)} USDC at your worst price`
    : null;

  return (
    <div className="trade-screen">
      <div className="screen-head">
        <span className="where">Trade</span>
        <h1>Place an order</h1>
        <p className="bell-line">{bellLine}</p>
      </div>

      {showGuide && (
        <ol className="guide" aria-label="First-time steps">
          {guide.map((g) => (
            <li key={g.n} className={g.n < stepNow ? "done" : g.n === stepNow ? "now" : "next"} aria-current={g.n === stepNow ? "step" : undefined}>
              <span className="g-dot" aria-hidden="true">{g.n < stepNow ? <IconCheck size={14} /> : g.n}</span>
              <span>{g.n === stepNow ? `Step ${g.n} of 3: ` : ""}{g.label}</span>
            </li>
          ))}
        </ol>
      )}

      <form className="stack-lg trade-form" onSubmit={(e) => e.preventDefault()} noValidate>
        {/* Buy or Sell: native radios drawn as our own two-part switch */}
        <fieldset className="switch">
          <legend className="sr-only">Buy or sell ETH</legend>
          <label><input type="radio" name="side" checked={isBuy} onChange={() => setIsBuy(true)} /><span>Buy ETH</span></label>
          <label><input type="radio" name="side" checked={!isBuy} onChange={() => setIsBuy(false)} /><span>Sell ETH</span></label>
        </fieldset>

        {/* Chain cards: native radios drawn as big cards, with your balance on each chain */}
        <fieldset className="chain-cards">
          <legend>{isBuy ? "You'll pay from" : "You'll sell from"}</legend>
          {DESK_CHAIN_IDS.map((id) => {
            const c = DESKS[id];
            const b = bal.data?.[id];
            const shown = b ? (isBuy ? `${fmtUsdc(b.usdc)} USDC` : `${fmtEth(b.weth)} ETH`) : "Connect to see your balance";
            return (
              <label key={id} className="chain-card bc bc-card" style={{ ["--cut" as string]: "20px" }}>
                <input type="radio" name="chain" checked={chainId === id} onChange={() => setChainId(id)} />
                <span className="chain-card-body">
                  <span className="chain-card-top"><ChainMark chain={c.key} size={20} /><strong>{c.key === "base" ? "Base" : "Unichain"}</strong><span className="tick" aria-hidden="true"><IconCheck size={16} /></span></span>
                  <span className="tnum chain-bal">{shown}</span>
                  <span className="small muted">{isBuy ? "You'll pay from here" : "You'll sell from here"}</span>
                </span>
              </label>
            );
          })}
        </fieldset>

        {/* Amount */}
        <div className="field">
          <label htmlFor="amount" className="field-label">Amount (ETH)</label>
          <div className="amount-row">
            <input id="amount" className="amount-input tnum" type="text" inputMode="decimal" autoComplete="off" placeholder="0.0000"
              value={amount} onChange={(e) => setAmount(e.target.value)} aria-describedby="amount-conv" />
            <button type="button" className="chip-btn" disabled={!maxWei || maxWei <= 0n} onClick={() => maxWei && setAmount(trimEth(maxWei))}>Max</button>
          </div>
          <p id="amount-conv" className="field-hint">{converted ?? (isBuy ? "How much ETH do you want to buy?" : "How much ETH do you want to sell?")}</p>
        </div>

        {/* Protection: a native range, restyled */}
        <div className="field">
          <div className="row between">
            <label htmlFor="prot" className="field-label">Protection <HelpButton topic="protection" /></label>
            <span className="tnum prot-readout"><strong>{prot}%</strong></span>
          </div>
          <input id="prot" className="slider" type="range" min={0.5} max={10} step={0.5} value={prot}
            onChange={(e) => setProt(Number(e.target.value))}
            aria-valuetext={plan.limit ? `${worstText}` : `${prot} percent`} />
          <p className="worst" aria-live="off">{plan.limit ? `${isBuy ? "You pay at most" : "You get at least"} ${fmtPrice(plan.limit)} USDC per ETH` : "Type an amount to see your worst price."}</p>
          <div className="quick" role="group" aria-label="Quick protection picks">
            {[{ l: "Tight", v: 1 }, { l: "Normal", v: 2 }, { l: "Wide", v: 5 }].map((q) => (
              <button key={q.l} type="button" className="chip-btn" aria-pressed={prot === q.v} onClick={() => setProt(q.v)}>{q.l} {q.v}%</button>
            ))}
          </div>
        </div>

        <div className="inset paid-note">
          <p><strong>You'll be paid on whichever chain your match is on.</strong> <HelpButton topic="paid" /></p>
          <p className="small muted">If nobody matches you, the rest is filled by Uniswap on {chainLabel}, inside your worst price. <HelpButton topic="pool" /></p>
        </div>

        {staleWarn && r.snap?.priceAgeSeconds != null && (
          <p className="field-warn" role="note"><IconAlert size={18} /> The Uniswap price is {Math.round(r.snap.priceAgeSeconds / 60)} minutes old. Nobody has traded the pool since, so the bell may be skipped.</p>
        )}

        <div className="stack">
          {control}
          {message}
          {errorLine}
        </div>
      </form>

      {/* Keyboard and screen-reader users confirm in a sheet instead of holding */}
      <Sheet open={confirm} onClose={() => setConfirm(false)} title="Join the next bell?">
        {qty !== null && plan.limit !== null && (
          <div className="stack">
            <p>{isBuy ? "Buy" : "Sell"} <strong className="tnum">{fmtEth(qty)} ETH</strong> on {d.name}.</p>
            <p className="muted">{isBuy ? "You pay at most" : "You get at least"} {fmtPrice(plan.limit)} USDC per ETH.</p>
            <p className="muted">Your money stays in your wallet until the bell. You'll be paid on whichever chain your match is on.</p>
            <Button label="Join the bell" glyph={<Mark height={24} tone="current" gap={0} />} onPress={doJoin} />
          </div>
        )}
      </Sheet>
    </div>
  );
}
