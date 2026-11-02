"use strict";
(() => {
  const ns = "http://www.w3.org/2000/svg";
  function mount(root) {
    let history = { candles: [] }, count = 60, end = 0, sma = true, drag;
    const info = document.createElement("div"); info.className = "ohlc";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 900 440"); svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Executed-trade candlesticks and volume. Scroll to zoom, drag to pan.");
    root.replaceChildren(info, svg);
    const value = ratio => Number(ratio.numerator) / Number(ratio.denominator);
    const number = n => n.toLocaleString(undefined, { maximumSignificantDigits: 7 });
    const add = (tag, attrs, text) => {
      const node = document.createElementNS(ns, tag);
      for (const [key, val] of Object.entries(attrs)) node.setAttribute(key, val);
      if (text !== undefined) node.textContent = text;
      svg.append(node); return node;
    };
    function show(candle) {
      info.textContent = candle ? `${new Date(candle.at).toLocaleString()}  O ${number(value(candle.open))}  H ${number(value(candle.high))}  L ${number(value(candle.low))}  C ${number(value(candle.close))} ${history.currency}  | ${candle.trades} trades`
        : "No executed trades in this interval. Empty periods are not fabricated.";
    }
    let visible = [], step = 1;
    function draw() {
      svg.replaceChildren();
      const all = history.candles || [];
      end = Math.min(Math.max(1, end), all.length);
      const start = Math.max(0, end - count); visible = all.slice(start, end);
      show(visible.at(-1));
      if (!visible.length) { add("text", { x: 450, y: 180, "text-anchor": "middle", fill: "#a3a3b8", "font-size": 16 }, "No executed candles yet"); return; }
      let low = Math.min(...visible.map(c => value(c.low))), high = Math.max(...visible.map(c => value(c.high)));
      const pad = (high - low || high || 1) * .08; low = Math.max(0, low - pad); high += pad;
      const y = n => 300 - (n - low) / (high - low) * 270;
      step = 790 / Math.max(visible.length, 8);
      for (let i = 0; i < 6; i++) {
        const yy = 30 + i * 54;
        add("line", { x1: 10, x2: 800, y1: yy, y2: yy, stroke: "#2c2c39" });
        add("text", { x: 810, y: yy + 4, fill: "#a3a3b8", "font-size": 11 }, number(high - (high - low) * i / 5));
      }
      const maxVolume = Math.max(...visible.map(c => Number(c.quoteVolume)), 1), width = Math.max(1, Math.min(20, step * .65));
      visible.forEach((c, i) => {
        const x = 14 + (i + .5) * step, open = value(c.open), close = value(c.close), color = close >= open ? "#3dd9a0" : "#f97583";
        add("line", { x1: x, x2: x, y1: y(value(c.high)), y2: y(value(c.low)), stroke: color });
        add("rect", { x: x - width / 2, y: Math.min(y(open), y(close)), width, height: Math.max(1, Math.abs(y(open) - y(close))), fill: color });
        const height = Number(c.quoteVolume) / maxVolume * 65;
        add("rect", { x: x - width / 2, y: 390 - height, width, height, fill: color, opacity: .5 });
        if (i % Math.max(1, Math.ceil(visible.length / 5)) === 0)
          add("text", { x, y: 416, fill: "#a3a3b8", "font-size": 10 }, new Date(c.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }));
      });
      if (sma) {
        const points = [];
        for (let i = 0; i < visible.length; i++) {
          const index = start + i;
          if (index >= 19) {
            const average = all.slice(index - 19, index + 1).reduce((sum, c) => sum + value(c.close), 0) / 20;
            points.push(`${14 + (i + .5) * step},${Math.max(20, Math.min(310, y(average)))}`);
          }
        }
        if (points.length) add("polyline", { points: points.join(" "), fill: "none", stroke: "#d7b86d", "stroke-width": 1.5 });
      }
      add("text", { x: 15, y: 438, fill: "#a3a3b8", "font-size": 10 }, `Executed volume (${history.currency}) / SMA20 uses executed candles only`);
    }
    svg.addEventListener("wheel", event => { event.preventDefault(); count = Math.max(5, Math.min(300, count + (event.deltaY > 0 ? 5 : -5))); draw(); }, { passive: false });
    svg.addEventListener("pointerdown", event => { drag = { x: event.clientX, end }; svg.setPointerCapture(event.pointerId); });
    svg.addEventListener("pointerup", () => { drag = null; });
    svg.addEventListener("pointercancel", () => { drag = null; });
    svg.addEventListener("pointermove", event => {
      const bounds = svg.getBoundingClientRect(), x = (event.clientX - bounds.left) * 900 / bounds.width;
      if (drag) { end = drag.end - Math.round((event.clientX - drag.x) * 900 / bounds.width / step); draw(); }
      else show(visible[Math.max(0, Math.min(visible.length - 1, Math.floor((x - 14) / step)))]);
    });
    return { update(next) { history = next; end = next.candles?.length || 0; draw(); },
      reset() { count = 60; end = history.candles?.length || 0; draw(); }, sma(value) { sma = value; draw(); } };
  }
  window.FeatheralCandleChart = { mount };
})();
