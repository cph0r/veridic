# Framework adapters and Next.js: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Veridic reads Next.js apps (routes, guards, statuses, effects, tests) as it reads Express, with Express moved behind one adapter interface unchanged.

**Architecture:** `routeInventory(g)` stays the single entry point and merges the routes of every framework adapter in `core/frameworks/` whose `detect(g)` is true. Express's discovery moves to `core/frameworks/express.mjs` byte-for-byte; `core/frameworks/nextjs.mjs` reads routes from files. Shared analysis (effects, access, contract, tests) reads framework idioms from the route's adapter.

**Tech Stack:** Node 22.5+ ESM, `node:test`, no new runtime dependency; CodeGraph index (`openGraph`).

**Spec:** `docs/specs/2026-10-23-adapters-nextjs-design.md`

## Global Constraints

- No new runtime dependency; nothing read from the network; no build or run of the target app.
- Express output unchanged: Task 1's snapshots byte-identical on RealWorld, Gobbles and cloudcrane-launchpad (the route `framework` field excepted), every metric in `test/metrics-baseline.mjs` identical, `npm test` (incl. the git-ignored acceptance test) green.
- Code or fixtures taken from Noir, next-openapi-gen, nextjs-routes or CodeQL carry their MIT notice in `NOTICE` (repo root) and a one-line credit comment where used.
- Private apps (Gobbles, launchpad) never appear in committed fixtures, docs or the benchmark.
- Each phase ends with a checkpoint run on the sample repos, shown to the user before the next phase starts.

## Review Focus

1. Route handlers re-exported (`export { handler as GET, handler as POST }`, Auth.js's `export const { GET, POST } = handlers`): each method is a route, its extent the handler's. Test in Task 4.
2. A monorepo with an Express server and a Next.js app side by side: both adapters' routes, no route twice, Express's unchanged. Test in Task 7.
3. The common middleware matcher `"/((?!api|_next/static|_next/image|favicon.ico).*)"` and `"/dashboard/:path*"`: which routes it covers. Test in Task 9.
4. Non-handler exports in a `route.ts` (`runtime`, `dynamic`, `revalidate`, `config`, helpers) are not routes. Test in Task 4.
5. A Next.js app with no API routes, only pages and server actions: its actions are routes and form parts. Test in Task 6.

---

## Phase 1: the adapter interface, Express unchanged

### Task 1: Snapshot tool and baselines

**Files:**
- Create: `test/adapter-snapshot.mjs`

**Interfaces:**
- Produces: `node test/adapter-snapshot.mjs --repo <path> (--out <file> | --compare <file>)`; exit 1 on any difference, printing the first 40 differing paths.

- [ ] **Step 1:** Write the tool, modelled on `test/metrics-baseline.mjs`: `openGraph(repo)`, `routeInventory(g)` (entry, mounts, unmounted_route_files, each route without its `framework` field), `accessMatrix(g, inv)`, `effectManifest(g, inv)` (id, effect, moves_money, flags), and for a repo with an OpenAPI file, `drift()` operations. Keys sorted, routes sorted by id.
- [ ] **Step 2:** Capture baselines on `main`'s code into the scratchpad: `--out base-rw.json` for `$TMPDIR/veridic-bench/tests-realworld-B-90VHbt`, `base-gobbles.json`, `base-launchpad.json`. Expected: three files written.
- [ ] **Step 3:** Commit the tool: `git commit -m "test: adapter snapshot, to prove Express unchanged"`.

### Task 2: `core/frameworks/` with Express behind it

**Files:**
- Create: `core/frameworks/paths.mjs` (moved: `joinPath`, `normRoute`, `parseRouteId`, `jsonc`, `dedupe`), `core/frameworks/express.mjs`, `core/frameworks/index.mjs`
- Modify: `core/routes.mjs` (keeps re-exporting the moved helpers)
- Test: `test/generalize.test.mjs`

**Interfaces:**
- Produces: an adapter `{ name: string, detect(g): boolean, routes(g, opts): { routes: Route[], ...extra } }` where `Route = { id, method, path, file, start, end, node?, guards: [{ name, at }], handlerText?, framework }`; `adapters` (array, Express first) from `core/frameworks/index.mjs`; `routeInventory(g, opts)` returns Express's `{ entry, mounts, unmounted_route_files }` plus `routes` from every detected adapter, each tagged `framework`.

- [ ] **Step 1: Failing test** `"adapters: every route says which framework it comes from, and Express's routes are unchanged"`: on the `tenantRepo()` fixture, `routeInventory(g).routes.every((r) => r.framework === "express")`; `adapters.map((a) => a.name)` deep-equals `["express"]`.
- [ ] **Step 2:** Run it: FAIL (`framework` undefined).
- [ ] **Step 3:** Move `routeInventory`'s body to `express.routes(g, opts)` unchanged; `express.detect = () => true` (it runs on every repo today and finds nothing where there's no Express). `routeInventory` runs the detected adapters and concatenates their routes, sorted as today (file, then start), tagging each with its adapter's `name`.
- [ ] **Step 4:** `npm test`: all pass. Then Task 1's tool with `--compare` on the three repos: identical. Then `test/metrics-baseline.mjs --compare` on RealWorld and Gobbles: identical.
- [ ] **Step 5:** Commit: `"routes: framework adapters, Express the first"`.

