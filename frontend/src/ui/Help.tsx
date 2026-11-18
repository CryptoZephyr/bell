// Plain two-line explanations for the terms that might confuse people, and the "?" button that opens them in a sheet.
// The Help screen uses the same topics, so the words never drift apart.
import { useState } from "react";
import { Sheet } from "./Sheet";
import { IconHelp } from "./Icons";

export type HelpTopic = { id: string; title: string; short: string; body: string[] };

export const HELP: HelpTopic[] = [
  {
    id: "bell",
    title: "What is the bell?",
    short: "A moment every couple of minutes when waiting orders meet.",
    body: [
      "Orders gather in one list, from Base and from Unichain. About every two minutes the bell rings, and everyone who can trade at that moment does, at the same Uniswap price.",
      "Your money stays in your wallet until the bell. Nothing is locked in the meantime.",
    ],
  },
  {
    id: "paid",
    title: "Why am I paid on the other chain?",
    short: "Your match may be on the other chain. That is the point.",
    body: [
      "Bell pairs people across chains, so a buyer on Base can meet a seller on Unichain with no bridge in between. Each side is paid on the chain where their match was.",
      "Before you place an order, Bell tells you this. You'll be paid on whichever chain your match is on.",
    ],
  },
  {
    id: "protection",
    title: "What does protection mean?",
    short: "The worst price you are willing to accept.",
    body: [
      "Protection sets your worst price, a little away from the Uniswap price. At 2%, a buyer pays at most 2% more and a seller gets at most 2% less.",
      "If the price at the bell is worse than your limit, your order waits for the next bell. It never trades outside your limit.",
    ],
  },
  {
    id: "pool",
    title: "What if nobody matches me?",
    short: "The rest goes into the Uniswap pool, inside your limit.",
    body: [
      "Whatever isn't paired with another trader is swapped in the real Uniswap pool on your own chain. The swap stops at your worst price. If the pool can't fill all of it inside your limit, the unused part comes back to you.",
      "So an order is either matched, filled by the pool inside your limit, or returned.",
    ],
  },
  {
    id: "faucet",
    title: "How do I get test funds?",
    short: "Test ETH for gas and test USDC from a faucet.",
    body: [
      "Bell runs on test networks, so you use free test funds. You need a little test ETH on each chain for gas, and test USDC if you want to buy.",
      "The Trade screen links to a faucet whenever you are short of something.",
    ],
  },
];

export function HelpButton({ topic, label }: { topic: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const t = HELP.find((h) => h.id === topic);
  if (!t) return null;
  return (
    <>
      <button type="button" className="help-btn" onClick={() => setOpen(true)} aria-label={label ?? `What does this mean: ${t.title}`}>
        <IconHelp size={18} />
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title={t.title}>
        {t.body.map((p) => <p key={p}>{p}</p>)}
      </Sheet>
    </>
  );
}
