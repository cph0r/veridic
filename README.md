<p align="center">
  <img src="assets/veridic.svg" alt="veridic" width="520">
</p>

<p align="center">
  <strong>Know what your code really does, with proof, before you change it.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/veridic"><img src="https://img.shields.io/npm/v/veridic?style=flat-square&color=0E7490&label=npm" alt="npm"></a>
  <img src="https://img.shields.io/badge/Claude%20Code-plugin-0E7490?style=flat-square" alt="Claude Code plugin">
  <img src="https://img.shields.io/badge/checks-deterministic%20%C2%B7%20no%20LLM-111111?style=flat-square" alt="Deterministic checks">
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2022.5-111111?style=flat-square" alt="Node 22.5+">
  <img src="https://img.shields.io/badge/license-MIT-111111?style=flat-square" alt="MIT">
</p>

---

Your agent can write a thousand lines an hour. Nobody can tell you what the
*existing* code does: the docs drifted, the spec was aspirational, half the
tests assert nothing, and that innocent `GET /payment-status` quietly marks
orders paid.

**Veridic reads your codebase and hands you facts with receipts.** Every
requirement it writes cites `file:line`. Every citation is checked by a script:
does the line exist, and does it actually say what the requirement claims?
Models read and reason; deterministic code gathers the facts and does the
checking. Nothing in the verdict can be talked into passing.

> **Why "Veridic"?** *Veridic* means truthful: corresponding to the facts. A
> Veridic spec says only what the code can prove, and the proof is a line number.
> (Formerly *Plumb*; `plumbcode` on npm now points here.)

## What you get

| | | |
|---|---|---|
| 📜 **Evidence-backed specs** | `/veridic:spec checkout` | Spec Kit–style requirements for code that already exists. Each one cites the lines that implement it, and `veridic check` proves the cited lines hold the facts the requirement states. |
| 🔁 **Specs that stay true** | `veridic stale --fix` | When code moves, citations follow it. When cited code *changes*, the requirement is flagged. Runs as a git pre-commit hook, a Claude Code Stop hook, or a GitHub Action. |
| 🧪 **Honest test coverage** | `veridic tests --run` | A requirement counts as tested only if a test named for it reaches the cited code **and asserts something**. Empty tests, `expect(true).toBe(true)`, `xit` and `describe.skip` don't count; `toBeTruthy`-only tests are called out as weak. |
| 🤖 **Agent readiness** | `veridic agent-ready` | What each route *really* does (read, write, destructive, moves money, notifies someone), traced through the code it calls. Finds GETs that write and money routes that act on ids the caller doesn't own, before you hand your API to an AI agent. |
| 🔎 **Risk finders** | `veridic scope`, `states`, `access`, `drift` | Everything that belongs to a feature (webhooks and timers included), timer races in state machines, routes missing ownership or paywall checks, and where your OpenAPI contract and the code disagree. |

## See it

A tiny Express app. One handler looks harmless:

```ts
// Polled by the checkout page.
ordersRouter.get("/orders/:id/payment-status", async (req, res) => {
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, Number(req.params.id)));
  const intent = await stripe.paymentIntents.retrieve(order.paymentIntentId);
  if (intent.status === "succeeded") await markPaid(order.id);
  res.json({ status: intent.status });
});
```

```console
$ veridic agent-ready --md
```

> 5 routes: 1 read, 3 write, 1 destructive; 2 move money; 1 GETs that write. **40%** have no medium or high issue.
>
> | Severity | Issue | Route | What | Evidence |
> |---|---|---|---|---|
> | high | get-that-writes | `GET /api/orders/:id/payment-status` | GET that writes and moves money: a tool scanner going by method would call it a safe read | `src/routes/orders.ts:40 via markPaid`, `src/routes/orders.ts:22` |
> | high | id-param-without-caller-scope | `GET /api/orders/:id/payment-status` | write, moves money, and acts on an id the caller isn't checked to own | `src/routes/orders.ts:20-25` |
> | high | id-param-without-caller-scope | `POST /api/orders/:id/refund` | write, moves money, and acts on an id the caller isn't checked to own | `src/routes/orders.ts:27-32` |
> | high | id-param-without-caller-scope | `DELETE /api/orders/:id` | destructive, and acts on an id the caller isn't checked to own | `src/routes/orders.ts:34-37` |

Every finding points at a line. `--manifest` emits the full per-route tool
manifest (effect, money, notifications, auth, body fields, responses) as JSON.

## Measured, not vibes

Veridic was built against two production Express codebases and compared with a
plain Claude Code session (Opus, no Veridic) writing the same feature spec.

| | Baseline | Veridic (`/veridic:spec`, Sonnet) |
|---|---|---|
| **App A** (152 routes, payments): cost per spec | $2.46 | **$0.94** |
| time | 6.6 min | **4.3 min** |
| requirement facts actually in the cited lines | 89% | **100%** |
| known money-losing bugs surfaced | 2 of 2 | **2 of 2, every run** |
| **App B** (57 routes, subscriptions): cost per spec | $1.13 | **$0.42** |
| time | 3.0 min | **1.8 min** |
| requirement facts actually in the cited lines | 79% | **100%** |

Its own checks are held to the same bar:

- **Test honesty:** across 1,780 existing tests it flagged 7 (6 weak, 1 asserting nothing); all 7 were right. It caught 8 of 8 planted fake tests.
- **Agent readiness:** every high and medium issue on both codebases was confirmed by hand.
- **Claim checking:** the first version's flags were 0 for 14 useful; after tuning, three specs produced 3 flags (1 real off-by-one, 2 borderline). Each fix ships with a regression test.

