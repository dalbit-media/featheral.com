"use strict";
(() => {
  const $ = id => document.getElementById(id);
  let current = null, cardRequest = null, revision = 0;
  const notify = (message, error = false) => {
    $("status").textContent = message; $("status").dataset.error = String(error);
    if (error) console.error("Featheral Pay:", message);
  };
  const displayAmount = raw => {
    const rounded = (BigInt(raw) + 5n * 10n ** 15n) / 10n ** 16n;
    const fraction = (rounded % 100n).toString().padStart(2, "0").replace(/0+$/, "");
    return rounded === 0n ? "<0.01" : `${rounded / 100n}${fraction ? "." + fraction : ""}`;
  };
  function invalidate() {
    revision++; current = null; cardRequest = null;
    $("request-result").hidden = true; $("empty-request").hidden = false;
    $("print-card").disabled = true;
    $("card-qr").hidden = true; $("card-qr").removeAttribute("src");
    $("card-qr-placeholder").hidden = false;
    $("card-name").textContent = "Your name. Your wallet.";
    $("card-name").dataset.long = "false";
    $("card-wallet").textContent = "Your public wallet ID appears here";
  }
  async function getRequest(params) {
    const response = await fetch("/api/v1/pay/requests?" + params, { cache: "no-store", credentials: "omit" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Payment service unavailable.");
    return result;
  }
  function loadQr(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("QR code could not be loaded. Create the request again to retry."));
      image.src = url;
    });
  }
  async function generate(params, incoming = false) {
    invalidate();
    const version = revision;
    $("generate").disabled = true;
    notify("Preparing your payment request...");
    try {
      const request = await getRequest(params);
      if (version !== revision) return;
      const reusable = await getRequest(new URLSearchParams({ to: request.to, name: request.name, currency: "FTH$" }));
      if (version !== revision) return;
      $("request-name").textContent = request.name || "FTH$ payment request";
      $("request-amount").textContent = request.amount ? `${displayAmount(request.baseUnits)} FTH$` : "Choose your amount in the wallet";
      $("recipient").textContent = request.to;
      $("pay-wallet").href = request.payers.wallet;
      $("pay-dollar").href = request.payers.dollar;
      $("payment-link").value = request.paymentUrl;
      $("download-qr").href = request.qrUrl;
      $("card-name").textContent = request.name || "Pay to my Featheral wallet";
      $("card-name").dataset.long = String(request.name.length > 35);
      $("card-wallet").textContent = reusable.to;
      await Promise.all([loadQr(request.qrUrl), loadQr(reusable.qrUrl)]);
      if (version !== revision) return;
      $("payment-qr").src = request.qrUrl; $("card-qr").src = reusable.qrUrl;
      current = request; cardRequest = reusable;
      $("request-result").hidden = false; $("empty-request").hidden = true;
      $("card-qr").hidden = false; $("card-qr-placeholder").hidden = true; $("print-card").disabled = false;
      history.replaceState(null, "", "/?" + new URL(request.paymentUrl).searchParams + (incoming ? "#accept" : ""));
      notify(incoming ? "Request loaded. Verify the recipient, then choose Dollar or Wallet to review and pay."
        : "Your payment request and reusable printable card are ready. Verify the wallet ID before sharing.");
      if (incoming) $("accept").scrollIntoView({ behavior: "smooth" });
    } catch (error) {
      if (version === revision) { invalidate(); $("generate").disabled = false; notify(error.message, true); }
    } finally { if (version === revision) $("generate").disabled = false; }
  }
  $("request-form").addEventListener("input", () => {
    invalidate(); $("generate").disabled = false;
    notify("Details changed. Create a new request to update the QR and card.");
  });
  $("request-form").addEventListener("submit", event => {
    event.preventDefault();
    generate(new URLSearchParams({ to: $("to").value.trim(), name: $("name").value.trim(), amount: $("amount").value.trim(), currency: "FTH$" }));
  });
  $("copy-link").addEventListener("click", async () => {
    try {
      if (!current) throw new Error("Create a payment request first.");
      if (!navigator.clipboard) throw new Error("Clipboard unavailable. Select and copy the payment link manually.");
      await navigator.clipboard.writeText(current.paymentUrl); notify("Payment link copied.");
    } catch (error) { notify(error.message, true); }
  });
  $("print-card").addEventListener("click", () => {
    if (!cardRequest) { notify("Create a payment request and load its QR before printing.", true); return; }
    window.print();
  });
  $("write-nfc").addEventListener("click", async () => {
    try {
      if (!current) throw new Error("Create a payment request first.");
      if (!window.isSecureContext || !("NDEFWriter" in window))
        throw new Error("Web NFC writing is unavailable in this browser. Use an NFC writer app to write the payment link as a URL record, or share the QR instead.");
      const request = current, version = revision;
      $("write-nfc").disabled = true;
      notify("Hold a writable NFC tag near your device. This writes the current payment link; use a blank amount for a reusable card.");
      await new window.NDEFWriter().write({ records: [request.nfc] }, { signal: AbortSignal.timeout(30000) });
      notify(version === revision ? "NFC URL written. Test the tag with another device before sharing."
        : "NFC tag contains the previous payment link. Your form changed; create a new request and rewrite the tag.");
    } catch (error) { notify(`NFC tag was not written: ${error.message}`, true); }
    finally { $("write-nfc").disabled = false; }
  });
  const params = new URLSearchParams(location.search);
  if (params.size) {
    $("to").value = params.get("to") || ""; $("name").value = params.get("name") || ""; $("amount").value = params.get("amount") || "";
    generate(params, true);
  }
})();
