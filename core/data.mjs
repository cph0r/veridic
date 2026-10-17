// The data: which tables the app has, and which routes read, write or delete each
// one. A module owns the tables it writes most; the rest it only uses. This is what
// someone working on one module needs to know about the database: what is theirs to
// change, and what belongs to another module.
//
// Tables come from the schema: Drizzle (pgTable/sqliteTable/mysqlTable), Prisma models,
// Mongoose and Sequelize models, TypeORM entities, and CREATE TABLE / createTable in
// SQL and Knex migrations. Uses are found on the lines a route reaches (see reach.mjs).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { reached } from "./reach.mjs";

const SKIP = /(^|\/)(node_modules|dist|build|coverage|\.next|\.codegraph|\.veridic|vendor)\//;
const TEST = /(^|\/)(__tests__|tests?|e2e|cypress|playwright|__mocks__|mocks?|fixtures?)\/|\.(test|spec|d)\.[cm]?[jt]sx?$/;
const COMMENT = /^\s*(?:\/\/|\*|\/\*|--)/;
const esc = (s) => s.replace(/[$.]/g, "\\$&");
const lineOf = (text, i) => text.slice(0, i).split("\n").length;

function listFiles(repo, g) {
  try {
    return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: repo, encoding: "utf8", maxBuffer: 64 << 20 }).split("\n").filter(Boolean);
  } catch {
    return g?.files ?? [];
  }
}

