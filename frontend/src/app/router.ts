import { useEffect, useState } from "react";

// A tiny hash router. Tabs are plain links with aria-current, because they change screens.
export type Route =
  | { name: "landing" }
  | { name: "bell" }
  | { name: "trade" }
  | { name: "activity" }
  | { name: "rounds" }
  | { name: "round"; block: string }
  | { name: "receipt"; chainId: number; orderId: number }
  | { name: "contracts" }
  | { name: "help" }
  | { name: "states" };

export function parse(hash: string): Route {
  const h = hash.replace(/^#\/?/, "");
  const [a, b, c] = h.split("/");
  switch (a) {
    case "bell": return { name: "bell" };
    case "trade": return { name: "trade" };
    case "activity": return { name: "activity" };
    case "rounds": return { name: "rounds" };
    case "round": return /^\d+$/.test(b ?? "") ? { name: "round", block: b } : { name: "rounds" };
    case "receipt": return { name: "receipt", chainId: Number(b), orderId: Number(c) };
    case "contracts": return { name: "contracts" };
    case "help": return { name: "help" };
    // The States gallery uses sample numbers, so it exists only in development builds (audit M5).
    case "states": return import.meta.env.DEV ? { name: "states" } : { name: "landing" };
    default: return { name: "landing" };
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash));
  useEffect(() => {
    const on = () => { setRoute(parse(window.location.hash)); window.scrollTo(0, 0); };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export const href = {
  landing: "#/", bell: "#/bell", trade: "#/trade", activity: "#/activity", rounds: "#/rounds", contracts: "#/contracts", help: "#/help",
  receipt: (chainId: number, orderId: number) => `#/receipt/${chainId}/${orderId}`,
  round: (block: bigint | string) => `#/round/${block}`,
};
