const crypto = require('node:crypto');
const error = (status, message) => Object.assign(new Error(message), { status });
const MAX = 1_000_000_000_000;
const ASSETS = [
  { symbol: 'FTH$', name: 'Featheral base asset', decimals: 6 },
  { symbol: 'FTHX', name: 'Featheral X native credits', decimals: 0 },
  { symbol: 'USD$', name: 'Demo dollar', decimals: 6 },
  { symbol: 'BTC$', name: 'Demo Bitcoin', decimals: 6 },
  { symbol: 'ETH$', name: 'Demo Ether', decimals: 6 },
  { symbol: 'SOL$', name: 'Demo Solana', decimals: 6 },
];
function integer(value, name, min = 1, max = MAX) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw error(400, `${name} must be an integer from ${min} to ${max}`);
  return value;
}
function asset(symbol) {
  const found = ASSETS.find((a) => a.symbol === symbol);
  if (!found) throw error(400, 'Unsupported demo asset');
  return found;
}
function units(value, symbol) {
  const { decimals } = asset(symbol);
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value) || value.length > 24) throw error(400, 'Enter a positive decimal amount');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw error(400, `${symbol} supports ${decimals} decimal places`);
  const n = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (n < 1n || n > BigInt(MAX)) throw error(400, 'Amount is outside demo limits');
  return Number(n);
}
function sqrt(n) {
  if (n < 2n) return n;
  let x = n; let y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
}

