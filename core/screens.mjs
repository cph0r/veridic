// Screen groups: a frontend's pages grouped by who uses them, so each group gets
// a spec of its own (specs/<area>-app/spec.md; the group's id is <area>-app, so it
// never clashes with a server module's id). A page's area is the first segment of
// its URL in the router (/admin/orders -> admin), else the first word of its path
// under pages/ (pages/owner/clients.tsx, owner-dashboard.tsx -> owner). Pages with
// no segment, and areas with a single page, are the guest screens. A group holds
// its pages and the components, hooks and lib files only its pages import; a file
// pages of several groups import is shared UI, in no group.

import fs from "node:fs";
import path from "node:path";
import { importResolver } from "./resolve.mjs";
import { isTestFile } from "./graph.mjs";
import { makeResolver } from "./citations.mjs";
import { sides } from "./layout.mjs";

const UI = /\.(?:[cm]?[jt]sx?|vue|svelte)$/;
const JSX = /\.(?:[jt]sx|vue|svelte)$/;
const SKIP = /(^|\/)(node_modules|dist|build|coverage|\.next|\.nuxt|\.codegraph|\.veridic|vendor)\//;
const PAGES = /(^|\/)(pages?|views|screens)\//;
const HELPERS = /^(components?|hooks?|lib|utils?|sections?|context|api|types?|constants?|styles?)$/;

const title = (s) => s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * @param all every repo file (relative paths)
 * @param routes the server's routes (their packages are not frontend)
 * @param specs report specs: [{ path, requirements: [{ cites: [{ file }] }] }]
 * @param ui linkUi's files: [{ file, routes }] (the API calls each makes)
 * @returns [{ id, name, pages, urls, files, calls, spec_path, specs }]
 */
