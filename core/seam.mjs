// Is it done? For requirements an agent says it implemented: did the change stay
// inside their seam (the files they cite or declare with `[seam: …]`, plus their
// named tests), and does each have an asserting test, passing when run, for every
// verification criterion? Files changed outside every claimed seam are strays.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseSpec, makeResolver } from "./citations.mjs";
import { testCoverage } from "./tests.mjs";
import { defaultRange, resolveRange } from "./staleness.mjs";

const git = (repo, args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] });
const TEST_FILE = /(^|\/)(__tests__|tests?)\/.*\.[cm]?[jt]sx?$|\.(test|spec)\.[cm]?[jt]sx?$/;
// Changes that never count as strays: lockfiles, build output, indexes.
const IGNORED = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$|(^|\/)(dist|build|coverage|\.codegraph|node_modules)\//;

/** Files changed in the range: committed changes, plus the working tree (and untracked files) when the range has no head. */
export function changedFiles(repo, range) {
  let base;
  let head = null;
  let label;
  if (range) ({ base, head } = resolveRange(repo, range)), (label = range);
  else if (git(repo, ["status", "--porcelain"]).trim()) (base = git(repo, ["rev-parse", "HEAD"]).trim()), (label = "HEAD vs working tree");
  else {
    const r = defaultRange(repo);
    ({ base, head } = resolveRange(repo, r));
    label = r;
  }
  const names = git(repo, ["diff", "--name-only", base, ...(head ? [head] : [])]).split("\n").filter(Boolean);
  const untracked = head ? [] : git(repo, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
  names.push(...untracked);
  // Changed line ranges per file (new side), so a change counts only for the code it touched.
  const hunks = {};
  let cur = null;
  for (const line of git(repo, ["diff", "-U0", "--no-color", base, ...(head ? [head] : [])]).split("\n")) {
    const f = line.match(/^\+\+\+ b\/(.+)$/);
    if (f) (cur = f[1]), (hunks[cur] ??= []);
    const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (h && cur) {
      const start = Number(h[1]);
      const n = h[2] == null ? 1 : Number(h[2]);
      hunks[cur].push(n ? [start, start + n - 1] : [start + 0.5, start + 0.5]); // a pure deletion sits between two lines: it is inside what spans both
    }
  }
  for (const f of untracked) hunks[f] = null; // a new file: all of it
  return { range: label, files: [...new Set(names)], hunks };
}

/**
 * @param opts { ids: claimed requirement ids (default: every requirement whose seam the change touched), range, run }
 */
export function doneCheck(repo, specPath, opts = {}) {
  const text = fs.readFileSync(specPath, "utf8");
  const parsed = parseSpec(text);
  const resolve = makeResolver(repo, { aliases: parsed.aliases, bases: parsed.bases });
  const seamOf = new Map(); // requirement -> Set(files)
  const add = (fr, f) => fr && f && (seamOf.get(fr) ?? seamOf.set(fr, new Set()).get(fr)).add(f);
  for (const c of parsed.citations) if (!c.bad && /^(FR|INV|SC|NFR|AC)-/.test(c.fr)) add(c.fr, resolve(c.file).file);
  for (const s of parsed.seams) add(s.fr, resolve(s.file).file ?? s.file);

  const cov = testCoverage(repo, text, { specPath, run: !!opts.run });
  const covOf = new Map(cov.requirements.map((r) => [r.id, r]));
  // A requirement's named tests are in its seam too.
  for (const r of cov.requirements) for (const t of r.tests) add(r.id, t.at.split(":")[0]);

  const changed = changedFiles(repo, opts.range);
  const specDir = path.relative(repo, path.dirname(path.resolve(specPath)));
  const isSpec = (f) => specDir && !specDir.startsWith("..") && (f === specDir || f.startsWith(`${specDir}/`));

  const known = new Set([...seamOf.keys(), ...cov.requirements.map((r) => r.id)]);
  const unknown = (opts.ids ?? []).filter((id) => !known.has(id));
  const claimed = opts.ids?.length ? opts.ids.filter((id) => known.has(id)) : [...seamOf.keys()].filter((id) => [...seamOf.get(id)].some((f) => changed.files.includes(f)));
  const claimedSeam = new Set(claimed.flatMap((id) => [...(seamOf.get(id) ?? [])]));
  const anySeam = new Set([...seamOf.values()].flatMap((s) => [...s]));

  const files = changed.files.map((f) => ({
    file: f,
    as: IGNORED.test(f) ? "ignored" : isSpec(f) ? "spec" : claimedSeam.has(f) ? "held" : TEST_FILE.test(f) ? "other test" : anySeam.has(f) ? "other requirement" : "stray",
  }));
  const strays = files.filter((f) => f.as === "stray" || f.as === "other requirement");

  const requirements = claimed.map((id) => {
    const c = covOf.get(id);
    const seam = [...(seamOf.get(id) ?? [])];
    const vcs = c?.verification ?? [];
    const problems = [];
    if (!c || !["covered", "passing"].includes(c.status)) problems.push(c?.status === "failing" ? "its test fails" : c?.status === "unasserted" ? "its named test asserts nothing" : "no named test that reaches its code and asserts");
    for (const v of vcs) if (!v.covered) problems.push(`${v.id} has no asserting test`);
    if (opts.run) for (const v of vcs) if (v.tests.some((t) => t.result === "failed")) problems.push(`${v.id} test fails`);
    const touched = seam.filter((f) => changed.files.includes(f));
    return { id: id, seam, touched, status: c?.status ?? "none", ...(vcs.length ? { criteria: `${vcs.filter((v) => v.covered).length} of ${vcs.length}` } : {}), problems, ...(touched.length ? {} : { note: "the change didn't touch this requirement's seam" }) };
  });

  const blocking = requirements.some((r) => r.problems.length) || strays.length > 0 || unknown.length > 0 || !claimed.length;
  return {
    spec: path.relative(process.cwd(), specPath),
    range: changed.range,
    claimed,
    ...(unknown.length ? { unknown_ids: unknown } : {}),
    seam: { held: files.filter((f) => f.as === "held").length, declared: claimedSeam.size, strays: strays.map((f) => `${f.file}${f.as === "other requirement" ? " (another requirement's seam)" : ""}`) },
    requirements,
    files,
    done: !blocking,
  };
}

/**
 * `done` without a spec. With claims (routes or files the agent says it changed),
 * the seam is the code those routes run plus the tests that reach it, and a
 * change outside it is a stray. Either way, every changed file a route depends on
 * needs a test that reaches it and asserts, and changed tests must assert.
 */
// The function a line sits in, read from the source, for code the index doesn't list as a
// function (a method shorthand in an object literal: `statics = { removeByUser(id) { … } }`).
const HEADER = /^\s*(?:(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|(?:static\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{|(?:const|let|var)?\s*([A-Za-z_$][\w$.]*)\s*[:=]\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>))/;
const NOT_NAMES = new Set(["if", "for", "while", "switch", "catch", "with", "return", "function"]);
// `file:12` or `file:12-14`; a deletion between lines 12 and 13 reads `file:12`.
const at = (f, [a, b]) => `${f}:${Math.floor(a)}${Math.floor(b) !== Math.floor(a) && b < Number.MAX_SAFE_INTEGER ? `-${Math.floor(b)}` : ""}`;

export function enclosingByText(lines, line) {
  // Walking up from the line: once more `{` than `}` have been seen, that line opened a
  // block still open at the line, so a function header there encloses it.
  let open = 0;
  for (let i = Math.min(line, lines.length) - 1; i >= 0 && i >= line - 120; i--) {
    const l = lines[i];
    open += (l.match(/\{/g) ?? []).length - (l.match(/\}/g) ?? []).length;
    if (open <= 0) continue;
    const m = l.match(HEADER);
    const name = m && (m[1] ?? m[2] ?? m[3]?.split(".").pop());
    if (name && !NOT_NAMES.has(name)) return [name];
    open = 0; // a block that isn't a function (an if, an object): keep looking outward
  }
  return [];
}

export async function doneWithoutSpec(repo, { claims = [], range } = {}) {
  const { openGraph } = await import("./graph.mjs");
  const { routeInventory } = await import("./routes.mjs");
  const { parseTargets, affectedRoutes, footprintOf } = await import("./impact.mjs");
  const { testsReaching, auditFile, testFilesOf } = await import("./tests.mjs");
  const g = openGraph(repo);
  const inv = routeInventory(g);
  const changed = changedFiles(repo, range);
  const SOURCE = /\.[cm]?[jt]sx?$/;
  const source = changed.files.filter((f) => SOURCE.test(f) && !TEST_FILE.test(f) && !IGNORED.test(f) && !/\.d\.ts$/.test(f));
  const tests = changed.files.filter((f) => TEST_FILE.test(f) && !IGNORED.test(f));

  // The seam: claimed files (all of them), and the exact code the claimed routes run.
  const { targets, unknown } = parseTargets(inv, claims);
  const claimedFiles = new Set(targets.filter((t) => !t.route && t.start == null).map((t) => t.file));
  const seamRanges = targets.filter((t) => !t.route && t.start != null).map((t) => ({ file: t.file, start: t.start, end: t.end }));
  for (const t of targets.filter((x) => x.route)) for (const r of inv.routes.filter((x) => x.id === t.route)) seamRanges.push(...footprintOf(g, r).map((n) => ({ file: n.file, start: n.start, end: n.end })));
  const seamFiles = new Set([...claimedFiles, ...seamRanges.map((x) => x.file)]);
  const inSeam = (file, [a, b]) => claimedFiles.has(file) || seamRanges.some((x) => x.file === file && x.start <= b && x.end >= a);
  const reachSeam = testsReaching(repo, [...seamFiles]);
  const seamTests = new Set([...reachSeam.values()].flat().map((t) => t.file));

  // What each changed hunk reaches, and whether a test that reaches it is about it:
  // a test counts for a route only if it names the route's path or the changed function.
  const reachChanged = testsReaching(repo, source);
  const testText = new Map();
  const textOf = (f) => (testText.has(f) ? testText.get(f) : testText.set(f, (g.text(f) ?? "").toLowerCase()).get(f));
  // The route's most specific literal part: /api/orders/:id/payment-status -> payment-status.
  const pathWords = (route) => route.split(" ")[1].split("/").filter((w) => w && !w.startsWith(":") && w !== "*").slice(-1);
  // Asserting tests anywhere in the repo, for matching routes by URL.
  const allTests = (() => {
    try {
      return testFilesOf(repo).filter((t) => auditFile(repo, t).asserting > 0);
    } catch {
      return [];
    }
  })();
  const urlCache = new Map();
  const callsUrl = (route) => {
    if (urlCache.has(route)) return urlCache.get(route);
    const p = route.split(" ")[1];
    const parts = p.split("/").filter(Boolean);
    // Literal segments in order; a :param or * matches any value, including `${id}` or "' + id + '".
    const re = parts.length
      ? new RegExp(`["'\`]/${parts.map((x) => (x.startsWith(":") || x === "*" ? "(?:[^/\\s'\"\`]+|['\"\`]\\s*\\+[^,)]*)" : x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/")}(?:[?'"\`),]|$)`)
      : null;
    const hit = !!re && parts.some((x) => !x.startsWith(":")) && allTests.some((t) => re.test(g.text(t) ?? ""));
    urlCache.set(route, hit);
    return hit;
  };
  const strayHunks = [];
  const outsideRoutes = [];
  const claimedRoutes = new Set(targets.filter((t) => t.route).map((t) => t.route));
  const files = source.map((f) => {
    const h = changed.hunks?.[f] ?? null;
    const ranges = h ?? [[1, Number.MAX_SAFE_INTEGER]];
    const routes = affectedRoutes(g, inv, ranges.map(([start, end]) => ({ file: f, start, end })));
    // A stray is a change inside code some *other* route runs: scope creep into behavior
    // nobody asked to change. A change no route runs (a schema, imports, config, deleted
    // code) isn't one; it is listed as outside any route.
    if (claims.length)
      for (const r of ranges) {
        if (inSeam(f, r)) continue;
        const others = affectedRoutes(g, inv, [{ file: f, start: r[0], end: r[1] }]).map((x) => x.route).filter((id) => !claimedRoutes.has(id));
        if (others.length) strayHunks.push({ file: f, range: r, routes: others });
        else outsideRoutes.push(at(f, r));
      }
    // Names of the functions the change sits in, for matching tests by name.
    const fns = h ? [...new Set(h.flatMap(([a, b]) => {
      const indexed = [...g.nodes.values()].filter((n) => n.file === f && (n.kind === "function" || n.kind === "method") && n.start <= b && n.end >= a).map((n) => n.name);
      return indexed.length ? indexed : enclosingByText(g.lines(f) ?? [], Math.ceil(a));
    }))] : [];
    const reaching = (reachChanged.get(f) ?? []).filter((t) => t.asserting > 0);
    // A route is tested if a test that reaches the change names it or the changed function,
    // or if any asserting test calls the route by its URL (supertest, e2e): `/v1/users/${id}`.
    // Which routes must have a test: the claimed ones (or, with no claim, routes whose own
    // handler changed). Routes reached only through shared code are reported, not required.
    const required = routes.filter((r) => (claimedRoutes.size ? claimedRoutes.has(r.route) : r.hops === 0));
    const untestedRoutes = required.filter((r) => !reaching.some((t) => pathWords(r.route).some((w) => textOf(t.file).includes(w.toLowerCase())) || fns.some((n) => textOf(t.file).includes(n.toLowerCase()))) && !callsUrl(r.route));
    return { file: f, also_affects: routes.filter((r) => !required.includes(r)).map((r) => r.route), in_seam: !claims.length || !strayHunks.some((x) => x.file === f), routes: routes.map((r) => r.route), risky: routes.filter((r) => r.moves_money || r.effect === "destructive").map((r) => r.route), tests: reaching.map((t) => t.file), untested_routes: untestedRoutes.map((r) => r.route) };
  });
  const testAudit = tests.map((f) => auditFile(repo, f)).filter((a) => a.tests);
  // Tests are never strays: adding or fixing tests is part of any change.
  const strays = claims.length ? strayHunks.map((x) => `${at(x.file, x.range)} (behind ${x.routes.slice(0, 2).join(", ")})`) : [];
  const untested = files.filter((f) => f.untested_routes.length);
  const nothing = testAudit.flatMap((a) => [...a.flagged.unasserted, ...a.flagged.empty].map((x) => x.at));
  const problems = [
    ...unknown.map((u) => `${u} isn't a route or file in this repo`),
    ...strays.map((s) => `stray: ${s} is outside what was claimed`),
    ...untested.map((f) => `untested: ${f.file} changes code behind ${f.untested_routes.slice(0, 3).join(", ")}${f.untested_routes.length > 3 ? ` and ${f.untested_routes.length - 3} more` : ""}, and no asserting test that reaches it names the route or the changed function`),
    ...nothing.map((at) => `a changed test asserts nothing: ${at}`),
  ];
  const affected = [...new Set(files.flatMap((f) => f.routes))];
  return {
    mode: "no spec",
    range: changed.range,
    claimed: claims,
    changed: { source: source.length, tests: tests.length },
    ...(claims.length ? { seam: { files: seamFiles.size, strays, outside_routes: outsideRoutes } } : {}),
    affected_routes: affected.length,
    risky_routes: [...new Set(files.flatMap((f) => f.risky))],
    files,
    problems,
    done: !problems.length && (source.length > 0 || tests.length > 0),
  };
}

// The agent's claim of what it is about to change, kept between commands (and for
// the Stop hook) in .codegraph/, which git ignores. Tied to HEAD: a claim made
// before the last commit belongs to an earlier task and is ignored.
const claimPath = (repo) => path.join(repo, ".codegraph", "veridic-claim.json");
export function saveClaim(repo, claims) {
  const head = git(repo, ["rev-parse", "HEAD"]).trim();
  fs.mkdirSync(path.dirname(claimPath(repo)), { recursive: true });
  fs.writeFileSync(claimPath(repo), JSON.stringify({ claims, head, at: new Date().toISOString() }, null, 2) + "\n");
  return { claims, head };
}
export function loadClaim(repo) {
  try {
    const c = JSON.parse(fs.readFileSync(claimPath(repo), "utf8"));
    return c.head === git(repo, ["rev-parse", "HEAD"]).trim() ? c.claims : [];
  } catch {
    return [];
  }
}
