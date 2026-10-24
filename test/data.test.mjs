// The data section: each table's columns, keys, defaults, foreign keys and enum values,
// read from the schema, cited with a hash so a schema change marks it out of date.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findTables, tableShape, dataMarkdown, dataDrift } from "../core/data.mjs";

const repoOf = (files) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "veridic-data-"));
  for (const [f, t] of Object.entries(files)) fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }), fs.writeFileSync(path.join(repo, f), t);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["add", "."], { cwd: repo });
  return { repo, w: (f, t) => fs.writeFileSync(path.join(repo, f), t), done: () => fs.rmSync(repo, { recursive: true, force: true }) };
};
const shapeOf = (repo, name) => tableShape(repo, findTables(repo).find((t) => t.name === name));

const PRISMA = [
  "enum Role {",
  "  USER",
  "  ADMIN",
  "}",
  "",
  "model User {",
  "  id        Int      @id @default(autoincrement())",
  "  email     String   @unique",
  "  name      String?",
  "  role      Role     @default(USER)",
  "  posts     Post[]",
  "}",
  "",
  "model Post {",
  "  id       Int     @id @default(autoincrement())",
  "  title    String",
  "  authorId Int",
  "  author   User    @relation(fields: [authorId], references: [id])",
  "  @@unique([authorId, title])",
  '  @@map("posts")',
  "}",
].join("\n");

test("data: a Prisma model's columns, keys, defaults, enum values and relations", () => {
  const r = repoOf({ "prisma/schema.prisma": PRISMA });
  const user = shapeOf(r.repo, "User"), post = shapeOf(r.repo, "posts");
  r.done();
  assert.deepEqual(user.columns, [
    { name: "id", type: "Int", nullable: false, default: "autoincrement()" },
    { name: "email", type: "String", nullable: false },
    { name: "name", type: "String", nullable: true },
    { name: "role", type: "Role", nullable: false, default: "USER", enum: ["USER", "ADMIN"] },
  ]);
  assert.deepEqual(user.primaryKey, ["id"]);
  assert.deepEqual(user.unique, [["email"]]);
  assert.match(user.at, /^prisma\/schema\.prisma:6-12$/);
  assert.match(user.hash, /^[0-9a-f]{8}$/);
  assert.deepEqual(post.foreignKeys, [{ columns: ["authorId"], table: "User", references: ["id"] }]);
  assert.deepEqual(post.unique, [["authorId", "title"]]);
});

test("data: a Drizzle table's columns, keys, defaults, references and enums", () => {
  const r = repoOf({
    "src/db/schema.ts": [
      'import { pgTable, pgEnum, serial, text, integer, timestamp } from "drizzle-orm/pg-core";',
      'export const statusEnum = pgEnum("status", ["draft", "paid"]);',
      'export const usersTable = pgTable("users", {',
      '  id: serial("id").primaryKey(),',
      '  email: text("email").notNull().unique(),',
      "});",
      'export const ordersTable = pgTable("orders", {',
      '  id: serial("id").primaryKey(),',
      '  userId: integer("user_id").notNull().references(() => usersTable.id),',
      '  status: statusEnum("status").notNull().default("draft"),',
      '  note: text("note", { enum: ["gift", "rush"] }),',
      '  createdAt: timestamp("created_at").defaultNow(),',
      "});",
    ].join("\n"),
  });
  const o = shapeOf(r.repo, "orders");
  r.done();
  assert.deepEqual(o.columns, [
    { name: "id", type: "serial", nullable: true },
    { name: "user_id", type: "integer", nullable: false },
    { name: "status", type: "status", nullable: false, default: '"draft"', enum: ["draft", "paid"] },
    { name: "note", type: "text", nullable: true, enum: ["gift", "rush"] },
    { name: "created_at", type: "timestamp", nullable: true, default: "now()" },
  ]);
  assert.deepEqual(o.primaryKey, ["id"]);
  assert.deepEqual(o.foreignKeys, [{ columns: ["user_id"], table: "users", references: ["id"] }]);
  assert.match(o.at, /^src\/db\/schema\.ts:7-13$/);
});

test("data: a SQL CREATE TABLE's columns and constraints", () => {
  const r = repoOf({
    "db/001.sql": "CREATE TABLE orders (\n  id SERIAL PRIMARY KEY,\n  user_id INTEGER NOT NULL REFERENCES users(id),\n  total NUMERIC(10,2) NOT NULL DEFAULT 0,\n  code TEXT UNIQUE,\n  UNIQUE (user_id, code)\n);\n",
  });
  const o = shapeOf(r.repo, "orders");
  r.done();
  assert.deepEqual(o.columns, [
    { name: "id", type: "SERIAL", nullable: true },
    { name: "user_id", type: "INTEGER", nullable: false },
    { name: "total", type: "NUMERIC(10,2)", nullable: false, default: "0" },
    { name: "code", type: "TEXT", nullable: true },
  ]);
  assert.deepEqual(o.primaryKey, ["id"]);
  assert.deepEqual(o.unique, [["code"], ["user_id", "code"]]);
  assert.deepEqual(o.foreignKeys, [{ columns: ["user_id"], table: "users", references: ["id"] }]);
});

test("data: the schema wins over a migration for the same table, and their disagreement is reported", () => {
  const r = repoOf({ "prisma/schema.prisma": 'model Order {\n  id Int @id\n  total Int\n  @@map("orders")\n}\n', "migrations/001.sql": "CREATE TABLE orders (\n  id INTEGER PRIMARY KEY,\n  amount INTEGER\n);\n" });
  const o = shapeOf(r.repo, "orders");
  r.done();
  assert.equal(o.kind, "prisma");
  assert.deepEqual(o.disagreement, { at: "migrations/001.sql:1", onlyInSchema: ["total"], onlyInMigration: ["amount"] });
});

