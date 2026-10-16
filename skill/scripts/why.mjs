#!/usr/bin/env node
// Why is the code like this? The commits that wrote a requirement's cited lines
// (or any file:start-end), most lines first, with their messages. Use them as
// decision evidence in spec.json: `"evidence": ["path:12-20", "commit:abc1234"]`.

import fs from "node:fs";
import { whyOf } from "../../core/decisions.mjs";
import { parseSpec, makeResolver } from "../../core/citations.mjs";
import { parseArgs, emit, fail, run } from "./_cli.mjs";

const usage = "why.mjs --repo <path> (--spec <spec.md> FR-002 [INV-1 …] | path:start-end …)";

run(() => {
  const a = parseArgs(process.argv.slice(2), { flags: ["repo", "spec"], bools: [] });
  if (!a.repo || !a._.length) fail("need --repo and a requirement id (with --spec) or a path:start-end", usage);
  const targets = [];
  let resolve = null;
  let parsed = null;
  if (a.spec) {
    parsed = parseSpec(fs.readFileSync(a.spec, "utf8"));
    resolve = makeResolver(a.repo, { aliases: parsed.aliases, bases: parsed.bases });
  }
  for (const t of a._) {
    const range = t.match(/^([^\s:]+):(\d+)(?:-(\d+))?$/);
    if (range) {
      targets.push({ for: t, file: resolve?.(range[1]).file ?? range[1], start: Number(range[2]), end: Number(range[3] ?? range[2]) });
      continue;
    }
    if (!parsed) fail(`${t}: pass --spec to look up a requirement id`, usage);
    const cites = parsed.citations.filter((c) => c.fr === t && !c.bad);
    if (!cites.length) fail(`${t} has no citations in ${a.spec}`, usage);
    for (const c of cites) targets.push({ for: t, file: resolve(c.file).file ?? c.file, start: c.start, end: c.end });
  }
  const results = targets.map((t) => ({ for: t.for, ...whyOf(a.repo, t.file, t.start, t.end) }));
  emit({ repo: a.repo, results, next: "Write each decision into spec.json `decisions` (decision, because, evidence: the lines and the commit), then render" });
}, usage);
