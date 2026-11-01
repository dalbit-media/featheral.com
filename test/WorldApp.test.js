const { expect } = require("chai");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "sites", "world", "app.js"), "utf8");
const account = "0x1111111111111111111111111111111111111111";

function fixture({ posts = [], failFeed = false } = {}) {
  const nodes = {};
  class Node {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.listeners = {};
      this.attributes = {};
      this.value = "";
      this.disabled = false;
      this.classList = { toggle() {} };
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    prepend(child) { this.children.unshift(child); }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, handler) { this.listeners[name] = handler; }
    dispatchEvent(event) { return this.listeners[event.type]?.(event); }
    click() { return this.disabled ? undefined : this.listeners.click?.({}) || this.onclick?.({}); }
    focus() { this.focused = true; }
    scrollIntoView() {}
    setSelectionRange() {}
    remove() {}
    querySelector(tag) { return find(this, (node) => node.tag === tag)[0] || null; }
    getContext() { return { fillRect() {} }; }
    toDataURL() { return "data:image/png;base64,AA=="; }
  }
  const find = (root, predicate) => root.children.flatMap((child) => child instanceof Node ? [...(predicate(child) ? [child] : []), ...find(child, predicate)] : []);
  const node = (id) => nodes[id] ||= new Node("div");
  const calls = [];
  let action = async () => ({ post: posts[0] });
  const window = {};
  vm.runInNewContext(`${source.slice(0, source.indexOf('  $("searchForm").addEventListener'))}
    window.test = { state, drafts, composer, showHome, showGettingStarted, loadFeed, emptyHome, focusComposer, setAction: (work) => { act = work; } };
  })();`, {
    window, ethers: require("ethers"), location: { hash: "", origin: "http://world.localhost" },
    document: { getElementById: node, createElement: (tag) => new Node(tag), querySelector: () => null, body: new Node("body") },
    setTimeout: () => 0, clearTimeout() {}, Event: class { constructor(type) { this.type = type; } },
    async fetch(url) {
      calls.push(url);
      return { ok: !failFeed, status: 503, json: async () => failFeed ? { error: "offline" } : { posts, next: 0 } };
    },
  });
  window.test.setAction((...args) => action(...args));
  return {
    ...window.test, nodes, node, calls, find,
    setAction(work) { action = work; },
    mount() {
      const box = window.test.composer();
      node("composerHost").replaceChildren(box);
      return { box, area: box.querySelector("textarea"), send: box.querySelector("button"), status: find(box, (n) => n.className === "composer-status muted fine")[0] };
    },
    input(area, text) { area.value = text; area.dispatchEvent({ type: "input" }); },
  };
}