### Task 3: Phase 1 checkpoint

- [ ] Run `veridic routes`, `veridic parts --md` and `veridic report` on RealWorld and launchpad, compare with `main` (identical), and show the user the snapshot and metric results. Stop until the user says go.

## Phase 2: Next.js routes

### Task 4: Sample repos, Noir fixtures, and app router routes

**Files:**
- Create: `test/samples.json`, `test/samples.mjs`, `test/fixtures/noir/` (Noir's `javascript/nextjs*` fixture dirs), `NOTICE`, `core/frameworks/nextjs.mjs`
- Modify: `core/frameworks/index.mjs` (adds `nextjs` after `express`)
- Test: `test/nextjs.test.mjs`

**Interfaces:**
- Produces: `test/samples.json` entries `{ name, url, sha }` for `nextjs/saas-starter@6e33e58b1e55`, `vercel/nextjs-subscription-payments@bdd0813206e4`, `shadcn-ui/taxonomy@298a8857c712`, `papermark/papermark@ed19717ec02a`, `elie222/inbox-zero@83290dedc535`; `node test/samples.mjs [name…]` clones each into `$TMPDIR/veridic-samples/<name>` at its sha (shallow fetch of that commit), runs `veridic init --no-specs --no-tests`, and prints its route count by method. `nextjs.detect(g)`: some `package.json` in `g.files` lists `next` in dependencies or devDependencies. `nextjs.routes(g)` → `{ routes }`; also exports `appPath(file): string | null` (the URL a `route.ts` / page folder serves).

- [ ] **Step 1: Failing tests**, each on a `fakeRepo` (copy the helper from `test/generalize.test.mjs` into a shared `test/fake.mjs`):
  - `"next: route.ts folders become paths"`: `app/(shop)/orders/[id]/route.ts` with `export async function GET` → `GET /orders/:id`; `src/app/api/[...slug]/route.ts` → `/api/*`; `app/docs/[[...slug]]/route.ts` → `/docs/*`; files under `@modal/` and `_lib/` are not routes; `basePath: "/app"` in `next.config.js` → `/app/orders/:id`.
  - `"next: each exported method is a route with its own extent"`: `export async function GET() {…}` (lines 1-3) and `export const POST = async () => {…}` (lines 5-8) → two routes with those start/end lines; `export const runtime = "edge"`, `export const dynamic = "force-dynamic"`, `export function helper()` → not routes.
  - `"next: re-exported handlers are routes"`: `export { handler as GET, handler as POST }` → GET and POST, each spanning `handler`'s lines; `export const { GET, POST } = handlers` (Auth.js) → GET and POST at that line.
  - `"next: Noir's nextjs fixtures"`: for each fixture dir, the routes equal Noir's expected endpoints (method + path, `{param}` written as `:param`), read from the matching `spec/functional_test/testers/javascript/nextjs*_spec.cr` and stored as `expected.json` beside each fixture.
- [ ] **Step 2:** Run `node --test test/nextjs.test.mjs`: FAIL (no adapter).
- [ ] **Step 3:** Implement `appPath` (credit nextjs-routes in a comment) and the app router part of `routes(g)`. Extents come from `bodyOf`-style brace matching after the declaration (reuse the one in `core/contract.mjs`, moved to `core/frameworks/paths.mjs` as `functionExtent(src, name): [start, end] | null`). `basePath` only when it's a string literal in `next.config.{js,mjs,ts}`.
- [ ] **Step 4:** Tests pass; `npm test` passes; Task 1 snapshots identical (Express repos aren't Next apps; Gobbles' frontend is Vite).
- [ ] **Step 5:** `node test/samples.mjs` on all five: print route counts. Commit: `"next: app router routes; sample repos and Noir's fixtures"`.

### Task 5: `pages/api` routes

**Files:** Modify `core/frameworks/nextjs.mjs`; Test `test/nextjs.test.mjs`

- [ ] **Step 1: Failing test** `"next: pages/api routes and their methods"`: `pages/api/users/[id].ts` whose default export branches on `req.method === "GET"` and `req.method === "DELETE"` → `GET /api/users/:id` and `DELETE /api/users/:id`; a handler with no method check → `ALL /api/users/:id`; `switch (req.method) { case "POST": … }` → POST; `export default withAuth(handler)` → extent of `handler`; `pages/api/_middleware.ts` and files under `pages/` outside `api/` → not routes.
- [ ] **Step 2:** Run: FAIL. **Step 3:** Implement. **Step 4:** Pass + `npm test`. **Step 5:** Commit `"next: pages/api routes"`.

### Task 6: Server actions

**Files:** Modify `core/frameworks/nextjs.mjs`; Test `test/nextjs.test.mjs`

**Interfaces:**
- Produces: action routes `{ id: "ACTION <path>", method: "ACTION", path }` where `path` is `appPath` of the file's folder plus `/_action/<name>` for files under `app/`, and `/_action/<file basename without extension>/<name>` otherwise.

- [ ] **Step 1: Failing tests**:
  - `"next: exported functions of a 'use server' file are actions"`: `app/(dashboard)/settings/actions.ts` starting with `"use server"` and exporting `updateName` and `deleteAccount` → `ACTION /settings/_action/updateName` and `…/deleteAccount`, with their extents; a non-exported helper → not an action; `lib/actions.ts` with `'use server'` → `ACTION /_action/actions/sendInvite`.
  - `"next: a function whose body starts with 'use server' is an action"`.
  - `"next: an app with only pages and actions forms parts"` (Review Focus 5): `findModules(g, routeInventory(g))` gives at least one module holding the actions.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** Pass + `npm test`. **Step 5:** Commit `"next: server actions are routes"`.

### Task 7: Monorepos and the Phase 2 checkpoint

**Files:** Modify `core/frameworks/nextjs.mjs`; Test `test/nextjs.test.mjs`

- [ ] **Step 1: Failing tests**:
  - `"next: each package depending on next is its own app"`: `apps/web/app/api/x/route.ts` (package `apps/web` depends on next) → `GET /api/x` with `file` `apps/web/app/api/x/route.ts`; a package without next → nothing.
  - `"adapters: an Express server and a Next app side by side"` (Review Focus 2): Express routes from `server/` and Next routes from `web/`, each once, Express's identical to running the Express adapter alone.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** Pass; `npm test`; Task 1 snapshots identical; metrics identical.
- [ ] **Step 5: Checkpoint.** `node test/samples.mjs`; for each sample print routes by kind (route.ts, pages/api, action) and `veridic parts --md`. Hand-check one sample (saas-starter) route by route against its source and record mismatches in this plan's Results. Commit `"next: monorepos"`; show the user the table and stop until they say go.

## Phase 3: Next.js guards, statuses and effects

### Task 8: Adapter idioms in the shared analysis, and Next.js statuses

**Files:**
- Modify: `core/frameworks/express.mjs`, `core/frameworks/nextjs.mjs` (add `idioms`), `core/contract.mjs` (`handlerFacts` and `calledStatuses` read `idiomsOf(route)`)
- Create: `idiomsOf(route)` in `core/frameworks/index.mjs`
- Test: `test/nextjs.test.mjs`

**Interfaces:**
- Produces: `idioms = { status: RegExp /* global, group 1 = status */, body: RegExp /* global, group 1 = field */, caller: RegExp }`. Express's are today's regexes moved as is; `idiomsOf(route)` returns the route's adapter's idioms (Express's when `framework` is missing).

- [ ] **Step 1: Failing test** `"next: statuses from NextResponse, Response, notFound and redirect"`: a `route.ts` returning `NextResponse.json(x, { status: 404 })`, `new Response(null, { status: 204 })`, `Response.json(e, { status: 400 })`, calling `notFound()` and `redirect("/login")` → `handlerFacts` statuses include 404, 204, 400, 404, 307; `NextResponse.json(x)` alone → implicit 200. Body fields: `const { name } = await req.json()` and `formData.get("email")` → `name`, `email`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** Pass; `npm test`; Task 1 snapshots identical (Express idioms unchanged). **Step 5:** Commit `"adapters: idioms; Next.js statuses and request bodies"`.

### Task 9: Next.js guards and scoping

**Files:** Modify `core/frameworks/nextjs.mjs`, `core/access.mjs` (caller idioms from the route's adapter); Test `test/nextjs.test.mjs`

- [ ] **Step 1: Failing tests**:
  - `"next: middleware.ts guards the routes its matcher covers, when it can turn a request away"`: `middleware.ts` redirecting when there's no session, `matcher: ["/dashboard/:path*", "/api/private/:path*"]` → guard `middleware` on `/api/private/x`, not on `/api/public`; matcher `"/((?!api|_next/static|_next/image|favicon.ico).*)"` → guards `/settings/_action/x` but not `/api/x` (Review Focus 3); no `config` → every route; a middleware that only sets a header → no guard.
  - `"next: a sign-in check in the handler is a guard"`: each of `const session = await auth(); if (!session) return NextResponse.json(…, { status: 401 })`, `getServerSession(authOptions)` then `redirect("/login")`, Clerk `const { userId } = await auth(); if (!userId)`, Supabase `const { data: { user } } = await supabase.auth.getUser(); if (!user)` → a guard named after the call, `access` = `"auth"`; the same calls without an early return → no guard.
  - `"next: a record looked up by the session's user id is scoped"`: `where: { id, userId: session.user.id }` → `scoped` `"yes"`; `findUnique({ where: { id: params.id } })` after a sign-in check → flag `id-param-without-caller-scope`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement (matcher patterns: `:path*`, `:path+`, `(…)` regex groups, arrays). **Step 4:** Pass; `npm test`; snapshots identical. **Step 5:** Commit `"next: middleware and sign-in guards, caller scoping"`.

### Task 10: Supabase effects and the Phase 3 checkpoint

**Files:** Modify `core/effects.mjs`; Test `test/nextjs.test.mjs`

- [ ] **Step 1: Failing test** `"effects: Supabase writes and deletes"`: `supabase.from("posts").insert({ … })`, `.update({ … }).eq("id", id)`, `.upsert([…])` → write; `.from("posts").delete().eq(…)` → destructive; `.from("posts").select("*")` → read. And the Express repos' effects unchanged (snapshots).
- [ ] **Step 2:** FAIL. **Step 3:** Implement (only after a `.from(` call in the same chain). **Step 4:** Pass; `npm test`; snapshots and metrics identical. **Step 5:** Commit `"effects: Supabase"`.
- [ ] **Step 6: Checkpoint.** `veridic agent-ready --md` and `veridic report` on the five samples; hand-check saas-starter and nextjs-subscription-payments route by route (guard, scope, effect, statuses) and record every disagreement in Results. Show the user; stop until they say go.

## Phase 4: benchmark

### Task 11: Next.js apps in veridic-bench

**Files:** in `../veridic-bench`: `repos.json`, `verdicts.json`, `RESULTS.md`; in this repo: `README.md` (one line: "Express and Next.js")

- [ ] **Step 1:** Add the five samples to `repos.json` pinned to their shas, with each app's hand-checked route count.
- [ ] **Step 2:** Run the bench (`node run.mjs <names>`): routes found equal the hand count for each; record flagged problems with a verdict and reason in `verdicts.json`.
- [ ] **Step 3:** `RESULTS.md`: a Next.js table (routes found, problems flagged and confirmed). README's frameworks line. Commit in both repos; ask the user before pushing either.

## Results

(filled in at each checkpoint)
