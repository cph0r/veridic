// The work list for turning a module's rules into tests: for each rule of the
// module's own spec, its status, what it needs (text, checks, cited code), existing
// tests that may already check it (to link by naming), where a new test goes, and
// how risky it is; plus the repo's test recipe. Deterministic: Veridic gathers,
// an agent writes the tests, Veridic verifies them (`veridic tests --module --run`).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { testCoverage, testsIn } from "./tests.mjs";
import { testRecipe, exampleTest } from "./recipe.mjs";

// Coverage statuses, in the work list's words.
const STATUS = { covered: "tested", passing: "tested", broken: "broken", failing: "failing", unasserted: "weak", tagged_only: "weak", todo: "untested", none: "untested" };
const RULE = /^\s*(?:-\s*\*\*|#{1,6}\s+)((?:FR|SC|NFR|AC|INV)-\d+[a-z]?)\b/;

const read = (repo, f) => {
  try {
    return fs.readFileSync(path.join(repo, f), "utf8");
  } catch {
    return null;
  }
};

/** The module a spec belongs to: the one it's named after, else the first that claims it. */
const ownerOf = (modules, spec) => modules.find((m) => spec.includes(`/${m.id}/`)) ?? modules.find((m) => (m.specs ?? []).includes(spec)) ?? null;

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
  const m = modules.find((x) => x.id.toLowerCase() === String(moduleId).toLowerCase() || x.name?.toLowerCase() === String(moduleId).toLowerCase());
  if (!m) return { error: `no module "${moduleId}"; \`veridic modules\` lists them`, modules: modules.map((x) => x.id) };
  const own = (m.specs ?? []).filter((s) => ownerOf(modules, s) === m);
  if (!own.length) {
    const owners = [...new Set((m.specs ?? []).map((s) => ownerOf(modules, s)).filter((o) => o && o !== m).map((o) => o.name))];
    return { error: `module ${m.name} has no spec of its own` + (owners.length ? `; its rules are in ${owners.join(", ")}'s spec` : `; \`/veridic:specs ${m.id}\` writes one`) };
  }
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: repo, encoding: "utf8", maxBuffer: 64 << 20 }).split("\n").filter(Boolean);
  const recipes = testRecipe(repo, files);
  const recipeOf = (f) => [...recipes.values()].filter((r) => r.dir === "." || f.startsWith(r.dir + "/")).sort((a, b) => b.dir.length - a.dir.length)[0] ?? null;
  // Handlers of routes that move money or delete: rules citing them come first.
  const risky = (data.routes ?? []).filter((r) => r.module === m.id && (r.moves_money || r.effect === "destructive")).map((r) => r.handler.match(/^(.*):(\d+)-(\d+)$/)).filter(Boolean);
  const touchesRisky = (cites) => cites.some((c) => { const [, f, a, b] = c.match(/^(.*):(\d+)(?:-(\d+))?$/) ?? []; return risky.some(([, hf, s, e]) => hf === f && Number(a) <= Number(e) && Number(b ?? a) >= Number(s)); });
  // Other specs' coverage, for ids that repeat across specs.
  const others = files.filter((f) => /(^|\/)spec\.md$/.test(f) && !own.includes(f)).map((f) => ({ f, text: read(repo, f) })).filter((x) => x.text);
  const reachedBy = (cov, id) => { const r = cov.requirements.find((x) => x.id === id); return new Set([...(r?.tests ?? []).map((t) => t.at.split(":")[0]), ...(r?.related_tests ?? [])]); };
  const otherCov = new Map();
  const covOf = (o) => otherCov.get(o.f) ?? otherCov.set(o.f, testCoverage(repo, o.text, { specPath: path.join(repo, o.f) })).get(o.f);

  const rules = [];
  for (const spec of own) {
    const text = read(repo, spec) ?? "";
    const cov = testCoverage(repo, text, { specPath: path.join(repo, spec), run: !!opts.run, module: m.id });
    const byId = new Map(cov.requirements.map((r) => [r.id, r]));
    const ids = [...new Set(text.split("\n").map((l) => l.match(RULE)?.[1]).filter(Boolean))];
    for (const id of ids) {
      const r = byId.get(id);
      if (!r || !(r.cites ?? []).length) {
        rules.push({ id, spec, status: "untested", text: text.split("\n").find((l) => RULE.test(l) && l.includes(id))?.replace(/^\s*-?\s*\*\*[\w-]+\*\*:?\s*|^#+\s*[\w-]+:?\s*/, "").trim() ?? "", checks: [], cites: [], candidates: [], target: null, risk: id.startsWith("INV") ? 1 : 2, ambiguous: false, reason: "no cited code" });
        continue;
      }
      const cited = [...new Set(r.cites.map((c) => c.split(":")[0]))];
      const rec = recipeOf(cited[0]);
      const candidates = (r.related_tests ?? []).flatMap((f) => testsIn(repo, f).filter((t) => (t.strength === "strong" || t.strength === "weak") && !t.title.includes(id)).map((t) => ({ at: `${f}:${t.line}`, title: t.title, strength: t.strength })));
      const mine = reachedBy(cov, id);
      const ambiguous = others.some((o) => covOf(o).requirements.some((x) => x.id === id) && [...reachedBy(covOf(o), id)].some((f) => mine.has(f)));
      rules.push({
        id,
        spec,
        status: STATUS[r.status] ?? "untested",
        ...(r.proven === false ? { proven: false } : {}),
        text: r.text ?? "",
        checks: (r.verification ?? []).map((v) => v.id),
        cites: r.cites,
        candidates,
        target: (rec && exampleTest(repo, rec, cited[0])) ?? targetFor(rec, cited[0]),
        risk: touchesRisky(r.cites) ? 0 : id.startsWith("INV") ? 1 : 2,
        ambiguous,
      });
    }
  }
  rules.sort((a, b) => a.risk - b.risk);
  const totals = { rules: rules.length };
  for (const s of ["tested", "broken", "failing", "weak", "untested"]) totals[s] = rules.filter((r) => r.status === s).length;
  const used = [...new Set(rules.flatMap((r) => r.cites.map((c) => recipeOf(c.split(":")[0])?.dir)).filter((d) => d != null))];
  const recipe = Object.fromEntries(used.map((d) => { const { tests, ...rest } = recipes.get(d); return [d, rest]; }));
  const todo = totals.untested + totals.weak + totals.failing;
  const links = rules.filter((r) => r.status !== "tested" && r.candidates.length).length;
  const next = todo ? [`/veridic:tests ${m.id} (${links} to link, ${todo - links} to write)`, `veridic tests --module ${m.id} --run`] : [`veridic tests --module ${m.id} --run`];
  return { module: { id: m.id, name: m.name }, specs: own, rules, totals, recipe, next };
}

/** The work list as compact Markdown, ending with the next commands. */
export function workListMarkdown(wl) {
  if (wl.error) return `${wl.error}${wl.modules ? `\nModules: ${wl.modules.join(", ")}` : ""}\n`;
  const t = wl.totals;
  const L = [`# Rules to tests: ${wl.module.name}`, "", `Totals: ${t.rules} rules · ${t.tested} tested · ${t.broken} broken · ${t.failing} failing · ${t.weak} weak · ${t.untested} untested`, ""];
  for (const [dir, r] of Object.entries(wl.recipe)) {
    L.push(`Recipe (${dir}): ${r.framework ?? "no test framework here: test this code from a package that has one"}${r.run ? ` · run one: \`${r.run}\`` : ""} · tests ${r.layout} · ${r.style === "http" ? "HTTP tests" : "direct calls"}${r.marker ? ` · expected failure: \`${r.marker}\`` : " · no expected-failure marker: skip with [broken] in the title"}`);
    for (const s of r.setup) L.push(`- setup: \`${s}\``);
    for (const h of r.helpers) L.push(`- helper: \`${h.file}\`${h.note ? `: ${h.note.split("\n")[0]}` : ""}`);
  }
  L.push("", "| rule | status | needs | link candidates | test file |", "|---|---|---|---|---|");
  for (const r of wl.rules) L.push(`| ${r.id}${r.ambiguous ? ` (title: \`${r.id} (${wl.module.id}): …\`)` : ""} | ${r.status}${r.proven === false ? " (not proven)" : ""}${r.reason ? `: ${r.reason}` : ""} | ${r.text.slice(0, 120).replace(/\|/g, "\\|")}${r.checks.length ? ` (${r.checks.join(", ")})` : ""}${r.cites.length ? `<br>${r.cites.map((c) => `\`${c}\``).join(" ")}` : ""} | ${r.candidates.slice(0, 3).map((c) => `\`${c.at}\` ${c.title.slice(0, 60).replace(/\|/g, "\\|")}`).join("<br>") || "—"} | ${r.target ? `\`${r.target}\`` : "—"} |`);
  L.push("", ...wl.next.map((n) => `Next: ${n}`));
  return L.join("\n") + "\n";
}
