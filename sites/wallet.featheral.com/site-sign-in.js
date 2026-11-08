"use strict";
((root, factory) => {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FeatheralSignIn = factory();
})(typeof window === "object" ? window : globalThis, () => {
  function validate(address, message, comments = true, parentOrigin, worldAccount) {
    if (typeof address !== "string" || !/^0x[0-9a-f]{40}$/i.test(address) || typeof message !== "string")
      throw new Error("Invalid sign-in request.");
    const app = comments && /^Sign in to Featheral App\.\n\nOrigin: (https:\/\/app\.featheral\.com|http:\/\/app\.localhost(?::\d+)?)\nWallet: (0x[0-9a-fA-F]{40})\nNonce: ([0-9a-f]{48})\nIssued: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\n\nJoin as a visitor\. Membership follows ecosystem learning and quizzes\. No transfer or salary approval\.$/.exec(message);
    if (app && app[1] !== parentOrigin) throw new Error("App sign-in origin does not match this site.");
    const silverOrigin = "(https:\\/\\/silver\\.featheral\\.com|http:\\/\\/silver\\.localhost(?::\\d+)?)";
    const silver = comments && new RegExp("^Sign in to Featheral Silver\\.\\n\\nOrigin: " + silverOrigin + "\\nWallet: (0x[0-9a-fA-F]{40})\\nNonce: ([0-9a-f]{48})\\nIssued: (\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z)\\n\\nView your digital orders and codes\\. Signing in does not spend FTHS\\. Purchases require separate payment approval\\.$").exec(message);
    const payment = comments && new RegExp("^Pay Featheral Silver order\\.\\n\\nOrigin: " + silverOrigin + "\\nWallet: (0x[0-9a-fA-F]{40})\\nOrder: [0-9a-f-]{36}\\nProduct: [^\\r\\n]{1,120}\\nAmount: [1-9]\\d{0,9} FTHS\\nRecipient: 0x[0-9a-fA-F]{40}\\nDetails: [0-9a-f]{64}\\nIssued: (\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z)\\n\\nThis signature authorizes this FTHS payment from your Notes balance\\. Digital code delivery requires administrator fulfillment\\. No physical shipping\\.$").exec(message);
    if ((silver || payment) && (silver || payment)[1] !== parentOrigin) throw new Error("Silver approval origin does not match this site.");
    const profile = comments && /^(?:https:\/\/(?:app|world|media)\.featheral\.com|http:\/\/(?:app|world|media)\.localhost(?::\d+)?)$/.test(parentOrigin || "")
      && /^Featheral profile update\n\nAddress: (0x[0-9a-fA-F]{40})\nUsername: [A-Za-z0-9_][A-Za-z0-9_.-]{2,23}\nAvatar: (?:none|[0-9a-f]{64})\nBio: (?:none|[0-9a-f]{64})\nIssued at: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\nChain ID: 1\n\nSigning is free and does not send a transaction\.$/.exec(message);
    const worldOrigin = comments && /^(?:https:\/\/world\.featheral\.com|http:\/\/world\.localhost(?::\d+)?)$/.test(parentOrigin || "");
    const world = worldOrigin && /^Featheral World Dollar wallet session\n\nWallet: (0x[0-9a-f]{40})\nSession: [0-9a-f]{64}\nIssued at: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\nOrigin: ([^\r\n]+)\n\nAuthorize a separate World fund for this wallet\. Gameplay spends only World funds, not wallet funds\. No funds move on authorization\.\nNo Ethereum transaction is sent\. Never share your recovery phrase or private key\.$/.exec(message);
    const withdrawal = worldOrigin && /^Featheral World fund withdrawal\n\nWorld account: (0x[0-9a-f]{64})\nWallet: (0x[0-9a-f]{40})\nBase units: ([1-9]\d{0,77})\nRequest: [a-zA-Z0-9_-]{16,128}\nOrigin: ([^\r\n]+)\nSession: [0-9a-f]{64}\nIssued at: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\n\nMove only this exact amount of existing World FTH\$ to the authorized wallet\. No Ethereum transaction is sent\.$/.exec(message);
    const deposit = worldOrigin && /^Featheral Dollar \(FTH\$\) transfer\n\nFrom: (0x[0-9a-fA-F]{40})\nTo account: (0x[0-9a-f]{64})\nAmount: (\d+\.\d{1,18}) FTH\$\nBase units: ([1-9]\d{0,77})\nNonce: [1-9]\d{0,15}\nMemo: [0-9a-f]{64}\nIssued at: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\nLedger: Featheral Dollar L3 \(settles to Ethereum Mainnet\)\n\nSigning is free and only authorizes this FTH\$ ledger transfer\.$/.exec(message);
    if (world && world[3] !== parentOrigin || withdrawal && withdrawal[4] !== parentOrigin)
      throw new Error("World approval origin does not match this site.");
    if ((withdrawal && withdrawal[1] !== worldAccount) || (deposit && deposit[2] !== worldAccount))
      throw new Error("World transfer account does not match the current budget.");
    if (deposit) {
      const [whole, fraction] = deposit[3].split(".");
      if (BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0")) !== BigInt(deposit[4]))
        throw new Error("World deposit amount does not match its base units.");
    }
    const match = world && [world[0], world[1], "", world[2]]
      || withdrawal && [withdrawal[0], withdrawal[2], "", withdrawal[5]]
      || deposit && [deposit[0], deposit[1], "", deposit[5]]
      || payment && [payment[0], payment[2], "", payment[3]] || silver && [silver[0], silver[2], silver[3], silver[4]]
      || profile && [profile[0], profile[1], "", profile[2]] || app && [app[0], app[2], app[3], app[4]] || /^Sign in to Featheral Notes and Sites\.\n\nWallet: (0x[0-9a-fA-F]{40})\nNonce: ([0-9a-f]{48})\nIssued: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\n\nSigning in does not spend funds\. Creating a note costs 1,000 FTHX; creating a website costs 500 FTH\$\. Creation requires separate confirmation\.$/.exec(message)
      || comments && /^Sign in to [^\r\n]{1,200} to leave comments\.\n\nWallet: (0x[0-9a-fA-F]{40})\nNonce: ([0-9a-f]{32,64})\nIssued: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\n\nThis request does not send a transaction or cost any gas\.$/.exec(message);
    if (!match || match[1].toLowerCase() !== address.toLowerCase())
      throw new Error("Only the standard Featheral sign-in message can be signed.");
    const issued = Date.parse(match[3]), age = Date.now() - issued;
    if (!Number.isFinite(issued) || new Date(issued).toISOString() !== match[3] || age < -30000 || (!withdrawal && !deposit && age > (world ? 300000 : 600000)))
      throw new Error("Sign-in request expired. Start again.");
  }
  return { validate };
});
