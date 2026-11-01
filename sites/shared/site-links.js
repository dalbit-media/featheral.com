"use strict";

// Cross-site links for the four Featheral hosts. Works on production (gold.featheral.com) and local
// development (gold.localhost:8080) by swapping only the first host label and keeping protocol/port.
(() => {
  const SITES = ["foundation", "gold", "dollar", "world"];
  const { protocol, hostname, port } = window.location;
  const labels = hostname.split(".");
  const isIp = /^[\d.]+$/.test(hostname) || hostname.includes(":");
  const base = isIp ? "localhost" : SITES.includes(labels[0]) && labels.length > 1 ? labels.slice(1).join(".") : hostname;
  const current = SITES.includes(labels[0]) && labels.length > 1 ? labels[0] : "foundation";

  function url(site, path = "/") {
    const host = site === "foundation" ? base : `${site}.${base}`;
    return `${protocol}//${host}${port ? `:${port}` : ""}${path}`;
  }

  function apply(root = document) {
    for (const link of root.querySelectorAll("a[data-site]")) {
      link.href = url(link.dataset.site, link.dataset.path || "/");
      if (link.dataset.site === current && (link.dataset.path || "/") === "/") link.setAttribute("aria-current", "page");
    }
  }

  window.FeatheralSites = { url, apply, current, SITES };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => apply());
  else apply();
})();
