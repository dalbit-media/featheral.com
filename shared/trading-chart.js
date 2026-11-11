"use strict";
(() => {
  let sequence = 0;
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  function average(candles, period) {
    let sum = 0;
    return candles.map((candle, index) => {
      sum += candle.close;
      if (index >= period) sum -= candles[index - period].close;
      return index + 1 >= period ? sum / period : null;
    });
  }
  function bounds(candles, duration) {
    if (!candles.length) throw Error("Chart bounds require recorded candles.");
    return { start: candles[0].time - duration / 2, end: Math.max(candles.at(-1).time + duration / 2, candles[0].time + duration * 6) };
  }
  function constrain(window, limits, minimumSpan) {
    const span = Math.min(limits.end - limits.start, Math.max(minimumSpan, window.end - window.start));
    const start = Math.max(limits.start, Math.min(limits.end - span, window.start));
    return { start, end: start + span };
  }
  function zoom(window, limits, factor, anchor, minimumSpan) {
    const ratio = Math.max(0, Math.min(1, anchor)), time = window.start + (window.end - window.start) * ratio;
    const span = Math.max(minimumSpan, Math.min(limits.end - limits.start, (window.end - window.start) * factor));
    return constrain({ start: time - span * ratio, end: time + span * (1 - ratio) }, limits, minimumSpan);
  }
  function validate(candles, duration) {
    if (!Number.isFinite(duration) || duration <= 0) throw Error("A positive chart interval is required.");
    for (const [index, candle] of candles.entries()) {
      if (!["time", "open", "high", "low", "close", "volume", "trades"].every(key => Number.isFinite(candle[key]))
        || candle.low < 0 || candle.volume < 0 || candle.trades < 1 || candle.high < Math.max(candle.open, candle.close)
        || candle.low > Math.min(candle.open, candle.close) || index && candle.time <= candles[index - 1].time)
        throw Error("Chart contains invalid or unordered executed candles.");
    }
  }
  function render(candles, options) {
    const { duration, formatPrice, formatVolume, formatTime } = options;
    validate(candles, duration);
    const t = text => escape(options.translate ? options.translate(text) : text);
    const price = value => escape(formatPrice(value)), volume = value => escape(formatVolume(value));
    const width = Math.max(240, options.width || 800), height = Math.max(180, options.height || 400);
    const id = options.id || `ft-chart-${++sequence}`, style = options.style || "line";
    if (!candles.length) return `<div class="ft-chart ft-chart-empty"><span class="chart-empty-symbol" aria-hidden="true">/ / /</span><h3>${t(options.emptyTitle || "No executed candles yet")}</h3><p>${t(options.emptyMessage || "Real trades will appear here. Empty periods are not fabricated.")}</p></div>`;
    const limits = bounds(candles, duration), window = constrain(options.window || limits, limits, duration);
    const visible = candles.filter(candle => candle.time >= window.start && candle.time <= window.end);
    const left = 12, right = width - Math.min(116, Math.max(76, width * .14)), top = 26;
    const bottom = height - (options.volume === false ? 36 : 102), volumeBottom = height - 30;
    const averages = options.averages ? [average(candles, 5), average(candles, 20)] : [];
    const averagePrices = averages.flatMap(values => values.filter((value, index) => value !== null && candles[index].time >= window.start && candles[index].time <= window.end));
    const latest = candles.at(-1), opening = visible[0], closing = visible.at(-1);
    const recordedLow = visible.length ? Math.min(...visible.map(candle => candle.low)) : latest.close;
    const recordedHigh = visible.length ? Math.max(...visible.map(candle => candle.high)) : latest.close;
    const low = Math.min(recordedLow, ...averagePrices), high = Math.max(recordedHigh, ...averagePrices);
    const padding = (high - low || high * .02 || .0001) * .16;
    const minimum = Math.max(0, low - padding), maximum = high + padding;
    const y = value => bottom - (value - minimum) / (maximum - minimum) * (bottom - top);
    const span = window.end - window.start, x = candle => left + (candle.time - window.start) * (right - left) / span;
    const change = opening?.open ? (closing.close - opening.open) / opening.open * 100 : 0;
    const direction = change >= 0 ? "up" : "down";
    const percent = value => `${value >= 0 ? "+" : ""}${value.toLocaleString(options.locale, { maximumFractionDigits: 2 })}%`;
    const percentage = percent(change);
    const candleWidth = Math.max(1, Math.min(22, (right - left) * duration / span * .65));
    const maxVolume = Math.max(1, ...visible.map(candle => candle.volume));
    const label = candle => options.candleLabel ? options.candleLabel(candle)
      : `${formatTime(candle.time)} · ${options.translate ? options.translate("Opening price") : "Opening price"} ${formatPrice(candle.open)} · H ${formatPrice(candle.high)} · L ${formatPrice(candle.low)} · C ${formatPrice(candle.close)} · ${options.translate ? options.translate("Volume") : "Volume"} ${formatVolume(candle.volume)} · ${candle.trades} ${options.translate ? options.translate("trades") : "trades"}`;
    const grid = Array.from({ length: 5 }, (_, index) => {
      const value = minimum + (maximum - minimum) * index / 4, yy = y(value);
      return `<path d="M${left} ${yy}H${right}" class="chart-grid"/><text x="${right + 10}" y="${yy + 4}" class="chart-axis-label">${price(value)}</text>`;
    }).join("");
    const segments = [];
    for (const candle of visible) {
      const segment = segments.at(-1);
      if (!segment || candle.time - segment.at(-1).time > duration * 1.5) segments.push([candle]);
      else segment.push(candle);
    }
    const areas = style === "line" ? segments.map(segment => {
      const points = segment.map(candle => `${x(candle)},${y(candle.close)}`).join(" ");
      const first = segment[0], last = segment.at(-1);
      return `<path class="chart-area" d="M${x(first)} ${bottom}L${segment.map(candle => `${x(candle)} ${y(candle.close)}`).join("L")}L${x(last)} ${bottom}Z" fill="url(#${escape(id)}-area)"/><polyline class="chart-line" points="${points}"/>`;
    }).join("") : "";
    const shapes = visible.map(candle => {
      const xx = x(candle), yy = y(candle.close), title = escape(label(candle)), up = candle.close >= candle.open;
      return `<g class="chart-candle ${up ? "up" : "down"}" tabindex="-1" data-chart-candle="${candle.time}" data-chart-x="${xx}" data-chart-y="${yy}" data-chart-price="${price(candle.close)}" data-chart-time="${escape(formatTime(candle.time))}" data-chart-change="${percent(opening?.open ? (candle.close - opening.open) / opening.open * 100 : 0)}" aria-label="${title}"><title>${title}</title><rect class="chart-hit" x="${Math.max(left, xx - Math.max(candleWidth, 10) / 2)}" y="${top}" width="${Math.max(candleWidth, 10)}" height="${volumeBottom - top}"/>
        ${style === "candles" ? `<path class="chart-wick" d="M${xx} ${y(candle.high)}V${y(candle.low)}"/><rect class="chart-body" x="${xx - candleWidth / 2}" y="${Math.min(y(candle.open), yy)}" width="${candleWidth}" height="${Math.max(1.5, Math.abs(y(candle.open) - yy))}"/>` : `<circle class="chart-sample" cx="${xx}" cy="${yy}" r="${segments.some(segment => segment.length === 1 && segment[0] === candle) ? 3 : 0}"/>`}
        ${options.volume === false ? "" : `<rect class="chart-volume" x="${xx - candleWidth / 2}" y="${volumeBottom - candle.volume * 42 / maxVolume}" width="${candleWidth}" height="${candle.volume * 42 / maxVolume}"/>`}</g>`;
    }).join("");
    const moving = averages.map((values, series) => {
      const parts = [];
      candles.forEach((candle, index) => {
        if (values[index] === null || candle.time < window.start || candle.time > window.end) return;
        const previous = candles[index - 1];
        parts.push(`${parts.length && previous && candle.time - previous.time <= duration * 1.5 ? "L" : "M"}${x(candle)} ${y(values[index])}`);
      });
      return `<path class="chart-average average-${series}" d="${parts.join("")}"/>`;
    }).join("");
    const timeCount = width < 500 ? 2 : 4;
    const times = Array.from({ length: timeCount }, (_, index) => {
      const ratio = index / (timeCount - 1);
      return `<text x="${left + ratio * (right - left)}" y="${height - 7}" text-anchor="${index === 0 ? "start" : index === timeCount - 1 ? "end" : "middle"}">${escape(formatTime(window.start + ratio * span, true))}</text>`;
    }).join("");
    const lastY = closing ? y(closing.close) : 0;
    const baseline = opening ? `<path d="M${left} ${y(opening.open)}H${right}" class="chart-baseline"/>` : "";
    const badge = closing ? `<g class="chart-price-tag"><rect x="${right + 4}" y="${lastY - 12}" width="${width - right - 6}" height="24" rx="5"/><text x="${right + 10}" y="${lastY + 4}">${price(closing.close)}</text></g>` : "";
    const endpoint = closing && style === "line" ? `<circle class="chart-endpoint-halo" cx="${x(closing)}" cy="${lastY}" r="8"/><circle class="chart-endpoint" cx="${x(closing)}" cy="${lastY}" r="3.5"/>` : "";
    const stat = (name, value) => `<span>${t(name)} <strong>${value}</strong></span>`;
    return `<div class="ft-chart" data-chart-direction="${direction}">
      <div class="chart-headline"><div><small data-chart-headline-label data-chart-default="${t("Latest recorded close")}">${t("Latest recorded close")}</small><strong><span data-chart-headline-price data-chart-default="${price(latest.close)}">${price(latest.close)}</span> <small>${escape(options.unit || "")}</small></strong></div><span class="chart-return ${direction}" data-chart-return-direction="${direction}"><span data-chart-return-value data-chart-default="${visible.length ? percentage : "—"}">${visible.length ? percentage : "—"}</span><small>${t("Visible range")}</small></span>${options.averages ? `<span class="chart-average-key">MA 5 / MA 20 · ${t("Recorded candles")}</span>` : ""}</div>
      <div class="chart-summary">${stat("Opening price", opening ? price(opening.open) : "—")}${stat("Highest price", opening ? price(recordedHigh) : "—")}${stat("Lowest price", opening ? price(recordedLow) : "—")}${stat("Closing price", closing ? price(closing.close) : "—")}${stat("Volume", volume(visible.reduce((sum, candle) => sum + candle.volume, 0)))}</div>
      <div class="chart-canvas"><svg class="market-chart trading-chart" viewBox="0 0 ${width} ${height}" role="group" tabindex="0" aria-label="${t(style === "candles" ? "Candlestick price chart" : "Closing price chart")}" data-chart-left="${left}" data-chart-right="${right}" data-chart-top="${top}" data-chart-bottom="${bottom}" data-chart-min="${minimum}" data-chart-max="${maximum}">
        <title>${t("Price history")}</title><defs><linearGradient id="${escape(id)}-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--chart-accent)" stop-opacity=".24"/><stop offset="100%" stop-color="var(--chart-accent)" stop-opacity="0"/></linearGradient><clipPath id="${escape(id)}-clip"><rect x="${left}" y="${top - 8}" width="${right - left}" height="${volumeBottom - top + 8}"/></clipPath></defs>
        ${grid}<g clip-path="url(#${escape(id)}-clip)">${baseline}${areas}${shapes}${moving}${endpoint}</g>${badge}
        ${visible.length ? "" : `<text x="${(left + right) / 2}" y="${(top + bottom) / 2}" text-anchor="middle">${t("No trades in this range")}</text>`}
        ${options.volume === false ? "" : `<text x="${left}" y="${bottom + 17}" class="chart-volume-label">${t("Volume")} · ${escape(options.volumeUnit || "")}</text>`}${times}
        <g class="chart-crosshair" visibility="hidden" pointer-events="none"><path data-crosshair-x class="chart-crosshair-line"/><path data-crosshair-y class="chart-crosshair-line"/><circle data-crosshair-dot r="4"/><text data-crosshair-price x="${right + 10}"/></g>
      </svg></div><p class="chart-inspection" data-chart-inspection data-chart-default="${t("Hover or focus a candle for OHLC and volume.")}" role="status">${t("Hover or focus a candle for OHLC and volume.")}</p></div>`;
  }
  function inspect(root, candle) {
    const svg = root.querySelector(".trading-chart");
    if (!svg) return;
    const x = Number(candle.dataset.chartX), y = Number(candle.dataset.chartY);
    const crosshair = svg.querySelector(".chart-crosshair");
    crosshair.setAttribute("visibility", "visible");
    crosshair.querySelector("[data-crosshair-x]").setAttribute("d", `M${x} ${svg.dataset.chartTop}V${svg.viewBox.baseVal.height - 30}`);
    crosshair.querySelector("[data-crosshair-y]").setAttribute("d", `M${svg.dataset.chartLeft} ${y}H${svg.dataset.chartRight}`);
    const dot = crosshair.querySelector("circle"); dot.setAttribute("cx", x); dot.setAttribute("cy", y);
    const label = crosshair.querySelector("text"); label.setAttribute("y", y - 7); label.textContent = candle.dataset.chartPrice;
    root.querySelector("[data-chart-headline-price]").textContent = candle.dataset.chartPrice;
    root.querySelector("[data-chart-headline-label]").textContent = candle.dataset.chartTime;
    root.querySelector("[data-chart-return-value]").textContent = candle.dataset.chartChange;
    root.querySelector(".chart-return").dataset.chartReturnDirection = candle.dataset.chartChange.startsWith("-") ? "down" : "up";
    root.querySelector("[data-chart-inspection]").textContent = candle.getAttribute("aria-label");
  }
  function clearInspection(root) {
    root.querySelector(".chart-crosshair")?.setAttribute("visibility", "hidden");
    root.querySelectorAll("[data-chart-default]").forEach(node => { node.textContent = node.dataset.chartDefault; });
    const change = root.querySelector(".chart-return");
    if (change) change.dataset.chartReturnDirection = root.querySelector(".ft-chart").dataset.chartDirection;
  }
  globalThis.FeatheralTradingChart = { render, validate, inspect, clearInspection, average, bounds, constrain, zoom };
})();
