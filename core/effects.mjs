// What each route really does, from its code and the code it calls: reads,
// writes, destructive changes, money movement, external calls, notifications.
// The HTTP method says what a route should do; this says what it does. Built
// for exposing an API to AI agents (tool manifests, approval policies), where a
// "read" that writes or an unscoped route that moves money is the dangerous case.

import { reached } from "./reach.mjs";
import { accessMatrix, loadIntended, compareAccess } from "./access.mjs";
import { handlerFacts } from "./contract.mjs";

// Line patterns, checked on code (comments ignored). Each effect cites the line.
const EFFECTS = [
  // SQL/Drizzle, a storage layer, and the MongoDB/Mongoose, Sequelize and Prisma calls that delete.
  ["destructive", /\.delete\s*\(\s*\w+Table\b|\bdb\.delete\(|DELETE\s+FROM\b|\bstorage\.(?:delete|remove|purge)\w*\(|(?<!\b(?:res|response|req|request|stream|socket|conn\w*|ws|reader|writer|readable|writable|upstream|passThrough)\s*)\.destroy\s*\(|status:\s*["'](?:cancelled|canceled|deleted|archived|revoked|deactivated)["']|\.(?:deleteOne|deleteMany|findOneAndDelete|findByIdAndDelete|findOneAndRemove|findByIdAndRemove|bulkDelete)\s*\(|\.\w+\.delete(?:Many)?\s*\(\s*\{\s*where\b|\.remove\s*\(\s*(?:\{|\)|[\w.]+\s*[,)])/],
  ["write", /\.insert\s*\(\s*\w+|\.update\s*\(\s*\w+Table\b|\bdb\.update\(|\.upsert\s*\(|INSERT\s+INTO\b|UPDATE\s+\w+\s+SET\b|\bstorage\.(?:create|update|add|set|save|record|upsert|mark|activate|increment|insert)\w*\(|(?<!\b(?:res|response|reply|ctx|headers)\s*)\.set\(\s*\{|\.(?:insertOne|insertMany|updateOne|updateMany|replaceOne|findOneAndUpdate|findByIdAndUpdate|findOneAndReplace|bulkWrite|bulkCreate)\s*\(|(?<!\b\w*(?:pdf|Pdf|canvas|ctx|workbook|zip|image|img|sharp|png|jpe?g)\w*)\.save\s*\(\s*\)|\b(?:(?!PDF|Object\b|Promise\b|Buffer\b|Date\b|Array\b|Map\b|Set\b|Symbol\b|Reflect\b|URL\b|Image\b|Canvas\b|Document\b|Readable\b|Stream\b)[A-Z]\w*|prisma\.\w+|\w*[Mm]odels?(?:\.\w+)?|\w+(?:Repository|Repo))\.create\s*\(|\.(?:insert|update)\s*\(\s*\{|\$(?:set|push|pull|inc|addToSet|unset)\b/],
  ["moves_money", /\b(?:razorpay|phonepe|stripe|paypal|cashfree|paytm)\b[\w.]*\s*\.|\binitiatePayment\s*\(|\bcheckPaymentStatus\s*\(|\b(?:refund|charge|capture)(?:Payment)?\s*\(|\bconfirm\w*Payment\s*\(|\bactivateSubscription\s*\(|\bpaidAt\s*:(?!\s*\w+Table\.)|\.(?:increment|decrement)\s*\(\s*\{\s*\w*(?:balance|credit|amount)\b|\bwallet\w*\s*\.\s*(?:increment|decrement|update|save)\s*\(/i],
  ["external", /\bfetch\s*\(|\baxios\b[\w.]*\(|\bgot\s*\(|\bnew\s+(?:Razorpay|Stripe|OpenAI|Anthropic)\b|\.chat\.completions\.create\s*\(|\bgenerateContent\s*\(/],
  // Calls that tell someone else (email, SMS, WhatsApp, push, a dashboard, a POS): not
  // logger or internal event wiring, and not the functions' own declarations.
  ["notifies", /(?<!function\s)(?<![.\w])(?:send\w*(?:Email|Mail|Sms|SMS|Whatsapp|WhatsApp|Push|Message|Notification)\w*|notify\w*|pushOrderTo\w+|sendTemplate\w*)\s*\(|\bresend\.emails\.send\(|\btwilio\.messages\./],
];
const COMMENT = /^\s*(?:\/\/|\*|\/\*)/;

/** Effects found along a route's call tree, each with where it happens and how far from the handler. */
export function routeEffects(g, route) {
  const found = [];
  const seen = new Set();
  for (const r of reached(g, route)) {
    const lines = g.lines(r.file) ?? [];
    for (let n = r.start; n <= Math.min(r.end, lines.length); n++) {
      const line = lines[n - 1];
      if (!line || COMMENT.test(line)) continue;
      for (const [kind, re] of EFFECTS) {
        if (!re.test(line)) continue;
        const key = `${kind}@${r.file}:${n}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({ kind, at: `${r.file}:${n}`, via: r.depth ? r.name : null, depth: r.depth, code: line.trim().slice(0, 100) });
      }
    }
  }
  return found;
}

const RANK = { read: 0, write: 1, destructive: 2 };

/**
 * The tool manifest: per route, its real effect class and side effects, what a
 * caller needs (auth, plan, scoping), and its contract facts, with evidence.
 */
export function effectManifest(g, inv) {
  const access = new Map(accessMatrix(g, inv).map((a) => [a.route, a]));
  return inv.routes.map((r) => {
    const effects = routeEffects(g, r);
    const kinds = new Set(effects.map((e) => e.kind));
    // Sending an email or a message is a side effect too: an agent can't take it back.
    const effect = kinds.has("destructive") ? "destructive" : kinds.has("write") || kinds.has("moves_money") || kinds.has("notifies") ? "write" : "read";
    const a = access.get(r.id) ?? {};
    const facts = handlerFacts(g, r);
    return {
      tool: r.id,
      method: r.method,
      path: r.path,
      effect,
      moves_money: kinds.has("moves_money"),
      external: kinds.has("external"),
      notifies: kinds.has("notifies"),
      requires: { access: a.access, plan: a.plan === "pro" ? "paid plan (server-checked)" : "none", scoped_to_caller: a.scoped },
      responses: [...new Set(facts.statuses.map((s) => s.status))].sort(),
      ...(facts.fields?.length ? { body_fields: [...new Set(facts.fields.map((f) => f.field))] } : {}),
      ...(facts.validated_by ? { validated_by: facts.validated_by } : {}),
      handler: `${r.file}:${r.start}-${r.end}`,
      evidence: effects.slice(0, 12),
      access_flags: a.flags ?? [],
    };
  });
}

/**
 * Agent-readiness: the problems that matter when an AI agent calls this API as
 * a user. Severity is high when money or destruction is involved.
 */
export function readiness(manifest, comparison = null) {
  const issues = [];
  const sev = (t) => (t.moves_money || t.effect === "destructive" ? "high" : t.effect === "write" ? "medium" : "low");
  for (const t of manifest) {
    if ((t.method === "GET" || t.method === "HEAD") && t.effect !== "read") {
      // Show the writes first: they are what makes this GET unsafe.
      const prio = { destructive: 0, write: 1, moves_money: 2 };
      const why = t.evidence.filter((e) => e.kind in prio).sort((x, y) => prio[x.kind] - prio[y.kind]).slice(0, 2).map((e) => `${e.at}${e.via ? ` via ${e.via}` : ""}`);
      issues.push({ severity: t.moves_money ? "high" : "medium", kind: "get-that-writes", tool: t.tool, text: `${t.method} that ${t.effect === "destructive" ? "deletes or cancels" : "writes"}${t.moves_money ? " and moves money" : ""}: a tool scanner going by method would call it a safe read`, evidence: why });
    }
    // Money moved on an authenticated route whose ids (body or URL) aren't checked against the caller.
    if (t.moves_money && t.requires.access !== "public" && t.requires.scoped_to_caller === "no" && !t.access_flags.some((f) => /^id-param/.test(f)))
      issues.push({ severity: "high", kind: "money-not-scoped", tool: t.tool, text: "moves money on ids from the request without checking they belong to the caller", evidence: [t.handler, ...t.evidence.filter((e) => e.kind === "moves_money").slice(0, 1).map((e) => e.at)] });
    const userUrl = t.access_flags.find((f) => f.startsWith("user-id-from-url"));
    if (userUrl) issues.push({ severity: t.moves_money || t.effect === "destructive" ? "high" : "medium", kind: "user-id-from-url", tool: t.tool, text: `${t.effect === "read" ? "reads" : `${t.effect}s`} as whichever user the URL names (${userUrl.split(": ")[1]}), never compared with the caller: anyone signed in can see or change another user's data`, evidence: [t.handler] });
    const fromBody = t.access_flags.find((f) => f.startsWith("identity-from-request-body"));
    if (fromBody && t.effect !== "read") issues.push({ severity: t.moves_money || t.effect === "destructive" ? "high" : "medium", kind: "identity-from-request-body", tool: t.tool, text: `${t.effect}${t.moves_money ? ", moves money" : ""}, and takes who it is for from the request body (${fromBody.split(": ")[1]}): a caller can act as, or for, someone else`, evidence: [t.handler] });
    const unscoped = t.access_flags.find((f) => /^id-param/.test(f));
    if (unscoped && t.effect !== "read") issues.push({ severity: sev(t), kind: unscoped, tool: t.tool, text: `${t.effect}${t.moves_money ? ", moves money" : ""}, and acts on an id the caller ${unscoped.endsWith("client-values") ? "only supplies (not checked against them)" : "isn't checked to own"}`, evidence: [t.handler] });
    else if (unscoped) issues.push({ severity: "low", kind: unscoped, tool: t.tool, text: "reads data by an id the caller isn't checked to own", evidence: [t.handler] });
  }
  for (const m of comparison?.mismatches ?? []) issues.push({ severity: "high", kind: "policy-mismatch", tool: m.route, text: m.problems.join("; "), evidence: [m.at] });
  const order = { high: 0, medium: 1, low: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);
  const flagged = new Set(issues.filter((i) => i.severity !== "low").map((i) => i.tool));
  const count = (k) => manifest.filter(k).length;
  return {
    summary: {
      tools: manifest.length,
      reads: count((t) => t.effect === "read"),
      writes: count((t) => t.effect === "write"),
      destructive: count((t) => t.effect === "destructive"),
      move_money: count((t) => t.moves_money),
      gets_that_write: count((t) => (t.method === "GET" || t.method === "HEAD") && t.effect !== "read"),
      issues: { high: issues.filter((i) => i.severity === "high").length, medium: issues.filter((i) => i.severity === "medium").length, low: issues.filter((i) => i.severity === "low").length },
      agent_ready_pct: Math.round(((manifest.length - flagged.size) / Math.max(1, manifest.length)) * 1000) / 10,
    },
    issues,
  };
}

export { loadIntended, compareAccess, accessMatrix, RANK };
