"use strict";

const crypto = require("node:crypto");

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
console.log("Public key (register with the writer):\n" + publicKey);
console.log("Private key (keep secret; do not commit or send to the API):\n" + privateKey);
