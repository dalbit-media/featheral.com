const { expect } = require("chai");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "sites", "wallet.featheral.com", "wallet-profile.js"), "utf8");
const account = "0x1111111111111111111111111111111111111111";
const preferenceKey = "featheral.walletDisconnected";

function widget(hostname, { accounts = [], otherAccounts = [], preference = null, storedPreference = null, multiple = false, legacy = false, reject = false, onConnect, adminWallets = [], fthgAdminWallets = [], moderators = adminWallets, role = false, configFailure = false, delayedConfig = null, delayedBalances = null, publicAdmin = false, inlineProfile = false, rejectProfile = false, signProfile, walletFailure = false, central = false, ethereumProvider = false } = {}) {
  const requests = [];
  const walletListeners = {};
  const alerts = [];
  const elements = [];
  const windowListeners = {};
  const otherRequests = [];
  const errors = [];
  const events = [];
  const profileWrites = [];
  const centralCalls = [];
  function node() {
    return {
      listeners: {},
      children: [],
      dataset: {},
      classList: { toggle() {}, contains() { return false; } },
      append(...children) { this.children.push(...children); },
      prepend() {},
      after() {},
      replaceChildren(...children) { this.children = children; },
      setAttribute() {},
      querySelector(selector) {
        if (selector !== ".wp-status") return null;
        const descendants = parent => parent.children.flatMap(child => child && typeof child === "object" ? [child, ...descendants(child)] : []);
        return descendants(this).find(child => child.className === "wp-status") || null;
      },
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
  const profileRoot = inlineProfile ? node() : null;
  if (publicAdmin) {
    const link = { href: "/admin/", hidden: false };
    headerNav.append(link);
    headerNav.querySelector = selector => selector === 'a[href="/admin/"]' ? link : null;
  }
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
        if (method === "personal_sign") return signProfile ? signProfile() : "profile-signature";
        throw new Error(`Unexpected wallet request: ${method}`);
      },
      on(event, listener) { walletListeners[event] = listener; },
    },
  };
  const otherProvider = {
    async request({ method }) {
      otherRequests.push(method);
      if (method === "eth_accounts") return otherAccounts;
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
    crypto: require("node:crypto").webcrypto,
    TextEncoder,
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
      if (url.includes("/api/wallet/accounts/") && walletFailure)
        return { ok: false, status: 503, json: async () => ({ error: "Central wallet is unavailable." }) };
      if (url === "/api/v1/notes/profiles" && init?.method === "POST") {
        const data = JSON.parse(init.body);
        profileWrites.push(data);
        return { ok: !rejectProfile, json: async () => rejectProfile ? { error: "Username already taken." }
          : { profile: { username: data.username, avatar: data.avatar }, ledgerHeight: 7 } };
      }
      if (url.includes("/api/wallet/accounts/") && delayedBalances) await delayedBalances;
      const isConfig = url === "/api/v1/admin/config" || url === "/api/v1/world/moderation?limit=1";
      if (isConfig && delayedConfig) await delayedConfig;
      return {
        ok: !(configFailure && isConfig),
        status: 503,
        async json() {
          if (url.endsWith("/api/v1/gold/rpc")) {
            const request = JSON.parse(init.body);
            return { result: request.params?.[0]?.data?.startsWith("0x91d14854") ? `0x${(role ? "1" : "0").padStart(64, "0")}` : "0x0" };
          }
          if (url === "/api/v1/admin/config") return { adminWallets, fthgAdminWallets };
          if (url === "/api/v1/world/moderation?limit=1") return { moderators };
          const profile = { username: "tester", avatar: "data:image/png;base64,AA==" };
          if (url.startsWith("/api/v1/notes/profiles/")) return { profile };
          if (url.includes("/api/wallet/accounts/")) return { holdings: [{ symbol: "FTHX", balance: "42" }],
            dollar: { balance: { available: "0", reserved: "0" } },
            ethereum: { balance: "2000000000000000000" }, portfolio: { usd: "12.00", fthg: "3000000000000000000", partial: false, unpriced: [] } };
          return { address: account, gameAccountId: `wallet:${account}`, profile, fthDollar: { balance: "0", reserved: "0" } };
        },
      };
    },
  });

  window.FeatheralSites = { current: hostname.split(".")[0] === "featheral" ? "foundation" : hostname.split(".")[0],
    url: (site, pathname) => `https://${site}.featheral.com${pathname}` };
  if (central) window.FeatheralWallet = { open: config => centralCalls.push(config) };
  window.FeatheralProfile.mount(button, { onConnect, profileRoot, ethereumProvider });
  return { profile: window.FeatheralProfile, button, requests, otherRequests, otherProvider, walletListeners, alerts, elements, errors, events, profileRoot, profileWrites, centralCalls, adminLink: headerNav.children[0] };
}

