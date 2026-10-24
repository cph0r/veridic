// A table's shape, from its schema: columns (name, type, nullable, default, enum values),
// primary key, unique sets and foreign keys. Prisma models, Drizzle tables and SQL CREATE
// TABLE are read; other declarations (Mongoose, Sequelize, TypeORM) are listed without
// columns. The definition is cited with a hash of its lines, so a schema change shows.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { citeHash } from "./citations.mjs";

const read = (repo, f) => { try { return fs.readFileSync(path.join(repo, f), "utf8"); } catch { return null; } };
const files = (repo) => { try { return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: repo, encoding: "utf8", maxBuffer: 64 << 20 }).split("\n").filter((f) => f && !f.includes("node_modules/")); } catch { return []; } };
const lineAt = (text, i) => text.slice(0, i).split("\n").length;

/** The text from `open` (a bracket) to its matching close, or null. */
function balanced(text, open) {
  const pair = { "{": "}", "(": ")", "[": "]" }[text[open]];
  let depth = 0, quote = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote && text[i - 1] !== "\\") quote = null; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === text[open]) depth++;
    else if (c === pair && --depth === 0) return { inner: text.slice(open + 1, i), end: i };
  }
  return null;
}
/** Split on commas at the top level (not inside brackets or strings). */
function topLevel(s) {
  const out = [];
  let depth = 0, quote = null, cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { cur += c; if (c === quote && s[i - 1] !== "\\") quote = null; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; cur += c; continue; }
    if ("([{".includes(c)) depth++;
    if (")]}".includes(c)) depth--;
    if (c === "," && depth === 0) { out.push(cur); cur = ""; } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}
