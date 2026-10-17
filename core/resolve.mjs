// Resolving an import to a file in the repo: relative paths, and the aliases
// projects set up for themselves: tsconfig/jsconfig `paths` (`"~/*": ["./*"]`),
// package.json `_moduleAliases` (module-alias) and `imports` (`"#lib/*"`).

import fs from "node:fs";
import path from "node:path";
import { jsonc } from "./routes.mjs";

const EXT = (base) => [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}/index.ts`, `${base}/index.js`];

/** resolve(fromFile, spec) -> repo-relative file or null, for a graph-like { repo }. */
export function importResolver(repo) {
  const exists = (rel) => {
    try {
      return fs.statSync(path.join(repo, rel)).isFile();
    } catch {
      return false;
    }
  };
  const withExt = (base) => EXT(base.replace(/\.[cm]?js$/, "")).find(exists) ?? null;
  const read = (rel) => {
    try {
      return JSON.parse(jsonc(fs.readFileSync(path.join(repo, rel), "utf8")));
    } catch {
      return null;
    }
  };
  // Aliases visible from a directory: the nearest tsconfig/jsconfig and package.json.
  const cache = new Map();
  const aliasesFrom = (dir) => {
    if (cache.has(dir)) return cache.get(dir);
    const list = [];
    let found = { config: false, pkg: false };
    for (let d = dir; ; d = path.posix.dirname(d)) {
      const at = (name) => (d === "." ? name : path.posix.join(d, name));
      for (const name of found.config ? [] : ["tsconfig.json", "jsconfig.json"]) {
        const cfg = exists(at(name)) && read(at(name));
        if (!cfg) continue;
        found.config = true;
        const co = cfg.compilerOptions ?? {};
        const base = path.posix.join(d, co.baseUrl ?? ".");
        for (const [k, v] of Object.entries(co.paths ?? {})) if (k !== "*") list.push({ prefix: k.replace(/\*$/, ""), wild: k.endsWith("*"), to: v.map((t) => path.posix.join(base, t.replace(/\*$/, ""))) });
        break;
      }
      const pkg = !found.pkg && exists(at("package.json")) && read(at("package.json"));
      if (pkg) {
        found.pkg = true;
        for (const [k, v] of Object.entries(pkg._moduleAliases ?? {})) list.push({ prefix: `${k}/`, wild: true, to: [path.posix.join(d, v)] }, { prefix: k, wild: false, to: [path.posix.join(d, v)] });
        for (const [k, v] of Object.entries(pkg.imports ?? {})) if (typeof v === "string") list.push({ prefix: k.replace(/\*$/, ""), wild: k.endsWith("*"), to: [path.posix.join(d, v.replace(/\*$/, ""))] });
      }
      if (d === "." || d === "" || d === "/") break;
    }
    cache.set(dir, list);
    return list;
  };
  return (fromFile, spec) => {
    if (spec.startsWith(".")) return withExt(path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec)));
    for (const a of aliasesFrom(path.posix.dirname(fromFile))) {
      if (!(a.wild ? spec.startsWith(a.prefix) : spec === a.prefix)) continue;
      for (const t of a.to) {
        const hit = withExt(a.wild ? path.posix.join(t, spec.slice(a.prefix.length)) : t);
        if (hit) return hit;
      }
    }
    return null;
  };
}
