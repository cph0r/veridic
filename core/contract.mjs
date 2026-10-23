// OpenAPI <-> implementation drift. Loads the OpenAPI document, scans each route
// handler for the status codes it returns and the request-body fields it reads,
// and reports the differences. Ported and extended from recover/extract.mjs
// section 4 (operation drift) and section 2 (response scan).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseYaml } from "./yaml.mjs";
import { codeOnly, cache } from "./graph.mjs";
import { joinPath, normRoute } from "./routes.mjs";
import { functionSpan } from "./frameworks/paths.mjs";
import { idiomsOf } from "./frameworks/index.mjs";

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];
const AUTH_GUARD = /auth|admin|owner|require|session|verify|login|perm|role|token|csrf/i;
const GUARD_KIND = { 401: AUTH_GUARD, 403: AUTH_GUARD, 429: /limit|throttl|rate/i, 413: /limit|size|body/i };

/** Repo-relative path of the OpenAPI document, or null. */
export function findOpenapi(repo) {
  let files = [];
  try {
    files = execFileSync("git", ["ls-files", "*openapi*.yaml", "*openapi*.yml", "*openapi*.json", "*swagger*.yaml", "*swagger*.json"], { cwd: repo, encoding: "utf8" })
      .split("\n")
      .filter((f) => f && !f.includes("node_modules"));
  } catch {
    return null;
  }
  return files.sort((a, b) => a.split("/").length - b.split("/").length || a.length - b.length)[0] ?? null;
}

/** { file, base, ops: [{ id, method, path, line, operationId, responses, request }] } */
export function loadContract(repo, file) {
  const text = fs.readFileSync(path.join(repo, file), "utf8");
  const doc = file.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
  return contractFromDoc(doc, text, file);
}

