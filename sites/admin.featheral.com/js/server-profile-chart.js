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

  function renderServerDiskChart(disk) {
    if (!disk.available) return `<p class="muted">${escapeHtml(disk.error)}</p>`;
    const bytes = value => {
      const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
      const index = value > 0 ? Math.min(units.length - 1, Math.max(0, Math.floor(Math.log(value) / Math.log(1024)))) : 0;
      return `${(value / 1024 ** index).toFixed(1)} ${units[index]}`;
    };
    const usedPct = disk.usedBytes / disk.totalBytes * 100;
    const freePct = 100 - usedPct;
    const description = `In use ${bytes(disk.usedBytes)} (${usedPct.toFixed(1)}%); free available ${bytes(disk.freeBytes)} (${freePct.toFixed(1)}%); total ${bytes(disk.totalBytes)}.`;
    const severity = ["healthy", "warning", "critical", "unknown"].includes(disk.severity) ? disk.severity : "unknown";
    const growth = disk.growthBytesPerDay;
    const forecast = growth === null || growth === undefined
      ? "Collecting history: at least five minutes between capacity samples are needed."
      : `Net growth: ${growth < 0 ? "-" : ""}${bytes(Math.abs(growth))}/day over ${(disk.growthObservedSeconds / 3600).toFixed(1)} hours. ${
        disk.daysUntilFull !== null ? `Estimated full in ${disk.daysUntilFull.toFixed(1)} days.`
          : "No net growth observed; no time-to-full projection."}`;
    return `<div class="server-disk-layout">
      <svg class="server-disk-donut" viewBox="0 0 160 160" role="img" aria-label="${escapeHtml(description)}">
        <circle class="server-disk-free" cx="80" cy="80" r="60"/>
        <circle class="server-disk-used" cx="80" cy="80" r="60" pathLength="100" stroke-dasharray="${usedPct} ${100 - usedPct}" transform="rotate(-90 80 80)"/>
        <text class="server-disk-percent" x="80" y="78" text-anchor="middle">${usedPct.toFixed(1)}%</text>
        <text class="server-disk-caption" x="80" y="96" text-anchor="middle">in use</text>
      </svg>
      <div class="server-disk-details"><p><span class="server-disk-key used"></span><b>In use</b> ${bytes(disk.usedBytes)} (${usedPct.toFixed(1)}%)</p>
        <p><span class="server-disk-key free"></span><b>Free available</b> ${bytes(disk.freeBytes)} (${freePct.toFixed(1)}%)</p>
        <p class="muted">Total capacity: ${bytes(disk.totalBytes)}</p>
        <div class="server-risk ${severity}"><span>${severity.toUpperCase()}</span><p>${escapeHtml(forecast)}</p></div>
      </div></div>`;
  }

  const api = { renderServerProfileChart, renderServerDiskChart, startServerProfilePolling };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window === "object") window.ServerProfileCharts = api;
})();
