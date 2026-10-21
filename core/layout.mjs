// Which side of the app a file is on: the server (what the routes run) or the
// frontend (its screens). Two layouts are common: separate packages (an API package
// and a web package), and one package with both (`src/server` and `src/client`).
// A package with routes is the server's; inside it, a top folder that holds JSX and
// no route file is the frontend's. A package without routes that holds JSX is the
// frontend's.

import fs from "node:fs";
import path from "node:path";

const JSX = /\.(?:[jt]sx|vue|svelte)$/;
const GENERIC = new Set(["src", "app", "lib", "packages", "apps"]);

/**
 * @param all files to classify (relative paths)
 * @param routeFiles the files that declare the server's routes
 * @returns { isClient(f), isServer(f), pkgOf(f) }
 */
export function sides(repo, all, routeFiles) {
  const memo = new Map();
  const pkgOf = (f) => {
    const walked = [];
    let d = path.posix.dirname(f);
    for (;;) {
      if (memo.has(d)) break;
      walked.push(d);
      if (fs.existsSync(path.join(repo, d, "package.json")) || d === "." || d === "") { memo.set(d, d === "." ? "" : d); break; }
      d = path.posix.dirname(d);
    }
    for (const w of walked) memo.set(w, memo.get(d));
    return memo.get(d);
  };
  // A file's top folder inside its package: src/server/x.ts -> src/server; client/x.ts -> client.
  const topOf = (f) => {
    const pkg = pkgOf(f);
    const rest = (pkg ? f.slice(pkg.length + 1) : f).split("/");
    const n = GENERIC.has(rest[0]) && rest.length > 2 ? 2 : 1;
    return [pkg, ...rest.slice(0, Math.min(n, rest.length - 1))].filter(Boolean).join("/");
  };
  const serverPkgs = new Set(routeFiles.map(pkgOf));
  const routeTops = new Set(routeFiles.map(topOf));
  const jsxPkgs = new Set(), jsxTops = new Set();
  for (const f of all) if (JSX.test(f)) { jsxPkgs.add(pkgOf(f)); jsxTops.add(topOf(f)); }
  const isClient = (f) => {
    const pkg = pkgOf(f);
    if (!serverPkgs.has(pkg)) return jsxPkgs.has(pkg);
    const top = topOf(f);
    return jsxTops.has(top) && !routeTops.has(top);
  };
  const isServer = (f) => serverPkgs.has(pkgOf(f)) && !isClient(f);
  return { isClient, isServer, pkgOf };
}
