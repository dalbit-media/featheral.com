# Database API

The database API is hosted with the administration site and exposes an
in-process service to the other application services. It owns all native
SQLite connection creation through `database.sqlite.open(file, options)`;
domain modules may execute their SQL through those returned connections.
This uses Node's built-in `node:sqlite` only and has no third-party database
driver dependency. Read-only connections are supported for legacy import and
inspection paths.

The service also exposes `database.domain` for token-, site-, and
database-scoped native file journals. Its document API is available during
phased migrations, independently of the SQLite connection API.

Runtime configuration uses `SystemDatabase` and the same domain/journal API in
the fixed private `data/system-database/` directory, namespace `databases/system`,
collection `settings`, document `runtime`. It is separate from the configurable
public/domain journal directory to prevent configuration bootstrap cycles or
exposure through database browsing routes. The document is an authenticated
AES-256-GCM envelope; journal hash chaining alone does not encrypt secrets.
Admin passwords inside the envelope are salted scrypt hashes. Recoverable
SSH/service secrets are encrypted, never irreversibly hashed or returned.
Writes use optimistic revisions and durable journal publication. Deployment
shared-data links resolve to the original real directory before journal opening.
Back up this private database and preserve its original external bootstrap/key.
Configuration migration does not relocate existing domain stores or change balances.

`database.profiles` is the authoritative store for wallet profile metadata.
It preserves the latest username, avatar, bio and signed-update proof while
keeping these non-currency records out of the FTH$ daily-file ledger. Existing
historical `PROFILE` blocks are imported on service startup and remain in the
immutable currency-ledger files; their original signatures remain in those
blocks. Newer profile changes and their signatures are saved in the DB API SQLite
store; the signature is not included in public profile reads.

```js
const site = database.domain.site("app.featheral.com");
const current = site.get("profiles", "alice");
site.transact({
  requestId: "unique-retry-safe-id",
  changes: [{
    collection: "profiles",
    id: "alice",
    op: "put",
    expectedRevision: current.revision,
    value: { displayName: "Alice" },
  }],
});
const page = site.list("profiles", { limit: 100 });

const cms = database.domain.database("cms");
const cmsPage = cms.list("pages");
```

Collections and document IDs are validated. Reads return a revision and
tombstone state; list reads return active documents in ID order with a cursor.
Transactions contain 1–100 unique changes in one token, site, or database namespace,
check expected revisions, and are idempotent by request ID. Cross-namespace
transactions are not supported.
Native site/database documents support finite JSON numbers; token-ledger
documents remain restricted to safe integers or decimal strings for exact
financial values.

This is the storage contract for phased migrations, not a completed cutover.
Existing SQLite-backed stores remain authoritative until their domain adapters
are migrated and verified. Existing data files are not changed by this API.
Named database stores provide an isolated namespace for each native-file
database, allowing a transaction to atomically update up to 100 documents
across collections in that database.
