const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

export function utc(iso: string | Date, withDay = true): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return `${withDay ? DAY[d.getUTCDay()] + " " : ""}${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

export function hm(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function clock(d: Date): string {
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

export function dateLine(d: Date): string {
  return `${DAY[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH[d.getUTCMonth()]} ${d.getUTCFullYear()}`.toUpperCase();
}

export function dayLabel(d: Date): string {
  return `${DAY[d.getUTCDay()]} ${d.getUTCDate()}`;
}

/** Signed countdown such as T-01:24:10 (before) or T+00:03:02 (after). */
export function countdown(target: string | Date, now: Date): string {
  const t = (typeof target === "string" ? new Date(target) : target).getTime();
  let s = Math.round((t - now.getTime()) / 1000);
  const sign = s >= 0 ? "-" : "+";
  s = Math.abs(s);
  return `T${sign}${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

export function ago(iso: string, now: Date): string {
  const h = (now.getTime() - new Date(iso).getTime()) / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min ago`;
  if (h < 48) return `${Math.round(h)} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function hours(h: number | null | undefined): string {
  if (h == null) return "–";
  if (h >= 48) return `${(h / 24).toFixed(1)} d`;
  return `${h} h`;
}

export function cadence(h: number | null): string {
  if (h == null) return "Once";
  if (h === 24) return "Daily";
  if (h === 168) return "Weekly";
  if (h % 24 === 0) return `Every ${h / 24} days`;
  return `Every ${h} h`;
}

export function people(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

export const pct = (f: number) => `${Math.round(f * 100)}%`;

export const STATUS_LABEL: Record<string, string> = {
  pending_approval: "Awaiting approval",
  needs_clarification: "Needs clarification",
  approved: "Approved",
  synced: "Approved and sent",
  rejected: "Rejected",
};

export const ROLE_LABEL: Record<string, string> = { manager: "sales manager", compliance: "compliance officer", sales: "account executive" };
export const VERDICT_LABEL: Record<string, string> = { feasible: "Feasible", tight: "Tight", not_feasible: "Not feasible" };
export const TYPE_CODE: Record<string, string> = { earthquake: "EQ", cyclone: "TC", flood: "FL", wildfire: "WF", volcano: "VO" };
export const TYPE_LABEL: Record<string, string> = { earthquake: "Earthquake", cyclone: "Cyclone", flood: "Flood", wildfire: "Wildfire", volcano: "Volcano" };
