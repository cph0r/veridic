// Running the conformance checks against a running app: each request as the user it names
// (owner, other, or signed out), its answer compared with the spec. Users' headers and the
// records checks need come from the app's own seed script (.veridic.json "conform.seed").

const LOCAL = /^(?:localhost|127\.0\.0\.1|\[::1\]|::1|[\w.-]+\.(?:test|localhost))$/;

/** Null when the checks may run against `url`; else why not. Never a remote host unless allowed. */
export function checkUrl(url, { allowRemote = false } = {}) {
  let u;
  try { u = new URL(url); } catch { return `not a URL: ${url}`; }
  if (allowRemote || LOCAL.test(u.hostname)) return null;
  return `${u.hostname} isn't local (localhost, 127.0.0.1, ::1, *.test, *.localhost); pass --allow-remote to run against it`;
}

/** An example's body as written ({ title: "Hi" }) to JSON, without evaluating anything. */
function toJson(body) {
  if (body == null) return undefined;
  try { return JSON.stringify(JSON.parse(body)); } catch {}
  const quoted = String(body)
    .replace(/'([^']*)'/g, (m, s) => JSON.stringify(s))
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
    .replace(/,\s*([}\]])/g, "$1");
  try { return JSON.stringify(JSON.parse(quoted)); } catch { return undefined; }
}
const literal = (s) => { try { return JSON.parse(String(s).replace(/^'([^']*)'$/, '"$1"')); } catch { return String(s); } };
const at = (obj, dotted) => String(dotted).split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

async function one(step, { url, users, seeds }) {
  const missing = (step.request.path.match(/:(\w+)/g) ?? []).map((p) => p.slice(1)).filter((p) => seeds[p] == null);
  if (missing.length) return { notRun: `no seed for ${missing.join(", ")}` };
  const path = step.request.path.replace(/:(\w+)/g, (m, k) => encodeURIComponent(seeds[k]));
  const as = step.request.as ?? "owner";
  if (as !== "anon" && !users[as]) return { notRun: `no "${as}" user from the seed` };
  const body = toJson(step.request.body);
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
    for (const [k, v] of Object.entries(step.expect.fields)) { gotFields[k] = at(json, k); if (JSON.stringify(gotFields[k]) !== JSON.stringify(literal(v))) fieldsOk = false; }
  }
  return statusOk && fieldsOk ? { pass: true } : { pass: false, got: statusOk ? gotFields : res.status };
}

/**
 * Run the checks. `users`: { owner: { headers }, other: { headers } }; `seeds`: { param: value }.
 * -> { checks, passed, failed: [{ id, rule, got }], not_run: [{ id, why }], fidelity_pct }
 */
export async function runChecks(checks, { url, users = {}, seeds = {} }) {
  const out = { checks: checks.length, passed: 0, failed: [], not_run: [] };
  for (const c of checks) {
    const steps = c.steps ?? [c];
    let result = { pass: true };
    for (const st of steps) {
      result = await one(st, { url, users, seeds });
      if (!result.pass) break;
    }
    if (result.notRun) out.not_run.push({ id: c.id, why: result.notRun });
    else if (result.pass) out.passed++;
    else out.failed.push({ id: c.id, rule: c.rule, got: result.got });
  }
  const ran = out.passed + out.failed.length;
  out.fidelity_pct = ran ? Math.round((out.passed / ran) * 1000) / 10 : null;
  return out;
}
