<div align="center">

<img src="assets/veridic.svg" alt="veridic" width="460">

# Veridic: proof before "done"

### Your coding agent says it's done. Veridic checks.

**It hands the agent the facts about your code before it edits, and won't let it call the work finished until the change stayed in scope and is really tested.**

[![npm](https://img.shields.io/npm/v/veridic?style=flat-square&color=0E7490&label=npm)](https://www.npmjs.com/package/veridic)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-0E7490?style=flat-square)](#get-started)
[![checks: deterministic, no LLM](https://img.shields.io/badge/checks-deterministic%20%C2%B7%20no%20LLM-111111?style=flat-square)](#how-it-works)
[![benchmark: 95% precision](https://img.shields.io/badge/benchmark-95%25%20precision-111111?style=flat-square)](https://github.com/cph0r/veridic-bench)
[![license: MIT](https://img.shields.io/badge/license-MIT-111111?style=flat-square)](LICENSE)

[Get started](#get-started) · [Try it](#try-it) · [How it works](#how-it-works) · [What it catches](#what-it-catches) · [Proof](#proof) · [FAQ](#faq)

<code>/plugin marketplace add cph0r/veridic</code>

<br><br>

<img src="assets/loop.svg" alt="Asked to add refunds, the agent also edited markPaid; Veridic says NOT DONE; the agent fixes it; Veridic says DONE" width="720">

</div>

## Get started

You need Node 22.5+, Claude Code, and an Express app (JavaScript or TypeScript).

```text
/plugin marketplace add cph0r/veridic
/plugin install veridic@veridic
```

Then, in your repo, tell Claude **"set up veridic"**, or run it yourself:

```bash
veridic init              # builds the code index; checks your routes are found
veridic init --enforce    # optional: Claude can't finish while Veridic says NOT DONE
```

`init` also splits your app into its parts, found from the code: server parts (orders, menu, auth…) with their timers and WebSocket handlers, and your frontend's screens grouped by who uses them (guest, admin…). If they have no specs yet, it offers to start Claude Code on `/veridic:specs`, which writes specs until the whole app is covered, riskiest parts first, and asks before starting. Then it links the tests you already have to the rules they really prove, so those rules count as proven without writing a test. If your parts already have specs, `init` counts the rules your existing tests could prove and offers that step on its own (`/veridic:tests --link-only`).

That's all. From now on Claude uses Veridic on its own when it changes, reviews or documents your code.

## Try it

Paste any of these into Claude Code:

> Add refunds to the orders API.

Claude claims the refund route, sees what that code reaches before touching it, makes the change, and runs `veridic done` until it says DONE.

> What breaks if I change `markPaid`?

> Is our API safe to expose to an AI agent? Show me every GET that writes and every route that moves money.

> Which of our tests don't actually test anything?

> Write a spec for the checkout flow, with every rule backed by the code.

> Write specs for every part (or run `/veridic:specs`).

> How much of our app do the specs describe?

Or see everything at once:

```bash
veridic report      # or: veridic ui, or /veridic:report in Claude Code
```

One page opens in your browser: your app's specs and nothing else.

<img src="assets/dashboard.png" alt="The Veridic dashboard: gauges for rules up to date, proven and covered, a sortable table of the app's parts, and one part open beside it with a chart of its rules: 19 proven, 2 that need attention" width="720">

Three gauges show how many rules still match the code, how many a test proves, and how much of the app the specs cover (hover one for the numbers). Every part of your app is a row you can search, filter (needs fixing, out of date, not tested, proven, no spec) and sort by any column. Click one to open it beside the table, in three tabs: a chart of its rules (proven, needing attention, weak test, not tested) with the ones to look at first, its user stories with the rules each names, and every rule, with where it lives in the code and which tests prove it. It only shows: it never changes anything. It's one local file, `.veridic/report.html` (git-ignored): no server, no network, nothing uploaded.

## How it works

**claim → edit → done**, on every change.

```mermaid
flowchart LR
    ask(["You ask Claude<br/>for a change"]) --> claim["<b>veridic claim</b><br/>what will this touch?"]
    claim --> edit["Claude<br/>edits the code"]
    edit --> check{"<b>veridic done</b>"}
    check -- "NOT DONE: stray edit,<br/>route without a real test" --> edit
    check -- "DONE" --> result(["Change stayed in scope,<br/>proven by tests"])
```

| When Claude is… | It runs | And gets |
|---|---|---|
| About to edit | `veridic claim "POST /api/refund"` | Every route that code reaches and what each really does (money and deletes first), and the tests that cover it |
| Finishing | `veridic done` | **DONE**, or exactly which change strayed outside the claim, which changed route has no real test, which new test asserts nothing |
| Checking an API for agents | `veridic agent-ready` | What every route really does: reads, writes, deletes, moves money, and which act on ids the caller doesn't own |
| Writing a spec | `/veridic:spec checkout` | A Spec Kit–format spec, each rule citing the lines that implement it and checked against them |
| Writing specs for the whole app | `/veridic:specs` | Specs until the app is covered: parts with no spec first (riskiest first), then specs that miss their own files, then code in no part. Each agent works from `veridic prepare --module <id>`: what every route really does, its tables, screens, tests and open findings |
| How much of the app the specs describe | `veridic coverage` | Every behaviour file and the spec that cites it, per part (a server feature or a group of screens); what's in no part; every file left out (tests, generated code, types, config, seeds) with its reason |
| Asked "why is it like this?" | `veridic why FR-002` | The commits that wrote that code |

**No model decides any of it.** Every verdict is computed from your code, the git diff and your tests, with the line that proves it, so it can't be talked into passing.

## What it catches

Real catches, on real code:

- **OWASP Juice Shop:** changes a user's password on a `GET`.
- **hackathon-starter** (35k ★): **captures a PayPal payment on a `GET`**, and unlinks accounts on one.
- **ProShop:** any signed-in user can mark any order paid.
- **A popular REST starter:** deletes users with no login at all.
- **A production food-ordering app:** a fix for an order-cancel bug quietly changed how every checkout is created, with no test for it. `veridic done` caught it in 2 seconds.

And on every change Claude makes, the slips that are easy to miss in review:

```text
VERIDIC · done? (no spec)

  · claimed  POST /api/orders/:id/refund
  ✖ seam     1 stray change(s) outside what was claimed
  · reaches  1 changed file(s) behind 2 route(s), 2 that move money or delete
  ✖ tests    1 changed route(s) without an asserting test about them
  · range    HEAD vs working tree

  VERDICT ✖ NOT DONE

  → stray: src/routes/orders.ts:41 (behind GET /api/orders/:id/payment-status) is outside what was claimed
    untested: src/routes/orders.ts changes code behind GET /api/orders/:id/payment-status, and no asserting test that reaches it names the route or the changed function
```

Asked to add refunds, the agent also edited the function that marks orders paid. Veridic names the line and the money route it sits behind.

## Proof

Measured on 10 public Express apps (OWASP Juice Shop, NodeGoat, hackathon-starter, RealWorld and six more), pinned to exact commits, with every verdict checked by hand. Reproduce it in one command: [veridic-bench](https://github.com/cph0r/veridic-bench).

| | |
|---|---|
| Routes found | **353 of 353**, matching an independent scan in every app |
| Problems flagged | **37 of 39 real** (95%), each verdict and reason [published](https://github.com/cph0r/veridic-bench/blob/main/verdicts.json) |
| Tests that check nothing | **9 of 9** confirmed among 3,105 tests |
| Speed | under 4 seconds per app |

Writing a feature spec, against plain Claude Code on two production apps: **$0.94 instead of $2.46, 4.3 instead of 6.6 minutes**, and 100% of stated facts found in the cited code (versus 79–89%).

Covering a whole app: on a production Express + React app, `/veridic:specs` took the share of its code described by a spec **from 39% to 99%** (380 of 384 files) in 37 minutes, for $15, with every citation pointing at real code.

## FAQ

<details>
<summary><strong>Does my code leave my machine?</strong></summary>

No. Veridic runs locally and sends nothing anywhere: no telemetry, no network calls, no model calls. It reads your code, git history and a local index (`.codegraph/`, built by [CodeGraph](https://github.com/colbymchenry/codegraph), run with its telemetry off), and writes only that index and the files you ask for. See [PRIVACY.md](PRIVACY.md).
</details>

<details>
<summary><strong>Do I need to write specs?</strong></summary>

No. `claim → edit → done` works on any Express repo from the first minute. Specs are optional: when you have one, `veridic done --spec` also checks each rule's verification criteria.
</details>

<details>
<summary><strong>How is this different from Spec Kit?</strong></summary>

[Spec Kit](https://github.com/github/spec-kit) helps an agent plan *new* work from a spec. Veridic is about the code you already have: what it really does, proven line by line, and whether the agent's change kept it working. It writes specs in Spec Kit's format, so the two fit together.
</details>

<details>
<summary><strong>Will it get in Claude's way?</strong></summary>

Only when the work isn't finished. The Stop hook is off until you run `veridic init --enforce`, and even then it sends Claude back at most once per turn, with exactly what's missing.
</details>

<details>
<summary><strong>Which frameworks?</strong></summary>

Express (JavaScript and TypeScript) today; Fastify, NestJS and Next.js route handlers are next. Effects are recognized for SQL, Drizzle, MongoDB/Mongoose, Sequelize and Prisma. Frontend screens are grouped for React apps (React Router, wouter, Next.js app router, or a `pages/` folder); Angular screens aren't yet, and fall under code in no part.
</details>

<details>
<summary><strong>What does it get wrong?</strong></summary>

It reads middleware by name, so an oddly named auth guard can be misread; it matches tests to routes by name, so a test that never names the route or function counts as missing (it errs toward NOT DONE); and a route prefix computed at run time is left out. Known misses are listed in the [benchmark](https://github.com/cph0r/veridic-bench/blob/main/RESULTS.md).
</details>

<details>
<summary><strong>Can I use it without Claude Code?</strong></summary>

Yes: `npm i -g veridic` or `brew install cph0r/tap/veridic`, then `veridic help`. Every command prints JSON for an agent, and `done`, `metrics`, `impact` and `init` also print a one-screen card with `--card`.
</details>

## Star history

<a href="https://star-history.com/#cph0r/veridic&Date">
  <img src="https://api.star-history.com/svg?repos=cph0r/veridic&type=Date" alt="Star history" width="560">
</a>

## License

[MIT](LICENSE) © Chirag Phor. Formerly *Plumb*.
