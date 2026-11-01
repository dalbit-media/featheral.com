"use strict";

const { LedgerDb } = require("../ledger-sql/ledgerDb");
const { canonical, txHash } = require("./codec");
const { accountWallet } = require("./transfer");

const SCHEMA = `
CREATE TABLE blocks (
  height INTEGER PRIMARY KEY, hash TEXT NOT NULL, prev_hash TEXT NOT NULL,
  time TEXT NOT NULL, time_ms INTEGER NOT NULL, tx_count INTEGER NOT NULL, file TEXT NOT NULL, signed INTEGER NOT NULL
);
CREATE TABLE transactions (
  hash TEXT PRIMARY KEY, id TEXT NOT NULL, kind TEXT NOT NULL, height INTEGER NOT NULL, idx INTEGER NOT NULL,
  time TEXT NOT NULL, time_ms INTEGER NOT NULL, account TEXT NOT NULL, wallet TEXT NOT NULL,
  counterparty TEXT NOT NULL, counterparty_wallet TEXT NOT NULL, amount TEXT NOT NULL, amount_fth REAL NOT NULL,
  memo TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX transactions_height ON transactions(height, idx);
CREATE INDEX transactions_account ON transactions(account);
CREATE INDEX transactions_counterparty ON transactions(counterparty);
CREATE INDEX transactions_kind ON transactions(kind);
CREATE TABLE accounts (
  account_id TEXT PRIMARY KEY, wallet TEXT NOT NULL, balance TEXT NOT NULL, balance_fth REAL NOT NULL,
  reserved TEXT NOT NULL, reserved_fth REAL NOT NULL, nonce INTEGER NOT NULL
);
CREATE INDEX accounts_balance ON accounts(balance_fth);
CREATE TABLE profiles (
  address TEXT PRIMARY KEY, account_id TEXT NOT NULL, username TEXT NOT NULL, has_avatar INTEGER NOT NULL, issued_at TEXT NOT NULL
);
CREATE TABLE redemptions (
  redemption_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, amount TEXT NOT NULL, amount_fth REAL NOT NULL,
  recipient TEXT NOT NULL, status TEXT NOT NULL, expires_at INTEGER NOT NULL, eth_tx TEXT NOT NULL
);
`;

const COMMENTS = {
  blocks: "One row per sealed block of the hash-chained FTH$ ledger.",
  transactions: "Every sealed transaction. amount is exact base units (18 decimals, text); amount_fth is a convenience float for sums and sorting.",
  accounts: "Current balance, reserved amount and transfer nonce per account id (a wallet address left-padded to bytes32, or a game-only id).",
  profiles: "Wallet-signed usernames. Avatars are not exposed here.",
  redemptions: "FTH$ to FTHG withdrawals and their reserve/settle/release status.",
};

const toFth = (raw) => Number(BigInt(raw) / 10n ** 12n) / 1e6;

function createFthDb() {
  return new LedgerDb({ schema: SCHEMA, comments: COMMENTS });
}

// Called after a block's transactions were applied to the ledger's in-memory state.
function ingestFthBlock(ledger, block, file) {
  const db = ledger.sql;
  const touched = new Set();
  db.transaction(() => {
    db.run("INSERT OR REPLACE INTO blocks VALUES (?,?,?,?,?,?,?,?)", block.h, block.H, block.p, new Date(block.t).toISOString(), block.t, block.x.length, file, typeof block.S === "string" ? 1 : 0);
    block.x.forEach((tx, index) => {
      const d = tx.d;
      const counterparty = tx.k === "TRANSFER" ? d.to : "";
      const data = tx.k === "PROFILE" ? { ...d, avatar: d.avatar ? "(image)" : "" } : d;
      db.run(
        "INSERT OR REPLACE INTO transactions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        txHash(tx), tx.i, tx.k, block.h, index, new Date(tx.t).toISOString(), tx.t, tx.a,
        tx.a ? accountWallet(tx.a) : "", counterparty, counterparty ? accountWallet(counterparty) : "",
        tx.v, toFth(tx.v), tx.k === "TRANSFER" ? d.m || "" : "", canonical(data),
      );
      if (tx.a) touched.add(tx.a);
      if (counterparty) touched.add(counterparty);
      if (tx.k === "PROFILE") {
        const profile = ledger.profiles.get(accountWallet(tx.a).toLowerCase());
        if (profile) db.run("INSERT OR REPLACE INTO profiles VALUES (?,?,?,?,?)", profile.address, tx.a, profile.username, profile.avatar ? 1 : 0, profile.issuedAt);
      }
      if (["RESERVE", "SETTLE", "RELEASE"].includes(tx.k)) {
        const redemption = ledger.redemptions.get(String(d.r));
        if (redemption) {
          db.run("INSERT OR REPLACE INTO redemptions VALUES (?,?,?,?,?,?,?,?)", redemption.redemptionId, redemption.accountId, redemption.amount, toFth(redemption.amount), redemption.recipient, redemption.status, redemption.expiresAt, redemption.txHash || "");
        }
      }
    });
    for (const accountId of touched) {
      const entry = ledger.balances.get(accountId) || { balance: 0n, reserved: 0n };
      db.run("INSERT OR REPLACE INTO accounts VALUES (?,?,?,?,?,?,?)", accountId, accountWallet(accountId), entry.balance.toString(), toFth(entry.balance.toString()), entry.reserved.toString(), toFth(entry.reserved.toString()), ledger.nonces.get(accountId) || 0);
    }
  });
}

module.exports = { createFthDb, ingestFthBlock };
