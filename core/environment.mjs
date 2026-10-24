// The environment an app needs to run, for its environment spec: the env vars it reads
// (with a default, and whether startup fails without them), the outside services its
// dependencies talk to, its schedules (crons, queues) and what its deployment files define.
// Names only: real env files (.env, .env.local) are never opened; templates (.env.example)
// are read for names, and no value is kept.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const read = (repo, f) => { try { return fs.readFileSync(path.join(repo, f), "utf8"); } catch { return null; } };
const filesOf = (repo) => { try { return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: repo, encoding: "utf8", maxBuffer: 64 << 20 }).split("\n").filter(Boolean); } catch { return []; } };
const SKIP = /(?:^|\/)(?:node_modules|dist|build|coverage|\.next|vendor)\//;
const TEST = /(?:^|\/)(?:__tests__|tests?|e2e)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const CODE = /\.[cm]?[jt]sx?$/;
const TEMPLATE = /(?:^|\/)\.env\.(?:example|sample|template|defaults)$/;
const lineAt = (text, i) => text.slice(0, i).split("\n").length;

// Dependencies -> the service they talk to.
const SERVICES = [
  [/^stripe$/, "Stripe"], [/^razorpay$/, "Razorpay"], [/^@paypal\//, "PayPal"],
  [/^(?:ioredis|redis)$/, "Redis"], [/^bullmq$|^bull$/, "BullMQ (Redis queues)"],
  [/^(?:pg|postgres|@neondatabase\/serverless|@vercel\/postgres)$/, "Postgres"], [/^mysql2?$/, "MySQL"], [/^(?:mongoose|mongodb)$/, "MongoDB"], [/^@supabase\/supabase-js$/, "Supabase"],
  [/^@aws-sdk\/client-(.+)$/, (m) => `AWS ${m[1] === "s3" ? "S3" : m[1].toUpperCase()}`],
  [/^resend$/, "Resend (email)"], [/^nodemailer$/, "SMTP email (nodemailer)"], [/^@sendgrid\/mail$/, "SendGrid (email)"], [/^postmark$/, "Postmark (email)"], [/^twilio$/, "Twilio"],
  [/^openai$/, "OpenAI"], [/^@anthropic-ai\/sdk$/, "Anthropic"], [/^@google\/generative-ai$|^@google\/genai$/, "Google Gemini"],
  [/^@sentry\//, "Sentry"], [/^posthog-(?:node|js)$/, "PostHog"], [/^firebase-admin$/, "Firebase"], [/^@clerk\//, "Clerk"], [/^next-auth$|^@auth\/core$/, "Auth.js providers"],
];

/** -> { vars: [{ name, at, default?, required }], services: [{ name, via, at }], schedules: [{ what, when, at }], deploy: [{ file, services }] } */
export function environment(repo) {
  const files = filesOf(repo).filter((f) => !SKIP.test(f));
  const vars = new Map();
  // Set by the bundler or the system, not by the app's configuration.
  const BUILT_IN = /^(?:DEV|PROD|MODE|BASE_URL|SSR|HOME|PATH|USER|SHELL|PWD|TMPDIR|TEMP|TMP|LANG|TERM|HOSTNAME|CI|NODE_TEST_CONTEXT)$/;
  const note = (name, at, { required, def } = {}) => {
    if (BUILT_IN.test(name) && !TEMPLATE.test(at.split(":")[0])) return;
    const v = vars.get(name) ?? vars.set(name, { name, at: [], required: false }).get(name);
    if (!v.at.includes(at)) v.at.push(at);
    if (required) v.required = true;
    if (def != null && v.default == null) v.default = def;
  };
  // A Prisma datasource: env("X") is read at connect time, so the app can't start without it.
  const PROVIDERS = { postgresql: "Postgres", postgres: "Postgres", mysql: "MySQL", mongodb: "MongoDB", sqlserver: "SQL Server", cockroachdb: "CockroachDB" };
  const prismaServices = [];
  for (const f of files.filter((x) => /\.prisma$/.test(x))) {
    const text = read(repo, f) ?? "";
    for (const m of text.matchAll(/\benv\(\s*["']([A-Z][A-Z0-9_]*)["']\s*\)/g)) note(m[1], `${f}:${lineAt(text, m.index)}`, { required: true });
    for (const m of text.matchAll(/^\s*provider\s*=\s*["'](\w+)["']/gm))
      if (PROVIDERS[m[1]]) prismaServices.push({ name: PROVIDERS[m[1]], via: "prisma datasource", at: `${f}:${lineAt(text, m.index + m[0].search(/provider/))}` });
  }
  for (const f of files) {
    if (TEMPLATE.test(f)) {
      (read(repo, f) ?? "").split("\n").forEach((l, i) => { const m = l.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/); if (m) note(m[1], `${f}:${i + 1}`); });
      continue;
    }
    if (!CODE.test(f) || TEST.test(f)) continue;
    const text = read(repo, f) ?? "";
    if (text.length > 1e6 || !/process\.env|import\.meta\.env|createEnv|z\.object/.test(text)) continue;
    // An env schema (zod, t3 createEnv): a key is required unless optional or defaulted.
    if (/\.parse\(\s*process\.env\s*\)|createEnv\s*\(|safeParse\(\s*process\.env\s*\)/.test(text))
      for (const m of text.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*:\s*z\.([^\n]*?),?\s*$/gm)) {
        const def = m[2].match(/\.default\(\s*([^)]*?)\s*\)/)?.[1];
        note(m[1], `${f}:${lineAt(text, m.index + m[0].search(/[A-Z]/))}`, { required: !/\.optional\(\)|\.default\(|\.nullish\(\)/.test(m[2]), def });
      }
    // Reads in code: process.env.X, process.env["X"], import.meta.env.X, with a fallback or a check.
    for (const m of text.matchAll(/\b(?:process\.env|import\.meta\.env)(?:\.([A-Z][A-Z0-9_]*)|\[\s*["'`]([A-Z][A-Z0-9_]*)["'`]\s*\])/g)) {
      const name = m[1] ?? m[2];
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 80);
      const def = after.match(/^\s*(?:\?\?|\|\|)\s*(["'`][^"'`\n]*["'`]|-?\d+(?:\.\d+)?|true|false)/)?.[1];
      const before = text.slice(Math.max(0, m.index - 30), m.index);
      const required = /\bif\s*\(\s*!\s*$/.test(before) && /^\s*\)\s*(?:\{[^}]{0,120}?)?\bthrow\b/.test(after);
      note(name, `${f}:${lineAt(text, m.index)}`, { required, def });
    }
  }

  // Services, from every package.json's runtime dependencies.
  const services = new Map(prismaServices.map((x) => [x.name, x]));
  for (const f of files.filter((x) => /(?:^|\/)package\.json$/.test(x))) {
    let pkg;
    try { pkg = JSON.parse(read(repo, f) ?? "{}"); } catch { continue; }
    for (const dep of Object.keys(pkg.dependencies ?? {}))
      for (const [re, label] of SERVICES) {
        const m = dep.match(re);
        if (!m) continue;
        const name = typeof label === "function" ? label(m) : label;
        if (!services.has(name)) services.set(name, { name, via: "dependency", at: `${f}: ${dep}` });
        break;
      }
  }

  // Schedules: platform crons, cron libraries, queues.
  const schedules = [];
  for (const f of files) {
    if (/(?:^|\/)vercel\.json$/.test(f)) {
      try { for (const c of JSON.parse(read(repo, f) ?? "{}").crons ?? []) schedules.push({ what: c.path, when: c.schedule, at: f }); } catch {}
      continue;
    }
    if (!CODE.test(f) || TEST.test(f)) continue;
    const text = read(repo, f) ?? "";
    if (!/schedule|CronJob|Queue\(/.test(text)) continue;
    for (const m of text.matchAll(/\b(?:cron\.schedule|schedule\.scheduleJob|new\s+CronJob)\(\s*["'`]([^"'`]+)["'`]\s*,\s*(?:async\s*)?(?:\(\s*\)\s*=>\s*\{?\s*(?:await\s+)?([\w$.]+\([^)]*\))|([\w$.]+))?/g))
      schedules.push({ what: m[2] ?? m[3] ?? "a job", when: m[1], at: `${f}:${lineAt(text, m.index)}` });
    for (const m of text.matchAll(/\bnew\s+Queue\(\s*["'`]([^"'`]+)["'`]/g)) schedules.push({ what: `queue: ${m[1]}`, when: "on demand", at: `${f}:${lineAt(text, m.index)}` });
  }

  // Deployment: compose services (image, ports), Dockerfile ports.
  const deploy = [];
  for (const f of files.filter((x) => /(?:^|\/)(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml$/.test(x))) {
    const out = [];
    let inServices = false, cur = null, inPorts = false;
    for (const l of (read(repo, f) ?? "").split("\n")) {
      if (/^services:\s*$/.test(l)) { inServices = true; continue; }
      if (/^\S/.test(l)) { inServices = false; continue; }
      if (!inServices) continue;
      let m;
      if ((m = l.match(/^ {2}([\w.-]+):\s*$/))) { cur = { name: m[1] }; out.push(cur); inPorts = false; continue; }
      if (!cur) continue;
      if ((m = l.match(/^ {4}image:\s*["']?([^"'\s]+)/))) cur.image = m[1];
      if (/^ {4}ports:\s*$/.test(l)) { inPorts = true; cur.ports = []; continue; }
      if (inPorts && (m = l.match(/^ {6}-\s*["']?([^"'\s]+)/))) { cur.ports.push(m[1]); continue; }
      if (/^ {4}\S/.test(l)) inPorts = false;
    }
    if (out.length) deploy.push({ file: f, services: out });
  }
  for (const f of files.filter((x) => /(?:^|\/)Dockerfile$/.test(x))) {
    const ports = [...(read(repo, f) ?? "").matchAll(/^\s*EXPOSE\s+(.+)$/gim)].flatMap((m) => m[1].trim().split(/\s+/));
    if (ports.length) deploy.push({ file: f, expose: ports });
  }

  return { vars: [...vars.values()].sort((a, b) => a.name.localeCompare(b.name)), services: [...services.values()], schedules, deploy };
}

const row = (cells) => "|" + cells.map((c) => (c === "" ? " " : ` ${c} `)).join("|") + "|";

/** The environment spec, specs/environment/spec.md. */
export function environmentMarkdown(env) {
  const out = ["# Environment", "", "_Generated by `veridic environment`: names only, never values._", ""];
  out.push("## Environment variables", "", "| Name | Required | Default | Read at |", "|---|---|---|---|");
  for (const v of env.vars) out.push(row([v.name, v.required ? "yes" : "no", v.default ?? "", v.at.slice(0, 3).map((a) => `\`${a}\``).join(", ") + (v.at.length > 3 ? ` +${v.at.length - 3}` : "")]));
  out.push("", "## Services", "");
  out.push(...(env.services.length ? env.services.map((s) => `- ${s.name} (\`${s.at}\`)`) : ["None found."]));
  out.push("", "## Schedules", "");
  out.push(...(env.schedules.length ? env.schedules.map((s) => `- ${s.what}: ${s.when} (\`${s.at}\`)`) : ["None found."]));
  out.push("", "## Deployment", "");
  if (!env.deploy.length) out.push("None found.");
  for (const d of env.deploy) {
    if (d.expose) { out.push(`- \`${d.file}\`: exposes ${d.expose.join(", ")}`); continue; }
    out.push(`- \`${d.file}\`:`);
    for (const s of d.services) out.push(`  - ${s.name}${s.image ? `: image ${s.image}` : ""}${s.ports?.length ? `, ports ${s.ports.join(", ")}` : ""}`);
  }
  return out.join("\n") + "\n";
}
