"use strict";
(() => {
  const element = (tag, value, className) => {
    const node = document.createElement(tag);
    if (value !== undefined) node.textContent = value;
    if (className) node.className = className;
    return node;
  };
  const format = (raw, symbol) => {
    const value = BigInt(raw), precision = ["FTH$", "FTHG"].includes(symbol) ? 18 : 0;
    const unit = 10n ** BigInt(precision), fraction = (value % unit).toString().padStart(precision, "0").replace(/0+$/, "");
    return (value / unit).toLocaleString() + (precision && fraction ? "." + fraction : "") + " " + symbol;
  };
  function fundingProgress(reserve, target) {
    if (target === null || target === undefined) return null;
    const goal = BigInt(target);
    if (goal <= 0n) return null;
    const percent = BigInt(reserve) * 10000n / goal;
    return Number(percent > 10000n ? 10000n : percent) / 100;
  }
  function table(caption, headings) {
    const wrapper = element("div", undefined, "market-activity-scroll"), root = element("table");
    root.append(element("caption", caption));
    const head = element("thead"), row = element("tr"), body = element("tbody");
    for (const heading of headings) row.append(element("th", heading));
    head.append(row); root.append(head, body); wrapper.append(root);
    return { wrapper, body };
  }
  function row(body, values) {
    const tr = element("tr");
    for (const value of values) tr.append(element("td", value));
    body.append(tr);
  }
  async function get(path, signal) {
    const response = await fetch("/api/creation/" + path, { cache: "no-store", signal });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || `Activity HTTP ${response.status}`);
    return result;
  }
  function mount(root) {
    root.classList.add("market-activity");
    const heading = element("h2", "Across the economy");
    const intro = element("p", "World settlements, wallet transfers, Exchange movements, note rewards and payments. Activity is not trading volume; only executed trades set price candles.");
    const controls = element("div", undefined, "market-activity-controls");
    const select = (title, items) => {
      const label = element("label", title), input = element("select");
      input.setAttribute("aria-label", title);
      for (const [value, name] of items) {
        const option = element("option", name); option.value = value; input.append(option);
      }
      label.append(input); controls.append(label); return input;
    };
    const interval = select("Window", [["1h", "1 hour"], ["24h", "24 hours"], ["7d", "7 days"], ["30d", "30 days"]]);
    interval.value = "24h";
    const symbol = select("Currency", [["", "All currencies"], ["FTHX", "FTHX"], ["FTH$", "FTH$"], ["FTHS", "FTHS"], ["FTHG", "FTHG (coverage below)"]]);
    const source = select("Activity", [["", "All sources"], ["world", "World settlement"], ["wallet", "Wallet transfers"],
      ["exchange", "Exchange"], ["gold", "Gold channel"], ["app", "App rewards"], ["silver", "Silver payments"], ["notes", "Notes creation"], ["other", "Other notes activity"]]);
    const refresh = element("button", "Refresh activity"); refresh.type = "button"; controls.append(refresh);
    const status = element("p"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
    const charts = element("div", undefined, "market-activity-charts");
    const feed = table("Public financial activity - postings and sealed transactions", ["Time", "Source", "Currency", "Event", "Event amount", "Gross credits", "Gross debits", "Record"]);
    const tape = table("Latest executed pool trades (up to 100)", ["Time", "Pair", "Input", "Output"]);
    const tapeNote = element("p");
    const more = element("button", "Load older activity"); more.type = "button"; more.hidden = true;
    const poolHeading = element("div", undefined, "liquidity-heading");
    poolHeading.append(element("h3", "Liquidity landscape"), element("p", "Actual reserves. Empty pools are opportunities, not executable liquidity."));
    const poolCards = element("div", undefined, "liquidity-cards");
    const poolLegend = element("p", "Bars compare each currency's reserves to its own initial target, not to the other currency. They are not pool value, depth, or token allocation percentages.", "liquidity-legend");
    const liquidityDetails = element("details"), reserves = table("Actual pool reserves", ["Pair", "FTHX reserve", "Token reserve", "Status", "Initial funding needed"]);
    liquidityDetails.append(element("summary", "Base liquidity and funding needs"), reserves.wrapper);
    const policy = element("p"), coverage = element("details"), coverageBody = element("div");
    coverage.append(element("summary", "Coverage and accounting rules"), coverageBody);
    root.replaceChildren(heading, intro, controls, status, poolHeading, poolCards, poolLegend, charts, tape.wrapper, tapeNote, feed.wrapper, more, liquidityDetails, policy, coverage);
    let cursor = null, loading = false, generation = 0, controller, count = 0, timer;
    function renderCharts(data) {
      charts.replaceChildren();
      for (const summary of data.summary) {
        const card = element("article"), values = data.buckets.filter(bucket => bucket.symbol === summary.symbol && bucket.recordType === summary.recordType);
        const max = Math.max(1, ...values.map(bucket => bucket.events));
        card.append(element("h3", `${summary.symbol} / ${summary.recordType}`), element("p", `${summary.events.toLocaleString()} ledger records`),
          element("p", `Gross credits: ${format(summary.credits, summary.symbol)}`),
          element("p", `Gross debits: ${format(summary.debits, summary.symbol)}`));
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 600 100"); svg.setAttribute("role", "img");
        svg.setAttribute("aria-label", `${summary.symbol} activity record counts over time, not prices`);
        for (const bucket of values) {
          const bar = document.createElementNS(svg.namespaceURI, "rect"), title = document.createElementNS(svg.namespaceURI, "title");
          const start = Math.max(data.from, bucket.at), end = Math.min(data.to, bucket.at + data.bucketMs);
          bar.setAttribute("x", String((start - data.from) / (data.to - data.from) * 600));
          bar.setAttribute("y", String(100 - bucket.events / max * 95));
          bar.setAttribute("width", String(Math.max(1, (end - start) / (data.to - data.from) * 600 - 1)));
          bar.setAttribute("height", String(bucket.events / max * 95)); bar.setAttribute("fill", "currentColor");
          title.textContent = `${new Date(bucket.at).toLocaleString()}: ${bucket.events} records; credits ${format(bucket.credits, bucket.symbol)}; debits ${format(bucket.debits, bucket.symbol)}`;
          bar.append(title); svg.append(bar);
        }
        card.append(svg); charts.append(card);
      }
      if (!data.summary.length) {
        const empty = element("article", undefined, "activity-empty");
        const icon = element("span", "///", "activity-empty-icon"); icon.setAttribute("aria-hidden", "true");
        empty.append(icon, element("h3", "A clear view of every move"),
          element("p", "No recorded financial activity in this window. See coverage below for unavailable sources."),
          element("small", "Recorded activity will appear here. No sample transactions are displayed."));
        charts.append(empty);
      }
    }
    function renderPools(liquidity) {
      poolCards.replaceChildren();
      const selected = symbol.value, visible = liquidity.markets.filter(market => !selected || selected === "FTHX" || market.symbol === selected);
      const ordered = [...visible].sort((a, b) => Number(b.status === "funded") - Number(a.status === "funded"));
      for (const market of ordered.slice(0, 6)) {
        const card = element("article", undefined, "liquidity-card"); card.dataset.state = market.status;
        const title = element("div", undefined, "liquidity-pair");
        const tokens = element("span", undefined, "liquidity-tokens"); tokens.setAttribute("aria-hidden", "true");
        tokens.append(element("span", (market.symbol.replace(/^FTH/, "") || "N").slice(0, 2)), element("span", "X"));
        const name = element("div"); name.append(element("h4", `${market.symbol} / FTHX`), element("small", "Constant-product pool"));
        title.append(tokens, name);
        const badge = element("span", market.status.replaceAll("-", " "), "liquidity-status");
        card.append(title, badge);
        for (const [currency, reserve, target] of [
          ["FTHX", market.baseReserve, market.initialTarget?.FTHX],
          [market.symbol, market.tokenReserve, market.initialTarget?.notes],
        ]) {
          const reserveRow = element("div", undefined, "liquidity-reserve");
          reserveRow.append(element("span", currency + " reserve"), element("strong", format(reserve, currency)));
          card.append(reserveRow);
          const percent = fundingProgress(reserve, target), track = element("div", undefined, "liquidity-track");
          track.setAttribute("aria-hidden", "true");
          if (percent !== null) { const fill = element("span"); fill.style.width = percent + "%"; track.append(fill); }
          else track.classList.add("liquidity-track-unscaled");
          card.append(track);
          card.append(element("small", percent === null ? "No initial target defined / reserve shown unscaled"
            : `Initial target: ${format(target, currency)} / ${percent}% (visual capped at 100%)`, "liquidity-target"));
        }
        card.append(element("p", market.status === "funded" ? `${market.feeBps / 100}% fee per trade. Reserves move with actual execution.`
          : market.status === "unfunded" ? "Awaiting approved initial funding. No executable price."
            : market.error || "Unavailable for execution. Check settlement or writer status."));
        const link = element("a", market.status === "funded" ? "View market" : "Review market", "liquidity-link");
        const base = location.hostname.startsWith("ex.") ? "/" : `${location.protocol}//${location.hostname.endsWith(".localhost") ? "ex.localhost" : "ex.featheral.com"}${location.port ? ":" + location.port : ""}/`;
        link.href = base + "?market=" + encodeURIComponent(market.symbol); card.append(link); poolCards.append(card);
        if (market.status === "unfunded") {
          const fund = element("a", "Fund and enable", "liquidity-link");
          fund.setAttribute("aria-label", `Fund and enable ${market.symbol} / FTHX`);
          const admin = `${location.protocol}//${location.hostname.endsWith(".localhost") ? "admin.localhost" : "admin.featheral.com"}${location.port ? ":" + location.port : ""}/`;
          fund.href = market.symbol === "FTH$" ? base + "?market=FTH%24#initial-dollar-funding"
            : admin + "#/notes?site=ex.featheral.com&market=" + encodeURIComponent(market.symbol);
          card.append(fund);
        }
      }
      if (!ordered.length) poolCards.append(element("p", "No internal FTHX pool for this currency. FTHG uses the separate Gold conversion channel."));
      if (ordered.length > 6) poolCards.append(element("p", `Showing 6 of ${ordered.length} pools. Select a currency or expand actual pool reserves below for the full list.`, "liquidity-more"));
    }
    async function load(append = false) {
      if (loading && append) return;
      const current = ++generation;
      controller?.abort(); controller = new AbortController(); loading = true;
      refresh.disabled = true; more.disabled = true;
      const params = new URLSearchParams({ interval: interval.value, symbol: symbol.value, source: source.value, limit: "50" });
      if (append && cursor) params.set("cursor", cursor);
      try {
        status.textContent = "Reading authoritative ledgers...";
        const [data, liquidity, executions] = await Promise.all([get("activity?" + params, controller.signal),
          append ? Promise.resolve(null) : get("liquidity", controller.signal),
          append ? Promise.resolve(null) : get("market-tape?" + new URLSearchParams({ interval: interval.value, symbol: symbol.value }), controller.signal)]);
        if (current !== generation) return;
        if (!append) { feed.body.replaceChildren(); count = 0; }
        for (const entry of data.rows) {
          row(feed.body, [new Date(entry.at).toLocaleString(), entry.source, entry.symbol, entry.kind,
            format(entry.amount, entry.symbol), format(entry.credits, entry.symbol), format(entry.debits, entry.symbol), entry.recordType]);
        }
        if (!append && !data.rows.length) row(feed.body, ["No recorded financial activity in this window.", "", "", "", "", "", "", ""]);
        count += data.rows.length; cursor = data.nextCursor;
        more.hidden = !cursor;
        status.textContent = `${data.partial ? "Partial coverage. " : ""}${count} recent records shown. Window: ${new Date(data.from).toLocaleString()} - ${new Date(data.to).toLocaleString()}.`;
        renderCharts(data);
        for (const summary of data.summary) {
          if (![...symbol.options].some(option => option.value === summary.symbol)) {
            const option = element("option", summary.symbol); option.value = summary.symbol; symbol.append(option);
          }
        }
        if (executions) {
          tape.body.replaceChildren();
          for (const trade of executions.rows) row(tape.body, [new Date(trade.at).toLocaleString(), `${trade.symbol}/FTHX`, format(trade.amount, trade.from), format(trade.output, trade.to)]);
          tapeNote.textContent = executions.description;
          if (!executions.rows.length) row(tape.body, ["No executed trades in this window.", "", "", ""]);
        }
        coverageBody.replaceChildren(...Object.entries(data.coverage).map(([name, value]) => element("p", `${name}: ${value}`)));
        if (liquidity) {
          renderPools(liquidity);
          reserves.body.replaceChildren();
          for (const market of liquidity.markets) {
            row(reserves.body, [`${market.symbol}/FTHX`, format(market.baseReserve, "FTHX"), format(market.tokenReserve, market.symbol),
              market.error || market.status, market.fundingNeeded ? `${format(market.fundingNeeded.FTHX, "FTHX")} + ${format(market.fundingNeeded.notes, market.symbol)}`
                : market.status === "unfunded" ? "Administrator must approve both amounts" : "No automatic top-up"]);
            if (![...symbol.options].some(option => option.value === market.symbol)) {
              const option = element("option", market.symbol); option.value = market.symbol; symbol.append(option);
            }
          }
          policy.textContent = liquidity.policy;
        }
      } catch (error) {
        if (error.name === "AbortError" || current !== generation) return;
        console.error("Market activity unavailable:", error);
        status.textContent = `Activity unavailable: ${error.message}. Previously displayed data, if any, is stale. Refresh to retry.`;
      } finally {
        if (current === generation) { loading = false; refresh.disabled = false; more.disabled = false; }
      }
    }
    for (const input of [interval, symbol, source]) input.addEventListener("change", () => load());
    refresh.addEventListener("click", () => load());
    more.addEventListener("click", () => load(true));
    timer = setInterval(() => {
      if (!root.isConnected) { clearInterval(timer); controller?.abort(); return; }
      if (!document.hidden && !loading && count <= 50) load();
    }, 30000);
    load();
  }
  document.querySelectorAll("[data-market-activity]").forEach(mount);
})();
