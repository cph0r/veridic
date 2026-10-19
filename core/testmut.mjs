// Would the tests notice? For a sample of tested rules: change one thing in the code
// the rule cites (a number, a string, a comparison, a boolean), run the rule's named
// tests, and count the rules whose tests fail. The file is always restored. A rule
// whose tests still pass checks something other than its cited code.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runByFramework } from "./tests.mjs";

// One small change per line, the first that applies; comments and imports are left alone.
const MUTATIONS = [
  [/===/, "!=="],
  [/!==/, "==="],
  [/\btrue\b/, "false"],
  [/\bfalse\b/, "true"],
  [/(?<![\w.$])(\d+)(?![\w.])/, (n) => String(Number(n) + 1)],
  [/(["'])([^"'\\]+)\1/, (_, q, s) => `${q}${s}Mut${q}`],
  [/ < /, " >= "],
  [/ > /, " <= "],
];
const SKIP = /^\s*(?:\/\/|\*|\/\*|import\b|export\s+\*|\}?\s*$)/;

/** The first line in file:start-end that a mutation changes: { line, text } or null. */
export function mutantOf(src, start, end) {
  const lines = src.split("\n");
  for (let n = start; n <= Math.min(end, lines.length); n++) {
    const l = lines[n - 1];
    if (!l || SKIP.test(l)) continue;
    for (const [re, to] of MUTATIONS) {
      if (!re.test(l)) continue;
      const next = l.replace(re, to);
      if (next !== l) return { line: n, text: next };
    }
  }
  return null;
}

/**
 * @param rules [{ id, status, cites: ["file:start-end"], tests: [test files] }] — tested ones are sampled.
 * @returns {{ sampled, caught, rules: [{ id, cite, caught, reason? }] }}
 */
export function testMutation(repo, rules, n = 5) {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: repo, encoding: "utf8", maxBuffer: 64 << 20 }).split("\n").filter(Boolean);
  const out = [];
  for (const r of rules.filter((x) => x.status === "tested" && x.tests?.length).slice(0, n)) {
    const m = r.cites.map((c) => c.match(/^(.*):(\d+)(?:-(\d+))?$/)).find(Boolean);
    if (!m) continue;
    const [, file, a, b] = m;
    const abs = path.join(repo, file);
    const src = fs.readFileSync(abs, "utf8");
    const mut = mutantOf(src, Number(a), Number(b ?? a));
    if (!mut) {
      out.push({ id: r.id, cite: r.cites[0], caught: null, reason: "nothing to change in the cited lines" });
      continue;
    }
    const lines = src.split("\n");
    lines[mut.line - 1] = mut.text;
    try {
      fs.writeFileSync(abs, lines.join("\n"));
      const run = runByFramework(repo, [...new Set(r.tests)], files);
      // Caught when a test named for this rule fails with the change in place.
      const mine = [...run.results].filter(([k]) => k.split("\0")[1]?.includes(r.id));
      out.push({ id: r.id, cite: `${file}:${mut.line}`, caught: mine.length ? mine.some(([, v]) => v === "failed") : null, ...(mine.length ? {} : { reason: "its tests didn't run" }) });
    } finally {
      fs.writeFileSync(abs, src);
    }
  }
  const judged = out.filter((x) => x.caught != null);
  return { sampled: judged.length, caught: judged.filter((x) => x.caught).length, rules: out };
}
