"use strict";
(() => {
  const notesPage = document.body.dataset.siteBrand === "notes.featheral.com";
  const sitesPage = document.querySelector('meta[name="site-directory"]')?.content === "true";
  const exchangePage = document.body.dataset.siteBrand === "ex.featheral.com";
  if (!notesPage && !sitesPage && !exchangePage) return;
  const hostUrl = name => `${location.protocol}//${location.hostname.endsWith(".localhost") ? `${name}.localhost` : `${name}.featheral.com`}${location.port ? `:${location.port}` : ""}/`;
  const ledgerUrl = symbol => `${hostUrl("ledger")}${symbol === "FTH$" ? "explorer/" : `?currency=${encodeURIComponent(symbol)}`}`;
  const el = (tag, text, className) => { const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; };
  const noteColors = {
    A: "#f59e0b", B: "#2563eb", C: "#06b6d4", D: "#385e9d", E: "#10b981", F: "#d946ef",
    G: "#d4a017", H: "#d99a26", I: "#6366f1", J: "#00a86b", K: "#aaa06a", L: "#84cc16",
    M: "#db2777", N: "#243b75", O: "#f97316", P: "#9333ea", Q: "#b89ac9", R: "#ef4444",
    S: "#94a3b8", T: "#14b8a6", U: "#4166f5", V: "#8b5cf6", W: "#f1f5f9", X: "#59616c",
    Y: "#eab308", Z: "#71717a",
  };
  function noteHeading(note) {
    const heading = el("h3");
    if (["FTH$", "FTHS"].includes(note.symbol)) {
      const icon = el("img"); icon.src = `/shared/logo-${note.symbol === "FTH$" ? "dollar" : "silver"}.svg`;
      icon.alt = ""; icon.width = 32; icon.height = 32; heading.append(icon);
    } else {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 64 64"); svg.setAttribute("aria-hidden", "true"); svg.classList.add("note-feather");
      const color = /^FTH[A-Z]$/.test(note.symbol) ? noteColors[note.symbol.slice(-1)] : "#a855d7";
      for (const [tag, attrs] of [
        ["circle", { cx: 32, cy: 32, r: 30, fill: "#172033", stroke: color, "stroke-width": 2 }],
        ["path", { d: "M48 12C30 12 18 24 16 44l-4 8 8-4c20-2 32-14 28-36z", fill: color }],
        ["path", { d: "M16 44L40 20", stroke: "#172033", "stroke-width": 2, fill: "none" }],
      ]) {
        const shape = document.createElementNS(svg.namespaceURI, tag);
        for (const [key, value] of Object.entries(attrs)) shape.setAttribute(key, value);
        svg.append(shape);
      }
      heading.append(svg);
    }
    heading.append(el("span", note.symbol)); return heading;
  }
  function priceTrend(note) {
    const interval = document.querySelector("#note-chart-interval").value;
    const range = {
      "1h": { label: "1-hour", start: "1h ago", samples: 13 },
      "24h": { label: "24-hour", start: "24h ago", samples: 24 },
      "7d": { label: "7-day", start: "7d ago", samples: 28 },
      "30d": { label: "30-day", start: "30d ago", samples: 30 },
    }[interval];
    const points = note.history?.points || [];
    const prices = points.map(point => Number(point.numerator) / Number(point.denominator));
    const change = prices.length > 1 ? (prices[prices.length - 1] / prices[0] - 1) * 100 : null;
    const chart = el("figure", "", "note-price-trend");
    const caption = el("figcaption");
    const formatPrice = ratio => {
      const numerator = BigInt(ratio.numerator), denominator = BigInt(ratio.denominator);
      const digits = ({ "FTH$": 2, FTHG: 4, FTHS: 4, FTHX: 2 })[ratio.currency || "FTHX"] ?? 18;
      const scale = 10n ** BigInt(digits), rounded = (numerator * scale + denominator / 2n) / denominator;
      const fraction = (rounded % scale).toString().padStart(digits, "0").replace(/0+$/, "");
      return (rounded / scale).toLocaleString() + (fraction ? "." + fraction : "");
    };
    const price = el("span", note.price ? `${formatPrice(note.price)} ${note.price.currency || "FTHX"}` : "No market price", "note-price");
    price.title = "Current pool spot ratio. Executable swaps include price impact and a 0.3% pool fee.";
    caption.append(price);
    if (change !== null) caption.append(el("span", `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`, change >= 0 ? "note-change positive" : "note-change negative"));
    chart.append(caption);
    if (!prices.length) {
      chart.append(el("p", "No executed trades in this interval", "note-chart-empty"));
      return chart;
    }
    const low = Math.min(...prices) * 0.98, high = Math.max(...prices) * 1.02;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 360 160"); svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `${note.symbol}: executed ${range.label} prices in ${note.history.currency || "FTHX"}. Current price is the pool spot ratio, not a guaranteed quote.`);
    const shape = (tag, attrs) => {
      const node = document.createElementNS(svg.namespaceURI, tag);
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
      svg.append(node); return node;
    };
    for (const y of [12, 52, 92, 132]) shape("line", { x1: 8, y1: y, x2: 352, y2: y, class: "mock-grid" });
    for (const x of [8, 94, 180, 266, 352]) shape("line", { x1: x, y1: 12, x2: x, y2: 132, class: "mock-grid" });
    const coordinates = prices.map((price, sample) => [
      8 + (Math.max(note.history.from, points[sample].at) - note.history.from) * 344 / (note.history.to - note.history.from),
      132 - (price - low) * 120 / (high - low),
    ]);
    shape("polyline", {
      points: coordinates.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" "),
      fill: "none", stroke: note.symbol === "FTH$" ? "#c8891a" : /^FTH[A-Z]$/.test(note.symbol) ? noteColors[note.symbol.slice(-1)] : "#a855d7",
      "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round",
    });
    if (coordinates.length === 1) shape("circle", { cx: coordinates[0][0], cy: coordinates[0][1], r: 3, fill: noteColors[note.symbol.slice(-1)] || "#a855d7" });
    shape("text", { x: 8, y: 154 }).textContent = range.start;
    shape("text", { x: 352, y: 154, "text-anchor": "end" }).textContent = "Now";
    chart.append(svg);
    return chart;
  }
  let token = localStorage.getItem("featheral-creation-token") || "", address = "";
  let root, account, connect, status, walletListener = false, me, updateCreationForm, trendRequest = 0;
  async function api(path, method = "GET", body, headers = {}) {
    const response = await fetch(`/api/creation${path}`, { method, headers: { "Content-Type": "application/json", "x-creation-token": token, ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = response.headers.get("content-type")?.includes("json") ? await response.json() : await response.text();
    if (!response.ok) throw Object.assign(new Error(result.error || result || `HTTP ${response.status}`), { status: response.status });
    return result;
  }
  const field = (form, name, title, value = "", tag = "input") => {
    const label = el("label", title), input = el(tag);
    input.name = name; input.value = value; input.required = true;
    label.append(input); form.append(label); return input;
  };
  function run(button, work) {
    button.addEventListener("click", async () => {
      button.disabled = true;
      try { await work(); }
      catch (error) { console.error(error); status.textContent = error.message; }
      finally { button.disabled = false; }
    });
  }
  async function sign(message) {
    if (!window.ethereum) throw new Error("This separate payment approval requires the owning browser extension. Built-in wallet sign-in does not authorize payments.");
    const signer = address;
    const accounts = await window.ethereum.request({ method: "eth_accounts" });
    if (accounts[0]?.toLowerCase() !== signer.toLowerCase()) throw new Error("Wallet account changed. Reconnect before signing.");
    const hex = "0x" + [...new TextEncoder().encode(message)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const signature = await window.ethereum.request({ method: "personal_sign", params: [hex, signer] });
    if (address !== signer || (await window.ethereum.request({ method: "eth_accounts" }))[0]?.toLowerCase() !== signer.toLowerCase())
      throw new Error("Wallet changed while signing. Reconnect.");
    return signature;
  }
  async function refresh() {
    const headerWallet = document.querySelector("header [data-central-wallet]");
    const updateHeaderWallet = () => { if (headerWallet) headerWallet.dataset.walletAddress = address; };
    account.replaceChildren();
    if (!token) { address = ""; updateHeaderWallet(); me = null; updateCreationForm?.(); connect.textContent = "Connect wallet"; account.append(el("p", "Connect to see your balance and manage your notes and websites.")); return; }
    try { me = await api("/me"); }
    catch (error) {
      if (error.status !== 401) throw error;
      token = ""; address = ""; localStorage.removeItem("featheral-creation-token");
      updateHeaderWallet();
      me = null; updateCreationForm?.();
      connect.textContent = "Connect wallet"; status.textContent = error.message; return;
    }
    address = me.address; connect.textContent = "Disconnect wallet";
    updateHeaderWallet();
    const raw = BigInt(me.dollar?.available || "0"), dollars = (raw / 10n ** 18n).toString() + (raw % 10n ** 18n ? "." + (raw % 10n ** 18n).toString().padStart(18,"0").slice(0,2) : "");
    account.append(el("p", `${address} · ${me.fthx.toLocaleString()} FTHX · ${me.dollar ? dollars + " FTH$" : "Dollar writer unavailable"}`));
    updateCreationForm?.();
    if (exchangePage) {
      const marketAccount = await api("/markets/account");
      for (const holding of me.holdings) account.append(el("p", `${holding.balance.toLocaleString()} ${holding.symbol}`));
      account.append(el("h3", "Liquidity positions"));
      for (const position of marketAccount.positions) account.append(el("p", `${position.symbol} / FTHX · ${position.shares.toLocaleString()} shares`));
      if (!marketAccount.positions.length) account.append(el("p", "No liquidity positions"));
      account.append(el("h3", "Recent transactions"));
      for (const trade of marketAccount.trades) account.append(el("p", `${new Date(trade.at).toLocaleString()} · ${trade.side} ${trade.symbol} · ${trade.amount} → ${trade.output}`));
      for (const item of marketAccount.liquidity) account.append(el("p", `${new Date(item.at).toLocaleString()} · ${item.action} ${item.symbol} liquidity · ${item.base} FTHX + ${item.notes} notes · ${item.shares} shares`));
      for (const request of me.dollarExchange?.requests || []) {
        const resume = el("button", `Resume Dollar ${request.parameters.funding ? "pool funding" : "swap"} · ${request.status}`);
        run(resume, async () => {
          if (!confirm("Resume this Dollar settlement without duplicating sealed payments?")) return;
          const current = request.status === "prepared" ? await api(`/dollar-pool/${request.id}/refresh`, "POST", {}) : request;
          const signature = current.payment && ["prepared", "awaiting_signature"].includes(current.status) ? await sign(current.message) : undefined;
          await api(`/dollar-pool/${request.id}/complete`, "POST", signature ? { signature } : {});
          status.textContent = "Dollar settlement completed."; await refresh(); await trending();
        });
        account.append(resume);
        if (request.error) account.append(el("p", request.error));
      }
      return;
    }
    {
      for (const holding of me.holdings || []) if (holding.symbol !== "FTHX")
        account.append(el("p", `${holding.balance.toLocaleString()} ${holding.symbol}`));
      account.append(el("h3", "Your notes"));
      for (const note of me.notes) account.append(el("p", `${note.symbol} · ${note.name}`));
    }
    {
      account.append(el("h3", "Your websites"));
      for (const site of me.sites) {
        const card = el("div", "", "creation-panel"), link = el("a", site.site);
        link.href = hostUrl("sites") + site.path.slice(1) + "/"; card.append(link);
        const integration = me.integrations.find(item => item.site === site.key);
        card.append(el("p", integration ? `Linked note: ${integration.symbol}` : "No note linked · Site-only"));
        const edit = el("button", "Edit pages and rewards");
        run(edit, () => editSite(card, site, me.notes)); card.append(edit); account.append(card);
      }
      for (const request of me.requests) {
        const button = el("button", `Resume ${request.slug} (500 FTH$; no duplicate charge)`);
        run(button, async () => {
          if (!confirm("Continue this website request? It costs 500 FTH$. An already sealed payment will not be charged again.")) return;
          const data = await api("/sites/prepare", "POST", { slug: request.slug, name: request.name, ...(request.noteSymbol ? { noteSymbol: request.noteSymbol } : {}) });
          if (data.status !== "complete") {
            const signature = await sign(data.message);
            await api(`/sites/${data.id}/complete`, "POST", { signature });
          }
          status.textContent = "Website is ready."; await refresh();
          document.querySelector(".website-directory")?.dispatchEvent(new Event("featheral:sites-changed"));
        });
        account.append(button);
      }
    }
  }
  async function editSite(card, site, ownedNotes) {
    const base = `/owned/${encodeURIComponent(site.key)}`;
    const [pages, themes, program, settings] = await Promise.all([api(base + "/pages"), api(base + "/theme"), api(base + "/rewards"), api(base + "/settings")]);
    card.replaceChildren(el("h3", site.site));
    const visit = el("a", "View website"); visit.href = hostUrl("sites") + site.path.slice(1) + "/"; visit.target = "_blank"; visit.rel = "noopener"; card.append(visit);
    const profile = el("form");
    const displayName = field(profile, "displayName", "Website name", settings.displayName || site.name); displayName.maxLength = 200;
    const description = field(profile, "description", "Directory description", settings.description); description.maxLength = 500; description.required = false;
    const saveProfile = el("button", "Save website details"); saveProfile.type = "submit"; profile.append(saveProfile);
    profile.addEventListener("submit", async event => {
      event.preventDefault(); saveProfile.disabled = true;
      try {
        await api(base + "/settings", "PUT", { displayName: displayName.value, description: description.value });
        status.textContent = "Website details saved.";
        document.querySelector(".website-directory")?.dispatchEvent(new Event("featheral:sites-changed"));
      }
      catch (error) { console.error(error); status.textContent = error.message; }
      finally { saveProfile.disabled = false; }
    });
    card.append(profile);
    for (const page of pages) {
      const form = el("form");
      field(form, "title", "Page title", page.title);
      const body = field(form, "body", "Page content (safe HTML)", page.body, "textarea");
      body.closest("label").className = "wide";
      const save = el("button", "Save page"); save.type = "submit"; form.append(save);
      form.addEventListener("submit", async event => {
        event.preventDefault(); save.disabled = true;
        try { const updated = await api(`${base}/pages/${page.id}`, "PUT", { title: form.elements.title.value, body: form.elements.body.value, revision: page.revision });
          page.revision = updated.revision; status.textContent = "Page saved."; }
        catch (error) { console.error(error); status.textContent = error.message; }
        finally { save.disabled = false; }
      });
      card.append(form);
    }
    const theme = el("select"); theme.setAttribute("aria-label", "Website theme");
    for (const item of themes.themes) { const option = el("option", typeof item === "string" ? item : item.label || item.name); option.value = typeof item === "string" ? item : item.id; theme.append(option); }
    theme.value = themes.theme;
    const saveTheme = el("button", "Save theme");
    run(saveTheme, async () => { await api(base + "/theme", "PUT", { theme: theme.value }); status.textContent = "Theme saved."; });
    card.append(theme, saveTheme);
    const newPage = el("form");
    field(newPage, "title", "New page title");
    const pageBody = field(newPage, "body", "New page content (safe HTML)", "", "textarea");
    pageBody.closest("label").className = "wide";
    const publish = el("button", "Publish new page"); publish.type = "submit"; newPage.append(publish);
    newPage.addEventListener("submit", async event => {
      event.preventDefault(); publish.disabled = true;
      try { await api(base + "/pages", "POST", { title: newPage.elements.title.value, body: newPage.elements.body.value }); status.textContent = "Page published."; await editSite(card, site, ownedNotes); }
      catch (error) { console.error(error); status.textContent = error.message; }
      finally { publish.disabled = false; }
    });
    card.append(newPage);
    card.append(el("p", "FTH$, FTHX and FTHS are system-native notes, not regular rewards. Only your community notes can reward creators."));
    if (!ownedNotes.length) {
      const link = el("a", "Create a community note to enable rewards"); link.href = hostUrl("notes"); card.append(link); return;
    }
    const rewards = el("form"); rewards.append(el("p", "Reward creators on the first like or comment from another wallet."));
    const symbol = field(rewards, "symbol", "Community reward note", "", "select");
    for (const note of ownedNotes) { const option = el("option", note.symbol); option.value = note.symbol; symbol.append(option); }
    symbol.value = ownedNotes.some(note => note.symbol === program.symbol) ? program.symbol : ownedNotes[0].symbol;
    const linkNote = el("button", "Link this note to website (rewards off)"); linkNote.type = "button";
    run(linkNote, async () => {
      await api(base + "/note", "PUT", { symbol: symbol.value });
      status.textContent = `Linked ${symbol.value}. Enable rewards separately when ready.`;
      document.querySelector(".website-directory")?.dispatchEvent(new Event("featheral:sites-changed"));
      await editSite(card, site, ownedNotes);
    });
    card.append(linkNote);
    const chance = field(rewards, "chance", "Chance (%)", program.chance); chance.type = "number"; chance.min = 1; chance.max = 99;
    const amount = field(rewards, "amount", "Credits per reward", program.amount); amount.type = "number"; amount.min = 1; amount.max = 1000;
    const enabled = field(rewards, "enabled", "Enable rewards"); enabled.type = "checkbox"; enabled.required = false; enabled.checked = !!program.enabled;
    const saveRewards = el("button", "Save rewards"); saveRewards.type = "submit"; rewards.append(saveRewards);
    rewards.addEventListener("submit", async event => {
      event.preventDefault(); saveRewards.disabled = true;
      try { await api(base + "/rewards", "PUT", { symbol: symbol.value, chance: Number(chance.value), amount: Number(amount.value), enabled: enabled.checked }); status.textContent = "Reward program saved."; }
      catch (error) { console.error(error); status.textContent = error.message; }
      finally { saveRewards.disabled = false; }
    });
    card.append(rewards);
  }
  async function mount() {
    root = notesPage || exchangePage ? document.querySelector("#creation-root") : el("section");
    root.className = "creation-panel";
    if (sitesPage) document.querySelector("#view").prepend(root);
    root.append(el("h2", exchangePage ? "Your wallet" : "Mint a note with a website"));
    if (!exchangePage) root.append(el("p", "Mint: 1,000 FTHX + 500 FTH$. Every new note reserves a new website. Rewards start off. Resume a pending site without paying the note fee again."));
    const other = el("a", notesPage ? "Browse websites" : "Mint a note on Featheral Notes");
    other.href = hostUrl(notesPage ? "sites" : "notes"); root.append(other);
    const mintLink = document.querySelector("#sites-link");
    document.querySelector("#notes-link")?.setAttribute("href", hostUrl("notes"));
    if (mintLink) { mintLink.textContent = "Mint a note"; mintLink.href = "#creation-root"; mintLink.addEventListener("click", () => { document.querySelector("#creation-root").closest("details").open = true; }); }
    connect = el("button", "Connect wallet"); root.append(connect);
    account = el("div"); root.append(account);
    status = el("p", "", "creation-status"); status.setAttribute("role", "status"); root.append(status);
    run(connect, async () => {
      if (token) { await api("/logout", "POST", {}); token = ""; address = ""; localStorage.removeItem("featheral-creation-token"); await refresh(); return; }
      if (!window.FeatheralWallet) throw new Error("Central wallet is loading or unavailable. Reload and retry.");
      const authorization = await window.FeatheralWallet.authenticate(address => api("/challenge", "POST", { address }));
      address = authorization.address;
      const session = await api("/login", "POST", authorization);
      token = session.token; localStorage.setItem("featheral-creation-token", token); await refresh();
    });
    if (exchangePage) {
      if (window.ethereum?.on) window.ethereum.on("accountsChanged", () => { token = ""; address = ""; localStorage.removeItem("featheral-creation-token"); refresh().catch(console.error); });
      await refresh(); return;
    }
    const form = el("form");
    const mode = field(form, "mode", "What would you like to create?", "", "select");
    for (const [value, label] of [["site", "Website only"], ["both", "Website with a note"]]) {
      const option = el("option", label); option.value = value; mode.append(option);
    }
    mode.value = notesPage ? "both" : "site";
    const source = field(form, "noteSource", "Note choice", "", "select");
    for (const [value, label] of [["new", "Create a new note · 1,000 FTHX"], ["existing", "Use an owned note · No note creation fee"]]) {
      const option = el("option", label); option.value = value; source.append(option);
    }
    const noteName = field(form, "noteName", "Note name"); noteName.maxLength = 100;
    const symbol = field(form, "symbol", "Symbol (e.g. ART)"); symbol.pattern = "[A-Z][A-Z0-9]{1,15}"; symbol.maxLength = 16;
    const owned = field(form, "ownedSymbol", "Your existing note", "", "select");
    const name = field(form, "name", "Website name"); name.maxLength = 100;
    const slug = field(form, "slug", "Website address (e.g. my-art)"); slug.pattern = "[a-z0-9]+(-[a-z0-9]+)*"; slug.maxLength = 63;
    const create = el("button"); create.type = "submit"; form.append(create); root.append(form);
    const visibility = (input, visible) => { input.disabled = !visible; input.closest("label").hidden = !visible; };
    const updateFields = () => {
      const hasNote = mode.value !== "site", hasSite = mode.value !== "note", newNote = source.value === "new";
      visibility(source, hasNote); visibility(noteName, hasNote && newNote); visibility(symbol, hasNote && newNote);
      visibility(owned, hasNote && !newNote); visibility(name, hasSite); visibility(slug, hasSite);
      create.textContent = `Create / link · ${hasSite ? "500 FTH$" : "No site fee"}${hasNote && newNote ? " + 1,000 FTHX" : ""}`;
    };
    updateCreationForm = () => {
      const previousNote = owned.value;
      owned.replaceChildren();
      for (const note of me?.notes || []) { const option = el("option", `${note.symbol} · ${note.name}`); option.value = note.symbol; owned.append(option); }
      if ([...owned.options].some(option => option.value === previousNote)) owned.value = previousNote;
      updateFields();
    };
    mode.addEventListener("change", updateFields); source.addEventListener("change", updateFields); updateCreationForm();
    form.addEventListener("submit", async event => {
      event.preventDefault(); create.disabled = true;
      try {
        if (!token) throw new Error("Connect your wallet first.");
        const hasNote = mode.value !== "site", hasSite = mode.value !== "note", newNote = source.value === "new";
        const input = { noteName: noteName.value, symbol: symbol.value, ownedSymbol: owned.value, name: name.value, slug: slug.value };
        if (!confirm(`Confirm ${hasSite ? "500 FTH$ site fee" : "no site fee"}${hasNote && newNote ? " and 1,000 FTHX note fee (existing identical note retries do not charge again)" : ""}? Fees go to treasury. Rewards will be configured disabled.`)) return;
        let noteSymbol = hasNote ? input.ownedSymbol : "";
        let request;
        if (hasNote && newNote) {
          const note = await api("/notes", "POST", { name: input.noteName, symbol: input.symbol, site: { name: input.name, slug: input.slug } });
          noteSymbol = note.symbol;
          request = note.request;
          status.textContent = `Note ${noteSymbol} is ready.${hasSite ? " Creating your site next; your note is retained if this step fails." : ""}`;
        }
        if (hasSite) {
          request ||= await api("/sites/prepare", "POST", { name: input.name, slug: input.slug, ...(noteSymbol ? { noteSymbol } : {}) });
          if (request.status !== "complete") {
            const signature = await sign(request.message);
            await api(`/sites/${request.id}/complete`, "POST", { signature });
          }
        }
        status.textContent = hasSite ? noteSymbol ? `Website created and linked to ${noteSymbol}. Rewards are off; manage both below.` : "Website created. Edit its pages below."
          : "Note is ready. Any selected website is linked; enable rewards separately.";
        await refresh(); if (notesPage) await trending();
        document.querySelector(".website-directory")?.dispatchEvent(new Event("featheral:sites-changed"));
      } catch (error) { console.error(error); status.textContent = `${error.message} Any note already created is retained; retry the same note details or select it from your owned notes, and resume any pending site below.`; await refresh().catch(e => { console.error(e); }); }
      finally { create.disabled = false; }
    });
    if (window.ethereum?.on && !walletListener) {
      walletListener = true;
      window.ethereum.on("accountsChanged", () => { token = ""; address = ""; localStorage.removeItem("featheral-creation-token"); refresh().catch(console.error); });
    }
    await refresh();
  }
  async function exchange() {
    const panel = document.querySelector("#exchange-root");
    panel.className = "creation-panel";
    const form = el("form");
    const symbol = field(form, "symbol", "Note / FTHX", "", "select");
    const action = field(form, "action", "Operation", "", "select");
    for (const [value, text] of [["buy", "Buy note"], ["sell", "Sell note"], ["add", "Add liquidity"], ["remove", "Remove liquidity"]]) {
      const option = el("option", text); option.value = value; action.append(option);
    }
    const amount = field(form, "amount", "Input amount (FTHX to buy/add, notes to sell, shares to remove)", "1");
    amount.type = "number"; amount.min = 1; amount.max = 1000000000; amount.step = 1;
    const slippage = field(form, "slippage", "Swap slippage (%)", "0.5");
    slippage.type = "number"; slippage.min = 0; slippage.max = 50; slippage.step = 0.1;
    const submit = el("button", "Get quote"); submit.type = "submit";
    const feedback = el("p"); feedback.setAttribute("role", "status");
    form.append(submit, feedback); panel.append(form);
    let pending;
    const markets = await api("/markets");
    for (const market of markets.markets) {
      const option = el("option", `${market.symbol} / FTHX${market.funded ? "" : " · No liquidity"}`);
      option.value = market.symbol; symbol.append(option);
    }
    form.addEventListener("input", () => { pending = null; submit.textContent = "Get quote"; });
    form.addEventListener("submit", async event => {
      event.preventDefault(); submit.disabled = true;
      try {
        if (!token) throw new Error("Connect your wallet first.");
        const value = Number(amount.value);
        if (!pending) {
          if (["buy", "sell"].includes(action.value)) {
            const quote = await api("/markets/quote", "POST", { symbol: symbol.value, side: action.value, amount: value });
            const bps = Math.round(Number(slippage.value) * 100);
            if (!Number.isInteger(bps) || bps < 0 || bps > 5000) throw new Error("Choose slippage from 0% to 50%.");
            const minOutput = Math.max(1, Number(BigInt(quote.output) * BigInt(10000 - bps) / 10000n));
            pending = { route: "/markets/trade", input: { symbol: symbol.value, side: action.value, amount: value, minOutput, requestId: crypto.randomUUID() } };
            feedback.textContent = `${quote.amount} ${quote.from} → ${quote.output} ${quote.to}. Minimum ${minOutput}. Pool fee 0.3%.`;
          } else {
            const quote = await api("/markets/liquidity/quote", "POST", { symbol: symbol.value, action: action.value, amount: value });
            pending = { route: "/markets/liquidity", input: { ...quote, amount: value, requestId: crypto.randomUUID() } };
            feedback.textContent = `${quote.action} ${quote.base} FTHX + ${quote.notes} ${quote.symbol} · ${quote.shares} shares. Exact amounts must still match on confirmation.`;
          }
          submit.textContent = "Confirm transaction";
        } else {
          if (!confirm("Execute this real ledger transaction? No Ethereum transaction is sent.")) return;
          await api(pending.route, "POST", pending.input);
          pending = null; submit.textContent = "Get quote"; feedback.textContent = "Transaction completed.";
          await refresh(); await trending();
        }
      } catch (error) {
        console.error(error); feedback.textContent = error.message;
        if (error.status === 409) { pending = null; submit.textContent = "Get quote"; }
      }
      finally { submit.disabled = false; }
    });
    const funding = el("details");
    funding.append(el("summary", "FTH$/FTHX initial liquidity · Administrator approval"));
    funding.append(el("p", "Only existing balances from your connected wallet. Initial liquidity is committed to the pool; no FTHX or FTH$ is minted. Swaps remain disabled until funding settles."));
    const fundForm = el("form");
    const dollars = field(fundForm, "dollars", "FTH$ to fund"); dollars.inputMode = "decimal";
    const fthx = field(fundForm, "fthx", "Existing FTHX to fund"); fthx.type = "number"; fthx.min = 1; fthx.max = 1000000000; fthx.step = 1;
    const approval = field(fundForm, "approval", "Exact approval phrase");
    const phrase = el("p"); phrase.setAttribute("role", "status");
    const password = field(fundForm, "password", "Administrator password"); password.type = "password"; password.autocomplete = "off";
    const submitFunding = el("button", "Review & fund"); submitFunding.type = "submit"; fundForm.append(phrase, submitFunding); funding.append(fundForm); panel.append(funding);
    const parseDollar = () => {
      if (!/^\d+(?:\.\d{1,18})?$/.test(dollars.value)) throw new Error("Enter a positive FTH$ amount with at most 18 decimals.");
      const [whole, fraction = ""] = dollars.value.split(".");
      const value = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
      if (value < 1n) throw new Error("Funding must be positive.");
      return value.toString();
    };
    let fundingRequest;
    fundForm.addEventListener("input", () => {
      fundingRequest = null;
      if (/^\d+(?:\.\d{1,18})?$/.test(dollars.value) && /^[1-9]\d*$/.test(fthx.value)) {
        try { phrase.textContent = `Required: FUND FTH$ ${parseDollar()} BASE_UNITS ${fthx.value} FTHX`; }
        catch (error) { phrase.textContent = error.message; }
      }
      else phrase.textContent = "Enter both amounts to see the exact approval phrase.";
    });
    fundForm.addEventListener("submit", async event => {
      event.preventDefault(); submitFunding.disabled = true;
      try {
        if (!token) throw new Error("Connect your funding wallet first.");
        if (!confirm("Commit existing FTH$ and FTHX to the exchange's initial pool? No supply is minted.")) return;
        fundingRequest ||= await api("/dollar-pool/fund", "POST", { dollars: parseDollar(), fthx: fthx.value,
          approval: approval.value, requestId: crypto.randomUUID() }, { Authorization: `Basic ${btoa("admin:" + password.value)}` });
        fundingRequest = await api(`/dollar-pool/${fundingRequest.id}/refresh`, "POST", {});
        const signature = fundingRequest.payment && ["prepared", "awaiting_signature"].includes(fundingRequest.status) ? await sign(fundingRequest.message) : undefined;
        await api(`/dollar-pool/${fundingRequest.id}/complete`, "POST", signature ? { signature } : {});
        password.value = ""; fundingRequest = null; status.textContent = "Initial pool funding settled."; await refresh(); await trending();
      } catch (error) { console.error(error); status.textContent = error.message; }
      finally { password.value = ""; submitFunding.disabled = false; }
    });
  }
  async function trending() {
    const request = ++trendRequest;
    const data = await api(`/trending?interval=${document.querySelector("#note-chart-interval").value}`);
    if (request !== trendRequest) return;
    const grid = document.querySelector("#trending-notes"), nativeGrid = document.querySelector("#native-notes");
    grid.replaceChildren(); nativeGrid?.replaceChildren();
    const formatSupply = (raw, decimals) => {
      const units = BigInt(raw), scale = 10n ** BigInt(decimals);
      const fraction = (units % scale).toString().padStart(decimals, "0").slice(0, 2).replace(/0+$/, "");
      return (units / scale).toLocaleString() + (decimals && fraction ? "." + fraction : "");
    };
    for (const note of data.notes) {
      const card = el("article", "", "note-trending");
      card.append(noteHeading(note));
      if (note.native) {
        card.append(el("p", note.alias ? `${note.name} · ${note.alias}` : note.name));
        card.append(el("p", "System-native · Not earnable through regular rewards"));
        card.append(el("p", note.circulating === null ? "Circulation unavailable — Dollar ledger is not connected."
          : `${formatSupply(note.circulating, note.decimals)} ${note.symbol}`, "note-supply"));
        card.append(el("p", "Total circulating"));
        if (note.supply != null) card.append(el("p", `Total issued: ${formatSupply(note.supply, note.decimals)} ${note.symbol}`));
        if (note.reserved != null && BigInt(note.reserved) > 0n) card.append(el("p", `Reserved for redemption: ${formatSupply(note.reserved, note.decimals)} ${note.symbol}`));
        const currencyExplorerLink = el("a", "Explore ledger activity"); currencyExplorerLink.href = ledgerUrl(note.symbol); card.append(currencyExplorerLink);
        nativeGrid?.append(card);
        const ranked = el("article", "", "note-trending");
        ranked.append(noteHeading(note),
          priceTrend(note),
          el("p", `24h volume · ${note.volume.toLocaleString()} FTHX`, "note-volume"));
        const swap = el("a", "FTH$ ↔ FTHX · Open Exchange");
        swap.href = hostUrl("ex") + "?market=" + encodeURIComponent("FTH$"); ranked.append(swap);
        const ledgerLink = el("a", "Explore ledger activity"); ledgerLink.href = ledgerUrl(note.symbol); ranked.append(ledgerLink);
        grid.append(ranked);
      } else {
        card.append(priceTrend(note));
        card.append(el("p", `24h volume · ${note.volume.toLocaleString()} FTHX`, "note-volume"));
        if (note.quoteCurrency) {
          const trade = el("a", note.funded ? "Trade on Exchange" : "View liquidity on Exchange");
          trade.href = hostUrl("ex") + "?market=" + encodeURIComponent(note.symbol); card.append(trade);
        } else card.append(el("span", "No pool", "note-mock-badge"));
        const ledger = el("a", "Explore ledger activity"); ledger.href = ledgerUrl(note.symbol); card.append(ledger);
        grid.append(card);
      }
    }
    if (!grid.childElementCount) grid.append(el("p", "No community notes yet. Create one below to start a reward program."));
  }
  if (notesPage || exchangePage) {
    document.querySelector("#note-chart-interval").addEventListener("change", () => {
      trending().catch(error => { console.error(error); status.textContent = error.message; });
    });
    run(document.querySelector("#refresh-trending"), trending);
    mount().then(async () => { if (exchangePage) await exchange(); await trending(); }).catch(error => { console.error(error); if (status) status.textContent = error.message; });
  }
  else {
    const observer = new MutationObserver(() => {
      if (!document.querySelector(".website-directory") || document.querySelector(".creation-panel")) return;
      mount().catch(error => { console.error(error); if (status) status.textContent = error.message; });
    });
    observer.observe(document.querySelector("#view"), { childList: true });
  }
})();
