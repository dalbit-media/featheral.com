const demoNotice = '<div class="demo-notice"><b>LOCAL DEMO</b> No real funds, monetary value, blockchain settlement or fulfillment. Layer 3-inspired interface only.</div>';
const assetDecimals = { 'FTH$': 6, FTHX: 0, 'USD$': 6, 'BTC$': 6, 'ETH$': 6, 'SOL$': 6 };
const minimumAfterSlippage = (output, bps) => Number((BigInt(output) * BigInt(10000 - bps) + 9999n) / 10000n);
function displayAsset(value, symbol) {
  const decimals = assetDecimals[symbol] ?? 0;
  return (value / 10 ** decimals).toLocaleString(undefined, { maximumFractionDigits: Math.min(decimals, ({ "FTH$": 2, FTHG: 4, FTHS: 4, FTHX: 2 })[symbol] ?? decimals) });
}
function rawAmount(value, symbol) {
  const decimals = assetDecimals[symbol] ?? 0;
  return (value / 10 ** decimals).toFixed(decimals);
}
async function templateHome() {
  const slug = info.siteSettings.homeSlug;
  const home = await api(`/api/public/texts/by-slug/${encodeURIComponent(slug)}`);
  const stories = await api('/api/public/texts?sort=newest&limit=12');
  const website = !!document.querySelector('meta[name=site-base]');
  view().innerHTML = `<section class="site-home">
    <div class="home-hero"><div class="eyebrow">${esc(info.brand)} / ${website ? 'Hosted by Featheral Sites' : 'Independent by design'}</div>
      <h1>${esc(home.title)}</h1>${(website ? home.paragraphs : [home.paragraphs[0] || '']).map(paragraph => `<p class="hero-lead">${esc(paragraph)}</p>`).join('')}
      <div class="project-actions"><a class="btn primary" href="#/read">${website ? 'Browse pages' : 'Explore the stories'}</a><a class="btn" href="#/page/${encodeURIComponent(slug)}">About this site</a></div>
      <div class="hero-art" aria-hidden="true"><span>F</span><i></i><i></i><i></i></div>
    </div><div class="home-grid">${stories.items.filter((p) => p.slug !== slug).map((p, i) => `
      <a class="home-card" href="${p.type === 'page' ? `#/page/${encodeURIComponent(p.slug)}` : `#/read/${p.id}`}">
        <div class="card-art"><span>0${i + 1}</span></div><div class="eyebrow">Featheral / ${p.type || 'Story'}</div>
        <h2>${esc(p.title)}</h2><p>${esc(p.snippet)}</p><span class="card-link">Discover more &rarr;</span></a>`).join('')}</div>
    <footer class="site-footer">${esc(info.siteSettings.footer || 'Built with Featheral CMS. Independent by design.')}
      <nav aria-label="Site pages">${info.pages.filter((p) => p.slug !== slug).map((p) => `<a href="#/page/${encodeURIComponent(p.slug)}">${esc(p.title)}</a>`).join('')}</nav>
    </footer>
  </section>`;
}
function bindDemoForm(form, endpoint, fields, done) {
  let pending = null; let key = '';
  const status = document.createElement('p');
  status.className = 'form-feedback'; status.setAttribute('role', 'status'); form.append(status);
  let submitting = false;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submitting) return;
    const button = form.querySelector('button[type=submit]');
    submitting = true; button.disabled = true; status.textContent = 'Preparing demo operation…';
    try {
      if (!wallet.address && !await connectWallet()) return;
      const values = fields();
      const next = JSON.stringify(values);
      if (key !== next) { key = next; pending = { ...values, requestId: crypto.randomUUID() }; }
      status.textContent = 'Submitting demo operation…';
      const result = await api(endpoint, { json: pending });
      pending = null; key = '';
      await done(result);
    } catch (e) { status.textContent = e.message; toast(e.message); }
    finally { submitting = false; button.disabled = false; }
  });
}
async function demoWallet(el, refresh) {
  el.innerHTML = `<div class="demo-account">${wallet.address ? `<b>${esc(short(wallet.address))}</b>` : '<b>Connect a wallet to use demo credits</b>'}
    <button class="btn" type="button" data-demo-connect>${wallet.address ? 'Refresh balances' : 'Connect wallet'}</button>
    <button class="btn primary" type="button" data-faucet ${wallet.address ? '' : 'hidden'}>Claim demo credits</button><div data-balances></div></div>`;
  const load = async () => {
    if (!wallet.address) return;
    const account = await api('/api/public/demo/account');
    el.querySelector('[data-balances]').innerHTML = account.assets.map((a) => `<span class="balance-pill">${esc(a.symbol)} <b>${displayAsset(a.balance, a.symbol)}</b></span>`).join('');
    el.querySelector('[data-faucet]').disabled = account.faucetUsed;
    el.querySelector('[data-faucet]').textContent = account.faucetUsed ? 'Demo credits claimed' : 'Claim demo credits';
    return account;
  };
  el.querySelector('[data-demo-connect]').addEventListener('click', async () => {
    try {
      if (!wallet.address) { await connectWallet(); return; }
      await refresh();
    } catch (e) { toast(e.message); }
  });
  let pending = { requestId: crypto.randomUUID() };
  el.querySelector('[data-faucet]').addEventListener('click', async (event) => {
    const button = event.currentTarget; button.disabled = true;
    try {
      await api('/api/public/demo/faucet', { json: pending });
      pending = { requestId: crypto.randomUUID() };
      toast('Demo credits added. No real funds.'); await load(); await refreshBalance(); await refresh();
    } catch (e) { toast(e.message); button.disabled = false; }
  });
  return load();
}
async function shopDemo() {
  if (cleanup) { cleanup(); cleanup = null; }
  const products = await api('/api/public/shop/products');
  const home = info.pages.some((p) => p.slug === info.siteSettings.homeSlug)
    ? await api(`/api/public/texts/by-slug/${encodeURIComponent(info.siteSettings.homeSlug)}`) : null;
  let cart = store.get('demo-cart', {});
  if (!cart || typeof cart !== 'object' || Array.isArray(cart)) cart = {};
  cart = Object.fromEntries(Object.entries(cart).filter(([id, n]) => products.some((p) => String(p.id) === id) && Number.isInteger(n) && n > 0 && n <= 100));
  let alive = true;
  view().innerHTML = `<section class="site-home shop-home">${demoNotice}
    <div class="shop-heading"><div class="eyebrow">${esc(info.brand)} / Curated demo collection</div><h1>${esc(home?.title || 'The demo collection')}</h1><p>${esc(home?.paragraphs[0] || 'Browse, build a cart and checkout with local FTHX credits.')}</p></div>
    <div id="demo-wallet"></div><div class="commerce-layout"><div class="home-grid products">
    ${products.map((p, i) => `<article class="home-card"><div class="card-art"><span>${['F', 'X', '*'][i % 3]}</span></div>
      <h2>${esc(p.title)}</h2><p>${esc(p.description)}</p><div class="product-price">${p.price} FTHX <span>${p.stock} available</span></div>
      <button class="btn primary" type="button" data-cart-add="${p.id}" ${p.stock ? '' : 'disabled'}>Add to cart</button></article>`).join('')}
    </div><aside class="demo-panel"><h2>Your cart</h2><div id="cart-items"></div>
      <form id="checkout-form"><button class="btn primary" type="submit">Demo checkout</button></form><p class="muted">No real shipment. Catalog prices and stock are verified when ordering.</p>
      <div id="order-confirmation" role="status"></div></aside></div><section class="demo-panel"><h2>Your demo orders</h2><div id="my-orders"></div></section></section>`;
  const refreshOrders = async () => {
    const orders = wallet.address ? await api('/api/public/shop/orders') : [];
    if (!alive) return;
    $('#my-orders').innerHTML = orders.length ? orders.map((o) => `<p>Order #${o.id} &middot; ${o.total} FTHX &middot; ${esc(o.status)}<br>${o.items.map((p) => `${esc(p.title)} × ${p.quantity}`).join(', ')}</p>`).join('') : '<p>Connect a wallet or place your first demo order.</p>';
  };
  const drawCart = () => {
    store.set('demo-cart', cart);
    $('#cart-items').innerHTML = Object.entries(cart).map(([id, n]) => {
      const p = products.find((p) => String(p.id) === id);
      return `<p>${esc(p.title)} <label class="cart-quantity">Quantity <input type="number" data-quantity="${id}" value="${n}" min="1" max="${Math.min(100,p.stock)}" step="1" aria-label="Quantity for ${esc(p.title)}"></label>
        <b>${p.price * n} FTHX</b> <button class="btn" type="button" data-remove="${id}">Remove</button></p>`;
    }).join('') || '<p>Your cart is empty.</p>';
    const total = Object.entries(cart).reduce((sum,[id,n]) => sum + products.find((p) => String(p.id) === id).price * n,0);
    $('#cart-items').insertAdjacentHTML('beforeend', `<p class="cart-total">Total <b>${total} FTHX</b></p>`);
    $('#cart-items').querySelectorAll('[data-quantity]').forEach((input) => input.addEventListener('change', () => {
      const quantity = Number(input.value);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > Number(input.max)) {
        toast('Choose a whole quantity within available stock.'); drawCart(); return;
      }
      cart[input.dataset.quantity] = quantity; drawCart();
    }));
    $('#cart-items').querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => { delete cart[b.dataset.remove]; drawCart(); }));
    $('#checkout-form button').disabled = !Object.keys(cart).length;
  };
  view().querySelectorAll('[data-cart-add]').forEach((b) => b.addEventListener('click', () => {
    const p = products.find((p) => String(p.id) === b.dataset.cartAdd);
    const quantity = (cart[p.id] || 0) + 1;
    if (quantity > Math.min(p.stock, 100)) { toast('Maximum available quantity reached'); return; }
    cart[p.id] = quantity; drawCart();
  }));
  bindDemoForm($('#checkout-form'), '/api/public/shop/checkout', () => ({
    items: Object.entries(cart).map(([id, quantity]) => ({ id: Number(id), quantity })),
    expectedTotal: Object.entries(cart).reduce((sum, [id, n]) => sum + products.find((p) => String(p.id) === id).price * n, 0),
  }), async (result) => {
    cart = {}; store.set('demo-cart', cart);
    await shopDemo();
    $('#order-confirmation').textContent = `Order #${result.orderId} recorded: ${result.total} FTHX. Demo only; no fulfillment.`;
  });
  const onWallet = () => { shopDemo().catch((e) => toast(e.message)); };
  document.addEventListener('wallet', onWallet);
  cleanup = () => { alive = false; document.removeEventListener('wallet', onWallet); };
  drawCart(); await demoWallet($('#demo-wallet'), shopDemo); await refreshOrders();
}
async function exchangeDemo() {
  if (cleanup) { cleanup(); cleanup = null; }
  const data = await api('/api/public/exchange/pools');
  const home = info.pages.some((page) => page.slug === info.siteSettings.homeSlug)
    ? await api(`/api/public/texts/by-slug/${encodeURIComponent(info.siteSettings.homeSlug)}`) : null;
  const pools = data.pools;
  let chosen = Number(store.get('demo-pool', pools[0]?.id));
  if (!pools.some((p) => p.id === chosen)) chosen = pools[0]?.id;
  let alive = true; let quote = null; let quoteVersion = 0;
  const p = () => pools.find((p) => p.id === chosen);
  view().innerHTML = `<section class="exchange-home">${demoNotice}<div class="exchange-title"><div><div class="eyebrow">Featheral / Layer 3-inspired local simulation</div>
    <h1>${esc(home?.title || 'Featheral Exchange')}</h1><p>${esc(home?.paragraphs[0] || 'FTH$ base markets. Native demo assets. Transparent constant-product pools.')}</p></div><span class="exchange-badge">FTH$ BASE</span></div>
    <div id="demo-wallet"></div><div class="exchange-layout"><section class="demo-panel"><h2>Markets</h2>
      <div class="market-list">${pools.map((p) => `<button class="market-row ${p.id === chosen ? 'selected' : ''}" type="button" data-pool="${p.id}">
        <b>${esc(p.symbol)} / FTH$</b><span>${p.fee_bps / 100}% fee</span>
        <small>${displayAsset(p.base, 'FTH$')} FTH$ / ${displayAsset(p.quote, p.symbol)} ${esc(p.symbol)}</small></button>`).join('')}</div>
      <div class="pool-stats" id="pool-stats"></div>
      <h3>Your pool shares</h3><div id="positions"></div>
      <h3>Recent demo activity</h3><div id="exchange-history"></div>
    </section><section class="demo-panel"><h2>Swap</h2><form id="swap-form" class="demo-form">
      <label>From<select name="from"></select></label><label>Amount<input name="amount" inputmode="decimal" value="10" required></label>
      <label>Slippage tolerance<select name="slippage"><option value="50">0.5%</option><option value="100" selected>1%</option><option value="300">3%</option></select></label>
      <button class="btn" id="get-quote" type="button">Get quote</button><div id="swap-quote" role="status">Request a quote before swapping.</div>
      <button class="btn primary" type="submit" disabled>Execute demo swap</button>
    </form><hr><h2>Add liquidity</h2><p>Only the proportional amounts are used. Fees accrue to the pool; prices and withdrawal value can change.</p>
    <form id="add-form" class="demo-form"><label>Maximum FTH$<input name="baseAmount" inputmode="decimal" value="100" required></label>
      <label>Maximum paired asset<input name="quoteAmount" inputmode="decimal" value="100" required></label>
      <label>Minimum LP shares<input name="minShares" type="number" min="1" step="1" value="1" required></label>
      <button class="btn primary" type="submit">Add demo liquidity</button></form>
    <hr><h2>Remove liquidity</h2><form id="remove-form" class="demo-form">
      <label>LP shares to burn<input name="shares" type="number" min="1" step="1" required></label>
      <label>Minimum FTH$ output<input name="minBase" inputmode="decimal" value="0.000001" required></label>
      <label>Minimum paired-asset output<input name="minQuote" inputmode="decimal" value="1" required></label>
      <button class="btn" type="submit">Withdraw demo liquidity</button></form>
    </section></div><section class="demo-panel"><h2>Create a base pair</h2><p>Every pool pairs with FTH$. Supported demo assets only. One pool per pair.</p>
      <form id="create-pool-form" class="demo-form create-pool">
        <label>Paired asset<select name="symbol">${data.assets.filter((a) => a.symbol !== 'FTH$' && !pools.some((p) => p.symbol === a.symbol)).map((a) => `<option>${esc(a.symbol)}</option>`).join('')}</select></label>
        <label>Initial FTH$<input name="baseAmount" inputmode="decimal" value="100" required></label>
        <label>Initial pair amount<input name="quoteAmount" inputmode="decimal" value="10" required></label>
        <label>Fee tier<select name="feeBps"><option value="5">0.05%</option><option value="30" selected>0.30%</option><option value="100">1.00%</option></select></label>
        <button class="btn primary" type="submit">Create demo pool</button>
      </form><p>1,000 initial LP units remain permanently locked. Seed liquidity is simulated treasury liquidity. Not investment advice.</p></section></section>`;
  const swapForm = $('#swap-form');
  swapForm.elements.from.innerHTML = `<option>${esc('FTH$')}</option><option>${esc(p().symbol)}</option>`;
  $('#pool-stats').innerHTML = `<p>Selected: <b>${esc(p().symbol)} / FTH$</b><br>Total LP units: ${fmtNum(p().shares)}<br>Fee: ${p().fee_bps / 100}%</p>`;
  view().querySelectorAll('[data-pool]').forEach((b) => b.addEventListener('click', () => {
    store.set('demo-pool', Number(b.dataset.pool)); exchangeDemo().catch((e) => toast(e.message));
  }));
  const invalidate = () => { quote = null; quoteVersion++; $('#swap-form button[type=submit]').disabled = true; $('#swap-quote').textContent = 'Request a new quote.'; };
  swapForm.addEventListener('input', invalidate);
  $('#get-quote').addEventListener('click', async () => {
    const version = ++quoteVersion;
    try {
      const result = await api('/api/public/exchange/quote', { json: { poolId: chosen, from: swapForm.elements.from.value, amount: swapForm.elements.amount.value } });
      if (!alive || version !== quoteVersion) return;
      quote = { ...result, deadline: Date.now() + 180000, amountText: swapForm.elements.amount.value };
      const min = minimumAfterSlippage(quote.output, Number(swapForm.elements.slippage.value));
      $('#swap-quote').textContent = `Receive ${displayAsset(quote.output, quote.to)} ${quote.to}. Minimum ${displayAsset(min, quote.to)}. Fee ${quote.feeBps / 100}%. Price impact including fee ${(quote.impactBps / 100).toFixed(2)}%. Quote expires in 3 minutes.`;
      $('#swap-form button[type=submit]').disabled = min < 1;
    } catch (e) { toast(e.message); }
  });
  const success = async (r) => { toast(`Demo ${r.to ? 'swap' : 'liquidity operation'} completed`); await exchangeDemo(); await refreshBalance(); };
  bindDemoForm(swapForm, '/api/public/exchange/swap', () => {
    if (!quote) throw new Error('Request a quote first');
    return { poolId: chosen, from: quote.from, amount: quote.amountText, deadline: quote.deadline,
      minOutput: minimumAfterSlippage(quote.output, Number(swapForm.elements.slippage.value)) };
  }, success);
  bindDemoForm($('#add-form'), '/api/public/exchange/liquidity/add', () => {
    const values = Object.fromEntries(new FormData($('#add-form')));
    return { ...values, poolId: chosen, minShares: Number(values.minShares) };
  }, success);
  const parseMinimum = (text, symbol) => {
    const decimals = assetDecimals[symbol]; const [whole, fraction = ''] = text.split('.');
    if (!/^\d+(\.\d+)?$/.test(text) || fraction.length > decimals) throw new Error(`Enter a valid ${symbol} amount`);
    const n = Number(BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0'));
    if (!Number.isSafeInteger(n) || n < 1) throw new Error('Minimum output must be positive');
    return n;
  };
  bindDemoForm($('#remove-form'), '/api/public/exchange/liquidity/remove', () => {
    const v = Object.fromEntries(new FormData($('#remove-form')));
    return { poolId: chosen, shares: Number(v.shares), minBase: parseMinimum(v.minBase, 'FTH$'), minQuote: parseMinimum(v.minQuote, p().symbol) };
  }, success);
  $('#create-pool-form button').disabled = !$('#create-pool-form select').options.length;
  bindDemoForm($('#create-pool-form'), '/api/public/exchange/pools', () => {
    const v = Object.fromEntries(new FormData($('#create-pool-form'))); return { ...v, feeBps: Number(v.feeBps) };
  }, success);
  const onWallet = () => { exchangeDemo().catch((e) => toast(e.message)); };
  document.addEventListener('wallet', onWallet);
  cleanup = () => { alive = false; document.removeEventListener('wallet', onWallet); };
  const account = await demoWallet($('#demo-wallet'), exchangeDemo);
  if (!alive) return;
  $('#positions').innerHTML = account?.positions.length ? account.positions.map((pos) => `<p>${esc(pools.find((p) => p.id === pos.poolId)?.symbol)} / FTH$ &middot; ${fmtNum(pos.shares)} LP units</p>`).join('') : '<p>No wallet liquidity positions.</p>';
  $('#exchange-history').innerHTML = account?.activity.length ? account.activity.map((op) => `<p>${esc(op.kind.replaceAll('_', ' '))} &middot; ${esc(new Date(op.at).toLocaleString())}</p>`).join('') : '<p>No demo activity yet.</p>';
}
