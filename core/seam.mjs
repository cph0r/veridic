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
  if (!head) names.push(...git(repo, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean));
  return { range: label, files: [...new Set(names)] };
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
