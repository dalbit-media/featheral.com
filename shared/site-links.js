"use strict";

// Cross-site links for the Featheral hosts. Works on production (gold.featheral.com) and local
// development (gold.localhost:8080) by swapping only the first host label and keeping protocol/port.
(() => {
  const SITES = ["foundation", "gold", "silver", "app", "db", "dollar", "world", "ledger", "admin", "x", "ex", "notes", "sites", "stats", "wallet"];
  const publicSites = [["foundation", "Foundation"], ["gold", "Gold · FTHG"], ["dollar", "Dollar · FTH$"],
    ["silver", "Silver · FTHS"], ["app", "App"], ["world", "World"], ["ledger", "Ledger"], ["x", "X"], ["ex", "Exchange"], ["notes", "Notes"], ["sites", "Sites"], ["stats", "Stats"], ["wallet", "Wallet"], ["db", "Database"]];
  const { protocol, hostname, port } = window.location;
  const labels = hostname.split(".");
  const isIp = /^[\d.]+$/.test(hostname) || hostname.includes(":");
  const base = isIp ? "localhost" : [...SITES, "cms"].includes(labels[0]) && labels.length > 1 ? labels.slice(1).join(".") : hostname;
  const current = SITES.includes(labels[0]) && labels.length > 1 ? labels[0] : "foundation";

  function url(site, path = "/") {
    if (site === "cms") site = "admin";
    if (["foundation", "gold", "dollar", "world"].includes(site) && /^\/admin(?:\/|$|#)/.test(path)) {
      const tab = path.split("#")[1];
      path = `/#/operations/${site}${tab ? `?tab=${encodeURIComponent(tab)}` : ""}`;
      site = "admin";
    }
    const host = site === "foundation" ? base : `${site}.${base}`;
    return `${protocol}//${host}${port ? `:${port}` : ""}${path}`;
  }

  function apply(root = document) {
    const header = root.querySelector?.("body > header, #app > header, header.topbar");
    if (!root.querySelector?.(".eco-bar") && header && current !== "admin"
      && !window.location.pathname.startsWith("/operations/")) {
      const bar = document.createElement("nav");
      bar.className = "eco-bar";
      bar.setAttribute("aria-label", "Featheral sites");
      header.before(bar);
    }
    for (const bar of root.querySelectorAll(".eco-bar")) {
      for (const [site, label] of [...publicSites, ...(current === "admin" ? [["admin", "Admin"]] : [])]) {
        if (bar.querySelector(`a[data-site="${site}"]`)) continue;
        const link = document.createElement("a");
        link.dataset.site = site;
        link.textContent = label;
        bar.append(link);
      }
      if (header && window.getComputedStyle?.(header).position === "fixed" && !bar.dataset.fixedLayout) {
        bar.dataset.fixedLayout = "true";
        document.body.classList.add("eco-fixed-header");
        const resize = () => document.body.style.setProperty("--eco-height", `${bar.getBoundingClientRect().height}px`);
        resize();
        new ResizeObserver(resize).observe(bar);
      }
    }
    if (header && current !== "admin" && !window.location.pathname.startsWith("/operations/")
      && document.body.dataset.embedded !== "true"
      && !(current === "wallet" && new URL(window.location.href).searchParams.get("embedded") === "1")
      && !document.querySelector(".eco-footer")) {
      const footer = document.createElement("footer");
      footer.className = "eco-footer";
      footer.setAttribute("aria-label", "Featheral ecosystem");
      const nav = document.createElement("nav");
      nav.setAttribute("aria-label", "Featheral sites");
      const tree = document.createElement("ul"), foundation = document.createElement("li");
      const siteLink = site => {
        const link = document.createElement("a");
        link.dataset.site = site;
        link.textContent = publicSites.find(([key]) => key === site)[1];
        return link;
      };
      foundation.append(siteLink("foundation"));
      const groups = document.createElement("ul");
      for (const [label, sites] of [
        ["Currencies", ["gold", "silver", "dollar"]],
        ["Apps", ["app", "world", "x", "ex", "notes", "sites"]],
        ["Ledgers", ["ledger"]],
        ["Tools", ["wallet", "stats", "db"]],
      ]) {
        const group = document.createElement("li"), heading = document.createElement("span");
        heading.textContent = label;
        const children = document.createElement("ul");
        for (const site of sites) {
          const item = document.createElement("li");
          item.append(siteLink(site)); children.append(item);
        }
        group.append(heading, children); groups.append(group);
      }
      foundation.append(groups); tree.append(foundation); nav.append(tree); footer.append(nav);
      document.body.append(footer);
    }
    if (current !== "admin") {
      for (const link of root.querySelectorAll('nav a, .eco-bar a')) {
        const target = link.dataset.site ? new URL(url(link.dataset.site, link.dataset.path || "/"))
          : new URL(link.getAttribute("href") || "/", window.location.href);
        if (["admin", "cms"].includes(link.dataset.site) || target.hostname.startsWith("admin.") || /^\/admin(?:\/|$)/.test(target.pathname))
          link.remove();
      }
    }
    for (const link of root.querySelectorAll("a[data-site]")) {
      link.href = url(link.dataset.site, link.dataset.path || "/");
      if (link.dataset.site === current && (link.dataset.path || "/") === "/") link.setAttribute("aria-current", "page");
    }
  }

  window.FeatheralSites = { url, apply, current, SITES };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => apply());
  else apply();
  if (current !== "wallet" && current !== "admin" && !document.querySelector('script[data-central-wallet-loader]')) {
    const script = document.createElement("script"); script.dataset.centralWalletLoader = "true";
    script.src = url("wallet", "/embed.js");
    script.onerror = () => {
      console.error("Central Featheral wallet could not be loaded.");
      const header = document.querySelector("body > header, #app > header, header.topbar");
      if (!header) return;
      const retry = document.createElement("button");
      retry.type = "button"; retry.textContent = "Retry wallet";
      retry.title = "Wallet app unavailable. Retry loading it in this site.";
      retry.addEventListener("click", () => {
        const loader = document.createElement("script"); loader.src = script.src;
        loader.onload = () => retry.remove(); loader.onerror = () => { retry.textContent = "Wallet unavailable · retry"; };
        document.head.append(loader);
      });
      header.append(retry);
    };
    document.head.append(script);
  }
})();
