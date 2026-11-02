"use strict";
(() => {
  const charts = document.querySelector("#traffic-charts");
  const refresh = document.querySelector("#refresh-traffic");
  const header = document.querySelector("#traffic-interval");
  async function load() {
    refresh.disabled = true;
    try {
      await window.FeatheralTraffic.load(charts, "/api/telemetry/public", undefined, header);
    } finally {
      refresh.disabled = false;
    }
  }
  refresh.addEventListener("click", load);
  void load();
})();
