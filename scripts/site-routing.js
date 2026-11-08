"use strict";
const path = require("node:path");
const fs = require("node:fs");

function worldResource(site, pathname) {
  if (site === "world") {
    const publicSections = {
      "/features/exploration": "exploration", "/features/settlements": "settlements",
      "/features/marketplace": "marketplace", "/features/federations": "federations",
      "/guide": "guide", "/roadmap": "roadmap",
    };
    const section = publicSections[pathname.replace(/\/index\.html$/, "").replace(/\/$/, "")];
    if (section) return { redirect: "world", pathname: `/#${section}` };
    if (pathname === "/community") return { redirect: "world", pathname: "/community/" };
    if (["/community/", "/community/index.html"].includes(pathname))
      return { directory: "media.featheral.com", pathname: "/index.html" };
    if (["/community/app.js", "/community/app.css"].includes(pathname))
      return { directory: "media.featheral.com", pathname: pathname.slice("/community".length) };
    if (["/account/account.js", "/account/account.css", "/account/home-account.css"].includes(pathname))
      return { directory: "world.featheral.com", pathname };
    if (pathname === "/account") return { redirect: "world", pathname: "/account/" };
    if (["/login", "/register"].includes(pathname)) return { redirect: "world", pathname: pathname + "/" };
    if (pathname === "/play" || pathname === "/play/" || pathname === "/play/index.html")
      return { redirect: "world", pathname: "/explore/" };
    if (pathname.startsWith("/play/")) {
      const target = pathname.slice("/play".length);
      return { redirect: "world", pathname: target.startsWith("/about") ? "/" : target };
    }
    if (["/about", "/about/", "/about/index.html"].includes(pathname))
      return { redirect: "world", pathname: "/" };
    if (["/docs", "/ledger", "/news"].some(prefix => pathname === prefix || pathname.startsWith(prefix + "/"))
      || ["/app.js", "/app.css", "/play-launch.js"].includes(pathname))
      return { redirect: "media", pathname };
    if (["/wallet-sync.html", "/wallet-sync.js", "/wallet-sync-frame.html", "/wallet-sync-frame.js", "/world-funds.html", "/world-funds.js", "/world-funds.css"].includes(pathname))
      return { directory: "world.featheral.com", pathname };
    return { directory: path.join("world.featheral.com", "play", "dist"), pathname };
  }
  if (site === "media") {
    if (pathname === "/docs" || pathname.startsWith("/docs/")) return { redirect: "media", pathname: "/#/guide" };
    if (pathname === "/news" || pathname.startsWith("/news/")) return { redirect: "media", pathname: "/#/feed" };
    if (pathname === "/play" || pathname.startsWith("/play/"))
      return { redirect: "world", pathname: pathname === "/play" || pathname === "/play/" ? "/explore/" : pathname.slice("/play".length) };
    if (pathname === "/about" || pathname.startsWith("/about/")) return { redirect: "media", pathname: "/" };
    return { directory: "media.featheral.com", pathname };
  }
  return null;
}

function mediaNavigationHtml(html) {
  const nav = fs.readFileSync(path.join(__dirname, "..", "shared", "world-navigation.html"), "utf8")
    .replace(/href="([^"]+)"/g, (_, target) => `href="https://world.featheral.com${target}" data-site="world" data-path="${target}"`)
    .replace('data-path="/#community"', 'data-path="/#community" aria-current="page"');
  return html.replace('<!-- WORLD_PUBLIC_NAV -->', nav);
}
function worldCommunityHtml(html) {
  return mediaNavigationHtml(html).replace('href="/app.css"', 'href="/community/app.css"')
    .replace('src="/app.js"', 'src="/community/app.js"')
    .replace('<title>Community feed · Featheral Media</title>', '<title>Community · Featheral World</title>')
    .replace('content="Public wallet-signed posts, conversations and profiles on Featheral Media."',
      'content="Meet World builders, share wallet-signed posts and discuss settlements, exploration and federations with your shared World profile."')
    .replace('href="https://media.featheral.com/"', 'href="https://world.featheral.com/community/"')
    .replace('content="Featheral Media"', 'content="Community · Featheral World"')
    .replaceAll('/shared/logo-media.svg', '/shared/logo-world.svg')
    .replace('<b>Featheral Media</b>', '<b>Featheral World</b>')
    .replace('aria-label="Media site"', 'aria-label="World site"');
}

module.exports = { worldResource, worldCommunityHtml, mediaNavigationHtml };
