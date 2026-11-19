import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/screens.css";
import { App } from "./app/App";

// On the Rounds page the chains are read at once, in parallel with the screen's own code loading.
if (/^#\/rounds\/?$/.test(window.location.hash)) import("./chain/rounds").then((m) => m.warmScan()).catch(() => {});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
