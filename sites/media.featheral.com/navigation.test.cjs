const { strict: assert } = require("node:assert");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const { worldResource } = require("../../scripts/site-routing");

test("Media owns social navigation while World owns gameplay", () => {
  const html = readFileSync(join(__dirname, "index.html"), "utf8");
  const rail = html.match(/<aside class="rail"[\s\S]*?<\/aside>/)[0];
  assert.deepEqual([...rail.matchAll(/<a href="([^"]+)"/g)].map(match => match[1]),
    ["#/setup", "#/feed", "#/explore", "#/me", "#/guide"]);
  assert.match(rail, /id="railPost"/);
  assert.match(html, /id="profileEditor"/);
  assert.doesNotMatch(html, /src="\/play-launch.js"/);
  assert.match(html, /data-site="world" data-path="\/explore\/"[^>]*target="_blank" rel="noopener"/);
  assert.match(readFileSync(join(__dirname, "app.js"), "utf8"), /\/api\/v1\/media/);
});

test("retired placeholder pages redirect to real content without duplicate files", () => {
  for (const [pathname, destination] of [["/docs/", "/#/guide"], ["/news/", "/#/feed"], ["/about/", "/"]])
    assert.deepEqual(worldResource("media", pathname), { redirect: "media", pathname: destination });
  assert.deepEqual(worldResource("world", "/ledger/"), { redirect: "media", pathname: "/ledger/" });
  assert.deepEqual(worldResource("world", "/play/settlement/"), { redirect: "world", pathname: "/settlement/" });
  assert.deepEqual(worldResource("world", "/play/"), { redirect: "world", pathname: "/explore/" });
});

test("Media keeps the centered responsive social layout", () => {
  const css = readFileSync(join(__dirname, "app.css"), "utf8");
  assert.match(css, /\.app\{width:100%;max-width:1280px;margin-inline:auto;/);
  assert.match(css, /\.column\{[^}]*min-width:0;width:100%;margin:0;padding:0;max-width:none/);
  assert.match(css, /grid-template-columns:minmax\(72px,260px\) minmax\(0,600px\) minmax\(0,350px\)/);
  assert.match(css, /@media \(max-width:640px\)[^{]*\{[^]*?\.app\{grid-template-columns:minmax\(0,1fr\)\}/);
});
