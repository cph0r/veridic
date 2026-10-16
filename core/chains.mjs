// Method chains in source: `router.route("/x").get(a).post(b)` or
// `Router().use(a).use("/p", b)`, across lines. Comments and string contents are
// blanked first (offsets kept), so a chain is only real code; string arguments
// are read back from the original source at the same offsets.

import { codeOnly } from "./tests.mjs";

const lineAt = (src) => {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") starts.push(i + 1);
  return (idx) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
};

/** Index just past the paren that closes the one opened before `from`. */
export function closeParen(code, from) {
  let depth = 1;
  for (let i = from; i < code.length; i++) {
    if (code[i] === "(") depth++;
    else if (code[i] === ")" && --depth === 0) return i;
  }
  return code.length;
}

/** Arguments of a call, split at top-level commas: [{ text, raw }] (raw = original source). */
export function splitArgs(code, src, start, end) {
  const out = [];
  let depth = 0;
  let from = start;
  for (let i = start; i <= end; i++) {
    const c = code[i];
    if (i === end || (c === "," && depth === 0)) {
      out.push({ text: code.slice(from, i).trim(), raw: src.slice(from, i).trim() });
      from = i + 1;
    } else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
  }
  return out.filter((a) => a.text);
}

/** A string literal's value, or null: `"/x"`, `'/x'`, or a template with no `${}`. */
export const stringValue = (raw) => raw.match(/^(["'`])([^"'`$]*)\1$/)?.[2] ?? null;

/**
 * The call chains that start at `from` (just after a root expression).
 * @returns [{ name, line, endLine, args: [{text, raw}] }]
 */
export function chainAt(code, src, from, line) {
  const calls = [];
  let j = from;
  for (;;) {
    while (/\s/.test(code[j] ?? "")) j++;
    if (code[j] !== ".") break;
    j++;
    while (/\s/.test(code[j] ?? "")) j++;
    const m = code.slice(j).match(/^([A-Za-z_$][\w$]*)\s*\(/);
    if (!m) break;
    const open = j + m[0].length;
    const close = closeParen(code, open);
    calls.push({ name: m[1], line: line(j), endLine: line(close), args: splitArgs(code, src, open, close) });
    j = close + 1;
  }
  return calls;
}

/**
 * Every chain rooted at one of `names` (a variable) or at a `Router()` /
 * `express.Router()` call assigned to it. Returns [{ root, line, calls }].
 */
export function chainsOf(src, names) {
  const code = codeOnly(src);
  const line = lineAt(src);
  const out = [];
  if (!names.length) return out;
  const alt = names.map((n) => n.replace(/\$/g, "\\$")).join("|");
  // `v.get(…)`, `v\n  .route(…)`: the variable itself, not a property (`x.v`) or a declaration's name.
  for (const m of code.matchAll(new RegExp(`(?<![\\w$.])(${alt})(?![\\w$])`, "g"))) {
    const before = code.slice(Math.max(0, m.index - 12), m.index);
    if (/\b(?:const|let|var|function)\s+$/.test(before)) continue;
    const calls = chainAt(code, src, m.index + m[0].length, line);
    if (calls.length) out.push({ root: m[1], line: line(m.index), calls });
  }
  // `const v = Router().use(…)`: the chain on the initializer belongs to v.
  for (const m of code.matchAll(new RegExp(`\\b(?:const|let|var)\\s+(${alt})\\s*(?::[^=]+)?=\\s*(?:express\\s*\\.\\s*)?Router\\s*\\(`, "g"))) {
    const close = closeParen(code, m.index + m[0].length);
    const calls = chainAt(code, src, close + 1, line);
    if (calls.length) out.push({ root: m[1], line: line(m.index), calls });
  }
  return out;
}

/** Chains on anonymous routers: `export default Router().use("/api", api)`. */
export function anonymousRouterChains(src) {
  const code = codeOnly(src);
  const line = lineAt(src);
  const out = [];
  for (const m of code.matchAll(/(?<![\w$.])(?:express\s*\.\s*)?Router\s*\(/g)) {
    const before = code.slice(Math.max(0, m.index - 40), m.index);
    if (/=\s*$/.test(before)) continue; // assigned: chainsOf handles it under the variable's name
    const close = closeParen(code, m.index + m[0].length);
    const calls = chainAt(code, src, close + 1, line);
    if (calls.length) out.push({ root: "*", line: line(m.index), calls });
  }
  return out;
}
