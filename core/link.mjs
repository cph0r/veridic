// Link existing tests to rules: the agent decides which tests really check a rule, and
// Veridic puts the rule id at the front of each title, in one call, instead of the agent
// editing titles one at a time. Only the title changes; only test files are touched.

import fs from "node:fs";
import path from "node:path";
import { isTestFile } from "./graph.mjs";

const TITLE_AT = /(?<![\w$.])(x?)(it|test|describe)(?:\.\w+)?\s*\(\s*(["'`])((?:(?!\3).)*)\3/;
const TAG = String.raw`[A-Z]+-\d+[a-z]?(?:\s+VC\d+)?(?:\s*\([\w-]+\))?`;
// A title that already starts with ids: "FR-002: …", "FR-002 (auth), INV-1: …".
const NAMED = new RegExp(String.raw`^(${TAG}(?:\s*,\s*${TAG})*)\s*:\s*`);

/**
 * @param links {id, at: "file:line"}[]
 * @param opts.module, opts.qualify: ids written as "FR-002 (module)" (ids shared with another spec)
 * @returns { linked: {id, at, title}[], skipped: {id, at, reason}[] }
 */
export function linkTests(repo, links, { module = null, qualify = new Set() } = {}) {
  const linked = [], skipped = [];
  const files = new Map();
  for (const { id, at } of links) {
    const [, file, ln] = at.match(/^(.*):(\d+)$/) ?? [null, at, null];
    const skip = (reason) => skipped.push({ id, at, reason });
    if (!isTestFile(file)) { skip("not a test file"); continue; }
    if (!files.has(file)) {
      try {
        files.set(file, fs.readFileSync(path.join(repo, file), "utf8").split("\n"));
      } catch {
        skip("no such file");
        continue;
      }
    }
    const lines = files.get(file), i = Number(ln) - 1;
    const m = lines[i]?.match(TITLE_AT);
    if (!m) { skip("no test title on that line"); continue; }
    if (m[2] === "describe") { skip("describe block, not a test"); continue; }
    const title = m[4];
    if (new RegExp(String.raw`\b${id}\b`).test(title)) { skip(`already named ${id}`); continue; }
    const tag = qualify.has(id) && module ? `${id} (${module})` : id;
    const named = title.match(NAMED);
    const next = named ? `${named[1]}, ${tag}: ${title.slice(named[0].length)}` : `${tag}: ${title}`;
    const start = m.index + m[0].length - m[4].length - 1;
    lines[i] = lines[i].slice(0, start) + next + lines[i].slice(start + title.length);
    linked.push({ id, at, title: next });
  }
  for (const [file, lines] of files) if (linked.some((l) => l.at.startsWith(file + ":"))) fs.writeFileSync(path.join(repo, file), lines.join("\n"));
  return { linked, skipped };
}

/** `ID=file:line[,line…]` arguments, for one module: ids its spec shares with another get the module's name. */
export async function linkForModule(repo, moduleId, args, opts = {}) {
  const links = [], bad = [];
  for (const a of args) {
    const m = a.match(/^([A-Z]+-\d+[a-z]?)=(.+):([\d,]+)$/);
    if (!m) { bad.push({ id: a, at: null, reason: "expected ID=file:line" }); continue; }
    for (const ln of m[3].split(",").filter(Boolean)) links.push({ id: m[1], at: `${m[2]}:${ln}` });
  }
  const { workList } = await import("./worklist.mjs");
  const wl = await workList(repo, moduleId, { data: opts.data });
  const qualify = new Set((wl.rules ?? []).filter((r) => r.ambiguous).map((r) => r.id));
  const r = linkTests(repo, links, { module: moduleId, qualify });
  return { module: moduleId, linked: r.linked, skipped: [...bad, ...r.skipped] };
}

export function linkMarkdown(r) {
  const L = [`Linked ${r.linked.length} test${r.linked.length === 1 ? "" : "s"}`];
  for (const l of r.linked) L.push(`- ${l.id}: \`${l.at}\` ${l.title}`);
  if (r.skipped.length) L.push("", "Not linked:", ...r.skipped.map((s) => `- ${s.id}${s.at ? ` \`${s.at}\`` : ""}: ${s.reason}`));
  L.push("", `Next: veridic tests --module ${r.module}`);
  return L.join("\n") + "\n";
}
