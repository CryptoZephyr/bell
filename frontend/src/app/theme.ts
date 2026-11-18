import { useCallback, useEffect, useState } from "react";

export type ThemePref = "system" | "light" | "dark";
const KEY = "bell-theme";

function resolve(pref: ThemePref): "light" | "dark" {
  if (pref === "system") return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  return pref;
}

/** The theme is applied before the first frame by the script in index.html. This keeps it in step afterwards. */
export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(() => (document.documentElement.getAttribute("data-theme-pref") as ThemePref) || "system");

  const apply = useCallback((p: ThemePref) => {
    const r = document.documentElement;
    r.setAttribute("data-theme-pref", p);
    r.setAttribute("data-theme", resolve(p));
  }, []);

  const choose = useCallback((p: ThemePref) => {
    setPref(p);
    try { localStorage.setItem(KEY, p); } catch { /* a private window cannot remember, the choice still applies */ }
    apply(p);
  }, [apply]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => { if (pref === "system") apply("system"); };
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [pref, apply]);

  return { pref, choose };
}
