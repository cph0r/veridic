// The actual access matrix, from code: per route, who can call it (public,
// signed in, role-restricted), whether a paid-plan check runs on the server, and
// whether the handler limits data to the caller. Compared with an intended
// matrix (CSV) when one is given. Deterministic.

import fs from "node:fs";

const AUTH_GUARD = /auth|authenticated|requireUser|session|signedIn|login/i;
const ROLE_GUARD = /admin|owner|role|platform|staff|superuser|manager/i;
const PLAN_GUARD = /pro\b|Pro[A-Z]|plan|subscri|premium|paid|tier|entitle/i;
const LIMITER = /limit|limiter|throttle/i;
// In the handler: a server-side plan check, a role check, and use of the caller's identity.
const PLAN_CHECK = /getActiveSubscription|hasActivePlan|requirePro|isPro\b|requireSubscription|checkSubscription|requirePlan|assertPlan|entitlement/;
const ROLE_CHECK = /\.role\s*(?:!==|===|!=|==)|hasRole\(|requireRole\(/;
const CALLER = /req\.(?:userId|user\??!?\.id|user!\.id|customer\??\.id|auth\??\.\w+|session\??\.\w*[uU]ser)|\buserId\b|ownerId|restaurantId:\s*req\.|\w+\(\s*req\.user\b/; // identity handed to a helper, e.g. getActiveRestaurantId(req.user!)
const OPEN_BY_DESIGN = /webhook|callback|login|logout|health|oauth|signup|register|token/i;
// Scoped only by values the client supplies (query/body ids, e.g. from a QR code): weaker than caller identity.
const CLIENT_SCOPE = /req\.(?:query|body)\.\w+[\s\S]{0,400}?\beq\([\w.]+\.(?:\w*[iI]d|\w*Token)\b/;
// Reads worth protecting even when public: someone's orders, messages, payments, account data.
const SENSITIVE = /order|message|conversation|payment|user|customer|invoice|account|profile|session|subscription|bill/i;

/** One row per route. */
export function accessMatrix(g, inv) {
  return inv.routes.map((r) => {
    const text = (g.lines(r.file) ?? []).slice(r.start - 1, r.end).join("\n");
    const guards = (r.guards ?? []).map((x) => x.name ?? x).filter((n) => !LIMITER.test(n));
    const roles = guards.filter((n) => ROLE_GUARD.test(n));
    const inlineRole = ROLE_CHECK.test(text);
    const access = roles.length || inlineRole ? "role" : guards.some((n) => AUTH_GUARD.test(n) || PLAN_GUARD.test(n)) ? "auth" : "public";
    const plan = guards.some((n) => PLAN_GUARD.test(n)) || PLAN_CHECK.test(text) ? "pro" : "free";
    const scoped = CALLER.test(text) ? "yes" : CLIENT_SCOPE.test(text) ? "weak" : "no";
    const flags = [];
    const sensitive = r.method !== "GET" || SENSITIVE.test(r.path);
    if (/:\w+/.test(r.path) && scoped !== "yes" && access !== "role" && sensitive && !OPEN_BY_DESIGN.test(r.path))
      flags.push(scoped === "weak" ? "id-param-scoped-by-client-values" : "id-param-without-caller-scope");
    return { route: r.id, at: `${r.file}:${r.start}-${r.end}`, access, roles: roles.length ? roles : inlineRole ? ["(inline check)"] : [], plan, scoped, guards, flags };
  });
}

/** Intended matrix CSV: route pattern ("METHOD /path", * as wildcard), access, plan, scoped; '#' lines are comments. */
export function loadIntended(file) {
  const rows = fs.readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const [head, ...body] = rows;
  const cols = head.split(",").map((c) => c.trim());
  return body.map((line) => {
    const v = Object.fromEntries(line.split(",").map((x, i) => [cols[i], x.trim()]));
    const [method, ...p] = v.route.split(/\s+/);
    const glob = (s) => new RegExp(`^${s.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
    return { ...v, match: (r) => glob(method).test(r.route.split(" ")[0]) && glob(p.join(" ")).test(r.route.split(" ").slice(1).join(" ")) };
  });
}

/** Mismatches between actual and intended: the first intended row that matches a route applies. */
export function compareAccess(matrix, intended) {
  const out = [];
  let checked = 0;
  for (const r of matrix) {
    const want = intended.find((w) => w.match(r));
    if (!want) continue;
    checked++;
    const problems = [];
    const rank = { public: 0, auth: 1, role: 2 };
    if (want.access && want.access !== "*" && rank[r.access] < rank[want.access]) problems.push(`needs ${want.access}, is ${r.access}`);
    if (want.plan === "pro" && r.plan !== "pro") problems.push("needs a paid-plan check on the server; none found");
    if (want.scoped === "yes" && r.scoped !== "yes") problems.push(r.scoped === "weak" ? "needs to limit data to the caller; only client-supplied ids found" : "needs to limit data to the caller; no use of the caller's identity found");
    if (problems.length) out.push({ route: r.route, at: r.at, problems });
  }
  return { checked, mismatches: out };
}

export function accessMarkdown(matrix, comparison) {
  const lines = ["| Route | Access | Plan check | Caller-scoped | Flags |", "|---|---|---|---|---|"];
  for (const r of matrix) lines.push(`| \`${r.route}\` | ${r.access}${r.roles.length ? ` (${r.roles.join(", ")})` : ""} | ${r.plan === "pro" ? "yes" : "—"} | ${r.scoped} | ${r.flags.join(", ")} |`);
  const out = [`## Access matrix (generated from code)`, "", ...lines, ""];
  if (comparison) {
    out.push(`### Against the intended matrix: ${comparison.mismatches.length} of ${comparison.checked} routes don't match`, "");
    for (const m of comparison.mismatches) out.push(`- \`${m.route}\` (\`${m.at}\`): ${m.problems.join("; ")}`);
    out.push("");
  }
  return out.join("\n");
}
