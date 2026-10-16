// A small YAML reader for OpenAPI documents: block maps and sequences, plain and
// quoted scalars, flow collections (also spread over several lines), comments and
// block scalars. No anchors, aliases, tags or multi-document streams.

export function parseYaml(text) {
  const rows = toRows(text);
  const [value] = parseBlock(rows, 0, rows[0]?.indent ?? 0);
  return value ?? null;
}

function toRows(text) {
  const raw = text.split("\n");
  const rows = [];
  for (let i = 0; i < raw.length; i++) {
    let t = stripComment(raw[i]);
    if (!t.trim() || t.trim() === "---") continue;
    const indent = t.length - t.trimStart().length;
    t = t.trim();
    // Join a flow collection that continues on the following lines.
    while (unbalanced(t) && i + 1 < raw.length) t += " " + stripComment(raw[++i]).trim();
    // Block scalar: keep the indented lines that follow as its text.
    const block = t.match(/^(.*?:\s*|-\s+)([|>])[-+]?$/);
    if (block) {
      const body = [];
      while (i + 1 < raw.length && (!raw[i + 1].trim() || raw[i + 1].length - raw[i + 1].trimStart().length > indent)) body.push(raw[++i].trim());
      t = `${block[1]}${JSON.stringify(body.join(block[2] === "|" ? "\n" : " ").trim())}`;
    }
    rows.push({ indent, text: t, line: i + 1 });
  }
  return rows;
}

function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i).trimEnd();
  }
  return line;
}

function unbalanced(t) {
  let depth = 0;
  let q = null;
  for (const c of t) {
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
  }
  const v = t.replace(/^-\s+/, "").replace(/^[^"'[{]*?:\s+/, "");
  return depth > 0 && /^[[{]/.test(v);
}

/** Parses rows starting at i at the given indent. Returns [value, nextIndex]. */
function parseBlock(rows, i, indent) {
  if (i >= rows.length) return [null, i];
  if (/^[[{"']/.test(rows[i].text) && !isKeyLine(rows[i].text)) return [scalar(rows[i].text), i + 1];
  return rows[i].text.startsWith("- ") || rows[i].text === "-" ? parseSeq(rows, i, indent) : parseMap(rows, i, indent);
}

function parseSeq(rows, i, indent) {
  const out = [];
  while (i < rows.length && rows[i].indent === indent && (rows[i].text.startsWith("- ") || rows[i].text === "-")) {
    const rest = rows[i].text.slice(1).trim();
    if (!rest) {
      const [v, j] = rows[i + 1]?.indent > indent ? parseBlock(rows, i + 1, rows[i + 1].indent) : [null, i + 1];
      out.push(v);
      i = j;
    } else if (isKeyLine(rest)) {
      // "- key: value" starts a map whose other keys sit at indent + 2.
      const inner = indent + rows[i].text.indexOf(rest);
      const sub = [{ indent: inner, text: rest, line: rows[i].line }];
      let j = i + 1;
      while (j < rows.length && rows[j].indent >= inner) sub.push(rows[j++]);
      out.push(parseMap(sub, 0, inner)[0]);
      i = j;
    } else {
      out.push(scalar(rest));
      i++;
    }
  }
  return [out, i];
}

function parseMap(rows, i, indent) {
  const out = {};
  while (i < rows.length && rows[i].indent === indent && !rows[i].text.startsWith("- ")) {
    const m = splitKey(rows[i].text);
    if (!m) {
      i++;
      continue;
    }
    const [key, rest] = m;
    if (rest) {
      out[key] = scalar(rest);
      i++;
    } else if (rows[i + 1] && (rows[i + 1].indent > indent || (rows[i + 1].indent === indent && rows[i + 1].text.startsWith("- ")))) {
      [out[key], i] = parseBlock(rows, i + 1, rows[i + 1].indent);
    } else {
      out[key] = null;
      i++;
    }
  }
  return [out, i];
}

const isKeyLine = (t) => !!splitKey(t) && !/^[[{]/.test(t);

function splitKey(t) {
  const q = t.match(/^(["'])((?:(?!\1).)*)\1\s*:(?:\s+(.*))?$/);
  if (q) return [q[2], q[3]?.trim() ?? ""];
  const m = t.match(/^([^:"'[{][^:]*?)\s*:(?:\s+(.*))?$/);
  return m ? [m[1], m[2]?.trim() ?? ""] : null;
}

function scalar(s) {
  s = s.trim();
  if (s.startsWith("[") || s.startsWith("{")) return flow(s, { i: 0 });
  if (/^"/.test(s)) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  if (/^'/.test(s)) return s.slice(1, -1).replace(/''/g, "'");
  if (s === "~" || s === "null") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function flow(s, p) {
  const ws = () => {
    while (/\s/.test(s[p.i])) p.i++;
  };
  ws();
  if (s[p.i] === "[") {
    p.i++;
    const out = [];
    for (ws(); s[p.i] !== "]" && p.i < s.length; ws()) {
      out.push(flowItem(s, p));
      ws();
      if (s[p.i] === ",") p.i++;
    }
    p.i++;
    return out;
  }
  if (s[p.i] === "{") {
    p.i++;
    const out = {};
    for (ws(); s[p.i] !== "}" && p.i < s.length; ws()) {
      const k = flowToken(s, p, /[:,}]/);
      ws();
      if (s[p.i] === ":") {
        p.i++;
        out[k] = flowItem(s, p);
      } else out[k] = null;
      ws();
      if (s[p.i] === ",") p.i++;
    }
    p.i++;
    return out;
  }
  return flowItem(s, p);
}

function flowItem(s, p) {
  while (/\s/.test(s[p.i])) p.i++;
  if (s[p.i] === "[" || s[p.i] === "{") return flow(s, p);
  return scalar(flowToken(s, p, /[,\]}]/, true));
}

function flowToken(s, p, stop, raw = false) {
  while (/\s/.test(s[p.i])) p.i++;
  const q = s[p.i];
  if (q === '"' || q === "'") {
    const start = p.i;
    for (p.i++; p.i < s.length && s[p.i] !== q; p.i++) if (q === '"' && s[p.i] === "\\") p.i++;
    p.i++;
    const tok = s.slice(start, p.i);
    return raw ? tok : scalar(tok);
  }
  const start = p.i;
  while (p.i < s.length && !stop.test(s[p.i])) p.i++;
  return s.slice(start, p.i).trim();
}
