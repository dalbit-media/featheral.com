const { expect } = require("chai");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..", "sites");
const source = fs.readFileSync(path.join(root, "shared", "admin-kit.js"), "utf8");

function fixture({ hash = "", restricted = false, fail = false } = {}) {
  const handlers = {};
  const errors = [];
  let account = "";
  const moderator = "0x1111111111111111111111111111111111111111";
  const project = "0x2222222222222222222222222222222222222222";
  const nodes = {};
  function node(id) {
    const classes = new Set();
    return nodes[id] = {
      id, attrs: {}, children: [], handlers: {}, dataset: {}, hidden: false,
      classList: {
        toggle(name, value) { if (value) classes.add(name); else classes.delete(name); },
        contains(name) { return classes.has(name); },
      },
      setAttribute(name, value) { this.attrs[name] = value; },
      addEventListener(name, listener) { this.handlers[name] = listener; },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      focus() { this.focused = true; },
      getBoundingClientRect() { return { height: 61 }; },
    };
  }
  const buttons = ["overview", "operations", "queries"].map((id) => {
    const button = node(`button-${id}`);
    button.dataset.tab = id;
    node(id);
    return button;
  });
  const nav = node("nav");
  nav.querySelectorAll = () => buttons;
  const location = { hash };
  const calls = [];
  const window = {
    FeatheralProfile: { snapshot: () => ({ account }) },
    addEventListener(event, listener) { handlers[event] = listener; },
  };
  vm.runInNewContext(source, {
    window, location,
    history: { replaceState(state, title, value) { location.hash = value; } },
    document: {
      body: { style: { setProperty() {} } },
      querySelector() { return nav; },
      getElementById(id) { return nodes[id]; },
      createElement() { return node(`el-${Object.keys(nodes).length}`); },
    },
    ResizeObserver: class { observe() {} },
    console: { error(...args) { errors.push(args); } },
    async fetch(url) {
      calls.push(url);
      return {
        ok: !fail, status: 503,
        async json() { return url.includes("/world/") ? { moderators: [moderator] } : { adminWallets: [project], fthgAdminWallets: [] }; },
      };
    },
  });
  const changes = [];
  const tabs = window.AdminKit.tabs((id) => changes.push(id), (id) => !restricted || id !== "operations");
  return { window, nodes, buttons, tabs, changes, location, handlers, calls, errors, moderator, project, setAccount(value) { account = value; } };
}

