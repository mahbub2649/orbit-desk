import { useState } from "react";
import { countdown, hm } from "../format";

export interface TimelineItem {
  key: string;
  time: string;
  label: string;
  sub: string;
  kind: "order" | "event";
  onSelect: () => void;
}

const HOURS = 24;

/** The next 24 hours on one line: planned collections for orders, first looks for watched events. */
export default function Timeline({ items, now }: { items: TimelineItem[]; now: Date }) {
  const [hover, setHover] = useState<TimelineItem | null>(null);
  const t0 = now.getTime();
  const span = HOURS * 3_600_000;
  const upcoming = items.filter((i) => new Date(i.time).getTime() >= t0 && new Date(i.time).getTime() <= t0 + span).sort((a, b) => a.time.localeCompare(b.time));
  const next = upcoming[0];
  const left = (iso: string) => `${((new Date(iso).getTime() - t0) / span) * 100}%`;

  const hoursMarks: { at: number; label: string }[] = [];
  const h = new Date(t0);
  h.setUTCMinutes(0, 0, 0);
  for (let t = h.getTime() + 3_600_000; t < t0 + span; t += 3_600_000) {
    const d = new Date(t);
    if (d.getUTCHours() % 3 === 0) hoursMarks.push({ at: t, label: hm(d) });
  }

  return (
    <div className="timeline">
      <div className="tl-next">
        <span className="micro">Next collection</span>
        {next ? (
          <>
            <strong className="tl-count">{countdown(next.time, now)}</strong>
            <span className="tl-what">{next.label}</span>
          </>
        ) : (
          <strong className="tl-count dim">No passes in 24 h</strong>
        )}
      </div>
      <div className="tl-track">
        <div className="tl-rail" />
        {hoursMarks.map((m) => (
          <span key={m.at} className="tl-hour" style={{ left: `${((m.at - t0) / span) * 100}%` }}>
            {m.label}
          </span>
        ))}
        <span className="tl-now">NOW</span>
        {upcoming.map((i) => (
          <button
            key={i.key}
            className={`tl-mark ${i.kind} ${i === next ? "next" : ""}`}
            style={{ left: left(i.time) }}
            onClick={i.onSelect}
            onPointerEnter={() => setHover(i)}
            onPointerLeave={() => setHover(null)}
            aria-label={`${i.label}, ${hm(i.time)} UTC`}
          />
        ))}
        {hover && (
          <div className="tip" style={{ left: left(hover.time), bottom: 30, transform: "translateX(-50%)" }}>
            <strong>{hover.label}</strong>
            <span>
              {hm(hover.time)} UTC · {hover.sub}
            </span>
            <span>{hover.kind === "order" ? "Planned collection" : "First possible look"}</span>
          </div>
        )}
      </div>
      <div className="tl-legend">
        <span>
          <i className="order" /> Order
        </span>
        <span>
          <i className="event" /> Event first look
        </span>
      </div>
    </div>
  );
}
