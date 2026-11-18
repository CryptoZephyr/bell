// The order dock (section 5): a small Ink card above the tab bar whenever the wallet has an order open. It says where the
// order is and when the next bell rings, and links to Activity.
import { useOrders } from "../app/OrdersContext";
import { useRoundCtx } from "../app/RoundContext";
import { Mark } from "./Mark";
import { clock, countdown, fmtEth } from "../chain/format";
import { href, type Route } from "../app/router";

export function Dock({ route }: { route: Route }) {
  const { orders } = useOrders();
  const r = useRoundCtx();
  const open = (orders ?? []).filter((o) => o.outcome === "open");
  if (open.length === 0 || route.name === "activity" || route.name === "landing" || route.name === "states") return null;
  const o = open[0];
  const where = o.step >= 2 ? "Settling now" : o.step === 1 ? "In the book" : "Placed, waiting to be heard";
  const when = r.snap?.nextBellAt && r.secondsLeft !== null ? `Bell at ${clock(r.snap.nextBellAt)}, in ${countdown(r.secondsLeft)}` : "Next bell not set yet";
  const title = open.length > 1 ? `${open.length} open orders` : `${o.isBuy ? "Buy" : "Sell"} ${fmtEth(o.qty)} ETH`;
  return (
    <a className="dock bc bc-card" href={href.activity} aria-label={`${title}. ${where}. ${when}. Open Activity.`}>
      <Mark height={28} tone="fog" />
      <span className="dock-body">
        <span className="dock-title">{title}</span>
        <span className="dock-sub">{where} · {when}</span>
      </span>
    </a>
  );
}
