// The app's routes, from every framework adapter that applies (core/frameworks/): each route
// with its full URL, its handler extent and the guards above it.

import { adapters } from "./frameworks/index.mjs";
export { jsonc, joinPath, normRoute, parseRouteId, dedupe } from "./frameworks/paths.mjs";

/**
 * Every route of the app, each tagged with the framework that found it. The rest of the
 * result (entry, mounts, unmounted route files) is Express's.
 */
export function routeInventory(g, opts = {}) {
  let out = null;
  const routes = [];
  for (const a of adapters) {
    if (!a.detect(g)) continue;
    const r = a.routes(g, opts);
    if (!out) out = r;
    for (const route of r.routes) routes.push({ ...route, framework: a.name });
  }
  routes.sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start);
  return { ...out, routes };
}
