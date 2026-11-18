import { createContext, useContext, type ReactNode } from "react";
import { useMyOrders } from "./account";
import type { MyOrder } from "../chain/account";

type Ctx = { orders: MyOrder[] | null; loading: boolean; error: string | null; refresh: () => Promise<void> };
const C = createContext<Ctx | null>(null);

/** One reading of the connected wallet's orders, shared by the dock, Activity, Trade and the receipt. */
export function OrdersProvider({ children }: { children: ReactNode }) {
  const m = useMyOrders();
  return <C.Provider value={{ orders: m.data, loading: m.loading, error: m.error, refresh: m.refresh }}>{children}</C.Provider>;
}

export function useOrders(): Ctx {
  const c = useContext(C);
  if (!c) throw new Error("OrdersProvider is missing");
  return c;
}