describe("Shared administration tabs", () => {
  it("shows one panel, wires ARIA, preserves hidden-panel input state, and follows deep links", () => {
    const ui = fixture({ hash: "#queries" });
    expect(ui.nodes.queries.hidden).to.equal(false);
    expect(ui.nodes.overview.hidden).to.equal(true);
    expect(ui.buttons[2].attrs["aria-selected"]).to.equal("true");
    expect(ui.buttons[2].attrs["aria-controls"]).to.equal("queries");
    expect(ui.nodes.queries.attrs.role).to.equal("tabpanel");
    ui.nodes.queries.value = "SELECT * FROM blocks";
    ui.tabs.select("overview");
    expect(ui.location.hash).to.equal("#overview");
    ui.tabs.select("queries");
    expect(ui.nodes.queries.value).to.equal("SELECT * FROM blocks");
    expect(ui.buttons.filter((button) => button.tabIndex === 0)).to.have.length(1);
  });

  it("supports keyboard selection and skips restricted tabs", () => {
    const ui = fixture({ restricted: true });
    let prevented = false;
    ui.buttons[0].handlers.keydown({ key: "ArrowRight", preventDefault() { prevented = true; } });
    expect(prevented).to.equal(true);
    expect(ui.nodes.queries.hidden).to.equal(false);
    expect(ui.buttons[2].focused).to.equal(true);
    expect(ui.tabs.select("operations")).to.equal(false);
    ui.buttons[2].handlers.keydown({ key: "Home", preventDefault() {} });
    expect(ui.nodes.overview.hidden).to.equal(false);
  });

  it("rejects invalid hashes and responds to valid hash navigation", () => {
    const ui = fixture({ hash: "#removed-tab" });
    expect(ui.nodes.overview.hidden).to.equal(false);
    ui.location.hash = "#queries";
    ui.handlers.hashchange();
    expect(ui.nodes.queries.hidden).to.equal(false);
    expect(ui.tabs.select("removed-tab")).to.equal(false);
  });

  for (const site of ["foundation", "gold", "dollar", "world"]) {
    it(`wires every ${site} tab to a unique existing panel`, () => {
      const html = fs.readFileSync(path.join(root, site, "admin", "index.html"), "utf8");
      const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
      expect(new Set(ids).size).to.equal(ids.length);
      const nav = html.match(/<nav[^>]*data-admin-tabs[^>]*>([\s\S]*?)<\/nav>/)[1];
      const tabs = [...nav.matchAll(/data-tab="([^"]+)"/g)].map((match) => match[1]);
      expect(tabs.length).to.be.greaterThan(1);
      for (const id of tabs) expect(html).to.match(new RegExp(`<section[^>]*id="${id}"`));
      expect(html).to.include("/shared/admin.css");
      expect(html).to.include("/shared/admin-kit.js");
    });
  }

  it("does not leave removed Gold control handlers or dead literal DOM references", () => {
    const html = fs.readFileSync(path.join(root, "gold", "admin", "index.html"), "utf8");
    const script = fs.readFileSync(path.join(root, "gold", "admin", "app.js"), "utf8");
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
    for (const match of script.matchAll(/\$\("([^"]+)"\)|act\("([^"]+)"/g)) expect(ids.has(match[1] || match[2]), match[1] || match[2]).to.equal(true);
    for (const removed of ["depositDynamicBridgeFthg", "initializeDynamicBridgePool", "lpSend", "addMarket", "mTable", "dexRoadmapSummary"]) {
      expect(html).not.to.include(removed);
      expect(script).not.to.include(removed);
    }
    expect(html).not.to.include("ledger.sqlite");
    expect(html).to.include('data-path="/admin/#liquidity"');
    expect(html).to.include('data-tab="game"');
    expect(html).to.include('data-tab="dex"');
  });

  it("keeps personal staking in the wallet and management in admin", () => {
    const admin = fs.readFileSync(path.join(root, "dollar", "admin", "index.html"), "utf8");
    const wallet = fs.readFileSync(path.join(root, "dollar", "wallet", "index.html"), "utf8");
    for (const id of ["stakeForm", "claimForm"]) {
      expect(admin).not.to.include(`id="${id}"`);
      expect(wallet).to.include(`id="${id}"`);
    }
    expect(admin).to.include('id="aprForm"');
    expect(admin).to.include('href="/wallet/#staking"');
    expect(wallet).to.include("/wallet/staking.js");
  });
});

describe("World moderator wallet gate", () => {
  it("uses actual moderators rather than the unrelated project admin list", async () => {
    const ui = fixture();
    let authorized;
    await ui.window.AdminKit.gate(ui.nodes.overview, "world", (ok) => { authorized = ok; });
    expect(ui.calls).to.deep.equal(["/api/v1/world/moderation?limit=1"]);
    ui.setAccount(ui.project);
    ui.handlers["featheral:wallet"]({ detail: { account: ui.project } });
    expect(authorized).to.equal(false);
    ui.setAccount(ui.moderator);
    ui.handlers["featheral:wallet"]({ detail: { account: ui.moderator } });
    expect(authorized).to.equal(true);
    ui.handlers["featheral:wallet"]({ detail: { account: "" } });
    expect(authorized).to.equal(false);
  });

  it("reports a failed access lookup explicitly and disables access", async () => {
    const ui = fixture({ fail: true });
    let authorized = true;
    await ui.window.AdminKit.gate(ui.nodes.overview, "world", (ok) => { authorized = ok; });
    expect(authorized).to.equal(false);
    expect(ui.nodes.overview.textContent).to.include("unavailable");
    expect(ui.errors).to.have.length(1);
  });
});

describe("World moderation actions", () => {
  async function submit({ approved = false, wallet = "0x1111111111111111111111111111111111111111" } = {}) {
    const nodes = {};
    const writes = [];
    const signatures = [];
    const node = (id) => nodes[id] ||= { value: "", textContent: "", handlers: {}, replaceChildren() {}, addEventListener(name, handler) { this.handlers[name] = handler; } };
    const button = {};
    const json = async (url, options) => {
      if (options) writes.push({ url, ...options });
      return url.endsWith("/stats") ? { ledger: {} } : { moderators: [], suspended: [], posts: [] };
    };
    const FeatheralProfile = { getProvider: () => ({ async request(request) { signatures.push(request); return "0x1234"; } }) };
    const window = {
      AdminKit: {
        el() {}, stat() {}, json, tabs() {}, mountWallet() {},
        gate(host, kind, change) { change(true, "0x2222222222222222222222222222222222222222"); },
      },
      LedgerSql: { mount() {} },
    };
    vm.runInNewContext(fs.readFileSync(path.join(root, "world", "admin", "admin.js"), "utf8"), {
      window, FeatheralProfile, ethers: require("ethers"), crypto: require("node:crypto").webcrypto,
      confirm: () => approved,
      document: { getElementById: node, querySelectorAll: () => [button] },
    });
    node("walletInput").value = wallet;
    node("walletForm").handlers.submit({ preventDefault() {} });
    await new Promise(setImmediate);
    return { nodes, writes, signatures, button, wallet };
  }

  it("preserves the wallet input and submits nothing when confirmation is cancelled", async () => {
    const ui = await submit();
    expect(ui.nodes.walletInput.value).to.equal(ui.wallet);
    expect(ui.nodes.moderationStatus.textContent).to.include("cancelled");
    expect(ui.writes).to.have.length(0);
    expect(ui.signatures).to.have.length(0);
    expect(ui.button.disabled).to.equal(false);
  });

  it("clears the input only after a signed moderation action is recorded", async () => {
    const ui = await submit({ approved: true });
    expect(ui.nodes.walletInput.value).to.equal("");
    expect(ui.nodes.moderationStatus.textContent).to.include("recorded");
    expect(ui.signatures[0].method).to.equal("personal_sign");
    expect(ui.writes[0].url).to.equal("/api/v1/world/actions");
    expect(JSON.parse(ui.writes[0].body).data.act).to.equal("SUSPEND");
  });

  it("reports invalid wallet input without signing or clearing it", async () => {
    const ui = await submit({ approved: true, wallet: "invalid wallet" });
    expect(ui.nodes.walletInput.value).to.equal(ui.wallet);
    expect(ui.nodes.moderationStatus.textContent).to.include("Moderation failed:");
    expect(ui.signatures).to.have.length(0);
    expect(ui.writes).to.have.length(0);
  });
});

describe("Ledger SQL menu examples", () => {
  for (const [site, page, count] of [["dollar", "admin", 3], ["world", "admin", 3], ["dollar", "explorer", 6], ["world", "ledger", 6]]) {
    it(`provides labeled, executable queries in ${site} ${page}`, () => {
      const filename = page === "admin" ? "admin.js" : `${page}.js`;
      const script = fs.readFileSync(path.join(root, site, page, filename), "utf8");
      const examples = [...script.matchAll(/\{ title: ("(?:[^"\\]|\\.)*"), sql: ("(?:[^"\\]|\\.)*") \}/g)].map((match) => ({ title: JSON.parse(match[1]), sql: JSON.parse(match[2]) }));
      expect(examples).to.have.length(count);
      const db = site === "dollar"
        ? require("../services/fth-ledger/sql").createFthDb()
        : require("../services/social-ledger/social").SocialLedger.prototype.buildSql();
      try {
        for (const example of examples) {
          expect(example.title).not.to.equal("");
          expect(db.query(example.sql).columns.length).to.be.greaterThan(0);
        }
      } finally {
        db.close();
      }
    });
  }
});
