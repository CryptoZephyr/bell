import { WalletProvider } from "../wallet/wallet";
import { Announcer, Footer, Header, ShellProvider, TabBar } from "./Shell";
import { useRoute } from "./router";
import { RoundProvider } from "./RoundContext";
import { lazy, Suspense } from "react";
import { OrdersProvider } from "./OrdersContext";
import { Dock } from "../ui/Dock";



// Each screen is its own chunk, so the first paint only loads the shell. viem lives in the chain chunk.
const Bell = lazy(() => import("../screens/Bell").then((m) => ({ default: m.Bell })));
const Trade = lazy(() => import("../screens/Trade").then((m) => ({ default: m.Trade })));
const Activity = lazy(() => import("../screens/Activity").then((m) => ({ default: m.Activity })));
const Receipt = lazy(() => import("../screens/Receipt").then((m) => ({ default: m.Receipt })));
const Landing = lazy(() => import("../screens/Landing").then((m) => ({ default: m.Landing })));
const Contracts = lazy(() => import("../screens/Contracts").then((m) => ({ default: m.Contracts })));
const HelpScreen = lazy(() => import("../screens/HelpScreen").then((m) => ({ default: m.HelpScreen })));
const States = lazy(() => import("../screens/States").then((m) => ({ default: m.States })));

function Screen({ route }: { route: ReturnType<typeof useRoute> }) {
  switch (route.name) {
    case "landing": return <Landing />;
    case "bell": return <Bell />;
    case "trade": return <Trade />;
    case "activity": return <Activity />;
    case "receipt": return <Receipt chainId={route.chainId} orderId={route.orderId} />;
    case "contracts": return <Contracts />;
    case "help": return <HelpScreen />;
    case "states": return <States />;
  }
}

export function App() {
  const route = useRoute();
  const wide = route.name === "bell" || route.name === "landing" || route.name === "contracts" || route.name === "states";
  return (
    <WalletProvider>
      <Announcer>
        <ShellProvider>
          <RoundProvider>
            <OrdersProvider>
            <div className="app">
              <a className="skip" href="#main">Skip to content</a>
              <Header route={route} />
              <main id="main" tabIndex={-1} className={wide ? "wide" : undefined}>
                <Suspense fallback={<div className="skeleton" style={{ height: 240 }} aria-busy="true" />}>
                  <Screen route={route} />
                </Suspense>
              </main>
              <Footer route={route} />
              <Dock route={route} />
              <TabBar route={route} />
            </div>
            </OrdersProvider>
          </RoundProvider>
        </ShellProvider>
      </Announcer>
    </WalletProvider>
  );
}