export function contractFromDoc(doc, text = "", file = "openapi") {
  const base = (doc.servers?.[0]?.url ?? doc.basePath ?? "").replace(/^https?:\/\/[^/]+/, "");
  const lines = text.split("\n");
  const lineOf = (p, method) => {
    const pi = lines.findIndex((l) => new RegExp(`^\\s*["']?${escapeRe(p)}["']?\\s*:`).test(l));
    if (pi < 0) return null;
    const mi = lines.findIndex((l, i) => i > pi && new RegExp(`^\\s*["']?${method}["']?\\s*:`).test(l));
    return mi < 0 ? pi + 1 : mi + 1;
  };
  const resolve = (s, seen = 0) => {
    if (!s || seen > 8) return s;
    if (s.$ref) return resolve(s.$ref.replace(/^#\//, "").split("/").reduce((o, k) => o?.[k], doc), seen + 1);
    if (s.allOf) return { type: "object", properties: Object.assign({}, ...s.allOf.map((x) => resolve(x, seen + 1)?.properties ?? {})) };
    return s;
  };
  const ops = [];
  for (const [p, item] of Object.entries(doc.paths ?? {})) {
    for (const method of METHODS) {
      const op = item?.[method];
      if (!op) continue;
      const bodySchema = op.requestBody?.content?.["application/json"]?.schema;
      const body = resolve(bodySchema);
      ops.push({
        id: `${method.toUpperCase()} ${joinPath(base, p)}`,
        method: method.toUpperCase(),
        path: joinPath(base, p),
        line: lineOf(p, method),
        at: `${file}:${lineOf(p, method) ?? 1}`,
        operationId: op.operationId ?? null,
        responses: Object.keys(op.responses ?? {}).filter((c) => /^\d{3}$/.test(c)).map(Number),
        request: bodySchema
          ? { ref: bodySchema.$ref?.split("/").pop() ?? null, fields: body?.properties ? Object.keys(body.properties) : null, open: !body?.properties || body.additionalProperties === true }
          : null,
      });
    }
  }
  return { file, base, ops };
}

/** Status codes and request-body reads in a route handler. */
export function handlerFacts(g, route) {
  const code = codeOnlyLines(g, route.file).slice(route.start - 1, route.end);
  const statuses = [];
  const fields = [];
  let validatedBy = null;
  const aliases = new Set();
  const id = idiomsOf(route);
  code.forEach((l, i) => {
    const line = route.start + i;
    for (const re of id.status) for (const m of l.matchAll(re)) statuses.push({ status: Number(m[1]), line });
    if (id.implicit.test(l)) statuses.push({ status: 200, line, implicit: true });
    for (const [re, status, implicit] of id.fixed) if (re.test(l)) { statuses.push({ status, line, ...(implicit ? { implicit: true } : {}) }); if (implicit) break; }

    const v = l.match(/(\w+)(?:\.\w+\(\))?\.(?:safeParse|parse|validate)\(\s*req\.body\b/);
    if (v) validatedBy = v[1];
    const alias = l.match(id.bodyAlias);
    // `const body = req.body as {...}` aliases the body; `const x = (req.body as T).field` does not.
    if (alias && !/req\.body(?:\s+as[^)]*)?\s*\)?\s*\??\.\w/.test(l)) aliases.add(alias[1]);
  });
  const sources = ["req\\.body", ...aliases];
  code.forEach((l, i) => {
    const line = route.start + i;
    for (const src of sources) {
      for (const m of l.matchAll(new RegExp(`(?:\\b${src}|\\(\\s*${src}\\s+as[^)]*\\))\\??\\.(\\w+)`, "g"))) fields.push({ field: m[1], line });
      const d = l.match(new RegExp(`\\{([^}]*)\\}\\s*(?::[^=]+)?=\\s*\\(?\\s*${src}\\b`));
      if (d) for (const f of d[1].split(",").map((s) => s.trim().split(/[\s:=]/)[0]).filter((s) => /^\w+$/.test(s))) fields.push({ field: f, line });
    }
  });
  // Fields some frameworks read without a body object: destructured from a parsed body, or a form's get("x").
  const raw = (g.lines(route.file) ?? []).slice(route.start - 1, route.end);
  for (const re of id.bodyFields ?? [])
    raw.forEach((l, i) => {
      for (const m of re.global ? l.matchAll(re) : [l.match(re)].filter(Boolean))
        for (const f of m[1].split(",").map((s) => s.trim().split(/[\s:=]/)[0]).filter((s) => /^[\w-]+$/.test(s))) fields.push({ field: f, line: route.start + i });
    });
  return { statuses, fields: dedupeBy(fields, (f) => f.field), validated_by: validatedBy };
}

/**
 * @param contract loadContract() result
 * @param routes   routeInventory().routes, optionally filtered to a scope
 * @param opts     { scoped: boolean } when routes is a subset, documented ops
 *                 outside it are not reported as unimplemented
 */
export function drift(g, contract, routes, opts = {}) {
  const byNorm = new Map(routes.map((r) => [normRoute(r.id), r]));
  const opsByNorm = new Map(contract.ops.map((o) => [normRoute(o.id), o]));
  const inScope = opts.scoped ? contract.ops.filter((o) => opts.scopeIds?.has(normRoute(o.id))) : contract.ops;

  const documented_not_implemented = inScope.filter((o) => !byNorm.has(normRoute(o.id))).map((o) => ({ id: o.id, contract_at: o.at }));
  const implemented_not_documented = routes.filter((r) => !opsByNorm.has(normRoute(r.id))).map((r) => ({ id: r.id, at: `${r.file}:${r.start}` }));

  const operations = [];
  let clean = 0;
  for (const r of routes) {
    const op = opsByNorm.get(normRoute(r.id));
    if (!op) continue;
    const facts = handlerFacts(g, r);
    const returned = new Map();
    for (const s of facts.statuses) if (!returned.has(s.status)) returned.set(s.status, s);
    // Statuses sent or thrown by what the handler calls, and by its guards: they explain a
    // documented status, but a status the contract leaves out is only reported from the
    // handler's own lines (a guard's 401 applies to every route behind it).
    const reached = new Set(calledStatuses(g, r).map((s) => s.status));
    const documented = new Set(op.responses);

    // A documented 2xx satisfies an implicit res.json(); report implicit 200 only
    // when the contract documents no success code at all.
    const hasDocSuccess = op.responses.some((c) => c >= 200 && c < 300);
    const undocumented = [...returned.values()]
      .filter((s) => !documented.has(s.status) && !(s.implicit && hasDocSuccess))
      .map(({ status, line, implicit }) => ({ status, at: `${r.file}:${line}`, ...(implicit ? { implicit: true } : {}) }));
    const guards = r.guards?.length ? r.guards.map((x) => x.name ?? x) : [];
    const unreturned = op.responses
      .filter((c) => !returned.has(c) && !reached.has(c) && !(c >= 200 && c < 300 && [...returned.values()].some((s) => s.implicit)))
      .map((c) => {
        // A documented code the handler never returns may come from a guard
        // mounted above it, but only from a guard of the matching kind.
        const from = c >= 500 ? ["error handler"] : guards.filter((n) => (GUARD_KIND[c] ?? /$^/).test(n));
        return { status: c, ...(from.length ? { maybe_from: from } : {}) };
      });

    // Direct req.body reads are checked even when a validator runs: a field read
    // past the validator is exactly the kind the schema does not declare.
    let undeclared = [];
    if (op.request?.fields && !op.request.open) {
      const declared = new Set(op.request.fields);
      undeclared = facts.fields.filter((f) => !declared.has(f.field)).map((f) => ({ field: f.field, at: `${r.file}:${f.line}` }));
    } else if (!op.request && facts.fields.length) {
      undeclared = facts.fields.map((f) => ({ field: f.field, at: `${r.file}:${f.line}`, note: "operation declares no request body" }));
    }

    if (!undocumented.length && !unreturned.length && !undeclared.length) {
      clean++;
      continue;
    }
    operations.push({
      id: r.id,
      at: `${r.file}:${r.start}-${r.end}`,
      contract_at: op.at,
      ...(undocumented.length ? { undocumented_statuses: undocumented } : {}),
      ...(unreturned.length ? { unreturned_statuses: unreturned } : {}),
      ...(undeclared.length ? { undeclared_body_fields: undeclared } : {}),
      ...(facts.validated_by ? { validated_by: facts.validated_by } : {}),
    });
  }

  const problems =
    documented_not_implemented.length +
    implemented_not_documented.length +
    operations.reduce((a, o) => a + (o.undocumented_statuses?.length ?? 0) + (o.unreturned_statuses?.filter((u) => !u.maybe_from).length ?? 0) + (o.undeclared_body_fields?.length ?? 0), 0);
  return {
    openapi: contract.file,
    summary: {
      documented_ops: opts.scoped ? inScope.length : contract.ops.length,
      implemented_routes: routes.length,
      documented_not_implemented: documented_not_implemented.length,
      implemented_not_documented: implemented_not_documented.length,
      operations_with_drift: operations.length,
      operations_clean: clean,
      problems,
    },
    documented_not_implemented,
    implemented_not_documented,
    operations,
  };
}

const codeOnlyLinesCache = new WeakMap();
function codeOnlyLines(g, file) {
  if (!codeOnlyLinesCache.has(g)) codeOnlyLinesCache.set(g, cache((f) => codeOnly(g.text(f) ?? "").split("\n")));
  return codeOnlyLinesCache.get(g)(file);
}

const dedupeBy = (xs, key) => [...new Map(xs.map((x) => [key(x), x])).values()];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---- statuses beyond the handler's own lines ----
// Handlers often answer through what they call: a helper handed `res` (`parseOr400(schema,
// body, res)`), a service that throws an error class carrying a status (`throw new
// NotFoundError()` -> 404), or a guard mounted above the route (a membership check's 404).
const SRC = /\.(?:[cm]?[jt]sx?)$/;
const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "function", "typeof", "await", "new", "super", "import", "require"]);
const statusesIn = (text) => [
  ...[...text.matchAll(/\.(?:status|sendStatus)\(\s*(\d{3})\s*\)/g)].map((m) => Number(m[1])),
  ...[...text.matchAll(/\b(?:createError|createHttpError|httpError|HttpError)\(\s*(\d{3})\b/g)].map((m) => Number(m[1])),
];
// The body of the function `name` declared in `src`, or null.
function bodyOf(src, name) {
  const s = functionSpan(src, name);
  return s ? src.slice(s.open, s.close + 1) : null;
}
// What `file` imports: local name -> the file it comes from (relative imports only).
function importsIn(g, file) {
  const src = g.text(file) ?? "";
  const out = new Map();
  const resolve = (spec) => {
    if (!spec.startsWith(".")) return null;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)).replace(/\.(?:[cm]?js)$/, "");
    return [base, ...[".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", "/index.ts", "/index.js"].map((e) => base + e)].find((f) => g.text(f) != null) ?? null;
  };
  for (const m of src.matchAll(/import\s+(?:type\s+)?(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*["']([^"']+)["']/g)) {
    const f = resolve(m[3]);
    if (!f) continue;
    if (m[1]) out.set(m[1], f);
    for (const part of (m[2] ?? "").split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()?.trim();
      if (name) out.set(name, f);
    }
  }
  return out;
}
// Error classes and the status each carries: super(404, …), this.status = 404, or its parent's;
// else what its name says (NotFound -> 404).
const errorClasses = (g) => {
  if (g.__errorClasses) return g.__errorClasses;
  const raw = new Map();
  for (const f of (g.files ?? []).filter((f) => SRC.test(f) && !/(?:^|\/)(?:node_modules|dist|build)\//.test(f))) {
    const src = g.text(f) ?? "";
    if (!/\bclass\s+\w+\s+extends\b/.test(src)) continue;
    for (const m of src.matchAll(/\bclass\s+(\w+)\s+extends\s+(\w+)/g)) {
      const body = bodyOf(src.slice(m.index).replace(/^class\s+\w+\s+extends\s+\w+/, "function __c()"), "__c") ?? "";
      const own = body.match(/\bsuper\(\s*(\d{3})\b|\bsuper\([^)]*?,\s*(\d{3})\s*[,)]|\bstatus(?:Code)?\s*[=:]\s*(\d{3})\b/);
      raw.set(m[1], { parent: m[2], status: own ? Number(own[1] ?? own[2] ?? own[3]) : null });
    }
  }
  const BY_NAME = [[/NotFound/, 404], [/Forbidden/, 403], [/Unauthori[sz]ed/, 401], [/BadRequest|Validation/, 400], [/Conflict/, 409], [/TooMany|RateLimit/, 429], [/Unprocessable/, 422]];
  const statusOf = (name, seen = 0) => {
    const c = raw.get(name);
    if (c?.status) return c.status;
    if (c && seen < 6) { const p = statusOf(c.parent, seen + 1); if (p) return p; }
    return BY_NAME.find(([re]) => re.test(name))?.[1] ?? null;
  };
  g.__errorClasses = statusOf;
  return statusOf;
};

// What the app's error handling makes of a ZodError (thrown by `Schema.parse(req.body)`): the
// status or error class right after `instanceof ZodError`. Null when it doesn't say.
const zodStatus = (g) => {
  if ("__zodStatus" in g) return g.__zodStatus;
  const statusOf = errorClasses(g);
  let st = null;
  for (const f of (g.files ?? []).filter((f) => SRC.test(f))) {
    const src = g.text(f) ?? "";
    const i = src.search(/instanceof\s+(?:z\.)?ZodError/);
    if (i < 0) continue;
    const after = src.slice(i, i + 600);
    st = statusesIn(after)[0] ?? statusOf(after.match(/\bnew\s+(\w+)\s*\(/)?.[1] ?? "") ?? null;
    if (st) break;
  }
  g.__zodStatus = st;
  return st;
};

/** Statuses a route sends through what its handler calls (two calls deep) and through its guards. */
export function calledStatuses(g, route) {
  const statusOf = errorClasses(g);
  const out = [];
  const seen = new Set();
  // The forms this route's framework adds to Express's (NextResponse.json(x, { status: 403 })…).
  const extra = idiomsOf(route).status.filter((re) => !idiomsOf(null).status.includes(re));
  const scan = (text, file, depth, via) => {
    for (const st of statusesIn(text)) out.push({ status: st, line: null, via });
    for (const re of extra) for (const m of text.matchAll(re)) out.push({ status: Number(m[1]), line: null, via });
    for (const m of text.matchAll(/\b(?:throw|next\()\s*new\s+(\w+)\s*\(/g)) {
      const st = statusOf(m[1]);
      if (st) out.push({ status: st, line: null, via: via ?? m[1] });
    }
    if (depth >= 2) return;
    const imports = importsIn(g, file);
    for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[1];
      if (KEYWORDS.has(name) || seen.has(`${file}#${name}`)) continue;
      seen.add(`${file}#${name}`);
      const target = imports.get(name) ?? file;
      const body = bodyOf(g.text(target) ?? "", name);
      if (body) scan(body, target, depth + 1, via ?? name);
    }
  };
  const lines = (g.lines(route.file) ?? []).slice(route.start - 1, route.end).join("\n");
  scan(lines, route.file, 0, null);
  if (/\.parse\(\s*req\.(?:body|params|query)\b/.test(lines) && zodStatus(g)) out.push({ status: zodStatus(g), line: null, via: "request validation" });
  for (const gd of route.guards ?? []) {
    const name = String(gd.name ?? gd).split(/[\s(]/)[0];
    const at = String(gd.at ?? "").split(":")[0] || route.file;
    const target = importsIn(g, at).get(name) ?? at;
    const body = bodyOf(g.text(target) ?? "", name);
    if (body) for (const st of statusesIn(body)) out.push({ status: st, line: null, via: name });
  }
  return out.filter((x) => x.status >= 300);
}
