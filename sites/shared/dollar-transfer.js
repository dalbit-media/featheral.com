"use strict";

window.FeatheralDollarTransferMessage = ({ wallet, to, amount, nonce, memo, issuedAt }) => {
  const account = ethers.isAddress(to) ? ethers.zeroPadValue(ethers.getAddress(to), 32).toLowerCase() : to;
  const recipientWallet = account.startsWith("0x000000000000000000000000") && account !== ethers.ZeroHash
    ? ethers.getAddress(`0x${account.slice(26)}`) : "";
  return [
    "Featheral Dollar (FTH$) transfer", "", `From: ${ethers.getAddress(wallet)}`,
    recipientWallet ? `To: ${recipientWallet}` : `To account: ${account}`,
    `Amount: ${ethers.formatUnits(BigInt(amount), 18)} FTH$`, `Base units: ${amount}`,
    `Nonce: ${nonce}`, `Memo: ${memo || "(none)"}`, `Issued at: ${issuedAt}`,
    "Ledger: Featheral Dollar L3 (settles to Ethereum Mainnet)", "",
    "Signing is free and only authorizes this FTH$ ledger transfer.",
  ].join("\n");
};