describe("Admin signing restoration", () => {
    it("restores the matching connected signer when multiple providers prevent automatic header restoration", async () => {
      const app = widget("admin.featheral.com", { multiple: true, otherAccounts: [account], ethereumProvider: true });
      await settle();
      expect(app.profile.getProvider()).to.equal(null);
      const signer = await app.profile.ensureSigner(account);
      expect(signer.provider).to.equal(app.otherProvider);
      expect(signer.account).to.equal(account);
      expect(app.profile.snapshot().account).to.equal(account);
      expect(app.otherRequests).not.to.include("eth_requestAccounts");
    });
    it("requests origin permission on a signing click when the only provider is not yet authorized", async () => {
      const app = widget("admin.featheral.com", { ethereumProvider: true });
      await settle();
      expect(app.requests).not.to.include("eth_requestAccounts");
      const signer = await app.profile.ensureSigner(account);
      expect(signer.account).to.equal(account);
      expect(app.requests).to.include("eth_requestAccounts");
    });
    it("refreshes stale profile state from the selected provider before signing", async () => {
      const app = widget("admin.featheral.com", { accounts: [account], ethereumProvider: true });
      await settle();
      await app.profile.setAccount("");
      const signer = await app.profile.ensureSigner(account);
      expect(signer.account).to.equal(account);
      expect(app.requests).not.to.include("eth_requestAccounts");
    });
    it("does not substitute a different wallet for the wallet bound to the Admin session", async () => {
      const app = widget("admin.featheral.com", { accounts: [account], ethereumProvider: true });
      await settle();
      let error;
      try { await app.profile.ensureSigner("0x2222222222222222222222222222222222222222"); } catch (value) { error = value; }
      expect(error.message).to.include("other authorized origin or reserve wallet");
      expect(app.requests).not.to.include("personal_sign");
    });
    it("does not choose arbitrarily between two matching wallet extensions", async () => {
      const app = widget("admin.featheral.com", { multiple: true, accounts: [account], otherAccounts: [account], ethereumProvider: true });
      await settle();
      let error;
      try { await app.profile.ensureSigner(account); } catch (value) { error = value; }
      expect(error.message).to.include("Choose the Admin signing wallet");
      expect(app.profile.getProvider()).to.equal(null);
    });
  });
describe("Central wallet consistency", () => {
  for (const [host, primary] of [["featheral.com", "FTHX"], ["gold.featheral.com", "FTHG"], ["dollar.featheral.com", "FTH$"], ["world.featheral.com", "FTH$"]]) {
    it(`opens the common account-following renderer on ${host}`, async () => {
      const app = widget(host, { central: true });
      await app.button.listeners.click();
      expect(app.centralCalls).to.have.length(1);
      expect(app.centralCalls[0].primary).to.equal(primary);
      expect(app.requests).not.to.include("eth_requestAccounts");
    });
  }
  it("preserves explicit provider connection on Ethereum transaction screens", async () => {
    const app = widget("gold.featheral.com", { central: true, ethereumProvider: true });
    await app.button.listeners.click();
    expect(app.centralCalls).to.have.length(0);
    expect(app.requests).to.include("eth_requestAccounts");
  });
  it("preserves explicit Ethereum signer labels at runtime without changing generic wallet labels", async () => {
    const disconnected = widget("ex.featheral.com", { ethereumProvider: true });
    await settle();
    expect(disconnected.button.title).to.equal("Connect Ethereum signer");
    const connected = widget("ex.featheral.com", { ethereumProvider: true, accounts: [account] });
    await settle();
    expect(connected.button.title).to.equal("Ethereum signer (connected)");
    const generic = widget("ex.featheral.com");
    await settle();
    expect(generic.button.title).to.equal("Connect wallet to see your balance and profile");
    expect(source).to.include('button.setAttribute("aria-label", label)');
  });
  it("keeps World inline profile authentication separate from wallet portfolio selection", async () => {
    const app = widget("world.featheral.com", { central: true, inlineProfile: true });
    await app.profileRoot.children.find(child => child?.tagName === "BUTTON" || child?.textContent === "Connect wallet to set up profile").listeners.click();
    expect(app.centralCalls).to.have.length(0);
    expect(app.requests).to.include("eth_requestAccounts");
  });
});

