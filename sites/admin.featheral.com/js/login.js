"use strict";
const status = document.querySelector("#login-status"), sign = document.querySelector("#login-sign");
async function authRequest(path, body) {
  const response = await fetch("/api/admin-auth/" + path, { method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Admin sign-in failed.");
  return result;
}
window.FeatheralProfile.mount(document.querySelector("#login-wallet"), { ethereumProvider: true }).catch(error => {
  console.error("Admin wallet connection failed:", error);
  status.textContent = error.message;
});
sign.addEventListener("click", async () => {
  sign.disabled = true;
  try {
    const provider = window.FeatheralProfile.getProvider(), account = window.FeatheralProfile.snapshot().account;
    if (!provider || !account) throw new Error("Connect the origin or Dollar reserve wallet first.");
    status.textContent = "Review and sign the Admin sign-in message in your wallet.";
    const challenge = await authRequest("challenge", { address: account });
    const signature = await provider.request({ method: "personal_sign", params: [ethers.hexlify(ethers.toUtf8Bytes(challenge.message)), account] });
    const accounts = await provider.request({ method: "eth_accounts" });
    if (provider !== window.FeatheralProfile.getProvider() || accounts[0]?.toLowerCase() !== account.toLowerCase()
      || window.FeatheralProfile.snapshot().account?.toLowerCase() !== account.toLowerCase()) throw new Error("Wallet changed. Start sign-in again.");
    await authRequest("verify", { signature });
    location.reload();
  } catch (error) {
    console.error("Admin sign-in failed:", error);
    status.textContent = error.message;
  } finally { sign.disabled = false; }
});
