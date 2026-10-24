// Running the conformance checks against a running app: each request as the user it names
// (owner, other, or signed out), its answer compared with the spec. Users' headers and the
// records checks need come from the app's own seed script (.veridic.json "conform.seed").

import { literalJson as toJson } from "../literal.mjs";

const LOCAL = /^(?:localhost|127\.0\.0\.1|\[::1\]|::1|[\w.-]+\.(?:test|localhost))$/;

/** Null when the checks may run against `url`; else why not. Never a remote host unless allowed. */
export function checkUrl(url, { allowRemote = false } = {}) {
  let u;
  try { u = new URL(url); } catch { return `not a URL: ${url}`; }
  if (allowRemote || LOCAL.test(u.hostname)) return null;
  return `${u.hostname} isn't local (localhost, 127.0.0.1, ::1, *.test, *.localhost); pass --allow-remote to run against it`;
}

const literal = (s) => { try { return JSON.parse(String(s).replace(/^'([^']*)'$/, '"$1"')); } catch { return String(s); } };
const at = (obj, dotted) => String(dotted).split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

// In a path, a body or an expected value: {{unique}} is fresh for every request (so a journey can
// create a record a check already made), {{name}} is the seed's value.
let counter = 0;
const RUN = Date.now().toString(36);
// `json`: the value lands inside a quoted string, so it's escaped (a seed value holding a quote).
function fill(s, seeds, unique, { json = false } = {}) {
  if (s == null) return s;
  const esc = (v) => (json ? JSON.stringify(String(v)).slice(1, -1) : String(v));
  return String(s).replace(/\{\{(\w+)\}\}/g, (m, k) => (k === "unique" ? unique : seeds[k] != null ? esc(seeds[k]) : m));
}

async function one(step, { url, users, seeds }) {
  const unique = `${RUN}${(++counter).toString(36)}`;
  const named = [...`${step.request.path} ${step.request.body ?? ""} ${JSON.stringify(step.expect.fields ?? {})}`.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).filter((k) => k !== "unique" && seeds[k] == null);
  if (named.length) return { notRun: `no seed for ${[...new Set(named)].join(", ")}` };
  const missing = (step.request.path.match(/:(\w+)/g) ?? []).map((p) => p.slice(1)).filter((p) => seeds[p] == null);
  if (missing.length) return { notRun: `no seed for ${missing.join(", ")}` };
  const path = step.request.path.replace(/:(\w+)/g, (m, k) => encodeURIComponent(seeds[k])).replace(/\{\{(\w+)\}\}/g, (m) => encodeURIComponent(fill(m, seeds, unique)));
  // A path from the spec stays on the app: one leading slash, no backslash, same origin, so a
  // row can't carry a user's headers to another host.
  if (!/^\/(?![\/\\])/.test(path) || path.includes("\\") || new URL(path, url).origin !== new URL(url).origin) return { notRun: `path ${JSON.stringify(step.request.path)} isn't on the app (it must start with a single /)` };
  const as = step.request.as ?? "owner";
  if (as !== "anon" && !users[as]) return { notRun: `no "${as}" user from the seed` };
  const body = toJson(fill(step.request.body, seeds, unique, { json: true }));
  if (step.request.body != null && body === undefined) return { notRun: `the body isn't literal JSON: ${step.request.body}` };
  const headers = { ...(as === "anon" ? {} : users[as].headers ?? {}), ...(body ? { "content-type": "application/json" } : {}) };
  let res;
  try { res = await fetch(new URL(path, url), { method: step.request.method, headers, body, redirect: "manual" }); } catch (e) { return { notRun: `request failed: ${e.message}` }; }
  const want = step.expect.status;
  const statusOk = want === "denied" ? res.status === 403 || res.status === 404 : res.status === want;
  let fieldsOk = true, gotFields = null;
  if (statusOk && step.expect.fields) {
    let json = null;
    try { json = await res.json(); } catch {}
    gotFields = {};
    for (const [k, v] of Object.entries(step.expect.fields)) { gotFields[k] = at(json, k); if (JSON.stringify(gotFields[k]) !== JSON.stringify(literal(fill(v, seeds, unique, { json: true })))) fieldsOk = false; }
  }
  return statusOk && fieldsOk ? { pass: true, ...(want === "denied" ? { denied: res.status } : {}) } : { pass: false, got: statusOk ? gotFields : res.status };
}

/**
 * Run the checks. `users`: { owner: { headers }, other: { headers } }; `seeds`: { param: value }.
 * -> { checks, passed, failed: [{ id, rule, got }], not_run: [{ id, why }], denied: [{ id, got: 403|404 }], fidelity_pct }
 */
export async function runChecks(checks, { url, users = {}, seeds = {} }) {
  const out = { checks: checks.length, passed: 0, failed: [], not_run: [], denied: [] };
  for (const c of checks) {
    const steps = c.steps ?? [c];
    let result = { pass: true };
    const denied = [];
    for (const st of steps) {
      result = await one(st, { url, users, seeds });
      if (!result.pass) break;
      if (result.denied) denied.push(result.denied);
    }
    // Which refusal came back (403 or 404), so two implementations can be told apart.
    if (result.pass && denied.length) out.denied.push({ id: c.id, got: denied.length === 1 ? denied[0] : denied });
    if (result.notRun) out.not_run.push({ id: c.id, why: result.notRun });
    else if (result.pass) out.passed++;
    else out.failed.push({ id: c.id, rule: c.rule, got: result.got });
  }
  const ran = out.passed + out.failed.length;
  out.fidelity_pct = ran ? Math.round((out.passed / ran) * 1000) / 10 : null;
  return out;
}
