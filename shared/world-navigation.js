"use strict";
(() => {
  document.addEventListener("toggle", event => {
    const menu = event.target;
    if (!(menu instanceof HTMLDetailsElement) || !menu.matches(".world-submenu") || !menu.open) return;
    menu.parentElement.querySelectorAll(".world-submenu[open]").forEach(other => { if (other !== menu) other.open = false; });
  }, true);
  document.addEventListener("click", event => {
    document.querySelectorAll(".world-submenu[open]").forEach(menu => {
      if (!menu.contains(event.target) || event.target.closest("a")) menu.open = false;
    });
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    document.querySelectorAll(".world-submenu[open]").forEach(menu => {
      if (menu.contains(document.activeElement)) menu.querySelector("summary").focus();
      menu.open = false;
    });
  });
})();
