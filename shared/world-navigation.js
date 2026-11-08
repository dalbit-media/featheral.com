"use strict";
(() => {
  document.addEventListener("toggle", event => {
    const menu = event.target;
    if (!(menu instanceof HTMLDetailsElement) || !menu.matches(".world-submenu") || !menu.open) return;
    menu.parentElement.querySelectorAll(".world-submenu[open]").forEach(other => { if (other !== menu) other.open = false; });
    const links = menu.querySelector(".world-submenu-links");
    links.style.transform = "";
    const rect = links.getBoundingClientRect(), edge = document.documentElement.clientWidth - 8;
    const shift = rect.left < 8 ? 8 - rect.left : rect.right > edge ? edge - rect.right : 0;
    if (shift) links.style.transform = `translateX(${shift}px)`;
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
  window.addEventListener("resize", () => {
    document.querySelectorAll(".world-submenu[open]").forEach(menu => { menu.open = false; });
  });
})();
