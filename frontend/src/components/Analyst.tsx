import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { AgentAnswer } from "../types";

interface Turn {
  role: "user" | "assistant";
  content: string;
  result?: AgentAnswer;
}

const SUGGESTIONS = [
  "Which three events should we pitch to insurers today, and why?",
  "Which floods can we image before 06:00 UTC tomorrow?",
  "Why is the top event ranked first?",
  "Which orders are waiting for approval, and for whom?",
  "When can we next image Helsinki, and would optical see it?",
];

const TOOL_LABEL: Record<string, string> = {
  list_events: "Watch board",
  get_event: "Event detail",
  find_place: "City lookup",
  passes_for_location: "Pass prediction",
  people_nearby: "Population",
  list_orders: "Orders",
  get_order: "Order detail",
};

export default function Analyst({ available, context, contextLabel }: { available: boolean; context: string | null; contextLabel: string | null }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);

  // Braces matter: newer browsers return a Promise from smooth scrolling, and an effect must
  // return nothing or a cleanup function, or React throws when it runs the "cleanup".
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns, busy]);

  const send = async (text: string) => {
    if (!text.trim() || busy) return;
    const history = turns.map(({ role, content }) => ({ role, content }));
    setTurns((t) => [...t, { role: "user", content: text }]);
    setQ("");
    setBusy(true);
    setError(null);
    try {
      const r = await api.ask(text, history, context);
      setTurns((t) => [...t, { role: "assistant", content: r.answer, result: r }]);
    } catch (e) {
      setError((e as Error).message);
      setTurns((t) => t.slice(0, -1));
      setQ(text);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="analyst">
      <div className="chat">
        {!turns.length && (
          <div className="chat-intro">
            <p className="micro wrap">
              Ask about live events, passes and orders. The analyst answers from the console's own calculations and shows every lookup it made. It can read, never act.
            </p>
            {!available && <p className="note warn">Off: no Anthropic API key is set. Add ANTHROPIC_API_KEY to .env and restart.</p>}
            <ul className="suggest">
              {SUGGESTIONS.map((s) => (
                <li key={s}>
                  <button disabled={!available || busy} onClick={() => send(s)}>
                    {s}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`msg ${t.role}`}>
            {t.role === "assistant" && t.result && t.result.tool_calls.length > 0 && (
              <ol className="trace">
                {t.result.tool_calls.map((c, j) => (
                  <li key={j} className={c.error ? "err" : ""} title={JSON.stringify(c.input)}>
                    <span>{TOOL_LABEL[c.tool] ?? c.tool}</span>
                    {c.summary}
                  </li>
                ))}
              </ol>
            )}
            <p>{t.content}</p>
            {t.role === "assistant" && t.result && <span className="micro">{t.result.model}</span>}
          </div>
        ))}
        {busy && (
          <div className="msg assistant">
            <p className="thinking">Looking it up</p>
          </div>
        )}
        <div ref={end} />
      </div>
      {error && <p className="note warn pad">{error}</p>}
      <div className="ask">
        {contextLabel && <span className="ctx">Context: {contextLabel}</span>}
        <div className="ask-row">
          <input
            value={q}
            disabled={!available}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send(q)}
            placeholder={available ? "Ask the analyst…" : "Analyst off: no API key"}
          />
          <button className="cta" disabled={!available || busy || !q.trim()} onClick={() => send(q)}>
            Ask
          </button>
        </div>
      </div>
    </div>
  );
}