const strings = (s) => [...String(s).matchAll(/["'`]([^"'`]*)["'`]/g)].map((m) => m[1]);
const col = (name, type, nullable, extra = {}) => ({ name, type, nullable, ...(extra.default != null ? { default: extra.default } : {}), ...(extra.enum ? { enum: extra.enum } : {}) });

// ---- Prisma ----
function prismaShape(repo, file, text, line) {
  const enums = new Map(), models = new Map(), bodies = new Map();
  for (const f of files(repo).filter((x) => x.endsWith(".prisma"))) {
    const t = f === file ? text : read(repo, f) ?? "";
    for (const m of t.matchAll(/^\s*enum\s+(\w+)\s*\{([\s\S]*?)^\s*\}/gm)) enums.set(m[1], m[2].split("\n").map((l) => l.trim().split(/\s/)[0]).filter((v) => v && !v.startsWith("//") && !v.startsWith("@")));
    for (const m of t.matchAll(/^\s*model\s+(\w+)\s*\{([\s\S]*?)^\s*\}/gm)) models.set(m[1], m[2].match(/@@map\(\s*(?:name:\s*)?["'](\w+)["']/)?.[1] ?? m[1]), bodies.set(m[1], m[2]);
  }
  const re = /^\s*model\s+(\w+)\s*\{([\s\S]*?)^\s*\}/gm;
  let m;
  const at = (x) => x.index + x[0].search(/\bmodel\b/); // the match may start on a blank line before it
  while ((m = re.exec(text)) && lineAt(text, at(m)) < line);
  if (!m) return null;
  const start = lineAt(text, at(m)), end = lineAt(text, m.index + m[0].length);
  const columns = [], primaryKey = [], unique = [], foreignKeys = [], manyToMany = [];
  const later = [];
  const relName = (attrs) => attrs.match(/@relation\(\s*(?:name:\s*)?["'](\w+)["']/)?.[1] ?? null;
  // Lists on both sides with no key column: Prisma's implicit join table.
  const listsBack = (field, type, name) => (bodies.get(type) ?? "").split("\n").some((raw) => {
    const f = uncomment(raw).trim().match(/^(\w+)\s+(\w+)\[\]\s*(.*)$/);
    return f && f[2] === m[1] && relName(f[3]) === name && !(type === m[1] && f[1] === field);
  });
  for (const raw of m[2].split("\n")) {
    const l = uncomment(raw).trim();
    if (!l) continue;
    if (l.startsWith("@@")) { later.push(l); continue; }
    const f = l.match(/^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/);
    if (!f) continue;
    const [, field, type, list, opt, attrs] = f;
    const rel = attrs.match(/@relation\(([^)]*)\)/);
    if (models.has(type) || list) {
      if (list && models.has(type) && listsBack(field, type, relName(attrs))) manyToMany.push({ field, table: models.get(type), ...(relName(attrs) ? { via: relName(attrs) } : {}) });
      if (rel) {
        const fields = rel[1].match(/fields:\s*\[([^\]]*)\]/)?.[1], refs = rel[1].match(/references:\s*\[([^\]]*)\]/)?.[1];
        if (fields) foreignKeys.push({ columns: fields.split(",").map((x) => x.trim()), table: models.get(type) ?? type, references: (refs ?? "").split(",").map((x) => x.trim()).filter(Boolean) });
      }
      continue;
    }
    const name = attrs.match(/@map\(\s*["'](\w+)["']\s*\)/)?.[1] ?? field;
    const di = attrs.indexOf("@default(");
    const def = di >= 0 ? balanced(attrs, di + "@default".length)?.inner : null;
    columns.push(col(name, type, !!opt, { default: def, enum: enums.get(type) }));
    if (/@id\b/.test(attrs)) primaryKey.push(name);
    if (/@unique\b/.test(attrs)) unique.push([name]);
  }
  for (const l of later) {
    const ids = l.match(/^@@id\(\s*\[([^\]]*)\]/)?.[1];
    if (ids) primaryKey.push(...ids.split(",").map((x) => x.trim()));
    const un = l.match(/^@@unique\(\s*\[([^\]]*)\]/)?.[1];
    if (un) unique.push(un.split(",").map((x) => x.trim()));
  }
  return { start, end, columns, primaryKey, unique, foreignKeys, ...(manyToMany.length ? { manyToMany } : {}) };
}

// ---- Drizzle ----
function drizzleTables(repo) {
  const out = new Map(); // const name -> { name, text, open }
  for (const f of files(repo).filter((x) => /\.[cm]?[jt]s$/.test(x))) {
    const t = uncomment(read(repo, f) ?? "");
    if (!/Table\(/.test(t)) continue;
    for (const m of t.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*(?:pg|sqlite|mysql|singlestore)Table\(\s*["'`](\w+)["'`]\s*,\s*\{/g)) out.set(m[1], { name: m[2], text: t, open: m.index + m[0].length - 1 });
  }
  return out;
}
/** Comments blanked with spaces (lines and positions kept), so an apostrophe in one isn't a quote. */
function uncomment(text) {
  let out = "", quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { out += c; if (c === quote && text[i - 1] !== "\\") quote = null; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; continue; }
    if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") { out += " "; i++; } out += text[i] ?? ""; continue; }
    if (c === "/" && text[i + 1] === "*") { const end = text.indexOf("*/", i + 2); const stop = end < 0 ? text.length : end + 2; out += text.slice(i, stop).replace(/[^\n]/g, " "); i = stop - 1; continue; }
    out += c;
  }
  return out;
}

