const { test } = require('node:test');
const assert = require('node:assert/strict');
const { portfolio } = require('../../notes/portfolio');
const { createMarketPriceReader, positionAmounts, sqrtPriceAtTick, VALUATION_POOL } = require('../../gold/prices');
const unit = 10n ** 18n;
function openingGold() {
  return { chain: { id: 1, tokenAddress: '0xba658127d93b17e577e1b8e8995cab3ae7d7c665' }, checkedAt: new Date().toISOString(),
    bridge: { configured: true, deployed: true, initialized: false, paused: false, reserveFthg: '0', reserveFthDollar: '0',
      actualFthgBalance: '0', totalStakedFthg: '0', spotRateFthDollarPerFthg: '0' },
    usdMarket: { usdPerFthg: String(2n * unit), updatedAt: new Date().toISOString() } };
}
test('initialized native Gold reserve values wallet assets even without a deployed Ethereum bridge', () => {
  const gold = { ...openingGold(), bridge: { configured: false, deployed: false, initialized: false },
    goldReserve: { enabled: true, initialized: true, tokenAddress: '0xba658127d93b17e577e1b8e8995cab3ae7d7c665',
      rate: '1000', cap: String(1000n * unit), allocated: String(320n * unit), remaining: String(680n * unit),
      genesisHash: '0x' + '11'.repeat(32), evidence: { block: 26318664, hash: '0x' + '22'.repeat(32) } },
    usdMarket: { usdPerFthg: '10000000000000000', updatedAt: new Date().toISOString(), fallback: true } };
  const input = [{ symbol: 'FTHX', balance: '352120' }];
  const pool = { funded: false, dollars: '0', fthx: 0, version: 0 };
  const result = portfolio(input, pool, [], gold);
  assert.equal(result.goldReference.source, 'native-reserve');
  assert.equal(result.totals.FTHG.value, '3521200000000000000');
  assert.equal(result.usdValue, '35212000000000000');
  assert.equal(result.assets[0].usdValue, result.usdValue);
  assert.match(result.source, /1 FTHG = 1000 FTH\$.*obligations/);
  for (const change of [{ enabled: false }, { initialized: false }, { rate: '0' }, { rate: 'bad' },
    { tokenAddress: 'wrong' }, { tokenAddress: 1 }, { remaining: '1' }, { cap: '0' }, { genesisHash: '' }, { evidence: {} }]) {
    const invalid = portfolio(input, pool, [], { ...gold, goldReserve: { ...gold.goldReserve, ...change } });
    assert.equal(invalid.goldReference, null);
    assert.equal(invalid.usdValue, null);
  }
});
test('per-asset USD estimates use exact FTHG reference conversions and preserve dust and unavailable prices', () => {
  const gold = openingGold();
  gold.usdMarket = { usdPerFthg: '10000000000000000', updatedAt: new Date().toISOString(), fallback: true };
  const holdings = [{ symbol: 'FTH$', balance: String(10000n * unit) }, { symbol: 'FTHX', balance: '500000' },
    { symbol: 'FTHA', balance: '500000' }, { symbol: 'FTHB', balance: '1' }, { symbol: 'FTHC', balance: '0' }];
  const markets = [{ symbol: 'FTHA', funded: true, price: { numerator: '1', denominator: '1' } }];
  const extra = { ethereum: { chainId: 1, token: gold.chain.tokenAddress, balance: String(unit), checkedAt: gold.checkedAt },
    native: { market: { usdPerEth: String(2000n * unit), updatedAt: new Date().toISOString() },
      balances: [{ chainId: 8453, name: 'Base', balance: String(unit), checkedAt: new Date().toISOString() }] } };
  const result = portfolio(holdings, { funded: false, dollars: '0', fthx: 0, version: 0 }, markets, gold, extra);
  assert.deepEqual(result.assets.map(asset => asset.usdValue), ['10000000000000000', '5000000000000000', '5000000000000000', null, '0']);
  assert.equal(result.ethereumUsdValue, '10000000000000000');
  assert.equal(result.nativeAssets[0].usdValue, String(2000n * unit), 'ETH retains its independent USD feed');
  const missing = portfolio(holdings, { funded: false, dollars: '0', fthx: 0, version: 0 }, markets,
    { ...gold, usdMarket: null }, extra);
  assert.equal(missing.ethereumUsdValue, null);
  assert.deepEqual(missing.assets.map(asset => asset.usdValue), [null, null, null, null, '0']);
  assert.equal(missing.nativeAssets[0].usdValue, String(2000n * unit));
});
test('verified initial Gold opening values Dollar, FTHX, notes, Ethereum and separate World against live FTHG/USD', () => {
  const gold = openingGold(), pool = { funded: false, dollars: '0', fthx: 0, version: 0 };
  const holdings = [{ symbol: 'FTH$', balance: String(10000n * unit) }, { symbol: 'FTHX', balance: '500000' },
    { symbol: 'FTHA', balance: '500000' }];
  const markets = [{ symbol: 'FTHA', funded: true, price: { numerator: '1', denominator: '1' } }];
  const extra = { world: { available: String(10000n * unit), duplicate: false },
    ethereum: { chainId: 1, token: gold.chain.tokenAddress, balance: String(unit), checkedAt: gold.checkedAt } };
  const result = portfolio(holdings, pool, markets, gold, extra);
  assert.equal(result.fthg, String(4n * unit));
  assert.equal(result.usd, '8.00');
  assert.equal(result.worldUsdValue, String(2n * unit));
  assert.equal(result.totals['FTH$'].value, String(40000n * unit));
  assert.equal(result.totals.FTHX.value, String(4000000n * unit));
  assert.equal(result.totals.FTHG.value, String(4n * unit));
  assert.equal(result.partial, false);
  assert.deepEqual(result.goldReference, { numerator: String(10000n * unit * unit), denominator: String(unit),
    currency: 'FTH$', decimals: 18, source: 'opening', indicative: true });
  assert.match(result.source, /1 FTHG = 10000 FTH\$/);
  const linked = portfolio(holdings, pool, markets, gold, { ...extra, world: { ...extra.world, duplicate: true } });
  assert.equal(linked.fthg, String(3n * unit));
  assert.equal(linked.worldUsdValue, '0');
  const repriced = portfolio(holdings, pool, markets, { ...gold,
    usdMarket: { ...gold.usdMarket, usdPerFthg: String(3n * unit) } }, extra);
  assert.equal(repriced.usd, '12.00');
  const funded = { ...gold, bridge: { ...gold.bridge, initialized: true, reserveFthg: String(2n * unit),
    reserveFthDollar: String(10000n * unit), actualFthgBalance: String(2n * unit) } };
  const live = portfolio(holdings, pool, markets, funded, extra);
  assert.equal(live.fthg, String(7n * unit));
  assert.equal(live.usd, '14.00');
  assert.equal(live.goldReference.source, 'bridge');
  assert.equal(live.goldReference.indicative, false);
  const changed = portfolio(holdings, pool, markets, { ...funded,
    bridge: { ...funded.bridge, reserveFthDollar: String(20000n * unit) } }, extra);
  assert.equal(changed.fthg, String(4n * unit));
  assert.equal(changed.usd, '8.00');
});
test('Gold opening never masks unknown, stale, paused, malformed, mismatched or previously initialized states', () => {
  const gold = openingGold(), pool = { funded: false, dollars: '0', fthx: 0, version: 0 };
  const holdings = [{ symbol: 'FTH$', balance: String(unit) }];
  const invalid = [
    null, {}, { ...gold, error: 'RPC offline' }, { ...gold, priceError: 'Mismatch' },
    { ...gold, pendingSettlement: true }, { ...gold, chain: { ...gold.chain, id: 5 } },
    { ...gold, chain: { ...gold.chain, tokenAddress: 'wrong' } }, { ...gold, chain: { id: 1 } },
    { ...gold, checkedAt: new Date(Date.now() - 61000).toISOString() },
    { ...gold, checkedAt: new Date(Date.now() + 31000).toISOString() },
    ...[{ configured: false }, { configured: undefined }, { deployed: false }, { initialized: true }, { initialized: undefined },
      { paused: true }, { paused: undefined }, { reserveFthg: '1' }, { reserveFthDollar: '1' }, { actualFthgBalance: '1' },
      { reserveFthg: '-1' }, { reserveFthg: 'bad' }, { reserveFthg: String(2n ** 256n) }, { actualFthgBalance: undefined },
      { initialized: true, reserveFthg: String(unit), reserveFthDollar: String(10000n * unit), actualFthgBalance: '0' },
      { initialized: true, reserveFthg: String(unit), reserveFthDollar: '0', actualFthgBalance: String(unit) },
      { totalStakedFthg: '1' }, { totalStakedFthg: undefined }, { spotRateFthDollarPerFthg: undefined },
      { error: 'Read failed' }, { priceError: 'Custody mismatch' }, { pendingSettlement: true }]
      .map(bridge => ({ ...gold, bridge: { ...gold.bridge, ...bridge } })),
  ];
  for (const snapshot of invalid) {
    const result = portfolio(holdings, pool, [], snapshot);
    assert.equal(result.goldReference, null, JSON.stringify(snapshot));
    assert.equal(result.fthg, null);
    assert.equal(result.usd, null);
    assert.equal(result.partial, true);
  }
  for (const usdMarket of [
    null, { ...gold.usdMarket, updatedAt: new Date(Date.now() - 301000).toISOString() },
    { ...gold.usdMarket, updatedAt: new Date(Date.now() + 31000).toISOString() },
    ...['0', '-1', 'bad', null, 2].map(usdPerFthg => ({ ...gold.usdMarket, usdPerFthg })),
    { ...gold.usdMarket, error: 'Feed unavailable' }, { ...gold.usdMarket, token: 'wrong' },
  ]) {
    const result = portfolio(holdings, pool, [], { ...gold, usdMarket });
    assert.equal(result.goldReference.source, 'opening');
    assert.equal(result.usd, null);
    assert.equal(result.partial, true);
  }
});
test('opening Gold accounting retains arbitrary integer precision with no numeric conversion', () => {
  const balance = 10n ** 55n + 123456789012345678n;
  const result = portfolio([{ symbol: 'FTH$', balance: balance.toString() }],
    { funded: false, dollars: '0', fthx: 0, version: 0 }, [], openingGold());
  assert.equal(result.fthg, String(balance / 10000n));
  assert.equal(result.usdValue, String(balance / 10000n * 2n));
  assert.equal(result.totals.FTHX.value, String(balance * 100n));
});
test('unconfigured or currently undeployed bridge status does not prove a never-funded opening state', () => {
  const gold = openingGold(), pool = { funded: false, dollars: '0', fthx: 0, version: 0 };
  for (const bridge of [
    { configured: false, deployed: false, initialized: false },
    { configured: true, deployed: false, address: '0x1111111111111111111111111111111111111111', initialized: false },
  ]) {
    const result = portfolio([{ symbol: 'FTH$', balance: String(unit) }], pool, [], { ...gold, bridge });
    assert.equal(result.goldReference, null, 'current configuration/code absence is not historical initialization evidence');
    assert.equal(result.usd, null);
    assert.equal(result.totals.FTHG.partial, true);
    assert.equal(result.dollarReference.source, 'opening');
  }
  const discardedStats = portfolio([{ symbol: 'FTH$', balance: String(unit) }], pool, [], { usdMarket: gold.usdMarket, error: null });
  assert.equal(discardedStats.goldReference, null, 'market data alone cannot verify bridge state or mainnet snapshot freshness');
});
test('opening estimates use 100 FTHX per FTH$ then follow funded Exchange reserves, including notes and World', () => {
  const holdings = [{ symbol: 'FTH$', balance: String(2n * unit) }, { symbol: 'FTHX', balance: '50' }, { symbol: 'FTHA', balance: '4' }];
  const markets = [{ symbol: 'FTHA', funded: true, price: { numerator: '3', denominator: '2' } }];
  const gold = { chain: { id: 1 }, checkedAt: new Date().toISOString(),
    bridge: { deployed: true, initialized: true, paused: false, reserveFthg: String(unit), actualFthgBalance: String(unit), reserveFthDollar: String(10n * unit) },
    usdMarket: { usdPerFthg: String(2n * unit), updatedAt: new Date().toISOString() } };
  const extra = { world: { available: String(unit) } };
  const openingPool = { funded: false, dollars: '0', fthx: 0, version: 0 };
  const opening = portfolio(holdings, openingPool, markets, gold, extra);
  assert.equal(opening.totals.FTHX.value, String(356n * unit));
  assert.equal(opening.pricedFthDollar, String(356n * unit / 100n));
  assert.equal(opening.usd, '0.71');
  assert.equal(opening.partial, false);
  assert.equal(opening.dollarReference.source, 'opening');
  assert.equal(opening.dollarReference.indicative, true);
  assert.match(opening.source, /No executable liquidity/);
  const changed = portfolio(holdings, { funded: true, dollars: String(100n * unit), fthx: 5000, version: 2 }, markets, gold, extra);
  assert.equal(changed.totals.FTHX.value, String(206n * unit));
  assert.equal(changed.usd, '0.82');
  assert.equal(changed.dollarReference.source, 'exchange');
  assert.equal(changed.dollarReference.indicative, false);
  for (const pool of [{ ...openingPool, priceError: 'Reserves invalid' }, { ...openingPool, error: 'Reader failed' },
    { ...openingPool, paused: true }, { ...openingPool, version: 1 }, { ...openingPool, pendingSettlement: true },
    { funded: false }, { funded: true, dollars: 'bad', fthx: 100 }, { funded: true, dollars: String(unit), fthx: Number.MAX_SAFE_INTEGER + 1 }]) {
    const unavailable = portfolio(holdings, pool, markets, gold, extra);
    assert.equal(unavailable.dollarReference, null);
    assert.equal(unavailable.totals.FTHX.partial, true);
  }
  const noUsd = portfolio(holdings, openingPool, markets, null, extra);
  assert.equal(noUsd.totals.FTHX.value, String(356n * unit));
  assert.equal(noUsd.usd, null);
  assert.ok(noUsd.usdUnpriced.includes('Internal assets USD unavailable'));
});
test('all-network totals and token equivalents use the selected main currency without losing precision', () => {
  const gold = { chain: { id: 1 }, checkedAt: new Date().toISOString(), bridge: { deployed: true, initialized: true, paused: false,
    reserveFthg: String(unit), reserveFthDollar: String(10n * unit), actualFthgBalance: String(unit) },
    usdMarket: { usdPerFthg: String(2n * unit), updatedAt: new Date().toISOString() } };
  const ethereum = { balance: String(3n * unit), chainId: 1, token: '0xba658127d93b17e577e1b8e8995cab3ae7d7c665', checkedAt: new Date().toISOString() };
  const holdings = [{ symbol: 'FTH$', balance: String(10n * unit) }, { symbol: 'FTHX', balance: '20' }, { symbol: 'FTHA', balance: '4' }];
  const pool = { funded: true, dollars: String(100n * unit), fthx: 1000 };
  const markets = [{ symbol: 'FTHA', funded: true, price: { numerator: '3', denominator: '2' } }];
  const extra = { ethereum, world: { available: String(20n * unit), duplicate: false } };
  const result = portfolio(holdings, pool, markets, gold, extra);
  assert.equal(result.totals['FTH$'].value, String(626n * unit / 10n));
  assert.equal(result.totals.FTHX.value, String(626n * unit));
  assert.equal(result.totals.FTHG.value, String(626n * unit / 100n));
  assert.equal(result.usd, '12.52');
  assert.ok(Object.values(result.totals).every(total => total.decimals === 18 && !total.partial));
  assert.equal(result.assets[2].estimates.FTHX, String(6n * unit));
  const unfunded = portfolio(holdings, { funded: false }, markets, gold, extra);
  assert.equal(unfunded.totals.FTHX.value, String(26n * unit));
  assert.equal(unfunded.totals.FTHX.partial, true);
  assert.deepEqual(unfunded.totals.FTHX.unpriced, ['FTH$', 'World funds', 'Ethereum FTHG']);
  const reserved = portfolio([{ symbol: 'FTHG', balance: '999' }], pool, [], gold);
  assert.equal(reserved.totals.FTHG.value, '0'); assert.equal(reserved.totals.FTHG.partial, true);
});
test('combined totals include Ethereum and separate World funds once, with explicit partial valuation', () => {
  const ethereum = { balance: String(3n * unit), chainId: 1, token: '0xba658127d93b17e577e1b8e8995cab3ae7d7c665', checkedAt: new Date().toISOString() };
  const gold = { chain: { id: 1 }, checkedAt: new Date().toISOString(), bridge: { deployed: true, initialized: true, paused: false,
    reserveFthg: String(unit), reserveFthDollar: String(10n * unit), actualFthgBalance: String(unit) },
    usdMarket: { usdPerFthg: String(2n * unit), updatedAt: new Date().toISOString() } };
  const holdings = [{ symbol: 'FTH$', balance: String(10n * unit) }], pool = { funded: false };
  const extra = { ethereum, world: { available: String(20n * unit), duplicate: false } };
  const result = portfolio(holdings, pool, [], gold, extra);
  assert.equal(result.pricedFthDollar, String(30n * unit)); assert.equal(result.fthg, String(6n * unit)); assert.equal(result.usd, '12.00');
  assert.equal(result.partial, false);
  assert.equal(portfolio(holdings, pool, [], gold, { ...extra, world: { ...extra.world, duplicate: true } }).fthg, String(4n * unit));
  const partial = portfolio(holdings, pool, [], { usdMarket: gold.usdMarket }, extra);
  assert.equal(partial.fthg, ethereum.balance); assert.equal(partial.usd, '6.00'); assert.equal(partial.partial, true);
  for (const invalid of [{ ...ethereum, chainId: 5 }, { ...ethereum, token: 'wrong' }, { ...ethereum, checkedAt: new Date(Date.now() - 61000).toISOString() }]) {
    const result = portfolio(holdings, pool, [], gold, { ethereum: invalid });
    assert.equal(result.ethereumFthg, null); assert.equal(result.partial, true);
  }
  const missing = portfolio(holdings, pool, [], gold, { ethereumError: 'RPC offline', worldError: 'World unavailable' });
  assert.equal(missing.partial, true); assert.equal(missing.unpriced.length, 2);
});
test('portfolio values all priced notes through actual FTHX/Dollar reserves and excludes unpriced holdings', () => {
  const holdings = [{ symbol: 'FTH$', balance: String(10n * unit) }, { symbol: 'FTHX', balance: '20' },
    { symbol: 'FTHA', balance: '4' }, { symbol: 'FTHB', balance: '99' }];
  const pool = { funded: true, dollars: String(100n * unit), fthx: 1000 };
  const markets = [{ symbol: 'FTHA', funded: true, price: { numerator: '3', denominator: '2' } }];
  const gold = { chain: { id: 1 }, bridge: { deployed: true, initialized: true, paused: false,
    reserveFthg: String(2n * unit), reserveFthDollar: String(100n * unit), actualFthgBalance: String(2n * unit) },
    usdMarket: { usdPerFthg: String(5n * unit), updatedAt: new Date().toISOString() }, checkedAt: new Date().toISOString() };
  const result = portfolio(holdings, pool, markets, gold);
  assert.equal(result.pricedFthDollar, String(126n * unit / 10n));
  assert.equal(result.fthg, String(252n * unit / 1000n));
  assert.equal(result.usd, '1.26');
  assert.deepEqual(result.unpriced, ['FTHB']);
  assert.equal(result.assets[2].fthDollarValue, String(6n * unit / 10n));
  assert.equal(result.assets[3].fthDollarValue, null);
  assert.equal(portfolio(holdings, { ...pool, funded: false }, markets, gold).pricedFthDollar, String(10n * unit));
  assert.equal(portfolio(holdings, pool, markets).fthg, null);
  assert.equal(portfolio(holdings, pool, markets, { ...gold, chain: { id: 5 } }).usd, null);
  assert.equal(portfolio(holdings, pool, markets, { ...gold, bridge: { ...gold.bridge, paused: true } }).fthg, null);
  assert.equal(portfolio(holdings, pool, markets, { ...gold, bridge: { ...gold.bridge, actualFthgBalance: '0' } }).fthg, null);
  assert.equal(portfolio(holdings, pool, markets, { ...gold, checkedAt: new Date(Date.now() - 61000).toISOString() }).fthg, null);
  assert.equal(portfolio(holdings, pool, markets, { ...gold, usdMarket: { ...gold.usdMarket, updatedAt: new Date(Date.now() - 301000).toISOString() } }).usd, null);
});
function poolProvider(state) {
  const { ethers } = require('ethers');
  const iface = new ethers.Interface(['function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)', 'function getLiquidity(bytes32) view returns (uint128)']);
  return { calls: 0, async getBlockNumber() { if (state.offline) throw new Error('RPC offline'); return 26337500; },
    async call(tx) {
      this.calls++;
      assert.equal(tx.to.toLowerCase(), VALUATION_POOL.stateView.toLowerCase());
      const call = iface.parseTransaction({ data: tx.data });
      assert.equal(call.args[0], VALUATION_POOL.poolId);
      return call.name === 'getSlot0' ? iface.encodeFunctionResult('getSlot0', [state.sqrt, 177284, 0, 2500])
        : iface.encodeFunctionResult('getLiquidity', [state.liquidity]);
    } };
}
test('Gold values FTHG from the read-only Uniswap v4 ETH/FTHG pool and otherwise publishes the labeled $0.01 reference', async () => {
  const { ethers } = require('ethers');
  const now = 1793570000000, token = '0xba658127d93b17e577e1b8e8995cab3ae7d7c665';
  assert.equal(VALUATION_POOL.poolId, '0x3f1f8a9867d8f4a59f206b9644fafe05e9546323c0219dd1352187bbb5738fdd');
  assert.equal(VALUATION_POOL.currency1, ethers.getAddress(token));
  assert.ok(Object.isFrozen(VALUATION_POOL), 'pool setting is read-only');
  // sqrtPriceX96 = sqrt(50,000,000 FTHG/ETH) * 2^96.
  const sqrt = 7071n * 2n ** 96n, eth = { usdPerEth: String(2000n * unit) };
  const expected = (2000n * unit * 2n ** 192n / (sqrt * sqrt)).toString();
  for (const [state, ethUsd, valid] of [
    [{ sqrt, liquidity: 10n }, async () => eth, true],
    [{ sqrt: 0n, liquidity: 10n }, async () => eth, false],
    [{ sqrt, liquidity: 0n }, async () => eth, false],
    [{ sqrt, liquidity: 10n, offline: true }, async () => eth, false],
    [{ sqrt, liquidity: 10n }, async () => ({ usdPerEth: null, error: 'ETH down' }), false],
    [{ sqrt, liquidity: 10n }, undefined, false],
  ]) {
    const errors = [], provider = poolProvider(state);
    const read = createMarketPriceReader({ provider, ethUsd, clock: () => now, logger: { error: (...args) => errors.push(args) } });
    const result = await read();
    assert.equal(result.fallback, !valid);
    assert.equal(result.error, null);
    assert.equal(result.token, token);
    assert.equal(result.pool, VALUATION_POOL.poolId);
    assert.equal(result.updatedAt, new Date(now).toISOString());
    if (valid) {
      assert.equal(result.usdPerFthg, expected);
      assert.equal(result.fthgPerEth, (sqrt * sqrt * unit / 2n ** 192n).toString());
      assert.match(result.source, /Uniswap v4/);
    } else {
      assert.equal(result.usdPerFthg, '10000000000000000');
      assert.match(result.source, /1 FTHG = \$0.01/);
      assert.ok(result.marketError); assert.equal(errors.length, 1);
    }
    const calls = provider.calls;
    assert.deepEqual(await read(), result); assert.equal(provider.calls, calls, 'cached for one minute');
  }
  let time = now;
  const state = { sqrt, liquidity: 0n };
  const read = createMarketPriceReader({ provider: poolProvider(state), ethUsd: async () => eth, clock: () => time, logger: { error() {} } });
  const fallback = await read();
  assert.equal(fallback.fallback, true);
  const gold = { ...openingGold(), usdMarket: { ...fallback, updatedAt: new Date().toISOString() } };
  const value = portfolio([{ symbol: 'FTHX', balance: '1000000' }],
    { funded: false, dollars: '0', fthx: 0, version: 0 }, [], gold);
  assert.equal(value.fthg, String(unit));
  assert.equal(value.usdValue, '10000000000000000');
  assert.match(value.source, /Temporary indicative reference/);
  state.liquidity = 5n; time += 60001;
  const live = await read();
  assert.equal(live.fallback, false);
  assert.equal(live.usdPerFthg, expected);
  const priced = portfolio([{ symbol: 'FTHX', balance: '1000000' }], { funded: false, dollars: '0', fthx: 0, version: 0 }, [],
    { ...openingGold(), usdMarket: { ...live, updatedAt: new Date().toISOString() } });
  assert.equal(priced.usdValue, expected, 'every currency derives from the pool FTHG value');
  state.offline = true; time += 60001;
  assert.equal((await read()).fallback, true, 'pool failure returns to the explicit reference, not a stale quote');
});
test('Gold reports exact Uniswap v4 pool reserves from this pool\'s liquidity ranges, scanning logs incrementally', async () => {
  const { ethers } = require('ethers');
  assert.equal(sqrtPriceAtTick(887272), 1461446703485210103287273052203988822378723970342n);
  assert.equal(sqrtPriceAtTick(-887272), 4295128739n);
  assert.equal(sqrtPriceAtTick(0), 2n ** 96n);
  const event = new ethers.Interface(['event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)']);
  const log = (tickLower, tickUpper, delta) => event.encodeEventLog('ModifyLiquidity',
    [VALUATION_POOL.poolId, ethers.ZeroAddress, tickLower, tickUpper, delta, ethers.ZeroHash]);
  // The pool's opening full-range position at its on-chain sqrtPriceX96: 0.02 ETH and 1,000,000 FTHG.
  const sqrt = 560222128702570272483239940334470n, liquidity = 141422765105245725354n;
  const [eth, fthg] = positionAmounts(liquidity, -887250, 887250, sqrt);
  assert.ok(eth > 19999n * 10n ** 12n && eth < 20001n * 10n ** 12n, String(eth));
  assert.ok(fthg > 999999n * unit && fthg <= 1000000n * unit, String(fthg));
  const ranges = [];
  const provider = { ...poolProvider({ sqrt, liquidity }), async getLogs(filter) {
    assert.equal(filter.address, VALUATION_POOL.poolManager);
    assert.equal(filter.topics[1], VALUATION_POOL.poolId);
    assert.ok(filter.toBlock - filter.fromBlock < 5000, 'public RPC log ranges stay under 5,000 blocks');
    ranges.push([filter.fromBlock, filter.toBlock]);
    return filter.fromBlock === 26337402 ? [log(-887250, 887250, liquidity), log(-100, 100, 5n), log(-100, 100, -5n)].map((entry) => ({ ...entry })) : [];
  } };
  let time = 1793570000000;
  const read = createMarketPriceReader({ provider, ethUsd: async () => ({ usdPerEth: String(2000n * unit) }), clock: () => time, logger: { error() {} } });
  const result = await read();
  assert.deepEqual(result.reserves, { eth: eth.toString(), fthg: fthg.toString(), positions: 1, decimals: 18,
    tvlUsd: ((eth * 2000n * unit + fthg * BigInt(result.usdPerFthg)) / unit).toString() });
  assert.deepEqual(ranges, [[26337402, 26337500]]);
  time += 60001;
  await read();
  assert.equal(ranges.length, 1, 'already-scanned blocks are not requested again');
});
test('portfolio retains arbitrary integer precision and never prices reserved notes', () => {
  const huge = 10n ** 55n + 17n;
  const result = portfolio([{ symbol: 'FTH$', balance: huge.toString() }, { symbol: 'FTHG', balance: '100' }],
    { funded: true, dollars: String(unit), fthx: 100 },
    [{ symbol: 'FTHG', reserved: true, funded: true, price: { numerator: '1', denominator: '1' } }]);
  assert.equal(result.pricedFthDollar, huge.toString());
  assert.deepEqual(result.unpriced, ['FTHG']);
  assert.equal(result.usd, null);
});
test('CMS portfolio rejects inconsistent funded reserves rather than retaining their price', async () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const helper = source.slice(source.indexOf('async function walletPortfolio('), source.indexOf('app.setDollarWallet'));
  let invalidDollar = false, invalidNote = false;
  const logs = [];
  const read = vm.runInNewContext(helper + '; walletPortfolio;', {
    portfolioGoldReader: undefined,
    require: () => ({ portfolio }),
    console: { error: (...args) => logs.push(args) },
    dollarExchange: { assertReady() {}, pool: () => ({ funded: true, dollars: String(unit), fthx: 100 }),
      validatePool() { if (invalidDollar) throw new Error('dollar mismatch'); } },
    creation: { markets: { catalog: () => [{ symbol: 'FTHA', funded: true, price: { numerator: '1', denominator: '1' } }],
      pool: () => ({ base: 100, quote: 100 }), poolAccount: () => 'note-pool:FTHA' },
      notes: { balance: () => invalidNote ? 0 : 100 } },
  });
  const holdings = [{ symbol: 'FTH$', balance: String(unit) }, { symbol: 'FTHX', balance: '100' }];
  assert.equal((await read(holdings)).pricedFthDollar, String(2n * unit));
  invalidDollar = true;
  let result = await read(holdings);
  assert.equal(result.pricedFthDollar, String(unit)); assert.match(result.marketError, /dollar mismatch/);
  invalidDollar = false; invalidNote = true;
  result = await read(holdings);
  assert.equal(result.pricedFthDollar, String(unit)); assert.match(result.marketError, /reserves/);
  assert.equal(logs.length, 2);
});
