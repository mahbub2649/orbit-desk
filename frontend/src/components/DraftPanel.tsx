import { useState } from "react";
import { api } from "../api";
import type { Draft } from "../types";

const AUDIENCES = [
  ["insurer", "Insurer"],
  ["government", "Civil protection"],
  ["humanitarian", "Humanitarian"],
  ["maritime", "Maritime"],
] as const;

export default function DraftPanel({ eventId, available }: { eventId: string; available: boolean }) {
  const [audience, setAudience] = useState<string>("insurer");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const make = async () => {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      setDraft(await api.draft(eventId, audience));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="draft">
      <div className="filters flush">
        {AUDIENCES.map(([k, label]) => (
          <button key={k} className={audience === k ? "on" : ""} onClick={() => setAudience(k)}>
            {label}
          </button>
        ))}
        <button className="cta ghost push" disabled={!available || busy} onClick={make}>
          {busy ? "Writing…" : draft ? "Rewrite" : "Draft email"}
        </button>
      </div>
      {!available && <p className="note">Needs an Anthropic API key in .env.</p>}
      {error && <p className="note warn">{error}</p>}
      {draft && (
        <div className="draft-body">
          <p className="micro">Subject</p>
          <p className="subject">{draft.subject}</p>
          <pre>{draft.body}</pre>
          <div className="row">
            <span className="micro wrap">Draft only. Nothing is sent. Check every figure before using it.</span>
            <button
              className="cta ghost"
              onClick={() => navigator.clipboard.writeText(`Subject: ${draft.subject}\n\n${draft.body}`).then(() => setCopied(true))}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