function drizzleShape(repo, file, raw, line) {
  const text = uncomment(raw);
  const re = /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:pg|sqlite|mysql|singlestore)Table\(\s*["'`](\w+)["'`]\s*,\s*\{/g;
  let m;
  while ((m = re.exec(text)) && lineAt(text, m.index) < line);
  if (!m) return null;
  const obj = balanced(text, m.index + m[0].length - 1);
  if (!obj) return null;
  const close = balanced(text, text.indexOf("(", m.index));
  const start = lineAt(text, m.index), end = lineAt(text, close ? close.end : obj.end);
  const enums = new Map();
  for (const e of text.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*(?:pg|mysql)Enum\(\s*["'`](\w+)["'`]\s*,\s*\[([^\]]*)\]/g)) enums.set(e[1], { name: e[2], values: strings(e[3]) });
  const tables = drizzleTables(repo);
  const columnOf = (constName, key) => {
    const t = tables.get(constName);
    if (!t) return key;
    const o = balanced(t.text, t.open);
    const entry = o && topLevel(o.inner).find((x) => x.startsWith(key + ":") || x.startsWith(key + " :"));
    return entry ? strings(entry.slice(entry.indexOf(":") + 1))[0] ?? key : key;
  };
  const columns = [], primaryKey = [], unique = [], foreignKeys = [];
  for (const entry of topLevel(obj.inner)) {
    const e = entry.match(/^(\w+)\s*:\s*(\w+)\s*\(([\s\S]*)$/);
    if (!e) continue;
    const [, key, callee] = e;
    const args = balanced(entry, entry.indexOf("(", entry.indexOf(":")));
    const chain = args ? entry.slice(entry.indexOf("(", entry.indexOf(":")) + args.inner.length + 2) : "";
    const name = strings(args?.inner.split(",")[0] ?? "")[0] ?? key;
    const en = enums.get(callee);
    const inline = args && args.inner.match(/\benum\s*:\s*\[([^\]]*)\]/);
    const dIdx = chain.indexOf(".default(");
    const def = dIdx >= 0 ? balanced(chain, dIdx + ".default".length)?.inner : /\.defaultNow\(\)/.test(chain) ? "now()" : /\.defaultRandom\(\)/.test(chain) ? "random()" : null;
    columns.push(col(name, en ? en.name : callee, !/\.notNull\(\)/.test(chain), { default: def, enum: en ? en.values : inline ? strings(inline[1]) : null }));
    if (/\.primaryKey\(\)/.test(chain)) primaryKey.push(name);
    if (/\.unique\(\)/.test(chain)) unique.push([name]);
    const ref = chain.match(/\.references\(\s*\(\)\s*=>\s*(\w+)\.(\w+)/);
    if (ref) foreignKeys.push({ columns: [name], table: tables.get(ref[1])?.name ?? ref[1], references: [columnOf(ref[1], ref[2])] });
  }
  return { start, end, columns, primaryKey, unique, foreignKeys };
}

// ---- SQL ----
function sqlShape(raw, line) {
  const text = raw.replace(/--[^\n]*/g, (m) => " ".repeat(m.length)); // a comment's apostrophe isn't a quote
  const re = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[`"\w]+\.)?[`"[]?(\w+)[`"\]]?\s*\(/gi;
  let m;
  while ((m = re.exec(text)) && lineAt(text, m.index) < line);
  if (!m) return null;
  const body = balanced(text, m.index + m[0].length - 1);
  if (!body) return null;
  const start = lineAt(text, m.index), end = lineAt(text, body.end);
  const columns = [], primaryKey = [], unique = [], foreignKeys = [];
  const names = (s) => s.split(",").map((x) => x.trim().replace(/[`"[\]]/g, "")).filter(Boolean);
  const tableCons = [];
  for (const def of topLevel(body.inner)) {
    if (/^(?:CONSTRAINT\s+\w+\s+)?(?:PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK|INDEX|KEY)\b/i.test(def)) { tableCons.push(def); continue; }
    const c = def.match(/^[`"[]?(\w+)[`"\]]?\s+(\w+(?:\s*\([^)]*\))?)\s*([\s\S]*)$/);
    if (!c) continue;
    const [, name, type, rest] = c;
    const def0 = rest.match(/\bDEFAULT\s+('[^']*'|\([^)]*\)|[^\s,]+)/i)?.[1] ?? null;
    columns.push(col(name, type.replace(/\s+/g, ""), !/\bNOT\s+NULL\b/i.test(rest), { default: def0 }));
    if (/\bPRIMARY\s+KEY\b/i.test(rest)) primaryKey.push(name);
    if (/\bUNIQUE\b/i.test(rest)) unique.push([name]);
    const ref = rest.match(/\bREFERENCES\s+[`"]?(\w+)[`"]?\s*\(([^)]*)\)/i);
    if (ref) foreignKeys.push({ columns: [name], table: ref[1], references: names(ref[2]) });
  }
  for (const t of tableCons) {
    let x;
    if ((x = t.match(/PRIMARY\s+KEY\s*\(([^)]*)\)/i))) primaryKey.push(...names(x[1]));
    else if ((x = t.match(/FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+[`"]?(\w+)[`"]?\s*\(([^)]*)\)/i))) foreignKeys.push({ columns: names(x[1]), table: x[2], references: names(x[3]) });
    else if ((x = t.match(/UNIQUE\s*(?:KEY\s+\w+\s*)?\(([^)]*)\)/i))) unique.push(names(x[1]));
  }
  return { start, end, columns, primaryKey, unique, foreignKeys };
}

/** A migration that creates the same table, compared by column names (case and _ ignored). */
function migrationDisagreement(repo, table, shape) {
  const norm = (s) => s.toLowerCase().replace(/[_"`[\]]/g, "");
  const name = `(?:[\`"\\w]+\\.)?[\`"[]?${table}[\`"\\]]?`;
  // The migrations in order (their folders and files are named by time or number): the table's
  // CREATE, then each later ALTER that adds, drops or renames a column.
  let cols = null, at = null;
  for (const f of files(repo).filter((x) => x.endsWith(".sql")).sort()) {
    const t = read(repo, f) ?? "";
    const create = new RegExp(`\\bCREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${name}\\s*\\(`, "i").exec(t);
    let from = 0;
    if (create && !cols) {
      const mig = sqlShape(t, lineAt(t, create.index));
      if (!mig) continue;
      cols = mig.columns.map((c) => c.name);
      at = `${f}:${lineAt(t, create.index)}`;
      from = create.index + create[0].length;
    }
    if (!cols) continue;
    for (const alt of t.slice(from).matchAll(new RegExp(`\\bALTER\\s+TABLE\\s+(?:ONLY\\s+)?(?:IF\\s+EXISTS\\s+)?${name}\\s+([^;]*)`, "gi")))
      for (const action of alt[1].split(/,\s*(?=(?:ADD|DROP|RENAME|ALTER)\b)/i)) {
        let m;
        if ((m = action.match(/^\s*ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?(\w+)/i)) && !/^(?:CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|INDEX|KEY)$/i.test(m[1])) cols.push(m[1]);
        else if ((m = action.match(/^\s*DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?[`"[]?(\w+)/i)) && !/^(?:CONSTRAINT|INDEX|KEY|PRIMARY|FOREIGN)$/i.test(m[1])) cols = cols.filter((c) => norm(c) !== norm(m[1]));
        else if ((m = action.match(/^\s*RENAME\s+(?:COLUMN\s+)?[`"[]?(\w+)[`"\]]?\s+TO\s+[`"[]?(\w+)/i))) cols = cols.map((c) => (norm(c) === norm(m[1]) ? m[2] : c));
      }
  }
  if (!cols) return null;
  const a = new Set(shape.columns.map((c) => norm(c.name))), b = new Set(cols.map(norm));
  const onlyInSchema = shape.columns.filter((c) => !b.has(norm(c.name))).map((c) => c.name);
  const onlyInMigration = cols.filter((c) => !a.has(norm(c)));
  return onlyInSchema.length || onlyInMigration.length ? { at, onlyInSchema, onlyInMigration } : null;
}

/**
 * A table's shape: { name, kind, at: "file:start-end", hash, columns, primaryKey, unique,
 * foreignKeys, manyToMany?, disagreement? } (manyToMany: Prisma lists on both sides; disagreement: a
 * migration for the same table with other columns).
 */
export function tableShape(repo, table) {
  if (!table) return null;
  const text = read(repo, table.file) ?? "";
  const line = Number(String(table.at).split(":").pop());
  const s = table.kind === "prisma" ? prismaShape(repo, table.file, text, line) : table.kind === "drizzle" ? drizzleShape(repo, table.file, text, line) : table.kind === "sql" ? sqlShape(text, line) : null;
  if (!s) return { name: table.name, kind: table.kind, at: table.at, columns: [], primaryKey: [], unique: [], foreignKeys: [], note: `columns aren't read for ${table.kind} yet` };
  const lines = text.split("\n").slice(s.start - 1, s.end);
  const shape = { name: table.name, kind: table.kind, at: `${table.file}:${s.start}-${s.end}`, hash: citeHash(lines), columns: s.columns, primaryKey: s.primaryKey, unique: s.unique, foreignKeys: s.foreignKeys, ...(s.manyToMany ? { manyToMany: s.manyToMany } : {}) };
  const dis = table.kind !== "sql" ? migrationDisagreement(repo, table.name, shape) : null;
  return dis ? { ...shape, disagreement: dis } : shape;
}

const row = (cells) => "|" + cells.map((c) => (c === "" ? " " : ` ${c} `)).join("|") + "|";

/** The spec's data section: each table's columns, then its foreign keys. */
export function dataMarkdown(shapes) {
  const out = ["## Data (generated)", ""];
  for (const t of shapes.filter(Boolean)) {
    out.push(`### ${t.name}${t.hash ? ` [evidence: ${t.at}~${t.hash}]` : ` [evidence: ${t.at}]`}`, "");
    if (t.note) { out.push(`_${t.note}._`, ""); continue; }
    out.push("| Column | Type | Null | Default | Key |", "|---|---|---|---|---|");
    for (const c of t.columns) {
      const key = [t.primaryKey.includes(c.name) ? "primary" : "", t.unique.some((u) => u.length === 1 && u[0] === c.name) ? "unique" : "", ...t.foreignKeys.filter((f) => f.columns.length === 1 && f.columns[0] === c.name).map((f) => `→ ${f.table}.${f.references.join(",")}`)].filter(Boolean).join(", ");
      out.push(row([c.name, c.enum ? `${c.type} (${c.enum.join(", ")})` : c.type, c.nullable ? "yes" : "no", c.default ?? "", key]));
    }
    const multi = [...t.unique.filter((u) => u.length > 1).map((u) => `Unique together: ${u.join(", ")}.`), ...t.foreignKeys.filter((f) => f.columns.length > 1 || !t.columns.some((c) => c.name === f.columns[0])).map((f) => `${f.columns.join(", ")} → ${f.table}.${f.references.join(", ")}.`)];
    if (t.manyToMany) multi.push(`Many-to-many: ${t.manyToMany.map((x) => `${x.field} ↔ ${x.table}${x.via ? ` (${x.via})` : ""}`).join("; ")}.`);
    if (t.disagreement) multi.push(`The migration at \`${t.disagreement.at}\` disagrees: only in the schema: ${t.disagreement.onlyInSchema.join(", ") || "none"}; only in the migration: ${t.disagreement.onlyInMigration.join(", ") || "none"}.`);
    out.push("", ...multi, ...(multi.length ? [""] : []));
  }
  return out.join("\n");
}

/** Where a spec's data section and the schema disagree now: [{ table, problem }]. */
export function dataDrift(spec, repo, { findTables }) {
  const i = String(spec).search(/^## Data \(generated\)/m);
  if (i < 0) return [];
  const section = String(spec).slice(i).split(/\n## /)[0];
  const tables = findTables(repo);
  const out = [];
  for (const block of section.split(/\n### /).slice(1)) {
    const name = block.match(/^(\w+)/)?.[1];
    const cols = [...block.matchAll(/^\| (\w+) \|/gm)].map((m) => m[1]).filter((c) => c !== "Column");
    const now = tableShape(repo, tables.find((t) => t.name === name));
    if (!now) { out.push({ table: name, problem: "table not found in the schema" }); continue; }
    const have = new Set(now.columns.map((c) => c.name)), had = new Set(cols);
    const added = [...have].filter((c) => !had.has(c)), removed = [...had].filter((c) => !have.has(c));
    if (added.length || removed.length) out.push({ table: name, problem: `columns changed: ${[added.length ? `added ${added.join(", ")}` : "", removed.length ? `removed ${removed.join(", ")}` : ""].filter(Boolean).join("; ")}` });
  }
  return out;
}
