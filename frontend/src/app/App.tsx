import { WalletProvider } from "../wallet/wallet";
import { Announcer, Footer, Header, ShellProvider, TabBar } from "./Shell";
import { useRoute } from "./router";
import { RoundProvider } from "./RoundContext";
import { OrdersProvider } from "./OrdersContext";
import { Dock } from "../ui/Dock";
import { Bell } from "../screens/Bell";
import { Trade } from "../screens/Trade";
import { Activity } from "../screens/Activity";
import { Receipt } from "../screens/Receipt";
import { Landing } from "../screens/Landing";
import { Contracts } from "../screens/Contracts";
import { HelpScreen } from "../screens/HelpScreen";
import { States } from "../screens/States";

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
                <Screen route={route} />
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
