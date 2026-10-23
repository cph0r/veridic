// Test skeleton from a spec: one placeholder per requirement, named with its id
// (so `tests` links it), grouped by the route or file it cites, with the
// citations and the spec's acceptance scenarios as comments. The agent replaces
// each placeholder with a real test. Deterministic; writes nothing itself.

import { parseStoryHeading } from "./report.mjs";
import fs from "node:fs";
import path from "node:path";
import { parseSpec, makeResolver } from "./citations.mjs";
import { enclosingSymbol } from "./anchors.mjs";

const strip = (line) =>
  line
    .replace(/\[evidence:[^\]]*\]/g, "")
    .replace(/^\s*[-*]\s*/, "")
    .replace(/\*\*((?:FR|SC|NFR|AC)-?\d+[a-z]?)\*\*:?\s*/, "")
    .replace(/[*`]/g, "")
    .replace(/\s+[—–-]\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
const title = (id, text, max = 100) => {
  const t = `${id}: ${text}`;
  return t.length > max ? `${t.slice(0, max - 1).replace(/\s+\S*$/, "")}…` : t;
};
const quote = (s) => JSON.stringify(s);

/** The test framework of the package that owns `file`: vitest, jest, or node:test. */
export function detectFramework(repo, file) {
  let dir = path.dirname(path.join(repo, file));
  while (dir.startsWith(repo)) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
      const p = JSON.parse(fs.readFileSync(pkg, "utf8"));
      const deps = { ...p.dependencies, ...p.devDependencies };
      if (deps.vitest) return { name: "vitest", package: path.relative(repo, dir) || "." };
      if (deps.jest) return { name: "jest", package: path.relative(repo, dir) || "." };
    }
    dir = path.dirname(dir);
  }
  return { name: "node:test", package: "." };
}

const HARNESS_EXPRESS = `
/** Mount a router on a throwaway app and call it over HTTP (no extra dependencies). */
async function call(router: import("express").Router, method: string, url: string, body?: unknown) {
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = app.listen(0);
  try {
    const { port } = server.address() as { port: number };
    const res = await fetch(\`http://127.0.0.1:\${port}\${url}\`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = text;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, body: json as any };
  } finally {
    server.close();
  }
}
`;

/**
 * @param opts { specPath, out (the test file's repo-relative path, for import paths), harness: "express" | null, symbols, bases }
 * @returns {{ framework, text, requirements: number, groups: number }}
 */
export function scaffold(repo, spec, opts = {}) {
  const parsed = parseSpec(spec);
  const resolve = makeResolver(repo, { aliases: parsed.aliases, bases: [...(opts.bases ?? []), ...parsed.bases] });
  const lines = spec.split("\n");

  // Requirements in spec order, with their text and resolved citations.
  const reqs = new Map();
  for (const c of parsed.citations) {
    if (!/^(FR|SC|NFR|AC)-?\d+/.test(c.fr)) continue;
    if (!reqs.has(c.fr)) reqs.set(c.fr, { id: c.fr, text: strip(lines[c.spec_line - 1]), cites: [] });
    const f = !c.bad && resolve(c.file).file;
    if (f) reqs.get(c.fr).cites.push({ file: f, start: c.start, end: c.end });
  }
  if (!reqs.size) throw new Error("no requirements with citations (FR-001 … [evidence: path:line]) found in the spec");

  // Group by the route (or file) of each requirement's first citation.
  const groups = new Map();
  for (const r of reqs.values()) {
    const c = r.cites[0];
    const sym = c && opts.symbols && enclosingSymbol(opts.symbols, c.file, c.start, c.end).symbol;
    const key = sym?.kind === "route" ? `${sym.name}` : c ? c.file : "(no resolvable citation)";
    if (!groups.has(key)) groups.set(key, { key, route: sym?.kind === "route" ? sym : null, file: c?.file, reqs: [] });
    groups.get(key).reqs.push(r);
  }

  // Acceptance scenarios, by user story.
  const stories = [];
  let story = null;
  for (const l of lines) {
    const h = l.match(/^###\s+(.*)$/);
    const st = h && parseStoryHeading(h[1]);
    if (st) stories.push((story = { title: `User Story ${st.n} - ${st.title}`, scenarios: [] }));
    else if (/^#{1,3}\s/.test(l)) story = null;
    else if (story && /^\s*\d+\.\s+\*\*Given\*\*/.test(l)) story.scenarios.push(l.replace(/\*\*/g, "").trim());
  }

  const fw = detectFramework(repo, [...reqs.values()].find((r) => r.cites[0])?.cites[0].file ?? ".");
  const out = opts.out ?? "veridic.test.ts";
  const relTo = (file) => {
    let p = path.posix.relative(path.posix.dirname(out), file).replace(/\.[cm]?[jt]sx?$/, "");
    return p.startsWith(".") ? p : `./${p}`;
  };
  const todo = fw.name === "node:test" ? "test.todo" : "it.todo";
  const imports =
    fw.name === "vitest"
      ? `import { describe, it, expect } from "vitest";`
      : fw.name === "jest"
        ? `// jest globals: describe, it, expect`
        : `import { describe, test } from "node:test";\nimport assert from "node:assert/strict";`;

  const body = [];
  body.push(`// veridic-spec: ${opts.specPath ? path.relative(repo, path.resolve(opts.specPath)) : "<spec path>"}`);
  body.push(`// Generated by \`veridic scaffold\`: one placeholder per requirement, named with its id.`);
  body.push(`// Replace each ${todo} with a real test, keep the id in the test name, and assert the behavior`);
  body.push(`// the requirement states. \`veridic tests\` links tests to requirements by that id.`);
  body.push(imports);
  if (opts.harness === "express") body.push(HARNESS_EXPRESS.trimEnd());
  for (const g of groups.values()) {
    body.push("");
    const hint = g.route ? `router: import router from ${quote(relTo(g.file))}; route ${g.route.name} (mounted path may add a prefix)` : `code: ${g.file}`;
    body.push(`describe(${quote(g.key)}, () => {`);
    body.push(`  // ${hint}`);
    for (const r of g.reqs) {
      body.push(`  // ${r.id}: ${r.text}`);
      if (r.cites.length) body.push(`  //   cites: ${r.cites.map((c) => `${c.file}:${c.start}${c.end !== c.start ? `-${c.end}` : ""}`).join(", ")}`);
      body.push(`  ${todo}(${quote(title(r.id, r.text))});`);
    }
    body.push(`});`);
  }
  if (stories.some((s) => s.scenarios.length)) {
    body.push("");
    body.push(`// Acceptance scenarios from the spec. Each should end up proven by a requirement test above.`);
    for (const s of stories) {
      if (!s.scenarios.length) continue;
      body.push(`// ${s.title}`);
      for (const sc of s.scenarios) body.push(`//   ${sc}`);
    }
  }
  return { framework: fw, text: body.join("\n") + "\n", requirements: reqs.size, groups: groups.size };
}
