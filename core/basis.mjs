// Results tied to the code they checked. A basis is a short digest of the exact
// file contents a result was computed from (cited code and the tests that cover
// it). Stored results (traceability.md's "covered (passing)") carry their basis;
// when the code changes, the stored result is outdated and can't count as a pass.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

/** Digest of these repo-relative files' current contents (missing files count too). */
export function basisOf(repo, files) {
  const list = [...new Set(files)].filter(Boolean).sort();
  const parts = list.map((f) => {
    try {
      return `${f}\0${sha(fs.readFileSync(path.join(repo, f)))}`;
    } catch {
      return `${f}\0missing`;
    }
  });
  return { digest: sha(parts.join("\n")).slice(0, 12), files: list.length };
}

const MARK = /<!--\s*veridic-basis:\s*([0-9a-f]{12})\s+files:\s*(\d+)\s*-->/;

/** The footer line that records a basis in a generated file. */
export const basisComment = (b) => `<!-- veridic-basis: ${b.digest} files: ${b.files} -->`;

/** The basis recorded in a generated file's text, or null. */
export function recordedBasis(text) {
  const m = String(text ?? "").match(MARK);
  return m ? { digest: m[1], files: Number(m[2]) } : null;
}
