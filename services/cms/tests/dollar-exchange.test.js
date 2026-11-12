const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { ethers } = require('ethers');
const { Notes } = require('../../notes/ledger');
const { Creation } = require('../../notes/creation');
const { Exchange, DOLLAR_POOL } = require('../../notes/exchange');
const { createDollarApi } = require('../../notes/dollar');
const { walletAccountId, transferMessage } = require('../../fth-ledger/transfer');
const { SYSTEM_TREASURY_ACCOUNT } = require('../../notes/game-funds');
test('World sync shares only a public account with the fixed Dollar host and explicitly reports missing sessions', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../../sites/world.featheral.com/wallet-sync.js'), 'utf8');
  const accountId = `0x${'ab'.repeat(32)}`;
  for (const [hostname, ok] of [['world.localhost', true], ['world.featheral.com', true], ['world.localhost', false]]) {
    let destination, request;
    const nodes = { 'sync-status': {}, 'return-link': {} };
    const errors = [];
    require('node:vm').runInNewContext(source, {
      URL, URLSearchParams, console: { error: (...args) => errors.push(args) },
      location: { hostname, protocol: 'http:', port: '8080', replace: url => { destination = new URL(url); } },
      document: { getElementById: id => nodes[id] },
      fetch: async (url, options) => {
        request = { url, options };
        return { ok, status: ok ? 200 : 401, json: async () => ok ? { accountId, wallet: null, available: '123' } : { error: 'Session required.' } };
      },
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(request.url, '/api/dollar/game/wallet/balance');
    assert.equal(request.options.credentials, 'same-origin');
    assert.equal(request.options.cache, 'no-store');
    assert.equal(destination.hostname, hostname === 'world.localhost' ? 'wallet.localhost' : 'wallet.featheral.com');
    assert.equal(destination.pathname, '/');
    const payload = new URLSearchParams(destination.hash.slice(1));
    if (ok) { assert.deepEqual([...payload.keys()], ['worldAccount']); assert.equal(payload.get('worldAccount'), accountId); }
    else { assert.match(payload.get('worldSyncError'), /Open World Play first/); assert.equal(errors.length, 1); }
  }
});
test('Dollar wallet display rounds like World at two decimals without losing base-unit precision', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../../sites/wallet.featheral.com/wallet-app.js'), 'utf8');
  const formatter = source.slice(source.indexOf('const format = '), source.indexOf('const status = '));
  const format = require('node:vm').runInNewContext(`${formatter}; format;`);
  for (const [input, expected] of [['1.234', '1.23 FTH$'], ['1.235', '1.24 FTH$'], ['9.999', '10 FTH$'], ['0', '0 FTH$'], ['0.005', '0.01 FTH$']])
    assert.equal(format(ethers.parseUnits(input, 18).toString(), 'FTH$'), expected);
  assert.equal(format('1', 'FTH$'), '<0.01 FTH$');
  assert.equal(format('55', 'FTHX'), '55 FTHX');
});
async function fixture(t, existingFthx = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dollar-note-exchange-'));
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const api = createDollarApi({ exchangeSigningKey: privateKey, env: { FTH_LEDGER_MODE: 'writer', FTH_LEDGER_DIR: path.join(root, 'dollar'),
    FTH_LEDGER_BLOCK_INTERVAL_MS: '0', FTH_GAME_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }).toString() } });
  const notes = new Notes(path.join(root, 'notes.sqlite'));
  const creation = new Creation(notes, { list: () => [] });
  const exchange = new Exchange(creation); exchange.setDollar(api.exchangeSettlement);
  const wallet = ethers.Wallet.createRandom(), owner = wallet.address.toLowerCase();
  const credit = (address, units) => notes.db.prepare("INSERT INTO notes_entries(address,amount,kind,at,site) VALUES (?,?,'fixture',0,'test')").run(address, units);
  if (existingFthx) { credit(owner, 100000); credit(SYSTEM_TREASURY_ACCOUNT, 1000000); }
  await api.ledger.submit({ id: 'fixture-dollar', kind: 'CREDIT', account: walletAccountId(owner), amount: ethers.parseUnits('10000', 18).toString(),
    data: { src: 'FthgConverted', tx: `0x${'ab'.repeat(32)}` } });
  t.after(() => { api.close(); notes.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const complete = async request => exchange.complete(owner, request.id, request.message ? await wallet.signMessage(request.message) : undefined);
  const fund = async () => complete(exchange.prepare(owner, { requestId: 'initial-funding-0001', dollars: ethers.parseUnits('1000', 18).toString(),
    fthx: '10000', approval: `FUND FTH$ ${ethers.parseUnits('1000', 18)} BASE_UNITS 10000 FTHX` }, true));
  return { api, notes, creation, exchange, owner, wallet, complete, fund };
}
test('FTH$ converts through real FTHX/FTHS pools and pays for a digital Silver order without minting at checkout', async t => {
  const { notes, creation, exchange, owner, wallet, fund, api } = await fixture(t);
  new (require('../../notes/workspace').Workspace)(notes, creation.markets);
  creation.markets.fund('FTHS', 'FUND FTHS 1000000 FTHX 1000000 NOTES');
  await fund();
  const input = { from: 'FTH$', to: 'FTHS', amount: ethers.parseUnits('10', 18).toString() };
  const quote = exchange.swapQuote(input);
  assert.deepEqual(quote.route, ['FTH$', 'FTHX', 'FTHS']);
  const request = exchange.prepareSwap(owner, { ...input, minOutput: quote.output, requestId: 'silver-dollar-conversion-1' });
  const result = await exchange.completeSwap(owner, request.id, await wallet.signMessage(request.message));
  assert.equal(result.status, 'complete'); assert.equal(notes.balance(owner, 'FTHS'), Number(result.output));
  assert.equal(creation.markets.account(owner).trades.filter(trade => trade.symbol === 'FTHS').length, 1);
  assert.equal(exchange.account(owner).trades.length, 1);
  const silverSupply = notes.db.prepare("SELECT SUM(amount) AS n FROM notes_entries WHERE symbol='FTHS'").get().n;
  const dollarSupply = api.ledger.summary().supply;
  const store = new (require('../../notes/silver-store').SilverStore)(notes, creation.markets, { SILVER_CODE_KEY: crypto.randomBytes(32).toString('hex') });
  store.configure({ treasury: ethers.Wallet.createRandom().address, terms: 'Digital code only', enabled: true, revision: 0 });
  const product = store.saveProduct({ title: 'Test redemption', brand: 'Fixture issuer', category: 'giftcard', description: 'Isolated fixture',
    region: 'Japan only', denomination: 'Fixture units', sourcing: 'Japan test supplier', terms: 'Test issuer terms',
    redeemUrl: 'https://example.com/redeem', price: 5, published: true });
  store.addStock(product.id, { codes: ['TEST-CONVERT-THEN-REDEEM'] });
  const order = store.prepare(owner, { product: product.id, request: crypto.randomUUID() }, 'http://silver.localhost');
  store.pay(owner, order.id, await wallet.signMessage(order.message), 'http://silver.localhost');
  assert.equal(notes.balance(owner, 'FTHS'), Number(result.output) - 5);
  assert.equal(notes.db.prepare("SELECT SUM(amount) AS n FROM notes_entries WHERE symbol='FTHS'").get().n, silverSupply);
  assert.equal(api.ledger.summary().supply, dollarSupply);
});
test('Dollar pool stays disabled until explicit existing-fund funding and conserves both supplies', async t => {
  const { api, notes, exchange, fund } = await fixture(t);
  const opening = exchange.market().referencePrice;
  assert.equal(opening.source, 'opening');
  assert.equal(BigInt(opening.numerator) / BigInt(opening.denominator), 100n);
  assert.equal(exchange.market().notes[0].price, null, 'opening estimate is not executable liquidity');
  const dollarSupply = api.ledger.summary().supply;
  const noteSupply = notes.db.prepare("SELECT SUM(amount) AS supply FROM notes_entries WHERE symbol='FTHX'").get().supply;
  assert.throws(() => exchange.quote({ from: 'FTH$', to: 'FTHX', amount: '1000000000000000000' }), /unfunded/);
  assert.throws(() => exchange.prepare('0xnone', { requestId: 'bad-funding-0001', dollars: '1', fthx: '1', approval: 'wrong' }, true), /approval/);
  await fund();
  assert.equal(exchange.pool().funded, true);
  assert.equal(exchange.market().referencePrice.source, 'exchange');
  assert.equal(api.ledger.balance(DOLLAR_POOL).available, ethers.parseUnits('1000', 18).toString());
  assert.equal(api.ledger.summary().supply, dollarSupply);
  assert.equal(notes.db.prepare("SELECT SUM(amount) AS supply FROM notes_entries WHERE symbol='FTHX'").get().supply, noteSupply);
});
test('zero FTHX can launch once, fund at 100:1, recover funding and trade dynamically without minting', async t => {
  const { api, notes, creation, exchange, owner, wallet, complete } = await fixture(t, false);
  const dollarSupply = api.ledger.summary().supply;
  assert.equal(notes.fthx.summary().circulating, '0');
  const supply = notes.fthx.initializeSupply(owner, { supply: '1000000',
    approval: `INITIALIZE FTHX 1000000 TO ${owner}`, requestId: 'exchange-fixed-supply1' }, owner);
  const dollars = ethers.parseUnits('1000', 18).toString();
  const input = { dollars, fthx: '100000', approval: `FUND FTH$ ${dollars} BASE_UNITS 100000 FTHX`, requestId: 'launch-pool-funding01' };
  assert.throws(() => exchange.prepare(owner, { ...input, fthx: '10000',
    approval: `FUND FTH$ ${dollars} BASE_UNITS 10000 FTHX` }, true), /1 FTH\$ = 100 FTHX/);
  const prepared = exchange.prepare(owner, input, true);
  const commit = exchange.dollar.commitSettlement;
  exchange.dollar.commitSettlement = () => { throw Error('fixture funding receipt lost'); };
  await assert.rejects(complete(prepared), /receipt lost/);
  exchange.dollar.commitSettlement = commit;
  const recovered = await complete(exchange.refresh(owner, prepared.id));
  assert.equal(recovered.status, 'complete');
  const restarted = new Exchange(creation); restarted.setDollar(exchange.dollar);
  assert.deepEqual(await restarted.complete(owner, prepared.id), recovered);
  assert.equal(exchange.pool().fthx, 100000);
  assert.equal(notes.balance(owner), 900000);
  const opening = exchange.market().referencePrice;
  assert.equal(BigInt(opening.numerator) / BigInt(opening.denominator), 100n);
  const quote = exchange.swapQuote({ from: 'FTH$', to: 'FTHX', amount: ethers.parseUnits('10', 18).toString() });
  const trade = exchange.prepareSwap(owner, { ...quote, minOutput: quote.output, requestId: 'launch-first-swap-01' });
  await exchange.completeSwap(owner, trade.id, await wallet.signMessage(trade.message));
  assert.equal(exchange.pool().fthx, 100000 - Number(quote.output));
  assert.ok(BigInt(exchange.pool().fthx) * 10n ** 18n < BigInt(exchange.pool().dollars) * 100n);
  assert.equal(notes.fthx.summary().circulating, supply.supply);
  assert.equal(api.ledger.summary().supply, dollarSupply);
  assert.equal(exchange.walletTrades(owner).length, 1);
  const reverse = exchange.swapQuote({ from: 'FTHX', to: 'FTH$', amount: quote.output });
  const sale = exchange.prepareSwap(owner, { ...reverse, minOutput: reverse.output, requestId: 'launch-reverse-swap01' });
  assert.equal((await exchange.completeSwap(owner, sale.id)).status, 'complete');
  assert.equal(exchange.pool().fthx, 100000);
  assert.ok(BigInt(exchange.pool().dollars) > BigInt(dollars), 'Swap fees remain in the reserves');
  assert.equal(notes.fthx.summary().circulating, supply.supply);
  assert.equal(api.ledger.summary().supply, dollarSupply);
  exchange.validatePool(exchange.pool());
});
test('wallet swaps execute funded native pairs and two-hop routes as real Exchange trades without a Dollar writer', async t => {
  const { notes, creation, exchange, owner } = await fixture(t);
  notes.db.prepare("INSERT INTO notes_entries(address,amount,kind,at,site) VALUES (?,1000000,'fixture',0,'test')").run(SYSTEM_TREASURY_ACCOUNT);
  for (const symbol of ['FTHA', 'FTHB']) creation.markets.fund(symbol, `FUND ${symbol} 1000000 FTHX 1000000 NOTES`);
  exchange.setDollar(null);
  const supply = () => notes.db.prepare('SELECT symbol,SUM(amount) AS supply FROM notes_entries GROUP BY symbol ORDER BY symbol').all();
  const before = supply();
  const buy = exchange.swapQuote({ from: 'FTHX', to: 'FTHA', amount: '1000' });
  const request = exchange.prepareSwap(owner, { ...buy, minOutput: buy.output, requestId: 'wallet-swap-native-buy1' });
  assert.equal(creation.markets.account(owner).trades.length, 0, 'preparation never executes a trade');
  await exchange.completeSwap(owner, request.id);
  assert.equal(notes.balance(owner, 'FTHA'), Number(buy.output));
  assert.equal(creation.markets.account(owner).trades.length, 1);
  assert.equal(creation.markets.history('FTHA').candles[0].quoteVolume, '1000');
  const route = exchange.swapQuote({ from: 'FTHA', to: 'FTHB', amount: '100' });
  assert.deepEqual(route.route, ['FTHA', 'FTHX', 'FTHB']);
  assert.equal(route.hops, 2);
  const routed = exchange.prepareSwap(owner, { ...route, minOutput: route.output, requestId: 'wallet-swap-native-route1' });
  const complete = await exchange.completeSwap(owner, routed.id);
  assert.equal(complete.status, 'complete');
  assert.equal(notes.balance(owner, 'FTHB'), Number(route.output));
  assert.equal(creation.markets.account(owner).trades.length, 3, 'each executed FTHX pair is recorded once');
  assert.equal(exchange.walletTrades(owner).length, 3);
  const restarted = new Exchange(creation);
  assert.deepEqual(await restarted.completeSwap(owner, routed.id), complete);
  assert.equal(creation.markets.account(owner).trades.length, 3);
  assert.deepEqual(supply(), before);
  assert.equal(exchange.account(owner).requests.length, 0);
});
test('native wallet swaps reject stale quotes, unauthorized recovery and partial routes atomically', async t => {
  const { notes, creation, exchange, owner } = await fixture(t);
  notes.db.prepare("INSERT INTO notes_entries(address,amount,kind,at,site) VALUES (?,1000000,'fixture',0,'test')").run(SYSTEM_TREASURY_ACCOUNT);
  for (const symbol of ['FTHA', 'FTHB']) creation.markets.fund(symbol, `FUND ${symbol} 1000000 FTHX 1000000 NOTES`);
  for (const [from, to, amount] of [['FTHG', 'FTHX', '1'], ['FTHX', 'FTH#', '1'], ['FTHX', 'FTHC', '1'], ['FTHX', 'FTHX', '1'], ['FTHX', 'FTHA', '1.5']])
    assert.throws(() => exchange.swapQuote({ from, to, amount }));
  const prepare = (from, to, amount, requestId) => {
    const quote = exchange.swapQuote({ from, to, amount });
    return exchange.prepareSwap(owner, { from, to, amount, minOutput: quote.output, requestId });
  };
  const buy = prepare('FTHX', 'FTHA', '1000', 'native-stale-price-buy1');
  const other = '0x' + '99'.repeat(20);
  await assert.rejects(exchange.completeSwap(other, buy.id), /not found/);
  assert.throws(() => exchange.refreshSwap(other, buy.id), /not found/);
  assert.throws(() => exchange.cancelSwap(other, buy.id), /not found/);
  creation.markets.trade(owner, { symbol: 'FTHA', side: 'buy', amount: 10000, minOutput: 1, requestId: 'competing-market-buy1' });
  const holdings = notes.balance(owner), trades = creation.markets.account(owner).trades.length;
  await assert.rejects(exchange.completeSwap(owner, buy.id), /minimum output/);
  assert.equal(notes.balance(owner), holdings); assert.equal(creation.markets.account(owner).trades.length, trades);
  exchange.cancelSwap(owner, buy.id);
  const route = prepare('FTHA', 'FTHB', '100', 'atomic-native-route-01');
  const balances = ['FTHX', 'FTHA', 'FTHB'].map(symbol => notes.balance(owner, symbol));
  const execute = creation.markets.tradeInTransaction;
  creation.markets.tradeInTransaction = function (account, input) {
    if (input.symbol === 'FTHB') throw new Error('injected second-leg failure');
    return execute.call(this, account, input);
  };
  await assert.rejects(exchange.completeSwap(owner, route.id), /second-leg failure/);
  assert.deepEqual(['FTHX', 'FTHA', 'FTHB'].map(symbol => notes.balance(owner, symbol)), balances);
  assert.equal(creation.markets.account(owner).trades.length, trades);
  creation.markets.tradeInTransaction = execute;
  await exchange.completeSwap(owner, route.id);
  assert.equal(creation.markets.account(owner).trades.length, trades + 2);
  assert.throws(() => exchange.cancelSwap(owner, route.id), /unsubmitted/);
});
test('wallet Dollar swaps use signed journaled settlement and preserve minimums and request identity', async t => {
  const { notes, exchange, owner, wallet, fund } = await fixture(t);
  await fund();
  const quote = exchange.swapQuote({ from: 'FTH$', to: 'FTHX', amount: ethers.parseUnits('10', 18).toString() });
  const input = { ...quote, minOutput: quote.output, requestId: 'wallet-dollar-swap-01' };
  const request = exchange.prepareSwap(owner, input);
  assert.equal(notes.balance(owner), 90000);
  await assert.rejects(exchange.completeSwap(owner, request.id, '0x00'), /signature/);
  const done = await exchange.completeSwap(owner, request.id, await wallet.signMessage(request.message));
  assert.equal(done.status, 'complete');
  assert.deepEqual(await exchange.completeSwap(owner, request.id), done);
  assert.equal(notes.balance(owner), 90000 + Number(quote.output));
  assert.equal(exchange.account(owner).trades.length, 1);
  assert.equal(exchange.walletTrades(owner)[0].symbol, 'FTH$');
  assert.equal(exchange.walletTrades(owner)[0].side, 'sell');
  assert.equal(exchange.walletTrades(owner)[0].output, quote.output);
  assert.throws(() => exchange.prepareSwap(owner, { ...input, from: 'FTHX', to: 'FTHA' }), /different parameters/);
  const sell = exchange.swapQuote({ from: 'FTHX', to: 'FTH$', amount: '10' });
  const pending = exchange.prepareSwap(owner, { ...sell, minOutput: sell.output, requestId: 'wallet-dollar-sell-01' });
  assert.equal(exchange.refreshSwap(owner, pending.id).id, pending.id);
  exchange.cancelSwap(owner, pending.id);
  assert.throws(() => exchange.refreshSwap(owner, pending.id), /not found/);
  const payout = exchange.prepareSwap(owner, { ...sell, minOutput: sell.output, requestId: 'wallet-dollar-sell-02' });
  assert.equal((await exchange.completeSwap(owner, payout.id)).status, 'complete');
  assert.equal(exchange.account(owner).trades.length, 2);
});
test('Dollar swap quotes and prepared payments retain exact raw amounts above the safe Number range', async t => {
  const { exchange, owner, fund } = await fixture(t);
  await fund();
  const rawAmount = (BigInt(Number.MAX_SAFE_INTEGER) * 100n).toString();
  const quote = exchange.swapQuote({ from: 'FTH$', to: 'FTHX', amount: rawAmount });
  const pool = exchange.pool();
  const expected = (BigInt(rawAmount) * 9970n * BigInt(pool.fthx)
    / (BigInt(pool.dollars) * 10000n + BigInt(rawAmount) * 9970n)).toString();
  assert.equal(quote.amount, rawAmount);
  assert.equal(quote.output, expected);

  const request = exchange.prepareSwap(owner, {
    ...quote, minOutput: quote.output, requestId: 'wallet-dollar-exact-amount1',
  });
  assert.equal(request.payment.amount, rawAmount);
  assert.equal(request.output, expected);
});
test('Dollar routes buy and sell notes through FTHX with signatures, exact retries and no double charge', async t => {
  const { api, notes, creation, exchange, owner, complete, fund } = await fixture(t);
  await fund(); creation.markets.fund('FTHA', 'FUND FTHA 1000000 FTHX 1000000 NOTES');
  const supply = api.ledger.summary().supply;
  const quote = exchange.quote({ from: 'FTH$', to: 'FTHA', amount: ethers.parseUnits('10', 18).toString() });
  const request = exchange.prepare(owner, { from: quote.from, to: quote.to, amount: quote.amount, minOutput: quote.output, requestId: 'dollar-buy-route-0001' });
  await assert.rejects(exchange.complete(owner, request.id, '0x00'), /signature/);
  const paid = await complete(request);
  const balance = api.ledger.balance(walletAccountId(owner)).available;
  await complete(request);
  const reference = exchange.market().referencePrice;
  assert.notEqual(BigInt(reference.numerator), 10n * BigInt(reference.denominator), 'executed trade moves the funded opening reserve ratio');
  const { portfolio } = require('../../notes/portfolio');
  const estimated = portfolio([{ symbol: 'FTH$', balance: ethers.parseUnits('1', 18).toString() }], exchange.pool(), []);
  assert.equal(estimated.dollarReference.source, 'exchange');
  assert.equal(estimated.totals.FTHX.value, (BigInt(reference.numerator) * 10n ** 18n / BigInt(reference.denominator)).toString());
  assert.equal(paid.status, 'complete');
  assert.equal(api.ledger.balance(walletAccountId(owner)).available, balance);
  assert.equal(notes.balance(owner, 'FTHA'), Number(quote.output));
  assert.deepEqual(quote.route, ['FTH$', 'FTHX', 'FTHA']);
  const sell = exchange.quote({ from: 'FTHA', to: 'FTH$', amount: '20' });
  await complete(exchange.prepare(owner, { from: sell.from, to: sell.to, amount: sell.amount, minOutput: sell.output, requestId: 'dollar-sell-route-0001' }));
  assert.equal(api.ledger.summary().supply, supply);
  assert.equal(exchange.account(owner).trades.length, 2);
  assert.equal(api.ledger.balance(DOLLAR_POOL).available, exchange.pool().dollars);
  notes.validateBalances();
});
test('sealed Dollar deposits and interrupted payouts recover without replaying note trades or payments', async t => {
  const { api, notes, creation, exchange, owner, wallet, complete, fund } = await fixture(t);
  await fund();
  const quote = exchange.quote({ from: 'FTH$', to: 'FTHX', amount: ethers.parseUnits('10', 18).toString() });
  const request = exchange.prepare(owner, { from: quote.from, to: quote.to, amount: quote.amount, minOutput: quote.output, requestId: 'dollar-recovery-0001' });
  const original = api.exchangeSettlement.commitSettlement;
  api.exchangeSettlement.commitSettlement = () => { throw new Error('disk unavailable'); };
  await assert.rejects(complete(request), /disk unavailable/);
  const noteBalance = notes.balance(owner), dollarBalance = api.ledger.balance(walletAccountId(owner)).available;
  assert.throws(() => creation.markets.quote('FTHA', 'buy', 1), /settling/);
  assert.throws(() => exchange.quote({ from: 'FTHX', to: 'FTH$', amount: '10' }), /recovery/);
  api.exchangeSettlement.commitSettlement = original;
  const reopened = new Exchange(creation); reopened.setDollar(api.exchangeSettlement);
  await reopened.recover();
  assert.equal(notes.balance(owner), noteBalance);
  assert.equal(api.ledger.balance(walletAccountId(owner)).available, dollarBalance);
  assert.equal(reopened.account(owner).requests.length, 0);
  assert.equal(api.ledger.balance(DOLLAR_POOL).available, reopened.pool().dollars);
  assert.equal((await reopened.complete(owner, request.id, await wallet.signMessage(request.message))).status, 'complete');
});

test('lost deposit receipts and stale preparations recover without creating additional transfers', async t => {
  const { api, notes, creation, exchange, owner, complete, fund } = await fixture(t);
  await fund();
  const parameters = { from: 'FTH$', to: 'FTHX', amount: ethers.parseUnits('10', 18).toString(), minOutput: '1', requestId: 'stale-dollar-0001' };
  const stale = exchange.prepare(owner, parameters);
  await complete(exchange.prepare(owner, { ...parameters, requestId: 'other-dollar-0001' }));
  await assert.rejects(complete(stale), /Pool changed/);
  const refreshed = exchange.refresh(owner, stale.id);
  assert.equal(refreshed.id, stale.id);
  const submit = api.exchangeSettlement.submit;
  api.exchangeSettlement.submit = async payment => { await submit(payment); throw new Error('lost deposit response'); };
  const before = notes.balance(owner);
  await assert.rejects(complete(refreshed), /lost deposit response/);
  const dollars = api.ledger.balance(walletAccountId(owner)).available;
  assert.equal(notes.balance(owner), before, 'output is not released before the sealed payment is recognized');
  assert.throws(() => creation.markets.fund('FTHA', 'FUND FTHA 1000000 FTHX 1000000 NOTES'), /settling/);
  api.exchangeSettlement.submit = submit;
  await exchange.recover();
  assert.equal(api.ledger.balance(walletAccountId(owner)).available, dollars);
  assert.equal(notes.balance(owner), before + Number(refreshed.output));
});

test('wallet note transfers preserve balances, reject foreign debits and roll back on persistence errors', async t => {
  const { notes, creation, owner } = await fixture(t);
  const recipient = ethers.Wallet.createRandom().address.toLowerCase();
  const input = { symbol: 'FTHX', to: recipient, amount: 20, requestId: 'wallet-send-0001' };
  assert.throws(() => creation.sendNote(recipient, { ...input, to: owner }), /Insufficient/);
  const before = notes.balance(owner);
  notes.db.exec("CREATE TRIGGER fail_wallet_transfer BEFORE INSERT ON note_wallet_transfers BEGIN SELECT RAISE(ABORT,'transfer failure'); END");
  assert.throws(() => creation.sendNote(owner, input), /transfer failure/);
  assert.equal(notes.balance(owner), before);
  assert.equal(notes.balance(recipient), 0);
  notes.db.exec("DROP TRIGGER fail_wallet_transfer");
  assert.deepEqual(creation.sendNote(owner, input), creation.sendNote(owner, input));
  assert.equal(notes.balance(owner), before - 20);
  assert.equal(notes.balance(recipient), 20);
  assert.throws(() => creation.sendNote(owner, { ...input, amount: 30 }), /different parameters/);
  assert.throws(() => creation.sendNote(owner, { ...input, symbol: 'FTH$' }), /Dollar transfer API/);
});

test('a competing payment nonce retains reservations and requires a replacement signature before recovery', async t => {
  const { api, notes, exchange, owner, wallet, complete } = await fixture(t);
  const dollars = ethers.parseUnits('1000', 18).toString();
  const request = exchange.prepare(owner, { requestId: 'nonce-funding-0001', dollars, fthx: '10000',
    approval: `FUND FTH$ ${dollars} BASE_UNITS 10000 FTHX` }, true);
  const submit = api.exchangeSettlement.submit;
  api.exchangeSettlement.submit = async payment => {
    const competing = { ...payment, amount: '1', memo: 'competing-transfer', to: walletAccountId(ethers.Wallet.createRandom().address) };
    await submit({ ...competing, signature: await wallet.signMessage(transferMessage(competing)) });
    throw new Error('competing payment sealed first');
  };
  await assert.rejects(complete(request), /competing payment/);
  assert.equal(notes.balance(owner), 90000);
  api.exchangeSettlement.submit = submit;
  await assert.rejects(complete(request), /consumed this nonce/);
  const replacement = exchange.account(owner).requests[0];
  assert.equal(replacement.status, 'awaiting_signature');
  assert.equal(replacement.payment.nonce, request.payment.nonce + 1);
  await assert.rejects(exchange.complete(owner, request.id, await wallet.signMessage(request.message)), /signature/);
  assert.equal(notes.balance(owner), 90000);
  assert.equal((await complete(replacement)).status, 'complete');
  assert.equal(notes.balance(owner), 90000, 'reserved FTHX is not debited again');
  assert.equal(api.ledger.balance(DOLLAR_POOL).available, dollars);
  assert.equal(exchange.account(owner).requests.length, 0);
});
test('FTHX Thanks tips conserve balances, bind purpose and recipient, and retry without a second debit', async t => {
  const { creation, notes, owner } = await fixture(t);
  const recipient = ethers.Wallet.createRandom().address.toLowerCase();
  const input = { to: recipient, symbol: 'FTHX', amount: 25, purpose: 'tip', requestId: 'thanks-transfer-0001' };
  const before = notes.balance(owner), total = notes.db.prepare("SELECT SUM(amount) AS n FROM notes_entries WHERE symbol='FTHX'").get().n;
  assert.equal(creation.sendNote(owner, input).purpose, 'tip');
  creation.sendNote(owner, input);
  assert.equal(notes.balance(owner), before - 25);
  assert.equal(notes.balance(recipient), 25);
  assert.equal(notes.db.prepare("SELECT SUM(amount) AS n FROM notes_entries WHERE symbol='FTHX'").get().n, total);
  assert.equal(notes.db.prepare("SELECT COUNT(*) AS n FROM notes_entries WHERE kind='wallet_tip_out'").get().n, 1);
  for (const changed of [{ to: ethers.Wallet.createRandom().address }, { amount: 26 }, { purpose: undefined }])
    assert.throws(() => creation.sendNote(owner, { ...input, ...changed }), /different parameters/);
  assert.throws(() => creation.sendNote(owner, { ...input, symbol: 'FTHA' }), /tips use FTHX/);
  assert.throws(() => creation.sendNote(owner, { ...input, amount: 0 }), /whole-note/);
  assert.throws(() => creation.sendNote(recipient, { ...input, to: owner, requestId: 'unfunded-tip-0001', amount: 26 }), /Insufficient/);
  assert.throws(() => creation.sendNote(owner, { ...input, to: owner }), /another wallet/);
  notes.db.exec("CREATE TRIGGER fail_tip BEFORE INSERT ON note_wallet_transfers WHEN NEW.request='thanks-rollback-0001' BEGIN SELECT RAISE(ABORT,'tip persist failed'); END");
  assert.throws(() => creation.sendNote(owner, { ...input, requestId: 'thanks-rollback-0001' }), /tip persist failed/);
  assert.equal(notes.balance(owner), before - 25); assert.equal(notes.balance(recipient), 25);
});
test('FTH$/FTHX market reports exact funded spot ratios and completed volumes only', async t => {
  const { exchange, complete, fund, api, owner } = await fixture(t);
  const empty = exchange.market();
  assert.equal(empty.volumeFthx, '0'); assert.equal(empty.trades, 0);
  assert.equal(empty.notes[0].price, null); assert.equal(empty.notes[1].history.points.length, 0);
  assert.throws(() => exchange.market('invalid'), /supported chart interval/);
  await fund();
  assert.equal(exchange.market().volumeFthDollar, '0', 'initial funding is not trading volume');
  const price = exchange.market().notes[0].price;
  assert.equal(BigInt(price.numerator) / BigInt(price.denominator), 10n);
  const buy = exchange.quote({ from: 'FTH$', to: 'FTHX', amount: ethers.parseUnits('10', 18).toString() });
  const request = exchange.prepare(owner,
    { from: buy.from, to: buy.to, amount: buy.amount, minOutput: buy.output, requestId: 'metric-buy-0001-test' });
  assert.equal(exchange.market().trades, 0, 'preparations are not volume');
  await complete(request);
  const sell = exchange.quote({ from: 'FTHX', to: 'FTH$', amount: '10' });
  const sale = exchange.prepare(owner, { from: sell.from, to: sell.to, amount: sell.amount, minOutput: sell.output, requestId: 'metric-sell-0001-test' });
  const commit = api.exchangeSettlement.commitSettlement;
  api.exchangeSettlement.commitSettlement = () => { throw new Error('market fixture interruption'); };
  await assert.rejects(complete(sale), /interruption/);
  assert.equal(exchange.market().trades, 1, 'unsealed settlement is not completed volume');
  assert.equal(exchange.market().notes[0].price, null, 'pending settlement hides unsettled spot reserves');
  assert.equal(exchange.market().referencePrice, null, 'pending settlement never falls back to the opening estimate');
  assert.equal(exchange.account(owner).trades.length, 1);
  api.exchangeSettlement.commitSettlement = commit;
  await complete(sale); await complete(sale);
  const market = exchange.market('1h');
  assert.equal(market.trades, 2);
  assert.equal(market.volumeFthx, (BigInt(buy.output) + 10n).toString());
  assert.equal(market.volumeFthDollar, (BigInt(buy.amount) + BigInt(sell.output)).toString());
  assert.equal(market.notes[0].history.source, 'executed-trades');
  assert.equal(market.notes[0].history.currency, 'FTHX');
  assert.equal(market.notes[1].history.currency, 'FTH$');
  const finalPoint = market.notes[0].history.points.at(-1);
  assert.equal(finalPoint.numerator, String(10n * 10n ** 18n));
  assert.equal(finalPoint.denominator, sell.output);
  const stale = exchange.market('24h', Date.now() + 86400001);
  assert.equal(stale.trades, 0); assert.equal(stale.notes[0].history.points.length, 0);
});
