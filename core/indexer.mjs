// The CodeGraph index Veridic reads: find the codegraph CLI (the copy installed
// with Veridic first, then PATH), build the index, and keep it in step with the
// code, so line numbers never come from an outdated index. Veridic always runs
// codegraph with its telemetry off (CODEGRAPH_TELEMETRY=0).

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const CODEGRAPH_VERSION = "1.6.0";
export const CODEGRAPH_PACKAGE = `@colbymchenry/codegraph@${CODEGRAPH_VERSION}`;
const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE = /\.(?:[cm]?[jt]sx?|py|go|rb|java|kt|rs|php|cs|swift|vue|svelte)$/;

/** Path to the codegraph CLI: Veridic's own dependency, else one on PATH, else null. */
export function findCodegraph() {
  for (let dir = ROOT; ; dir = path.dirname(dir)) {
    const bin = path.join(dir, "node_modules", ".bin", "codegraph");
    if (fs.existsSync(bin)) return bin;
    if (path.dirname(dir) === dir) break;
  }
  try {
    return execFileSync(process.platform === "win32" ? "where" : "which", ["codegraph"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n")[0].trim() || null;
  } catch {
    return null;
  }
}

/** Run codegraph in a repo, telemetry off. */
export function codegraph(repo, args, { bin = findCodegraph(), quiet = true } = {}) {
  if (!bin) throw new Error(`codegraph isn't installed. Run \`veridic init --install\` or \`npm i -g ${CODEGRAPH_PACKAGE}\``);
  const t = Date.now();
  const run = () => spawnSync(bin, args, { cwd: repo, encoding: "utf8", env: { ...process.env, CODEGRAPH_TELEMETRY: "0", NO_COLOR: "1" }, stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit", timeout: 30 * 60_000 });
  let r = run();
  // Another process (an editor's CodeGraph server, a second agent) may hold the database briefly.
  for (let wait = 1; r.status !== 0 && /database is locked/i.test(`${r.stderr}${r.stdout}`) && wait <= 8; wait *= 2) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait * 1000);
    r = run();
  }
  if (r.status !== 0) throw new Error(`codegraph ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim().slice(-400)}`);
  return { ms: Date.now() - t, out: r.stdout ?? "" };
}

const dbPath = (repo) => path.join(repo, ".codegraph", "codegraph.db");
// Written after each sync: the database may not change (nothing to update, or
// writes still in its -wal journal), so its own time can't say when it was checked.
const MARKER = (repo) => path.join(repo, ".codegraph", "veridic-synced");
const mtime = (f) => {
  try {
    return fs.statSync(f).mtimeMs;
  } catch {
    return 0;
  }
};
const markSynced = (repo) => fs.writeFileSync(MARKER(repo), `${new Date().toISOString()}\n`);

/** Source files changed since the index was built (by modification time), or null with no index. */
export function indexLag(repo) {
  const db = dbPath(repo);
  if (!fs.existsSync(db)) return null;
  const built = Math.max(mtime(db), mtime(`${db}-wal`), mtime(MARKER(repo)));
  let files;
  try {
    files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: repo, encoding: "utf8", maxBuffer: 64 << 20 }).split("\n");
  } catch {
    return { newer: [] };
  }
  const newer = [];
  for (const f of files) {
    if (!SOURCE.test(f) || f.includes("node_modules/")) continue;
    try {
      if (fs.statSync(path.join(repo, f)).mtimeMs > built) newer.push(f);
    } catch {
      // deleted in the working tree
    }
  }
  return { newer };
}

/**
 * Make sure the index exists and is current. Builds it only when `build` is set;
 * syncs an outdated one unless VERIDIC_NO_SYNC=1. Notes go to stderr.
 * @returns {{ index: "missing"|"current"|"synced"|"built"|"outdated", ms?, changed? }}
 */
export function ensureIndex(repo, { build = false, sync = process.env.VERIDIC_NO_SYNC !== "1", log = (m) => process.stderr.write(`veridic: ${m}\n`) } = {}) {
  const lag = indexLag(repo);
  if (!lag) {
    if (!build) return { index: "missing" };
    const { ms } = codegraph(repo, ["init", "-y", "."]);
    markSynced(repo);
    return { index: "built", ms };
  }
  if (!lag.newer.length) return { index: "current" };
  if (!sync) return { index: "outdated", changed: lag.newer.length };
  const bin = findCodegraph();
  if (!bin) {
    log(`the code index is behind ${lag.newer.length} changed file(s), and codegraph isn't installed to update it; line numbers may be off. Run \`veridic init\`.`);
    return { index: "outdated", changed: lag.newer.length };
  }
  const { ms } = codegraph(repo, ["sync", "."], { bin });
  markSynced(repo);
  log(`updated the code index (${lag.newer.length} changed file(s), ${(ms / 1000).toFixed(1)}s)`);
  return { index: "synced", ms, changed: lag.newer.length };
}

const checked = new Set(); // repos already checked in this process

/** Once per process: sync the repo's index if the code moved on. Never throws. */
export function freshIndex(repo) {
  repo = path.resolve(repo);
  if (checked.has(repo)) return;
  checked.add(repo);
  try {
    ensureIndex(repo);
  } catch (e) {
    process.stderr.write(`veridic: couldn't update the code index (${e.message}); results may use old line numbers\n`);
  }
}
