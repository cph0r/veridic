// Shared argument parsing and output for the veridic scripts. Every script
// prints one JSON document to stdout and exits 0 (ok), 1 (problems found) or
// 2 (usage or setup error).

import fs from "node:fs";
import path from "node:path";

export function parseArgs(argv, { flags = [], bools = [] } = {}) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const [k, inline] = a.slice(2).split(/=(.*)/s);
    if (bools.includes(k)) out[k] = true;
    else if (flags.includes(k)) out[k] = inline ?? argv[++i];
    else fail(`unknown option --${k}`);
  }
  if (out.repo) out.repo = path.resolve(out.repo);
  return out;
}

// process.stdout is asynchronous for pipes on macOS, so write()+exit() can cut
// a large JSON document short. Write synchronously, retrying while the pipe is full.
export function writeAll(text) {
  const buf = Buffer.from(text);
  let off = 0;
  while (off < buf.length) {
    try {
      off += fs.writeSync(1, buf, off);
    } catch (e) {
      if (e.code === "EPIPE") return; // the reader stopped early (e.g. `| head`): nothing left to do
      if (e.code !== "EAGAIN") throw e;
    }
  }
}

// Indented for a person at a terminal; compact for an agent or a pipe, where
// every character stays in the conversation and is re-read on later turns.
export const toJson = (x) => JSON.stringify(x, null, process.stdout.isTTY ? 2 : 0);

export function emit(result, problems) {
  writeAll(toJson(result) + "\n");
  process.exit(problems ? 1 : 0);
}

export function fail(message, usage) {
  writeAll(toJson({ error: message, ...(usage ? { usage } : {}) }) + "\n");
  process.exit(2);
}

export async function run(main, usage) {
  try {
    await main();
  } catch (err) {
    fail(err.message, usage);
  }
}