Small samples (two runs per method on App A, one or two on App B), hand-verified by
the author. Run it on your code and see.

## Install

**Requirements:** Node ≥ 22.5 (Veridic reads the index with the built-in `node:sqlite`)
and a [CodeGraph](https://github.com/colbymchenry/codegraph) index of your repo:

```bash
npm i -g @colbymchenry/codegraph
cd your-repo && codegraph init
```

**As a Claude Code plugin** (recommended: adds the skill, `/veridic:*` commands and the `veridic` CLI):

```text
/plugin marketplace add cph0r/veridic
/plugin install veridic@veridic
```

**As a CLI only:**

```bash
npm i -g veridic            # npm: installs the `veridic` command
brew install cph0r/tap/veridic  # or Homebrew
```

## Quick start

```bash
veridic routes payment                 # find the routes for a feature
veridic scope "POST /api/orders"       # everything that belongs to it, and what to read
veridic agent-ready --md               # is this API safe to hand to an agent?
veridic access --intended policy.csv   # who can call what, vs. who should
```

In Claude Code:

```text
/veridic:spec the checkout flow        # write an evidence-backed spec (gathers context first)
/veridic:check specs/checkout/spec.md  # do the citations hold?
/veridic:tests                         # which requirements have real tests
/veridic:metrics                       # every number in one table
/veridic:hooks                         # keep specs in sync on every commit
```

## Commands

| Command | What it does |
|---|---|
| `veridic metrics` | Every number in one call (`--md` for a table) |
| `veridic check` | `cite` + `claims`: are the citations right? |
| `veridic routes` | The app's routes, filtered by words |
| `veridic scope` | What belongs to a feature, and what to read |
| `veridic prepare` | Scope + contract + code for a feature as one document |
| `veridic read` | All the code to read for a feature in one call |
| `veridic states` | The feature's state machine and bug-shaped patterns in it |
| `veridic access` | Who can call each route, plan checks, caller scoping (`--intended <csv>`) |
| `veridic agent-ready` | Real effect per route, GETs that write, unscoped money routes (`--manifest`) |
| `veridic drift` | Where the OpenAPI contract and the code disagree |
| `veridic render` | `spec.json` → `spec.md` + `traceability.md` (validates first) |
| `veridic cite` | Do citations resolve; the text they point at |
| `veridic claims` | Do cited lines hold the facts each requirement states |
| `veridic anchor` | Add symbol anchors so citations survive code moving |
| `veridic stale` | Requirements a change touched (`--fix`, `--pr`) |
| `veridic mutate` | Would the guard notice the code behind a requirement changing |
| `veridic tests` | Which requirements have a real test (`--run` for pass/fail, `--table`) |
| `veridic scaffold` | A test skeleton: one placeholder per requirement |
| `veridic install-hook` | Install the git pre-commit hook |

## How it works

```text
 your repo ──▶ CodeGraph index ──▶ veridic: routes · scope · states · effects
                                        │  (facts, with file:line)
                                        ▼
                     Claude writes spec.json from the gathered context
                                        │
                                        ▼
         veridic render · cite · claims · tests   ◀── deterministic verdict
                                        │
                                        ▼
            pre-commit / Stop hook / CI: stale --fix keeps it true
```

The rule that shaped every part: **models read and reason; scripts gather facts and
verify.** Veridic never asks a model whether a spec is right. It checks.

## What Veridic runs and touches

Veridic runs locally and sends nothing anywhere: no telemetry, no network calls,
no model calls from its scripts.

- **Reads:** your repo's files, `git` metadata (`git ls-files`, `git diff`, `git show`), and the CodeGraph index at `.codegraph/codegraph.db`.
- **Runs:** `git`, Node, and, only with `veridic tests --run` / `render --run-tests`, your own tests through `npx --no-install vitest` (never downloads a package). `veridic mutate` works in a temporary `git clone --shared` and deletes it afterwards.
- **Writes:** only what you ask for: spec files from `render` and `stale --fix`, a test skeleton from `scaffold`, and files named with `--out`. Generated test harnesses call your app on `127.0.0.1` only.
- **Hooks are opt-in:** `veridic install-hook` writes `.git/hooks/pre-commit` (it refuses to overwrite an existing one); it updates citations that only moved, stages the spec, and blocks a commit whose cited code changed without the spec. `/veridic:hooks` explains each hook and asks before writing `.claude/settings.json` or a CI workflow.

## Limits

- Route discovery understands **Express** (JS/TS). Other frameworks aren't supported yet.
- `--run` executes tests with **vitest**.
- Effects (writes, money, notifications) are found by patterns on the code a route reaches; unusual libraries can slip past.
- Needs a CodeGraph index; re-run `codegraph sync` after big changes.

## Roadmap

- **Spec-aware "done" check:** when an agent says "implemented FR-002", verify the cited code is in the diff and an asserting `FR-002` test passes.
- More frameworks (Fastify, Hono, Next.js route handlers).
- Export the agent-readiness manifest as an MCP tool config with approval flags.

## Related

- [Spec Kit](https://github.com/github/spec-kit): the spec format Veridic writes.
- [CodeGraph](https://github.com/colbymchenry/codegraph): the code index Veridic reads.
- [Groundtruth](https://github.com/akahkhanna/groundtruth): checks an agent's own claims against its diff. Complementary: Groundtruth asks *"did the agent do what it said?"*, Veridic asks *"what does the code do?"*

## License

[MIT](LICENSE) © Chirag Phor
