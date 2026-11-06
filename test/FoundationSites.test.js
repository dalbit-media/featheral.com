const { expect } = require("chai");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

describe("Foundation managed-site gateway", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "scripts", "serve.js"), "utf8");
  const handlerSource = source.slice(source.indexOf("const server = http.createServer"), source.indexOf("\nasync function start()"));
  const siteFor = vm.runInNewContext(source.slice(source.indexOf("const SITES ="), source.indexOf("const cms ="))
    + source.slice(source.indexOf("function siteFor("), source.indexOf("// gold.featheral.com")) + ";siteFor");

  function fixture(claimDollar = false, claimGold = false) {
    let handler;
    const calls = [];
    const cms = (req) => calls.push(["cms", req.url]);
    cms.walletSummary = async address => { calls.push(["wallet-summary", address]); return { address, holdings: [] }; };
    cms.resolveHostname = (host) => ["admin.featheral.com", "x.featheral.com", "ex.featheral.com", "news.featheral.com", "news.localhost"].includes(host);
    cms.renderSitePage = (hostname, file) => { calls.push(["static", path.join(__dirname, "..", "sites", hostname, file)]); return "page"; };
    cms.hasSitePage = (hostname, file) => file === "index.html" || file === "docs/index.html"
      || hostname === "featheral.com" && file === "governance/index.html";
    const handle = (name) => ({ handle: async () => { calls.push([name]); return name === "dollar" && claimDollar || name === "gold" && claimGold; } });
    vm.runInNewContext(handlerSource, {
      URL, console, path, require: name => name === "./site-routing" ? require("../scripts/site-routing") : require(name),
      requestPolicy: () => true, gameApi: null, dollarGameApi: null, deploymentManifest: null,
      injectTelemetry() {},
      http: { createServer: (fn) => { handler = fn; } },
      siteFor,
      siteUrl: (req, site, pathname) => `http://${site}.localhost:8080${pathname}`,
      redirect: (res, url, status) => calls.push(["redirect", url, status]),
      cms, gold: handle("gold"), world: handle("world"), api: handle("dollar"),
      pay: require("../services/pay/server").createPayApi({ siteUrl: (req, site, pathname) => `http://${site}.localhost:8080${pathname}` }),
      sitesRoot: path.join(__dirname, "..", "sites"),
      root: path.join(__dirname, ".."),
      fs: { existsSync: fs.existsSync, statSync: fs.statSync, readFileSync: file => { calls.push(["static", file]); return "wallet"; },
        promises: { stat: file => fs.promises.stat(file), readFile: async file => { calls.push(["static", file]); return Buffer.from("page"); } },
        readFile: (file, callback) => { calls.push(["static", file]); callback(null, Buffer.from("page")); } },
      types: { ".html": "text/html" },
    });
    const request = async (host, url = "/", headers = {}, method = "GET") => {
      await handler({ method, url, headers: { host, ...headers } }, { setHeader() {}, writeHead(status) { if (status >= 400) calls.push(["status", status]); }, end() {} });
      return calls;
    };
    return { request };
  }

  it("dispatches CMS/public APIs before the unrelated ledger handlers", async () => {
    for (const host of ["admin.featheral.com", "x.featheral.com", "ex.featheral.com", "admin.localhost:8080", "x.localhost:8080", "ex.localhost:8080", "news.featheral.com", "news.localhost:8080"]) {
      expect(await fixture().request(host, "/api/public/info")).to.deep.equal([["cms", "/api/public/info"]]);
    }
  });
  it("isolates the staged DB host from public writes and serves its own landing page", async () => {
    expect(siteFor("db.localhost")).to.equal("db");
    expect(await fixture().request("db.localhost:8080", "/api/v1/db/status")).to.deep.equal([["cms", "/api/v1/db/status"]]);
    for (const route of ["/api/database", "/api/v1/gold/rpc", "/api/v1/notes/fth/transfers"])
      expect(await fixture().request("db.localhost:8080", route, {}, "POST")).to.deep.equal([["status", 404]]);
    expect(await fixture().request("db.localhost:8080")).to.deep.equal([["static", path.join(__dirname, "..", "sites", "db.featheral.com", "index.html")]]);
  });
  it("serves the dedicated currency ledger site", async () => {
    expect(siteFor("ledger.localhost")).to.equal("ledger");
    expect(await fixture().request("ledger.localhost:8080")).to.deep.equal([
      ["static", path.join(__dirname, "..", "sites", "ledger.featheral.com", "index.html")],
    ]);
  });
  it("serves Pay independently of CMS and rejects unrelated financial API writes", async () => {
    expect(siteFor("pay.localhost")).to.equal("pay");
    expect(await fixture().request("pay.localhost:8080")).to.deep.equal([
      ["static", path.join(__dirname, "..", "sites", "pay.featheral.com", "index.html")],
    ]);
    expect(await fixture().request("pay.localhost:8080", "/api/v1/notes/fth/transfers", {}, "POST")).to.deep.equal([["status", 404]]);
    expect(await fixture().request("pay.localhost:8080", "/api/v1/pay/requests?to=invalid")).to.deep.equal([["status", 400]]);
    expect(await fixture().request("pay.localhost:8080", "/api/v1/pay/requests?to=0x" + "11".repeat(20))).to.deep.equal([]);
  });
  it("serves the FTH$ explorer on Ledger and redirects legacy Dollar explorer URLs", async () => {
    const explorer = await fixture().request("ledger.localhost:8080", "/explorer/");
    expect(explorer.at(-1)).to.deep.equal([
      "static", path.join(__dirname, "..", "sites", "dollar.featheral.com", "explorer", "index.html"),
    ]);
    const helper = await fixture().request("ledger.localhost:8080", "/fth.js");
    expect(helper.at(-1)).to.deep.equal(["static", path.join(__dirname, "..", "sites", "dollar.featheral.com", "fth.js")]);
    const notesExplorer = await fixture().request("ledger.localhost:8080", "/notes-explorer.js");
    expect(notesExplorer.at(-1)).to.deep.equal(["static", path.join(__dirname, "..", "sites", "ledger.featheral.com", "notes-explorer.js")]);
    expect(await fixture().request("ledger.localhost:8080", "/missing/")).to.deep.equal([["status", 404]]);
    expect(await fixture().request("ledger.localhost:8080", "/explorer"))
      .to.deep.equal([["redirect", "http://ledger.localhost:8080/explorer/", 301]]);
    const legacy = await fixture().request("dollar.localhost:8080", "/explorer/");
    expect(legacy.at(-1)).to.deep.equal(["redirect", "http://ledger.localhost:8080/explorer/", 301]);
    expect(await fixture().request("ledger.localhost:8080", "/api/notes/ledger/currencies"))
      .to.deep.equal([["cms", "/api/notes/ledger/currencies"]]);
  });
  it("redirects the retired CMS host and all product admin routes to unified administration", async () => {
    expect(await fixture().request("cms.localhost:8080", "/?site=example")).to.deep.equal([
      ["redirect", "http://admin.localhost:8080/?site=example", 301],
    ]);
    for (const [host, site] of [["localhost:8080", "foundation"], ["gold.localhost:8080", "gold"],
      ["dollar.localhost:8080", "dollar"], ["world.localhost:8080", "world"]]) {
      for (const pathname of ["/admin", "/admin/", "/admin/index.html"]) {
        expect(await fixture().request(host, pathname)).to.deep.equal([
          ["redirect", `http://admin.localhost:8080/#/operations/${site}`, 301],
        ]);
      }
    }
  });

  it("preserves static sites, ledger dispatch and the unknown-host foundation fallback", async () => {
    for (const [host, site] of [["localhost:8080", "foundation"], ["gold.featheral.com", "gold"], ["dollar.localhost:8080", "dollar"], ["world.featheral.com", "world"], ["unknown.example", "foundation"]]) {
      const calls = await fixture().request(host);
      expect(calls.slice(0, 3)).to.deep.equal([["gold"], ["world"], ["dollar"]]);
      expect(calls[3]).to.deep.equal(["static", path.join(__dirname, "..", "sites", site === "foundation" ? "featheral.com" : `${site}.featheral.com`, ...(site === "world" ? ["play", "dist", "index.html"] : ["index.html"]))]);
    }
  });
  it("serves shared assets outside sites and the relocated World play build", async () => {
    for (const [url, expected] of [
      ["/shared/site-links.js", path.join("shared", "site-links.js")],
      ["/explore/", path.join("sites", "world.featheral.com", "play", "dist", "explore", "index.html")],
    ]) {
      const calls = await fixture().request("world.featheral.com", url);
      expect(calls[3]).to.deep.equal(["static", path.join(__dirname, "..", expected)]);
    }
  });
  it("moves social pages to Media and preserves legacy game paths and query strings", async () => {
    for (const [route, destination] of [
      ["/play/?lang=en", "http://world.localhost:8080/explore/?lang=en"],
      ["/play/settlement/?tab=storage", "http://world.localhost:8080/settlement/?tab=storage"],
      ["/ledger/?post=abc", "http://media.localhost:8080/ledger/?post=abc"],
      ["/about/", "http://world.localhost:8080/"],
    ]) expect((await fixture().request("world.localhost:8080", route)).at(-1)).to.deep.equal(["redirect", destination, 301]);
    expect((await fixture().request("media.localhost:8080", "/docs/?lang=en")).at(-1))
      .to.deep.equal(["redirect", "http://media.localhost:8080/?lang=en#/guide", 301]);
    expect((await fixture().request("media.localhost:8080")).at(-1))
      .to.deep.equal(["static", path.join(__dirname, "..", "sites", "media.featheral.com", "index.html")]);
  });
  it("keeps the original Dollar landing page and serves the standalone wallet only at wallet routes", async () => {
    const rootCalls = await fixture().request("dollar.localhost:8080", "/");
    expect(rootCalls[3]).to.deep.equal(["static", path.join(__dirname, "..", "sites", "dollar.featheral.com", "index.html")]);
    for (const site of ["dollar", "ex", "notes", "gold", "world"]) {
      for (const route of ["/wallet", "/wallet/"]) {
        const calls = await fixture().request(`${site}.localhost:8080`, route);
        expect(calls).to.deep.equal([["static", path.join(__dirname, "..", "sites", "wallet.featheral.com", "host.html")]]);
      }
    }
    const wallet = fs.readFileSync(path.join(__dirname, "..", "sites", "wallet.featheral.com", "wallet-app.html"), "utf8");
    for (const site of ["foundation", "gold", "dollar", "world"]) expect(wallet).to.include(`data-site="${site}"`);
    expect(wallet).to.include('/shared/site-links.js');
    for (const route of ["/", "/explorer/", "/docs/"]) expect(wallet).to.include(`href="${route}"`);
  });
  it("routes native Dollar transfers on each network wallet host without hitting protected CMS APIs", async () => {
    for (const site of ["dollar", "ex", "notes", "wallet"]) {
      expect(await fixture(true).request(`${site}.localhost:8080`, "/api/v1/dollar/fth/transfers")).to.deep.equal([["dollar"]]);
      expect(await fixture().request(`${site}.localhost:8080`, "/api/creation/wallet")).to.deep.equal([["cms", "/api/creation/wallet"]]);
    }
  });
  it("routes canonical Note chain operations across every public site without protected CMS dispatch", async () => {
    for (const site of ["foundation", "gold", "dollar", "ex", "notes", "wallet", "world", "x", "sites", "stats"]) {
      expect(await fixture(true).request(`${site}.localhost:8080`, "/api/v1/notes/fth/transfers", {}, "POST")).to.deep.equal([["dollar"]]);
    }
    expect(await fixture(true).request("notes.localhost:8080", "/api/v1/fth/stats")).to.deep.equal([["dollar"]]);
  });
  it("uses only the Gold handler for Ethereum aliases on every public site", async () => {
    for (const site of ["foundation", "gold", "dollar", "ex", "notes", "wallet", "world", "x", "sites", "stats"]) {
      expect(await fixture(false, true).request(`${site}.localhost:8080`, "/api/v1/gold/rpc", {}, "POST")).to.deep.equal([["gold"]]);
    }
    expect(await fixture(false, true).request("admin.localhost:8080", "/api/v1/gold/reserve/reconcile", {}, "POST")).to.deep.equal([
      ["cms", "/api/v1/gold/reserve/reconcile"],
    ]);
  });
  it("loads Foundation and Gold profile UX from the central wallet without replacing their pages", async () => {
    for (const host of ["localhost:8080", "gold.localhost:8080"]) {
      for (const file of ["wallet-profile.js", "wallet-profile.css"]) {
        expect(await fixture().request(host, `/shared/${file}`)).to.deep.equal([
          ["redirect", `http://wallet.localhost:8080/shared/${file}`, 302],
        ]);
      }
    }
    expect(await fixture().request("wallet.localhost:8080", "/shared/wallet-profile.js")).to.deep.equal([
      ["static", path.join(__dirname, "..", "sites", "wallet.featheral.com", "wallet-profile.js")],
    ]);
  });
  it("exposes only public read-only account summaries to approved network origins", async () => {
    const address = "0x1111111111111111111111111111111111111111", route = `/api/wallet/accounts/${address}`;
    for (const origin of ["http://localhost:8080", "http://gold.localhost:8080", "https://featheral.com"]) {
      expect(await fixture().request("wallet.localhost:8080", route, { origin })).to.deep.equal([["wallet-summary", address]]);
    }
    expect(await fixture().request("wallet.localhost:8080", route, { origin: "https://evil.example" })).to.deep.equal([["status", 403]]);
    expect(await fixture().request("wallet.localhost:8080", "/api/wallet/accounts/invalid")).to.deep.equal([["status", 400]]);
    expect(await fixture().request("wallet.localhost:8080", route, {}, "POST")).to.deep.equal([["status", 400]]);
  });
  it("renders all migrated documents through CMS at their original public URLs", async () => {
    for (const [host, paths] of [["localhost:8080", ["/", "/docs/", "/governance/"]],
      ["gold.localhost:8080", ["/", "/docs/"]], ["dollar.localhost:8080", ["/", "/docs/"]]]) {
      for (const url of paths) {
        const calls = await fixture().request(host, url);
        expect(calls[3][1]).to.equal(path.join(__dirname, "..", "sites",
          host.startsWith("gold") ? "gold.featheral.com" : host.startsWith("dollar") ? "dollar.featheral.com" : "featheral.com",
          url === "/" ? "index.html" : url.slice(1) + "index.html"));
      }
    }
    expect(await fixture().request("gold.localhost:8080", "/governance/")).to.deep.equal([["gold"], ["world"], ["dollar"], ["status", 404]]);
  });
});

