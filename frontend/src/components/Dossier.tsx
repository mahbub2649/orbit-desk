import { useEffect, useState } from "react";
import { api } from "../api";
import { ago, cadence, countdown, hours, pct, people, ROLE_LABEL, STATUS_LABEL, TYPE_CODE, TYPE_LABEL, utc, VERDICT_LABEL } from "../format";
import type { AuditEvent, Pass, TaskingRequest, User, WatchEvent } from "../types";
import { Bar, Count, Scramble, Stat } from "../ui";
import DraftPanel from "./DraftPanel";
import Strip from "./Strip";

function PassTable({ passes, limit = 8 }: { passes: Pass[]; limit?: number }) {
  const [all, setAll] = useState(false);
  if (!passes.length) return <p className="empty">No opportunities in this window.</p>;
  const rows = all ? passes : passes.slice(0, limit);
  return (
    <>
      <table className="grid-table">
        <thead>
          <tr>
            <th>Time (UTC)</th>
            <th>Satellite</th>
            <th className="num">Angle</th>
            <th>Look</th>
            <th>Optical</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.time + p.norad_id}>
              <td>{utc(p.time).replace(" UTC", "")}</td>
              <td>{p.satellite}</td>
              <td className="num">{p.incidence_deg.toFixed(1)}°</td>
              <td>{p.look_side}</td>
              <td className={p.optical === "clear" ? "" : "hot"}>{p.optical === "night" ? "blind: night" : p.optical === "cloud" ? `blind: cloud ${p.cloud_pct}%` : p.optical ? "could see" : "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {passes.length > limit && (
        <button className="link" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${passes.length}`}
        </button>
      )}
    </>
  );
}

export function EventDossier({ event: e, now, busy, onCreate, accessNow, aiAvailable }: { event: WatchEvent; now: Date; busy: boolean; onCreate: () => void; accessNow: string[]; aiAvailable: boolean }) {
  const f = e.first_look;
  return (
    <div className="dossier" key={e.id}>
      <header className="dossier-head">
        <div className="tags">
          <span className="tag type">{TYPE_CODE[e.type]}</span>
          <span className="tag">{TYPE_LABEL[e.type]}</span>
          <span className="tag hot">{e.severity_label}</span>
          <span className="tag dim">{ago(e.time, now)}</span>
        </div>
        <h2>
          <Scramble text={e.title} />
        </h2>
        <p className="meta">
          {e.lat.toFixed(2)}°, {e.lon.toFixed(2)}° · reported by{" "}
          {e.sources.map((s, i) => (
            <span key={s.name}>
              {i > 0 && ", "}
              {s.url ? (
                <a href={s.url} target="_blank" rel="noreferrer">
                  {s.name}
                </a>
              ) : (
                s.name
              )}
            </span>
          ))}
          {e.detail && ` · ${e.detail}`}
          {` · ${e.exposure.nearest.km} km from ${e.exposure.nearest.name}, ${e.exposure.nearest.country}`}
        </p>
      </header>

      <div className="scroll">
        <div className="hero">
          <div className="hero-main">
            <span className="micro">Time to first radar look</span>
            {accessNow.length > 0 ? (
              <strong className="big ok">IN ACCESS NOW</strong>
            ) : f ? (
              <strong className="big">{countdown(f.time, now)}</strong>
            ) : (
              <strong className="big dim">No pass in 72 h</strong>
            )}
            <span className="hero-sub">{accessNow.length > 0 ? accessNow.join(", ") : f ? `${f.satellite} · ${utc(f.time)} · ${f.incidence_deg}° looking ${f.look_side}` : "With the current access model"}</span>
          </div>
          <div className="hero-score">
            <span className="micro">Priority</span>
            <strong>
              <Count value={e.priority.value} />
            </strong>
          </div>
        </div>

        <div className="stats">
          <Stat label="Looks in 24 h">
            <Count value={e.looks_24h} />
          </Stat>
          <Stat label="Optical blind" tone="hot">
            <Count value={e.optical.blind_fraction * 100} suffix="%" />
          </Stat>
          <Stat label="Mean cloud">{e.optical.cloud_mean != null ? `${e.optical.cloud_mean}%` : "n/a"}</Stat>
          <Stat label="People in 100 km">{people(e.exposure.population)}</Stat>
        </div>

        <h3>Who can see it, and when</h3>
        <Strip optical={e.optical} passes={e.passes} />
        <p className="note">
          {e.radar_only_looks} of the {e.looks_72h} radar looks in 72 hours fall at night or under heavy cloud, when optical satellites see nothing. Cloud: NOAA GFS forecast, looked up locally.
        </p>
        {e.exposure.cities.length > 0 && (
          <p className="note">
            Largest cities within 100 km: {e.exposure.cities.map((c) => `${c.name} (${people(c.population)})`).join(", ")}.
          </p>
        )}

        <h3>Why it ranks here</h3>
        <table className="calc">
          <thead>
            <tr>
              <th>Term · source</th>
              <th className="num">Value</th>
            </tr>
          </thead>
          <tbody>
            {e.priority.terms.map((t) => (
              <tr key={t.term}>
                <td>
                  <strong>{t.term}</strong>
                  <span>{t.source}</span>
                </td>
                <td className="num">
                  <Bar value={t.value} tone="dim" />
                  {t.value.toFixed(2)}
                </td>
              </tr>
            ))}
            <tr className="total">
              <td>
                <strong>Priority</strong>
                <span>{e.priority.formula}</span>
              </td>
              <td className="num">{e.priority.value}</td>
            </tr>
          </tbody>
        </table>

        <h3>Next radar looks</h3>
        <PassTable passes={e.passes} limit={6} />

        <h3>Outreach draft</h3>
        <DraftPanel key={e.id} eventId={e.id} available={aiAvailable} />
      </div>

      <footer className="action-bar">
        <span className="micro">Turn this event into an order for approval</span>
        <a className="cta ghost" href={`/api/intel/events/${e.id}/brief`} download>
          Brief
        </a>
        <button className="cta" onClick={onCreate} disabled={busy}>
          {busy ? "Planning…" : "Create tasking order"}
        </button>
      </footer>
    </div>
  );
}

type Tab = "brief" | "passes" | "audit";

export function OrderDossier({ request: r, user, now, accessNow, onChanged, onError }: { request: TaskingRequest; user: User; now: Date; accessNow: string[]; onChanged: (r: TaskingRequest) => void; onError: (m: string) => void }) {
  const [tab, setTab] = useState<Tab>("brief");
  const o = r.order;
  const f = r.feasibility;
  const nextPlanned = f?.plan?.find((p) => new Date(p.time).getTime() > now.getTime());
  const blindLooks = f?.radar_only ? f.radar_only.night + f.radar_only.cloud : null;
  const maxPerDay = Math.max(1, ...(f?.comparison ?? []).map((c) => c.per_day));

  return (
    <div className="dossier" key={r.id}>
      <header className="dossier-head">
        <div className="tags">
          <span className="tag type">ORD</span>
          <span className={`tag s-${r.status}`}>{STATUS_LABEL[r.status]}</span>
          {f && <span className={`tag v-${f.verdict}`}>{VERDICT_LABEL[f.verdict]}</span>}
          <span className="tag dim">#{r.id.slice(0, 6)}</span>
          <a className="tag link-tag" href={`/api/requests/${r.id}/brief`} download>
            Download brief
          </a>
        </div>
        <h2>
          <Scramble text={o.location_name ?? "Location unclear"} />
        </h2>
        <p className="meta">{o.summary}</p>
      </header>
      <nav className="tabs">
        {(["brief", "passes", "audit"] as Tab[]).map((t, i) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            <span className="idx">0{i + 1}</span>
            {{ brief: "Brief", passes: "Passes", audit: "Audit trail" }[t]}
          </button>
        ))}
      </nav>

      <div className="scroll">
        {tab === "brief" && (
          <>
            {f && (
              <div className="hero">
                <div className="hero-main">
                  <span className="micro">Next planned collection</span>
                  {accessNow.length > 0 ? <strong className="big ok">IN ACCESS NOW</strong> : nextPlanned ? <strong className="big">{countdown(nextPlanned.time, now)}</strong> : <strong className="big dim">None planned</strong>}
                  <span className="hero-sub">{accessNow.length > 0 ? accessNow.join(", ") : nextPlanned ? `${nextPlanned.satellite} · ${utc(nextPlanned.time)}` : f.reason}</span>
                </div>
              </div>
            )}
            <blockquote>{r.raw_text}</blockquote>
            {r.parser_note && <p className="note warn">{r.parser_note}</p>}
            <dl className="kv">
              <dt>Customer</dt>
              <dd>{o.customer ?? "Not stated"}</dd>
              <dt>Area</dt>
              <dd>
                {o.latitude != null ? `${o.latitude.toFixed(3)}°, ${o.longitude!.toFixed(3)}°` : "Unknown"}
                {r.country ? ` · ${r.country}` : o.latitude != null ? " · open sea" : ""} · {o.radius_km} km radius
              </dd>
              <dt>Imaging</dt>
              <dd>
                {o.imaging_mode} mode · {cadence(o.revisit_hours)} · {o.priority} priority
              </dd>
              <dt>Period</dt>
              <dd>{o.start_date || o.end_date ? `${o.start_date ?? "now"} to ${o.end_date ?? "open"}` : "Not stated"}</dd>
              {f?.exposure && (
                <>
                  <dt>Nearby</dt>
                  <dd>
                    {people(f.exposure.population)} people in cities within 100 km · {f.exposure.nearest.km} km from {f.exposure.nearest.name}
                  </dd>
                </>
              )}
              <dt>Read by</dt>
              <dd>{r.parser}</dd>
            </dl>

            {o.open_questions.length > 0 && (
              <>
                <h3>To confirm</h3>
                <ul className="bullets">
                  {o.open_questions.map((q) => (
                    <li key={q}>{q}</li>
                  ))}
                </ul>
              </>
            )}

            {f && (
              <>
                <h3>Can we deliver it?</h3>
                <p className="note">{f.reason}</p>
                {f.conflicts_avoided && f.conflicts_avoided.length > 0 && (
                  <p className="note warn">
                    {f.conflicts_avoided.length} planned collection{f.conflicts_avoided.length > 1 ? "s were" : " was"} moved to another pass, because {f.conflicts_avoided[0].satellite} was already booked by the order for{" "}
                    {f.conflicts_avoided[0].booked_by}.
                  </p>
                )}
                <div className="stats">
                  <Stat label="Looks in 7 days">
                    <Count value={f.opportunities} />
                  </Stat>
                  <Stat label="Typical gap">{hours(f.median_gap_hours)}</Stat>
                  <Stat label="Longest gap">{hours(f.max_gap_hours)}</Stat>
                  <Stat label="Radar-only looks" tone="hot">
                    {blindLooks != null && f.opportunities ? <Count value={(blindLooks / f.opportunities) * 100} suffix="%" /> : "n/a"}
                  </Stat>
                </div>
              </>
            )}

            {f?.comparison && f.comparison.length > 0 && (
              <>
                <h3>Revisit by radar constellation</h3>
                <table className="calc">
                  <thead>
                    <tr>
                      <th>Constellation · satellites</th>
                      <th className="num">Looks per day</th>
                    </tr>
                  </thead>
                  <tbody>
                    {f.comparison.map((c, i) => (
                      <tr key={c.name} className={i === 0 ? "total" : ""}>
                        <td>
                          <strong>{c.name}</strong>
                          <span>
                            {c.satellites} satellites · longest gap {hours(c.max_gap_hours)}
                          </span>
                        </td>
                        <td className="num">
                          <Bar value={c.per_day / maxPerDay} tone={i === 0 ? "hot" : "dim"} />
                          {c.per_day.toFixed(1)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="note">Same simplified access model and public orbit data for every row. It shows geometry only, not real capacity.</p>
              </>
            )}

            <h3>Approval rules</h3>
            <ul className="rules">
              {r.policy.rules.map((rule) => (
                <li key={rule.id} className={`lvl-${rule.level}`}>
                  <span className="idx">{rule.id}</span>
                  {rule.text}
                </li>
              ))}
            </ul>

            <h3>Approvals</h3>
            <ul className="approvals">
              {r.policy.required_roles.map((role) => {
                const done = r.approvals.find((a) => a.role === role);
                return (
                  <li key={role} className={done ? done.decision : "waiting"}>
                    <i />
                    <span>
                      <strong>{ROLE_LABEL[role].replace(/^./, (c) => c.toUpperCase())}</strong>
                      {done ? ` · ${done.decision === "approve" ? "approved" : "rejected"} by ${done.actor}, ${utc(done.ts, false)}` : " · waiting"}
                      {done?.comment && <em> “{done.comment}”</em>}
                    </span>
                  </li>
                );
              })}
            </ul>

            {r.status === "approved" && (
              <p className="note warn">
                Approved, but a write to another system failed. Check the audit trail for the error.{" "}
                <button className="link" onClick={() => api.retrySync(r.id).then(onChanged).catch((e) => onError((e as Error).message))}>
                  Retry now
                </button>
              </p>
            )}
            {r.integrations.length > 0 && (
              <>
                <h3>Created in other systems</h3>
                <ul className="integrations">
                  {r.integrations.map((i) => (
                    <li key={i.external_id}>
                      <strong>{i.system === "salesforce" ? "Salesforce deal" : "Jira ticket"}</strong>
                      {i.url ? (
                        <a href={i.url} target="_blank" rel="noreferrer">
                          <code>{i.external_id}</code>
                        </a>
                      ) : (
                        <code>{i.external_id}</code>
                      )}
                      <span className={`tag ${i.mock ? "dim" : "s-synced"}`}>{i.mock ? "simulated" : "live"}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}

        {tab === "passes" &&
          (f ? (
            <>
              {f.optical && (
                <>
                  <h3>Who can see it, and when</h3>
                  <Strip optical={f.optical} passes={f.passes ?? []} plan={f.plan} />
                </>
              )}
              <h3>Planned collections</h3>
              <PassTable passes={f.plan ?? []} limit={10} />
              <h3>All opportunities</h3>
              <PassTable passes={f.passes ?? []} limit={8} />
              <p className="note">
                Simplified model: a look is counted when a satellite passes with an incidence angle between {f.assumptions?.min_incidence_deg}° and {f.assumptions?.max_incidence_deg}°. All{" "}
                {f.assumptions?.satellites_considered} catalogued satellites are treated as available.
              </p>
            </>
          ) : (
            <p className="empty">No location yet, so passes cannot be calculated.</p>
          ))}

        {tab === "audit" && <Audit requestId={r.id} version={r.approvals.length + r.integrations.length} />}
      </div>

      <Decide request={r} user={user} onChanged={onChanged} onError={onError} />
    </div>
  );
}

function Decide({ request: r, user, onChanged, onError }: { request: TaskingRequest; user: User; onChanged: (r: TaskingRequest) => void; onError: (m: string) => void }) {
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  if (r.status !== "pending_approval") return null;
  const canAct = r.outstanding_roles.includes(user.role) && r.created_by_key !== user.key;
  const act = async (decision: "approve" | "reject") => {
    setBusy(true);
    try {
      onChanged(await api.decide(r.id, decision, comment));
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <footer className="action-bar">
      {canAct ? (
        <>
          <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Reason for this decision (optional)" />
          <button className="cta ok" disabled={busy} onClick={() => act("approve")}>
            Approve
          </button>
          <button className="cta bad" disabled={busy} onClick={() => act("reject")}>
            Reject
          </button>
        </>
      ) : (
        <>
          <span className="micro wrap">
            Waiting for the {r.outstanding_roles.map((x) => ROLE_LABEL[x]).join(" and the ")}. You are {user.name.split(" ")[0]} ({user.title.toLowerCase()}).
          </span>
          <button className="cta ghost" disabled={busy} onClick={() => act("approve")} title="Tries anyway, to show the server refusing and logging it">
            Try anyway
          </button>
        </>
      )}
    </footer>
  );
}

function Audit({ requestId, version }: { requestId: string; version: number }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [check, setCheck] = useState<{ ok: boolean; checked: number; broken_at_id: number | null } | null>(null);
  useEffect(() => {
    api.audit(requestId).then(setEvents).catch(() => setEvents([]));
    setCheck(null);
  }, [requestId, version]);
  return (
    <>
      <div className="row">
        <p className="note">Each entry stores a fingerprint of the entry before it, so an edited or deleted entry is detected.</p>
        <button className="cta ghost" onClick={() => api.verify().then(setCheck)}>
          Verify log
        </button>
      </div>
      {check && <p className={`verify ${check.ok ? "ok" : "bad"}`}>{check.ok ? `Log intact: all ${check.checked} entries verified.` : `Log has been altered at entry ${check.broken_at_id}.`}</p>}
      <ol className="audit">
        {events.map((e, i) => (
          <li key={e.id} style={{ animationDelay: `${i * 35}ms` }}>
            <div>
              <strong>{e.action}</strong>
              <span>{utc(e.ts, false)}</span>
            </div>
            <p>
              {e.actor}
              {typeof e.payload.reason === "string" && ` · ${e.payload.reason}`}
              {typeof e.payload.external_id === "string" && ` · ${e.payload.external_id}`}
              {typeof e.payload.verdict === "string" && ` · ${e.payload.verdict}`}
            </p>
            <code title={e.hash}>
              {e.prev_hash.slice(0, 8)} → {e.hash.slice(0, 8)}
            </code>
          </li>
        ))}
      </ol>
    </>
  );
}

export function Sitrep({ events, orders, pctBlind }: { events: WatchEvent[]; orders: TaskingRequest[]; pctBlind: number | null }) {
  const firsts = events.map((e) => e.first_look?.hours_from_now).filter((h): h is number => h != null).sort((a, b) => a - b);
  const median = firsts.length ? firsts[Math.floor(firsts.length / 2)] : null;
  const top = events.slice(0, 3);
  return (
    <div className="dossier">
      <header className="dossier-head">
        <div className="tags">
          <span className="tag type">SIT</span>
          <span className="tag dim">Situation report</span>
        </div>
        <h2>Where radar matters now</h2>
        <p className="meta">Live events from public feeds, scored by severity, freshness and how blind optical satellites are over each one.</p>
      </header>
      <div className="scroll">
        <div className="stats">
          <Stat label="Events tracked">
            <Count value={events.length} />
          </Stat>
          <Stat label="Median first look">{median != null ? <Count value={median} decimals={1} suffix=" h" /> : "–"}</Stat>
          <Stat label="Optical blind, avg" tone="hot">
            {pctBlind != null ? <Count value={pctBlind * 100} suffix="%" /> : "–"}
          </Stat>
          <Stat label="Orders open">
            <Count value={orders.filter((o) => o.status === "pending_approval").length} />
          </Stat>
        </div>
        <h3>Top of the board</h3>
        <ul className="rules">
          {top.map((e, i) => (
            <li key={e.id}>
              <span className="idx">0{i + 1}</span>
              {e.title} · first look in {e.first_look ? `${e.first_look.hours_from_now} h` : "more than 72 h"} · optical blind {pct(e.optical.blind_fraction)}
            </li>
          ))}
          {!top.length && <li>Waiting for the event feeds.</li>}
        </ul>
        <h3>How to use this console</h3>
        <ol className="bullets">
          <li>Pick an event on the watch board, or click a red marker on the globe.</li>
          <li>Read how soon a radar satellite can image it and how blind optical is.</li>
          <li>Create a tasking order. Fixed rules decide who must approve it.</li>
          <li>Or write a customer request by hand under Intake.</li>
        </ol>
      </div>
    </div>
  );
}