const settle = () => new Promise((resolve) => setImmediate(resolve));
describe("Central wallet themed profile panels", () => {
  it("shows an existing FTHX balance in the Dollar wallet popup alongside swap access", async () => {
    const app = widget("dollar.featheral.com", { accounts: [account] });
    await settle(); await app.button.listeners.click();
    expect(app.elements.some(element => element.textContent === "42 FTHX")).to.equal(true);
    expect(app.elements.some(element => element.textContent === "⇄ Swap" && element.href === "https://ex.featheral.com/")).to.equal(true);
  });
  it("reports central API failures without inventing balances or disabling profile editing", async () => {
    const app = widget("gold.featheral.com", { accounts: [account], walletFailure: true });
    await settle(); await app.button.listeners.click();
    const panel = app.elements.find(element => element.className === "wp-panel");
    const descendants = node => [node, ...(node.children || []).flatMap(child => typeof child === "object" ? descendants(child) : [])];
    const texts = descendants(panel).map(node => node.textContent);
    expect(texts).to.include("Central wallet is unavailable.");
    expect(texts).to.include("USD unavailable");
    expect(texts).not.to.include("$12.00");
    expect(texts).to.include("Edit World profile ↗");
    expect(app.errors.some(args => args[0] === "Central wallet portfolio unavailable:")).to.equal(true);
  });
  it("native signer panels use central USD valuations or explicitly report unavailable, never a fixed Dollar peg", async () => {
    for (const walletFailure of [false, true]) {
      const app = widget("ex.featheral.com", { accounts: [account], ethereumProvider: true, walletFailure });
      await settle(); await app.button.listeners.click();
      const panel = app.elements.find(element => element.className === "wp-panel");
      const descendants = node => [node, ...(node.children || []).flatMap(child => typeof child === "object" ? descendants(child) : [])];
      const texts = descendants(panel).map(node => node.textContent);
      expect(texts).to.include(walletFailure ? "USD unavailable" : "$12.00");
    }
    expect(source).not.to.match(/0\.01|toUsd|usdPerDollar/);
  });
  for (const [hostname, primary] of [["featheral.com", "42 FTHX"], ["gold.featheral.com", "2 FTHG"]]) {
    it(`preserves the profile panel on ${hostname} with central portfolio totals and primary asset`, async () => {
      const app = widget(hostname, { accounts: [account] });
      await settle();
      await app.button.listeners.click();
      const panel = app.elements.find(element => element.className === "wp-panel");
      const descendants = node => [node, ...(node.children || []).flatMap(child => typeof child === "object" ? descendants(child) : [])];
      const nodes = descendants(panel), texts = nodes.map(node => node.textContent);
      expect(texts).to.include(primary);
      expect(texts).to.include("$12.00");
      expect(texts).to.include("3 FTHG estimated");
      expect(nodes.some(node => node.href?.startsWith("https://wallet.featheral.com/?primary="))).to.equal(true);
    });
  }
});

