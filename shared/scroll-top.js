"use strict";
(() => {
  if (location.pathname.startsWith("/operations/") || document.getElementById("featheral-scroll-top")) return;
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet"; stylesheet.href = "/shared/scroll-top.css";
  document.head.append(stylesheet);
  const button = document.createElement("button");
  button.id = "featheral-scroll-top"; button.type = "button"; button.hidden = true;
  button.setAttribute("aria-label", "Scroll to top"); button.title = "Scroll to top";
  button.textContent = "\u2191"; document.body.append(button);
  let panel = null;
  const update = () => {
    button.hidden = Math.max(document.scrollingElement?.scrollTop || 0, panel?.scrollTop || 0) < 300;
  };
  document.addEventListener("scroll", event => {
    const target = event.target;
    if (target instanceof HTMLElement && target.matches("main, #view, [role=main]")) panel = target;
    update();
  }, { capture: true, passive: true });
  window.addEventListener("scroll", update, { passive: true });
  button.addEventListener("click", () => {
    const behavior = matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth";
    window.scrollTo({ top: 0, behavior });
    panel?.scrollTo({ top: 0, behavior });
  });
  update();
})();
