// Spec coverage: how much of the app its specs describe. A behaviour file is
// covered when any rule in any spec cites a line in it. Files nobody needs to
// spec (tests, generated code, types, config, seeds) are left out, each with its
// reason, never silently. Per part: the app's modules and its screen groups.

import fs from "node:fs";
import path from "node:path";
import { isTestFile, codeOnly } from "./graph.mjs";
import { repoFiles, makeResolver } from "./citations.mjs";

const SOURCE = /\.[cm]?[jt]sx?$/;

/** Why a file needs no spec, or null when it is behaviour. `head` is its first 10 lines. */
export function skipReason(file, head, text) {
  if (isTestFile(file) || /(^|\/)(testkit|fixtures|__mocks__)\//.test(file)) return "test";
  if (/\/generated\//.test(file) || /@generated|do not edit|auto-?generated/i.test(head)) return "generated";
  if (/\.d\.[cm]?ts$/.test(file)) return "types only";
  if (/(^|\/)[^/]*\.config\.[cm]?[jt]s$|(^|\/)build\.[cm]?[jt]s$|(^|\/)(eslint|vite|vitest|jest|tsconfig)[^/]*$/.test(file)) return "config or build";
  if (/(^|\/)scripts\/|(^|\/)seeds?\b|seedData/.test(file)) return "seed or script";
  if (!/\b(function|class|const|let|var)\b|=>|module\.exports|exports\./.test(codeOnly(text()))) return "types only";
  return null;
}

const headOf = (abs) => {
  try {
    const fd = fs.openSync(abs, "r");
    const buf = Buffer.alloc(2048);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return buf.toString("utf8", 0, n).split("\n").slice(0, 10).join("\n");
  } catch {
    return "";
  }
};
const read = (abs) => { try { return fs.readFileSync(abs, "utf8"); } catch { return ""; } };

/**
 * @param data collectReport output: specs[].requirements[].cites[], modules[].files/code, screens[].files
 * @returns { behaviour, covered, pct, parts, orphans, orphanFolders, skipped, cited }
 */
export function specCoverage(repo, data, { files } = {}) {
  const all = files ?? repoFiles(repo);
  const resolve = makeResolver(repo, { files: all });
  const cited = new Map(); // file -> spec paths citing it
  for (const s of data.specs ?? [])
    for (const r of s.requirements ?? [])
      for (const c of r.cites ?? []) {
        const f = resolve(c.file ?? String(c.cite ?? "").replace(/:.*$/, "")).file;
        if (!f) continue;
        if (!cited.has(f)) cited.set(f, []);
        if (!cited.get(f).includes(s.path)) cited.get(f).push(s.path);
      }

  const behaviour = [], skipped = [];
  for (const f of all.filter((x) => SOURCE.test(x)).sort()) {
    const abs = path.join(repo, f);
    const why = skipReason(f, headOf(abs), () => read(abs));
    if (why) skipped.push({ file: f, reason: why });
    else behaviour.push(f);
  }
  const isBehaviour = new Set(behaviour);

  const part = (id, name, kind, list) => {
    const fs_ = [...new Set(list)].filter((f) => isBehaviour.has(f));
    const uncovered = fs_.filter((f) => !cited.has(f));
    return { id, name, kind, total: fs_.length, covered: fs_.length - uncovered.length, uncovered };
  };
  const parts = [
    ...(data.modules ?? []).map((m) => part(m.id, m.name, "module", [...(m.files ?? []), ...(m.code ?? [])])),
    ...(data.screens ?? []).map((s) => part(s.id, s.name, "screens", s.files ?? [])),
  ].filter((p) => p.total);
  const inPart = new Set([...(data.modules ?? []).flatMap((m) => [...(m.files ?? []), ...(m.code ?? [])]), ...(data.screens ?? []).flatMap((s) => s.files ?? [])]);
  // In no part and cited by no spec: what still needs a home.
  const orphans = behaviour.filter((f) => !inPart.has(f) && !cited.has(f));
  const folders = new Map();
  for (const f of orphans) { const d = path.posix.dirname(f).split("/").slice(0, 4).join("/"); if (!folders.has(d)) folders.set(d, []); folders.get(d).push(f); }
  const orphanFolders = [...folders].map(([folder, list]) => ({ folder, files: list })).sort((a, b) => b.files.length - a.files.length);

  const covered = behaviour.filter((f) => cited.has(f)).length;
  return { behaviour: behaviour.length, covered, pct: behaviour.length ? Math.round((100 * covered) / behaviour.length) : 0, parts, orphans, orphanFolders, skipped, cited };
}

/** For people: the share, each part's uncovered files, what's in no part, what's skipped and why. */
export function coverageMarkdown(c, { module } = {}) {
  const L = [`Covered: ${c.covered} of ${c.behaviour} behaviour files (${c.pct}%)`];
  const parts = module ? c.parts.filter((p) => p.id === module) : c.parts;
  for (const p of parts) {
    L.push("", `## ${p.name}${p.kind === "screens" ? " (screens)" : ""}: ${p.covered}/${p.total}`);
    for (const f of p.uncovered) L.push(`- ${f}`);
  }
  if (!module) {
    if (c.orphanFolders.length) {
      L.push("", `## In no part: ${c.orphans.length}`);
      for (const g of c.orphanFolders) L.push(`- ${g.folder}/ (${g.files.length})`);
    }
    if (c.skipped.length) {
      L.push("", `## Skipped: ${c.skipped.length}`);
      const by = new Map();
      for (const s of c.skipped) by.set(s.reason, (by.get(s.reason) ?? 0) + 1);
      for (const [r, n] of by) L.push(`- ${r}: ${n}`);
    }
  }
  return L.join("\n") + "\n";
}
