// One call that prints the code an agent needs to read for a feature: every
// read_list range from scope, in priority order, with line numbers and why it is
// there. Replaces a dozen or more separate file reads, so a spec run takes fewer
// turns (each turn re-reads the whole conversation). Ranges that overlap a range
// already printed are printed once; a budget caps one page, and the output says
// how to get the next one.

import fs from "node:fs";
import path from "node:path";

/**
 * @param readList  scope's read_list: [{ at: "file:start-end", priority, lines, why }]
 * @param opts      { budget: characters per page (default 120000), from: first read_list index }
 * @returns {{ text, printed, total, next: number|null, lines }}
 */
export function bundle(repo, readList, opts = {}) {
  const budget = opts.budget ?? 120_000;
  const from = opts.from ?? 0;
  const cache = new Map();
  const src = (f) => {
    if (!cache.has(f)) cache.set(f, fs.readFileSync(path.join(repo, f), "utf8").split("\n"));
    return cache.get(f);
  };
  const shown = new Map(); // file -> [[start, end]] already printed
  const covered = (file, a, b) => (shown.get(file) ?? []).some(([s, e]) => s <= a && e >= b);

  const parts = [];
  let size = 0;
  let printed = 0;
  let lines = 0;
  let next = null;
  for (let i = from; i < readList.length; i++) {
    const r = readList[i];
    const m = r.at.match(/^(.*):(\d+)-(\d+)$/);
    if (!m) continue;
    const [, file, a, b] = [m[0], m[1], Number(m[2]), Number(m[3])];
    if (covered(file, a, b)) continue;
    let code;
    try {
      code = src(file).slice(a - 1, b);
    } catch {
      continue;
    }
    const width = String(b).length;
    const block = `=== ${file}:${a}-${b}  (${r.why})\n${code.map((l, k) => `${String(a + k).padStart(width)}  ${l}`).join("\n")}\n`;
    if (size + block.length > budget && printed > 0) {
      next = i;
      break;
    }
    parts.push(block);
    size += block.length;
    printed++;
    lines += code.length;
    if (!shown.has(file)) shown.set(file, []);
    shown.get(file).push([a, b]);
  }
  return { text: parts.join("\n"), printed, total: readList.length, next, lines };
}
