import { HELP } from "../ui/Help";

export function HelpScreen() {
  return (
    <div className="stack-lg">
      <div className="screen-head"><span className="where">Learn</span><h1>Help</h1><p>Short answers, in plain words.</p></div>
      <div className="stack">
        {HELP.map((t) => (
          <details key={t.id} className="inset help-item" id={t.id}>
            <summary>{t.title}</summary>
            {t.body.map((p) => <p key={p} className="muted">{p}</p>)}
          </details>
        ))}
      </div>
    </div>
  );
}
