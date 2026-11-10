"use strict";
const crypto = require("node:crypto");
const W = require("../cms/lib/wallet");
const { SYSTEM_TREASURY_ACCOUNT } = require("../notes/game-funds");
const { walletAccountId, transferMessage } = require("../fth-ledger/transfer");
const fail = (status, message) => Object.assign(new Error(message), { status });
const SITE_COST = (500n * 10n ** 18n).toString();
const NOTE_COST = 1000;
const { Markets, isReservedMarket } = require("./markets");

class Creation {
  constructor(notes, sites) {
    this.notes = notes;
    this.sites = sites;
    this.db = notes.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS note_currencies(symbol TEXT PRIMARY KEY,name TEXT NOT NULL,owner TEXT NOT NULL,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS creation_sessions(token TEXT PRIMARY KEY,address TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS creation_challenges(address TEXT PRIMARY KEY,nonce TEXT NOT NULL,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS creation_requests(id TEXT PRIMARY KEY,owner TEXT NOT NULL,slug TEXT UNIQUE NOT NULL,payload TEXT NOT NULL,
        payment TEXT NOT NULL,signature TEXT,status TEXT NOT NULL DEFAULT 'prepared',site_key TEXT,receipt TEXT,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS site_owners(site TEXT PRIMARY KEY,owner TEXT NOT NULL,request TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS note_sites(site TEXT PRIMARY KEY,symbol TEXT NOT NULL,owner TEXT NOT NULL,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS note_mints(symbol TEXT PRIMARY KEY,request TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS note_wallet_transfers(owner TEXT NOT NULL,request TEXT NOT NULL,payload TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(owner,request));
    `);
    this.markets = new Markets(notes);
  }
  address(value) {
    if (!W.isAddress(value)) throw fail(400, "Enter a valid wallet address.");
    return W.checksum(value);
  }
  challenge(value) {
    this.db.prepare("DELETE FROM creation_sessions WHERE expires<=?").run(Date.now());
    this.db.prepare("DELETE FROM creation_challenges WHERE at<?").run(Date.now() - 600000);
    const address = this.address(value), nonce = crypto.randomBytes(24).toString("hex"), at = Date.now();
    this.db.prepare("INSERT OR REPLACE INTO creation_challenges VALUES (?,?,?)").run(address.toLowerCase(), nonce, at);
    const message = `Sign in to Featheral Notes and Sites.\n\nWallet: ${address}\nNonce: ${nonce}\nIssued: ${new Date(at).toISOString()}\n\nSigning in does not spend funds. Creating a note costs 1,000 FTHX; creating a website costs 500 FTH$. Creation requires separate confirmation.`;
    return { address, message };
  }
  login(value, signature) {
    const address = this.address(value);
    const challenge = this.db.prepare("SELECT * FROM creation_challenges WHERE address=?").get(address.toLowerCase());
    if (!challenge || Date.now() - challenge.at > 600000) throw fail(401, "Sign-in expired. Connect again.");
    const message = `Sign in to Featheral Notes and Sites.\n\nWallet: ${address}\nNonce: ${challenge.nonce}\nIssued: ${new Date(challenge.at).toISOString()}\n\nSigning in does not spend funds. Creating a note costs 1,000 FTHX; creating a website costs 500 FTH$. Creation requires separate confirmation.`;
    if (W.recoverAddress(message, signature) !== address) throw fail(401, "Invalid wallet signature.");
    this.db.prepare("DELETE FROM creation_challenges WHERE address=?").run(address.toLowerCase());
    const token = crypto.randomBytes(32).toString("hex");
    this.db.prepare("INSERT INTO creation_sessions VALUES (?,?,?)").run(token, address.toLowerCase(), Date.now() + 86400000);
    return { token, address };
  }
  owner(token) {
    const session = this.db.prepare("SELECT * FROM creation_sessions WHERE token=? AND expires>?").get(String(token || ""), Date.now());
    if (!session) throw fail(401, "Connect your wallet to continue.");
    return session.address;
  }
  trending(now = Date.now()) {
    const markets = this.markets.catalog(now, true);
    const dollar = this.dollarSupply ? this.dollarSupply() : null;
    const fthx = this.notes.fthx.summary();
    const definitions = this.db.prepare("SELECT symbol,name FROM note_currencies").all();
    const currencies = [
      { symbol: "FTH$", name: "Featheral Dollar", kind: "reserve-backed-ledger", native: true, ...dollar,
        circulating: dollar?.circulating ?? null, decimals: 18 },
      { symbol: "FTHX", name: "Featheral Exchange Token", kind: "global-credit", native: true,
        supply: fthx.supply, circulating: fthx.circulating, reserved: fthx.reserved, decimals: 18, precisionVersion: 2 },
      ...definitions.map(row => {
        const currency = { ...markets.find(market => market.symbol === row.symbol), ...row, kind: "unbacked-credit" };
        if (row.symbol !== "FTHS") return currency;
        const supply = this.db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM notes_entries WHERE symbol='FTHS'").get().n;
        if (!Number.isSafeInteger(supply) || supply < 0) throw fail(409, "Silver supply is invalid.");
        return { ...currency, native: true, kind: "approved-work-credit", alias: "Featheral Salary",
          supply: String(supply), circulating: String(supply), reserved: "0", decimals: 0 };
      }),
      ...markets.filter(market => market.placeholder && !definitions.some(note => note.symbol === market.symbol))
        .map(market => ({ ...market, kind: "unbacked-credit" })),
    ];
    const legacy = this.db.prepare("SELECT symbol FROM notes_programs UNION SELECT symbol FROM notes_entries").all();
    for (const { symbol } of legacy) if (!currencies.some(currency => currency.symbol === symbol))
      currencies.push({ symbol, name: symbol, kind: "unbacked-credit" });
    const activity = this.db.prepare(`SELECT e.symbol,COUNT(*) AS rewards,SUM(e.amount) AS awarded FROM notes_entries e
      WHERE e.kind='reaction_in' AND e.at>=? GROUP BY e.symbol`).all(now - 86400000);
    const quoteVolume = markets.reduce((sum, market) => sum + market.volume, 0);
    if (!Number.isSafeInteger(quoteVolume)) throw fail(409, "Total FTHX trading volume exceeds safe unit limits.");
    return currencies.filter(currency => !isReservedMarket(currency.symbol)).map(currency => ({ ...currency, volume: currency.symbol === "FTHX" ? quoteVolume : markets.find(market => market.symbol === currency.symbol)?.volume || 0,
      rewards: currency.native ? 0 : activity.find(row => row.symbol === currency.symbol)?.rewards || 0,
      awarded: currency.native ? 0 : activity.find(row => row.symbol === currency.symbol)?.awarded || 0 }))
      .sort((a, b) => b.volume - a.volume || a.symbol.localeCompare(b.symbol));
  }
  mintNote(owner, input) {
    if (!input?.site || typeof input.site !== "object" || Array.isArray(input.site) || input.siteKey !== undefined)
      throw fail(400, "Minting a note requires a new website (site name and slug).");
    return this.createNote(owner, input, true);
  }
  createNote(owner, input, mint = false) {
    const symbol = input?.symbol, name = input?.name;
    if (input?.siteKey !== undefined && (typeof input.siteKey !== "string" || !input.siteKey))
      throw fail(400, "Choose a valid website key or omit siteKey.");
    if (typeof symbol !== "string" || !/^[A-Z][A-Z0-9]{1,15}$/.test(symbol)
      || ["FTHX", "FTHG", "ETH", "BTC", "USD", "USDT", "USDC"].includes(symbol)
      || typeof name !== "string" || !name.trim() || name.length > 100) throw fail(400, "Use a unique 2–16 character uppercase symbol and a name (up to 100 characters). Built-in token symbols are reserved.");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT * FROM note_currencies WHERE symbol=?").get(symbol);
      if (existing) {
        if (existing.owner === owner && existing.name === name.trim()) {
          if (input.siteKey) this.linkNote(owner, input.siteKey, symbol);
          const request = mint ? this.bindMint(owner, input, symbol) : null;
          this.db.exec("COMMIT"); return mint ? { ...existing, request } : existing;
        }
        throw fail(409, "That note symbol already exists.");
      }
      if (this.db.prepare("SELECT 1 FROM notes_programs WHERE symbol=?").get(symbol)) throw fail(409, "That symbol is already used by an existing reward program.");
      if (this.db.prepare("SELECT 1 FROM note_markets WHERE symbol=?").get(symbol)) throw fail(409, "That symbol belongs to the placeholder catalog.");
      const balance = this.notes.balance(owner);
      if (!Number.isSafeInteger(balance) || balance < NOTE_COST) throw fail(402, "Creating a note requires 1,000 FTHX.");
      const treasury = this.notes.balance(SYSTEM_TREASURY_ACCOUNT);
      if (!Number.isSafeInteger(treasury + NOTE_COST)) throw fail(409, "Treasury balance exceeds safe credit limits.");
      const insert = this.db.prepare("INSERT INTO notes_entries(address,amount,kind,other,at,site) VALUES (?,?,?,?,?,'notes-creation')");
      insert.run(owner, -NOTE_COST, "note_creation_out", SYSTEM_TREASURY_ACCOUNT, Date.now());
      insert.run(SYSTEM_TREASURY_ACCOUNT, NOTE_COST, "note_creation_in", owner, Date.now());
      this.db.prepare("INSERT INTO note_currencies VALUES (?,?,?,?)").run(symbol, name.trim(), owner, Date.now());
      if (input.siteKey) this.linkNote(owner, input.siteKey, symbol);
      const request = mint ? this.bindMint(owner, input, symbol) : null;
      this.db.exec("COMMIT");
      const note = this.db.prepare("SELECT * FROM note_currencies WHERE symbol=?").get(symbol);
      return mint ? { ...note, request } : note;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  bindMint(owner, input, symbol) {
    const bound = this.db.prepare("SELECT request FROM note_mints WHERE symbol=?").get(symbol);
    if (bound) {
      const row = this.db.prepare("SELECT * FROM creation_requests WHERE id=?").get(bound.request);
      const payload = JSON.parse(row.payload);
      if (row.owner !== owner || payload.slug !== input.site.slug || payload.name !== input.site.name?.trim())
        throw fail(409, "This note is bound to its original website request. Resume that request.");
    }
    const request = this.prepareSite(owner, { slug: input.site.slug, name: input.site.name, noteSymbol: symbol });
    this.db.prepare("INSERT OR IGNORE INTO note_mints VALUES (?,?)").run(symbol, request.id);
    return request;
  }
  requireSite(owner, key) {
    if (typeof key !== "string" || !key) throw fail(400, "Choose a valid website key.");
    if (this.db.prepare("SELECT owner FROM site_owners WHERE site=?").get(key)?.owner !== owner) throw fail(403, "You can manage only your own websites.");
    const site = this.sites.list().find(site => site.key === key);
    if (!site) throw fail(404, "Your website registration is missing. Contact the administrator for recovery.");
    return site;
  }
  requireNote(owner, symbol) {
    if (typeof symbol !== "string" || this.db.prepare("SELECT owner FROM note_currencies WHERE symbol=?").get(symbol)?.owner !== owner)
      throw fail(403, "Choose a community note owned by your wallet.");
  }
  sendNote(owner, input) {
    const to = this.address(input?.to).toLowerCase(), { symbol, amount, requestId } = input || {};
    const purpose = input?.purpose;
    if (purpose !== undefined && purpose !== "tip") throw fail(400, "Choose a supported transfer purpose.");
    if (purpose === "tip" && symbol !== "FTHX") throw fail(400, "Thanks tips use FTHX.");
    if (to === owner || to === require('ethers').ethers.ZeroAddress.toLowerCase()) throw fail(400, "Choose another wallet.");
    if (typeof symbol !== "string" || symbol === "FTH$") throw fail(400, "Use the Dollar transfer API for FTH$.");
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1000000000) throw fail(400, "Send a whole-note amount from 1 to 1,000,000,000.");
    if (typeof requestId !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(requestId)) throw fail(400, "A unique transfer request ID is required.");
    const payload = JSON.stringify({ to, symbol, amount, ...(purpose ? { purpose } : {}) });
    return this.markets.atomic(() => {
      const existing = this.db.prepare("SELECT payload FROM note_wallet_transfers WHERE owner=? AND request=?").get(owner, requestId);
      if (existing) {
        if (existing.payload !== payload) throw fail(409, "Transfer request ID already used with different parameters.");
        return { to, symbol, amount, requestId, ...(purpose ? { purpose } : {}) };
      }
      this.markets.requireUnlocked();
      if (this.notes.balance(owner, symbol) < amount) throw fail(402, `Insufficient ${symbol}.`);
      const insert = this.db.prepare("INSERT INTO notes_entries(address,amount,kind,other,at,site,symbol) VALUES (?,?,?,?,?,'notes-wallet',?)");
      insert.run(owner, -amount, purpose === "tip" ? "wallet_tip_out" : "wallet_note_out", to, Date.now(), symbol);
      insert.run(to, amount, purpose === "tip" ? "wallet_tip_in" : "wallet_note_in", owner, Date.now(), symbol);
      this.db.prepare("INSERT INTO note_wallet_transfers VALUES (?,?,?,?)").run(owner, requestId, payload, Date.now());
      return { to, symbol, amount, requestId, ...(purpose ? { purpose } : {}) };
    });
  }
  // Called inside the caller's transaction so the link and reward configuration commit together.
  linkNote(owner, key, symbol) {
    this.requireSite(owner, key);
    this.requireNote(owner, symbol);
    const current = this.db.prepare("SELECT * FROM note_sites WHERE site=?").get(key);
    if (current?.symbol === symbol) return current;
    this.notes.setProgram(key, { symbol, chance: 10, amount: 1, enabled: false });
    this.db.prepare("INSERT INTO note_sites VALUES (?,?,?,?) ON CONFLICT(site) DO UPDATE SET symbol=excluded.symbol,owner=excluded.owner,at=excluded.at")
      .run(key, symbol, owner, Date.now());
    return this.db.prepare("SELECT * FROM note_sites WHERE site=?").get(key);
  }
  integrate(owner, key, symbol) {
    return this.markets.atomic(() => this.linkNote(owner, key, symbol));
  }
  prepareSite(owner, input) {
    if (!this.payment) throw fail(503, "Website payments require the Featheral Dollar writer.");
    const slug = input?.slug, name = input?.name;
    if (typeof slug !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)
      || ["api", "site", "shared", "media", "admin", "operations", "healthz"].includes(slug)
      || typeof name !== "string" || !name.trim() || name.length > 100) throw fail(400, "Choose a lowercase website address and display name (up to 100 characters).");
    if (input.noteSymbol !== undefined) this.requireNote(owner, input.noteSymbol);
    const payload = JSON.stringify({ hostname: "sites.featheral.com", slug, name: name.trim(), template: "website",
      ...(input.noteSymbol ? { noteSymbol: input.noteSymbol } : {}) });
    const existing = this.db.prepare("SELECT * FROM creation_requests WHERE slug=?").get(slug);
    if (existing) {
      if (existing.owner !== owner || existing.payload !== payload) throw fail(409, "That website address is already reserved.");
      if (existing.status !== "complete" && this.payment.conflict(JSON.parse(existing.payment))) {
        // A different sealed/pending transfer consumed this nonce, so the old signature
        // cannot debit it. Only then is it safe to issue a new payment for this request.
        const payment = JSON.parse(existing.payment);
        payment.nonce = this.payment.nonce(walletAccountId(owner)) + 1;
        payment.issuedAt = new Date().toISOString();
        this.db.prepare("UPDATE creation_requests SET payment=?,signature=NULL WHERE id=?").run(JSON.stringify(payment), existing.id);
        return this.requestView(this.db.prepare("SELECT * FROM creation_requests WHERE id=?").get(existing.id));
      }
      return this.requestView(existing);
    }
    if (this.sites.records.some(site => site.path === `/${slug}`)) throw fail(409, "That website address already exists.");
    if (this.db.prepare("SELECT COUNT(*) AS n FROM creation_requests WHERE owner=? AND status!='complete'").get(owner).n >= 3)
      throw fail(409, "Finish your pending website requests before reserving another address.");
    const account = walletAccountId(owner), balance = this.payment.balance(account);
    if (BigInt(balance.available) < BigInt(SITE_COST)) throw fail(402, "Creating a website requires 500 FTH$ in your real Dollar wallet (not demo funds).");
    const id = crypto.randomUUID();
    const payment = { wallet: this.address(owner), to: SYSTEM_TREASURY_ACCOUNT, amount: SITE_COST,
      nonce: this.payment.nonce(account) + 1, memo: `site:${id}`, issuedAt: new Date().toISOString() };
    this.db.prepare("INSERT INTO creation_requests(id,owner,slug,payload,payment,at) VALUES (?,?,?,?,?,?)")
      .run(id, owner, slug, payload, JSON.stringify(payment), Date.now());
    return this.requestView(this.db.prepare("SELECT * FROM creation_requests WHERE id=?").get(id));
  }
  requestView(row) {
    const payment = JSON.parse(row.payment);
    return { id: row.id, slug: row.slug, name: JSON.parse(row.payload).name, noteSymbol: JSON.parse(row.payload).noteSymbol || null,
      status: row.status, siteKey: row.site_key, payment, message: transferMessage(payment) };
  }
  async completeSite(owner, id, signature) {
    let row = this.db.prepare("SELECT * FROM creation_requests WHERE id=? AND owner=?").get(id, owner);
    if (!row) throw fail(404, "Website creation request not found.");
    if (row.status === "complete") return this.sites.list().find(site => site.key === row.site_key);
    if (!this.payment) throw fail(503, "Website payments require the Featheral Dollar writer.");
    const payment = { ...JSON.parse(row.payment), signature: row.signature || signature };
    const verified = this.payment.verify(payment);
    if (verified.wallet.toLowerCase() !== owner) throw fail(403, "Payment must be signed by the website owner.");
    if (!row.signature) this.db.prepare("UPDATE creation_requests SET signature=? WHERE id=?").run(signature, id);
    const receipt = await this.payment.submit(payment);
    // The signed transfer is idempotent in the Dollar ledger. A persisted request binds its
    // memo and recipient to this exact site; retry completes provisioning without another debit.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      row = this.db.prepare("SELECT * FROM creation_requests WHERE id=?").get(id);
      const key = `sites-featheral-com--${row.slug}`;
      let created = this.sites.list().find(site => site.key === key);
      if (!created) created = this.sites.create(JSON.parse(row.payload));
      const existingOwner = this.db.prepare("SELECT * FROM site_owners WHERE site=?").get(key);
      if (existingOwner && (existingOwner.owner !== owner || existingOwner.request !== id))
        throw fail(409, "This website has a different owner. The paid request needs administrator recovery.");
      const payload = JSON.parse(row.payload);
      if (created.hostname !== payload.hostname || created.path !== `/${payload.slug}` || created.name !== payload.name)
        throw fail(409, "The reserved website conflicts with a restored registration. The paid request needs administrator recovery.");
      this.db.prepare("INSERT OR IGNORE INTO site_owners VALUES (?,?,?)").run(key, owner, id);
      if (payload.noteSymbol) this.linkNote(owner, key, payload.noteSymbol);
      if (payload.noteSymbol) this.db.prepare("INSERT OR IGNORE INTO note_markets(symbol) VALUES (?)").run(payload.noteSymbol);
      this.db.prepare("UPDATE creation_requests SET status='complete',site_key=?,receipt=? WHERE id=?").run(key, JSON.stringify(receipt), id);
      this.db.exec("COMMIT");
      return created;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  account(owner) {
    const fthx = this.notes.fthx.view(owner);
    const holdings = this.db.prepare("SELECT symbol,SUM(amount) AS balance FROM notes_entries WHERE address=? GROUP BY symbol HAVING SUM(amount)>0").all(owner);
    const token = holdings.find(asset => asset.symbol === "FTHX");
    if (token) Object.assign(token, { baseBalance: fthx.balance, decimals: 18 });
    else if (BigInt(fthx.balance) > 0n) holdings.push({ symbol: "FTHX", balance: 0, baseBalance: fthx.balance, decimals: 18 });
    return { address: owner, fthx: this.notes.balance(owner),
      fthxExact: fthx, holdings,
      dollar: this.payment ? this.payment.balance(walletAccountId(owner)) : null,
      notes: this.db.prepare("SELECT symbol,name FROM note_currencies WHERE owner=?").all(owner),
      integrations: this.db.prepare("SELECT site,symbol FROM note_sites WHERE owner=?").all(owner),
      sites: this.sites.list().filter(site => this.db.prepare("SELECT owner FROM site_owners WHERE site=?").get(site.key)?.owner === owner),
      requests: this.db.prepare("SELECT * FROM creation_requests WHERE owner=? AND status!='complete'").all(owner).map(row => this.requestView(row)),
      noteCost: NOTE_COST, siteCost: "500", treasury: SYSTEM_TREASURY_ACCOUNT };
  }
  async recover() {
    for (const row of this.db.prepare("SELECT * FROM creation_requests WHERE signature IS NOT NULL AND status!='complete'").all()) {
      try { await this.completeSite(row.owner, row.id, row.signature); }
      catch (error) { console.error(`Website creation ${row.id} needs retry: ${error.message}`); }
    }
  }
}
module.exports = { Creation, NOTE_COST, SITE_COST };
