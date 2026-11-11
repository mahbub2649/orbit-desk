import { ago, pct } from "../format";
import type { Coverage } from "../types";

const wait = (h: number) => (h < 1 ? `${Math.round(h * 60)} min` : `${h.toFixed(1)} h`);
const band = (h: number) => (h <= 1.5 ? "quick" : h <= 3.2 ? "mid" : h <= 6 ? "slow" : "worst");
const share = (f: number) => (f > 0 && f < 0.01 ? "<1%" : pct(f));

/** Legend and worldwide numbers for the latency layer on the globe. */
export default function LatencyPanel({ coverage, now }: { coverage: Coverage | null; now: Date }) {
  if (!coverage || coverage.status !== "ready") {
    return (
      <div className="latency plate">
        <span className="micro">Latency map</span>
        <p className="latency-wait">{coverage?.status === "error" ? `Could not compute: ${coverage.error}` : "Propagating every orbit over the whole globe…"}</p>
      </div>
    );
  }
  const s = coverage.stats;
  // North at the top, like the globe.
  const rows = [...s.by_lat].reverse();
  const SCALE = 3; // hours at full bar width; longer waits are clipped and drawn red
  return (
    <div className="latency plate">
      <div className="latency-head">
        <span className="micro">Latency map</span>
        <span className="micro">
          {coverage.satellites} sats · {coverage.horizon_hours} h window · {ago(coverage.computed_at, now)}
        </span>
      </div>
      <div className="latency-body">
        <dl className="latency-nums">
          <div>
            <dt>Typical wait for a radar look, anywhere</dt>
            <dd>{wait(s.median_hours)}</dd>
          </div>
          <div>
            <dt>9 in 10 places</dt>
            <dd>under {wait(s.p90_hours)}</dd>
          </div>
          <div>
            <dt>Reachable in 1 h</dt>
            <dd>{share(s.within_1h)}</dd>
          </div>
          <div>
            <dt>In 3 h</dt>
            <dd>{share(s.within_3h)}</dd>
          </div>
          <div>
            <dt>Out of reach</dt>
            <dd className={s.never_share > 0 ? "hot" : ""}>{share(s.never_share)}</dd>
          </div>
        </dl>
        <div className="latency-lat" title="Typical wait at each latitude, north at the top. Full width = 3 h.">
          {rows.map((r) => (
            <i key={r.lat} className={band(r.median_hours)} style={{ width: `${Math.max(3, Math.min(100, (r.median_hours / SCALE) * 100))}%` }} />
          ))}
          <span className="micro n">90°N</span>
          <span className="micro q">0°</span>
          <span className="micro s">90°S</span>
        </div>
      </div>
      <div className="latency-legend" aria-hidden="true">
        <span className="ramp" />
        <span className="marks micro">
          <b style={{ left: "0%" }}>now</b>
          <b style={{ left: "14.3%" }}>1 h</b>
          <b style={{ left: "42.9%" }}>3 h</b>
          <b style={{ left: "85.7%" }}>6 h</b>
        </span>
        <span className="micro hatch-key">
          <i /> no look in {coverage.horizon_hours} h
        </span>
      </div>
      <p className="micro wrap">Hover the globe for any point. Geometry only: every satellite is treated as working and free.</p>
    </div>
  );
}
