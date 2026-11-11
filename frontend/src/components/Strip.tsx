import { useState } from "react";
import { dayLabel, utc } from "../format";
import type { OpticalProfile, Pass } from "../types";

// Mark colours, checked for colour-blind separation and contrast on black.
const RADAR_ONLY = "#d9621e";
const ALSO_OPTICAL = "#3b7fc9";

const W = 400;
const LANE = { sun: 14, cloud: 34, pass: 58 };
const H = 96;
const LEFT = 44;

/**
 * When can anyone see this place?
 * Top lane: night. Middle lane: cloud cover. Bottom lane: radar passes.
 * A pass is drawn tall and orange when optical satellites would be blind at that moment.
 */
export default function Strip({ optical, passes, plan }: { optical: OpticalProfile; passes: Pass[]; plan?: Pass[] }) {
  const [hover, setHover] = useState<{ p: Pass; x: number } | null>(null);
  const t0 = new Date(optical.start).getTime();
  const span = optical.hours * 3_600_000;
  const x = (t: number) => LEFT + ((t - t0) / span) * (W - LEFT - 4);
  const hw = (W - LEFT - 4) / optical.hours;
  const planned = new Set((plan ?? []).map((p) => p.time + p.norad_id));
  const inside = passes.filter((p) => {
    const t = new Date(p.time).getTime();
    return t >= t0 && t <= t0 + span;
  });

  const days: Date[] = [];
  const first = new Date(t0);
  first.setUTCHours(24, 0, 0, 0);
  for (let t = first.getTime(); t < t0 + span; t += 86_400_000) days.push(new Date(t));

  return (
    <figure className="strip">
      <div className="strip-box">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Night, cloud cover and radar passes over time">
          <text x="0" y={LANE.sun + 9} className="lane">NIGHT</text>
          <text x="0" y={LANE.cloud + 9} className="lane">CLOUD</text>
          <text x="0" y={LANE.pass + 12} className="lane">PASSES</text>
          {optical.strip.map((h, i) => (
            <g key={i}>
              {h.night && <rect x={LEFT + i * hw} y={LANE.sun} width={hw + 0.3} height={12} className="night" />}
              {h.cloud != null && <rect x={LEFT + i * hw} y={LANE.cloud} width={hw + 0.3} height={12} className="cloud" opacity={(h.cloud / 100) * 0.9} />}
            </g>
          ))}
          <rect x={LEFT} y={LANE.sun} width={W - LEFT - 4} height={12} className="frame" />
          <rect x={LEFT} y={LANE.cloud} width={W - LEFT - 4} height={12} className="frame" />
          {!optical.cloud_available && (
            <text x={LEFT + 6} y={LANE.cloud + 9} className="lane">
              forecast unavailable
            </text>
          )}
          <line x1={LEFT} x2={W - 4} y1={LANE.pass + 20} y2={LANE.pass + 20} className="axis" />
          {days.map((d) => (
            <g key={d.getTime()}>
              <line x1={x(d.getTime())} x2={x(d.getTime())} y1={LANE.sun} y2={LANE.pass + 23} className="grid" />
              <text x={x(d.getTime()) + 3} y={H - 4} className="tickl">
                {dayLabel(d)}
              </text>
            </g>
          ))}
          {inside.map((p) => {
            const blind = p.optical !== "clear";
            const px = x(new Date(p.time).getTime());
            const isPlan = planned.has(p.time + p.norad_id);
            return (
              <g key={p.time + p.norad_id} onPointerEnter={() => setHover({ p, x: px })} onPointerLeave={() => setHover(null)}>
                <rect x={px - 4} y={LANE.pass - 2} width={8} height={24} fill="transparent" />
                <rect x={px - 1} y={blind ? LANE.pass : LANE.pass + 10} width={2} height={blind ? 20 : 10} rx={1} fill={blind ? RADAR_ONLY : ALSO_OPTICAL} />
                {isPlan && <circle cx={px} cy={LANE.pass - 4} r={2.6} className="plan-dot" />}
              </g>
            );
          })}
        </svg>
        {hover && (
          <div className="tip" style={{ left: `${(hover.x / W) * 100}%`, top: 0, transform: `translate(${hover.x > W * 0.6 ? "-104%" : "4%"}, -30%)` }}>
            <strong>{hover.p.satellite}</strong>
            <span>{utc(hover.p.time)}</span>
            <span>
              {hover.p.incidence_deg}° incidence, looking {hover.p.look_side}
            </span>
            <span>
              {hover.p.optical === "night" ? "Night: optical blind" : hover.p.optical === "cloud" ? `Cloud ${hover.p.cloud_pct}%: optical blind` : "Clear daylight: optical could see too"}
            </span>
          </div>
        )}
      </div>
      <figcaption className="legend">
        <span>
          <i className="tall" style={{ background: RADAR_ONLY }} /> Radar only (optical blind)
        </span>
        <span>
          <i className="short" style={{ background: ALSO_OPTICAL }} /> Optical could see too
        </span>
        {plan && (
          <span>
            <i className="dot" /> Planned
          </span>
        )}
      </figcaption>
    </figure>
  );
}
