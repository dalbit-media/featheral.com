"use strict";
const path = require("node:path");

function worldResource(site, pathname) {
  if (site === "world") {
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

module.exports = { worldResource };
