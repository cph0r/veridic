// Route paths and ids, shared by every framework adapter.

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