export function screenGroups(repo, { all, routes = [], specs = [], ui = [] }) {
  const read = (f) => { try { return fs.readFileSync(path.join(repo, f), "utf8"); } catch { return ""; } };
  const uiAll = all.filter((f) => UI.test(f) && !SKIP.test(f) && !isTestFile(f));
  const uiSet = new Set(uiAll);
  const side = sides(repo, uiAll, routes.filter((r) => r.file).map((r) => r.file));
  const front = uiAll.filter(side.isClient);
  if (!front.length) return [];
  const resolve = importResolver(repo);
  const importMemo = new Map();
  const imports = (f) => {
    if (importMemo.has(f)) return importMemo.get(f);
    const out = new Set();
    for (const m of read(f).matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g)) {
      const hit = resolve(f, m[1]);
      const file = typeof hit === "string" ? hit : hit?.file;
      if (file && uiSet.has(file)) out.add(file);
    }
    importMemo.set(f, [...out]);
    return importMemo.get(f);
  };

  // The router: <Route path="/admin/orders" component={X} />, element={<X />}, or { path, element|component }.
  const urlOf = new Map(); // page file -> URL
  for (const f of front.filter((x) => JSX.test(x))) {
    const src = read(f);
    if (!/\bpath\s*[=:]/.test(src)) continue;
    const ids = new Map();
    for (const m of src.matchAll(/import\s+([\w$]+)\s+from\s+["']([^"']+)["']/g)) ids.set(m[1], m[2]);
    for (const m of src.matchAll(/(?:const|let)\s+([\w$]+)\s*=\s*lazy\(\s*\(\)\s*=>\s*import\(\s*["']([^"']+)["']/g)) ids.set(m[1], m[2]);
    const pairs = [];
    for (const m of src.matchAll(/<Route\b([^>]*?)\/?>/g)) {
      const p = m[1].match(/\bpath\s*=\s*\{?\s*["'`]([^"'`]*)["'`]/)?.[1];
      const c = m[1].match(/\b(?:component|element)\s*=\s*\{\s*<?\s*([\w$]+)/)?.[1];
      if (p && c) pairs.push([p, c]);
    }
    for (const m of src.matchAll(/\bpath\s*:\s*["'`]([^"'`]*)["'`][^{}]{0,200}?\b(?:element|component|Component)\s*:\s*<?\s*([\w$]+)/g)) pairs.push([m[1], m[2]]);
    for (const [p, c] of pairs) {
      const spec = ids.get(c);
      const hit = spec && resolve(f, spec);
      const file = typeof hit === "string" ? hit : hit?.file;
      if (file && uiSet.has(file) && !urlOf.has(file)) urlOf.set(file, p.startsWith("/") ? p : "/" + p);
    }
  }

  // Next.js app router: app/admin/orders/page.tsx is /admin/orders ((group) folders drop, [id] is :id).
  for (const f of front) {
    const m = f.match(/(?:^|\/)app\/((?:[^/]+\/)*)page\.[jt]sx$/);
    if (m && !urlOf.has(f)) urlOf.set(f, "/" + m[1].split("/").filter((x) => x && !/^\(.*\)$/.test(x)).map((x) => x.replace(/^\[+\.*([^\]]+)\]+$/, ":$1")).join("/"));
  }
  // Pages: what the router shows, and the files right under a pages folder.
  const underPages = (f) => { const m = f.match(/(?:^|\/)(?:pages?|views|screens)\/(.*)$/); return m ? m[1] : null; };
  const isPage = (f) => {
    if (urlOf.has(f)) return true;
    const rest = underPages(f);
    if (!rest || !JSX.test(f)) return false;
    const parts = rest.split("/");
    if (parts.length === 1 || (parts.length === 2 && /^index\./.test(parts[1]))) return true;
    // A page in an area folder (pages/owner/clients.tsx): a default-exported component or a
    // `…Page` one,
    // not inside a helper folder (pages/order/components/…).
    return parts.length === 2 && !HELPERS.test(parts[0]) && /export\s+default\b|export\s+(?:async\s+)?(?:function|const)\s+[A-Z][\w$]*Page\b/.test(read(f));
  };
  const pages = front.filter(isPage);
  const areaOf = (f) => {
    const url = urlOf.get(f);
    if (url != null) { const seg = url.split("/").filter(Boolean)[0]; return seg && !/^[:*]/.test(seg) ? seg.toLowerCase() : "guest"; }
    const rest = underPages(f) ?? path.posix.basename(f);
    return rest.split("/")[0].replace(/\.[^.]+$/, "").split(/[-_.]/)[0].toLowerCase() || "guest";
  };
  const area = new Map(pages.map((p) => [p, areaOf(p)]));
  const count = new Map();
  for (const a of area.values()) count.set(a, (count.get(a) ?? 0) + 1);
  for (const [p, a] of area) if ((count.get(a) ?? 0) < 2) area.set(p, "guest");

  // Each file joins the one area whose pages reach it through imports.
  const reachedBy = new Map(); // file -> Set(areas)
  for (const p of pages) {
    const a = area.get(p);
    const seen = new Set([p]);
    const queue = [p];
    while (queue.length) {
      const f = queue.shift();
      if (!reachedBy.has(f)) reachedBy.set(f, new Set());
      reachedBy.get(f).add(a);
      for (const n of imports(f)) if (!seen.has(n)) { seen.add(n); queue.push(n); }
    }
  }
  const pageSet = new Set(pages);
  const groups = new Map();
  for (const [f, as] of reachedBy) {
    const a = pageSet.has(f) ? area.get(f) : as.size === 1 ? [...as][0] : null;
    if (!a) continue;
    if (!groups.has(a)) groups.set(a, { pages: [], files: [] });
    groups.get(a).files.push(f);
    if (pageSet.has(f)) groups.get(a).pages.push(f);
  }

  // The specs that already describe a group: those citing its files, most first.
  const resolveCite = makeResolver(repo, { files: all });
  const citedBy = new Map();
  for (const s of specs) for (const r of s.requirements ?? []) for (const c of r.cites ?? []) {
    const f = resolveCite(c.file ?? String(c.cite ?? "").replace(/:.*$/, "")).file;
    if (!f) continue;
    if (!citedBy.has(f)) citedBy.set(f, new Set());
    citedBy.get(f).add(s.path);
  }
  return [...groups]
    .map(([id, g]) => {
      const n = new Map();
      for (const f of g.files) for (const sp of citedBy.get(f) ?? []) n.set(sp, (n.get(sp) ?? 0) + 1);
      const callsOf = new Map(ui.map((u) => [u.file, u.routes ?? []]));
      const calls = [...new Set(g.files.flatMap((f) => callsOf.get(f) ?? []))].sort();
      const urls = Object.fromEntries(g.pages.filter((p) => urlOf.has(p)).map((p) => [p, urlOf.get(p)]));
      return { id: `${id}-app`, name: `${title(id)} screens`, pages: g.pages.sort(), urls, files: g.files.sort(), calls, spec_path: `specs/${id}-app/spec.md`, specs: [...n].sort((a, b) => b[1] - a[1]).map(([sp]) => sp) };
    })
    .sort((a, b) => b.pages.length - a.pages.length);
}
