# World Feed Database

World social actions are signed **offchain database writes**, not currency
transactions. `createWorldApi({ sqlite, profiles, profileHandler, env })` requires the
managed `services/db-api/sqlite.js` opener; there is no fallback connection.
`profiles` is the DB API profile store (`get(address)`, `owner(username)`,
`save(profile)`); writes remain delegated to `profileHandler`.

`WORLD_DB_FILE` selects the durable feed database (default
`data/world-feed.sqlite`). Use a dedicated path, not an existing user/profile or
currency database. Startup creates missing feed tables without deleting data.
Legacy World block files are neither read nor written; no automatic migration or
deletion of old files or existing SQLite user data is performed. Back up the
database with SQLite-aware backup tooling while live, or close all connections
before copying it.

The managed connection uses WAL, full synchronous durability, a five-second busy
timeout and `BEGIN IMMEDIATE` transactions. Validation, authorization, unique
author/nonce registration, signed-action storage and state mutations commit
atomically. Signatures must be within ten minutes of server time. Sessions last
at most seven days; delegation and moderation require the wallet itself.
Exact fresh retries return the original receipt; changed payloads reusing a
nonce return 409. IDs are random opaque identifiers, not transaction hashes.
Legacy wallet signing-domain text remains compatible with existing browser
sessions; it does not imply chain storage.

Feed routes under `/api/v1/world`: `/timeline`, `/posts/:id`, `/users/:address`,
`/search`, `/suggestions`, `/session`, `/actions`, `/moderation`, `/stats`,
`/sql`, `/sql/schema`. `/stats` returns `database`; action responses have
`status: "committed"` and `receipt.id`. `/ledger/` is the database status and
read-only SQL explorer; post links use `/post/<id>`.
Block, transaction-hash, file, sync and replication APIs are removed.

The public SQL console retains the 4,000-character/500-row limits, single
SELECT/CTE restriction, unsafe-function/recursive-query exclusions and SQLite
`query_only` enforcement. Currency APIs remain owned by the FTH$ ledger service;
wallet profile metadata is provided separately by the DB API.
