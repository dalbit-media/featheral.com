"use strict";
(() => {
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

  function renderServerProfileChart(history) {
    const series = [
      { label: "Process CPU · %/core", value: point => point.processCpuPct, unit: "%" },
      { label: "Process memory · MB", value: point => point.rssBytes / 1024 ** 2, unit: " MB" },
      { label: "Event-loop p95 · ms", value: point => point.eventLoopP95Ms, unit: " ms" },
      { label: "HTTP requests · /s", value: point => point.requestsPerSecond, unit: " /s" },
      { label: "HTTP response · KB/s", value: point => point.responseBytesPerSecond / 1024, unit: " KB/s" },
    ];
    const width = 960, left = 205, right = 948, rowHeight = 48, top = 10;
    const rows = series.map((line, index) => {
      const points = history.map(point => {
        const value = Number(line.value(point));
        return Number.isFinite(value) && value > 0 ? value : 0;
      });
      const max = Math.max(1, ...points) * 1.15;
      const y = top + index * rowHeight;
      const d = points.map((value, pointIndex) => {
        const x = left + (history.length <= 1 ? 0 : pointIndex / (history.length - 1) * (right - left));
        const py = y + rowHeight - 10 - value / max * (rowHeight - 18);
        return `${pointIndex ? "L" : "M"}${x.toFixed(1)},${py.toFixed(1)}`;
      }).join(" ");
      const current = points.length ? `${points.at(-1).toFixed(1)}${line.unit}` : "—";
      return `<g><text class="server-chart-label" x="4" y="${y + 22}">${escapeHtml(line.label)}</text><text class="server-chart-value" x="${width - 4}" y="${y + 22}" text-anchor="end">${escapeHtml(current)}</text><line class="server-chart-grid" x1="${left}" y1="${y + rowHeight - 10}" x2="${right}" y2="${y + rowHeight - 10}"/><path class="server-chart-line" d="${d}"/></g>`;
    }).join("");
    return `<svg viewBox="0 0 ${width} ${top * 2 + rowHeight * series.length}" preserveAspectRatio="none" aria-hidden="true">${rows}</svg>`;
  }

  function startServerProfilePolling(load, intervalMs = 2000) {
    if (typeof load !== "function" || !Number.isFinite(intervalMs) || intervalMs < 1)
      throw new TypeError("A load function and positive polling interval are required.");
    const timer = setInterval(load, intervalMs);
    return () => clearInterval(timer);
  }

  const api = { renderServerProfileChart, startServerProfilePolling };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window === "object") window.ServerProfileCharts = api;
})();
