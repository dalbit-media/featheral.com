"use strict";
((root, factory) => {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else root.FeatheralVault = factory(root.ethers);
})(typeof window === "object" ? window : globalThis, ethers => {
  const KEY = "featheral-encrypted-wallet-v1";
  class Vault {
    constructor(storage) { this.storage = storage; this.signer = null; this.generation = 0; }
    read() {
      const raw = this.storage.getItem(KEY);
      if (!raw) return null;
      const record = JSON.parse(raw);
      if (record.version !== 1 || typeof record.keystore !== "string" || !Array.isArray(record.links))
        throw new Error("Unsupported wallet backup.");
      const keystore = JSON.parse(record.keystore);
      if (!ethers.isKeystoreJson(record.keystore) || !ethers.isAddress("0x" + keystore.address))
        throw new Error("Invalid encrypted wallet backup.");
      return { version: 1, keystore: record.keystore, links: record.links, address: ethers.getAddress("0x" + keystore.address) };
    }
    async prepare(password) {
      if (password.length < 12) throw new Error("Use a wallet password of at least 12 characters.");
      const signer = ethers.Wallet.createRandom();
      const keystore = await signer.encrypt(password);
      return { version: 1, keystore, links: [] };
    }
    async restore(record, password) {
      if (this.read()) throw new Error("A built-in wallet already exists. Never overwrite it; use its recovery backup in another browser.");
      const generation = this.generation;
      if (record.version !== 1 || typeof record.keystore !== "string" || !Array.isArray(record.links))
        throw new Error("Unsupported wallet backup.");
      const signer = await ethers.Wallet.fromEncryptedJson(record.keystore, password);
      if (this.generation !== generation) throw new Error("Wallet was locked during recovery. Try again.");
      if (this.read()) throw new Error("Another wallet was saved during recovery. It will not be overwritten.");
      const links = this.verifiedLinks(record, signer.address);
      this.storage.setItem(KEY, JSON.stringify({ version: 1, keystore: record.keystore, links }));
      this.signer = signer;
      return signer.address;
    }
    async unlock(password) {
      this.lock();
      const generation = this.generation;
      const record = this.read();
      if (!record) throw new Error("Create or restore a wallet first.");
      const signer = await ethers.Wallet.fromEncryptedJson(record.keystore, password);
      if (this.generation !== generation) throw new Error("Wallet was locked during unlock. Try again.");
      if (this.read()?.keystore !== record.keystore) throw new Error("Wallet storage changed during unlock. Try again.");
      this.signer = signer;
      return this.signer.address;
    }
    lock() { this.signer = null; this.generation++; }
    async sign(message, address) {
      if (!this.signer || this.signer.address.toLowerCase() !== address.toLowerCase()) throw new Error("Unlock the active built-in wallet first.");
      const signer = this.signer, signature = await signer.signMessage(message);
      if (this.signer !== signer) throw new Error("Wallet was locked while signing.");
      return signature;
    }
    verifiedLinks(record = this.read(), address = record?.address) {
      if (!record) return [];
      if (record.links.length > 4) throw new Error("A wallet supports up to four linked accounts.");
      const seen = new Set([address.toLowerCase()]);
      return record.links.map(link => {
        const expected = `Link Featheral wallet\nBuilt-in: ${address.toLowerCase()}\nExternal: ${String(link.address).toLowerCase()}\nBalances stay separate. This does not authorize transfers.`;
        if (!ethers.isAddress(link.address) || seen.has(link.address.toLowerCase()) || link.message !== expected
          || ethers.verifyMessage(expected, link.localSignature).toLowerCase() !== address.toLowerCase()
          || ethers.verifyMessage(expected, link.externalSignature).toLowerCase() !== link.address.toLowerCase())
          throw new Error("Linked wallet proof is invalid.");
        seen.add(link.address.toLowerCase());
        return { address: link.address, message: link.message, localSignature: link.localSignature, externalSignature: link.externalSignature };
      });
    }
    async link(provider) {
      if (!this.signer) throw new Error("Unlock the built-in wallet before linking.");
      const signer = this.signer;
      const record = this.read(), links = this.verifiedLinks(record);
      if (links.length >= 4) throw new Error("A wallet supports up to four linked accounts.");
      const address = (await provider.request({ method: "eth_requestAccounts" }))[0];
      if (!ethers.isAddress(address)) throw new Error("The external wallet did not return an address.");
      const message = `Link Featheral wallet\nBuilt-in: ${this.signer.address.toLowerCase()}\nExternal: ${address.toLowerCase()}\nBalances stay separate. This does not authorize transfers.`;
      const localSignature = await this.signer.signMessage(message);
      const externalSignature = await provider.request({ method: "personal_sign", params: [ethers.hexlify(ethers.toUtf8Bytes(message)), address] });
      if (this.signer !== signer) throw new Error("Built-in wallet was locked while linking.");
      if ((await provider.request({ method: "eth_accounts" }))[0]?.toLowerCase() !== address.toLowerCase()) throw new Error("External wallet changed while linking.");
      if (this.read()?.keystore !== record.keystore) throw new Error("Wallet storage changed while linking.");
      record.links.push({ address, message, localSignature, externalSignature });
      this.verifiedLinks(record);
      this.storage.setItem(KEY, JSON.stringify({ version: 1, keystore: record.keystore, links: record.links }));
      return address;
    }
    backup() {
      const record = this.read();
      if (!record) throw new Error("No built-in wallet to back up.");
      return JSON.stringify({ version: 1, keystore: record.keystore, links: this.verifiedLinks(record) });
    }
  }
  return { Vault };
});