/** The tables declared in the repo: [{ name, kind, at, ids, accessor? }]. */
export function findTables(repo, g = null) {
  const byName = new Map();
  // ids are query-builder names (Drizzle's ordersTable); models are classes called directly (Order.find).
  const add = (name, kind, file, line, ids = [], accessor = null) => {
    const key = name.toLowerCase();
    const t = byName.get(key) ?? byName.set(key, { name, kind, at: `${file}:${line}`, ids: new Set(), models: new Set(), accessors: new Set(), file }).get(key);
    // The schema beats a migration as the place to read a table's definition, and a
    // hand-written schema beats one drizzle-kit generated into its migrations folder.
    if ((t.kind === "sql" && kind !== "sql") || (generated(t.file) && !generated(file) && kind !== "sql")) Object.assign(t, { kind, at: `${file}:${line}`, file });
    for (const id of ids) if (id) (kind === "drizzle" ? t.ids : t.models).add(id);
    if (accessor) t.accessors.add(accessor);
  };
  const all = listFiles(repo, g);
  const migrationDirs = new Set(all.filter((f) => f.endsWith("meta/_journal.json")).map((f) => path.dirname(path.dirname(f))));
  const generated = (f) => migrationDirs.has(path.dirname(f));
  for (const file of all) {
    if (SKIP.test(file) || TEST.test(file)) continue;
    const prisma = file.endsWith(".prisma");
    const sql = file.endsWith(".sql");
    if (!prisma && !sql && !/\.[cm]?[jt]sx?$/.test(file)) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(repo, file), "utf8");
    } catch {
      continue;
    }
    if (text.length > 2e6) continue;
    let m;
    if (prisma) {
      for (const re = /^\s*model\s+(\w+)\s*\{([\s\S]*?)^\s*\}/gm; (m = re.exec(text)); ) {
        const mapped = m[2].match(/@@map\(\s*(?:name:\s*)?["'](\w+)["']/)?.[1];
        add(mapped ?? m[1], "prisma", file, lineOf(text, m.index), [], m[1][0].toLowerCase() + m[1].slice(1));
      }
      continue;
    }
    // CREATE TABLE in SQL and raw migrations; createTable in Knex migrations.
    for (const re = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[`"\w]+\.)?[`"[]?(\w+)/gi; (m = re.exec(text)); ) add(m[1], "sql", file, lineOf(text, m.index));
    if (sql) continue;
    for (const re = /\.createTable(?:IfNotExists)?\(\s*["'`](\w+)["'`]/g; (m = re.exec(text)); ) add(m[1], "sql", file, lineOf(text, m.index));
    // Drizzle: export const ordersTable = pgTable("orders", …)
    for (const re = /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:pg|sqlite|mysql|singlestore)Table\(\s*["'`](\w+)["'`]/g; (m = re.exec(text)); ) add(m[2], "drizzle", file, lineOf(text, m.index), [m[1]]);
    // Mongoose: const Order = mongoose.model("Order", schema); module.exports = model<IUser>("User", …)
    for (const re = /(?:\b(?:const|let|var)\s+(\w+)\s*=\s*|exports?\b[\w.]*\s*=\s*|export\s+default\s+)?\b(?:mongoose\.|connection\.|db\.)?model\s*(?:<[^>()]*>)?\(\s*["'`](\w+)["'`]\s*,/g; (m = re.exec(text)); ) {
      if (!/mongoose|Schema\b/.test(text)) break;
      add(m[2], "mongoose", file, lineOf(text, m.index), [m[2], m[1]]);
    }
    // Sequelize: sequelize.define("user", …); class UserModel extends Model … init(…, { tableName })
    for (const re = /\b(?:const|let|var)\s+(\w+)\s*=\s*\w+\.define\(\s*["'`](\w+)["'`]/g; (m = re.exec(text)); ) add(m[2], "sequelize", file, lineOf(text, m.index), [m[1]]);
    for (const re = /\bclass\s+(\w+)\s+extends\s+Model\b/g; (m = re.exec(text)); ) {
      if (!/sequelize/i.test(text)) break;
      const name = text.slice(m.index).match(/\btableName:\s*["'`](\w+)["'`]/)?.[1] ?? m[1].replace(/Model$/, "");
      // export { Basket as BasketModel }: callers use the exported name.
      const as = text.match(new RegExp(`export\\s*\\{[^}]*\\b${m[1]}\\s+as\\s+(\\w+)`))?.[1];
      add(name, "sequelize", file, lineOf(text, m.index), [m[1], as]);
    }
    // TypeORM: @Entity("orders") export class Order
    for (const re = /@Entity\(\s*(?:["'`](\w+)["'`]|\{[^}]*?name:\s*["'`](\w+)["'`][^}]*\})?[^)]*\)\s*(?:export\s+)?(?:default\s+)?class\s+(\w+)/g; (m = re.exec(text)); ) add(m[1] ?? m[2] ?? m[3], "typeorm", file, lineOf(text, m.index), [m[3]]);
  }
  return [...byName.values()].map((t) => ({ name: t.name, kind: t.kind, at: t.at, file: t.file, ids: [...t.ids], models: [...t.models], accessors: [...t.accessors] }));
}

// A model method, by what it does to the data. Deletes are checked first (findByIdAndDelete), then writes.
const M_DELETE = /^(?:delete\w*|destroy\w*|remove\w*|findOneAndDelete|findByIdAndDelete|findOneAndRemove|findByIdAndRemove|truncate)$/;
const M_WRITE = /^(?:create\w*|insert\w*|update\w*|upsert\w*|save|bulk\w*|increment|decrement|replace\w*|findOneAndUpdate|findByIdAndUpdate|findOneAndReplace|restore)$/;
const M_READ = /^(?:find\w*|count\w*|aggregate\w*|exists|distinct|groupBy|get\w*|all|first|where|query|estimatedDocumentCount|populate)$/;
const modelOp = (method) => (M_DELETE.test(method) ? "delete" : M_WRITE.test(method) ? "write" : M_READ.test(method) ? "read" : null);

/**
 * Classifies one line's table uses: [{ table, op }]. `aliases` maps extra local names
 * (a default import of a model file) to tables.
 */
function lineUses(line, idx, aliases) {
  const out = [];
  const seen = new Set();
  const put = (table, op) => {
    const k = `${table}\0${op}`;
    if (!seen.has(k)) seen.add(k), out.push({ table, op });
  };
  // Query builders on an id: db.insert(ordersTable), .from(ordersTable), innerJoin(ordersTable)
  for (const m of line.matchAll(idx.builder)) {
    const t = idx.byId.get(m[2]) ?? aliases.get(m[2]);
    if (t) put(t, m[1] === "delete" ? "delete" : m[1] === "insert" || m[1] === "update" ? "write" : "read");
  }
  // Drizzle relational queries: db.query.orders.findMany
  for (const m of line.matchAll(/\.query\.(\w+)\.\w+\(/g)) {
    const t = idx.byId.get(m[1]) ?? idx.byId.get(`${m[1]}Table`);
    if (t) put(t, "read");
  }
  // Models: Order.find(…), prisma.order.create(…), new User(…)
  for (const m of line.matchAll(/\bnew\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    const t = idx.byModel.get(m[1]) ?? aliases.get(m[1]);
    if (t) put(t, "write");
  }
  for (const m of line.matchAll(/(?<![\w$])([A-Za-z_$][\w$]*)\s*\.\s*(\w+)\s*\(/g)) {
    const t = idx.byModel.get(m[1]) ?? aliases.get(m[1]);
    const op = t && modelOp(m[2]);
    if (op) put(t, op);
  }
  for (const m of line.matchAll(/\.([a-z]\w*)\s*\.\s*(\w+)\s*\(/g)) {
    const t = idx.byAccessor.get(m[1]);
    const op = t && modelOp(m[2]);
    if (op) put(t, op);
  }
  // SQL and Knex: "SELECT … FROM orders", knex("orders").insert(…), supabase.from("orders").delete()
  if (idx.sql) {
    for (const m of line.matchAll(idx.sql)) {
      const t = idx.byName.get(m[2].toLowerCase());
      if (!t) continue;
      const kw = m[1].toUpperCase();
      put(t, kw.startsWith("DELETE") ? "delete" : kw.startsWith("INSERT") || kw.startsWith("UPDATE") ? "write" : "read");
    }
    for (const m of line.matchAll(idx.knex)) {
      const t = idx.byName.get(m[1].toLowerCase());
      if (!t) continue;
      const rest = line.slice(m.index + m[0].length);
      put(t, /^[\s\S]*?\.(?:del|delete|truncate)\s*\(/.test(rest) ? "delete" : /^[\s\S]*?\.(?:insert|update|upsert|increment|decrement)\s*\(/.test(rest) ? "write" : "read");
    }
  }
  return out;
}

function indexTables(tables) {
  const byId = new Map(), byModel = new Map(), byAccessor = new Map(), byName = new Map();
  for (const t of tables) {
    byName.set(t.name.toLowerCase(), t.name);
    for (const id of t.ids) byId.set(id, t.name);
    for (const id of t.models) byModel.set(id, t.name);
    for (const a of t.accessors) byAccessor.set(a, t.name);
  }
  const ids = [...byId.keys()].map(esc);
  const names = [...byName.keys()].map(esc);
  return {
    byId,
    byModel,
    byAccessor,
    byName,
    builder: ids.length ? new RegExp(`\\.(insert|update|delete|from|\\w*[jJ]oin|\\$count)\\(\\s*(${ids.join("|")})\\b`, "g") : /(?!)/g,
    sql: names.length ? new RegExp(`\\b(FROM|JOIN|INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+[\`"]?(?:\\w+\\.)?[\`"]?(${names.join("|")})\\b`, "gi") : null,
    // A table named as a call's first argument: knex("orders"), .from("orders"), new ItemsService("directus_users").
    knex: names.length ? new RegExp(`\\(\\s*["'\`](${names.join("|")})["'\`]`, "gi") : null,
  };
}

/** A file's local names for model files it imports by default: `import User from "../models/user"`. */
function modelAliases(g, file, tables) {
  const out = new Map();
  const text = g.text(file) ?? "";
  const byBase = new Map();
  for (const t of tables) if (t.models.length) byBase.set(path.basename(t.file).replace(/\.[^.]+$/, "").toLowerCase(), t.name);
  for (const m of text.matchAll(/(?:import\s+(\w+)\s+from|(?:const|let|var)\s+(\w+)\s*=\s*require\()\s*["'](\.[^"']+)["']/g)) {
    const t = byBase.get(path.basename(m[3]).replace(/\.[cm]?[jt]s$/, "").toLowerCase());
    if (t) out.set(m[1] ?? m[2], t);
  }
  return out;
}

/** Per route: [{ table, op, at }] for every table use along its call tree. */
export function routeData(g, routes, tables) {
  const out = new Map();
  if (!tables.length) return out;
  const idx = indexTables(tables);
  const lineCache = new Map();
  const aliasCache = new Map();
  for (const route of routes) {
    const uses = new Map();
    for (const r of reached(g, route)) {
      const lines = g.lines(r.file) ?? [];
      const aliases = aliasCache.get(r.file) ?? aliasCache.set(r.file, modelAliases(g, r.file, tables)).get(r.file);
      for (let n = r.start; n <= Math.min(r.end, lines.length); n++) {
        const key = `${r.file}:${n}`;
        let found = lineCache.get(key);
        if (!found) {
          const line = lines[n - 1];
          found = !line || COMMENT.test(line) ? [] : lineUses(line, idx, aliases);
          lineCache.set(key, found);
        }
        for (const u of found) {
          const k = `${u.table}\0${u.op}`;
          if (!uses.has(k)) uses.set(k, { ...u, at: key });
        }
      }
    }
    out.set(route.id, [...uses.values()]);
  }
  return out;
}

const RANK = { read: 0, write: 1, delete: 2 };
const sing = (w) => (w.length > 3 ? w.replace(/ies$/, "y").replace(/(?<!s)s$/, "") : w);
const tokens = (s) => String(s).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && w !== "table").map(sing);

/**
 * Which module owns each table: the one with the most routes that write it (then the most
 * that read it). Returns, per module id, { owns, uses } and the table list with owners.
 */
export function dataByModule(modules, uses, tables) {
  const def = new Map(tables.map((t) => [t.name, t]));
  const per = new Map(); // table -> module -> { read, write, delete } sets of route ids
  for (const m of modules)
    for (const id of m.routes)
      for (const u of uses.get(id) ?? []) {
        const mods = per.get(u.table) ?? per.set(u.table, new Map()).get(u.table);
        const s = mods.get(m.id) ?? mods.set(m.id, { read: new Set(), write: new Set(), delete: new Set() }).get(m.id);
        s[u.op].add(id);
      }
  // The owner: a module the table is named after, if it changes it (directus_comments → Comments);
  // otherwise the module with the most routes that write it. A table nearly every module
  // touches through shared code is shared: nobody's to own.
  const active = new Set([...per.values()].flatMap((mods) => [...mods.keys()])).size;
  const nameOf = new Map(modules.map((m) => [m.id, new Set(tokens(m.name ?? m.id))]));
  // A prefix most tables share (directus_, wp_) names the app, not the table.
  const firsts = tables.map((t) => tokens(t.name)[0]);
  const prefix = firsts.find((w) => w && firsts.filter((x) => x === w).length > 0.5 * tables.length && tables.length > 3);
  const tableWords = (t) => tokens(t).filter((w) => w !== prefix);
  const owner = new Map();
  for (const [table, mods] of per) {
    const writes = (s) => s.write.size + s.delete.size;
    const score = ([, s]) => writes(s) * 1000 + s.read.size;
    const named = [...mods].filter(([id]) => tableWords(table).some((w) => nameOf.get(id)?.has(w))).sort((a, b) => score(b) - score(a));
    const spread = mods.size >= 4 && mods.size > 0.4 * active;
    const pick = named.find(([, s]) => writes(s)) ?? (spread ? named[0] : [...mods].sort((a, b) => score(b) - score(a))[0]);
    owner.set(table, pick?.[0] ?? null);
  }
  const byModule = new Map(modules.map((m) => [m.id, { owns: [], uses: [] }]));
  for (const [table, mods] of per)
    for (const [mid, s] of mods) {
      const row = { table, at: def.get(table)?.at ?? null, reads: s.read.size, writes: s.write.size, deletes: s.delete.size };
      if (owner.get(table) === mid) {
        // Other modules that change this table: a change here can break them, and theirs can break this.
        row.alsoWrittenBy = [...mods].filter(([o, x]) => o !== mid && x.write.size + x.delete.size).map(([o]) => o);
        row.readBy = [...mods].filter(([o, x]) => o !== mid && !(x.write.size + x.delete.size)).map(([o]) => o);
        byModule.get(mid).owns.push(row);
      } else byModule.get(mid).uses.push({ ...row, owner: owner.get(table) });
    }
  const most = (r) => r.deletes * 3 + r.writes * 2 + r.reads;
  for (const d of byModule.values()) {
    d.owns.sort((a, b) => most(b) - most(a));
    d.uses.sort((a, b) => most(b) - most(a));
  }
  return { byModule, owner, shared: [...owner].filter(([, o]) => !o).map(([t]) => t), unused: tables.filter((t) => !per.has(t.name)).map((t) => t.name) };
}

export { RANK };
