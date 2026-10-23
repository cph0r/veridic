// The work list for turning a module's rules into tests: for each rule of the
// module's own spec, its status, what it needs (text, checks, cited code), existing
// tests that may already check it (to link by naming), where a new test goes, and
// how risky it is; plus the repo's test recipe. Deterministic: Veridic gathers,
// an agent writes the tests, Veridic verifies them (`veridic tests --module --run`).

import { execFileSync } from "node:child_process";
import { specHomes } from "./parts.mjs";
import fs from "node:fs";
import path from "node:path";
import { testCoverage, testsIn, specQual } from "./tests.mjs";
import { testRecipe, exampleTest } from "./recipe.mjs";

// Coverage statuses, in the work list's words.
const STATUS = { covered: "tested", passing: "tested", broken: "broken", failing: "failing", marker_stale: "failing", unasserted: "weak", tagged_only: "weak", ambiguous: "weak", todo: "untested", none: "untested" };
const REASON = { marker_stale: "its expected-failure test now fails: the code satisfies the rule, so make it a normal test", ambiguous: "a test names this id, but it also runs another spec's rule with the same id: write the id with its spec, e.g. `FR-008 (auth-2)`" };
const RULE = /^\s*(?:-\s*\*\*|#{1,6}\s+)((?:FR|SC|NFR|AC|INV)-\d+[a-z]?)\b/;

const read = (repo, f) => {
  try {
    return fs.readFileSync(path.join(repo, f), "utf8");
  } catch {
    return null;
  }
};

/** The module a spec belongs to: the one it's named after, else the first that claims it. */

/** Where a new test for a cited file goes, by the package's layout. */
function targetFor(recipe, file) {
  const ext = path.posix.extname(file);
  const name = path.posix.basename(file, ext) + ".test" + ext;
  if (recipe?.layout === "__tests__") return path.posix.join(path.posix.dirname(file), "__tests__", name);
  if (recipe?.layout === "test-dir") return path.posix.join(recipe.dir === "." ? "" : recipe.dir, "test", name);
  return path.posix.join(path.posix.dirname(file), name);
}

/**
 * @param opts { run?: boolean, data?: { modules, routes } } — data defaults to the report's.
 * @returns {{ module, specs, rules, totals, recipe, next } | { error, modules? }}
 */
export async function workList(repo, moduleId, opts = {}) {
  const data = opts.data ?? (await (await import("./modulectx.mjs")).loadModules(repo)).data;
  const modules = data.modules ?? [];
  let m = modules.find((x) => x.id.toLowerCase() === String(moduleId).toLowerCase() || x.name?.toLowerCase() === String(moduleId).toLowerCase());
  // A screen part works the same way: its own spec, its own code.
  if (!m) {
    const g = (data.screens ?? []).find((x) => x.id === String(moduleId).toLowerCase() || x.name?.toLowerCase() === String(moduleId).toLowerCase());
    if (g) m = { id: g.id, name: g.name, specs: g.specs ?? [], routes: [], files: g.files ?? [], code: [] };
  }
  if (!m) return { error: `no part "${moduleId}"; \`veridic parts\` lists them`, modules: modules.map((x) => x.id) };
  // The part's spec files, by the same rule as the dashboard and veridic parts (core/parts.mjs).
  // Specs a module names but the report hasn't read (no rules yet) count too, by their folder.
  const named = [...new Set(modules.flatMap((x) => x.specs ?? []))].filter((p) => !(data.specs ?? []).some((s) => s.path === p)).map((p) => ({ path: p, requirements: [] }));
  const homes = specHomes({ ...data, specs: [...(data.specs ?? []), ...named] });
  const own = [...(data.specs ?? []).map((s) => s.path), ...named.map((s) => s.path)].filter((p) => homes.get(p) === m.id);
  if (!own.length) {
    const owners = [...new Set((m.specs ?? []).map((s) => homes.get(s)).filter((o) => o && o !== m.id).map((o) => modules.find((x) => x.id === o)?.name ?? o))];
    return { error: `the ${m.name} part has no spec of its own` + (owners.length ? `; its rules are in ${owners.join(", ")}'s spec` : `; \`/veridic:specs ${m.id}\` writes one`) };
  }
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: repo, encoding: "utf8", maxBuffer: 64 << 20 }).split("\n").filter(Boolean);
  const recipes = testRecipe(repo, files);
  const recipeOf = (f) => [...recipes.values()].filter((r) => r.dir === "." || f.startsWith(r.dir + "/")).sort((a, b) => b.dir.length - a.dir.length)[0] ?? null;
  // Handlers of routes that move money or delete: rules citing them come first.
  const risky = (data.routes ?? []).filter((r) => r.module === m.id && (r.moves_money || r.effect === "destructive")).map((r) => r.handler.match(/^(.*):(\d+)-(\d+)$/)).filter(Boolean);
  const touchesRisky = (cites) => cites.some((c) => { const [, f, a, b] = c.match(/^(.*):(\d+)(?:-(\d+))?$/) ?? []; return risky.some(([, hf, s, e]) => hf === f && Number(a) <= Number(e) && Number(b ?? a) >= Number(s)); });
  // Every other spec's coverage, for ids that repeat across specs: another part's, or this part's other files.
  const others = files.filter((f) => /(^|\/)spec\.md$/.test(f)).map((f) => ({ f, text: read(repo, f) })).filter((x) => x.text);
  const reachedBy = (cov, id) => { const r = cov.requirements.find((x) => x.id === id); return new Set([...(r?.tests ?? []).map((t) => t.at.split(":")[0]), ...(r?.related_tests ?? [])]); };
  const otherCov = new Map();
  const covOf = (o) => otherCov.get(o.f) ?? otherCov.set(o.f, testCoverage(repo, o.text, { specPath: path.join(repo, o.f) })).get(o.f);

  const rules = [];
  const errors = [];
  for (const spec of own) {
    const text = read(repo, spec) ?? "";
    const cov = testCoverage(repo, text, { specPath: path.join(repo, spec), run: !!opts.run, module: m.id });
    errors.push(...(cov.errors ?? []));
    const byId = new Map(cov.requirements.map((r) => [r.id, r]));
    const ids = [...new Set(text.split("\n").map((l) => l.match(RULE)?.[1]).filter(Boolean))];
    for (const id of ids) {
      const r = byId.get(id);
      if (!r || !(r.cites ?? []).length) {
        rules.push({ id, spec, status: "untested", text: text.split("\n").find((l) => RULE.test(l) && l.includes(id))?.replace(/^\s*-?\s*\*\*[\w-]+\*\*:?\s*|^#+\s*[\w-]+:?\s*/, "").trim() ?? "", checks: [], cites: [], candidates: [], target: null, risk: id.startsWith("INV") ? 1 : 2, ambiguous: false, qual: specQual(spec) ?? m.id, reason: "no cited code" });
        continue;
      }
      const cited = [...new Set(r.cites.map((c) => c.split(":")[0]))];
      const rec = recipeOf(cited[0]);
      const candidates = (r.related_tests ?? []).flatMap((f) => testsIn(repo, f).filter((t) => (t.strength === "strong" || t.strength === "weak") && !t.title.includes(id)).map((t) => ({ at: `${f}:${t.line}`, title: t.title, strength: t.strength })));
      const mine = reachedBy(cov, id);
      // Shared with another of this part's spec files: always (one part, one set of tests).
      // Shared with another part's spec: when a test reaches both rules' code.
      const ambiguous = own.some((o) => o !== spec && (read(repo, o) ?? "").split("\n").some((l) => l.match(RULE)?.[1] === id)) || others.some((o) => o.f !== spec && covOf(o).requirements.some((x) => x.id === id) && [...reachedBy(covOf(o), id)].some((f) => mine.has(f)));
      rules.push({
        id,
        spec,
        // Under --run, "covered" means its test never ran (the runner couldn't start): not tested.
        status: opts.run && r.status === "covered" ? "not run" : STATUS[r.status] ?? "untested",
        ...(REASON[r.status] ? { reason: REASON[r.status] } : {}),
        ...(r.proven === false ? { proven: false } : {}),
        text: r.text ?? "",
        checks: (r.verification ?? []).map((v) => v.id),
        cites: r.cites,
        tests: [...new Set((r.tests ?? []).filter((t) => !t.todo).map((t) => t.at.split(":")[0]))],
        candidates,
        target: (rec && exampleTest(repo, rec, cited[0])) ?? targetFor(rec, cited[0]),
        risk: touchesRisky(r.cites) ? 0 : id.startsWith("INV") ? 1 : 2,
        ambiguous,
        qual: specQual(spec) ?? m.id,
      });
    }
  }
  rules.sort((a, b) => a.risk - b.risk);
  const totals = { rules: rules.length };
  for (const s of ["tested", "broken", "failing", "weak", "untested", "not run"]) totals[s] = rules.filter((r) => r.status === s).length;
  const used = [...new Set(rules.flatMap((r) => r.cites.map((c) => recipeOf(c.split(":")[0])?.dir)).filter((d) => d != null))];
  // The test to copy per package: the first rule's test file there that already exists.
  const exampleIn = (d) => rules.find((r) => r.target && recipeOf(r.target)?.dir === d && r.cites.length && files.includes(r.target))?.target ?? null;
  const recipe = Object.fromEntries(used.map((d) => { const { tests, ...rest } = recipes.get(d); return [d, { ...rest, example: exampleIn(d) }]; }));
  // The cited code of rules still to do, so the agent reads it here (at most 60 lines a cite, 400 in all).
  const code = [];
  let budget = 400;
  for (const c of new Set(rules.filter((r) => r.status !== "tested" && r.status !== "broken").flatMap((r) => r.cites))) {
    const [, f, a, b] = c.match(/^(.*):(\d+)(?:-(\d+))?$/) ?? [];
    const src = f && read(repo, f);
    if (!src || budget <= 0) continue;
    const lines = src.split("\n").slice(Number(a) - 1, Math.min(Number(b ?? a), Number(a) + 59, Number(a) - 1 + budget));
    budget -= lines.length;
    code.push({ cite: c, lines: lines.map((l, i) => `${String(Number(a) + i).padEnd(4)} ${l}`) });
  }
  const todo = totals.untested + totals.weak + totals.failing;
  const links = rules.filter((r) => r.status !== "tested" && r.candidates.length).length;
  const next = todo ? [`/veridic:tests ${m.id} (${links} to link, ${todo - links} to write)`, ...(links ? [`veridic tests --module ${m.id} --link ID=file:line[,line] …`] : []), `veridic tests --module ${m.id} --run`] : [`veridic tests --module ${m.id} --run`];
  return { module: { id: m.id, name: m.name }, specs: own, rules, totals, recipe, code, next, errors };
}

/** The work list as compact Markdown, ending with the next commands. */
export function workListMarkdown(wl) {
  if (wl.error) return `${wl.error}${wl.modules ? `\nParts: ${wl.modules.join(", ")}` : ""}\n`;
  const t = wl.totals;
  const L = [`# Rules to tests: ${wl.module.name}`, "", `Totals: ${t.rules} rules · ${t.tested} tested · ${t.broken} broken · ${t.failing} failing · ${t.weak} weak · ${t.untested} untested${t["not run"] ? ` · ${t["not run"]} not run` : ""}`, ""];
  for (const e of wl.errors ?? []) L.push(`Could not run: ${e.package ?? e.file ?? (e.files ?? []).join(", ")}: ${runError(e.error).slice(0, 200)}`);
  if (wl.errors?.length) L.push("");
  for (const [dir, r] of Object.entries(wl.recipe)) {
    L.push(`Recipe (${dir}): ${r.framework ?? "no test framework here: test this code from a package that has one"}${r.run ? ` · run one: \`${r.run}\`` : ""} · tests ${r.layout} · ${r.style === "http" ? "HTTP tests" : "direct calls"}${r.marker ? ` · expected failure: \`${r.marker}\`` : " · no expected-failure marker: skip with [broken] in the title"}${r.example ? ` · example test: \`${r.example}\`` : ""}`);
    for (const s of r.setup) L.push(`- setup: \`${s}\``);
    for (const h of r.helpers) L.push(`- helper: \`${h.file}\`${h.note ? `: ${h.note.split("\n")[0]}` : ""}`);
  }
  L.push("", "| rule | status | needs | link candidates | test file |", "|---|---|---|---|---|");
  for (const r of wl.rules) L.push(`| ${r.id}${r.ambiguous ? ` (title: \`${r.id} (${r.qual}): …\`, link: \`${r.id}@${r.qual}=…\`)` : ""} | ${r.status}${r.proven === false ? " (not proven)" : ""}${r.reason ? `: ${r.reason}` : ""} | ${r.text.replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|")}${r.checks.length ? ` (${r.checks.join(", ")})` : ""}${r.cites.length ? `<br>${r.cites.map((c) => `\`${c}\``).join(" ")}` : ""} | ${r.candidates.slice(0, 6).map((c) => `\`${c.at}\` ${c.title.slice(0, 80).replace(/\|/g, "\\|")}`).join("<br>") || "—"} | ${r.target ? `\`${r.target}\`` : "—"} |`);
  if (wl.code?.length) L.push("", "## Cited code", "", ...wl.code.flatMap((c) => [`\`${c.cite}\``, "```", ...c.lines, "```"]));
  L.push("", ...wl.next.map((n) => `Next: ${n}`));
  return L.join("\n") + "\n";
}

/** The line of a test runner's output that says why it couldn't run: the first error line, not a stack frame or a closing brace. */
export function runError(out) {
  const lines = String(out ?? "").split("\n").map((l) => l.trim()).filter((l) => l && !/^at\s|^[{}\[\](),]+$|^⎯/.test(l));
  return lines.find((l) => /\b(?:Error|ERR_[A-Z_]+|Cannot find|not found|failed|ENOENT|EACCES)\b/i.test(l)) ?? lines.at(-1) ?? "";
}
