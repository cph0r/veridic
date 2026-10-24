// The environment spec: env vars, outside services, schedules and deployment. Names only:
// no value read from an env file ever reaches the output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { environment, environmentMarkdown } from "../core/environment.mjs";

const SECRET = "sk_live_DO_NOT_LEAK_123";
const repoOf = (files) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "veridic-env-"));
  for (const [f, t] of Object.entries(files)) fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }), fs.writeFileSync(path.join(repo, f), t);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["add", "-f", "."], { cwd: repo });
  return { repo, done: () => fs.rmSync(repo, { recursive: true, force: true }) };
};

const FILES = {
  "package.json": JSON.stringify({ dependencies: { stripe: "^14", ioredis: "^5", "@aws-sdk/client-s3": "^3", resend: "^3", "node-cron": "^3", bullmq: "^5", pg: "^8" } }),
  "src/env.ts": [
    'import { z } from "zod";',
    "export const env = z.object({",
    "  DATABASE_URL: z.string().url(),",
    "  STRIPE_KEY: z.string(),",
    "  LOG_LEVEL: z.string().default(\"info\"),",
    "  SENTRY_DSN: z.string().optional(),",
    "}).parse(process.env);",
  ].join("\n"),
  "src/server.ts": [
    'const port = process.env.PORT ?? "3000";',
    "const base = process.env.APP_BASE_URL;",
    'if (!process.env.SESSION_SECRET) throw new Error("SESSION_SECRET is required");',
    'const flag = import.meta.env.VITE_FLAG || "off";',
    'cron.schedule("0 3 * * *", () => sweep());',
    'const emails = new Queue("emails", { connection });',
    "if (import.meta.env.DEV) console.log(import.meta.env.MODE, import.meta.env.BASE_URL);",
    'const home = process.env.HOME ?? "";',
  ].join("\n"),
  ".env.example": "DATABASE_URL=\nSTRIPE_KEY=\nANALYTICS_ID=\n",
  ".env": `STRIPE_KEY=${SECRET}\n`,
  "vercel.json": JSON.stringify({ crons: [{ path: "/api/cron/cleanup", schedule: "0 * * * *" }] }),
  "docker-compose.yml": "services:\n  api:\n    build: .\n    ports:\n      - \"3000:3000\"\n  db:\n    image: postgres:16\n    ports:\n      - \"5432:5432\"\n",
};

test("environment: env vars, with a default and whether startup needs them", () => {
  const r = repoOf(FILES);
  const env = environment(r.repo);
  r.done();
  const v = Object.fromEntries(env.vars.map((x) => [x.name, x]));
  assert.equal(v.DATABASE_URL.required, true, "in a zod env schema, no default");
  assert.equal(v.STRIPE_KEY.required, true);
  assert.equal(v.LOG_LEVEL.required, false);
  assert.equal(v.LOG_LEVEL.default, '"info"');
  assert.equal(v.SENTRY_DSN.required, false);
  assert.equal(v.PORT.required, false);
  assert.equal(v.PORT.default, '"3000"');
  assert.equal(v.SESSION_SECRET.required, true, "startup throws without it");
  assert.equal(v.VITE_FLAG.default, '"off"');
  assert.ok(v.APP_BASE_URL, "read with no fallback: listed");
  assert.ok(v.ANALYTICS_ID, "named in .env.example");
  assert.deepEqual(v.STRIPE_KEY.at.sort(), [".env.example:2", "src/env.ts:4"]);
  for (const builtIn of ["DEV", "MODE", "BASE_URL", "HOME"]) assert.equal(v[builtIn], undefined, `${builtIn} is set by Vite or the system, not by the app's config`);
});

test("environment: services, schedules and deployment", () => {
  const r = repoOf(FILES);
  const env = environment(r.repo);
  r.done();
  assert.deepEqual(env.services.map((s) => s.name).sort(), ["AWS S3", "BullMQ (Redis queues)", "Postgres", "Redis", "Resend (email)", "Stripe"]);
  assert.deepEqual(env.schedules.map((s) => [s.what, s.when]).sort(), [["/api/cron/cleanup", "0 * * * *"], ["queue: emails", "on demand"], ["sweep()", "0 3 * * *"]]);
  assert.deepEqual(env.deploy, [{ file: "docker-compose.yml", services: [{ name: "api", ports: ["3000:3000"] }, { name: "db", image: "postgres:16", ports: ["5432:5432"] }] }]);
});

test("environment: no value from an env file ever reaches the output", () => {
  const r = repoOf(FILES);
  const env = environment(r.repo);
  const md = environmentMarkdown(env);
  r.done();
  assert.ok(!JSON.stringify(env).includes(SECRET));
  assert.ok(!md.includes(SECRET));
  assert.match(md, /^# Environment/);
  assert.match(md, /\| DATABASE_URL \| yes \| \|/);
});
