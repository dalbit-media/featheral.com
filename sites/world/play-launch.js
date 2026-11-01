"use strict";

document.addEventListener("click", (event) => {
  const link = event.target.closest?.("a[data-play-launch]");
  if (!link || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  const width = Math.min(1280, window.screen.availWidth);
  const height = Math.min(900, window.screen.availHeight);
  const popup = window.open(link.href, "featheral-play", `popup=yes,width=${width},height=${height},resizable=yes,scrollbars=yes`);
  if (!popup) {
    window.alert("Play could not open. Allow popups for Featheral World, then try again.");
    return;
  }
  popup.opener = null;
  popup.focus();
});
