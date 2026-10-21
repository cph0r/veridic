#!/usr/bin/env node
// Gather a feature's context before a spec session: scope, contract comparison
// and all relevant code as one Markdown document. Prints it, or writes it with
// --out <file>. Seeds as for scope, or --module <id> for one of the modules
// `veridic modules` lists: its routes as the seeds, and its full context
// (what each route really does, tables, screens, tests, rules, findings) first.

import fs from "node:fs";
import path from "node:path";
import { prepare } from "../../core/prepare.mjs";
import { loadModules, findModule, moduleMarkdown, screenMarkdown } from "../../core/modulectx.mjs";
import { specCoverage } from "../../core/coverage.mjs";
import { parseArgs, emit, fail, run, writeAll } from "./_cli.mjs";

const usage = 'prepare.mjs --repo <path> ("<METHOD /path>" | <file> | <symbol> ... | --module <id>) [--out <context.md>] [--all] [--entry <app file>]';

run(async () => {
  const a = parseArgs(process.argv.slice(2), { flags: ["repo", "out", "entry", "module"], bools: ["all"] });
  if (!a.repo || (!a._.length && !a.module)) fail("need --repo and at least one seed, or --module <id>", usage);
  let head = "", seeds = a._;
  if (a.module) {
    const { data, modules } = await loadModules(a.repo);
    const m = findModule(modules, a.module);
    // A screen group: its own context (pages, files, the server rules its calls depend on).
    const sg = !m && (data.screens ?? []).find((x) => x.id === String(a.module).toLowerCase());
    if (sg) {
      const part = specCoverage(a.repo, data).parts.find((p) => p.kind === "screens" && p.id === sg.id);
      const md = screenMarkdown(data, sg, { uncovered: part?.uncovered ?? [] });
      if (a.out) {
        const out = path.resolve(a.out);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, md);
        emit({ repo: a.repo, wrote: a.out, screens: sg.id, pages: sg.pages.length, files: sg.files.length });
      }
      writeAll(md);
      return;
    }
    if (!m) fail(`no module "${a.module}"; run \`veridic modules\` for the list (${modules.map((x) => x.id).join(", ")})`, usage);
    head = moduleMarkdown(data, m) + "\n---\n\n";
    seeds = [...m.routes, ...seeds];
  }
  const r = prepare(a.repo, seeds, { entry: a.entry, all: !!a.all });
  r.markdown = head + r.markdown;
  if (a.out) {
    const out = path.resolve(a.out);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    // Context under .veridic/ quotes the code: keep it out of git, as the report does.
    const vdir = path.join(a.repo, ".veridic");
    if (out.startsWith(vdir + path.sep) && !fs.existsSync(path.join(vdir, ".gitignore"))) fs.writeFileSync(path.join(vdir, ".gitignore"), "# Written by veridic: generated files, never committed.\n*\n");
    fs.writeFileSync(out, r.markdown);
    emit({ repo: a.repo, wrote: a.out, ...r.stats });
  }
  writeAll(r.markdown);
}, usage);