describe("World posting experience", () => {
  it("omits repeated sidebar titles while retaining community feed tabs", async () => {
    const ui = fixture();
    ui.showGettingStarted();
    expect(ui.node("colHead").hidden).to.equal(true);
    expect(ui.node("colHead").children).to.deep.equal([]);
    await ui.showHome("all");
    expect(ui.node("colHead").hidden).to.equal(false);
    expect(ui.find(ui.node("colHead"), node => node.tag === "h1")).to.have.length(0);
    expect(ui.find(ui.node("colHead"), node => node.role === "tab")).to.have.length(2);
  });
  it("welcomes visitors without requiring a wallet or requesting gameplay funds", () => {
    const ui = fixture();
    ui.showGettingStarted();
    expect(ui.node("gettingStarted").hidden).to.equal(false);
    expect(ui.node("composerHost").children).to.have.length(0);
    expect(ui.calls).to.have.length(0);
    ui.showGettingStarted(true);
  });
  it("keeps About compatibility, feed navigation, docs and the inline optional profile on the main site", () => {
    const home = fs.readFileSync(path.join(__dirname, "..", "sites", "world", "index.html"), "utf8");
    expect(home).to.include('data-nav="start"').and.include('href="#/feed"').and.include('data-nav="guide"');
    expect(home).to.include('id="profileEditor"').and.include('Skip for now');
    expect(home).to.include('aria-label="Docs"');
    expect(source).to.include('profileRoot: $("profileEditor")');
    expect(source).to.include('if (!name || name === "setup") showGettingStarted');
    const about = fs.readFileSync(path.join(__dirname, "..", "sites", "world", "featheral", "about", "index.html"), "utf8");
    expect(about).to.include("window.location.replace('/' + window.location.search + '#/')");
  });
  it("shows three labeled examples only on an empty Home feed, with no fake interaction controls", async () => {
    const ui = fixture();
    await ui.showHome("all");
    expect(ui.find(ui.node("feed"), (n) => n.tag === "article")).to.have.length(3);
    expect(ui.find(ui.node("feed"), (n) => n.textContent === "Example post")).to.have.length(3);
    expect(ui.find(ui.node("feed"), (n) => n.className === "post-actions")).to.have.length(0);
    expect(ui.calls).to.have.length(1);
    ui.state.account = account;
    await ui.showHome("following");
    expect(ui.find(ui.node("feed"), (n) => n.tag === "article")).to.have.length(0);
  });

  it("does not replace a failed feed request with example activity", async () => {
    const ui = fixture({ failFeed: true });
    let error;
    try { await ui.showHome("all"); } catch (caught) { error = caught; }
    expect(error.message).to.equal("offline");
    expect(ui.find(ui.node("feed"), (n) => n.tag === "article")).to.have.length(0);
  });

  it("does not show examples when a real post exists", async () => {
    const ui = fixture({ posts: [{ id: `0x${"ab".repeat(32)}`, author: account, text: "Real post", timeMs: Date.now(), likes: 0, reposts: 0, replies: 0 }] });
    await ui.showHome("all");
    expect(ui.find(ui.node("feed"), (n) => n.tag === "article")).to.have.length(1);
    expect(ui.find(ui.node("feed"), (n) => n.textContent === "Example post")).to.have.length(0);
  });

  it("lets visitors draft before connecting without signing or submitting a post", async () => {
    const ui = fixture();
    let connects = 0;
    let writes = 0;
    ui.node("walletButton").onclick = () => { connects += 1; };
    ui.setAction(async () => { writes += 1; });
    const { area, send } = ui.mount();
    expect(send.disabled).to.equal(true);
    ui.input(area, "Hello World");
    expect(send.textContent).to.equal("Connect to post");
    await send.click();
    expect(connects).to.equal(1);
    expect(writes).to.equal(0);
    expect(ui.mount().area.value).to.equal("Hello World");
  });

  it("uses starter ideas only for a blank draft", () => {
    const ui = fixture();
    const { area } = ui.mount();
    ui.focusComposer("Hello, World! ");
    expect(area.value).to.equal("Hello, World! ");
    expect(area.focused).to.equal(true);
    ui.focusComposer("Replace me");
    expect(area.value).to.equal("Hello, World! ");
  });

  it("counts Unicode characters and enforces the exact 280-character limit", () => {
    const ui = fixture();
    ui.state.account = account;
    const { area, send } = ui.mount();
    ui.input(area, "😀".repeat(280));
    expect(send.disabled).to.equal(false);
    ui.input(area, "😀".repeat(281));
    expect(send.disabled).to.equal(true);
    ui.input(area, "   ");
    expect(send.disabled).to.equal(true);
  });

  it("labels the composer accessibly and supports Ctrl+Enter", async () => {
    const ui = fixture();
    ui.state.account = account;
    let writes = 0;
    ui.setAction(async () => { writes += 1; return {}; });
    const { area, box } = ui.mount();
    expect(area.attributes["aria-label"]).to.equal("Write a post");
    ui.input(area, "Keyboard post");
    expect(ui.find(box, (n) => n.className === "count")[0].attributes["aria-label"]).to.equal("13 of 280 characters");
    let prevented = false;
    area.dispatchEvent({ type: "keydown", ctrlKey: true, key: "Enter", preventDefault() { prevented = true; } });
    await new Promise(setImmediate);
    expect(prevented).to.equal(true);
    expect(writes).to.equal(1);
  });

  it("refuses to publish from a composer belonging to a previous wallet", async () => {
    const ui = fixture();
    ui.state.account = account;
    let writes = 0;
    ui.setAction(async () => { writes += 1; return {}; });
    const { area, send } = ui.mount();
    ui.input(area, "Original wallet draft");
    ui.state.account = "0x2222222222222222222222222222222222222222";
    await send.click();
    expect(writes).to.equal(0);
    expect(area.value).to.equal("Original wallet draft");
  });

  it("prevents duplicate submission while pending and clears only a successful draft", async () => {
    const ui = fixture();
    ui.state.account = account;
    let finish;
    let writes = 0;
    ui.setAction(() => { writes += 1; return new Promise((resolve) => { finish = resolve; }); });
    const { area, send, status } = ui.mount();
    ui.input(area, "New post");
    const pending = send.click();
    expect(area.disabled).to.equal(true);
    expect(send.disabled).to.equal(true);
    await send.click();
    expect(writes).to.equal(1);
    finish({});
    await pending;
    expect(area.value).to.equal("");
    expect(status.textContent).to.include("Posted");
    expect(ui.mount().area.value).to.equal("");
  });

  it("preserves a rejected post for retry and keeps wallet drafts separate", async () => {
    const ui = fixture();
    ui.state.account = account;
    ui.setAction(async () => { throw new Error("Request cancelled in your wallet."); });
    const { area, send, status } = ui.mount();
    ui.input(area, "Keep this draft");
    await send.click();
    expect(status.textContent).to.include("Your draft has been kept");
    expect(send.disabled).to.equal(false);
    expect(area.disabled).to.equal(false);
    expect(ui.mount().area.value).to.equal("Keep this draft");
    ui.state.account = "0x2222222222222222222222222222222222222222";
    expect(ui.mount().area.value).to.equal("");
  });

  it("disables posting for suspended wallets", () => {
    const ui = fixture();
    ui.state.account = account;
    ui.state.suspended = true;
    const { area, send } = ui.mount();
    ui.input(area, "Not allowed");
    expect(send.disabled).to.equal(true);
  });
});
