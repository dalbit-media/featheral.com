"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const file = process.argv[2], repository = path.resolve(__dirname, "..");
if (!file || !path.isAbsolute(file)) throw new Error("Usage: node scripts\\init-db-vault.js <absolute key file outside repository and ledger>");
const relative = path.relative(repository, path.resolve(file));
if (!relative || !relative.startsWith("..") && !path.isAbsolute(relative)) throw new Error("Keep the encryption key outside the repository and all ledger backups.");
fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
if (fs.realpathSync(path.dirname(file)).toLowerCase() !== path.dirname(path.resolve(file)).toLowerCase()) throw new Error("Key directory cannot contain symbolic links.");
const fd = fs.openSync(file, "wx", 0o600);
try { fs.writeFileSync(fd, crypto.randomBytes(32).toString("hex") + "\n"); fs.fsyncSync(fd); }
finally { fs.closeSync(fd); }
console.log("Created vault key. Restrict its OS permissions, back it up separately, then set DB_VAULT_KEY_FILE to this absolute path.");
