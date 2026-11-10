"use strict";
(() => {
  const tabs = [...document.querySelectorAll("[data-exchange-tab]")];
  const panels = [...document.querySelectorAll("[data-exchange-panel]")];
  const list = document.querySelector("[data-exchange-tabs]");
  if (!list || !tabs.length || !panels.length) {
    console.error("Exchange workspace navigation is unavailable; all sections remain visible.");
    return;
  }
  list.setAttribute("role", "tablist");
  function activate(name, focus = false) {
    for (const tab of tabs) {
      const selected = tab.dataset.exchangeTab === name;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected && focus) tab.focus();
    }
    for (const panel of panels) panel.hidden = panel.dataset.exchangePanel !== name;
    window.dispatchEvent(new Event("resize"));
  }
  function fromHash() {
    const target = document.getElementById(location.hash.slice(1));
    if (target?.closest("#world-market-activity") && tabs.some(tab => tab.getAttribute("aria-selected") === "true")) return;
    activate(target?.closest("[data-exchange-panel]")?.dataset.exchangePanel || "trade");
  }
  for (const [index, tab] of tabs.entries()) {
    tab.setAttribute("role", "tab");
    const controlled = panels.filter(panel => panel.dataset.exchangePanel === tab.dataset.exchangeTab);
    tab.setAttribute("aria-controls", controlled.map(panel => panel.id).join(" "));
    for (const panel of controlled) panel.setAttribute("role", "tabpanel");
    tab.addEventListener("click", event => {
      event.preventDefault();
      history.replaceState(null, "", tab.getAttribute("href"));
      activate(tab.dataset.exchangeTab);
    });
    tab.addEventListener("keydown", event => {
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        tab.click();
        return;
      }
      const destination = event.key === "ArrowRight" ? (index + 1) % tabs.length
        : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
          : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
      if (destination < 0) return;
      event.preventDefault();
      tabs[destination].click();
      tabs[destination].focus();
    });
  }
  window.addEventListener("hashchange", fromHash);
  fromHash();
})();
