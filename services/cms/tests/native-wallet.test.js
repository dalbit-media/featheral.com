const { test } = require('node:test');
const assert = require('node:assert/strict');
const { NETWORKS, createNativeReader } = require('../../gold/native');
const { portfolio } = require('../../notes/portfolio');
const now = 1793570000000, unit = 10n ** 18n, address = '0x1111111111111111111111111111111111111111';
function reader({ failure = null, wrongChain = false, stale = false, balance = unit, usd = 2000 } = {}) {
  const calls = [], errors = [];
  const read = createNativeReader({ clock: () => now, env: {}, logger: { error: (...args) => errors.push(args) },
    fetchRpc: async (url, options) => {
      if (!options.body) { calls.push('price'); return { ok: true, json: async () => ({ ethereum: { usd, last_updated_at: now / 1000 - (stale ? 301 : 0) } }) }; }
      const request = JSON.parse(options.body), network = NETWORKS.find(network => network.rpc === url);
      calls.push({ chainId: network.chainId, ...request });
      if (network.chainId === failure) throw new Error('RPC offline');
      return { ok: true, json: async () => ({ result: request.method === 'eth_chainId' ? '0x' + (wrongChain ? 999 : network.chainId).toString(16)
        : request.method === 'eth_blockNumber' ? '0xabc' : '0x' + balance.toString(16) }) };
    } });
  return { read, calls, errors };
}
test('native ETH reads all six chain identities and pinned balances, coalescing cached public-address reads', async () => {
  const { read, calls, errors } = reader({ balance: 2n ** 255n + 17n });
  const [first, second] = await Promise.all([read(address), read(address.toUpperCase().replace('0X', '0x'))]);
  assert.deepEqual(first, second); assert.deepEqual(await read(address), first);
  assert.equal(calls.length, 19);
  assert.deepEqual(first.balances.map(asset => asset.chainId), [1, 8453, 42161, 10, 324, 59144]);
  assert.ok(first.balances.every(asset => asset.balance === String(2n ** 255n + 17n)));
  assert.ok(calls.filter(call => call.method === 'eth_getBalance').every(call => JSON.stringify(call.params) === JSON.stringify([address, '0xabc'])));
  assert.deepEqual(errors, []);
  await assert.rejects(read('private-key-or-invalid-address'), /Invalid/);
});
test('one RPC failure remains unavailable, never zero, without hiding other network balances', async () => {
  const { read, errors } = reader({ failure: 8453 });
  const result = await read(address);
  assert.equal(result.balances[1].balance, null);
  assert.match(result.balances[1].error, /offline/);
  assert.ok(result.balances.filter(asset => asset.chainId !== 8453).every(asset => asset.balance === String(unit)));
  assert.equal(errors.length, 1);
  const wrong = await reader({ wrongChain: true }).read(address);
  assert.ok(wrong.balances.every(asset => asset.balance === null && /mismatch/.test(asset.error)));
});
test('stale ETH price is explicit and malformed oversized RPC balances are rejected', async () => {
  const stale = await reader({ stale: true }).read(address);
  assert.equal(stale.market.usdPerEth, null); assert.match(stale.market.error, /fresh/);
  const huge = await reader({ balance: 2n ** 256n }).read(address);
  assert.ok(huge.balances.every(asset => asset.balance === null && /Invalid RPC/.test(asset.error)));
});
test('native pricing preserves decimal quotes without floating-point tails', async () => {
  const result = await reader({ usd: 2290.09 }).read(address);
  assert.equal(result.market.usdPerEth, '2290090000000000000000');
});
test('native caches expire independently and per-chain RPC overrides retain chain verification', async () => {
  let time = now, prices = 0, balances = 0, overrides = 0;
  const read = createNativeReader({ clock: () => time, env: { WALLET_RPC_8453: 'https://test.invalid/base' },
    fetchRpc: async (url, options) => {
      if (!options.body) { prices++; return { ok: true, json: async () => ({ ethereum: { usd: 2000, last_updated_at: time / 1000 } }) }; }
      const request = JSON.parse(options.body), chainId = url === 'https://test.invalid/base' ? 8453 : NETWORKS.find(network => network.rpc === url).chainId;
      if (chainId === 8453) overrides++;
      if (request.method === 'eth_getBalance') balances++;
      return { ok: true, json: async () => ({ result: request.method === 'eth_chainId' ? '0x' + chainId.toString(16) : '0x0' }) };
    } });
  await read(address); await read(address);
  assert.equal(balances, 6); assert.equal(prices, 1);
  time += 31000;
  await read(address);
  assert.equal(balances, 12); assert.equal(prices, 1);
  time += 31000;
  await read(address);
  assert.equal(balances, 18); assert.equal(prices, 2); assert.equal(overrides, 9);
});
function native(balances = {}, price = String(2000n * unit)) {
  return { market: { usdPerEth: price, updatedAt: new Date().toISOString() },
    balances: NETWORKS.map(network => ({ chainId: network.chainId, name: network.name, balance: balances[network.chainId] ?? '0', checkedAt: new Date().toISOString() })) };
}
test('portfolio includes mainnet and L2 ETH together with FTHG, internal notes and World in each primary currency', () => {
  const gold = { chain: { id: 1 }, checkedAt: new Date().toISOString(), bridge: { deployed: true, initialized: true, paused: false,
    reserveFthg: String(unit), reserveFthDollar: String(10n * unit), actualFthgBalance: String(unit) },
    usdMarket: { usdPerFthg: String(2n * unit), updatedAt: new Date().toISOString() } };
  const result = portfolio([{ symbol: 'FTH$', balance: String(10n * unit) }, { symbol: 'FTHX', balance: '10' }],
    { funded: true, dollars: String(100n * unit), fthx: 1000 }, [], gold,
    { world: { available: String(20n * unit) }, native: native({ 1: String(unit), 8453: String(2n * unit) }) });
  assert.equal(result.usd, '6006.20');
  assert.equal(result.fthg, String(30031n * unit / 10n));
  assert.equal(result.totals['FTH$'].value, String(30031n * unit));
  assert.equal(result.totals.FTHX.value, String(300310n * unit));
  assert.equal(result.partial, false);
  assert.equal(result.nativeAssets.length, 6);
});
test('native network equivalents use only verified opening Gold references, keeping exact balances and linked World deduplication', () => {
  const gold = { chain: { id: 1, tokenAddress: '0xba658127d93b17e577e1b8e8995cab3ae7d7c665' }, checkedAt: new Date().toISOString(),
    bridge: { configured: true, deployed: true, initialized: false, paused: false, reserveFthg: '0', reserveFthDollar: '0',
      actualFthgBalance: '0', totalStakedFthg: '0', spotRateFthDollarPerFthg: '0' },
    usdMarket: { usdPerFthg: String(2n * unit), updatedAt: new Date().toISOString() } };
  const raw = unit + 17n, nativeGold = raw * 1000n, pool = { funded: false, dollars: '0', fthx: 0, version: 0 };
  const extra = { native: native({ 1: raw.toString(), 8453: raw.toString() }),
    world: { available: String(10000n * unit), duplicate: true } };
  const result = portfolio([{ symbol: 'FTH$', balance: String(10000n * unit) }], pool, [], gold, extra);
  assert.equal(result.nativeAssets[0].balance, raw.toString());
  assert.equal(result.nativeAssets[0].estimates.FTHG, nativeGold.toString());
  assert.equal(result.nativeAssets[0].estimates['FTH$'], String(nativeGold * 10000n));
  assert.equal(result.nativeAssets[0].estimates.FTHX, String(nativeGold * 1000000n));
  assert.equal(result.totals.FTHG.value, String(2n * nativeGold + unit));
  assert.equal(result.usdValue, String(2n * raw * 2000n + 2n * unit));
  assert.equal(result.partial, false);
  const unavailable = portfolio([], pool, [], { ...gold, bridge: { ...gold.bridge, paused: true } }, extra);
  assert.equal(unavailable.goldReference, null);
  assert.equal(unavailable.nativeAssets[0].estimates['FTH$'], null);
  assert.equal(unavailable.nativeAssets[0].estimates.FTHX, null);
  assert.equal(unavailable.nativeAssets[0].estimates.FTHG, nativeGold.toString());
  assert.equal(unavailable.totals['FTH$'].partial, true);
  const noFeed = portfolio([], pool, [], { ...gold,
    usdMarket: { ...gold.usdMarket, updatedAt: new Date(Date.now() - 301000).toISOString() } }, extra);
  assert.equal(noFeed.nativeAssets[0].estimates.FTHG, null);
  assert.equal(noFeed.nativeAssets[0].estimates['FTH$'], null);
  assert.equal(noFeed.nativeAssets[0].estimates.FTHX, null);
});
test('native USD survives unavailable FTHG prices, discloses missing internal values and adds dust before rounding', () => {
  const input = native({ 1: String(3n * 10n ** 12n), 8453: String(3n * 10n ** 12n) });
  const result = portfolio([{ symbol: 'FTH$', balance: String(unit) }], { funded: false }, [], null, { native: input });
  assert.equal(result.usd, '0.01');
  assert.equal(result.fthg, null);
  assert.equal(result.partial, true);
  assert.ok(result.usdUnpriced.includes('Internal assets USD unavailable'));
  assert.ok(result.totals['FTH$'].unpriced.includes('Base ETH'));
  input.balances.push(input.balances[0]);
  assert.equal(portfolio([], { funded: false }, [], null, { native: input }).usd, '0.01');
  input.balances[0].checkedAt = new Date(Date.now() - 61000).toISOString();
  const stale = portfolio([], { funded: false }, [], null, { native: input });
  assert.equal(stale.nativeAssets[0].balance, null);
  assert.ok(stale.totals.FTHG.unpriced.includes('Ethereum ETH unavailable'));
  assert.equal(portfolio([], { funded: false }, [], null, { native: { ...input, balances: [] } }).nativeAssets.length, 6);
});