class Economy {
  constructor(store, cms) {
    this.store = store;
    this.db = store.db;
    this.cms = cms;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS demo_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS demo_balances (address TEXT NOT NULL, symbol TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount >= 0),
        PRIMARY KEY(address, symbol));
      CREATE TABLE IF NOT EXISTS demo_faucet (address TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS demo_pools (id INTEGER PRIMARY KEY, symbol TEXT NOT NULL UNIQUE, base INTEGER NOT NULL CHECK(base > 0),
        quote INTEGER NOT NULL CHECK(quote > 0), shares INTEGER NOT NULL CHECK(shares > 0), fee_bps INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS demo_positions (address TEXT NOT NULL, pool_id INTEGER NOT NULL, shares INTEGER NOT NULL CHECK(shares >= 0),
        PRIMARY KEY(address, pool_id));
      CREATE TABLE IF NOT EXISTS demo_operations (address TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        kind TEXT NOT NULL, result TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(address, request_id));
      CREATE TABLE IF NOT EXISTS shop_products (id INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
        price INTEGER NOT NULL CHECK(price > 0), stock INTEGER NOT NULL CHECK(stock >= 0), active INTEGER NOT NULL CHECK(active IN (0,1)));
      CREATE TABLE IF NOT EXISTS shop_orders (id INTEGER PRIMARY KEY, address TEXT NOT NULL, total INTEGER NOT NULL,
        items TEXT NOT NULL, status TEXT NOT NULL, at INTEGER NOT NULL);
    `);
  }

  enabled(feature) {
    if (!this.cms.siteSettings()[feature]) throw error(404, `${feature} demo is not enabled for this site`);
  }
  atomic(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  seed() {
    if (this.db.readOnlyReplica) return;
    const settings = this.cms.siteSettings();
    const needed = (feature) => settings[feature] && !this.db.prepare('SELECT value FROM demo_meta WHERE key=?').get(`${feature}-seed-v1`);
    if (!needed('exchange') && !needed('commerce')) return;
    this.atomic(() => {
      if (needed('exchange')) {
        for (const [symbol, quote] of [['FTHX', 50000], ['USD$', 100000000000], ['BTC$', 2000000], ['ETH$', 50000000]]) {
          const base = 100000000000;
          const shares = Number(sqrt(BigInt(base) * BigInt(quote)));
          const r = this.db.prepare('INSERT INTO demo_pools (symbol,base,quote,shares,fee_bps) VALUES (?,?,?,?,30)')
            .run(symbol, base, quote, shares);
          this.db.prepare('INSERT INTO demo_positions VALUES (?,?,?)').run('demo-treasury', Number(r.lastInsertRowid), shares - 1000);
        }
        this.db.prepare("INSERT INTO demo_meta VALUES ('exchange-seed-v1','installed')").run();
      }
      if (needed('commerce')) {
        for (const [title, description, price, stock] of [
          ['Archive Field Notes', 'A sample digital notebook for your discoveries. Demo only; no fulfillment.', 25, 100],
          ['Featheral Studio Kit', 'A sample creative toolkit. Local checkout demonstration only.', 80, 30],
          ['Independent Internet Print', 'A sample limited-edition print. No real shipment or payment.', 45, 15],
        ]) this.db.prepare('INSERT INTO shop_products (title,description,price,stock,active) VALUES (?,?,?,?,1)').run(title, description, price, stock);
        this.db.prepare("INSERT INTO demo_meta VALUES ('commerce-seed-v1','installed')").run();
      }
    });
  }
  balance(address, symbol) {
    asset(symbol);
    return symbol === 'FTHX' ? this.store.balance(address)
      : this.db.prepare('SELECT amount FROM demo_balances WHERE address = ? AND symbol = ?').get(address, symbol)?.amount || 0;
  }
  change(address, symbol, delta, kind) {
    integer(Math.abs(delta), 'Balance change');
    const next = this.balance(address, symbol) + delta;
    if (next < 0) throw error(402, `Not enough ${symbol}`);
    if (next > MAX) throw error(400, 'Demo balance limit exceeded');
    if (symbol === 'FTHX') this.store.addEntry(address, delta, kind);
    else this.db.prepare('INSERT INTO demo_balances VALUES (?,?,?) ON CONFLICT(address,symbol) DO UPDATE SET amount=excluded.amount')
      .run(address, symbol, next);
  }
  account(address) {
    return {
      demo: true, nativeCurrency: this.cms.siteSettings().nativeCurrency, baseAsset: 'FTH$',
      assets: ASSETS.map((a) => ({ ...a, balance: this.balance(address, a.symbol) })),
      faucetUsed: !!this.db.prepare('SELECT 1 FROM demo_faucet WHERE address = ?').get(address),
      positions: this.db.prepare('SELECT pool_id AS poolId, shares FROM demo_positions WHERE address = ? AND shares > 0').all(address),
      activity: this.db.prepare('SELECT kind,result,at FROM demo_operations WHERE address = ? ORDER BY at DESC LIMIT 30').all(address)
        .map((r) => ({ ...r, result: JSON.parse(r.result) })),
    };
  }
  operation(address, input, kind, fn) {
    if (!input || typeof input !== 'object') throw error(400, 'Operation fields are required');
    if (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId)) throw error(400, 'A unique requestId is required');
    const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, canonical(v[key])])) : v;
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ kind, input: canonical(input) })).digest('hex');
    return this.atomic(() => {
      const existing = this.db.prepare('SELECT fingerprint,result FROM demo_operations WHERE address = ? AND request_id = ?').get(address, input.requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw error(409, 'Request ID already used with different fields');
        return JSON.parse(existing.result);
      }
      const result = { demo: true, ...fn() };
      this.db.prepare('INSERT INTO demo_operations VALUES (?,?,?,?,?,?)')
        .run(address, input.requestId, fingerprint, kind, JSON.stringify(result), Date.now());
      return result;
    });
  }
  faucet(address, input) {
    if (!this.cms.siteSettings().exchange && !this.cms.siteSettings().commerce) throw error(404, 'Demo faucet is not enabled');
    return this.operation(address, input, 'faucet', () => {
      if (this.db.prepare('SELECT 1 FROM demo_faucet WHERE address = ?').get(address)) throw error(409, 'Demo credits already claimed for this wallet on this site');
      for (const [symbol, amount] of [['FTH$', 10000000000], ['FTHX', 1000], ['USD$', 10000000000], ['BTC$', 100000], ['ETH$', 1000000], ['SOL$', 100000000]]) {
        this.change(address, symbol, amount, 'demo_faucet');
      }
      this.db.prepare('INSERT INTO demo_faucet VALUES (?)').run(address);
      return { message: 'Demo credits added. No monetary value or real funds.' };
    });
  }
  pool(id) {
    integer(id, 'Pool ID');
    const p = this.db.prepare('SELECT * FROM demo_pools WHERE id = ?').get(id);
    if (!p) throw error(404, 'Pool not found');
    return p;
  }
  pools() {
    this.enabled('exchange');
    this.seed();
    return { demo: true, baseAsset: 'FTH$', assets: ASSETS, pools: this.db.prepare('SELECT * FROM demo_pools ORDER BY id').all() };
  }
  quote(input) {
    this.enabled('exchange'); this.seed();
    const p = this.pool(input?.poolId);
    if (!['FTH$', p.symbol].includes(input?.from)) throw error(400, 'Choose one asset in this pair');
    const fromBase = input.from === 'FTH$';
    const to = fromBase ? p.symbol : 'FTH$';
    const amount = units(input.amount, input.from);
    const reserveIn = fromBase ? p.base : p.quote;
    const reserveOut = fromBase ? p.quote : p.base;
    const effective = BigInt(amount) * BigInt(10000 - p.fee_bps);
    const output = Number(effective * BigInt(reserveOut) / (BigInt(reserveIn) * 10000n + effective));
    if (output < 1 || output >= reserveOut) throw error(400, 'Amount is too small or liquidity is insufficient');
    const impactBps = Number((BigInt(amount) * BigInt(reserveOut) - BigInt(output) * BigInt(reserveIn)) * 10000n /
      (BigInt(amount) * BigInt(reserveOut)));
    return { demo: true, poolId: p.id, from: input.from, to, amount, output, feeBps: p.fee_bps, impactBps };
  }
  swap(address, input) {
    this.enabled('exchange'); this.seed();
    return this.operation(address, input, 'swap', () => {
      const q = this.quote(input);
      const minOutput = integer(input.minOutput, 'Minimum output');
      integer(input.deadline, 'Deadline', Date.now(), Date.now() + 300000);
      if (q.output < minOutput) throw error(409, 'Price moved beyond your minimum output; request a new quote');
      const p = this.pool(q.poolId);
      const base = p.base + (q.from === 'FTH$' ? q.amount : -q.output);
      const quote = p.quote + (q.from === 'FTH$' ? -q.output : q.amount);
      integer(base, 'Base reserve'); integer(quote, 'Pair reserve');
      this.change(address, q.from, -q.amount, 'swap_out');
      this.change(address, q.to, q.output, 'swap_in');
      this.db.prepare('UPDATE demo_pools SET base=?,quote=? WHERE id=?').run(base, quote, p.id);
      return q;
    });
  }
  createPool(address, input) {
    this.enabled('exchange'); this.seed();
    return this.operation(address, input, 'create_pool', () => {
      asset(input.symbol);
      if (input.symbol === 'FTH$') throw error(400, 'A pair must include a non-base asset');
      if (this.db.prepare('SELECT 1 FROM demo_pools WHERE symbol=?').get(input.symbol)) throw error(409, 'This FTH$ pair already exists');
      const base = units(input.baseAmount, 'FTH$'); const quote = units(input.quoteAmount, input.symbol);
      const shares = Number(sqrt(BigInt(base) * BigInt(quote)));
      if (shares <= 1000) throw error(400, 'Initial liquidity is too small');
      const fee = integer(input.feeBps, 'Fee basis points', 1, 100);
      this.change(address, 'FTH$', -base, 'liquidity_out'); this.change(address, input.symbol, -quote, 'liquidity_out');
      const id = Number(this.db.prepare('INSERT INTO demo_pools (symbol,base,quote,shares,fee_bps) VALUES (?,?,?,?,?)')
        .run(input.symbol, base, quote, shares, fee).lastInsertRowid);
      this.db.prepare('INSERT INTO demo_positions VALUES (?,?,?)').run(address, id, shares - 1000);
      return { poolId: id, shares: shares - 1000 };
    });
  }
  addLiquidity(address, input) {
    this.enabled('exchange'); this.seed();
    return this.operation(address, input, 'add_liquidity', () => {
      const p = this.pool(input.poolId);
      const maxBase = units(input.baseAmount, 'FTH$'); const maxQuote = units(input.quoteAmount, p.symbol);
      const shares = Number([BigInt(maxBase) * BigInt(p.shares) / BigInt(p.base),
        BigInt(maxQuote) * BigInt(p.shares) / BigInt(p.quote)].reduce((a, b) => a < b ? a : b));
      if (shares < integer(input.minShares, 'Minimum shares')) throw error(409, 'Liquidity would mint fewer than your minimum shares');
      const ceil = (a, b) => Number((a + b - 1n) / b);
      const base = ceil(BigInt(shares) * BigInt(p.base), BigInt(p.shares));
      const quote = ceil(BigInt(shares) * BigInt(p.quote), BigInt(p.shares));
      integer(p.base + base, 'Base reserve'); integer(p.quote + quote, 'Pair reserve'); integer(p.shares + shares, 'Pool shares');
      this.change(address, 'FTH$', -base, 'liquidity_out'); this.change(address, p.symbol, -quote, 'liquidity_out');
      this.db.prepare('UPDATE demo_pools SET base=base+?,quote=quote+?,shares=shares+? WHERE id=?').run(base, quote, shares, p.id);
      this.db.prepare('INSERT INTO demo_positions VALUES (?,?,?) ON CONFLICT(address,pool_id) DO UPDATE SET shares=shares+excluded.shares')
        .run(address, p.id, shares);
      return { poolId: p.id, base, quote, shares };
    });
  }
  removeLiquidity(address, input) {
    this.enabled('exchange'); this.seed();
    return this.operation(address, input, 'remove_liquidity', () => {
      const p = this.pool(input.poolId); const shares = integer(input.shares, 'Shares');
      const own = this.db.prepare('SELECT shares FROM demo_positions WHERE address=? AND pool_id=?').get(address, p.id)?.shares || 0;
      if (shares > own) throw error(400, 'Not enough pool shares');
      const base = Number(BigInt(p.base) * BigInt(shares) / BigInt(p.shares));
      const quote = Number(BigInt(p.quote) * BigInt(shares) / BigInt(p.shares));
      if (base < integer(input.minBase, 'Minimum base output') || quote < integer(input.minQuote, 'Minimum pair output')) {
        throw error(409, 'Withdrawal is below your minimum outputs');
      }
      this.change(address, 'FTH$', base, 'liquidity_in'); this.change(address, p.symbol, quote, 'liquidity_in');
      this.db.prepare('UPDATE demo_pools SET base=base-?,quote=quote-?,shares=shares-? WHERE id=?').run(base, quote, shares, p.id);
      this.db.prepare('UPDATE demo_positions SET shares=shares-? WHERE address=? AND pool_id=?').run(shares, address, p.id);
      return { poolId: p.id, base, quote, shares };
    });
  }
  products(admin = false) {
    this.enabled('commerce'); this.seed();
    return this.db.prepare(`SELECT * FROM shop_products ${admin ? '' : 'WHERE active=1'} ORDER BY id`).all();
  }
  saveProduct(input, id) {
    this.enabled('commerce'); this.seed();
    const title = String(input?.title || '').trim();
    const description = String(input?.description || '').trim();
    if (!title || title.length > 200 || description.length > 3000) throw error(400, 'A title up to 200 characters and description up to 3000 characters are required');
    const price = integer(input.price, 'FTHX price', 1, 1000000); const stock = integer(input.stock, 'Stock', 0, 100000);
    if (typeof input.active !== 'boolean') throw error(400, 'Active must be true or false');
    if (id !== undefined) {
      integer(id, 'Product ID');
      if (!this.db.prepare('UPDATE shop_products SET title=?,description=?,price=?,stock=?,active=? WHERE id=?')
        .run(title, description, price, stock, +input.active, id).changes) throw error(404, 'Product not found');
    } else id = Number(this.db.prepare('INSERT INTO shop_products (title,description,price,stock,active) VALUES (?,?,?,?,?)')
      .run(title, description, price, stock, +input.active).lastInsertRowid);
    return this.db.prepare('SELECT * FROM shop_products WHERE id=?').get(id);
  }
  checkout(address, input) {
    this.enabled('commerce'); this.seed();
    return this.operation(address, input, 'checkout', () => {
      if (!Array.isArray(input.items) || !input.items.length || input.items.length > 30) throw error(400, 'Cart must have 1 to 30 products');
      const seen = new Set();
      const items = input.items.map((item) => {
        integer(item?.id, 'Product ID'); const quantity = integer(item.quantity, 'Quantity', 1, 100);
        if (seen.has(item.id)) throw error(400, 'Combine duplicate cart products');
        seen.add(item.id);
        const p = this.db.prepare('SELECT * FROM shop_products WHERE id=? AND active=1').get(item.id);
        if (!p) throw error(404, 'Product is no longer available');
        if (p.stock < quantity) throw error(409, `Insufficient stock for ${p.title}`);
        return { id: p.id, title: p.title, price: p.price, quantity };
      });
      const total = items.reduce((sum, p) => sum + p.price * p.quantity, 0);
      if (total !== integer(input.expectedTotal, 'Expected FTHX total')) throw error(409, 'Cart prices changed; review the current catalog');
      this.change(address, 'FTHX', -total, 'checkout');
      for (const item of items) this.db.prepare('UPDATE shop_products SET stock=stock-? WHERE id=?').run(item.quantity, item.id);
      const id = Number(this.db.prepare("INSERT INTO shop_orders (address,total,items,status,at) VALUES (?,?,?,'demo-paid',?)")
        .run(address, total, JSON.stringify(items), Date.now()).lastInsertRowid);
      return { orderId: id, total, items, status: 'demo-paid', message: 'Demo order recorded. No real payment or fulfillment.' };
    });
  }
  orders(address) {
    this.enabled('commerce');
    return this.db.prepare(`SELECT * FROM shop_orders ${address ? 'WHERE address=?' : ''} ORDER BY id DESC LIMIT 100`)
      .all(...(address ? [address] : [])).map((r) => ({ ...r, items: JSON.parse(r.items) }));
  }
}

module.exports = { Economy, ASSETS, units, sqrt };
