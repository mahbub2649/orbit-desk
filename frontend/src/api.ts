import type { AgentAnswer, AuditEvent, Coverage, Draft, Meta, TaskingRequest, Tle, Watch } from "./types";

let currentUser = "aino";
export const setApiUser = (key: string) => {
  currentUser = key;
};

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", "X-Demo-User": currentUser, ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (typeof body.detail === "string") message = body.detail;
    } catch {
      /* keep the generic message */
    }
    throw new Error(message);
  }
  return res.json();
}

export const api = {
  meta: () => call<Meta>("/meta"),
  satellites: () => call<{ satellites: Tle[] }>("/satellites"),
  requests: () => call<TaskingRequest[]>("/requests"),
  request: (id: string) => call<TaskingRequest>(`/requests/${id}`),
  create: (text: string) => call<TaskingRequest>("/requests", { method: "POST", body: JSON.stringify({ text }) }),
  watch: () => call<Watch>("/intel/watch"),
  coverage: () => call<Coverage>("/coverage"),
  fromEvent: (id: string) => call<TaskingRequest>(`/requests/from-event/${id}`, { method: "POST" }),
  ask: (question: string, history: { role: "user" | "assistant"; content: string }[], context: string | null) =>
    call<AgentAnswer>("/agent/ask", { method: "POST", body: JSON.stringify({ question, history, context }) }),
  draft: (eventId: string, audience: string) => call<Draft>(`/intel/events/${eventId}/draft`, { method: "POST", body: JSON.stringify({ audience }) }),
  retrySync: (id: string) => call<TaskingRequest>(`/requests/${id}/sync`, { method: "POST" }),
  decide: (id: string, decision: "approve" | "reject", comment: string) =>
    call<TaskingRequest>(`/requests/${id}/decision`, { method: "POST", body: JSON.stringify({ decision, comment: comment || null }) }),
  audit: (id: string) => call<AuditEvent[]>(`/audit?request_id=${id}`),
  verify: () => call<{ ok: boolean; checked: number; broken_at_id: number | null }>("/audit/verify"),
};