describe("Inline World profile editor", () => {
  it("links every wallet menu to World setup without creating an inline wallet editor", async () => {
    const world = widget("world.featheral.com", { accounts: [account] });
    const gold = widget("gold.featheral.com", { accounts: [account] });
    await settle();
    await world.button.listeners.click();
    await gold.button.listeners.click();
    expect(world.alerts).to.deep.equal([]);
    expect(gold.alerts).to.deep.equal([]);
    expect(world.elements.some(node => node.href === "https://world.featheral.com/#/setup")).to.equal(true);
    expect(world.elements.some(node => node.autocomplete === "nickname")).to.equal(false);
    expect(gold.elements.some(node => node.autocomplete === "nickname")).to.equal(false);
    expect(gold.elements.some(node => node.href === "https://world.featheral.com/#/setup")).to.equal(true);
  });
  it("offers optional setup without prompting a visitor's wallet", async () => {
    const app = widget("world.featheral.com", { inlineProfile: true });
    await settle();
    expect(app.profileRoot.children.some(child => child.textContent === "Connect wallet to set up profile")).to.equal(true);
    expect(app.requests).not.to.include("eth_requestAccounts");
    expect(app.profileWrites).to.have.length(0);
  });
  it("preserves an unsaved username during balance refresh and publishes through the existing signature API", async () => {
    const app = widget("world.featheral.com", { inlineProfile: true, accounts: [account] });
    await settle();
    const input = app.elements.filter(element => element.autocomplete === "nickname").at(-1);
    const save = app.elements.filter(element => element.textContent === "Save profile").at(-1);
    const editorCount = app.elements.filter(element => element.autocomplete === "nickname").length;
    input.value = "world_builder";
    await app.profile.setAccount(account);
    expect(app.elements.filter(element => element.autocomplete === "nickname")).to.have.length(editorCount);
    expect(input.value).to.equal("world_builder");
    await save.listeners.click();
    expect(app.profileWrites).to.have.length(1);
    expect(app.profileWrites[0]).to.include({ address: account, username: "world_builder", signature: "profile-signature" });
    expect(app.profile.snapshot().profile.username).to.equal("world_builder");
    expect(app.profileRoot.querySelector(".wp-status").textContent).to.equal("Saved · FTH$ block #7");
  });
  it("reports validation and server errors without losing the draft", async () => {
    const app = widget("world.featheral.com", { inlineProfile: true, accounts: [account], rejectProfile: true });
    await settle();
    const input = app.elements.filter(element => element.autocomplete === "nickname").at(-1);
    const save = app.elements.filter(element => element.textContent === "Save profile").at(-1);
    input.value = "..";
    await save.listeners.click();
    expect(app.profileWrites).to.have.length(0);
    expect(app.profileRoot.querySelector(".wp-status").dataset.kind).to.equal("error");
    input.value = "reserved_name";
    await save.listeners.click();
    expect(app.profileRoot.querySelector(".wp-status").textContent).to.equal("Username already taken.");
    expect(input.value).to.equal("reserved_name");
  });
  it("blocks profile publication when the wallet changes while signing", async () => {
    let finish;
    const app = widget("world.featheral.com", { inlineProfile: true, accounts: [account], signProfile: () => new Promise(resolve => { finish = resolve; }) });
    await settle();
    const save = app.elements.filter(element => element.textContent === "Save profile").at(-1);
    const pending = save.listeners.click();
    while (!finish) await settle();
    await app.profile.setAccount("0x2222222222222222222222222222222222222222");
    finish("old-signature");
    await pending;
    expect(app.profileWrites).to.have.length(0);
  });
});

describe("Shared Admin navigation", () => {
  it("preserves an existing public reserve admin link without duplicating or hiding it", async () => {
    const app = widget("gold.featheral.com", { publicAdmin: true });
    await settle();
    expect(app.adminLink.hidden).to.equal(false);
    await app.profile.setAccount(account);
    expect(app.adminLink.hidden).to.equal(false);
    await app.profile.disconnect();
    expect(app.adminLink.hidden).to.equal(false);
    expect(app.elements.filter(element => element.className === "admin-nav")).to.have.length(0);
  });
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
