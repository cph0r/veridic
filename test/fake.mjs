// A fake index over real files: no CodeGraph nodes, so discovery must come from source.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function fakeRepo(files, nodes = []) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "veridic-fake-"));
  for (const [f, t] of Object.entries(files)) fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }), fs.writeFileSync(path.join(repo, f), t);
  const g = {
    repo,
    files: Object.keys(files),
    nodes: new Map(nodes.map((n) => [n.id, n])),
    text: (f) => files[f] ?? null,
    lines: (f) => files[f]?.split("\n") ?? [],
    usesInRange: () => [],
  };
  return { g, done: () => fs.rmSync(repo, { recursive: true, force: true }) };
}
