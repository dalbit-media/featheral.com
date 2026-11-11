"use strict";
(() => {
  const engine = globalThis.FeatheralTradingChart;
  const intervals = { "1h": 300000, "24h": 3600000, "7d": 21600000, "30d": 86400000, all: 86400000 };
  function mount(root) {
    let history = { candles: [] }, candles = [], window, style = "line", averages = true, volume = true, duration = 3600000;
    let key, markup = "", frame = 0, gesture, observedCanvas;
    const pointers = new Map();
    const controls = document.createElement("div"); controls.className = "chart-appearance-controls";
    controls.setAttribute("role", "group"); controls.setAttribute("aria-label", "Chart appearance and navigation");
    controls.innerHTML = `<button type="button" data-chart-style="line" aria-pressed="true">Line</button><button type="button" data-chart-style="candles" aria-pressed="false">Candles</button>
      <button type="button" data-chart-volume aria-pressed="true">Volume</button><button type="button" data-chart-averages aria-pressed="true">MA 5 / 20</button>
      <button type="button" data-chart-nav="older" aria-label="Earlier candles" title="Earlier candles">&larr;</button><button type="button" data-chart-nav="in" aria-label="Zoom in">+</button><button type="button" data-chart-nav="out" aria-label="Zoom out">&minus;</button><button type="button" data-chart-nav="newer" aria-label="Later candles" title="Later candles">&rarr;</button>
      <button type="button" data-chart-nav="reset">Reset</button><button type="button" data-chart-close hidden>Exit fullscreen</button>`;
    const content = document.createElement("div"), disclosure = document.createElement("p");
    content.className = "chart-content";
    disclosure.className = "chart-disclosure";
    root.replaceChildren(controls, content, disclosure);
    const number = value => value.toLocaleString(undefined, { maximumSignificantDigits: 7 });
    const time = (at, short = false) => new Date(at).toLocaleString(undefined, { timeZone: "UTC", month: "short", day: "numeric",
      ...(!short || duration < 86400000 ? { hour: "2-digit", minute: "2-digit" } : {}) });
    function series() {
      if (!candles.length) return null;
      const bounds = engine.bounds(candles, duration);
      return { bounds, window: engine.constrain(window || bounds, bounds, duration * 3) };
    }
    function draw() {
      const focused = content.querySelector("[data-chart-candle]:focus")?.dataset.chartCandle;
      const chartFocused = content.querySelector(".trading-chart:focus");
      const canvas = content.querySelector(".chart-canvas");
      const next = engine.render(candles, { id: "exchange-market", duration, width: content.clientWidth || 800,
        height: canvas?.clientHeight || 400, style, averages, volume, window: series()?.window,
        unit: `${history.currency || "FTHX"}/${history.symbol?.replace(/^WORLD:/, "") || "asset"}`, volumeUnit: history.currency || "FTHX",
        formatPrice: number, formatVolume: value => `${number(value)} ${history.currency || "FTHX"}`, formatTime: time,
        emptyTitle: history.referenceOnly ? "Reference / conversion market" : "No executed candles yet",
        emptyMessage: history.referenceOnly ? "No direct FTHG / FTHX pool or executed candles. Empty periods are not fabricated." : undefined,
      });
      if (next !== markup) {
        content.innerHTML = next; markup = next;
        if (observedCanvas) observer.unobserve(observedCanvas);
        observedCanvas = content.querySelector(".chart-canvas");
        if (observedCanvas) observer.observe(observedCanvas);
        if (focused) content.querySelector(`[data-chart-candle="${focused}"]`)?.focus({ preventScroll: true });
        else if (chartFocused) content.querySelector(".trading-chart")?.focus({ preventScroll: true });
      }
      controls.querySelectorAll("[data-chart-style]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.chartStyle === style)));
      controls.querySelector("[data-chart-volume]").setAttribute("aria-pressed", String(volume));
      controls.querySelector("[data-chart-averages]").setAttribute("aria-pressed", String(averages));
      controls.querySelectorAll("[data-chart-nav]").forEach(button => { button.disabled = !candles.length; });
      disclosure.textContent = `Executed trades only. Gaps are not estimated prices. Times: UTC${history.clocks?.length ? " / " + history.clocks.join(", ") : ""}. Drag to pan; pinch or Ctrl + scroll to zoom. Arrow keys inspect; + / - zoom. Moving averages use recorded candles only.`;
    }
    function schedule() {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; draw(); });
    }
    function geometry() {
      const svg = content.querySelector(".trading-chart");
      if (!svg) return null;
      const rect = svg.getBoundingClientRect(), left = Number(svg.dataset.chartLeft), right = Number(svg.dataset.chartRight);
      const scale = rect.width / svg.viewBox.baseVal.width;
      return { svg, rect, left, right, pixelWidth: (right - left) * scale,
        x: clientX => (clientX - rect.left) / scale, y: clientY => (clientY - rect.top) / scale,
        anchor: clientX => ((clientX - rect.left) / scale - left) / (right - left) };
    }
    function show(candle) {
      engine.inspect(content, candle);
    }
    function clear() {
      engine.clearInspection(content);
    }
    function inspect(event) {
      const geo = geometry();
      if (!geo) return;
      const x = geo.x(event.clientX), y = geo.y(event.clientY);
      if (x < geo.left || x > geo.right || y < Number(geo.svg.dataset.chartTop) || y > Number(geo.svg.dataset.chartBottom)) { clear(); return; }
      const nearest = [...content.querySelectorAll("[data-chart-candle]")].reduce((best, candle) =>
        !best || Math.abs(Number(candle.dataset.chartX) - x) < Math.abs(Number(best.dataset.chartX) - x) ? candle : best, null);
      if (nearest) show(nearest);
    }
    function zoom(factor, anchor = .5) {
      const current = series();
      if (current) window = engine.zoom(current.window, current.bounds, factor, anchor, duration * 3);
    }
    function begin() {
      const current = series(), points = [...pointers.values()];
      gesture = current && points.length ? { window: current.window, x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
        distance: points.length > 1 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : 0 } : null;
    }
    controls.addEventListener("click", event => {
      const button = event.target.closest("button");
      if (!button) return;
      if (button.dataset.chartStyle) style = button.dataset.chartStyle;
      if (button.hasAttribute("data-chart-volume")) volume = !volume;
      if (button.hasAttribute("data-chart-averages")) averages = !averages;
      if (button.hasAttribute("data-chart-close")) {
        document.exitFullscreen().catch(error => { console.error(error); disclosure.textContent = error.message; });
        return;
      }
      const action = button.dataset.chartNav, current = series();
      if (action === "reset") window = undefined;
      else if (action === "in" || action === "out") zoom(action === "in" ? .7 : 1 / .7);
      else if (current && action) {
        const shift = (current.window.end - current.window.start) * (action === "older" ? -.25 : .25);
        window = engine.constrain({ start: current.window.start + shift, end: current.window.end + shift }, current.bounds, duration * 3);
      }
      draw();
    });
    content.addEventListener("pointerdown", event => {
      if (event.button !== 0 || !event.target.closest(".chart-canvas")) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY }); content.setPointerCapture(event.pointerId); begin(); inspect(event);
    });
    content.addEventListener("pointermove", event => {
      if (!pointers.has(event.pointerId)) { inspect(event); return; }
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const current = series(), geo = geometry();
      if (!current || !geo || !gesture) return;
      const points = [...pointers.values()];
      if (points.length > 1 && gesture.distance > 0) {
        const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
        window = engine.zoom(gesture.window, current.bounds, gesture.distance / Math.max(1, distance), geo.anchor(gesture.x), duration * 3);
      } else {
        const centre = points.reduce((sum, point) => sum + point.x, 0) / points.length;
        const shift = (gesture.x - centre) / geo.pixelWidth * (gesture.window.end - gesture.window.start);
        window = engine.constrain({ start: gesture.window.start + shift, end: gesture.window.end + shift }, current.bounds, duration * 3);
      }
      schedule();
    });
    const end = event => { pointers.delete(event.pointerId); begin(); };
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) content.addEventListener(name, end);
    content.addEventListener("pointerleave", () => { if (!pointers.size) clear(); });
    content.addEventListener("wheel", event => {
      if (!(event.ctrlKey || event.metaKey) || !event.target.closest(".chart-canvas")) return;
      const geo = geometry(); if (!geo) return;
      event.preventDefault(); zoom(Math.exp(Math.max(-1, Math.min(1, event.deltaY * .003))), geo.anchor(event.clientX)); schedule();
    }, { passive: false });
    content.addEventListener("focusin", event => { const candle = event.target.closest("[data-chart-candle]"); if (candle) show(candle); });
    content.addEventListener("focusout", event => { if (!content.contains(event.relatedTarget)) clear(); });
    content.addEventListener("keydown", event => {
      if (!event.target.closest(".chart-canvas")) return;
      if (["+", "=", "-"].includes(event.key)) { event.preventDefault(); zoom(event.key === "-" ? 1 / .7 : .7); draw(); return; }
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const nodes = [...content.querySelectorAll("[data-chart-candle]")], index = nodes.indexOf(document.activeElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? nodes.length - 1 : Math.max(0, Math.min(nodes.length - 1, index + (event.key === "ArrowLeft" ? -1 : 1)));
      nodes[next]?.focus({ preventScroll: true });
    });
    const observer = new ResizeObserver(schedule); observer.observe(root); observer.observe(content);
    const fullscreen = () => { controls.querySelector("[data-chart-close]").hidden = document.fullscreenElement !== root; schedule(); };
    document.addEventListener("fullscreenchange", fullscreen);
    return {
      update(next) {
        const nextKey = `${next.symbol || ""}:${next.interval || "24h"}:${next.source || ""}`;
        const nextDuration = intervals[next.interval || "24h"];
        if (!nextDuration) throw Error("Unsupported executed chart interval.");
        const decimals = next.quoteVolumeDecimals ?? (next.symbol === "FTH$" || next.currency === "FTH$" ? 18 : 0);
        const nextCandles = (next.candles || []).map(candle => ({ time: candle.at, open: Number(candle.open.numerator) / Number(candle.open.denominator),
          high: Number(candle.high.numerator) / Number(candle.high.denominator), low: Number(candle.low.numerator) / Number(candle.low.denominator),
          close: Number(candle.close.numerator) / Number(candle.close.denominator), volume: Number(candle.quoteVolume) / 10 ** decimals, trades: candle.trades }));
        // Validate before replacing the last successfully rendered history.
        engine.validate(nextCandles, nextDuration);
        if (key !== nextKey) { window = undefined; pointers.clear(); gesture = null; }
        key = nextKey; history = next; candles = nextCandles; duration = nextDuration; draw();
      },
      reset() { window = undefined; draw(); },
      sma(value) { averages = value; draw(); },
      destroy() { observer.disconnect(); cancelAnimationFrame(frame); document.removeEventListener("fullscreenchange", fullscreen); }
    };
  }
  window.FeatheralCandleChart = { mount };
})();
