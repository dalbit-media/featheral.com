"use strict";
(() => {
  const suffixes = ["", "K", "M", "B", "T", "Qa", "Qi"];
  function compactText(text) {
    const match = /^(\s*[-\u2212+]?\s*[$\u20ac\u00a3]?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(\s+(?:[A-Za-z][A-Za-z$]*(?:[ /][A-Za-z][A-Za-z$]*)*)?\s*|\s*)$/.exec(text);
    if (!match) return text;
    const whole = match[2].replaceAll(",", ""), fraction = (match[3] || "").slice(1);
    if (BigInt(whole) < 10000n) return text;
    const scale = 10n ** BigInt(fraction.length), raw = BigInt(whole + fraction);
    let index = Math.min(Math.floor((whole.replace(/^0+/, "").length - 1) / 3), suffixes.length - 1);
    let divisor = 1000n ** BigInt(index) * scale;
    let rounded = (raw * 1000n + divisor / 2n) / divisor;
    if (rounded >= 1000000n && index < suffixes.length - 1) {
      index++; divisor *= 1000n; rounded = (raw * 1000n + divisor / 2n) / divisor;
    }
    const decimals = (rounded % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
    return `${match[1]}${rounded / 1000n}${decimals ? "." + decimals : ""}${suffixes[index]}${match[4]}`;
  }
  window.FeatheralNumbers = { compactText };
  if (!document.body || typeof MutationObserver !== "function") return;
  const metrics = "b,strong,dd,h1,h2,[data-total],[data-compact-number],.stat-value,.metric-value,.count,.note-supply,#goldStat,#dollarStat,#balance,#portfolio-usd,#portfolio-primary";
  const exact = "table,small,code,pre,svg,time,input,textarea,select,button,form,[contenteditable],[data-exact-number],.sr-only,.muted,.wp-muted,.wallet-approval,#swap,#requests,#history,#terminal,#trading-account,#initial-dollar-funding,#pending-movements,#liquidity-form";
  const records = new Map();
  function restoreAttributes(record) {
    for (const [name, value] of Object.entries(record.attributes)) {
      if (record.parent.getAttribute(name) !== record.applied[name]) continue;
      if (value === null) record.parent.removeAttribute(name);
      else record.parent.setAttribute(name, value);
    }
  }
  function restore(node, record) {
    if (node.nodeValue === record.compact) node.nodeValue = record.full;
    restoreAttributes(record);
    records.delete(node);
  }
  function render(node) {
    const parent = node.parentElement, record = records.get(node);
    if (!parent || !parent.closest(metrics) || parent.closest(exact)
      || parseFloat(getComputedStyle(parent).fontSize) <= 12) {
      if (record) restore(node, record);
      return;
    }
    if (record && node.nodeValue === record.compact) return;
    if (record) {
      restoreAttributes(record);
      records.delete(node);
    }
    const full = node.nodeValue, compact = compactText(full);
    if (full === compact) return;
    const attributes = Object.fromEntries(["title", "aria-label", "tabindex", "data-number-full"].map(name => [name, parent.getAttribute(name)]));
    const detail = parent.textContent;
    parent.title = attributes.title ? `${attributes.title} / ${detail}` : detail;
    parent.setAttribute("aria-label", attributes["aria-label"] || detail);
    parent.setAttribute("data-number-full", detail);
    if (!parent.closest("a,[tabindex]")) parent.tabIndex = 0;
    const applied = Object.fromEntries(Object.keys(attributes).map(name => [name, parent.getAttribute(name)]));
    records.set(node, { parent, full, compact, attributes, applied });
    node.nodeValue = compact;
  }
  function scan(root) {
    if (root.nodeType === Node.TEXT_NODE) { render(root); return; }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) render(walker.currentNode);
  }
  const observer = new MutationObserver(changes => {
    for (const [node, record] of records) if (!node.isConnected) restore(node, record);
    for (const change of changes) {
      if (change.type === "characterData") render(change.target);
      else for (const node of change.addedNodes) scan(node);
    }
  });
  scan(document.body);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  window.addEventListener("resize", () => scan(document.body));
  const tooltip = document.createElement("div");
  tooltip.setAttribute("role", "tooltip"); tooltip.hidden = true;
  Object.assign(tooltip.style, { position: "fixed", zIndex: "2147483647", maxWidth: "min(90vw, 600px)",
    padding: "8px 12px", borderRadius: "6px", background: "#101a28", color: "#e9f1fb",
    border: "1px solid #53677d", font: "13px/1.5 system-ui", overflowWrap: "anywhere", pointerEvents: "none" });
  document.body.append(tooltip);
  document.addEventListener("focusin", event => {
    const target = event.target.closest("[data-number-full]") || event.target.querySelector("[data-number-full]");
    if (!target) return;
    tooltip.textContent = target.getAttribute("data-number-full"); tooltip.hidden = false;
    const bounds = target.getBoundingClientRect();
    tooltip.style.left = Math.max(8, Math.min(bounds.left, innerWidth - tooltip.offsetWidth - 8)) + "px";
    tooltip.style.top = Math.max(8, Math.min(bounds.bottom + 6, innerHeight - tooltip.offsetHeight - 8)) + "px";
  });
  document.addEventListener("focusout", () => { tooltip.hidden = true; });
  document.addEventListener("keydown", event => { if (event.key === "Escape") tooltip.hidden = true; });
  window.addEventListener("scroll", () => { tooltip.hidden = true; }, true);
})();
