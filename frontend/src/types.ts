export interface Tle {
  name: string;
  norad_id: number;
  line1: string;
  line2: string;
}

export interface Pass {
  satellite: string;
  norad_id: number;
  time: string;
  incidence_deg: number;
  look_side: "left" | "right";
  direction: "ascending" | "descending";
  range_km: number;
  local_time: string;
  sun_elevation_deg?: number;
  cloud_pct?: number | null;
  optical?: "night" | "cloud" | "clear";
}

export interface OpticalProfile {
  start: string;
  hours: number;
  strip: { night: boolean; cloud: number | null }[];
  blind_fraction: number;
  night_fraction: number;
  cloud_mean: number | null;
  cloud_available: boolean;
}

export interface Exposure {
  radius_km: number;
  population: number;
  cities: { name: string; country: string; population: number; km: number }[];
  nearest: { name: string; country: string; population: number; km: number };
}

export type EventType = "earthquake" | "cyclone" | "flood" | "wildfire" | "volcano";

export interface WatchEvent {
  id: string;
  type: EventType;
  title: string;
  lat: number;
  lon: number;
  time: string;
  severity: number;
  severity_label: string;
  detail: string;
  sources: { name: string; url: string | null }[];
  optical: OpticalProfile;
  exposure: Exposure;
  first_look: (Pass & { hours_from_now: number }) | null;
  looks_24h: number;
  looks_72h: number;
  radar_only_looks: number;
  passes: Pass[];
  priority: { value: number; formula: string; terms: { term: string; value: number; source: string }[] };
}

export interface Watch {
  status: "loading" | "ready" | "error";
  updated_at: string | null;
  window_start?: string;
  window_hours?: number;
  feeds: { name: string; ok: boolean; count: number; error: string | null }[];
  kp: { value: number; time: string; level: "quiet" | "active" | "storm" } | null;
  events: WatchEvent[];
}

export interface Order {
  customer: string | null;
  location_name: string | null;
  latitude: number | null;
  longitude: number | null;
  radius_km: number;
  imaging_mode: "spot" | "strip" | "scan";
  cadence: "once" | "recurring";
  revisit_hours: number | null;
  start_date: string | null;
  end_date: string | null;
  priority: "routine" | "priority" | "urgent";
  purpose: string;
  summary: string;
  open_questions: string[];
}

export interface Feasibility {
  verdict: "feasible" | "tight" | "not_feasible";
  reason: string;
  window_start: string;
  window_hours: number;
  opportunities: number;
  satellites_used: number;
  per_day: number;
  first_opportunity: string | null;
  median_gap_hours: number | null;
  max_gap_hours: number | null;
  required_revisit_hours: number | null;
  passes?: Pass[];
  plan?: Pass[];
  assumptions?: { min_incidence_deg: number; max_incidence_deg: number; satellites_considered: number };
  optical?: OpticalProfile;
  exposure?: Exposure;
  conflicts_avoided?: { satellite: string; time: string; booked_by: string }[];
  radar_only?: { night: number; cloud: number; clear: number };
  comparison?: { name: string; satellites: number; opportunities: number; per_day: number; max_gap_hours: number | null }[];
}

export interface Rule {
  id: string;
  level: "info" | "warn" | "block";
  text: string;
}

export type Status = "pending_approval" | "needs_clarification" | "approved" | "synced" | "rejected";

export interface TaskingRequest {
  id: string;
  created_at: string;
  created_by: string;
  created_by_key: string;
  raw_text: string;
  parser: string;
  parser_note: string | null;
  status: Status;
  country: string | null;
  order: Order;
  feasibility: Feasibility | null;
  policy: { required_roles: string[]; rules: Rule[] };
  outstanding_roles: string[];
  approvals: { role: string; actor: string; decision: string; comment: string | null; ts: string }[];
  already_existed?: boolean;
  integrations: { system: string; external_id: string; ts: string; mock: boolean; url: string | null; payload: Record<string, unknown> }[];
}

export interface User {
  key: string;
  name: string;
  role: "sales" | "manager" | "compliance";
  title: string;
}

export interface Meta {
  users: User[];
  ai_parser: boolean;
  agent_available: boolean;
  intel_enabled: boolean;
  llm_model: string;
  satellites: number;
  orbit_data: { source: string; median_epoch: string; age_hours: number };
  status_counts: Record<string, number>;
  restricted_countries: string[];
  access_model: { min_incidence_deg: number; max_incidence_deg: number; horizon_hours: number };
}

export interface AgentCall {
  tool: string;
  input: Record<string, unknown>;
  summary: string;
  error: boolean;
}

export interface AgentAnswer {
  answer: string;
  tool_calls: AgentCall[];
  model: string;
  stopped: string;
}

export interface Draft {
  subject: string;
  body: string;
  facts_used: string[];
  audience: string;
  model: string;
}

export interface AuditEvent {
  id: number;
  ts: string;
  actor: string;
  action: string;
  request_id: string | null;
  payload: Record<string, unknown>;
  hash: string;
  prev_hash: string;
}

export interface Coverage {
  status: "ready" | "computing" | "error";
  error?: string;
  computed_at: string;
  compute_seconds: number;
  horizon_hours: number;
  cell_deg: number;
  rows: number;
  cols: number;
  satellites: number;
  hours: (number | null)[];
  looks: number[];
  stats: {
    median_hours: number;
    p90_hours: number;
    within_1h: number;
    within_3h: number;
    within_6h: number;
    never_share: number;
    mean_looks: number;
    worst: { lat: number; lon: number; hours: number | null };
    by_lat: { lat: number; median_hours: number; max_hours: number; looks: number }[];
  };
}
