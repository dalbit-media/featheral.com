const { strict: assert } = require("node:assert");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

const source = readFileSync(join(__dirname, "wallet-profile.js"), "utf8");

class Node {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.listeners = {};
    this.classes = new Set();
    this.classList = {
      toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name),
      contains: name => this.classes.has(name),
    };
  }
  append(...nodes) { this.children.push(...nodes); }
  prepend(node) { node.parent = this; this.children.unshift(node); }
  replaceChildren(...nodes) { this.children = nodes; }
  remove() { this.parent.children = this.parent.children.filter(node => node !== this); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  contains(node) { return node === this || this.children.some(child => child instanceof Node && child.contains(node)); }
  closest() { return null; }
  focus() { this.focused = true; }
  querySelector(selector) {
    const matches = node => selector === "button" ? node.tag === "button"
      : selector === "img.wp-avatar" ? node.tag === "img" && node.className === "wp-avatar"
        : selector.startsWith(".") ? node.className === selector.slice(1) : false;
    for (const child of this.children) {
      if (!(child instanceof Node)) continue;
      if (matches(child)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
}

function harness(options = {}, runtime = {}) {
  const body = new Node("body"), button = new Node("button");
  button.setAttribute("aria-label", "Custom admin wallet action");
  const events = {};
  const windowEvents = {}, channels = [];
  const document = {
    body, cookie: "",
    createElement: tag => {
      const node = new Node(tag);
      if (tag === "canvas") {
        node.getContext = () => ({ fillRect() {} });
        node.toDataURL = () => "data:image/png;base64,avatar";
      }
      return node;
    },
    addEventListener: (name, handler) => { events[name] = handler; },
    removeEventListener: name => { delete events[name]; },
  };
  const window = {
    addEventListener: (name, handler) => { windowEvents[name] = handler; }, dispatchEvent() {},
    location: { hostname: "world.localhost", pathname: "/", protocol: "http:" },
    ethereum: { request: async ({ method }) => method === "eth_chainId" ? "0x1" : [] },
  };
  runInNewContext(source, {
    document, window, location: window.location,
    alert: message => { throw new Error(message); },
    localStorage: { getItem: () => null, setItem() {} },
    Event: class {}, CustomEvent: class {},
    BroadcastChannel: class {
      constructor(name) { this.name = name; channels.push(this); }
      postMessage(value) { this.lastMessage = value; }
    },
    fetch: async url => ({
      ok: true,
      json: async () => url.startsWith("https:") ? { result: "0x0" }
        : url.includes("/wallets/") ? { gameAccountId: "test-account", fthDollar: { balance: "0", reserved: "0" } }
          : url.includes("/moderation") ? { moderators: [] } : { profile: runtime.profile || null },
    }),
  });
  window.FeatheralProfile.mount(button, options);
  return { button, body, events, windowEvents, channels, profile: window.FeatheralProfile };
}

test("disconnected headers mount only one wallet/avatar button, never a balance chip", () => {
  const { button, body } = harness();
  assert.match(button.innerHTML, /wp-avatar-icon/);
  assert.equal(button.attributes["aria-haspopup"], "dialog");
  assert.equal(button.attributes["aria-expanded"], "false");
  assert.match(button.attributes["aria-label"], /Connect wallet/);
  assert.equal(body.children.length, 2);
  assert.ok(body.children.every(node => node.tag === "div" && node.hidden));
  assert.doesNotMatch(source, /wp-chip|\bchip\b/);
});

test("the same connected avatar opens the profile menu and Escape closes it", async () => {
  const { button, body, events, profile } = harness();
  await new Promise(setImmediate);
  await profile.setAccount(`0x${"1".repeat(40)}`);
  assert.ok(button.classList.contains("has-avatar"));
  assert.ok(button.querySelector("img.wp-avatar"));
  assert.equal(body.children.length, 2);
  await button.listeners.click();
  assert.equal(body.children[0].hidden, false);
  assert.equal(button.attributes["aria-expanded"], "true");
  assert.ok(body.children[0].querySelector(".wp-balances"));
  assert.ok(body.children[0].querySelector(".wp-disconnect"));
  events.keydown({ key: "Escape" });
  assert.equal(body.children[0].hidden, true);
  assert.equal(button.focused, true);
  await profile.setAccount("");
  assert.equal(button.querySelector("img.wp-avatar"), null);
  assert.equal(button.classList.contains("has-avatar"), false);
  assert.equal(button.attributes["aria-expanded"], "false");
  assert.equal(events.keydown, undefined);
});

test("custom admin wallet actions retain their accessible labels", () => {
  const { button } = harness({ onConnect() {} });
  assert.equal(button.attributes["aria-label"], "Custom admin wallet action");
  assert.match(button.innerHTML, /wp-avatar-icon/);
  assert.equal(button.attributes["aria-haspopup"], "dialog");
});

test("Play can mount the canonical profile menu inside its top-layer account dialog", async () => {
  const dialog = new Node("dialog"), { body, profile, button } = harness({ panelRoot: dialog });
  assert.equal(body.children.length, 0);
  assert.equal(dialog.children.length, 2);
  await new Promise(setImmediate);
  await profile.setAccount(`0x${"1".repeat(40)}`);
  await button.listeners.click();
  assert.equal(dialog.children[0].hidden, false);
});

test("World profile changes refresh on focus and popup broadcasts; disconnect propagates without rebroadcast loops", async () => {
  const runtime = { profile: { username: "First.World", avatar: "data:image/png;base64,first" } };
  const { button, profile, windowEvents, channels } = harness({}, runtime);
  await new Promise(setImmediate);
  await profile.setAccount(`0x${"1".repeat(40)}`);
  assert.equal(profile.snapshot().profile.username, "First.World");
  runtime.profile = { username: "Updated.World", avatar: "data:image/png;base64,updated" };
  await windowEvents.focus();
  assert.equal(profile.snapshot().profile.username, "Updated.World");
  assert.equal(button.querySelector("img.wp-avatar").src, runtime.profile.avatar);
  runtime.profile = { username: "Popup.World", avatar: "data:image/png;base64,popup" };
  await channels[0].onmessage({ data: { type: "profile" } });
  assert.equal(profile.snapshot().profile.username, "Popup.World");
  assert.equal(channels[0].lastMessage, undefined);
  await profile.disconnect();
  assert.equal(channels[0].lastMessage.type, "disconnect");
  channels[0].lastMessage = undefined;
  await channels[0].onmessage({ data: { type: "disconnect" } });
  assert.equal(profile.snapshot().account, "");
  assert.equal(channels[0].lastMessage, undefined);
});
