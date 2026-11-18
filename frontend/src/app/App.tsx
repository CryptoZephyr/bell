import { WalletProvider } from "../wallet/wallet";
import { Announcer, Footer, Header, ShellProvider, TabBar } from "./Shell";
import { useRoute } from "./router";
import { RoundProvider } from "./RoundContext";
import { Bell } from "../screens/Bell";

function Screen({ route }: { route: ReturnType<typeof useRoute> }) {
  switch (route.name) {
    case "bell": return <Bell />;
    default: return <div className="screen-head"><h1>Bell</h1><p>Coming next: {route.name}</p></div>;
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
            <div className="app">
              <a className="skip" href="#main">Skip to content</a>
              <Header route={route} />
              <main id="main" tabIndex={-1} className={wide ? "wide" : undefined}>
                <Screen route={route} />
              </main>
              <Footer route={route} />
              <TabBar route={route} />
            </div>
          </RoundProvider>
        </ShellProvider>
      </Announcer>
    </WalletProvider>
  );
}