describe("Foundation cross-site links", () => {
  function fixture(origin) {
    const location = new URL(origin);
    const links = ["foundation", "gold", "dollar", "world"].map((site) => ({
      dataset: { site }, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; },
      remove() { links.splice(links.indexOf(this), 1); },
    }));
    const bar = {
      querySelectorAll: () => [...links], setAttribute() {},
      querySelector(selector) { return selector === ".eco-toggle" ? this.toggle : links.find((link) => selector.includes(`"${link.dataset.site}"`)); },
      append(link) { links.push(link); },
      prepend(toggle) { this.toggle = toggle; },
      addEventListener() {},
      classList: {
        open: false,
        toggle() { this.open = !this.open; return this.open; },
        remove() { this.open = false; },
      },
    };
    const document = {
      body: { dataset: { embedded: "true" } },
      head: { append() {} }, querySelector(selector) { return selector === ".eco-bar" ? bar : null; }, addEventListener() {},
      readyState: "complete",
      querySelectorAll(selector) { return selector === ".eco-bar" ? [bar] : selector === "a[data-site]" ? links : []; },
      createElement() { return { dataset: {}, attributes: {}, listeners: {}, addEventListener(name, listener) { this.listeners[name] = listener; }, setAttribute(name, value) { this.attributes[name] = value; } }; },
    };
    const window = { location };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "shared", "site-links.js"), "utf8"), { window, document, URL });
    return { sites: window.FeatheralSites, links, bar };
  }

  it("restricts shared title navigation to the current currency while preserving host roots", () => {
    for (const [origin, expected] of [["http://admin.localhost:8080/", "http://ex.localhost:8080/"], ["https://x.featheral.com/", "https://ex.featheral.com/"], ["http://127.0.0.1:8080/", "http://ex.localhost:8080/"]]) {
      const { sites, links } = fixture(origin);
      expect(sites.url("ex")).to.equal(expected);
      const expectedSites = sites.SITES.filter(site => site === sites.current || sites.currencies[sites.current] && sites.currencies[site] === sites.currencies[sites.current]);
      expect(links.map(link => link.dataset.site).sort()).to.deep.equal([...expectedSites].sort());
      sites.apply();
      expect(links).to.have.length(expectedSites.length);
    }
  });

  it("marks the current new site and returns to the foundation base host", () => {
    const { sites, links } = fixture("http://admin.localhost:8080/");
    expect(sites.current).to.equal("admin");
    expect(sites.url("foundation")).to.equal("http://localhost:8080/");
    expect(links.find((link) => link.dataset.site === "admin").attributes["aria-current"]).to.equal("page");
  });
  it("includes Notes, Sites, Stats and Database with correct host roots without a mobile header toggle", () => {
    for (const site of ["notes", "sites", "stats", "db"]) {
      const { sites, links, bar } = fixture(`http://${site}.localhost:8080/`);
      expect(sites.current).to.equal(site);
      expect(sites.url("foundation")).to.equal("http://localhost:8080/");
      expect(links.find(link => link.dataset.site === site).attributes["aria-current"]).to.equal("page");
      expect(bar.toggle).to.equal(undefined);
      sites.apply();
      expect(links.every(link => link.dataset.site === site || sites.currencies[site] && sites.currencies[link.dataset.site] === sites.currencies[site])).to.equal(true);
    }
  });
  it("points legacy CMS links and product admin deep links directly to the unified host", () => {
    const { sites } = fixture("http://gold.localhost:8080/");
    expect(sites.url("cms")).to.equal("http://admin.localhost:8080/");
    expect(sites.url("dollar", "/admin/#liquidity")).to.equal("http://admin.localhost:8080/#/operations/dollar?tab=liquidity");
  });
  it("removes existing public admin navigation without disabling direct administration URLs", () => {
    const links = [
      { dataset: { site: "admin" } },
      { dataset: {}, getAttribute: () => "/admin/" },
      { dataset: {}, getAttribute: () => "https://admin.featheral.com/" },
      { dataset: {}, getAttribute: () => "/docs/" },
    ];
    for (const link of links) link.remove = () => { link.removed = true; };
    const document = { readyState: "complete", body: { dataset: { embedded: "true" } }, addEventListener() {}, head: { append() {} }, querySelector() { return null; }, createElement() { return { dataset: {} }; }, querySelectorAll: selector => selector === 'header nav a, .eco-bar a' ? links : [] };
    const window = { location: new URL("https://gold.featheral.com/") };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "shared", "site-links.js"), "utf8"), { window, document, URL });
    expect(links.map(link => !!link.removed)).to.deep.equal([true, true, true, false]);
  });
});
