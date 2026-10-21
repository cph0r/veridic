// Call-graph feature scoping. Given seeds (routes, files or symbols), find
// everything that belongs to the same feature: the seed handlers' callee closure,
// plus every other route, webhook and timer that shares a feature-specific
// symbol or state literal with it, plus the tables, contract operations and
// client callers involved. Returns facts and locations, never prose.

import path from "node:path";
import { USE_KINDS, SYMBOL_KINDS, isTestFile, matchParen, lineAt, offsetOfLine, literalSpans, codeOnly, cache } from "./graph.mjs";
import { normRoute, parseRouteId } from "./routes.mjs";

const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/;
// Enum-like state values such as "awaiting_payment". Plain words like "pending"
// are too common to tie two flows together, so only snake_case values count.
const STATE_LITERAL = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
// ...and only where the code compares or assigns a state with them, so column
// names ("created_at") and event names in payloads do not count.
const STATE_BEFORE = [
  /(?:===|!==|==|!=)\s*$/, // x === "v"
  /\b(?:eq|ne)\([^()]*,\s*$/, // eq(table.status, "v")
  /\bcase\s+$/, // case "v":
  /(?:status|state)\w*["']?\s*[:=]\s*(?:[^,;{}()]*[?:|]\s*)?$/i, // status: "v", initialStatus: c ? "v" : "w", "v" | "w"
  /(?:status|state)\w*[^;{}]*\[[^\]]*$/i, // STATUSES = ["v", ...], inArray(t.status, ["v"])
];
const STATE_AFTER = /^\s*(?:===|!==|==|!=)/;
const TIMER_CALL = /\b(setInterval|cron\.schedule|schedule\.scheduleJob|scheduleJob|new\s+CronJob)\s*\(/g;
const WEBHOOK_PATH = /webhook|callback|hook|notify|ipn|\/events?\b/i;

export const DEFAULTS = { depth: 3, maxHops: 3, percentile: 0.95, minUbiquity: 8, literalMaxShare: 0.3, coreScore: 5, reachShare: 0.2 };

/**
 * @param g   graph from openGraph()
 * @param inv routeInventory(g)
 * @param seeds strings: "POST /api/x", a repo-relative file, or a symbol name
 * @param opts { depth, maxHops, percentile, minUbiquity, literalMaxShare, openapi: ops[] }
 */
export function scope(g, inv, seeds, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const serverRoot = inv.entry ? serverRootOf(inv.entry) : "";
  const codeFiles = g.files.filter((f) => CODE_FILE.test(f) && !isTestFile(f) && !f.includes("node_modules"));

  // --- ubiquity --------------------------------------------------------------
  const degrees = [...g.nodes.values()].filter((n) => SYMBOL_KINDS.has(n.kind)).map((n) => g.inDegree(n.id)).filter((d) => d > 0);
  const symCut = Math.max(o.minUbiquity, percentile(degrees, o.percentile));
  // Infrastructure by call count, or (set below) by how many routes and timers
  // reach it: a wrapper every handler goes through doesn't tie two flows together.
  let reachUbiquitous = new Set();
  const ubiquitous = (n) => g.inDegree(n.id) > symCut || reachUbiquitous.has(n.id);

  const stateLiterals = (file, start = 1, end = Infinity) => {
    const src = g.text(file) ?? "";
    const out = new Set();
    for (const l of literalSpans(src, offsetOfLine(src, start), end === Infinity ? src.length : offsetOfLine(src, end + 1))) {
      if (!STATE_LITERAL.test(l.value)) continue;
      const before = src.slice(Math.max(0, l.start - 120), l.start);
      if (STATE_BEFORE.some((re) => re.test(before)) || STATE_AFTER.test(src.slice(l.end + 1, l.end + 6))) out.add(l.value);
    }
    return out;
  };
  // Document frequency over server files: a state shared by most of the server
  // (e.g. a soft-delete flag) does not tie two flows together.
  const serverFiles = codeFiles.filter((f) => !serverRoot || f.startsWith(serverRoot));
  const literalDf = new Map();
  for (const f of serverFiles) for (const l of stateLiterals(f)) literalDf.set(l, (literalDf.get(l) ?? 0) + 1);
  const litCut = Math.max(o.minUbiquity, Math.floor(o.literalMaxShare * serverFiles.length));
  const specificLiteral = (l) => (literalDf.get(l) ?? 0) <= litCut;

  // --- units: routes, webhooks, timers ---------------------------------------
  const units = [];
  for (const r of inv.routes) {
    units.push({ kind: WEBHOOK_PATH.test(r.path) ? "webhook" : "route", id: r.id, file: r.file, start: r.start, end: r.end, guards: r.guards.map((x) => x.name) });
  }
  for (const e of entryPoints(g, codeFiles)) if (e.kind === "timer") units.push(e);

  // --- closures --------------------------------------------------------------
  // (Computed twice: once to measure reach, then with reach-ubiquitous symbols cut.)
  const refsOf = cache((key) => {
    const [file, s, e] = key.split("\u0000");
    const start = Number(s);
    const end = Number(e);
    const out = new Map();
    for (const u of g.usesInRange(file, start, end)) {
      const t = u.target;
      if (!USE_KINDS.has(u.kind) || !SYMBOL_KINDS.has(t.kind) || isTestFile(t.file)) continue;
      if (t.file === file && t.start >= start && t.end <= end) continue; // defined inside the range
      out.set(t.id, t);
    }
    return [...out.values()];
  });
  const rangeKey = (file, start, end) => `${file}\u0000${start}\u0000${end}`;

  /** id -> { node, depth, via } over calls/references, not expanding ubiquitous symbols. */
  const closureBody = (key) => {
    const seen = new Map();
    let frontier = refsOf(key).map((n) => ({ node: n, via: null }));
    for (let d = 1; d <= o.depth && frontier.length; d++) {
      const next = [];
      for (const { node, via } of frontier) {
        if (seen.has(node.id)) continue;
        seen.set(node.id, { node, depth: d, via });
        if (ubiquitous(node) || d === o.depth) continue;
        for (const t of refsOf(rangeKey(node.file, node.start, node.end))) if (!seen.has(t.id)) next.push({ node: t, via: node.name });
      }
      frontier = next;
    }
    return seen;
  };
  const closureOf = cache(closureBody);
  let closure = (u) => closureOf(rangeKey(u.file, u.start, u.end));

  // Reach: how many units reference each symbol directly (a wrapper or client
  // every handler calls). Deeper reach would also catch real shared services.
  const reach = new Map();
  for (const u of units) for (const t of refsOf(rangeKey(u.file, u.start, u.end))) reach.set(t.id, (reach.get(t.id) ?? 0) + 1);
  const reachCut = Math.max(3, Math.floor(o.reachShare * units.length));
  reachUbiquitous = new Set([...reach].filter(([, n]) => n > reachCut).map(([id]) => id));
  if (reachUbiquitous.size) {
    const fresh = cache(closureBody);
    closure = (u) => fresh(rangeKey(u.file, u.start, u.end));
  }

  const literalsOf = (u, clo) => {
    const out = new Set();
    const add = (file, start, end) => {
      for (const l of stateLiterals(file, start, end)) if (specificLiteral(l)) out.add(l);
    };
    add(u.file, u.start, u.end);
    for (const { node, depth } of clo.values()) if (depth === 1 && !ubiquitous(node)) add(node.file, node.start, node.end);
    return out;
  };

  // --- seeds -----------------------------------------------------------------
  const seedUnits = [];
  const unresolved = [];
  for (const s of seeds) {
    const found = resolveSeed(g, units, s);
    if (found.length) seedUnits.push(...found);
    else unresolved.push(s);
  }
  if (!seedUnits.length) return { seeds, unresolved, error: "no seed resolved" };

  const seedIds = new Set(seedUnits.map((u) => u.id));
  const featureSyms = new Map(); // id -> { node, depth, via }
  const featureLits = new Set();
  for (const u of seedUnits) {
    const clo = closure(u);
    for (const [id, c] of clo) if (!ubiquitous(c.node) && (!featureSyms.has(id) || featureSyms.get(id).depth > c.depth)) featureSyms.set(id, c);
    for (const l of literalsOf(u, clo)) featureLits.add(l);
  }

  // --- reverse step ----------------------------------------------------------
  // A unit joins the feature when it shares a feature-specific symbol within
  // maxHops (seed -> symbol -> unit), or compares/assigns a feature state value.
  const idf = (df) => Math.log((1 + codeFiles.length) / (1 + df));
  const included = [];
  for (const u of units) {
    if (seedIds.has(u.id)) continue;
    const clo = closure(u);
    const shared = [];
    for (const [id, c] of clo) {
      const f = featureSyms.get(id);
      if (!f || f.depth + c.depth > o.maxHops) continue;
      shared.push({ symbol: c.node.name, at: `${c.node.file}:${c.node.start}`, hops: f.depth + c.depth, weight: idf(g.inDegree(id)) / (f.depth + c.depth - 1) });
    }
    const lits = [...literalsOf(u, clo)].filter((l) => featureLits.has(l));
    if (!shared.length && !lits.length) continue;
    const score = shared.reduce((a, s) => a + s.weight, 0) + lits.reduce((a, l) => a + idf(literalDf.get(l) ?? 0), 0);
    // core: shares a feature state, or a symbol about as specific as one used by
    // two files at two hops. Peripheral units are listed but read later.
    const tier = lits.length || score >= o.coreScore ? "core" : "peripheral";
    included.push({ unit: u, tier, score: round(score), shared: shared.sort((a, b) => b.weight - a.weight).slice(0, 5).map(({ weight, ...s }) => s), shared_literals: lits });
  }
  included.sort((a, b) => b.score - a.score);

  // --- services: feature-specific symbols reached by the seeds or shared ------
  const inScope = [...seedUnits, ...included.map((i) => i.unit)];
  const services = new Map();
  const addService = (c, usedBy) => {
    const n = c.node;
    if (ubiquitous(n) || n.kind === "route") return;
    const cur = services.get(n.id) ?? { name: n.name, kind: n.kind, at: `${n.file}:${n.start}-${n.end}`, depth: c.depth, used_by: [] };
    cur.depth = Math.min(cur.depth, c.depth);
    if (!cur.used_by.includes(usedBy)) cur.used_by.push(usedBy);
    services.set(n.id, cur);
  };
  for (const u of seedUnits) for (const c of closure(u).values()) addService(c, u.id);
  for (const { unit } of included) for (const c of closure(unit).values()) if (c.depth === 1 || featureSyms.has(c.node.id)) addService(c, unit.id);

  // --- callers: other code paths into the seed's direct callees -------------
  // Entry points that are neither routes nor timers (WebSocket handlers, queue
  // consumers, CLI scripts) show up here.
  const covered = (file, line) => inScope.some((u) => u.file === file && u.start <= line && u.end >= line);
  const callers = new Map();
  for (const [id, f] of featureSyms) {
    if (f.depth !== 1) continue;
    for (const use of g.usersOf(id)) {
      const n = use.node;
      if (!n || isTestFile(use.file) || covered(use.file, use.line) || services.has(n.id) || n.id === id) continue;
      const cur = callers.get(n.id) ?? { name: n.name, at: `${n.file}:${n.start}-${n.end}`, calls: [] };
      if (!cur.calls.includes(f.node.name)) cur.calls.push(f.node.name);
      callers.set(n.id, cur);
    }
  }

  // --- schemas ---------------------------------------------------------------
  const tables = tableDefs(g, codeFiles);
  const schemas = [];
  if (tables.length) {
    const code = cache((f) => codeOnly(g.text(f) ?? "").split("\n"));
    const mentions = (file, start, end) => code(file).slice(start - 1, end).join("\n");
    const ranges = [...inScope.map((u) => [u.file, u.start, u.end, u.id]), ...[...services.values()].map((s) => [...splitAt(s.at), s.name])];
    // A table counts only where its binding is imported or defined, so a generic
    // name such as `orders` in a generated schema does not match every file.
    const binds = (file, name) => file === name.file || new RegExp(`import[^;]*\\b${name.name}\\b[^;]*from`).test(g.text(file) ?? "");
    for (const t of tables) {
      const re = new RegExp(`\\b${t.name}\\b`);
      const by = ranges.filter(([f, a, b]) => binds(f, t) && re.test(mentions(f, a, b))).map((r) => r[3]);
      if (by.length) schemas.push({ name: t.name, table: t.table, at: `${t.file}:${t.start}-${t.end}`, used_by: [...new Set(by)], uses: by.length });
    }
    schemas.sort((a, b) => b.uses - a.uses);
  }

  // --- contract ops and clients ----------------------------------------------
  const routeUnits = inScope.filter((u) => u.kind !== "timer");
  const ops = (o.openapi ?? []).filter((op) => routeUnits.some((u) => normRoute(u.id) === normRoute(op.id)));
  const clients = clientCallers(g, codeFiles, serverRoot, routeUnits);

  // --- read list -------------------------------------------------------------
  const reads = [];
  const push = (file, start, end, why, priority) => reads.push({ file, start, end, why, priority });
  for (const u of seedUnits) push(u.file, u.start, u.end, `seed ${u.kind}: ${u.id}`, 0);
  // Module-level constants a seed handler uses (a price table, a timeout). The
  // graph has no edge from an inline handler to them, so match names in its text.
  const seedText = (u) => (g.lines(u.file) ?? []).slice(u.start - 1, u.end).join("\n");
  for (const u of seedUnits) {
    const text = seedText(u);
    for (const n of g.nodesByFile.get(u.file) ?? []) {
      if (!["constant", "variable"].includes(n.kind) || (n.start >= u.start && n.end <= u.end)) continue;
      const decl = (g.lines(u.file) ?? [])[n.start - 1] ?? "";
      if (/\b(?:Router|createLogger|express)\s*\(/.test(decl) || !new RegExp(`\\b${n.name}\\b`).test(text)) continue;
      push(u.file, n.start, n.end, `constant used by seed: ${n.name}`, 1);
    }
  }
  const seedServiceNames = new Set([...services.values()].filter((sv) => sv.depth === 1 && sv.used_by.some((id) => seedIds.has(id))).map((sv) => sv.name));
  for (const s of services.values()) if (s.depth === 1 && s.used_by.some((id) => seedIds.has(id))) push(...splitAt(s.at), `called by seed: ${s.name}`, 1);
  const tierOf = new Map(included.map((i) => [i.unit.id, i.tier]));
  const core = (ids) => ids.some((id) => seedIds.has(id) || tierOf.get(id) === "core");
  for (const { unit, tier } of included) push(unit.file, unit.start, unit.end, `${tier} ${unit.kind}: ${unit.id}`, tier === "core" ? (unit.kind === "route" ? 3 : 2) : 6);
  for (const s of services.values()) if (s.depth === 1 && !s.used_by.some((id) => seedIds.has(id))) push(...splitAt(s.at), `called by ${s.used_by[0]}: ${s.name}`, core(s.used_by) ? 3 : 7);
  for (const s of services.values()) if (s.depth > 1) push(...splitAt(s.at), `depth ${s.depth}: ${s.name}`, core(s.used_by) ? 3 + s.depth : 8);
  for (const c of callers.values()) push(...splitAt(c.at), `also calls ${c.calls.join(", ")}: ${c.name}`, 4);
  // A table the seeds or their direct services use is part of the feature.
  for (const t of schemas) push(...splitAt(t.at), `table ${t.table ?? t.name}`, core(t.used_by) || t.used_by.some((n) => seedServiceNames.has(n)) ? 5 : 8);

  const strip = (u) => ({ id: u.id, at: `${u.file}:${u.start}-${u.end}`, ...(u.guards?.length ? { guards: u.guards } : {}), ...(u.every ? { every: u.every } : {}) });
  const why = (i) => ({ ...strip(i.unit), tier: i.tier, score: i.score, shared: i.shared, shared_literals: i.shared_literals });
  return {
    seeds,
    unresolved,
    thresholds: { ubiquitous_in_degree: symCut, ubiquitous_reach_units: reachCut, reach_ubiquitous_symbols: reachUbiquitous.size, ubiquitous_literal_files: litCut, depth: o.depth },
    routes: [...seedUnits.filter((u) => u.kind === "route").map((u) => ({ ...strip(u), seed: true })), ...included.filter((i) => i.unit.kind === "route").map(why)],
    webhooks: [...seedUnits.filter((u) => u.kind === "webhook").map((u) => ({ ...strip(u), seed: true })), ...included.filter((i) => i.unit.kind === "webhook").map(why)],
    timers: [...seedUnits.filter((u) => u.kind === "timer").map((u) => ({ ...strip(u), seed: true })), ...included.filter((i) => i.unit.kind === "timer").map(why)],
    services: [...services.values()].sort((a, b) => a.depth - b.depth || a.at.localeCompare(b.at)),
    callers: [...callers.values()],
    feature_literals: [...featureLits],
    schemas,
    contract_ops: ops,
    clients,
    read_list: mergeReads(reads),
  };
}

// ---------------------------------------------------------------------------

function resolveSeed(g, units, s) {
  const r = parseRouteId(s);
  if (r) return units.filter((u) => u.kind !== "timer" && normRoute(u.id) === normRoute(`${r.method} ${r.path}`));
  const fileHit = units.filter((u) => u.file === s || u.file.endsWith(`/${s}`));
  if (fileHit.length) return fileHit;
  const sym = [...g.nodes.values()].filter((n) => SYMBOL_KINDS.has(n.kind) && n.name === s && !isTestFile(n.file));
  return sym.map((n) => ({ kind: "symbol", id: `${n.name} @ ${n.file}:${n.start}`, file: n.file, start: n.start, end: n.end }));
}

const serverRootOf = (entry) => {
  const i = entry.indexOf("/src/");
  return i > -1 ? entry.slice(0, i + 1) : path.dirname(entry) + "/";
};

function intervalOf(args) {
  args = args.replace(/[\s,]+$/, "");
  const m = args.match(/,\s*([\d_*\s]+)\s*\)?\s*$/);
  if (!m) return args.match(/["']([^"']+)["']/)?.[1] ?? null; // cron expression
  const ms = m[1].replace(/_/g, "").split("*").reduce((a, x) => a * Number(x.trim()), 1);
  return Number.isFinite(ms) && ms > 0 ? `${ms} ms` : null;
}

/** Drizzle/Sequelize/Mongoose table definitions: `export const ordersTable = pgTable("orders", ...)`. */
// A WebSocket server, or a "connection"/"upgrade" handler in a file that uses WebSockets
// (a database pool's "connection" event is not one).
const SOCKET_CALL = /new\s+WebSocketServer\s*\(|\b[\w$]+\s*\.\s*on\s*\(\s*["'](?:connection|upgrade)["']/g;
const USES_SOCKETS = /WebSocket|socket\.io|from\s+["']ws["']|require\(\s*["']ws["']\s*\)/;

/** Entry points that are not routes: timers and WebSocket handlers, each with its extent. */
export function entryPoints(g, files) {
  const out = [];
  for (const f of files) {
    const src = g.text(f) ?? "";
    const at = (m, kind, label) => {
      const open = m.index + m[0].indexOf("(");
      const close = matchParen(src, open);
      if (close < 0) return null;
      const start = lineAt(src, m.index);
      const end = lineAt(src, close);
      const name = g.enclosing?.(f, start)?.name ?? null;
      return { kind, id: `${label} ${name ?? "(anonymous)"} @ ${f}:${start}`, name, file: f, start, end, open, close };
    };
    for (const m of src.matchAll(TIMER_CALL)) {
      const e = at(m, "timer", m[1].replace(/\s+/, " "));
      if (e) { const { open, close, ...rest } = e; out.push({ ...rest, every: intervalOf(src.slice(open, close)) }); }
    }
    if (!USES_SOCKETS.test(src)) continue;
    for (const m of src.matchAll(SOCKET_CALL)) {
      const e = at(m, "socket", "socket");
      if (e) { const { open, close, ...rest } = e; out.push(rest); }
    }
  }
  return out;
}

export function tableDefs(g, codeFiles) {
  const out = [];
  const DEF = /(?:export\s+)?const\s+(\w+)\s*=\s*(?:pgTable|mysqlTable|sqliteTable|\w+\.define|mongoose\.model|model)\s*(?:<[^>]*>)?\(\s*["'`](\w+)["'`]/g;
  for (const f of codeFiles) {
    const src = g.text(f) ?? "";
    if (!/pgTable|mysqlTable|sqliteTable|\.define\(|model\(/.test(src)) continue;
    for (const m of src.matchAll(DEF)) {
      const start = lineAt(src, m.index);
      const node = (g.nodesByFile.get(f) ?? []).find((n) => n.name === m[1] && n.start === start);
      out.push({ name: m[1], table: m[2], file: f, start, end: node?.end ?? start });
    }
  }
  return out;
}

function clientCallers(g, codeFiles, serverRoot, routeUnits) {
  const out = [];
  const others = codeFiles.filter((f) => !serverRoot || !f.startsWith(serverRoot));
  for (const u of routeUnits) {
    const p = u.id.split(" ")[1];
    const variants = [p, p.replace(/^\/api(?=\/)/, "")].filter((v, i, a) => v.split("/").length > 2 && a.indexOf(v) === i);
    // "/api/x", `/api/x/${id}`, or `${BASE}api/x` (a base URL interpolated in front).
    const res = variants.map((v) => {
      const body = v.slice(1).split("/").map((seg) => (seg.startsWith(":") ? "[^/\"'`]+" : escapeRe(seg))).join("/");
      return new RegExp(`(?:["'\`]/|\\}/?)${body}(?=["'\`?])`);
    });
    for (const f of others) {
      g.lines(f).forEach((l, i) => {
        if (!res.some((re) => re.test(l))) return;
        // A generated API client wraps the path in a small function; follow its
        // users (url builder, fetcher, hook) to reach the real call sites. A hit
        // inside a large component is already the call site.
        const fn = g.enclosing(f, i + 1);
        const wrapper = fn && fn.end - fn.start <= 20;
        out.push({ route: u.id, at: `${f}:${i + 1}`, ...(wrapper ? { via: fn.name, callers: callSites(g, fn) } : {}) });
      });
    }
  }
  return out;
}

function callSites(g, fn, depth = 6) {
  const sites = new Set();
  let frontier = [fn];
  const seen = new Set([fn.id]);
  for (let d = 0; d < depth && frontier.length; d++) {
    const next = [];
    for (const n of frontier) {
      for (const use of g.usersOf(n.id)) {
        if (isTestFile(use.file)) continue;
        if (use.file !== fn.file) sites.add(`${use.file}:${use.line}`);
        else if (use.node && !seen.has(use.node.id)) {
          seen.add(use.node.id);
          next.push(use.node);
        }
      }
    }
    frontier = next;
  }
  return [...sites].slice(0, 10);
}

function mergeReads(reads) {
  const byFile = Object.groupBy(reads, (r) => r.file);
  const merged = [];
  for (const [file, rs] of Object.entries(byFile)) {
    rs.sort((a, b) => a.start - b.start);
    let cur = null;
    for (const r of rs) {
      if (cur && r.start <= cur.end + 2) {
        cur.end = Math.max(cur.end, r.end);
        cur.priority = Math.min(cur.priority, r.priority);
        if (!cur.why.includes(r.why)) cur.why.push(r.why);
      } else {
        cur = { file, start: r.start, end: r.end, priority: r.priority, why: [r.why] };
        merged.push(cur);
      }
    }
  }
  merged.sort((a, b) => a.priority - b.priority || a.file.localeCompare(b.file) || a.start - b.start);
  return merged.map((r) => ({ at: `${r.file}:${r.start}-${r.end}`, priority: r.priority, lines: r.end - r.start + 1, why: r.why.slice(0, 4).join("; ") + (r.why.length > 4 ? `; +${r.why.length - 4} more` : "") }));
}

export function percentile(xs, p) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

const splitAt = (at) => {
  const m = at.match(/^(.*):(\d+)-(\d+)$/);
  return [m[1], Number(m[2]), Number(m[3])];
};
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const round = (x) => Math.round(x * 100) / 100;
