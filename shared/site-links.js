"use strict";

// Cross-site links for the Featheral hosts. Works on production (gold.featheral.com) and local
// development (gold.localhost:8080) by swapping only the first host label and keeping protocol/port.
(() => {
  const SITES = ["foundation", "gold", "silver", "app", "db", "dollar", "world", "media", "ledger", "admin", "x", "ex", "notes", "sites", "stats", "wallet", "pay"];
  const publicSites = [["foundation", "Foundation"], ["gold", "Gold · FTHG"], ["dollar", "Dollar · FTH$"],
    ["silver", "Silver · FTHS"], ["app", "App"], ["world", "World"], ["media", "Media"], ["ledger", "Ledger"], ["ex", "Exchange"], ["notes", "Notes"], ["sites", "Sites"], ["stats", "Stats"], ["wallet", "Wallet"], ["pay", "Pay"], ["db", "Database"], ["admin", "Admin"]];
  const currencies = { foundation: "FTHG", gold: "FTHG", silver: "FTHS", dollar: "FTH$", world: "FTH$", pay: "FTH$",
    app: "FTHX", media: "FTHX", x: "FTHX", ex: "FTHX", notes: "FTHX", sites: "FTHX", wallet: "FTHX" };
  const familySites = ["foundation", "gold", "dollar", "silver", "stats", "world", "media"];
  // Stats keeps the family layout but is linked from the footer Tools group, not the top bar.
  const barSites = familySites.filter(site => site !== "stats");
  const { protocol, hostname, port } = window.location;
  const labels = hostname.split(".");
  const isIp = /^[\d.]+$/.test(hostname) || hostname.includes(":");
  const base = isIp ? "localhost" : [...SITES, "cms"].includes(labels[0]) && labels.length > 1 ? labels.slice(1).join(".") : hostname;
  const current = SITES.includes(labels[0]) && labels.length > 1 ? labels[0] : "foundation";

  function url(site, path = "/") {
    if (site === "cms") site = "admin";
    if (["foundation", "gold", "dollar", "world", "media"].includes(site) && /^\/admin(?:\/|$|#)/.test(path)) {
      const tab = path.split("#")[1];
      path = `/#/operations/${site === "media" ? "world" : site}${tab ? `?tab=${encodeURIComponent(tab)}` : ""}`;
      site = "admin";
    }
    const host = site === "foundation" ? base : `${site}.${base}`;
    return `${protocol}//${host}${port ? `:${port}` : ""}${path}`;
  }

  function apply(root = document) {
    const standalone = current === "x";
    if (standalone) document.body.dataset.standalone = "x";
    const embedded = document.body.dataset.embedded === "true"
      || current === "wallet" && new URL(window.location.href).searchParams.get("embedded") === "1";
    const main = root.querySelector?.("main");
    if (main && current !== "admin" && !embedded && !document.querySelector(".skip-link, .eco-skip-link")) {
      if (!main.id) main.id = "eco-main";
      if (!main.hasAttribute("tabindex")) main.tabIndex = -1;
      const skip = document.createElement("a");
      skip.className = "eco-skip-link"; skip.href = `#${main.id}`; skip.textContent = "Skip to content";
      skip.addEventListener("click", event => {
        event.preventDefault();
        main.focus({ preventScroll: true });
        main.scrollIntoView({ block: "start" });
      });
      document.body.prepend(skip);
    }
    const header = root.querySelector?.("body > header, #app > header, header.topbar, #app header.topbar");
    if (!standalone) for (const link of root.querySelectorAll('a[href], a[data-site]')) {
      const target = new URL(link.getAttribute("href") || "/", window.location.href);
      if (link.dataset.site === "x" || [new URL(url("x")).hostname, "x.featheral.com"].includes(target.hostname))
        link.remove();
    }
    // World game pages are full-viewport apps with their own rail, so they skip the family chrome.
    const game = current === "world" && !!document.querySelector("#app");
    if (game || standalone) {
      delete document.body.dataset.familyLayout;
      for (const chrome of document.querySelectorAll(".eco-bar, .eco-footer")) chrome.remove();
    }
    if (familySites.includes(current) && !game) document.body.dataset.familyLayout = "true";
    if (!document.querySelector('link[data-site-navigation], link[href="/shared/site-links.css"]')) {
      const style = document.createElement("link"); style.rel = "stylesheet"; style.href = "/shared/site-links.css";
      style.dataset.siteNavigation = "true"; document.head.append(style);
    }
    if (!game && !standalone && !root.querySelector?.(".eco-bar") && header && current !== "admin"
      && !window.location.pathname.startsWith("/operations/")) {
      const bar = document.createElement("nav");
      bar.className = "eco-bar";
      bar.setAttribute("aria-label", "Featheral sites");
      header.before(bar);
    }
    for (const bar of root.querySelectorAll(".eco-bar")) {
      const family = current === "stats" ? familySites : barSites;
      const related = familySites.includes(current)
        ? family.map(site => publicSites.find(([key]) => key === site))
        : publicSites.filter(([site]) => barSites.includes(site)
          || site === current || currencies[current] && currencies[site] === currencies[current]);
      bar.setAttribute("aria-label", "Featheral family sites");
      const links = related.map(([site, label]) => {
        const link = document.createElement("a");
        link.dataset.site = site;
        link.textContent = label;
        return link;
      });
      const existing = [...bar.querySelectorAll("a")];
      if (existing.length !== related.length || existing.some((link, index) =>
        link.dataset.site !== related[index][0] || link.textContent !== related[index][1]))
        bar.replaceChildren(...links);
      if (header && window.getComputedStyle?.(header).position === "fixed" && !bar.dataset.fixedLayout) {
        bar.dataset.fixedLayout = "true";
        document.body.classList.add("eco-fixed-header");
        const resize = () => document.body.style.setProperty("--eco-height", `${bar.getBoundingClientRect().height}px`);
        resize();
        new ResizeObserver(resize).observe(bar);
      }
    }
    for (const title of root.querySelectorAll("header .brand, header a.logo, a.game-brand, a.site-brand")) {
      if (title.tagName === "A") { title.dataset.site = current; title.removeAttribute("data-path"); title.href = url(current); }
    }
    if (!game && !standalone && current !== "admin" && !window.location.pathname.startsWith("/operations/")
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
        ["World & community", ["world", "media"]],
        ["Apps", ["app", "ex", "notes", "sites", "pay"]],
        ["Ledgers", ["ledger"]],
        ["Tools", ["wallet", "stats", "db", "admin"]],
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
    {
      for (const link of root.querySelectorAll('header nav a')) {
        const target = link.dataset.site ? new URL(url(link.dataset.site, link.dataset.path || "/"))
          : new URL(link.getAttribute("href") || "/", window.location.href);
        const site = link.dataset.site || publicSites.find(([key]) => target.origin === new URL(url(key)).origin)?.[0];
        if (site && site !== current && (!currencies[current] || currencies[site] !== currencies[current])
          || current !== "admin" && (target.hostname.startsWith("admin.") || /^\/admin(?:\/|$)/.test(target.pathname)))
          link.remove();
      }
    }
    for (const link of root.querySelectorAll("a[data-site]")) {
      link.href = url(link.dataset.site, link.dataset.path || "/");
      if (link.dataset.site === current && (link.dataset.path || "/") === "/") link.setAttribute("aria-current", "page");
    }
    for (const bar of root.querySelectorAll(".eco-bar")) bar.dataset.familyReady = "true";
  }

  if (current === "world" && /^#\/(?:feed|following|post|user|me|setup|search|guide|explore)(?:\/|$)/.test(window.location.hash)) {
    window.location.replace(url("media") + window.location.search + window.location.hash);
    return;
  }
  window.FeatheralSites = { url, apply, current, SITES, currencies };
  // The Explore map needs a large, chrome-free viewport, so it opens in its own sized window.
  const EXPLORE_WINDOW = "featheral-explore";
  function openExplore(href) {
    const screenWidth = window.screen?.availWidth || 1440, screenHeight = window.screen?.availHeight || 900;
    const width = Math.max(960, Math.min(1600, screenWidth - 40)), height = Math.max(640, Math.min(1000, screenHeight - 60));
    const left = Math.max(0, Math.round((window.screen?.availLeft || 0) + (screenWidth - width) / 2));
    const top = Math.max(0, Math.round((window.screen?.availTop || 0) + (screenHeight - height) / 2));
    const popup = window.open(href, EXPLORE_WINDOW, `popup=yes,width=${width},height=${height},left=${left},top=${top}`);
    if (!popup) return false;
    popup.focus();
    return true;
  }
  document.addEventListener("click", (event) => {
    if (window.name === EXPLORE_WINDOW || event.defaultPrevented || event.button !== 0
      || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!link || link.hasAttribute("download")) return;
    const target = new URL(link.href, window.location.href);
    const world = new URL(url("world"));
    if (target.host !== world.host || !/^\/(?:explore|play)(?:\/(?:index\.html)?)?$/.test(target.pathname)) return;
    if (openExplore(target.href)) event.preventDefault();
  });
  window.FeatheralSites.openExplore = openExplore;
  document.addEventListener("featheral:site-ready", () => apply());
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => apply());
  else apply();
  if (current !== "wallet" && current !== "admin" && current !== "x" && !document.querySelector('script[data-central-wallet-loader]')) {
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
