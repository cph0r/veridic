// Route paths and ids, and function extents, shared by every framework adapter.

import { codeOnly } from "../graph.mjs";

/** JSON with comments and trailing commas (tsconfig.json): comments are dropped only outside strings. */
export function jsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") while (i < text.length && text[i] !== "\n") i++;
    else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export const joinPath = (a, b) => `${a}/${b}`.replace(/\/+/g, "/").replace(/(.)\/$/, "$1") || "/";

/** Normalized route id for matching: params become {}. */
export const normRoute = (id) => id.replace(/\{[^}]+\}|:\w+/g, "{}");

/** "POST /api/x" or "post /api/x" -> { method, path } */
export const parseRouteId = (s) => {
  const m = s.trim().match(/^(get|post|put|patch|delete|head|options|all)\s+(\/\S*)$/i);
  return m ? { method: m[1].toUpperCase(), path: m[2] } : null;
};

export function dedupe(xs, key) {
  return [...new Map(xs.map((x) => [key(x), x])).values()];
}

/**
 * Where the function `name` declared in `src` is: its declaration, and its body's first and last
 * character (offsets). Skips braces in parameter and return types; an arrow with an expression
 * body spans that expression. Null when it isn't declared there.
 */
export function functionSpan(src, name, { generics = false } = {}) {
  const code = codeOnly(src);
  // generics: `function f<T extends A<B>>(…)` (opt-in, so Express's reading stays as it was).
  const gen = generics ? "(?:<(?:[^<>]|<(?:[^<>]|<[^<>]*>)*>)*>)?\\s*" : "";
  const m = new RegExp(`(?:function\\s*\\*?\\s*${name}\\s*${gen}\\(|\\b(?:const|let|var)\\s+${name}\\s*(?::[^=]+)?=\\s*(?:async\\s*)?(?:function\\b[^(]*)?\\(?)`).exec(code);
  if (!m) return null;
  // Past the parameter list (whose types may hold braces: `user: { id: string }`) and any return
  // type (`Promise<{ deleted: string }>`): the body is the first brace outside them.
  let at = m.index + m[0].length;
  const paren = code.indexOf("(", m.index + m[0].length - 1);
  if (paren >= 0 && paren - at < 40) {
    let d = 0;
    for (let i = paren; i < code.length; i++) {
      if (code[i] === "(") d++;
      else if (code[i] === ")" && --d === 0) { at = i + 1; break; }
    }
  }
  let open = -1;
  for (let i = at, ang = 0; i < code.length; i++) {
    const c = code[i];
    if (c === "=" && code[i + 1] === ">") {
      const rest = code.slice(i + 2), lead = rest.search(/\S/);
      if (rest[lead] !== "{") { const end = rest.slice(lead).search(/;|\n\s*\n|\n(?=\S)/); return { decl: m.index, open: i + 2 + lead, close: end < 0 ? src.length - 1 : i + 2 + lead + end - 1 }; }
      i++;
    } else if (c === "<") ang++;
    else if (c === ">") ang = Math.max(0, ang - 1);
    else if (c === "{" && ang === 0) { open = i; break; }
    else if (c === ";" && ang === 0) return null;
  }
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}" && --depth === 0) return { decl: m.index, open, close: i };
  }
  return null;
}

/** The lines (1-based) the function `name` spans in `src`: [declaration line, last body line], or null. */
export function functionExtent(src, name) {
  const s = functionSpan(src, name);
  if (!s) return null;
  const line = (i) => src.slice(0, i).split("\n").length;
  return [line(s.decl), line(s.close)];
}
