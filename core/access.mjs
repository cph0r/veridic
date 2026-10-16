// The actual access matrix, from code: per route, who can call it (public,
// signed in, role-restricted), whether a paid-plan check runs on the server, and
// whether the handler limits data to the caller. Compared with an intended
// matrix (CSV) when one is given. Deterministic.

import fs from "node:fs";
import { handlerText } from "./reach.mjs";
import { codeOnly } from "./tests.mjs";
import { closeParen, splitArgs } from "./chains.mjs";

const handlerNames = new WeakMap();
// The route call's middleware arguments (all but the path and the last, the handler),
// as written: `protect`, `admin`, `auth("manageUsers")`. A name defined in the file as a
// list or call (`const articleAuth = [requiresLogin, hasAuthorization]`) brings its definition.
function middlewareOf(g, r) {
  let args;
  if (r.handlerText) {
    const code = codeOnly(`(${r.handlerText})`);
    args = splitArgs(code, `(${r.handlerText})`, 1, code.length - 1);
  } else {
    const src = (g.lines(r.file) ?? []).slice(r.start - 1, r.end).join("\n");
    const code = codeOnly(src);
    const m = code.match(/\.\s*(?:get|post|put|patch|delete|all|head|options)\s*\(/);
    if (!m) return [];
    const open = m.index + m[0].length;
    args = splitArgs(code, src, open, closeParen(code, open));
  }
  if (args.length && /^["'`]/.test(args[0].raw)) args = args.slice(1);
  const file = g.text(r.file) ?? "";
  // The handler is the last argument: `userController.createUser` -> createUser.
  const last = args.at(-1)?.raw ?? "";
  handlerNames.set(r, new Set([...last.matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0])));
  return args.slice(0, -1).map((a) => {
    const def = /^[\w$]+$/.test(a.raw) && file.match(new RegExp(`\\b(?:const|let|var)\\s+${a.raw}\\s*=\\s*([\\[\\w$][^;\\n]*)`))?.[1];
    return def ? `${a.raw} ${def}` : a.raw;
  });
}

const AUTH_GUARD = /auth|authenticated|requireUser|session|signedIn|login|protect|jwt|verifyToken|passport|ensureLoggedIn|requiresLogin|loggedIn/i;
const ROLE_GUARD = /admin|role|platform|staff|superuser|manage|authori[sz]e|permission|\bcan[A-Z]|restrict|\bis(?!Authori[sz]ed|Authenticated|Logged)[A-Z]\w*\s*\(/;
// Middleware that checks the caller owns the resource: the route is scoped even if the handler isn't.
// Also middleware that injects the caller's own id into the request (`appendUserId()`).
const OWNER_GUARD = /owner|hasAuthorization|isOwner|ownership|belongsTo|canEdit|canModify|(?:append|attach|inject)\w*User/i;
// Parameters that name a code, not a record someone owns: `:continueCode`, `:token`, `:provider`.
const CODE_PARAM = /code|token|coupon|key|slug|provider|lang|locale|page|hash|secret/i;
const PLAN_GUARD = /pro\b|Pro[A-Z]|plan|subscri|premium|paid|tier|entitle/i;
const LIMITER = /limit|limiter|throttle/i;
// In the handler: a server-side plan check, a role check, and use of the caller's identity.
const PLAN_CHECK = /getActiveSubscription|hasActivePlan|requirePro|isPro\b|requireSubscription|checkSubscription|requirePlan|assertPlan|entitlement/;
const ROLE_CHECK = /\.role\s*(?:!==|===|!=|==)|hasRole\(|requireRole\(/;
const CALLER = /req\.(?:userId|user\??!?\.id|user!\.id|customer\??\.id|auth\??\.\w+|session\??\.\w*[uU]ser)|\buserId\b|ownerId|restaurantId:\s*req\.|\w+\(\s*req\.user\b/; // identity handed to a helper, e.g. getActiveRestaurantId(req.user!)
// In handler code reached from the route, only the request's own identity counts as scoping:
// a function that merely mentions `userId` doesn't limit anything to the caller.
const CALLER_IN_HANDLER = /req\.(?:userId|user\b|customer\??\.id|auth\??\.\w+|session\??\.\w*[uU]ser)|\w+\(\s*req\.user\b/;
const OPEN_BY_DESIGN = /webhook|callback|login|logout|health|oauth|signup|register|token/i;
// Scoped only by values the client supplies (query/body ids, e.g. from a QR code): weaker than caller identity.
const CLIENT_SCOPE = /req\.(?:query|body)\.\w+[\s\S]{0,400}?\beq\([\w.]+\.(?:\w*[iI]d|\w*Token)\b/;
// Reads worth protecting even when public: someone's orders, messages, payments, account data.
const SENSITIVE = /order|message|conversation|payment|user|customer|invoice|account|profile|session|subscription|bill/i;

/** One row per route. */
export function accessMatrix(g, inv) {
  return inv.routes.map((r) => {
    const text = (g.lines(r.file) ?? []).slice(r.start - 1, r.end).join("\n");
    const guards = [...new Set([...(r.guards ?? []).map((x) => x.name ?? x), ...middlewareOf(g, r)])].filter((n) => !LIMITER.test(n));
    const roles = guards.filter((n) => ROLE_GUARD.test(n));
    const inlineRole = ROLE_CHECK.test(text);
    const roleGuarded = guards.some((n) => ROLE_GUARD.test(n) && !OWNER_GUARD.test(n.split(" ")[0]));
    const access = roles.length || inlineRole || roleGuarded ? "role" : guards.some((n) => AUTH_GUARD.test(n) || PLAN_GUARD.test(n)) ? "auth" : "public";
    const plan = guards.some((n) => PLAN_GUARD.test(n)) || PLAN_CHECK.test(text) ? "pro" : "free";
    // Scoping lives in the handler, which may be in a controller module: read what the route names.
    // Only the handler's own code: middleware that sets req.user doesn't scope the data.
    const body = handlerText(g, r, handlerNames.get(r) ?? null);
    // Without sign-in anywhere on the route, req.user can't be the caller (it's whatever was loaded).
    const identity = access !== "public" && CALLER_IN_HANDLER.test(body);
    const scoped = CALLER.test(text) || identity || guards.some((n) => OWNER_GUARD.test(n)) ? "yes" : CLIENT_SCOPE.test(text) || CLIENT_SCOPE.test(body) ? "weak" : "no";
    const flags = [];
    const sensitive = r.method !== "GET" || SENSITIVE.test(r.path);
    const params = [...r.path.matchAll(/:(\w+)/g)].map((m) => m[1]);
    if (params.length && !params.every((p) => CODE_PARAM.test(p)) && scoped !== "yes" && access !== "role" && sensitive && !OPEN_BY_DESIGN.test(r.path))
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
