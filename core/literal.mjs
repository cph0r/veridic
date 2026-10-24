// A JS object literal as written in a test or a spec ({ title: 'Hi', n: 2 }) to JSON, without
// evaluating anything.

/** An example's body as written ({ title: 'Hi', n: 2 }) to JSON, without evaluating anything:
 * keys get quoted and strings re-quoted outside strings only; anything else (a variable, an
 * expression) makes it not JSON, and undefined comes back. */
export function literalJson(body) {
  if (body == null) return undefined;
  try { return JSON.stringify(JSON.parse(body)); } catch {}
  const s = String(body);
  let out = "", last = "";
  for (let i = 0; i < s.length; ) {
    const c = s[i];
    if (c === '"' || c === "'") {
      let v = "";
      for (i++; i < s.length && s[i] !== c; i++) {
        if (s[i] === "\\" && i + 1 < s.length) { i++; v += s[i] === "'" ? "'" : s[i] === '"' ? '\\"' : `\\${s[i]}`; }
        else v += s[i] === '"' ? '\\"' : s[i];
      }
      if (i >= s.length) return undefined;
      out += `"${v}"`; last = '"'; i++;
      continue;
    }
    const id = s.slice(i).match(/^[A-Za-z_$][\w$]*/);
    if (id) {
      const key = (last === "{" || last === ",") && /^\s*:/.test(s.slice(i + id[0].length));
      out += key ? JSON.stringify(id[0]) : id[0]; last = "a"; i += id[0].length;
      continue;
    }
    if (c === "," && /^,\s*[}\]]/.test(s.slice(i))) { i++; continue; }
    out += c;
    if (!/\s/.test(c)) last = c;
    i++;
  }
  try { return JSON.stringify(JSON.parse(out)); } catch { return undefined; }
}
