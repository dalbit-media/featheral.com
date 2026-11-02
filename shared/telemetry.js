"use strict";
(() => {
  if (navigator.doNotTrack === "1" || navigator.globalPrivacyControl || location.pathname.startsWith("/operations/")) return;
  let last = "";
  function hit() {
    const route = location.pathname + location.search + location.hash;
    if (route === last) return;
    last = route;
    const base = document.querySelector('meta[name="site-base"]')?.content || "";
    fetch(base + "/api/telemetry/hit", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: "{}" })
      .then(response => { if (!response.ok) throw new Error(`HTTP ${response.status}`); })
      .catch(error => console.warn("Traffic telemetry unavailable:", error.message));
  }
  hit();
  addEventListener("hashchange", hit);
  addEventListener("popstate", hit);
  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    history[method] = function (...args) { const result = original.apply(this, args); hit(); return result; };
  }
})();
