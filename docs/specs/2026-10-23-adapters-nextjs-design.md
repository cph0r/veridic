# Framework adapters, and Next.js

Date: 2026-10-23. Status: approved, in progress (resumed 2026-10-23: the adapters leave Express unchanged, so there is no cost to cloudcrane). Project 1 of 3 (2: the spec layer for any
language; 3: Python/FastAPI).

## Goal

Veridic reads Next.js apps as well as it reads Express apps: every route with its guards,
what it does, what it returns and which tests reach it. To get there, the Express-specific
code moves behind one adapter interface, unchanged, and Next.js becomes the second adapter.

## Why

- Most of the people Veridic is for build on Next.js (v0, Lovable, Bolt, the Vercel
  templates). Today Veridic finds no routes there, so it can't split the app into parts, check
  guards, or tie tests to routes.
- Everything that analyses routes (effects, access, the contract check, parts, claim/done,
  the report: 17 consumers) reads one route list. Only producing that list, and a few
  framework idioms, is framework-specific. That is the seam.

## Research (2026-10-23)

No existing tool does what Veridic does (guards, effects, statuses, test reach); none gives
handler line ranges. What we reuse, all MIT, with credit in `NOTICE`:

- **OWASP Noir** (`owasp-noir/noir`): its Next.js, NestJS, Fastify, Hono and Koa analyzers as
  a checklist of edge cases, and its sample apps as test cases.
- **next-openapi-gen** (`tazo90/next-openapi-gen`): Next.js route and status inference.
- **nextjs-routes** (`tatethurston/nextjs-routes`): file path to URL (dynamic, catch-all,
  optional catch-all segments).
- **CodeQL's `.qll` models** (`github/codeql`, MIT for the library files only): `Next.qll` and
  `Express.qll` as the semantic checklist. The CodeQL CLI itself is not used (its terms forbid
  private repos without a licence, and redistribution).

Not used: Semgrep rules (licence forbids distribution), Bearer (ELv2, no routes), ExpressO
(GPL, needs the app running), closed tools. No new runtime dependency.

## Design

### 1. The adapter interface

`core/frameworks/` holds one module per framework:

```js
export default {
  name: "nextjs",
  detect(g),        // true when the repo (or a package in it) uses the framework
  routes(g),        // [{ id, method, path, file, start, end, guards: [{ name, at }], framework }]
  idioms: {         // regular expressions the shared analysis reads handlers with
    body,           // request body reads:   req.body.x | (await req.json()).x | formData.get("x")
    status,         // statuses sent:        res.status(404) | NextResponse.json(x, { status: 404 })
    caller,         // the caller's identity: req.user.id | session.user.id | (await auth()).userId
  },
};
```

- `routeInventory(g)` stays the one entry point: it runs every adapter whose `detect` is true
  and returns their routes together, each tagged with its `framework`. Its output shape doesn't
  change, so the 17 consumers don't either.
- Effects, access, the contract check, test reach, specs and the dashboard stay shared: Next.js
  handlers are JavaScript. Where they read an Express idiom today (`req.body`, `res.status`,
  `req.user`), they read the route's adapter idioms instead.

### 2. Express behind the interface, unchanged

`core/routes.mjs`'s discovery moves to `core/frameworks/express.mjs` as is. The proof is that
nothing moves: before the refactor, snapshot `routeInventory`, `accessMatrix`, effects and
contract drift on RealWorld, Gobbles and cloudcrane-launchpad; after, they're byte-identical,
and every metric (`test/metrics-baseline.mjs`) and the private acceptance test pass.

### 3. Next.js

**Routes**

- App router: `app/**/route.{ts,js}` (also under `src/`), one route per exported
  `GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS` (function or `const`), its extent the function's.
  Folders give the path: `(group)` drops, `[id]` is `:id`, `[...slug]` and `[[...slug]]` are
  `*`, `@slot` and `_private` folders are skipped. `basePath` from `next.config` when it's a
  literal.
- Pages router: `pages/api/**`: the default export; its methods from `req.method === "POST"`
  branches, else `ALL`.
- Server actions: exported async functions in files starting with `"use server"`, and
  functions whose body starts with it. They're routes too (`ACTION app/x/actions.ts#name`),
  so parts, guards, effects and tests cover them.
- A monorepo: each package whose `package.json` depends on `next`.

**Guards**

- `middleware.ts` (root or `src/`): a guard on every route its `config.matcher` covers (all
  when there's no matcher), when it can turn a request away (a redirect, or a 401/403 response),
  as for Express middleware.
- In the handler: a sign-in check that returns early: `auth()` / `getServerSession()` (Auth.js),
  `auth()` / `currentUser()` (Clerk), `supabase.auth.getUser()`, followed by a 401/403 response
  or a `redirect(…)`.
- Scoping: the caller's id from those (`session.user.id`, `userId`, `user.id`) used in the
  query, as `req.user.id` is for Express.

**Statuses**: `NextResponse.json(x, { status })`, `new Response(…, { status })`,
`Response.json`, `NextResponse.redirect` (307), `notFound()` (404), `redirect()` (307), and
`res.status()` in `pages/api`. Thrown error classes are followed as for Express.

**Effects**: the existing SQL, Prisma and Drizzle models, plus Supabase
(`.from("t").insert/update/upsert/delete`) and Stripe calls that move money.

**Screens**: already read from the app router; unchanged.

### 4. Proof

- Tests: Noir's Next.js sample apps (copied with its MIT notice) as golden files, with their
  endpoints plus the guards, statuses and line ranges we add; small fixtures for each case in §3.
- Benchmark: 4 to 6 public Next.js apps pinned to commits in veridic-bench, every route,
  guard and effect checked by hand, chosen to cover both routers, server actions, middleware,
  Auth.js/Clerk/Supabase, and Prisma/Drizzle/Supabase (candidates: nextjs/saas-starter,
  shadcn-ui/taxonomy, elie222/inbox-zero, mfts/papermark). Target: every route found, as on
  Express (353 of 353), and the flagged problems published with their verdicts.

## Out of scope

- tRPC procedures and GraphQL resolvers (a later adapter each).
- Routes computed at run time (dynamic `export const dynamic`, rewrites in `next.config`).
- Other frameworks and languages (projects 2 and 3). Noir as an optional cross-check comes
  with project 2.
- Running Next.js or its build: everything is read from source.

## Testing

- Refactor: the snapshots above, identical; the full suite; metrics on three apps.
- Next.js: a test per rule in §3 (route paths from folders, each export a route, server
  actions, middleware matchers, each sign-in check, each status form, Supabase effects);
  Noir's sample apps as golden files; the benchmark apps.
