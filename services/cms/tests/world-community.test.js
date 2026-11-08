"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { worldResource, worldCommunityHtml, mediaNavigationHtml } = require("../../../scripts/site-routing");
test("World community reuses the Media feed and assets without duplicating content or storage", () => {
  assert.deepEqual(worldResource("world", "/community/"), { directory: "media.featheral.com", pathname: "/index.html" });
  assert.deepEqual(worldResource("world", "/community/app.js"), { directory: "media.featheral.com", pathname: "/app.js" });
  assert.deepEqual(worldResource("world", "/community/app.css"), { directory: "media.featheral.com", pathname: "/app.css" });
  const html = worldCommunityHtml(fs.readFileSync(path.join(__dirname, "../../../sites/media.featheral.com/index.html"), "utf8"));
  assert.match(html, /src="\/community\/app.js"/);
  assert.match(html, /href="\/community\/app.css"/);
  assert.match(html, /<title>Community · Featheral World<\/title>/);
  assert.match(html, /rel="canonical" href="https:\/\/world.featheral.com\/community\/"/);
  assert.match(html, /src="\/shared\/world-account.js"/);
  assert.match(html, /id="composerHost"/);
  assert.doesNotMatch(html, /WORLD_PUBLIC_NAV/);
  assert.equal((html.match(/class="world-submenu"/g) || []).length, 3);
  assert.match(html, /data-site="world" data-path="\/login\/"/);
  assert.match(html, /data-site="world" data-path="\/register\/"/);
  assert.match(mediaNavigationHtml('<!-- WORLD_PUBLIC_NAV -->'), /href="https:\/\/world.featheral.com\/features\/exploration\/"/);
});
test("World feed hashes stay within Community, and ordinary Play links no longer open a different window", () => {
  const links = fs.readFileSync(path.join(__dirname, "../../../shared/site-links.js"), "utf8");
  assert.match(links, /!window\.location\.pathname\.startsWith\("\/community\/"\)/);
  assert.match(links, /url\("world", "\/community\/"\)/);
  assert.match(links, /!link\.hasAttribute\("data-game-window"\)/);
});
