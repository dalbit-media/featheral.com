const { expect } = require("chai");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "sites", "shared", "wallet-profile.js"), "utf8");
const account = "0x1111111111111111111111111111111111111111";
const preferenceKey = "featheral.walletDisconnected";

function widget(hostname, { accounts = [], preference = null, storedPreference = null, multiple = false, legacy = false, reject = false, onConnect, adminWallets = [], fthgAdminWallets = [], moderators = adminWallets, role = false, configFailure = false, delayedConfig = null, delayedBalances = null } = {}) {
  const requests = [];
  const walletListeners = {};
  const alerts = [];
  const elements = [];
  const windowListeners = {};
  const otherRequests = [];
  const errors = [];
  const events = [];
  function node() {
    return {
      listeners: {},
      children: [],
      classList: { toggle() {} },
      append(...children) { this.children.push(...children); },
      prepend() {},
      after() {},
      replaceChildren(...children) { this.children = children; },
      setAttribute() {},
      querySelector() { return null; },
      getContext() { return { fillRect() {} }; },
      toDataURL() { return "data:image/png;base64,AA=="; },
      focus() {},
      closest() { return headerNav; },
      insertBefore(child) { this.children.push(child); },
      addEventListener(event, listener) { this.listeners[event] = listener; },
    };
  }
  const button = node();
  const headerNav = node();
  const location = { hostname, protocol: "https:" };
  const window = {
    location,
    addEventListener(event, listener) { windowListeners[event] = listener; },
    dispatchEvent(event) {
      if (event.type === "featheral:wallet") events.push(event);
      if (event.type === "eip6963:requestProvider" && multiple && !legacy) {
        windowListeners["eip6963:announceProvider"]({ detail: { provider: window.ethereum, info: { name: "MetaMask" } } });
        windowListeners["eip6963:announceProvider"]({ detail: { provider: otherProvider, info: { name: "Coinbase Wallet" } } });
      }
    },
    ethereum: {
      async request({ method }) {
        requests.push(method);
        if (method === "eth_accounts") return accounts;
        if (method === "eth_requestAccounts") return [account];
        if (method === "eth_chainId") return "0x1";
        if (method === "wallet_revokePermissions") return null;
        throw new Error(`Unexpected wallet request: ${method}`);
      },
      on(event, listener) { walletListeners[event] = listener; },
    },
  };
  const otherProvider = {
    async request({ method }) {
      otherRequests.push(method);
      if (method === "eth_requestAccounts") {
        if (reject) throw Object.assign(new Error("Rejected"), { code: 4001 });
        return [account];
      }
      if (method === "eth_chainId") return "0x1";
      if (method === "wallet_revokePermissions") return null;
      if (method === "personal_sign") return "selected-wallet-signature";
      throw new Error(`Unexpected selected wallet request: ${method}`);
    },
    on(event, listener) { walletListeners[`other:${event}`] = listener; },
  };
  if (multiple && legacy) window.ethereum.providers = [window.ethereum, otherProvider];
  vm.runInNewContext(source, {
    window,
    console: { error(...args) { errors.push(args); } },
    location,
    document: {
      cookie: preference === null ? "" : `${preferenceKey}=${preference}`,
      body: node(),
      createElement() { const element = node(); elements.push(element); return element; },
      addEventListener() {},
      removeEventListener() {},
    },
    localStorage: {
      getItem() { return storedPreference; },
      setItem() {},
    },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    Event: class { constructor(type) { this.type = type; } },
    alert(message) { alerts.push(message); },
    async fetch(url, init) {
      if (url.startsWith("/api/v1/wallets/") && delayedBalances) await delayedBalances;
      const isConfig = url === "/api/v1/admin/config" || url === "/api/v1/world/moderation?limit=1";
      if (isConfig && delayedConfig) await delayedConfig;
      return {
        ok: !(configFailure && isConfig),
        status: 503,
        async json() {
          if (url.startsWith("https:")) {
            const request = JSON.parse(init.body);
            return { result: request.params?.[0]?.data?.startsWith("0x91d14854") ? `0x${(role ? "1" : "0").padStart(64, "0")}` : "0x0" };
          }
          if (url === "/api/v1/admin/config") return { adminWallets, fthgAdminWallets };
          if (url === "/api/v1/world/moderation?limit=1") return { moderators };
          const profile = { username: "tester", avatar: "data:image/png;base64,AA==" };
          if (url.startsWith("/api/v1/profiles/")) return { profile };
          return { address: account, profile, fthDollar: { balance: "0" } };
        },
      };
    },
  });
  window.FeatheralSites = { current: hostname.split(".")[0] === "featheral" ? "foundation" : hostname.split(".")[0] };
  window.FeatheralProfile.mount(button, { onConnect });
  return { profile: window.FeatheralProfile, button, requests, otherRequests, otherProvider, walletListeners, alerts, elements, errors, events, adminLink: headerNav.children[0] };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("Shared Admin navigation", () => {
  it("notifies consoles of an account change before balance reads finish", async () => {
    let finish;
    const delayedBalances = new Promise((resolve) => { finish = resolve; });
    const app = widget("gold.featheral.com", { delayedBalances });
    await settle();
    const change = app.profile.setAccount(account);
    await settle();
    expect(app.events).to.have.length(1);
    expect(app.events[0].detail.account).to.equal(account);
    finish();
    await change;
  });
  for (const site of ["foundation", "gold", "dollar", "world"]) {
    const hostname = site === "foundation" ? "featheral.com" : `${site}.featheral.com`;
    it(`shows Admin for eligible ${site} wallets and hides on disconnect`, async () => {
      const app = widget(hostname, { accounts: [account], adminWallets: [account], fthgAdminWallets: [account] });
      await settle();
      expect(app.adminLink.hidden).to.equal(false);
      expect(app.adminLink.href).to.equal("/admin/");
      await app.profile.disconnect();
      expect(app.adminLink.hidden).to.equal(true);
      expect(app.errors).to.deep.equal([]);
    });

    it(`hides Admin for non-admin ${site} wallets`, async () => {
      const app = widget(hostname, { accounts: [account] });
      await settle();
      expect(app.adminLink.hidden).to.equal(true);
      expect(app.errors).to.deep.equal([]);
    });
  }

  it("shows Gold Admin for an on-chain DEFAULT_ADMIN_ROLE holder", async () => {
    const app = widget("gold.featheral.com", { accounts: [account], role: true });
    await settle();
    expect(app.adminLink.hidden).to.equal(false);
  });

  it("shows Dollar Admin for a fixed bridge project wallet", async () => {
    const app = widget("dollar.featheral.com", { accounts: [account], fthgAdminWallets: [account] });
    await settle();
    expect(app.adminLink.hidden).to.equal(false);
  });

  it("shows World Admin for a moderator not on the project admin lists", async () => {
    const app = widget("world.featheral.com", { accounts: [account], moderators: [account] });
    await settle();
    expect(app.adminLink.hidden).to.equal(false);
  });

  it("does not show World Admin for a fixed project wallet that is not a moderator", async () => {
    const app = widget("world.featheral.com", { accounts: [account], fthgAdminWallets: [account], moderators: [] });
    await settle();
    expect(app.adminLink.hidden).to.equal(true);
  });

  it("hides when switching to a non-admin account", async () => {
    const app = widget("world.featheral.com", { accounts: [account], adminWallets: [account] });
    await settle();
    expect(app.adminLink.hidden).to.equal(false);
    await app.profile.setAccount("0x2222222222222222222222222222222222222222");
    expect(app.adminLink.hidden).to.equal(true);
  });

  it("does not reveal Admin after a stale check finishes following disconnect", async () => {
    let finish;
    const delayedConfig = new Promise((resolve) => { finish = resolve; });
    const app = widget("world.featheral.com", { accounts: [account], adminWallets: [account], delayedConfig });
    await settle();
    await app.profile.disconnect();
    finish();
    await settle();
    expect(app.adminLink.hidden).to.equal(true);
  });

  it("logs configuration failures and leaves Admin hidden", async () => {
    const app = widget("world.featheral.com", { accounts: [account], configFailure: true });
    await settle();
    expect(app.adminLink.hidden).to.equal(true);
    expect(app.errors).to.have.length(1);
    expect(app.errors[0][0]).to.equal("Admin navigation check failed:");
  });
});

describe("Shared wallet connection", () => {
  for (const hostname of ["featheral.com", "gold.featheral.com", "dollar.featheral.com", "world.featheral.com"]) {
    describe(hostname, () => {
      it("does not prompt on a new origin after connecting on another site", async () => {
        const { profile, requests } = widget(hostname, { preference: "0" });
        await settle();
        expect(requests).to.deep.equal(["eth_accounts", "eth_chainId"]);
        expect(profile.snapshot().account).to.equal("");
      });

      it("does not prompt when the connected preference is in local storage", async () => {
        const { profile, requests } = widget(hostname, { storedPreference: "0" });
        await settle();
        expect(requests).not.to.include("eth_requestAccounts");
        expect(profile.snapshot().account).to.equal("");
      });

      it("silently restores an already-authorized wallet", async () => {
        const { profile, requests } = widget(hostname, { accounts: [account] });
        await settle();
        expect(profile.snapshot().account).to.equal(account);
        expect(requests).not.to.include("eth_requestAccounts");
      });

      it("honors the shared disconnect preference over local connection state", async () => {
        const { profile, requests, walletListeners } = widget(hostname, {
          accounts: [account], preference: "1", storedPreference: "0",
        });
        walletListeners.accountsChanged([account]);
        await settle();
        expect(requests).to.deep.equal([]);
        expect(profile.snapshot().account).to.equal("");
      });

      it("requests permission only after clicking the wallet icon", async () => {
        const { profile, button, requests, alerts } = widget(hostname, { preference: "1" });
        expect(requests).to.deep.equal([]);
        await button.listeners.click();
        expect(requests).to.deep.equal(["eth_requestAccounts", "eth_chainId", "eth_chainId"]);
        expect(profile.snapshot().account).to.equal(account);
        expect(alerts).to.deep.equal([]);
      });

      for (const legacy of [false, true]) {
        it(`lets the user select a wallet app (${legacy ? "legacy" : "EIP-6963"})`, async () => {
          let callbackProvider;
          const app = widget(hostname, {
            multiple: true, legacy,
            onConnect: () => { callbackProvider = app.profile.getProvider(); },
          });
          await settle();
          expect(app.requests).to.deep.equal([]);
          expect(app.otherRequests).to.deep.equal([]);
          await app.button.listeners.click();
          const picker = app.elements.find((element) => element.className === "wp-panel wp-wallet-picker");
          expect(picker.hidden).to.equal(false);
          expect(app.otherRequests).to.deep.equal([]);
          await picker.children[2].listeners.click();
          expect(picker.hidden).to.equal(true);
          expect(app.requests).to.deep.equal([]);
          expect(app.otherRequests).to.deep.equal(["eth_requestAccounts", "eth_chainId", "eth_chainId"]);
          expect(app.profile.getProvider()).to.equal(app.otherProvider);
          expect(callbackProvider).to.equal(app.otherProvider);
          expect(app.profile.snapshot().account).to.equal(account);
          expect(await app.profile.getProvider().request({ method: "personal_sign" })).to.equal("selected-wallet-signature");
          expect(app.walletListeners.accountsChanged).to.equal(undefined);
          await app.profile.disconnect();
          expect(app.otherRequests).to.include("wallet_revokePermissions");
          expect(app.requests).to.deep.equal([]);
          expect(app.alerts).to.deep.equal([]);
        });
      }

      it("cancels wallet selection without requesting permission", async () => {
        const app = widget(hostname, { multiple: true });
        await app.button.listeners.click();
        const picker = app.elements.find((element) => element.className === "wp-panel wp-wallet-picker");
        picker.children[3].listeners.click();
        expect(picker.hidden).to.equal(true);
        expect(app.otherRequests).to.deep.equal([]);
        expect(app.requests).to.deep.equal([]);
      });

      it("keeps the disconnect preference when permission is rejected", async () => {
        const app = widget(hostname, { multiple: true, preference: "1", reject: true });
        await app.button.listeners.click();
        const picker = app.elements.find((element) => element.className === "wp-panel wp-wallet-picker");
        await picker.children[2].listeners.click();
        expect(app.profile.isDisconnected()).to.equal(true);
        expect(app.profile.snapshot().account).to.equal("");
        expect(app.button.disabled).to.equal(false);
        expect(app.alerts).to.deep.equal([]);
      });
    });
  }
});