test("data: the section, and a schema change found by check", () => {
  const r = repoOf({ "prisma/schema.prisma": PRISMA });
  const md = dataMarkdown([shapeOf(r.repo, "User")]);
  assert.match(md, /^## Data \(generated\)/);
  assert.match(md, /### User \[evidence: prisma\/schema\.prisma:6-12~[0-9a-f]{8}\]/);
  assert.match(md, /\| role \| Role \(USER, ADMIN\) \| no \| USER \| \|/);
  assert.deepEqual(dataDrift(md, r.repo), []);
  r.w("prisma/schema.prisma", PRISMA.replace("  name      String?\n", "  name      String?\n  phone     String?\n"));
  const drift = dataDrift(md, r.repo);
  r.done();
  assert.deepEqual(drift, [{ table: "User", problem: "columns changed: added phone" }]);
});

test("data: render writes the section, and check reports a schema change", async () => {
  const { renderMarkdown } = await import("../core/specdata.mjs");
  const { spawnSync } = await import("node:child_process");
  const r = repoOf({ "prisma/schema.prisma": PRISMA });
  const spec = { feature: "Users", seeds: ["POST /users"], requirements: [{ id: "FR-001", rule: "MUST x", evidence: ["prisma/schema.prisma:7"] }] };
  const md = renderMarkdown(spec, { data: dataMarkdown([shapeOf(r.repo, "User")]) });
  assert.match(md, /## Data \(generated\)[\s\S]*### User/);
  fs.writeFileSync(path.join(r.repo, "spec.md"), md);
  r.w("prisma/schema.prisma", PRISMA.replace("  name      String?\n", ""));
  const out = spawnSync(process.execPath, [path.resolve("skill/scripts/cite.mjs"), "--repo", r.repo, "--spec", path.join(r.repo, "spec.md")], { encoding: "utf8" });
  r.done();
  assert.deepEqual(JSON.parse(out.stdout).data_drift, [{ table: "User", problem: "columns changed: removed name" }]);
  assert.equal(out.status, 1);
});

test("data: comments with apostrophes don't hide a Drizzle table's columns", () => {
  const r = repoOf({
    "src/schema.ts": 'export const appsTable = pgTable(\n  "apps",\n  {\n    // the app\'s own id; it\'s never reused\n    id: uuid("id").primaryKey().defaultRandom(),\n    /* a name that isn\'t unique */\n    name: text("name").notNull(),\n  },\n);\n',
  });
  const s = shapeOf(r.repo, "apps");
  r.done();
  assert.deepEqual(s.columns.map((c) => c.name), ["id", "name"]);
});

test("data: the generated sections carry the tables the spec's routes use", async (t) => {
  const { generatedSections } = await import("../core/specdata.mjs");
  const { ensureIndex, findCodegraph } = await import("../core/indexer.mjs");
  if (!findCodegraph()) return t.skip("no CodeGraph");
  const r = repoOf({
    "prisma/schema.prisma": PRISMA,
    "package.json": '{ "name": "x", "dependencies": { "express": "4" } }\n',
    "src/app.js": 'const express = require("express");\nconst prisma = require("./prisma");\nconst app = express();\napp.get("/users", async (req, res) => {\n  res.json(await prisma.user.findMany());\n});\napp.listen(3000);\n',
  });
  ensureIndex(r.repo, { build: true, log: () => {} });
  const g = generatedSections(r.repo, ["GET /users"]);
  r.done();
  assert.match(g.data, /## Data \(generated\)[\s\S]*### User/);
});

test("data: Prisma's implicit many-to-many links (both sides lists), named and self ones too", () => {
  const schema = [
    "model Article {", "  id Int @id", "  tagList Tag[]", "  author User @relation(\"UserArticles\", fields: [authorId], references: [id])", "  authorId Int",
    "  favoritedBy User[] @relation(\"UserFavorites\")", "  comments Comment[]", "}", "",
    "model Comment {", "  id Int @id", "  article Article @relation(fields: [articleId], references: [id])", "  articleId Int", "}", "",
    "model Tag {", "  id Int @id", "  articles Article[]", "}", "",
    "model User {", "  id Int @id", "  articles Article[] @relation(\"UserArticles\")", "  favorites Article[] @relation(\"UserFavorites\")",
    "  followedBy User[] @relation(\"UserFollows\")", "  following User[] @relation(\"UserFollows\")", "}", "",
  ].join("\n");
  const r = repoOf({ "prisma/schema.prisma": schema });
  const [a, u] = [shapeOf(r.repo, "Article"), shapeOf(r.repo, "User")];
  r.done();
  assert.deepEqual(a.manyToMany, [{ field: "tagList", table: "Tag" }, { field: "favoritedBy", table: "User", via: "UserFavorites" }], "comments is one-to-many: Comment holds the key");
  assert.deepEqual(u.manyToMany, [{ field: "favorites", table: "Article", via: "UserFavorites" }, { field: "followedBy", table: "User", via: "UserFollows" }, { field: "following", table: "User", via: "UserFollows" }]);
  assert.match(dataMarkdown([a]), /Many-to-many: tagList ↔ Tag; favoritedBy ↔ User \(UserFavorites\)\./);
});
