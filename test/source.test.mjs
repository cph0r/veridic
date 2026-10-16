import { test } from "node:test";
import assert from "node:assert/strict";
import { matchParen, callExtent, literalSpans, codeOnly, offsetOfLine, lineAt } from "../core/graph.mjs";
import { parseYaml } from "../core/yaml.mjs";
import { joinPath, normRoute, parseRouteId } from "../core/routes.mjs";

test("matchParen skips parens inside strings, templates and comments", () => {
  const src = 'f(a, ")", `(${g(1)})`, /* ) */ b) // )\nnext()';
  assert.equal(matchParen(src, 1), src.indexOf(" // )") - 1);
});

test("callExtent spans a multi-line router call", () => {
  const src = ["x();", "router.post(", '  "/a",', "  async (req, res) => {", '    res.status(201).json({ ok: ")" });', "  },", ");", "after();"].join("\n");
  assert.deepEqual(callExtent(src, 2), [2, 7]);
});

test("literalSpans returns string literals with offsets, not comments or interpolated templates", () => {
  const src = 'const a = "x_y"; // "nope"\nconst b = `t_u`; const c = `v_${a}`;';
  assert.deepEqual(literalSpans(src).map((l) => l.value), ["x_y", "t_u"]);
  const [first] = literalSpans(src);
  assert.equal(src.slice(first.start, first.end + 1), '"x_y"');
});

test("codeOnly blanks comments and strings but keeps offsets and newlines", () => {
  const src = 'a("b"); // c\n/* d */ e';
  const out = codeOnly(src);
  assert.equal(out.length, src.length);
  assert.equal(out.replace(/ +/g, " "), 'a( ); \n e');
});

test("offsetOfLine and lineAt round-trip, and clamp past the end", () => {
  const src = "a\nbb\nccc";
  assert.equal(offsetOfLine(src, 3), 5);
  assert.equal(lineAt(src, 5), 3);
  assert.equal(offsetOfLine(src, 10), src.length);
});

test("parseYaml reads the OpenAPI subset: maps, sequences, flow collections, block scalars", () => {
  const doc = parseYaml(`
openapi: 3.1.0 # comment
servers:
  - url: /api
    description: "Base: path"
paths:
  /orders/{id}:
    get:
      tags: [orders, "public"]
      description: |
        Line one
        line two
      responses:
        "200":
          description: ok
        '404':
          description: missing
components:
  schemas:
    Status:
      enum:
        [
          awaiting_payment,
          pending,
        ]
      nullable: true
      count: 3
`);
  assert.equal(doc.openapi, "3.1.0");
  assert.deepEqual(doc.servers, [{ url: "/api", description: "Base: path" }]);
  const op = doc.paths["/orders/{id}"].get;
  assert.deepEqual(op.tags, ["orders", "public"]);
  assert.equal(op.description, "Line one\nline two");
  assert.deepEqual(Object.keys(op.responses), ["200", "404"]);
  assert.deepEqual(doc.components.schemas.Status, { enum: ["awaiting_payment", "pending"], nullable: true, count: 3 });
});

test("route helpers", () => {
  assert.equal(joinPath("/api/", "/orders/"), "/api/orders");
  assert.equal(joinPath("", "/"), "/");
  assert.equal(normRoute("GET /api/orders/:id/items/{itemId}"), "GET /api/orders/{}/items/{}");
  assert.deepEqual(parseRouteId("post /api/x"), { method: "POST", path: "/api/x" });
  assert.equal(parseRouteId("src/app.ts"), null);
});
