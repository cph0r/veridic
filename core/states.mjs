// The feature's state machine, extracted from code: every place a status is
// written, the state(s) it requires first (its guard) and who writes it (a
// route, webhook, timer or service). Then deterministic hints for the patterns
// behind real bugs, for the agent to confirm by reading:
//   - a state two writers can leave, one of them a timer (a late event finds the
//     row already moved on);
//   - a value one route overwrites and another rejects when it differs (a
//     second call invalidates the first);
//   - a status written without checking the current status.

const STATUS_WRITE = /\b(status|state)\s*:\s*["'`]([a-z][a-z_]*)["'`]/;
const WRITE_CONTEXT = /\.set\s*\(|\.values\s*\(|\b\w*(?:Fields|Update|Patch|Data)\s*(?::[^=]*)?=\s*\{|\.update\s*\(|\.insert\s*\(/;
const RESPONSE_CONTEXT = /\bres\s*\.|\.json\s*\(|\.send\s*\(|return\s*\{|notify\w*\(|emit\w*\(|type:\s*["']/;
const TIMING = /\b([A-Za-z_]*(?:TIMEOUT|EXPIR|TTL|WINDOW|expire|timeout|ttl|window)[A-Za-z_]*)\s*[:=]\s*([0-9][0-9_]*(?:\s*\*\s*[0-9_]+)*)/;

/** Which kind of unit a line belongs to, by the scope's routes, webhooks and timers. */
function unitAt(sc, g, file, line) {
  const inRange = (u) => {
    const m = u.at.match(/^(.*):(\d+)-(\d+)$/);
    return m && m[1] === file && Number(m[2]) <= line && Number(m[3]) >= line;
  };
  for (const [kind, list] of [["webhook", sc.webhooks], ["route", sc.routes]]) {
    const u = (list ?? []).find(inRange);
    if (u) return { kind, name: u.id };
  }
  const fn = g.enclosing(file, line);
  const name = fn?.name ?? "(module)";
  // A function a timer in the same file calls is the timer's work.
  const src = g.text(file) ?? "";
  if (fn && new RegExp(`set(?:Interval|Timeout)\\s*\\([^)]*\\b${name}\\b|cron[^\\n]*\\b${name}\\b|schedule[^\\n]*\\b${name}\\b`).test(src)) return { kind: "timer", name };
  return { kind: "service", name };
}

/**
 * @param g   CodeGraph handle (openGraph)
 * @param sc  scope result (routes, webhooks, timers, read_list)
 */
export function stateMachine(g, sc) {
  const ranges = (sc.read_list ?? [])
    .map((r) => r.at.match(/^(.*):(\d+)-(\d+)$/))
    .filter(Boolean)
    .map((m) => ({ file: m[1], start: Number(m[2]), end: Number(m[3]) }));
  const seen = new Set();
  const writers = [];
  const timing = new Map();
  const fieldWrites = []; // non-status fields written in an update: { field, unit, at, guardedNull }
  const fieldChecks = []; // comparisons that reject a value differing from a stored field

  for (const r of ranges) {
    const lines = g.lines(r.file) ?? [];
    for (let n = r.start; n <= Math.min(r.end, lines.length); n++) {
      const key = `${r.file}:${n}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const line = lines[n - 1];
      const t = line.match(TIMING);
      if (t && !timing.has(key)) timing.set(key, { name: t[1], value: t[2].replace(/\s+/g, " "), at: key });

      // Comparisons that reject a mismatch with a stored field: `x.field !== y` / `y !== x.field`.
      const cmp = line.match(/\b\w+\.(\w+)\s*!==\s*\w+|\w+\s*!==\s*\w+\.(\w+)/);
      if (cmp) {
        const field = cmp[1] ?? cmp[2];
        if (field && !/^(status|state|length|id)$/.test(field)) fieldChecks.push({ field, at: key, unit: unitAt(sc, g, r.file, n), line: line.trim() });
      }

      const w = line.match(STATUS_WRITE);
      if (!w) continue;
      // Find the object literal this property sits in and what it's for.
      let open = n;
      let depth = 0;
      for (let k = n; k >= Math.max(1, n - 12); k--) {
        const l = lines[k - 1];
        depth += (l.match(/\}/g) ?? []).length - (k === n ? 0 : 0);
        if (/\{/.test(l)) {
          open = k;
          break;
        }
      }
      const head = lines.slice(Math.max(0, open - 2), open).join(" ");
      if (RESPONSE_CONTEXT.test(head) && !WRITE_CONTEXT.test(head)) continue;
      if (!WRITE_CONTEXT.test(head) && !/\.set\s*\(|update/i.test(lines.slice(n - 1, n + 8).join(" "))) continue;

      // Guard: the where clause that follows, else checks earlier in the unit.
      const after = lines.slice(n - 1, n + 16).join(" ");
      const from = new Set();
      for (const m of after.matchAll(/\beq\(\s*[\w.]*\b(?:status|state),\s*["'`]([a-z_]+)["'`]\s*\)/g)) from.add(m[1]);
      for (const m of after.matchAll(/\binArray\(\s*[\w.]*\b(?:status|state),\s*\[([^\]]*)\]/g)) for (const s of m[1].matchAll(/["'`]([a-z_]+)["'`]/g)) from.add(s[1]);
      const notIn = [...after.matchAll(/\bnotInArray\(\s*[\w.]*\b(?:status|state),\s*\[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/["'`]([a-z_]+)["'`]/g)].map((s) => s[1]));
      const fn = g.enclosing(r.file, n);
      const before = lines.slice((fn?.start ?? Math.max(1, n - 40)) - 1, n - 1).join("\n");
      const checked = [...before.matchAll(/\.(?:status|state)\s*(?:!==|===)\s*["'`]([a-z_]+)["'`]/g)].map((m) => m[1]);
      const unit = unitAt(sc, g, r.file, n);
      // For a service, the routes/webhooks/timers in scope that call it.
      const callers =
        unit.kind === "service" && fn
          ? [...new Set(g.usersOf(fn.id).map((u) => unitAt(sc, g, u.file, u.line)).filter((x) => x.kind !== "service").map((x) => `${x.kind} ${x.name}`))]
          : [];
      writers.push({
        callers,
        to: w[2],
        from: [...from],
        not_from: notIn,
        checked_in_code: [...new Set(checked)],
        guarded: from.size > 0 || notIn.length > 0,
        by: unit,
        at: key,
      });

      // Other fields written in the same update, and whether the write requires them unset first.
      const block = lines.slice(open - 1, Math.min(lines.length, n + 16)).join(" ");
      for (const f of block.matchAll(/\b([a-z][A-Za-z0-9]*(?:Id|Ref|Token|Key|TransactionId))\s*:/g))
        fieldWrites.push({ field: f[1], unit, at: key, guardedNull: new RegExp(`isNull\\([\\w.]*\\b${f[1]}\\)`).test(block) });
    }
  }

  // Updates that set a correlation field without touching status (e.g. storing a new transaction id).
  for (const r of ranges) {
    const lines = g.lines(r.file) ?? [];
    for (let n = r.start; n <= Math.min(r.end, lines.length); n++) {
      if (!/\.set\s*\(\s*\{/.test(lines[n - 1])) continue;
      const block = lines.slice(n - 1, n + 10).join(" ");
      if (STATUS_WRITE.test(block)) continue;
      for (const f of block.matchAll(/\b([a-z][A-Za-z0-9]*(?:Id|Ref|Token|Key))\s*:/g))
        fieldWrites.push({ field: f[1], unit: unitAt(sc, g, r.file, n), at: `${r.file}:${n}`, guardedNull: new RegExp(`isNull\\([\\w.]*\\b${f[1]}\\)`).test(block) });
    }
  }

  // A timer's own timeout often sits at the top of its file, outside the read ranges.
  for (const f of new Set(writers.filter((w) => w.by.kind === "timer").map((w) => w.at.replace(/:\d+$/, "")))) {
    (g.lines(f) ?? []).forEach((line, i) => {
      const t = line.match(TIMING);
      const key = `${f}:${i + 1}`;
      if (t && !timing.has(key)) timing.set(key, { name: t[1], value: t[2].replace(/\s+/g, " "), at: key });
    });
  }

  const hints = [];
  // 1. A state left by two writers, one of them a timer.
  const byFrom = new Map();
  for (const w of writers) for (const s of w.from) (byFrom.get(s) ?? byFrom.set(s, []).get(s)).push(w);
  for (const [state, ws] of byFrom) {
    const timers = ws.filter((w) => w.by.kind === "timer");
    const others = ws.filter((w) => w.by.kind !== "timer" && w.to !== timers[0]?.to);
    if (!timers.length || !others.length) continue;
    hints.push({
      kind: "timer-race",
      text: `"${state}" is left by a timer (${timers.map((t) => `${t.by.name} → "${t.to}" at ${t.at}`).join("; ")}) and by ${others.map((o) => `${o.by.name} → "${o.to}" at ${o.at}`).join("; ")}. Whichever runs second finds the row no longer "${state}". Check whether the timer can fire while the other flow (a payment, a confirmation) can still complete, and compare the timing values in scope.`,
      timing: [...timing.values()],
    });
  }
  // 2. Two writers leaving the same state for the same target (a race between paths).
  for (const [state, ws] of byFrom) {
    const byTo = new Map();
    for (const w of ws) (byTo.get(w.to) ?? byTo.set(w.to, []).get(w.to)).push(w);
    for (const [to, same] of byTo) {
      const units = [...new Set(same.map((w) => w.by.name))];
      if (units.length > 1) hints.push({ kind: "parallel-paths", text: `"${state}" → "${to}" is written by ${units.join(" and ")} (${same.map((w) => w.at).join(", ")}). If both can run for the same row, the second gets nothing back: check what it tells its caller.` });
    }
  }
  // 2b. One guarded transition in a service that several entry points call.
  for (const w of writers.filter((x) => x.guarded && x.callers.length > 1))
    hints.push({ kind: "parallel-paths", text: `"${w.from.join('", "') || "(guarded)"}" → "${w.to}" is done by ${w.by.name} (${w.at}), called from ${w.callers.join(", ")}. When two of them handle the same row, the second finds it already moved on: check what that caller reports (an error after a successful payment is a common result).` });
  // 3. A correlation value overwritten by one unit and required to match by another.
  for (const c of fieldChecks) {
    const w = fieldWrites.filter((x) => x.field === c.field && !x.guardedNull && x.unit.name !== c.unit.name);
    if (!w.length) continue;
    hints.push({
      kind: "overwrite-then-compare",
      text: `\`${c.field}\` is written by ${[...new Set(w.map((x) => `${x.unit.name} (${x.at})`))].join(", ")} without requiring it to be unset, and ${c.unit.name} rejects any value that differs from the stored one (${c.at}: \`${c.line.slice(0, 80)}\`). If the writer can run twice, the second write invalidates whatever the first one issued.`,
    });
  }
  // 4. Status writes without any check of the current status.
  for (const w of writers.filter((x) => !x.guarded && !x.checked_in_code.length && x.by.kind !== "service"))
    hints.push({ kind: "unguarded-write", text: `${w.by.name} sets status "${w.to}" at ${w.at} without checking the current status in its where clause or before it.` });

  const uniq = (xs) => [...new Map(xs.map((h) => [h.text, h])).values()];
  return { writers, hints: uniq(hints), timing: [...timing.values()] };
}

/** The state-machine section for a context document or a rendered spec. */
export function stateMachineMarkdown(sm) {
  if (!sm.writers.length) return "";
  const out = ["## State machine (generated from code)", "", "| To | From (guard) | Written by | At |", "|---|---|---|---|"];
  for (const w of sm.writers) {
    const from = w.from.length ? w.from.map((s) => `\`${s}\``).join(", ") : w.not_from.length ? `not ${w.not_from.map((s) => `\`${s}\``).join(", ")}` : w.checked_in_code.length ? `checked in code: ${w.checked_in_code.map((s) => `\`${s}\``).join(", ")}` : "**unguarded**";
    out.push(`| \`${w.to}\` | ${from} | ${w.by.kind} \`${w.by.name}\`${w.callers?.length ? ` (called from ${w.callers.join(", ")})` : ""} | \`${w.at}\` |`);
  }
  if (sm.timing.length) out.push("", `Timing values in scope: ${sm.timing.map((t) => `\`${t.name} = ${t.value}\` (${t.at})`).join(", ")}.`);
  if (sm.hints.length) out.push("", "**Hints** (deterministic pattern matches; confirm each by reading before reporting it):", "", ...sm.hints.map((h) => `- [${h.kind}] ${h.text}`));
  out.push("");
  return out.join("\n");
}
