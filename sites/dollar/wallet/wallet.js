"use strict";

(() => {
  const F = window.FTH;
  const { el, api, fth, usd, money, count, short, timeAgo, stat, emptyRow, kindBadge, txLink, blockLink, accountLink, ethTxLink, state } = F;
  const $ = (id) => document.getElementById(id);
  const FTHG = "0xBa658127d93B17E577E1B8e8995cAB3aE7d7C665";
  const RPC_URL = "https://ethereum-rpc.publicnode.com";
  let snap = { account: "" };
  let account = "";
  let wallet = null;
  let quoteRequest = 0;

  FeatheralProfile.mount($("walletButton"), { primaryCurrency: "fthDollar" });
  $("connectButton").addEventListener("click", () => $("walletButton").click());
  $("refreshButton").addEventListener("click", () => FeatheralProfile.refresh());

  const available = () => (wallet ? BigInt(wallet.fthDollar.available) : 0n);
  const fthgBalance = () => (typeof snap.balances?.fthg === "bigint" ? snap.balances.fthg : null);

  function renderBalance() {
    $("connectButton").hidden = Boolean(account);
    $("refreshButton").hidden = !account;
    if (!account) {
      $("balanceValue").textContent = "— FTH$";
      $("balanceNote").textContent = "Connect a wallet to see your FTH$ balance. Browsing never requires a wallet.";
      $("balanceStats").replaceChildren();
      return;
    }
    if (!snap.balances) {
      $("balanceValue").textContent = "Loading…";
      $("balanceNote").textContent = `Reading balances for ${short(account)}…`;
      return;
    }
    if (!wallet) {
      $("balanceValue").textContent = "Ledger unavailable";
      $("balanceNote").textContent = "The FTH$ ledger API did not respond. Try Refresh.";
      return;
    }
    const balance = BigInt(wallet.fthDollar.balance);
    const fthg = fthgBalance();
    $("balanceValue").textContent = fth(balance);
    $("balanceNote").textContent = `${usd(balance)} est. · ${wallet.profile?.username ? `@${wallet.profile.username} · ` : ""}${short(account)}`;
    const fthgUsd = fthg === null ? 0 : F.toNumber(fthg) * F.USD_PER_FTHG_ESTIMATE;
    const fthDollarUsd = (F.toNumber(balance) * F.USD_PER_FTHG_ESTIMATE) / state.rate;
    $("balanceStats").replaceChildren(
      stat("Available", fth(wallet.fthDollar.available), "Spendable now"),
      stat("Reserved", fth(wallet.fthDollar.reserved), "Held for pending withdrawals"),
      stat("FTHG on Ethereum", fthg === null ? "Unavailable" : `${F.amount(fthg, 4)} FTHG`, fthg === null ? "Mainnet RPC did not respond" : `${money(fthgUsd)} est. · read from Mainnet`),
      stat("Total value est.", money(fthgUsd + fthDollarUsd), "FTH$ + FTHG at the $0.01 / FTHG reference"),
    );
  }

  function renderReceive() {
    $("receiveAddress").textContent = account || "—";
    $("receiveAccount").textContent = account ? F.accountIdFor(account) : "—";
    $("receiveNonce").textContent = wallet ? String(wallet.nonce + 1) : "—";
  }

  function renderActivity() {
    const body = $("activityRows");
    $("activityExplorer").href = account ? F.explorerUrl(`account/${account}`) : "/explorer/";
    if (!account) { body.replaceChildren(emptyRow(7, "Connect a wallet to see its FTH$ activity.")); return; }
    if (!wallet?.history?.length) { body.replaceChildren(emptyRow(7, wallet ? "No FTH$ activity yet. Convert FTHG or ask someone to send you FTH$." : "Loading…")); return; }
    const me = wallet.accountId;
    body.replaceChildren(...wallet.history.map((tx) => {
      const signed = F.signedAmount(tx, me);
      const outgoing = tx.from === me;
      const counterparty = outgoing ? accountLink(tx.to, tx.toWallet) : tx.from ? accountLink(tx.from, tx.fromWallet) : el("span", { className: "muted", textContent: tx.kind === "CREDIT" ? "Bridge" : "Ledger" });
      return el("tr", {},
        el("td", {}, blockLink(tx.height)),
        el("td", {}, kindBadge(tx.kind)),
        el("td", {}, counterparty),
        el("td", { className: `num ${signed?.className || ""}`, textContent: signed?.text || "—" }),
        el("td", { className: "muted", textContent: tx.memo || "" }),
        el("td", { className: "muted", textContent: tx.status === "pending" ? "pending" : timeAgo(tx.time), title: tx.time }),
        el("td", {}, tx.ethTx ? ethTxLink(tx.ethTx) : txLink(tx.hash)),
      );
    }));
  }

  /* Send */
  let resolvedRecipient = null;
  let resolveRequest = 0;
  async function resolveRecipient() {
    const input = $("sendTo").value.trim();
    const request = ++resolveRequest;
    resolvedRecipient = null;
    const note = $("sendToNote");
    note.className = "";
    if (!input) { note.textContent = "Wallet addresses map to their FTH$ account automatically."; return updateSend(); }
    if (F.isAddress(input)) {
      resolvedRecipient = { to: ethers.getAddress(input.toLowerCase()), label: ethers.getAddress(input.toLowerCase()) };
    } else if (F.isAccountId(input)) {
      const id = input.toLowerCase();
      const derived = id.startsWith("0x000000000000000000000000") && !/^0x0{64}$/.test(id) ? ethers.getAddress(`0x${id.slice(26)}`) : "";
      resolvedRecipient = derived ? { to: derived, label: derived } : { to: id, label: `account ${short(id, 10, 6)}` };
    } else if (/^@?[A-Za-z0-9_][A-Za-z0-9_.-]{2,23}$/.test(input)) {
      note.textContent = "Looking up username…";
      try {
        const result = await api(`/fth/search?q=${encodeURIComponent(input.replace(/^@/, ""))}`);
        if (request !== resolveRequest) return;
        if (result.type === "account") {
          const owner = result.accountId.startsWith("0x000000000000000000000000") ? ethers.getAddress(`0x${result.accountId.slice(26)}`) : result.accountId;
          resolvedRecipient = { to: owner, label: `@${input.replace(/^@/, "")} (${short(owner)})` };
        }
      } catch { if (request !== resolveRequest) return; }
    }
    if (resolvedRecipient && account && resolvedRecipient.to.toLowerCase() === account.toLowerCase()) resolvedRecipient = null;
    note.textContent = resolvedRecipient ? `Sending to ${resolvedRecipient.label}` : "Enter a 0x wallet address, a 32-byte account id, or a registered @username (not your own).";
    note.className = resolvedRecipient ? "pos" : "neg";
    updateSend();
  }

  function updateSend() {
    const amount = F.parseAmount($("sendAmount").value);
    const note = $("sendAmountNote");
    let problem = "";
    if (!account) problem = "Connect a wallet to send FTH$.";
    else if (!wallet) problem = "Waiting for the FTH$ ledger…";
    else if ($("sendAmount").value.trim() && (amount === null || amount === 0n)) problem = "Enter a positive amount with up to 18 decimals.";
    else if (amount !== null && amount > available()) problem = `Exceeds your available ${fth(available())}.`;
    note.textContent = problem || (amount ? `≈ ${usd(amount)} est. · available ${fth(available())}` : wallet ? `Available ${fth(available())}` : "\u00a0");
    note.className = problem && $("sendAmount").value.trim() ? "neg" : "";
    $("sendButton").disabled = Boolean(problem) || !amount || !resolvedRecipient;
  }

  function transferMessage({ wallet: from, to, amount, nonce, memo, issuedAt }) {
    const recipientWallet = to.startsWith("0x") && to.length === 42 ? to : "";
    return [
      "Featheral Dollar (FTH$) transfer",
      "",
      `From: ${from}`,
      recipientWallet ? `To: ${recipientWallet}` : `To account: ${to}`,
      `Amount: ${ethers.formatUnits(amount, 18)} FTH$`,
      `Base units: ${amount}`,
      `Nonce: ${nonce}`,
      `Memo: ${memo || "(none)"}`,
      `Issued at: ${issuedAt}`,
      "Ledger: Featheral Dollar L3 (settles to Ethereum Mainnet)",
      "",
      "Signing is free and only authorizes this FTH$ ledger transfer.",
    ].join("\n");
  }

  function setStatus(id, text, kind = "") {
    $(id).textContent = text;
    $(id).className = `status ${kind}`;
  }

  $("sendTo").addEventListener("input", resolveRecipient);
  $("sendAmount").addEventListener("input", updateSend);
  $("sendMax").addEventListener("click", () => { if (wallet) { $("sendAmount").value = ethers.formatUnits(available(), 18).replace(/\.0$/, ""); updateSend(); } });
  $("sendForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const amount = F.parseAmount($("sendAmount").value);
    if (!account || !wallet || !amount || !resolvedRecipient) return;
    const memo = $("sendMemo").value.trim();
    if (/[\u0000-\u001f\u007f]/.test(memo)) { setStatus("sendStatus", "Memo contains unsupported characters.", "err"); return; }
    $("sendButton").disabled = true;
    try {
      setStatus("sendStatus", "Reading your current nonce…");
      const fresh = await api(`/wallets/${account}`);
      const transfer = { wallet: ethers.getAddress(account), to: resolvedRecipient.to, amount: amount.toString(), nonce: fresh.nonce + 1, memo, issuedAt: new Date().toISOString() };
      if (amount > BigInt(fresh.fthDollar.available)) throw new Error(`Exceeds your available ${fth(fresh.fthDollar.available)}.`);
      const message = transferMessage(transfer);
      $("sendMessage").textContent = message;
      $("sendPreview").hidden = false;
      setStatus("sendStatus", "Confirm the signature request in your wallet (free, no gas)…");
      const hexMessage = ethers.hexlify(ethers.toUtf8Bytes(message));
      const signature = await FeatheralProfile.getProvider().request({ method: "personal_sign", params: [hexMessage, transfer.wallet] });
      setStatus("sendStatus", "Submitting to the FTH$ writer node…");
      const result = await api("/fth/transfers", { method: "POST", body: JSON.stringify({ ...transfer, signature }) });
      const link = el("a", { href: F.explorerUrl(`tx/${result.receipt.hash}`), textContent: "view transaction" });
      $("sendStatus").replaceChildren(`Sent ${fth(amount)} to ${resolvedRecipient.label} · sealed in block #${count(result.receipt.height)} · `, link);
      $("sendStatus").className = "status ok";
      $("sendAmount").value = "";
      $("sendMemo").value = "";
      await FeatheralProfile.refresh();
    } catch (error) {
      setStatus("sendStatus", error?.code === 4001 ? "Signature request was rejected in the wallet." : `Transfer failed: ${error.message || error}`, "err");
    } finally {
      updateSend();
    }
  });

  /* Convert (FTHG on Ethereum → FTH$ via the bridge contract) */
  let bridgeAbi = null;
  let tokenAbi = null;
  const bridgeLive = () => Boolean(state.rateLive && state.bridge?.address && !state.bridge?.paused);
  const readProvider = new ethers.JsonRpcProvider(RPC_URL, 1, { staticNetwork: true });
  async function abis() {
    if (!bridgeAbi) {
      const [bridge, token] = await Promise.all([fetch("/shared/abi/FthgGameBridge.json").then((r) => r.json()), fetch("/shared/abi/FeatheralGold.json").then((r) => r.json())]);
      bridgeAbi = bridge.abi;
      tokenAbi = token.abi;
    }
  }

  function renderBridge() {
    const live = bridgeLive();
    $("convertRate").textContent = `1 FTHG = ${state.rate.toLocaleString("en-US", { maximumFractionDigits: 2 })} FTH$ ${live ? "(live spot)" : "(opening)"}`;
    $("bridgeNotice").textContent = live
      ? `Bridge live at ${short(state.bridge.address)}. Quotes come from the on-chain curve and include price impact.`
      : state.bridge?.paused ? "The bridge is paused. Conversions are temporarily disabled." : `The FTHG ⇄ FTH$ bridge pool is not live yet. Quotes use the 1:${F.OPENING_FTH_DOLLAR_PER_FTHG.toLocaleString("en-US")} opening rate; conversion opens once the pool is deployed and funded.`;
    $("convertTarget").textContent = account ? `${short(F.accountIdFor(account), 10, 6)} (your FTH$ account)` : "Your FTH$ account";
    const fthg = fthgBalance();
    $("convertBalance").textContent = `FTHG balance: ${fthg === null ? "—" : `${F.amount(fthg, 4)} FTHG`}`;
    updateQuote();
  }

  async function updateQuote() {
    const request = ++quoteRequest;
    const amount = F.parseAmount($("convertAmount").value);
    const fthg = fthgBalance();
    if (!$("convertAmount").value.trim() || amount === null || amount === 0n) {
      $("convertQuote").textContent = $("convertAmount").value.trim() ? "Invalid amount" : "—";
      $("convertButton").disabled = true;
      return;
    }
    let out = (amount * BigInt(Math.round(state.rate * 1e6))) / 1000000n;
    if (bridgeLive()) {
      try {
        await abis();
        out = await new ethers.Contract(state.bridge.address, bridgeAbi, readProvider).quoteFthDollarOut(amount);
      } catch { /* keep the spot estimate */ }
      if (request !== quoteRequest) return;
    }
    $("convertQuote").textContent = `${fth(out)} · ${usd(out)} est.`;
    const enough = fthg !== null && amount <= fthg;
    $("convertButton").disabled = !(bridgeLive() && account && enough);
    $("convertButton").title = !bridgeLive() ? "Bridge pool not live yet" : !account ? "Connect a wallet" : !enough ? "Amount exceeds your FTHG balance" : "";
  }

  $("convertAmount").addEventListener("input", updateQuote);
  $("convertMax").addEventListener("click", () => { const fthg = fthgBalance(); if (fthg !== null) { $("convertAmount").value = ethers.formatUnits(fthg, 18).replace(/\.0$/, ""); updateQuote(); } });
  $("convertForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const amount = F.parseAmount($("convertAmount").value);
    if (!amount || !bridgeLive() || !account) return;
    $("convertButton").disabled = true;
    try {
      await abis();
      const provider = new ethers.BrowserProvider(FeatheralProfile.getProvider());
      if (Number((await provider.getNetwork()).chainId) !== 1) throw new Error("Switch your wallet to Ethereum Mainnet first.");
      const signer = await provider.getSigner(account);
      const bridge = new ethers.Contract(state.bridge.address, bridgeAbi, signer);
      const token = new ethers.Contract(FTHG, tokenAbi, signer);
      const quote = await bridge.quoteFthDollarOut(amount);
      const minOut = (quote * 99n) / 100n;
      const accountId = F.accountIdFor(account);
      if (!confirm(`Convert ${ethers.formatUnits(amount, 18)} FTHG into about ${fth(quote)} (minimum ${fth(minOut)})?\nFTH$ will be credited to ${accountId}.\nThis sends Ethereum transactions and costs gas.`)) return;
      if ((await token.allowance(account, state.bridge.address)) < amount) {
        setStatus("convertStatus", "Approve FTHG for the bridge in your wallet…");
        await (await token.approve(state.bridge.address, amount)).wait();
      }
      setStatus("convertStatus", "Confirm the conversion in your wallet…");
      const tx = await bridge.convertFthg(amount, minOut, accountId);
      setStatus("convertStatus", `Submitted ${short(tx.hash, 10, 6)} · waiting for confirmation…`);
      await tx.wait();
      $("convertStatus").replaceChildren("Confirmed on Ethereum. FTH$ is credited once the writer seals the bridge event. ", ethTxLink(tx.hash));
      $("convertStatus").className = "status ok";
      $("convertAmount").value = "";
      await FeatheralProfile.refresh();
    } catch (error) {
      setStatus("convertStatus", error?.code === 4001 || error?.code === "ACTION_REJECTED" ? "Request was rejected in the wallet." : `Conversion failed: ${error.shortMessage || error.message || error}`, "err");
    } finally {
      updateQuote();
    }
  });

  /* Lookup + copy */
  $("lookupForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const q = $("lookupInput").value.trim();
    if (q) window.location.href = F.explorerUrl(`search/${encodeURIComponent(q)}`);
  });
  document.querySelectorAll("[data-copy]").forEach((button) => button.addEventListener("click", () => {
    const text = $(button.dataset.copy).textContent;
    if (text && text !== "—") F.copy(text, button);
  }));

  function render() {
    renderBalance();
    renderReceive();
    renderActivity();
    renderBridge();
    resolveRecipient();
  }

  window.addEventListener("featheral:wallet", (event) => {
    snap = event.detail;
    account = snap.account ? ethers.getAddress(snap.account.toLowerCase()) : "";
    wallet = snap.wallet || null;
    render();
  });
  render();
  F.loadRate().then(render);
})();
