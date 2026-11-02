"use strict";

// Navigation and advisory wallet gates; privileged actions are checked on-chain or server-side.
window.AdminKit = (() => {
  const el = (tag, props = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
    return node;
  };

  async function json(url, init) {
    const response = await fetch(url, { cache: "no-store", ...init, headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers } });
    if (!response.headers.get("content-type")?.includes("json")) throw new Error(`Administration API did not return JSON (HTTP ${response.status}).`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  }

  const stat = (label, value) => el("div", { className: "stat" }, el("small", { textContent: label }), el("b", { textContent: String(value ?? "—") }));

  function tabs(root, initial = "", onChange = () => {}, canSelect = () => true) {
    const nav = root.querySelector("[data-admin-tabs]");
    if (!nav) return null;
    const buttons = [...nav.querySelectorAll("button[data-tab]")];
    const panels = buttons.map((button) => root.querySelector("#" + button.dataset.tab));
    nav.setAttribute("role", "tablist");
    nav.setAttribute("aria-label", "Administration");
    function select(id, updateRoute = true) {
      const index = buttons.findIndex((button) => button.dataset.tab === id);
      if (index < 0 || !canSelect(id)) return false;
      buttons.forEach((button, i) => {
        const active = i === index;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", String(active));
        button.tabIndex = active ? 0 : -1;
        panels[i].hidden = !active;
        panels[i].classList.toggle("active", active);
      });
      if (updateRoute) onChange(id);
      return true;
    }
    buttons.forEach((button, i) => {
      button.id = `admin-tab-${button.dataset.tab}`;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-controls", panels[i].id);
      panels[i].setAttribute("role", "tabpanel");
      panels[i].setAttribute("aria-labelledby", button.id);
      panels[i].tabIndex = 0;
      button.addEventListener("click", () => select(button.dataset.tab));
      button.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const available = buttons.filter((candidate) => canSelect(candidate.dataset.tab));
        const current = available.indexOf(button);
        const index = event.key === "Home" ? 0 : event.key === "End" ? available.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + available.length) % available.length;
        if (available[index]) { select(available[index].dataset.tab); available[index].focus(); }
      });
    });
    if (!select(initial, false)) select(buttons[0].dataset.tab, false);
    return { select };
  }

  // kind: "fth", "fthg", "any", or "world" (the server's actual moderator list).
  async function gate(host, kind, onChange, signal) {
    let list;
    try {
      const config = await json(kind === "world" ? "/api/v1/world/moderation?limit=1" : "/api/v1/admin/config");
      list = (kind === "world" ? config.moderators : kind === "fthg" ? config.fthgAdminWallets : kind === "any" ? [...config.adminWallets, ...config.fthgAdminWallets] : config.adminWallets).map((a) => a.toLowerCase());
    } catch (error) {
      if (signal?.aborted) return [];
      host.textContent = `Wallet access check unavailable: ${error.message}`;
      onChange?.(false, window.FeatheralProfile?.snapshot()?.account || "");
      console.error("Admin access check failed:", error);
      return [];
    }
    const render = (account) => {
      const ok = Boolean(account) && list.includes(account.toLowerCase());
      host.className = `admin-gate ${ok ? "ok" : ""}`;
      const role = kind === "world" ? "moderator" : "project";
      host.replaceChildren(el("b", { textContent: ok ? `${role === "moderator" ? "Moderator" : "Project"} wallet connected` : account ? `Connected wallet is not a configured ${role} wallet` : `Connect a ${role} wallet` }), el("span", { className: "muted", textContent: ok ? ` ${account}` : ` (${list.length} configured)` }));
      onChange?.(ok, account);
    };
    if (signal?.aborted) return [];
    window.addEventListener("featheral:wallet", (event) => render(event.detail.account), { signal });
    render(window.FeatheralProfile?.snapshot?.()?.account || "");
    return list;
  }

  function scope(root, signal) {
    return { el, json, stat,
      assertActive() { if (signal.aborted || !root.isConnected) throw new Error("Administration view changed. Review the action again."); },
      listen(type, listener) { window.addEventListener(type, listener, { signal }); },
      gate: (host, kind, onChange) => gate(host, kind, onChange, signal),
    };
  }
  return { el, json, stat, gate, tabs, scope };
})();
