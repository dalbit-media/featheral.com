"use strict";
const crypto = require("node:crypto");
const W = require("../cms/lib/wallet");
const fail = (status, message) => Object.assign(new Error(message), { status });
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const text = (value, name, max) => {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))
    throw fail(400, `${name} must contain 1-${max} characters.`);
  return value.trim();
};
const wallet = value => {
  if (!W.isAddress(value) || /^0x0{40}$/i.test(value)) throw fail(400, "A non-zero wallet address is required.");
  return value.toLowerCase();
};
class SilverStore {
  constructor(notes, markets, env = process.env, now = Date.now) {
    this.notes = notes; this.db = notes.db; this.markets = markets; this.now = now;
    if (env.SILVER_CODE_KEY && !/^[a-f0-9]{64}$/i.test(env.SILVER_CODE_KEY)) throw fail(503, "SILVER_CODE_KEY must be 32 bytes encoded as 64 hex characters.");
    this.key = env.SILVER_CODE_KEY ? Buffer.from(env.SILVER_CODE_KEY, "hex") : null;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS silver_settings(id INTEGER PRIMARY KEY CHECK(id=1),treasury TEXT NOT NULL,enabled INTEGER NOT NULL,terms TEXT NOT NULL,revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO silver_settings VALUES(1,'',0,'Digital codes only. No physical shipping. Read each product regional restrictions and redemption terms before paying.',0);
      CREATE TABLE IF NOT EXISTS silver_products(id TEXT PRIMARY KEY,data TEXT NOT NULL,revision INTEGER NOT NULL,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS silver_codes(id TEXT PRIMARY KEY,product TEXT NOT NULL,digest TEXT NOT NULL UNIQUE,sealed TEXT NOT NULL,state TEXT NOT NULL,expires INTEGER NOT NULL,at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS silver_stock ON silver_codes(product,state,expires);
      CREATE TABLE IF NOT EXISTS silver_orders(id TEXT PRIMARY KEY,owner TEXT NOT NULL,request TEXT NOT NULL,product TEXT NOT NULL,
        snapshot TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL,code TEXT,signature TEXT,expires INTEGER NOT NULL,at INTEGER NOT NULL,updated INTEGER NOT NULL,UNIQUE(owner,request));
      CREATE INDEX IF NOT EXISTS silver_buyer ON silver_orders(owner,at);
      CREATE TABLE IF NOT EXISTS silver_challenges(owner TEXT PRIMARY KEY,message TEXT NOT NULL,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS silver_sessions(token TEXT PRIMARY KEY,owner TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS silver_audit(id INTEGER PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,at INTEGER NOT NULL);
    `);
  }
  audit(actor, action, target) {
    this.db.prepare("INSERT INTO silver_audit(actor,action,target,at) VALUES(?,?,?,?)").run(actor, action, target, this.now());
  }
  requireKey() { if (!this.key) throw fail(503, "Digital inventory requires SILVER_CODE_KEY. Ask the administrator to configure secure code storage."); }
  seal(value, id) {
    this.requireKey();
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(id));
    const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), bytes].map(part => part.toString("base64")).join(".");
  }
  unseal(row) {
    this.requireKey();
    const [iv, tag, bytes] = row.sealed.split(".").map(value => Buffer.from(value, "base64"));
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, iv); decipher.setAAD(Buffer.from(row.id)); decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(bytes), decipher.final()]).toString("utf8");
  }
  settings() {
    const { id, enabled, ...settings } = this.db.prepare("SELECT * FROM silver_settings WHERE id=1").get();
    return { ...settings, enabled: !!enabled, codeStorageReady: !!this.key };
  }
  configure(input) {
    const treasury = input?.treasury === "" ? "" : wallet(input?.treasury), terms = text(input?.terms, "Store terms", 4000);
    if (typeof input.enabled !== "boolean") throw fail(400, "Enabled must be a boolean.");
    if (input.enabled && (!treasury || !this.key)) throw fail(409, "Configure the receiving wallet and SILVER_CODE_KEY before enabling checkout.");
    return this.markets.atomic(() => {
      if (input.revision !== this.settings().revision) throw fail(409, "Store settings changed. Reload before saving.");
      this.db.prepare("UPDATE silver_settings SET treasury=?,enabled=?,terms=?,revision=revision+1 WHERE id=1").run(treasury, +input.enabled, terms);
      this.audit("admin", "settings", "store"); return this.settings();
    });
  }
  product(id) {
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) throw fail(400, "A valid product ID is required.");
    const row = this.db.prepare("SELECT * FROM silver_products WHERE id=?").get(id);
    if (!row) throw fail(404, "Product not found.");
    const stock = this.db.prepare("SELECT COUNT(*) AS n FROM silver_codes WHERE product=? AND state='available' AND (expires=0 OR expires>?)").get(id, this.now()).n;
    const next = this.db.prepare("SELECT expires FROM silver_codes WHERE product=? AND state='available' AND (expires=0 OR expires>?) ORDER BY CASE WHEN expires=0 THEN 1 ELSE 0 END,expires,at LIMIT 1").get(id, this.now());
    return { id, ...JSON.parse(row.data), revision: row.revision, stock, codeExpiresAt: next?.expires || 0 };
  }
  catalog(admin = false) {
    return this.db.prepare("SELECT id FROM silver_products ORDER BY at DESC LIMIT 500").all().map(row => this.product(row.id)).filter(product => admin || product.published);
  }
  saveProduct(input, id) {
    const data = {};
    for (const [field, max] of Object.entries({ title: 120, brand: 100, description: 2000, region: 160, denomination: 120, terms: 4000, sourcing: 500 }))
      data[field] = text(input?.[field], field, max);
    if (/[\r\n]/.test(data.title)) throw fail(400, "Product titles must be a single line.");
    if (!["giftcard", "silver", "collectible"].includes(input?.category)) throw fail(400, "Choose giftcard, silver or collectible redemption.");
    if (!Number.isSafeInteger(input?.price) || input.price < 1 || input.price > 1000000000) throw fail(400, "Price must be 1-1,000,000,000 whole FTHS.");
    if (typeof input.published !== "boolean") throw fail(400, "Published must be a boolean.");
    let url;
    try { url = new URL(input.redeemUrl); } catch { throw fail(400, "A valid HTTPS issuer redemption URL is required."); }
    if (url.protocol !== "https:" || url.username || url.password) throw fail(400, "Use an HTTPS issuer redemption URL without credentials.");
    Object.assign(data, { category: input.category, price: input.price, published: input.published, redeemUrl: url.href });
    return this.markets.atomic(() => {
      const current = id ? this.product(id) : null;
      if (current && current.revision !== input.revision) throw fail(409, "Product changed. Reload before saving.");
      const key = id || crypto.randomUUID();
      this.db.prepare("INSERT INTO silver_products VALUES(?,?,1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,revision=silver_products.revision+1,at=excluded.at")
        .run(key, JSON.stringify(data), this.now());
      this.audit("admin", "product", key); return this.product(key);
    });
  }
  addStock(id, input) {
    this.requireKey(); this.product(id);
    if (!Array.isArray(input?.codes) || input.codes.length < 1 || input.codes.length > 200) throw fail(400, "Import 1-200 codes at a time.");
    const expires = input.expiresAt ? Date.parse(input.expiresAt) : 0;
    if (!Number.isFinite(expires) || expires && expires <= this.now()) throw fail(400, "Expiry must be a future date.");
    const codes = input.codes.map(value => text(value, "Code", 4000));
    return this.markets.atomic(() => {
      for (const code of codes) {
        const hash = digest(code);
        if (this.db.prepare("SELECT 1 FROM silver_codes WHERE digest=?").get(hash)) throw fail(409, "This import contains an already registered code. No codes were added.");
        const key = crypto.randomUUID();
        this.db.prepare("INSERT INTO silver_codes VALUES(?,?,?,?,'available',?,?)").run(key, id, hash, this.seal(code, key), expires, this.now());
      }
      this.audit("admin", "stock-import", id); return this.product(id);
    });
  }
  inventory(id) {
    this.product(id);
    return this.db.prepare("SELECT id,state,expires,at FROM silver_codes WHERE product=? ORDER BY at DESC LIMIT 1000").all(id);
  }
  retireStock(id, code) {
    return this.markets.atomic(() => {
      const row = this.db.prepare("SELECT state FROM silver_codes WHERE product=? AND id=?").get(id, code);
      if (!row) throw fail(404, "Inventory item not found.");
      if (!["available", "quarantined"].includes(row.state)) throw fail(409, "Reserved or delivered codes cannot be retired here.");
      this.db.prepare("UPDATE silver_codes SET state='quarantined' WHERE id=?").run(code);
      this.audit("admin", "stock-retire", code); return { retired: true };
    });
  }
  challenge(value, origin) {
    const owner = wallet(value), now = this.now();
    const message = `Sign in to Featheral Silver.\n\nOrigin: ${origin}\nWallet: ${W.checksum(owner)}\nNonce: ${crypto.randomBytes(24).toString("hex")}\nIssued: ${new Date(now).toISOString()}\n\nView your digital orders and codes. Signing in does not spend FTHS. Purchases require separate payment approval.`;
    this.db.prepare("DELETE FROM silver_challenges WHERE at<?").run(now - 300000);
    this.db.prepare("DELETE FROM silver_sessions WHERE expires<=?").run(now);
    this.db.prepare("INSERT OR REPLACE INTO silver_challenges VALUES(?,?,?)").run(owner, message, now);
    return { message };
  }
  login(input, origin) {
    const owner = wallet(input?.address), row = this.db.prepare("SELECT * FROM silver_challenges WHERE owner=?").get(owner);
    if (!row || row.at <= this.now() - 300000 || !row.message.includes(`Origin: ${origin}\n`) || W.recoverAddress(row.message, input?.signature)?.toLowerCase() !== owner)
      throw fail(401, "Silver sign-in expired or signature is invalid.");
    const token = crypto.randomBytes(32).toString("hex");
    this.markets.atomic(() => {
      this.db.prepare("DELETE FROM silver_challenges WHERE owner=?").run(owner);
      this.db.prepare("INSERT INTO silver_sessions VALUES(?,?,?)").run(digest(token), owner, this.now() + 86400000);
    });
    return token;
  }
  owner(token) {
    const row = typeof token === "string" && /^[a-f0-9]{64}$/.test(token) && this.db.prepare("SELECT owner FROM silver_sessions WHERE token=? AND expires>?").get(digest(token), this.now());
    if (!row) throw fail(401, "Connect your wallet to Silver.");
    return row.owner;
  }
  logout(token) { if (typeof token === "string") this.db.prepare("DELETE FROM silver_sessions WHERE token=?").run(digest(token)); }
  order(id, owner) {
    const row = this.db.prepare("SELECT * FROM silver_orders WHERE id=?").get(id);
    if (!row || owner && row.owner !== owner) throw fail(404, "Order not found.");
    return row;
  }
  view(row) {
    return { id: row.id, owner: row.owner, status: row.status, snapshot: JSON.parse(row.snapshot), message: row.message, expires: row.expires, at: row.at, updated: row.updated };
  }
  orders(owner) {
    return this.db.prepare(owner ? "SELECT * FROM silver_orders WHERE owner=? ORDER BY at DESC LIMIT 200" : "SELECT * FROM silver_orders WHERE status!='prepared' ORDER BY at DESC LIMIT 500")
      .all(...(owner ? [owner] : [])).map(row => this.view(row));
  }
  prepare(owner, input, origin) {
    if (typeof input?.request !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(input.request)) throw fail(400, "A unique checkout request ID is required.");
    const existing = this.db.prepare("SELECT * FROM silver_orders WHERE owner=? AND request=?").get(owner, input.request);
    if (existing) {
      if (existing.product !== input.product) throw fail(409, "Checkout request already belongs to a different product.");
      return this.view(existing);
    }
    this.requireKey(); this.markets.requireUnlocked();
    const settings = this.settings(), product = this.product(input.product);
    if (!settings.enabled || !settings.treasury) throw fail(409, "Checkout is not enabled. Contact the store administrator.");
    if (settings.treasury === owner) throw fail(409, "The receiving wallet cannot purchase from itself.");
    if (!product.published || !product.stock) throw fail(409, "This product is not available.");
    const id = crypto.randomUUID(), at = this.now(), expires = at + 300000;
    const snapshot = { product, total: product.price, currency: "FTHS", treasury: settings.treasury, storeTerms: settings.terms, settingsRevision: settings.revision, origin };
    const message = `Pay Featheral Silver order.\n\nOrigin: ${origin}\nWallet: ${W.checksum(owner)}\nOrder: ${id}\nProduct: ${product.title}\nAmount: ${product.price} FTHS\nRecipient: ${W.checksum(settings.treasury)}\nDetails: ${digest(JSON.stringify(snapshot))}\nIssued: ${new Date(at).toISOString()}\n\nThis signature authorizes this FTHS payment from your Notes balance. Digital code delivery requires administrator fulfillment. No physical shipping.`;
    this.db.prepare("INSERT INTO silver_orders VALUES(?,?,?,?,?,?,'prepared',NULL,NULL,?,?,?)")
      .run(id, owner, input.request, product.id, JSON.stringify(snapshot), message, expires, at, at);
    return this.view(this.order(id, owner));
  }
  move(from, to, amount, kind, id) {
    this.markets.requireUnlocked();
    if (this.notes.balance(from, "FTHS") < amount) throw fail(402, `Insufficient FTHS in ${kind === "silver-refund" ? "the original receiving wallet" : "your wallet"}.`);
    if (!Number.isSafeInteger(this.notes.balance(to, "FTHS") + amount)) throw fail(409, "Receiving balance exceeds safe limits.");
    const insert = this.db.prepare("INSERT INTO notes_entries(address,amount,kind,other,at,site,symbol) VALUES(?,?,?,?,?,'silver.featheral.com','FTHS')");
    insert.run(from, -amount, kind, `${id}:${to}`, this.now()); insert.run(to, amount, kind, `${id}:${from}`, this.now());
  }
  pay(owner, id, signature, origin) {
    return this.markets.atomic(() => {
      const row = this.order(id, owner), snapshot = JSON.parse(row.snapshot);
      if (snapshot.origin !== origin || W.recoverAddress(row.message, signature)?.toLowerCase() !== owner) throw fail(401, "Invalid Silver payment signature.");
      if (["paid", "delivered", "refunded"].includes(row.status)) return this.view(row);
      if (row.expires <= this.now()) throw fail(409, "Checkout expired. Review a new order.");
      const product = this.product(row.product), settings = this.settings();
      if (!settings.enabled || settings.revision !== snapshot.settingsRevision || product.revision !== snapshot.product.revision || !product.published)
        throw fail(409, "Product or checkout terms changed. Review a new order.");
      const code = this.db.prepare("SELECT * FROM silver_codes WHERE product=? AND state='available' AND (expires=0 OR expires>?) ORDER BY CASE WHEN expires=0 THEN 1 ELSE 0 END,expires,at LIMIT 1").get(row.product, this.now());
      if (!code) throw fail(409, "Sold out. No payment was taken.");
      if (code.expires !== snapshot.product.codeExpiresAt) throw fail(409, "Available code expiry changed. Review a new order.");
      this.unseal(code);
      this.move(owner, snapshot.treasury, snapshot.total, "silver-purchase", id);
      this.db.prepare("UPDATE silver_codes SET state='reserved' WHERE id=?").run(code.id);
      this.db.prepare("UPDATE silver_orders SET status='paid',code=?,signature=?,updated=? WHERE id=?").run(code.id, signature, this.now(), id);
      this.audit(owner, "payment", id); return this.view(this.order(id, owner));
    });
  }
  fulfill(id) {
    return this.markets.atomic(() => {
      const row = this.order(id);
      if (row.status === "delivered") return this.view(row);
      if (row.status !== "paid") throw fail(409, "Only paid orders can be delivered.");
      const code = this.db.prepare("SELECT * FROM silver_codes WHERE id=?").get(row.code);
      if (code.expires && code.expires <= this.now()) throw fail(409, "Reserved code expired. Refund this order.");
      this.unseal(code);
      this.db.prepare("UPDATE silver_orders SET status='delivered',updated=? WHERE id=?").run(this.now(), id);
      this.db.prepare("UPDATE silver_codes SET state='delivered' WHERE id=?").run(row.code);
      this.audit("admin", "delivery", id); return this.view(this.order(id));
    });
  }
  refund(id) {
    return this.markets.atomic(() => {
      const row = this.order(id);
      if (row.status === "refunded") return this.view(row);
      if (row.status !== "paid") throw fail(409, "Only undelivered paid orders can be refunded here. Delivered codes require issuer review.");
      const snapshot = JSON.parse(row.snapshot);
      this.move(snapshot.treasury, row.owner, snapshot.total, "silver-refund", id);
      this.db.prepare("UPDATE silver_orders SET status='refunded',updated=? WHERE id=?").run(this.now(), id);
      this.db.prepare("UPDATE silver_codes SET state='quarantined' WHERE id=?").run(row.code);
      this.audit("admin", "refund", id); return this.view(this.order(id));
    });
  }
  reveal(owner, id) {
    const row = this.order(id, owner);
    if (row.status !== "delivered") throw fail(409, "The administrator has not delivered this code yet.");
    const code = this.unseal(this.db.prepare("SELECT * FROM silver_codes WHERE id=?").get(row.code));
    this.audit(owner, "code-reveal", id);
    return { code, expires: this.db.prepare("SELECT expires FROM silver_codes WHERE id=?").get(row.code).expires };
  }
  admin() {
    return { settings: this.settings(), products: this.catalog(true), orders: this.orders(), audit: this.db.prepare("SELECT * FROM silver_audit ORDER BY id DESC LIMIT 200").all() };
  }
}
module.exports = { SilverStore };
