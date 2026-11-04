# Featheral Admin (CMS & operations)

The small bottom-right app build label starts at `v.01` and remains visible across
Admin views. `npm run build` (or `npm run build:world`, also used by startup and
deployment) increments it after the World/app build succeeds: `v.02`, `v.03`, etc.
The generated `sites/admin.featheral.com/js/build-version.js` is the persistent
counter and deployed label; retain it between builds. Failed builds do not advance
it. Direct `node scripts/serve.js` runs do not count as builds.

The unified administration frontend is `sites/admin.featheral.com/`, served at **admin.featheral.com** (`admin.localhost:8080` locally). Foundation overview/access, Gold reserve/token safety, Dollar liquidity/rewards/ledger and World moderation are native views, not iframe consoles. Templates live in `views/`, scoped controllers in `js/operations/`; one signing-wallet control persists across navigation. Tab deep links use `#/operations/<service>?tab=<tab>` and preserve drafts while switching tabs. Leaving a view disposes its wallet listeners and blocks stale signatures/submissions. Product `/admin/` routes, legacy `/operations/<service>/` URLs and the retired CMS hostname redirect to the matching native entry. Old console scripts and their standalone styling were removed; ethers is served locally.

The Sites overview includes all fourteen core hosts, including Database, App, Silver and the central Wallet,
plus additional hostname-named applications and registered CMS/hosted sites.
Each site has API-provided management links to its actual service workspace.
Apps without editable templates show application, relevant native-feature and
reviewed Deployment links instead of an empty CMS editor. Managed CMS roots replace their
built-in catalog entries without hiding separate hosted paths. Native applications
are also included in traffic reporting and deployment hostname review.

Navigation follows the selected site, including native service workspaces and
content/theme editors. Site workspaces show only their own management links;
server-wide menus (deployment, server profile and settings) remain in the
unselected administration workspace. Use **All sites** in the sidebar or site
picker to return there.
The All sites menu contains All sites, Server profile, Logs and
Settings; individual service tools such as App, Silver, Notes and Database
remain in their respective site menus. The site picker remains available.
Admin uses a viewport-height shell with
scrolling inside the content pane (and sidebar when needed); it omits the public
ecosystem footer to avoid a second page scrollbar.

### Site server profiles and compact settings

Every managed site has **Server & service settings** (`#/site-server/<site-key>`).
It defaults to the shared server, or can store an independent HTTPS server URL,
SSH host/port and SSH/sudo credential. The server key is pinned automatically
after the first successful SSH/sudo verification. No manual fingerprint is required.
Existing pins remain enforced; changed server keys are rejected. Enroll over a
trusted network because first-use trust cannot detect initial interception.
HTTP URLs are accepted only for loopback/local development. New credentials and
reactivated separate connections are checked with SSH and sudo before saving.
Changing an enrolled SSH target requires re-entering the credential. Blank
credentials keep the saved value; switching to Shared retains the independent
profile for later use.

All sites share the default server until assigned to a separate server. Reviewed
**Settings → Deployment** compresses the same Git-tracked working-tree files into a ZIP before uploading to every target,
using each target's own encrypted SSH/sudo credential. Nginx/TLS and the gateway
are scoped to assigned hostnames; set DNS A/AAAA records accordingly beforehand.
Separate targets deploy before the shared Admin server. A DB-only target starts
only the DB site/API and may initialize empty staged journals, never financial
writers. Other separate servers require existing reader configuration. This is
not a remote-database migration or distributed-storage cutover; in-process data
adapters and existing authoritative data remain unchanged.
Service controls still configure the current installation, not the remote host.
See the root [deployment instructions](../../README.md#unified-administration-cms-editing-and-reviewed-deployment)
for the two-server `featheral.com` / `db.featheral.com` setup and prerequisites.

Shared **Settings** shows a single Deployment card with connection fields,
review/approval controls and a live progress console, without Admin/configuration
cards. Wide desktops show connection, review and console side by side; smaller
desktops use two columns and narrow screens stack the same workflow.
Deploy remains disabled until the exact approval phrase matches the current,
unexpired plan. A new review clears the old phrase; a failed wallet challenge
shows its error and allows retry without leaving Settings.

**Sign & self-sync** is available only on the active deployed Linux Admin
server. Settings groups upload deployment and Git self-sync in one action panel
with a single source-labelled console. Both operations retain their logs when
the other refreshes; self-sync status can be refreshed after a restart.
Wallet approval failures are logged in the browser's request section and remain
visible after refreshing server status. Finished receipts are labelled as the
last recorded job with their ID, start time and commit, not a new successful
request. An Admin session alone does not replace the required signing wallet.
Action buttons recheck the selected Ethereum provider and restore the
session's signer before requesting a signature, including after reloads with
multiple wallet extensions. Both origin and reserve wallets can approve using
their own Admin sessions. Ambiguous extensions require choosing one in the
header; switching to the other authorized wallet requires signing in with it.
It requires wallet approval, server-side Git access to
`https://github.com/dalbit-media/featheral.com.git`, Git installed on the server,
and non-interactive sudo for deployment operations. It does not require the SSH
upload deployment enable switch or SSH target credentials: it updates the local
Admin installation, not another server. The independent
`featheral-deployment.service` job pulls the remote default branch with
`git pull --ff-only` into `<deployment-root>/shared/self-deployment/checkout`,
refuses local checkout edits or a changed origin, packages a fresh release,
builds, restarts and verifies it with the existing code rollback safeguards.
Self-sync preserves the active release's upload and timeout limits and reuses
installed HTTPS certificates, still verifying every assigned HTTPS hostname.
It needs no outbound TLS registration email; the existing Certbot timer handles
renewal.
Private storage stays linked in place; published CMS pages are not re-imported.
Custom content, storage-origin mappings and the current writer authority remain
intact. Recognized shipped page defaults receive their normal versioned design
upgrades when rendered; custom published edits are never replaced by Git content.
It never uses source-machine edits: commit and push them first. Status and bounded
redacted logs persist in `shared/self-deployment/status.json`; refresh Settings
after the Admin restart. An interrupted job without a completion receipt reports
uncertainty and requires inspection of `journalctl -u featheral-deployment`
before retrying. It cannot update a selected remote server.
Existing limits and low-level runtime values are preserved. Common service options use readable labels
in the corresponding App, World, Silver, Gold, Media, Wallet or Database site settings.
The reduced UI preserves existing low-level runtime values; advanced/offline
configuration and migration support remain available. Runtime edits still need
explicit backup/restart confirmation, and do not restart services automatically.

`GET /api/settings/sites/:key`, `POST /api/settings/sites/:key/challenge` and
`POST /api/settings/sites/:key` use the same Admin-host, HTTPS, authentication,
same-origin mutation, bounded body and Admin-wallet protections as shared
Settings. Saves bind the exact site, values and shared settings revision.
Unknown sites and cross-site service fields are rejected. Site credentials
share the encrypted system database; status responses never return them.

### One-time server data sync

Open a site's **Server & settings > Sync databases & uploads**. The saved site
assignment chooses the target server (including a shared target), not a
site-only subset of data. Deploy the current sync-capable release to an already
running target first. For a shared target, click **Sync to shared server** to
prepare the snapshot and start transfer immediately using the saved connection;
there is no separate review, replacement checkbox or wallet approval. For a
separate server, prepare a review, confirm database replacement and sign with
the Admin wallet. Reviewing never connects to or changes the target.

The sync panel polls while snapshot preparation or transfer is pending and shows
a stage-based progress bar, byte-counted SFTP upload progress and a timestamped
detail log. Target verification, backup, installation, restart, health probes and
rollback output appear live. The latest 200 redacted log lines and progress are
persisted across page reloads and server restarts; only confirmed success reaches
100%. Snapshot capture itself briefly blocks source requests while writers pause.

Each step shows progress, elapsed time and remaining-time estimate on one compact
text line, without individual progress bars or animated sections.
Upload percent is the actual byte fraction; ETA uses recent acknowledged-block
throughput and becomes unknown after ten seconds without a progress update.
Resume resets rate sampling so time spent paused or verifying is not counted as
transfer time. Other step estimates use the last measured duration for the same
target; these are labeled historical estimates, not measured completion counts.
First-run steps and steps exceeding their historical duration show **Estimating...**
without a measured percentage. Paused/interrupted steps freeze elapsed time and
do not display a running ETA. Step timings persist alongside the sync status.

Uploads have no total-duration limit. The saved `deploymentTimeoutSeconds`
(default 900 seconds) is an **inactivity timeout** for SFTP sync uploads; it resets
after every acknowledged block. Data is streamed in bounded 256 KiB blocks.
The same setting still limits the target apply job's total execution time.

If upload disconnects or stalls, the operation becomes **paused**, retains the
exact frozen source files and remote partial files, and offers **Continue transfer**.
Continue uses the original site/server assignment, pinned key and snapshot digest;
it verifies each local file and remote prefix SHA256 before writing
from that file's actual byte offset. Completed verified files are skipped.
Upload resume survives source restarts and does not require another snapshot or
wallet signature. Credentials come from the saved connection; changing timeout
settings does not invalidate the original snapshot, but changing the target does.
Source snapshots remain private until confirmed completion or rollback. A paused
upload prevents starting a different snapshot. Do not edit or delete its staging
files. Invalid target prefixes are explicitly rejected, never silently overwritten.

An interruption after target apply begins remains **uncertain** and requires the
signed receipt check below, not upload resume. Versions before resume support
used a ZIP; those retained ZIP transfers are not accepted by the new file uploader.
A ZIP transfer paused before apply may be replaced with a fresh reviewed
file-transfer snapshot; old staging is retained, never automatically deleted.
An uncertain apply still requires its signed target receipt check before another
snapshot. Check target jobs before recovering any unconfirmed operation.
Do not delete old snapshots, target staging or backups blindly.

**Pause** stops an uploading transfer after the current SFTP block; every file
already uploaded is recorded in a local journal and every acknowledged block of
the interrupted file stays on the target as a checksum-verified prefix.
**Continue transfer** lists the target staging once, skips journaled files whose
size matches, verifies the partial file's prefix and appends only the rest.
**Reset transfer** (paused, not-applied, rolled-back or complete) refuses while a
target sync job, lock or unfinished install receipt exists; otherwise it removes
every target `shared/site-sync/*` staging folder and every retained local
snapshot. Live target databases, uploads and `shared/sync-backups` are untouched.

The fixed, ten-minute snapshot includes installation SQLite databases, native
Dollar/World and database/CMS journals, site registries, upload indexes and uploads
under `data/` and `services/cms/data/`. SQLite snapshots consolidate committed WAL
contents with `VACUUM INTO` and pass `quick_check`. Synchronous capture pauses this
Node process's writers; a before/after inventory and checksums reject concurrent
external changes. Use one application writer and a quiet period. External/custom
storage outside the supported installation layout is rejected, not silently
omitted. Backups, test storage, operational state, external bootstrap, encrypted
server Settings/vault credentials, signing keys and secret files are excluded.
CMS journal identities are retained across different installation paths and OSes.

Separate-server approval binds the snapshot SHA256, site/target, pinned SSH key,
Settings revision, Admin origin, wallet and session. Shared-server sync checks the
saved shared assignment and Settings revision before capture and revalidates the
snapshot binding before transfer. The source sends database/journal/registry and
metadata files first, verifying each checksum before sending media/upload files.
No compression, ZIP creation or extraction is used. The complete manifest is
sent last; database replacement happens only after all referenced files arrive,
so the active target never sees a partially transferred snapshot.
Credentials go only to SSH and sudo stdin. The Linux target verifies file paths,
checksums and databases before stopping its exact PM2 application. A verified,
retained backup precedes database replacement and removal of superseded journal
records/WAL files. Uploads are overlaid: matching files use the source version;
target-only uploads, credentials, signing keys and unrelated files stay. This is
not a deletion mirror, DB merge, continuous replication or writer failover.

Sync files bypass Nginx over SSH/SFTP, so HTTP upload size and proxy timeouts
do not limit sync transfers. Managed Nginx configurations stream HTTP request
bodies (`proxy_request_buffering off`) rather than spooling entire uploads to
disk, while retaining the configured upload size and request timeout limits.

Before transfer, target free space is checked only for the snapshot bytes not yet
staged plus 512 MiB headroom; already uploaded files and resumed prefixes count as
staged. Staging is the only full copy: the receiver renames staged files into place
on the same filesystem, hard-links the replaced originals into the retained
rollback backup, and leaves byte-identical target files untouched without backing
them up. Rollback moves installed files back into staging (so a retry re-uploads
nothing) and restores each original through a verified temporary copy. Before
backup and replacement the receiver measures any cross-filesystem copies plus the
largest single file and refuses if space is short. Existing backups and staging are
never removed to make room. The receiver (`restore-site-sync.js` with its snapshot
and replica helpers) is uploaded with every sync into the staging folder and its
SHA256 is checked on the target before it runs, so an older target release does
not need a deployment first; only its `services/operations/settings.js` is used.
Frozen source files still need local snapshot space, but no second giant ZIP.
Deployment also checks source-file bytes plus 512 MiB headroom; dependency/build
space can exceed that allowance. An insufficient or unknown space result fails
explicitly before uploading. Completed release transfers use a digest-based
release directory so retries can skip verified files and resume partial prefixes.
New and existing managed hosts receive this setting on the next reviewed deployment.

`data/site-sync-replica.json` persistently forces native readers, disables upstream
polling and Gold execution, removes financial private keys from the runtime, opens
persistent SQLite read-only and rejects journal transactions and HTTP mutations.
Replica startup skips seeding/upgrades and public page views do not increment
stored counters. Target server Settings and encryption keys remain its own.
Dollar startup also skips legacy wallet-profile imports when profile storage is
read-only; it serves the profiles already present in the snapshot.
Code deployment skips published CMS imports on a read-only replica, preserving
the synced content and replica marker. It still rebuilds, restarts and verifies
the code release; it never enables writes to make an import succeed.
Public page rendering also skips persisted document upgrades and content seeding
on replicas. Existing snapshot pages remain unchanged; missing document/block
templates are rendered in memory, including legacy text, without journal writes.
The source remains the writer; purchasing, login and other mutations belong there.
Health must explicitly return `X-Featheral-Replica: read-only` before success.
The probe follows the target's configured HTTP host and port (including IPv6),
using server-side HTTP without browser restricted-port rules. Like deployment,
it allows 60 attempts, with a three-second request timeout and two seconds between
attempts. Failed attempts include the endpoint and connection/HTTP error; exhausted
health checks print bounded recent application logs before restoring the backup.
Code deployments preserve this marker; removing it is **not** a supported promotion
procedure. Never enable a second financial writer.

An operator-controlled writer cutover must first stop and durably fence the old
writer, synchronize its final frozen state, and restore the original game and
Gold authority keys (and ledger signing keys when configured). Preserve the
snapshot's `sourceCMS` identity separately as
`data/site-sync-origin.json` (`{"version":1,"sourceCMS":{...}}`) before retiring
the replica marker. This identity is not a permission flag: it retains existing
CMS journal namespaces across operating systems, future releases and subsequent
snapshots. Malformed or conflicting identities fail closed. Configure all copied
runtime paths explicitly and verify ledger continuity, sessions and gameplay
before routing writes to the new authority. Never automatically reactivate the
old writer after the new authority has accepted writes.
For a final frozen cutover snapshot, receiver manifests may mark already-present
files `retained: true`. They are verified against an explicitly selected read-only
target, checked again before backup and left in place only when their size and
SHA256 still match. This avoids staging or retransmitting unchanged uploads;
changed files retain the normal upload, backup and rollback path.

The target job runs as `featheral-site-sync.service`, independently of the SSH
connection. Backups and recovery receipts remain under
`<deployment-root>/shared/sync-backups/<sync-id>/`. Normal apply/health failures
restore the verified backup; abrupt interruption leaves a lock and requires
inspection. New deployments and syncs refuse an unresolved target lock. Source
restart or transport loss reports **uncertain**, never success. **Sign & recheck
target status** reads the original target receipt/process status without copying
data, and clears uncertainty only for a completed/rolled-back receipt or an online,
untouched target with no receipt, active job or lock.
Confirmed rollback completes the restore progress step, not the failed sync.
Older interrupted restore steps are corrected when the signed receipt check
confirms rollback.

For an interrupted install, inspect `journalctl -u featheral-site-sync.service`.
After the job has stopped, an operator on that target can restore a specific
verified backup using the same account that owns PM2:

```sh
node <deployment-root>/current/scripts/restore-site-sync.js --recover \
  <deployment-root> <deployment-root>/shared/sync-backups/<sync-id>
```

Recovery stops PM2, verifies every backup checksum before restoring, restores
previous replica/writer state, restarts PM2 and retains the backup. Check health
before resuming writes. A missing `state.json` means backup was interrupted
before installation; inspect the job and original data rather than attempting an
unverified restore or deleting files. Do not remove locks while a job is active.

The Settings API is `GET /api/settings/sites/:key/sync`. Authenticated, same-origin
`POST /api/settings/sites/:key/sync/shared/start` accepts the current Settings
`revision` and starts only a saved shared target. Separate review and signed mutation
routes `/sync/plan`, `/sync/challenge`, `/sync/start`, `/sync/check/challenge` and
`/sync/check`. Deployment/Settings and sync cannot run concurrently.
Authenticated same-origin `POST /api/settings/sites/:key/sync/resume` continues
only a paused upload belonging to that site.

The workspace and privileged APIs require a wallet-signed Admin session from the origin wallet (`0xD2f1Be8414472E9f436B65e91A2B8dFDa418287c`) or Dollar reserve wallet (`0x706CCb6109046a6a4A08dbAD4444A46408703ccb`). Connecting an address alone is insufficient: sign the five-minute single-use, browser/origin-bound challenge. Admin passwords, HTTP Basic and localhost bypasses are not accepted. Host-only HttpOnly/SameSite=Strict session cookies expire after eight hours; sign-out, wallet changes and server restarts require sign-in again. Production requires HTTPS. Frontend assets contain no authority. The main gateway dispatches authenticated API requests to the original Gold, Dollar and World services; signing, moderator/on-chain roles and wallet confirmations still apply. Writes must come from the admin origin. The standalone CMS service explicitly reports that operational APIs require the main `npm start` server. Backend modules and private datasets remain under `services/cms/`; an existing old CMS-host page database is reused to preserve its content/themes.

CMS and Notes use Node's built-in SQLite with connections created and managed
through `services/database/sqlite.js`. Standalone modules and tools import its
`open(file, options)` directly; no external database driver is required.
Standalone CMS shutdown calls `database.sqlite.closeAll()` after service cleanup.

Admin's **Server profile** (`#/server-profile`) consolidates protected server
resource metrics, a one-minute unified chart, risk indicators, cached database /
ledger / upload / source inventory and Linux account browsing. Credentials are
managed separately in **Settings**. `GET /api/server-profile` requires the Admin
host, HTTPS (except loopback `admin.localhost`) and Admin authentication.
Storage is scanned at startup and every five minutes; an authenticated same-origin
`POST /api/server-profile/refresh` requests an early scan. Filesystem capacity
is sampled separately: each authenticated dashboard read samples
current available space immediately, without waiting for the inventory scan.
The source inventory
skips `.git`, `node_modules`, `artifacts`, `cache`, `coverage`, `dist` and `out`;
those names are still counted inside data, upload and trash trees. Symlinks are
not followed. Set network capacity in **Settings** to a positive bytes-per-
second value to enable network utilization risk thresholds. Without that
setting, only observed HTTP traffic is reported because interface capacity is
not available from Node's portable OS APIs.

The disk-capacity donut shows in-use and available bytes and percentages for the
filesystem hosting the service repository (not only the application inventory).
In-use includes filesystem-reserved space unavailable to the service. Capacity
samples carry their own timestamp and refresh with storage scans. Net growth is
the used-space change over up to 24 hours of in-memory samples, collected at least
five minutes apart. History starts again on process restart, a capacity change or
a failed capacity sample. Before five minutes of observations, growth risk is
unknown, unless current utilization already warrants a warning. A positive growth
rate projects days until available space is exhausted; zero or declining usage
has no exhaustion estimate. Disk risk is warning at 85% used or projected full in
30 days, and critical at 95% used or projected full in 7 days. These are linear
filesystem-wide estimates, not predictions of application-only growth.
The compact Server profile dashboard puts ten metric overview tiles above disk,
risk and storage panels. Expandable info boxes hold measurement details and
thresholds; warning and critical risk explanations remain open by default.

## Foundation intranet

The gateway serves `app.featheral.com` and `silver.featheral.com` (local aliases:
`app.localhost:8080` and `silver.localhost:8080`). Admin's **App insiders & missions**
view (`#/intranet`) is the management backend. A World profile is required before
requesting membership. Profile, avatar and public bio are created and edited inside
App through the shared JSON-driven World profile component; no World-site redirect
is needed. The same editor is mounted on World. Its model is
`GET /api/v1/world/profile/ui` (schema `featheral.profile`, version 1), with
`POST /api/v1/world/profile/prepare`, `GET /api/v1/world/profile/:address` and
wallet-signed `POST /api/v1/world/profile`. World delegates persistence to the
existing Notes profile writer. Bios are public, signature-bound, up to 1,000
characters; old name/avatar-only updates remain valid and preserve saved bios.
App membership applications are still separate from public bios.
New requests are pending, volunteer/orientation, Learning
division/General team; only an authorized Admin operator can approve, suspend or
assign hierarchy. Built-in divisions are Operations, Engineering, Community,
Research and Learning. Teams are division-bound. Levels are orientation, learning,
practitioner, mentor and steward; roles are volunteer, intern, contributor, lead,
manager and director. Leads manage their team, managers their division, directors
the whole workspace; these roles never confer CMS administrator access.

Ready missions move through in-progress work, evidence-backed review and manager
approval. Assignees must belong to the mission team. A completed mission does not
automatically create salary. Admin Silver grants require a reason and exact
`ISSUE <whole amount> FTHS` approval, use retry-safe request IDs, and atomically
record ledger entries, grants and audit history. A linked completed mission can
receive one grant, to its assignee. Ordinary reaction-reward minting of FTHS is
disabled. Explicit Exchange pool funding remains a separate approved operation;
it requires existing treasury FTHX and never happens at startup.

`services/notes/workspace.js` stores membership, channels, messages, reads,
files, shared notes, missions, calls, grants and audit records in the existing
Notes SQLite database. Include that database in consistent private backups.
On startup FTHS is registered under the system treasury and its old unissued
placeholder becomes a real, unfunded market. A conflicting privately owned FTHS
definition stops initialization with an explicit error rather than overwriting it.
No live data is moved from World. Game chat and existing World inbox messages
remain in World; its communication view links Foundation work to App.

App endpoints use a dedicated origin-bound wallet challenge (five minutes),
one-day HttpOnly/SameSite Strict sessions stored hashed, same-origin mutations,
and active membership checks on every private operation. Channel/file/signaling
access follows current division, team and direct membership, including revocation.
Admin routes require the Admin hostname and existing CMS authentication; role
selection in signup never grants management rights. Message retries are immutable,
shared notes and missions check revisions, and per-author cooldowns bound chat.
Attachments are limited to 5 MiB each, 20 MiB per author/day and 100 MiB total;
downloads are attachments/octet-stream, never executable inline documents.
Private files are database BLOBs, not public uploads. Data is access-controlled,
not end-to-end encrypted; authorized server operators can access stored work.
Retention/deletion is an operator responsibility in this initial release.

The App manifest supports installation. Its service worker handles push only;
it does not cache private work or promise offline access. Notifications require
explicit permission, HTTPS (or localhost), and configured `APP_VAPID_PUBLIC_KEY`,
`APP_VAPID_PRIVATE_KEY` in Admin Settings (generate a matching pair with `npx web-push generate-vapid-keys`; the subject is `https://featheral.com`).
Only recognized browser push-service endpoints are accepted. Payloads contain
generic notification text, not message contents. Logout unsubscribes that browser;
suspending a member removes their subscriptions. iOS notifications require the
installed home-screen app on a compatible iOS version.

Calls are one-to-one audio, with optional screen sharing where supported; no
group conferencing is claimed. Microphone and screen access require explicit
browser consent. Configure comma-separated `APP_ICE_URLS` with your STUN/TURN
services. TURN URLs require `APP_TURN_SECRET` matching the relay's REST-auth secret;
the API provides short-lived HMAC credentials only to active members. Without
TURN, same-network calls may work but reliable external-network connectivity is
not guaranteed. Unanswered invitations expire after one minute. Signaling expires
and is pruned; calls and files are scoped to current membership.

### Silver digital marketplace

Silver sells digital gift cards and redemption codes, including externally
redeemable silver/collectibles, not shipments by Featheral. Admin's **Silver /
products & codes** (`#/silver`) manages drafts/publication, whole-unit FTHS prices,
issuer, denomination, sourcing, region restrictions, redemption URL/terms, private
stock, fulfillment, refunds and audit history. No third-party card procurement or
issuer API is integrated. Operators must verify authorization to resell, supplier
availability in Japan/Korea, account-region restrictions, expiry, fees and issuer
terms. There is no universal worldwide gift card. Never publish codes in content.

Set `SILVER_CODE_KEY` to a persistent random 32-byte key encoded as 64 hex
characters in the server environment. Store it in the operator secret manager,
not source control. Back it up separately from the Notes database. Inventory uses
AES-256-GCM with per-code nonces and record-bound authentication; losing/changing
the key prevents old codes from being decrypted. Do not rotate without a proper
inventory re-encryption migration. Without this key, stock import and checkout
are disabled. Set the FTHS receiving wallet and store terms in Admin, import
genuine unique codes, publish listings, then explicitly enable checkout. Nothing
is seeded, minted, funded, purchased from an issuer or charged at startup.

`/api/silver/catalog` is public on Silver. `/challenge`, `/login`, `/logout` and
`/me` provide separate origin-bound wallet auth and hashed, one-day HttpOnly Strict
sessions. `/orders` prepares an immutable five-minute, one-code order; its exact
wallet approval names product, buyer, receiving wallet and FTHS amount and binds
all listing/store terms. `/orders/:id/pay` verifies that signature and atomically
records two balanced native Notes entries, reserves stock and marks payment.
Retries use the same order ID without charging twice. Stock, price, publication,
terms, funds and ledger locks are rechecked before charging; quotes do not reserve
stock. All funds are native FTHS, with no Ethereum approval or gas transaction.

Admin-only `/api/silver/admin` routes manage settings, products, private inventory
metadata/import/retirement and `/orders/:id/deliver` or `/refund`. Manual delivery
releases the reserved code to its buyer. Only the authenticated buyer can explicitly
reveal it via `/orders/:id/code`; catalogs/order lists/Admin listings omit codes.
Sensitive responses use no-store. Codes stay private to the buyer and server operator,
not end-to-end encrypted. Undelivered paid refunds transfer the exact FTHS amount
from the original receiving wallet and quarantine the code. Keep sufficient funds
there. Delivered codes require external issuer review, not an unsafe automatic
refund/re-listing. Expired stock cannot be sold or delivered. Back up the private
Notes SQLite database consistently, including the Silver tables and audit records.

Silver's inline wallet uses FTHS for available balance, sends and receiving.
The FTH$ conversion action opens the existing Exchange-backed wallet swap flow,
defaulting to FTH$ -> FTHS on Silver. No fixed conversion rate or liquidity is
promised; unfunded FTHS markets disable the action. Actual quotes/execution still
check both route legs, fees, price impact and available funds.

Public `GET /api/intranet/silver` reports native FTHS supply and pool state on
App, Silver or Admin. All other private App endpoints are under `/api/intranet`
on App, and CMS-authenticated management is `/api/intranet/admin` on Admin.
World profiles remain canonical through Notes' profile API. These are native
application-ledger services, not Ethereum contracts or a deployed L3 rollup.

Focused validation:
`node --test services/cms/tests/workspace.test.js services/cms/tests/workspace-http.test.js`.

## Foundation integration

**Sites** manages complete Foundation, Gold and Dollar homepages/documentation and Foundation governance at their original URLs. Seeds and application shells are CMS-owned under `sites/admin.featheral.com/documents/`. Select a site and page to edit its title, search description and full safe-HTML body or select native/ocean/journal/forest themes. Headings, links, images and sections are editable; HTML scripts, styles, event handlers and unsafe URL schemes are rejected. Live widgets use protected `<cms-widget name="..."></cms-widget>` slots, each required exactly once. Reposition these slots without changing their contents. Wallet/navigation scripts stay in the shell, not editable HTML. Every publication checks the current revision, and saves retain revision history.

Published documents/metadata/themes are stored in `data/site-pages/` and included in reviewed deployment snapshots. Old text-block edits are automatically merged into the new document on first access without exporting private data into source seeds; their histories are retained. World and Admin remain native applications with plain-text CMS blocks. Wallet, conversion, explorer and World application routes/API ownership are unchanged. X/Exchange retain their existing full CMS editor.

Foundation's homepage, Docs and Governance now describe all thirteen current sites,
the shared tabbed wallet, actual Exchange trading, site-and-note creation and the
Gold/Notes API split. Admin is documented without a public administration link;
the writer/replica network is not described as a deployed L3 rollup. Supply widgets
use `/shared/foundation.js` with Gold and Note APIs, exact integer supply formatting
and explicit unavailable states, never a fixed USD estimate.
Document seeds can declare `replaces` SHA-256 fingerprints of previous published
defaults, computed over `JSON.stringify({title, excerpt, body})` after the original
CMS normalization. Only an exact published match is upgraded on page access, through
the normal revision-checked save. Customized body/metadata and drafts remain intact.
This refresh is idempotent and part of the next reviewed deployment, not an automatic
remote release.

The site-page editor opens the homepage first, with separate site/page selectors, full-width title/description/content fields and collapsible widget help. **View published page** opens the selected page at its public URL. The status distinguishes saved content from unsaved changes; use **Publish changes** or Ctrl/Cmd+S to publish. Switching pages or leaving the editor prompts before discarding changes.

**Deploy all sites** uses a digest-bound, expiring review plan covering every server and hostname assignment, followed by SFTP upload and pinned-host-key SSH execution with per-server credentials. It is disabled by default and must be enabled in Admin Settings with origin-wallet approval. Every target receives the same compressed ZIP of Git-tracked source and published metadata; untracked files are excluded and the tracked inventory is retained for later deployments from installed releases. Both the ZIP and every extracted file are checksum-verified; retries resume the ZIP's verified prefix. ZIP paths and links are checked before extraction into a fresh release. Free-space preflight includes compressed and expanded bytes plus headroom. Database/uploads Site Sync remains uncompressed file transfer. Status preserves per-target outcomes; failures stop the batch without rolling back other servers. See the root [deployment instructions](../../README.md#unified-administration-cms-editing-and-reviewed-deployment). Initial full-stack private data must be restored from a consistent offline backup; a fresh DB-only host does not need financial data or root credentials copied from the shared server. No deployment occurs merely by reviewing a plan.

This application and its complete local data were moved into the Featheral foundation at `services/cms/`; the old source root is empty. Run `npm start` from the foundation root to serve CMS, X, Exchange and all registered CMS sites through the same gateway as Foundation, Gold, Dollar and World. Root `npm install` includes this CMS workspace. Run `npm run test:cms` from the foundation root for the migrated suite.

Local gateway URLs are `http://admin.localhost:8080/`, `http://x.localhost:8080/` and `http://ex.localhost:8080/`. Existing sample Featheral hosts and new Featheral subdomains also support `.localhost` aliases. CMS preview links on `admin.localhost` keep their local origin. Sign in with an authorized Admin wallet even on localhost; only the transport's HTTPS requirement is relaxed on loopback `admin.localhost`. Imported data and uploads remain in this application's ignored `data/` directory, not in the foundation's ledger data directory.

For standalone operation, run `npm run start:cms` at the foundation root (default port 5178). Do not run standalone and gateway processes against the same data concurrently. The exchange remains a local demo and its FTH$ is not the foundation's Dollar currency.

Featheral CMS manages local content alongside the stored WordPress data set in `data/qporn-eurasiahosting-com`. CMS edits are kept separately so the imported WordPress snapshot remains unchanged.

## Local mode (default)

In Admin Settings, `ADMIN_CONFIG_JSON` controls site names and local mode (restart after saving):

```json
{ "brand": "admin.featheral.com", "siteKey": "qporn-eurasiahosting-com", "allowSync": false, "siteManagement": true, "publicBrand": "x.featheral.com", "cmsHost": "admin.featheral.com", "publicHost": "x.featheral.com", "publicTagline": "Featheral X Media Archiving and Streaming Platform. Share media, support free expression, and earn FTHX.", "ageGate": true }
```

- `brand`: the CMS name shown in the sidebar, page title and overview.
- `siteKey`: the default stored data set for the public site on localhost. With site management disabled, every other set is hidden.
- `siteManagement: true`: enables the **Sites** dashboard and sidebar site selector independently of WordPress syncing. New public websites are created only on `sites.featheral.com`.
- `allowSync: false`: WordPress connect, sync, cancel and data-set deletion remain disabled. Missing media returns 404 rather than being fetched from the live site.

## Site management

### Linux server accounts

`#/server-profile` (with the old `#/server-users` alias) is the Admin-only account
browser for the SSH server configured in **Settings**. It uses `getent passwd` to include system accounts and other
NSS-provided users, with search and 50-row pagination. Only username, UID, GID,
home and shell are returned; password fields and personal GECOS fields are not
exposed. UID 0 is marked as root privileges. This is separate from application
profiles and App membership; account creation/deletion and permission editing
are not enabled.

Account browsing requires configured Admin access, HTTPS (loopback Admin may use
HTTP), and a fresh origin-wallet approval for the Settings credential. It does not
require deployment to be enabled or a certificate email. No remote user data is
cached in browser storage. Root-password changing has been removed from the UI
and service; the old change/challenge/status endpoints return 404. Existing audit
files and legacy vault journals are retained without exposing their contents.

### Operations Settings

**Logs** (`#/logs`) provides CMS deployment progress plus signed remote reads for
each configured deployment server: installer, PM2 stdout/errors, Nginx
access/errors and Certbot setup/renewal. Remote reads use the saved pinned SSH
connection, require a fresh Admin-wallet signature bound to target, log and
Settings revision, and return only the last 64 KiB/up to 400 lines from fixed paths.
The default **All tracked logs + deployment progress** view reads every tracked
file on the selected server with one signature and SSH connection, plus the latest
CMS deployment progress. Results are grouped under source headings, not
chronologically merged (log formats and time zones differ). Individual sources
remain selectable. Missing/unreadable files are shown inline while available
sources remain visible; SSH timeouts explicitly mark remaining sources unread.
Both Settings and Logs consoles color errors red, warnings amber, success green,
progress blue and source headings purple. Output is rendered as text, never HTML.
Files are never supplied by the browser. Known saved credentials, private-key
blocks and common authentication fields are redacted; operational logs may still
contain sensitive information and must be reviewed before sharing. Missing files
and SSH failures are explicit errors. Logs are read on demand, not automatically
retried, downloaded or cleared. Remote APIs are `/api/database/logs`,
`/api/database/logs/challenge` and `/api/database/logs/read`.

`#/settings` contains one Deployment card for server host, SSH port, credential,
deployment directory and Let's Encrypt registration email, followed by review,
signed deployment and a live console. Saving the connection enables reviewed
deployment but never starts it. A credential is required initially and when the
SSH target changes; blank retains a verified saved credential. Unrelated runtime
controls and limits are omitted from this UI without resetting stored values.
Advanced configuration remains available through the protected Settings API.
Credentials use
`username:password`; password-only or `:password` means root. Passwords may contain
colons after the username separator. The same credential is used for SSH and sudo.
New credentials are checked with SSH and, for non-root users, sudo. First enrollment
automatically pins the host key only after success; later connections must match.
Saving never changes a server password. Secrets are not returned by the API,
included in commands, logged, or uploaded with releases.
The console polls persisted progress, including individual APT updates/installations,
Node setup, private-data checks, file verification, dependencies, build, PM2, Nginx and HTTPS.
Installer errors include the failed step and exit code in both the console and
per-server result (for example `apt-update (exit 100)` or `private-data (exit 1)`).
Installer stdout and stderr stream into the same console alongside fixed diagnostic
markers. Known SSH/runtime secrets, common authentication fields and private-key
blocks are redacted before persistence; lines exceeding 64 KiB are omitted with
an explicit notice. Logs can still contain operational data; review before sharing.
The latest 200 events and failed target details survive reloads.
Detailed results appear only in the console, with a compact status in its heading.
Review shows server/site/file counts and expiry, with connection details and
installer steps in a collapsed disclosure. The approval phrase is selectable
above the confirmation input; exact entry and wallet approval remain required.
Review/refresh is secondary; the primary Sign & deploy button shows approval
and deployment progress states.
The review and console expand with desktop viewport height. Polling preserves your scroll position when reading
older output, and follows new output when you are at the bottom.
Private detailed output remains in `<target>/shared/logs/deployment.log`.

Installation is detected automatically; there are no first-install controls.
`POST /api/deployment/plan` accepts `{}`; retired `initialize` and
`freshManagedSites` options are rejected so stale Admin clients must reload.
Automatic behavior and console streaming are disclosed in the plan and wallet
challenge. Only the shared Admin target initializes empty private storage;
separate DB targets can still start empty without financial writers.
The installer refuses to initialize an existing `current` release, linked or
nonempty private directories. After dependency installation it creates new encrypted Settings and
a private bootstrap/key in `<target>/shared/bootstrap/`, and passes that bootstrap
to PM2. Existing deployments reuse it without changing their key.
No local secrets or balances are copied; Gold is disabled, production Dollar/World
writers are unconfigured, and default standalone local ledgers may initialize
empty state. Back up the key separately. Retries reuse initialized storage,
even if a later build/TLS step failed.
Required Admin authentication/login source must be Git-tracked; incomplete
releases are rejected during review rather than uploaded.
An integrated-only content snapshot imports on a fresh server without `sites.json`.
Managed sites reuse an existing matching registry; mismatches are rejected before
content is written. An empty or absent registry automatically creates new canonical
site records from published pages, themes and presentation settings, validated
before creation. Source ownership, balances, rewards, uploads, page IDs and history
are not copied into new sites. Conflicting data folders are refused; referenced
media is not transferred. Later deployments and retries map the original published
site keys to the new records without importing source rewards. Restore the matching
registry and private data for recovery; never delete existing state to force setup.
Content import runs
before switching the active release. Separate `import-pages`, `pm2-start`,
`pm2-startup` and `health` console markers identify activation failures.
Before health checks, PM2 state is saved and its persistent `pm2-<ssh-user>`
systemd service is started. If the daemon was launched outside that service,
it is stopped before the service restores the saved processes, so financial
writers never overlap and the app survives the temporary deployment job exiting.
The importer resolves the release's CMS data link to its physical shared-storage
path before opening journals. This keeps journal paths stable across releases
without relaxing the ledger's symbolic-link protection.
CMS startup resolves the same shared data root, so managed-site journal namespaces
match the importer and remain stable across releases. Gateway health retries do
not parse failed HTTP responses; on timeout the console includes bounded PM2
error/stdout tails before rollback to expose the underlying startup failure.
Internal hostname probes send `X-Forwarded-Proto: https` to the loopback gateway
to match Nginx's HTTPS forwarding; Admin continues rejecting plain HTTP access.
Both internal and certificate-verified HTTPS probes log each hostname and HTTP
status, and identify the hostname on connection or unexpected-status failures.
Import prerequisites emit specific `import-fresh-conflict`,
`import-registry-mismatch` or `import-template` failures directly into the console.
The first specific failure is retained when the shell subsequently reports a
generic import failure. DNS resolution emits one progress event for the entire
assigned hostname list, not one identical message per hostname.

Run `node scripts/init-settings.js` as the service account to initialize an
external bootstrap and independent encryption key. The default bootstrap is
`/etc/featheral/bootstrap.json` on Linux or `%ProgramData%\Featheral\bootstrap.json`
on Windows; `FEATHERAL_BOOTSTRAP_FILE` may select another absolute external path.
Private files use 0600 on Unix; restrict Windows ACLs manually to the service
account. Keep the key outside the repository and ledger backups, backed up
separately. Sign in to Admin with the origin or Dollar reserve wallet before opening
Settings. HTTP is accepted only from loopback `admin.localhost`; production requires HTTPS.

`GET /api/settings` returns redacted values and a revision. `POST
/api/settings/challenge` binds a change to that revision and Admin origin/session.
`POST /api/settings` consumes a five-minute single-use Admin-wallet signature, validates
limits and verifies a changed credential before atomically persisting
AES-256-GCM ciphertext in the private `data/system-database/` named system database.
Legacy password hashes may remain encrypted for migration compatibility but grant
no Admin access. Settings changes invalidate outstanding credential approvals
and deployment plans. HTTPS, host restrictions, same-origin writes, bounded request
bodies and rate limits protect the API. No credential reveal/export endpoint exists.

Stop an existing writer and take a consistent offline backup before running
`node scripts/init-settings.js --migrate-env`. This explicitly imports the old
runtime configuration (including encrypted root-vault credentials when
configured), verifies database read-back, then removes the migrated `.env` and
imported legacy Admin JSON. Preserve a customized Admin JSON before upgrading
and supply its backup path as legacy `ADMIN_CONFIG` during migration. Deployment remains
disabled until reviewed. Migration refuses legacy SSH-key authentication rather
than discarding it; re-enroll a password credential in Settings. Keep the original
external vault key and journals for recovery. For existing encrypted JSON Settings,
If there is no existing Admin password or the old deployment uses an SSH key,
use `node scripts/init-settings.js --migrate-env --setup`. It archives the exact
source configuration encrypted beside the external bootstrap, leaves the SSH key
file untouched, preserves supported settings and keeps deployment disabled.
Start the service and sign in
at `http://admin.localhost:8080/#/settings` (use the migrated port) with an authorized
wallet, then enroll the replacement SSH/sudo credential. Normal API saves require
the wallet session and a separate signed approval, not an Admin password.
All migrations retain encrypted source backups in
`migration-backups/` beside the bootstrap using AAD `featheral-legacy-migration-v1`. For existing encrypted JSON Settings,
Invalid/missing legacy fingerprints are archived and left unset during credential-free
setup; credential re-enrollment pins the key after successful verification.
New Windows bootstrap/key and backup
files are ACL-restricted to the account running initialization. For existing encrypted JSON Settings,
run `node scripts/init-settings.js --migrate-settings` with their original bootstrap
first. Unknown environment names, conflicting aliases or conflicting saved values
abort migration without removing source configuration.
No startup process silently rewrites `.env`; gateway startup refuses a leftover file.
Process environment no longer overrides application configuration. Only the external
bootstrap location and ordinary OS/service-manager environment remain external.
Startup also rejects legacy application variables supplied by a service manager;
export them to a private migration file and remove the overrides after migration.
Use `--env-file <absolute-path>` for the real shared file, not its release symlink,
and `--bootstrap-file <absolute-path>` for an existing external bootstrap.

The Settings API retains the complete low-level runtime schema for advanced
operators; the compact UI exposes only the curated, site-scoped controls. Use the
protected Settings API or offline configuration migration for other values.
Secret values are always
blank, with only a configured indicator. Blank secrets retain the saved value;
explicit Reset (or an API `null`) removes it. Runtime edits require `APPLY RUNTIME SETTINGS` and origin
approval. Restart the service afterward; the API/UI reports restart-required state.
Changing storage paths, writer identities, authorities or reserve mode requires a
consistent offline backup and review. Live reserve mode can allocate funds on restart.
Profiles, balances, existing financial identities and other domain data stores are
preserved. Linux user accounts remain OS-owned; only connection configuration is
stored in the system database.

Upload limit: 1–1024 MiB; HTTP timeout: 5–3600 seconds; SSH timeout: 5–120 seconds;
deployment timeout: 60–7200 seconds. CMS body parsers and gateway timeouts use saved
values. Feature-specific limits may be lower. Nginx body/proxy timeout changes
apply on the next reviewed deployment. Public ports 80/443 and DNS must reach the
target for Let's Encrypt. Deployment enables `certbot.timer` and installs an
Nginx validation/reload hook for automatic certificate renewal.

The single Admin site dropdown includes every core and hosted site individually. Selecting a site opens its primary management workspace, while cards expose service, content/appearance and deployment links as appropriate. `#/operations` lists native service workspaces and application shortcuts. App membership, teams, missions and grants use `#/intranet`; Silver products, encrypted stock and fulfillment use `#/silver`; Notes reward programs, balances and explicit market funding use `#/notes`. Old per-site `note-markets` URLs delegate to that same Notes view, not a second funding implementation. Reserved and already-funded markets cannot be funded, insufficient treasury disables funding, and the exact approval phrase and confirmation remain required.

Site navigation stays scoped to the selected site. Return to **All sites → Settings**
for deployment. Review, exact approval, status and the progress console share the
single Deployment card; old `#/deployment` links redirect to `#/settings`. Connection
edits invalidate the displayed plan and must be saved before a new review. This
does not synchronize balances or perform Ethereum reconciliation. Public site
navigation does not show Admin links.

Deployment reads verified Settings, never operational environment variables.
Enable it only after checking prerequisites, generate a fresh plan, and sign its
exact digest with the origin wallet. SFTP uploads code and published content; SSH
starts a singleton systemd setup job using the approved credential on stdin for
sudo. The script provisions Node 24, PM2, Nginx and Certbot on Ubuntu/Debian and
preserves financial data. Before the first release, restore private data,
encrypted Settings and the original external bootstrap/key on the target. The SSH
user must own the target and have sudo rights, or be root. Existing SSH policy is
never relaxed. Credentials and private data are not uploaded or synchronized.

`db.featheral.com` serves the new SQL-free journal service's public staged status.
Admin `#/database` verifies chains and browses transaction metadata, not private
document values or vault ciphertext. Existing SQL stores are still authoritative:
no reset, upload deletion or signing-key replacement has occurred. Native
adapters, upload/reference preservation and cross-namespace atomic settlement
must be completed before the approved local-only cutover. See the root README's
file-ledger migration section for layout, durability limits and key recovery.

### Featheral Notes

`notes.featheral.com` (`notes.localhost:8080` locally) is the public currency/reward service. Its homepage separates system-native FTH$ (Featheral Dollar) and FTHX (Featheral Exchange Token) from notes ranked by last-24-hour FTHX trading volume. Native notes cannot be earned through regular rewards. Their public `/api/creation/trending` records have `native: true`, exact string `supply`, `circulating`, `reserved` values and `decimals`. Dollar totals come from the authoritative Dollar ledger (18 decimals), through a read-only adapter independent of payment-writer permissions; FTHX supply sums all global FTHX entries (whole units). Circulation includes treasury holdings and excludes redemption reservations, matching Dollar's existing summary. An unavailable Dollar ledger is explicitly shown as unavailable, never as zero. Authenticated wallets create a unique named note for **1,000 FTHX**, transferred atomically to the existing system treasury account. The definition and both fee entries commit together; identical retries return the existing definition without a second charge. Built-in and placeholder symbols are reserved. New symbols are unbacked credits, not Ethereum tokens or reserve claims.

Public `/api/creation` endpoints on Notes and the Sites base use a separate wallet-signature challenge/session system, same-origin writes, explicit prices and ownership checks. Sessions expire after 24 hours. `/trending` is public; `/me` lists only the authenticated wallet's holdings, definitions, websites, note/site integrations and pending requests. Both base hosts support note creation and website preparation/completion; hosted tenant paths cannot invoke these creation APIs. Privileged `/api/notes` and CMS APIs remain administrator-only; making Notes public does not expose their audit data. Admin's Notes preview redirects to the canonical Notes homepage so it displays the live ranking and public creation experience rather than the generic CMS shell.

Both homepages offer **Website only** and **Website with a note**; Notes' primary action is **Mint a note**. Every newly minted note requires a new website, at `sites.featheral.com/<slug>`, even when minted from Notes. Minting transfers 1,000 FTHX and atomically reserves a site request with the note definition; invalid or unaffordable site reservations roll back the note fee. The subsequent signed site payment transfers 500 FTH$. These are separate transactions, not a cross-ledger atomic bundle: after reservation, if site payment or provisioning fails, the note remains owned and its site request can be resumed. Identical mint retries preserve the same site request and never charge the note fee again; changing its site name/slug is rejected.

`POST /api/creation/notes` requires `{symbol,name,site:{slug,name}}` and returns the note plus its signed-payment `request`; standalone mint requests and `siteKey` are rejected. `POST /api/creation/sites/prepare` supports standalone sites or an existing owned `noteSymbol`. Completion records ownership, integration and disabled rewards together, then creates an unfunded community-note market definition. `PUT /api/creation/owned/:key/note` still links existing owned resources without another fee. All links check both ownership records and exclude native/placeholder currencies. Identical relinks preserve owner-edited rewards; a different note sets 10%/1-unit rewards disabled. Owner `/settings` GET/PUT edits website name and directory description without exposing feature controls. Both homepages show ownership and pending requests; Sites browsing searches names, descriptions and linked-note symbols.

### Placeholder markets

Notes seeds 53 placeholder market definitions: FTHA–FTHZ except existing FTHG and FTHX, FTH0–FTH9, and the suffixes `# @ ! % ^ & * ( ) - _ + = . , : ; ? ~`. FTH$ remains the existing Dollar, not a new placeholder; FTHX remains the quote asset and FTHG the existing Gold token. Definitions alone create no supply, fees or funded reserves. Existing user definitions are not overwritten.

The 19 special-character placeholders remain reserved but are hidden from public trends and market listings; quote, new trade and funding requests are rejected even for previously funded pools. Existing balances, pool reserves and trade history are preserved, as are idempotent receipts for already executed trades. Native FTH$ is not a placeholder and stays visible. Admin lists these symbols as reserved with no funding controls.

FTHG is also reserved and excluded from Notes trends and public note-market listings, including legacy definitions. Its existing Gold asset and balances are not deleted. Trending cards use the main feather geometry with alphabet-based colors (for example FTHB blue, FTHR red, FTHO orange, FTHY yellow). FTHX uses dark metal gray in both trending and circulation cards; native FTH$ retains its themed logo.

Notes and Exchange show actual pool spot ratios with exact string numerators/denominators, and bucketed executed-trade prices. One interval selects 1 hour, 24 hours, 7 days or 30 days for all charts, without changing the real 24-hour volume ranking. Buy execution price is FTHX input/note output; sell price is FTHX output/note input. Each bucket retains its last executed price; missing buckets are not fabricated. Unfunded/no-pair notes (including native FTH$ and FTHX) show **No market price**. Empty histories explicitly say no executed trades. Spot ratios exclude execution fees and price impact; users must quote before swapping. Mock charts have been removed.

The Notes market view is card-first: feather/symbol, price/change, history and compact real 24-hour volume. Trading controls link to Exchange instead of executing on Notes. Interval and refresh controls sit above the cards. Native circulation and wallet creation/management remain expandable.

Featheral Exchange uses `/api/creation` wallet sessions and real FTHX markets, not demo balances. Only the Exchange host accepts trading-account writes or liquidity management; hosted tenants cannot invoke these APIs. `GET /markets/:symbol/history?interval=24h` returns exact executed OHLC ratios, base/quote volumes and close-price points (also `1h`, `7d`, `30d`); empty candles are not fabricated. `GET /markets/account` returns main-wallet LP positions and liquidity history. `POST /markets/liquidity/quote` accepts `{symbol,action:"add"|"remove",amount}` (FTHX budget for add, shares for remove). `POST /markets/liquidity` includes exact quoted `{base,notes,shares}` and request ID. Changed quotes, foreign withdrawals and insufficient balances fail atomically. Liquidity provision transfers both existing currencies proportionally and returns proportional reserves on removal, including fees. Initial funding allocates 1,000 permanently locked shares and 999,000 treasury shares. Initial funding remains admin-approved and creates no FTHX. Old `/api/public/exchange` demo routes on Exchange return 410; independent hosted demo sites are unchanged.

#### Exchange trading accounts

Exchange-only routes under `/api/creation/trading`:

- `GET /markets?interval=24h`: verified public pools, executed OHLCV and valuation references.
- `GET /account`: authenticated trading holdings/portfolio, completed trades, movements and recoverable legacy settlements.
- `POST /deposit`: `{symbol:"FTHX",amount,requestId}` moves existing whole FTHX from the authenticated owner's wallet into isolated trading custody. Other deposit currencies are rejected.
- `POST /quote`: `{symbol,side:"buy"|"sell",amount}` quotes the chosen FTHX pair.
- `POST /trade`: add exact `minOutput` and unique `requestId`; only trading custody is debited.
- `POST /withdraw`: `{symbol,amount,requestId}` withdraws FTHX or an acquired asset to the same owner, never an arbitrary destination.

Amounts are positive integer **base-unit strings**: whole units for notes/FTHX,
18 decimals for FTH$. Atomic balanced note entries and immutable request
fingerprints prevent duplicate debits. Native Dollar trading credits are backed
by pool custody and excluded from executable pool reserves. Dollar withdrawals
persist a deterministic signed settlement before committing to the Dollar ledger;
an interrupted withdrawal blocks competing Dollar operations until retry/recovery.
No new supply is issued. Main-wallet portfolio totals include trading holdings,
but main-wallet spendable balances exclude them.

The terminal provides spot candlesticks, volume, SMA20, four timeframes,
zoom/pan/fullscreen, quote expiry, minimum output/slippage confirmation, positions,
trades and movement history. It preserves request IDs after uncertain submissions.
Trading sessions remain in memory. Built-in wallet sign-in uses a central
user-approved popup returning only the exact sign-in signature, not keys or tokens.
No leverage, fabricated order book or executable opening liquidity is added.

Gold reserve and Ethereum bridge/staking screens run on Exchange at
`/gold-channel/` and `/ethereum/`, reusing the existing central assets and Gold/
Dollar APIs. Their former top-level page URLs redirect there; actual contracts,
original authorized signing keys and reserve obligations are unchanged.
`GET /api/creation/economy/reference` on the central wallet origin exposes the
same public valuation of one FTH$ to legacy helpers, with a restricted Featheral
CORS origin allowlist. It never authenticates or returns private account state.

The shared HTML gateway also adds a scroll-to-top control across sites, independent of telemetry privacy opt-outs. It appears after 300px of document or main-panel scrolling, respects reduced motion, and is omitted from embedded operations consoles.

### Dollar wallet and FTH$ routes

The common wallet shell and client are served at `/wallet/` on `dollar.featheral.com`, `ex.featheral.com` and `notes.featheral.com` (including `.localhost`). Only the default primary asset/branding changes: FTH$ for Dollar, FTHX for Exchange/Notes. These are views of the same ledger holdings, not separate custodial deposits. Existing Classic roots, note minting and FTHX liquidity tools remain. Connect the same wallet separately per origin; authentication tokens are not passed across sites. The gateway dispatches native `/api/v1/dollar/*` reads/transfers to Dollar on all three wallet hosts rather than protected CMS administration.

The wallet's **Swap** tab replaces Thanks. On the central wallet and Exchange hosts, `POST /api/creation/wallet/swaps/quote` quotes FTH$, FTHX and funded notes through live Exchange pools. Authenticated `/prepare` binds `{from,to,amount,minOutput,requestId}`; `/:id/complete` executes the same request exactly once, with a wallet signature for outgoing FTH$. `/:id/refresh` recovers pending requests and `/:id/cancel` discards only unsubmitted preparations. Native note-to-note routes settle both FTHX-pair legs atomically; FTH$ routes reuse the signed settlement journal. Every executed pair leg contributes to Exchange trades, volume and candles and appears as a wallet trade in the Exchange terminal. Fees are 0.3% per hop, with price impact and a strict quoted-output minimum. Unfunded markets cannot trade. Ethereum FTHG conversion stays on Gold; its USD estimate is never a swap price. Existing authenticated note-transfer/tip APIs remain compatible for other callers.

`GET /api/creation/dollar-pool/market?interval=24h` (also `1h`, `7d`, `30d`) returns real 24-hour FTH$/FTHX volumes and completed trade counts, plus both assets' spot ratios and bucketed executed-price histories. Routed trades contribute their actual FTHX intermediate leg, once; initial funding and unsealed settlements are excluded. Pending settlements suppress spot prices until recovery. `/trending` merges these native pair histories/volumes with existing note markets, ranking by real FTHX volume. FTHX's total includes its community-note and Dollar pair legs.

Dollar's root retains its original CMS landing page and header links; `/wallet/` serves the standalone wallet app with shared core-site navigation and Home/Explorer/Docs links. World's legacy embedded wallet and Dollar explorer remain intact. The app signs through the user's existing injected wallet and has no seed/private-key import or custody. Its origin-scoped `/api/creation` session reads `GET /wallet` (authoritative FTH$ balance/nonce/history, global note holdings, wallet note transfers, pool positions and exchange requests). `POST /wallet/send/prepare` builds an exact native Dollar transfer message; the signed transfer uses the original `/api/v1/dollar/fth/transfers` API. `POST /wallet/notes/send` transfers existing whole-note balances atomically with owner/request-ID retry protection. FTH$ uses 18 base-unit decimals; the wallet display remains at most two. FTHX/note swaps use existing Exchange quotes and minimum output.

The separate FTH$/FTHX pool supplies native Dollar trading liquidity. `/dollar-pool` reports actual reserves and settlement availability. Legacy `/dollar-pool/prepare` and `/markets/trade` still return 410; new wallet swaps use `/wallet/swaps`, while terminal orders use trading accounts. Existing `/:id/refresh` and `/:id/complete` settlements remain recoverable on Exchange, charging the original 0.3% per pool. Native FTH$ settlement requires explicit writer mode and the **original genesis-authorized game settlement key**; an unconfigured development ledger does not enable conversion. No signing key or deployment mode is automatically changed.

Exchange's **FTH$/FTHX initial liquidity** form requires administrator authentication, a wallet session, explicit FTH$/FTHX amounts, the exact phrase `FUND FTH$ <18-decimal-base-units> BASE_UNITS <whole-units> FTHX`, and a wallet-signed FTH$ transfer. `POST /dollar-pool/fund` binds that approval to an immutable request. Both currencies come from existing balances owned by that connected wallet, not minted credits or an automatic treasury debit. This is initial committed pool capital, not an LP deposit/withdrawal interface. It stays unfunded until the operator explicitly completes the workflow.

The exchange service journals the phases `prepared`→`paying`→`paid`→`settling`→`complete`. Only input notes are reserved before the signed Dollar payment seals. Notes changes and a deterministic signed Dollar settlement are persisted together before payout; pending settlements block competing pool mutations and recover on startup or owner resume. Dollar settlement uses balanced transfers from dedicated escrow/pool accounts, not arbitrary wallet or treasury debits. A consumed conflicting nonce yields a replacement-signature request without releasing or double-debiting reserved inputs. Prepared quotes can be refreshed; identical completed requests never charge again. Failed settlement is explicitly reported, never presented as a completed swap.

World's new **Authorize World budget** signs `separateWorldFunds: true` on `/api/dollar/game/wallet/link`; the exact message comes from `/wallet/funds/authorization`. Existing legacy direct-wallet sessions stay unchanged until opt-in. Authorization moves no funds and retains the deterministic World guest account. Same-origin `/world-funds.html` uses authenticated `GET /wallet/funds`, CSRF-protected `POST /wallet/funds/prepare`, `/complete` and `/cancel` (all under `/api/dollar/game`). Deposits sign exact native Dollar transfers; withdrawals sign the World account, exact base-unit amount, fixed authorized destination, request ID and origin. Parameters are immutable per owner/request ID. Persisted deposit signatures and balanced withdrawal journals recover lost receipts without another debit. Conflicting deposit nonces require a refreshed preparation and signature; unsigned preparations can be discarded. Gameplay uses only World funds in separate mode. Existing legacy guest-transfer signatures remain supported but cannot authorize separate-mode changes.

`GET /api/creation/wallet` includes a portfolio for native FTH$ and note holdings. Public `GET /api/creation/wallet/portfolio/:account` values a read-only World account's native FTH$ only. Funded FTHX/community-note spot ratios require authoritative matching reserves and no pending routed settlement; unpriced assets are listed separately. Gold supplies verified mainnet bridge ratios for FTHG estimates. Its timeout-bounded USD lookup reads the read-only Uniswap v4 ETH/FTHG valuation pool (`VALUATION_POOL` in `services/gold/prices.js`) via StateView and multiplies its spot price by ETH/USD. With an uninitialized or liquidity-free pool, or a read error, it publishes the labeled temporary **1 FTHG = $0.01** reference, including `fallback: true` and `marketError`; this is not a market quote. Results are cached for one minute before retrying; successful pool results replace the reference automatically. Consumers require a source timestamp no older than five minutes. Internal USD estimates still require verified Gold conversion ratios; FTH$ is not USD. Neither the separate World budget nor legacy duplicate accounts are added to the connected-wallet subtotal.

Portfolio assets and native ETH entries expose exact 18-decimal USD base units as `usdValue`; mainnet FTHG uses `ethereumUsdValue`. Wallet rows show USD and primary-currency estimates beneath each asset balance, scaling combined wallet/custody valuations to the actual held portion. Totals remain below the available balance. USD estimates display four decimal places; primary-currency estimates use at most four. Both round using integer arithmetic; positive values below that precision show `<$0.0001` or `<0.0001` in the primary currency. Missing prices stay unavailable. Native ETH USD values retain their independent feed rather than inheriting the FTHG reference label.

Fresh mainnet Gold snapshots with an initialized native `goldReserve`, matching token, valid genesis/evidence and consistent cap/allocated/remaining totals supply their recorded conversion rate for valuation independently of the separate Ethereum bridge. The source is `native-reserve`, explicitly labeled as obligations rather than confirmed backing or executable liquidity. Unknown/malformed reserve and bridge states still cannot invent a conversion.

Dollar can display World guest funds without an injected wallet. `/wallet-sync.html` on the canonical World host makes a same-origin authenticated `GET /api/dollar/game/wallet/balance` (exact `{accountId,wallet,available}`; no-store), and returns to the fixed Dollar `/wallet/` URL with only the public `worldAccount` ID in a fragment. A top-level handoff preserves host-only/SameSite session protection even on `.localhost`, where a cross-site iframe cannot read the existing session. Dollar consumes/removes the fragment and stores only that public account ID; it polls `/api/v1/dollar/fth/accounts/:accountId` for the real spendable balance. Guest view is read-only and clearly labeled; a separately connected wallet is never merged with it. No session creation, cookie export, automatic fund transfer or signing capability is involved. Use **Sync World account** again after changing the linked World identity; missing sessions/errors are shown explicitly.

Each of the 34 letter/digit placeholders requests **1,000,000 existing treasury FTHX + 1,000,000 newly issued placeholder units**. Funding is never automatic. In Admin, select Notes and open **Note markets & funding**. The protected `POST /api/notes/markets/:symbol/fund` requires same origin and the exact phrase `FUND <symbol> 1000000 FTHX 1000000 NOTES`. Funding debits the existing system treasury, credits the pool and records initial placeholder issuance in one SQLite transaction. Insufficient treasury balance fails without any issuance. Each pool can be funded once. The 34 eligible pools would require 34,000,000 FTHX; the current supply is insufficient and must not be replaced with demo liquidity or newly minted FTHX.

Public `GET /api/creation/markets` lists funded/unfunded pools. On Notes, `POST /api/creation/markets/quote` returns a whole-unit constant-product quote with a 0.3% fee; `POST /api/creation/markets/trade` requires a wallet session, symbol, buy/sell direction, integer amount, minimum output and unique request ID. Buy spends real global FTHX; sell spends the selected placeholder. Four balanced entries, pool reserves and the trade record commit together. Retries return the original receipt and conflicting parameters are rejected. No Ethereum transaction or Dollar/demo balance is used. Fees remain in pool reserves. Trading does not mint FTHX; custom-note reward issuance remains separate. Existing system assets do not receive new placeholder pools.

The first content on the Notes homepage ranks all notes by **last-24-hour executed FTHX volume**, counting buy inputs and sell outputs once per trade, not reserves, reward activity or fabricated volume. FTHX shows aggregate quote volume across pairs; each other note shows its pair volume. These per-note volumes are not summed as independent totals. Native circulation is shown separately below the ranking. Unfunded markets show zero volume and disabled trading. Non-placeholder community currencies currently have no configured pool. A Refresh volumes control loads the latest ranking.

Notes owns the Dollar API implementation in `services/notes/dollar.js`; the original `services/notes/dollar.js` remains a compatibility export. Existing `/api/v1/` endpoints, Dollar URLs, game funding, signing keys, ledger files and Gold backing rules remain unchanged. The same authenticated API is available on the Notes host. No second FTH$ ledger is created. Activation of either FTH$ or FTHX regular reward programs explicitly fails. Existing native program records are treated as disabled at read and execution time, without rewriting balances or historical payouts.

FTHX accounting is global in ignored `data/notes.sqlite`. At startup each registered site's old `qprn_ledger` is imported once with source IDs, row counts, totals and SHA-256 audit digest; old tables are preserved. Wallet balances sum all original site entries. A changed legacy source after migration prevents startup instead of double-crediting it. Public FTHX top-ups, tips, posting costs and shop/demo FTHX operations now use this global balance within SQLite transactions; other demo assets remain site-local and are not the real FTH$ ledger.

Community rewards are disabled by default until a community note is selected and enabled. The first authenticated like **or** comment from another wallet on member-created content records one server-side random draw for that site/content/reactor pair. Default chance is 10% and payout is 1 unit of the selected community note to the creator, not a transfer charged to the reactor. Self-reactions and guests are excluded; losing draws, retries, undo and switching from like to comment cannot reroll. Wallets are not proof of distinct people; this is credit issuance, not a valuable-token anti-abuse system. Existing paid-like records are imported as already-attempted. CMS-edited whitepapers are preserved; untouched original or previously upgraded FTHX documents receive revised mechanics with revision history.

Admin-authenticated APIs: `GET /api/notes`, `GET /api/notes/sites`, `PUT /api/notes/sites/:key/rewards`, and `GET /api/notes/wallets/:address`. Writes require same origin. Database backups must include `notes.sqlite` and all source datasets; no private balances/history are added to Git or remote-deployed automatically.

The Ledger site exposes public, read-only Notes browsing through `GET /api/notes/ledger/currencies` and `GET /api/notes/ledger/:symbol/entries`. Entry reads support an optional `address`, a `before` entry-ID cursor and a `limit` from 1 to 100. Pages are newest-first and keyset-paginated; Notes database entries are not hash-chained blocks. FTH$ remains on its separate native daily-file currency ledger.

All core frontend folders are under `sites/`, named by full hostname. World serves its getting-started landing and settlement/federation game from `world.featheral.com/play/`; the former World social frontend now belongs to `media.featheral.com`. Its existing CMS overrides and feed database remain intact. Media owns moderation (`#/operations/world` remains compatible); World has no social moderation screen. Backend folders use ownership names (`database`, `gold`, `notes`, `identity`, `wallet`, `media`), and Admin screens are in `pages/`. Exchange and Stats serve their own shells while reusing the managed-site renderer/assets. The site dropdown uses canonical full URLs as both labels and option values (including hosted website paths); selection resolves to existing dataset keys or integrated editors without renaming databases.

### Free websites

`sites.featheral.com` hosts wallet-owned websites at `sites.featheral.com/site-name/` (`sites.localhost:8080/site-name/` locally), with a one-time creation fee and no recurring hosting charge. Its frontend shell and assets live in `sites/sites.featheral.com/`; the homepage retains editable CMS content and lists published hosted websites.

On **sites.featheral.com**, connect your wallet, enter a lowercase website address and display name, then confirm the **500 FTH$** creation fee. The wallet signs a native Dollar treasury transfer in 18-decimal base units, not an Ethereum transaction. Demo balances are not accepted. A durable request reserves the address and binds the exact owner, payload, amount, recipient, nonce and memo before payment. After the transfer seals, the website and ownership record are provisioned. Retries reuse that ledger transfer; restart recovery resumes saved signed requests. If another transfer consumes the nonce, preparation can safely issue a replacement only after detecting the conflicting ledger transaction. Pending requests appear in the owner's dashboard; at most three unfinished addresses can be reserved per wallet.

Each website gets a separate dataset such as `data/sites-featheral-com--site-name/`, including pages, revisions, theme, feature settings, media and public databases. The owner dashboard edits safe page HTML, publishes additional pages, changes the theme and configures rewards using only the owner's registered community notes. FTH$ and FTHX are not reward choices. Ownership is checked on every operation, independent of Admin permissions. Registry records share the base hostname but have distinct `path` and `key` fields. API requests and browser storage are scoped to the selected website; unknown names return 404. Names must be at most 63 characters and cannot use reserved API/asset/admin routes. Existing websites are not reassigned to arbitrary wallets.

`notes.sqlite` contains currency definitions, creation fee entries, wallet sessions, durable payment requests and website ownership. Preserve it alongside original Dollar ledgers, signing keys, `sites.json` and CMS datasets in a consistent private backup. Ownership and paid-request state are private runtime data, not source-controlled deployment content. Old Admin `/api/sites` POST and Notes `/api/notes/sites` POST return 410; there is no unpaid public creation bypass. Internal fixture/import/bootstrap provisioning remains available for restoration, not as a public API.

Public wallet sign-in enables paid creation and ownership-scoped editing; Admin authentication still enables ecosystem administration. There is no automatic remote deployment. Content uses the existing safe CMS renderer, not arbitrary uploaded HTML/scripts; path-hosted websites share a browser origin and are not a security boundary for running untrusted code. Reviewed deployment snapshots preserve each website's path; private datasets still require the matching restored registry and Notes ownership database. Traffic overview and Stats identify each hosted website separately by hostname/path.

### Ecosystem statistics

**All-site overview** displays aggregate traffic for every integrated and registered site, including Admin and World. Each site card's **Overview** opens its own hourly/daily charts. The charts contain exactly 24 hourly and 30 daily UTC buckets, including zero-traffic periods, and can be refreshed.

Sites and All-site overview show the same chart-first dashboard. Each card has compact overlaid favicon, description, status and management links; descriptions are limited to two lines with an ellipsis. Charts default to hourly (24 hours); one header interval selector controls all charts. UTC windows and bucket scales are labeled. Only reviewed-deployment controls remain below the dashboard; Admin's Add-site feature is removed. No port badge is shown.

Charts default to hourly line charts for the last 24 hours, with minute and daily options. Minute collection starts with this update; earlier hourly totals are preserved, not interpolated into invented minute data. Minute storage retains only the last hour. The redundant All-site overview sidebar entry is removed; Sites opens the dashboard and old overview URLs still work. Admin Sites and Stats begin with a full-width aggregate chart showing summed page views for the selected period, the site count, colored per-site lines and favicon legends. Stats shows the same shared per-site charts in its dedicated read-only dashboard. These are page views, not unique visitors.

One interval dropdown in the page header controls every chart, including the aggregate. Admin refresh preserves the selected interval. Charts include light quarter-step grids, numeric page-view axes and UTC time/date ticks. The redundant Admin overview header banner is removed.

All per-site traffic charts use one shared zero-based scale calculated from the largest minute, hourly or daily bucket across the complete report. Filtering a site or switching timeframes does not rescale it; equal counts have equal line heights across sites. The aggregate chart has its own explicitly labeled scale based on summed buckets across all sites and periods, so the total line is never clipped. Refreshing uses the updated report maximum. Core icon gradients and chart colors share `shared/site-colors.json`; regenerate assets with `npm run build:logos` after changing this palette.

Stats, the Sites directory and Notes have distinct blue, green and violet brand accents matching their icons. Their existing theme backgrounds and content remain unchanged; hosted websites keep their independently selected theme accents rather than inheriting the Sites directory color.

`stats.featheral.com` serves a dedicated statistics application rather than the X media frontend. Its charts load independently of legacy CMS homepage/Stats feature settings, so imported empty or media-configured records cannot turn Stats into a media feed. The public endpoint exposes only aggregate page views; other managed sites still require **Show public ecosystem traffic charts**. Existing CMS content is preserved but is not the Stats landing page. Local access is `http://stats.localhost:8080/`.

Stats opens directly onto the charts without an introductory header card. Its theme-matched interval selector and **Refresh statistics** button sit together above the charts with 44px touch targets. Stats uses the shared family header rather than X's fixed media shell, retaining its title on mobile and the same content-aligned width as the other family sites.

All served HTML receives the aggregate collector; SPA hash/history navigation is tracked, while embedded operation consoles are excluded to avoid double-counting the shell. It stores only hostname, UTC hour and page-view count in ignored `data/telemetry.sqlite`, never IPs, visitor IDs, wallet identities, referrers, route/query strings or page content. Do Not Track and Global Privacy Control suppress collection. Existing managed-site visitor analytics are separate and unchanged.

`POST /api/telemetry/hit` accepts only `{}` from a recognized same-origin site. `/api/telemetry/report` requires admin authentication. `/api/telemetry/public` exposes these aggregate-only charts on a Stats-enabled managed site (or authenticated CMS preview); richer visitor analytics are never included. Collection starts with this feature, not synthetic historical data. Adding Stats locally does not deploy or configure remote DNS/TLS.

The existing media data set is registered as **x.featheral.com** in `data/sites.json`; its original folder is retained to preserve all media and content. Use the sidebar selector or **Sites → Select site** to manage its content and theme.

Existing hostname-based sites remain manageable in Admin. Public creation supports only wallet-owned paths on `sites.featheral.com`, not new custom hostnames. Site datasets contain `db.sqlite` (an imported-data-compatible database), `cms.sqlite` (content and theme), `public.sqlite` (wallets, comments, votes and analytics), and `uploads/`. Content and settings remain isolated; FTHX wallet credits are global.

Public requests select the site by hostname; unregistered hostnames do not serve another site's data. On localhost, the selected site's **Public site** link uses `/?site=<key>` to preview it, including its own API requests and browser storage. Preview selection requires CMS access. Adding a site does not configure DNS or TLS; point each hostname at your HTTPS reverse proxy separately.

The app routes `admin.featheral.com` to the CMS and `x.featheral.com` to the public site using the request hostname. Configure DNS and your HTTPS reverse proxy to send both hostnames to this Node server. The CMS and privileged APIs require a signed origin/Dollar reserve wallet session; no HTTP Basic or localhost bypass is supported. Writes require the same Admin origin.

CMS-managed posts and pages are stored in `cms.sqlite` beside the imported site data. Drafts remain private; published text posts and pages appear in the public site's **Read** section. The **Public themes** screen switches the public site between Featheral, Editorial, and Ocean styles. The selected style is stored with the CMS content.

### Sample sites and professional themes

Automatic sample provisioning is disabled (`sampleSites: false`). Journal, Studio, Launch and Shop registrations and stored data have been removed; X and Exchange remain. Templates remain available for explicitly creating new sites. If `sampleSites: true` is deliberately re-enabled with site management, startup registers missing sample sites without overwriting existing registrations or content:

| Site | Template | Theme |
| --- | --- | --- |
| `journal.featheral.com` | Editorial magazine | Journal: crisp monochrome and lime |
| `studio.featheral.com` | Creative portfolio | Studio: violet, bold type and project panels |
| `launch.featheral.com` | SaaS concept | Launch: blue, light product cards |
| `shop.featheral.com` | Boutique demo | Boutique: warm minimal retail |
| `ex.featheral.com` | Exchange demo | Terminal: dark mint trading workspace |

These internal templates have independent databases, editable home and sample story content. Public paid creation uses the website template, not an Admin Add-site form. **Public themes** offers all eight styles, independently of homepage behavior. **Site features** chooses the media/CMS/shop/exchange homepage, home page slug, local native currency, feature flags, and per-site age gate. The existing media site's age gate and data are preserved. Setting `sampleSites` to false prevents automatic provisioning; it does not remove existing sites.

### Local native assets, shopping and exchange

**Hosted CMS demo features remain local simulations, not a Layer 3 chain, bridge, or decentralized exchange.** Their demo balances have no monetary value or fulfillment. This section describes only hosted demo features: the core `ex.featheral.com` now uses the real global Notes FTHX ledger as described above, not FTH$ demo pairs.

Connect an Ethereum-compatible wallet for existing signature-based authentication, then **Claim demo credits** once per wallet per site. Credits include FTH$, FTHX and supported demo assets USD$, BTC$, ETH$ and SOL$. FTHX remains whole-number credits in the existing ledger; other demo assets support six decimals. Sites do not share wallets, balances, carts, pools or orders. Local credits are not transferable between Featheral X and the exchange. Existing wallet-signed FTHX top-ups remain available and do not represent cryptocurrency deposits.

The exchange includes seeded FTH$ pairs, exact constant-product quotes, both-direction swaps, configurable slippage/minimum outputs, a three-minute UI quote deadline, fee and price-impact display, pool reserves, LP deposits/withdrawals, positions, and operation history. Add liquidity uses only the proportional amounts within your supplied maxima and enforces minimum shares. Withdrawals enforce both minimum outputs. New base pairs may be created for supported unpaired assets (SOL$ initially) with 0.05%, 0.30% or 1% UI fee tiers. Only one pool per paired asset is supported, not concentrated liquidity, order books or arbitrary token listings. Pools permanently lock 1,000 initial LP units; simulated treasury liquidity funds the seed markets. Fees stay in reserves and LP holders bear price/impermanent-loss risk.

Swap and withdrawal outputs round down to raw token units; liquidity inputs round up. Rounding dust stays in the pool and whole-credit FTHX swaps may have visibly higher rounding impact.

The shop supports a persistent site-scoped cart, FTHX checkout, stock limits, order receipts and wallet-specific history. **Shop catalog & orders** lets CMS administrators create/edit/deactivate products and view site orders. Server prices and stock are authoritative; price changes require cart review. Orders are recorded as `demo-paid` and never trigger delivery.

Demo tables live in each site's `public.sqlite`: `demo_*`, `shop_products`, and `shop_orders`. Pool/product seeds run once per enabled feature and never reset existing data on restart. Mutations use SQLite transactions and idempotent, wallet-scoped request IDs; retries with changed fields are rejected. Amount parsing uses exact units, BigInt intermediate arithmetic, and a maximum of 1,000,000,000,000 raw units. Do not expose these faucets as valuable assets.

APIs: `/api/public/demo/account`, `/api/public/demo/faucet`, `/api/public/exchange/{pools,quote,swap,liquidity/add,liquidity/remove}`, and `/api/public/shop/{products,checkout,orders}`. Authenticated CMS APIs: `/api/sets/:key/cms/settings` and `/api/sets/:key/shop/{products,orders}`. Public mutation APIs require the site's `X-Wallet-Token`; preview queries still require CMS authentication. Configure DNS/HTTPS separately for all sample hostnames.

### CMS editing and usability

The Sites screen includes searchable site cards with direct content, preview, theme and settings links. Storage paths are available under **Storage details**. CMS content lists have status/type filters, title/slug/excerpt search, draft/published totals and 20-item pagination. The summary request omits large bodies; content opens through keyboard-accessible links.

The editor shows word/read-time counts, saved/unsaved status, a safe escaped **Preview text**, a published-page link, and **Ctrl/Cmd+S** saving. In-app navigation and closing/reloading the tab warn about unsaved edits. Saves stay in the editor and prevent duplicate submissions; new drafts reopen at their permanent URL. This is not automatic saving or browser draft recovery.

Each update stores the previous version, retaining the latest 20 versions per content item. **Revision history** restores a saved version as a new update. **Duplicate as draft** creates a unique slug without publishing. Integer revisions detect stale editor saves and restores (409); API clients should send the revision returned by GET when updating. Legacy callers that omit the revision remain supported. Deleting content also removes its history. These versions live in `cms_revisions` within the site's CMS database, not the imported snapshot.

CMS landing homepages must point to an existing published page. Active landing pages cannot be deleted, unpublished, or have their slug/type changed until the homepage setting changes. **Site features** also edits the public display name, header/meta description, and landing footer. Empty branding fields retain hostname/config defaults; omitted metadata is preserved for older API clients.

Sample articles now contain useful original editorial, portfolio, product-concept, store-policy and exchange guidance rather than generic placeholder sentences. Startup upgrades only exact untouched legacy title/body/excerpt combinations; customized or unpublished content is preserved. The store shows an editable quantity and total, demo forms report errors inline, and public pages offer visible keyboard focus and a **Skip to content** link.

### FTHX landing page and whitepaper

On startup, the registered `x.featheral.com` site receives two published CMS pages: **FTHX - Media freedom, rewarded** (`/#/page/fthx`) and **FTHX Whitepaper** (`/#/page/fthx-whitepaper`). Edit them through that site's **CMS content** screen. The public navigation shows **FTHX** and **Whitepaper** only while the corresponding pages are published. Local previews retain the selected site's query parameter.

Installation is transactional and runs once per site database, tracked by `fthx-pages-v1` in `cms_settings`. Existing matching slugs are left untouched; subsequent restarts do not overwrite edits, republish drafts, or recreate deleted pages. Other sites are not seeded. Retain these slugs for the dedicated page styling and navigation. On these pages, short standalone lines after the first paragraph (100 characters or fewer) render as section headings. The existing Swipe homepage and age gate remain unchanged.

The whitepaper describes the local ledger as it works today and labels privacy technology, decentralized networking, popularity-based reward thresholds, and Featheral governance as proposals. These features are not implemented or promised by the branding update.

To turn the original sync features back on, set `allowSync` to `true` and restart the server. The sections below describe those features.

## Public site

The public site is at `http://127.0.0.1:5178/` and the CMS is at `http://127.0.0.1:5178/admin` for local development. In deployment, use `https://x.featheral.com/` and `https://admin.featheral.com/`.

- **Standalone X**: X is not advertised in family headers, footers or Foundation discovery cards. Its own app has no ecosystem header/footer, but retains the shared wallet, age gate, posting, saved likes and existing routes. Its host-scoped visual theme uses warm gradients, rounded discovery cards, prominent action buttons and a compact mobile tab strip with visible labels. Other CMS-hosted sites retain their selected themes. This is a visual refresh, not a dating/matching feature or a change to vote semantics.

### Public startup performance

The shared X/CMS frontend loads `/api/public/info?bootstrap=1` for branding,
features, wallet configuration and the age gate, without building every media
index or calculating unrelated gallery/text totals. The regular info endpoint
keeps its full response. The selected feed supplies its own current round and
counts, avoiding a second metadata request before the first card.
The primary media site's deck and tag indexes are built before the process
accepts requests, including after restarts, so its first visitor does not pay
the cold indexing cost. Other sites remain lazy. This warmup records no views
or votes and does not change rounds; an indexing failure prevents readiness.

Swipe media gives the visible card high fetch priority and starts background
downloads only after it loads. Lookahead is limited to three cards and 12 MiB
including the visible card; an oversized current card is still allowed.
Data Saver and 2G connections fetch only the current card. Card construction
does not bypass this budget, and obsolete requests are cancelled.

Trending, Gallery, Liked and Trash use viewport-windowed grids: at most 80 tile
elements are mounted, and only visible media is fetched. Fast scrolling defers
new downloads until scrolling settles for 120 ms; scrolling away, hiding the
tab, opening a viewer or leaving the route releases image sources and decoded
tile references. Already loaded previews take priority over new candidates and
remain loaded within a 160px viewport-edge margin, avoiding visible images
flipping back to placeholders during small scrolls. This retention shares the
same resource budget; it is not an unbounded media cache. At most two images load concurrently (one with Data Saver/2G).
Every visible tile can show media: Trending/Gallery stills and budget-excluded
originals use 320px WebP previews rather than remaining "Open media" placeholders.
Up to two original GIFs animate (one on constrained connections); other GIFs show
a still preview until opened. Originals share a 16 MiB/16 megapixel budget
(up to 24 sources), reserving 8 MiB/8 megapixels for at most 80 small previews.
A single oversized visible original is allowed. Preview generation uses two
workers, a bounded queue and a 16 MiB/256-entry in-memory cache; it writes no
thumbnail files to disk. Cache keys include file size and modification time.
Queued previews show a loading surface, active requests show a
spinner, and successfully loaded images fade in; reduced-motion preferences
disable these effects. A 20-second request deadline frees stalled loading slots;
failed tiles report the error and can be selected to retry. Opening a loaded tile
shows the original at full quality in the viewer. Grid paging, sorting, votes, undo and
viewer navigation retain their original semantics. Layout uses bounded row
lookahead rather than repeatedly compacting the full list. Pagination reuses
completed rows and recalculates only the new page and its unfinished lookahead;
resizing, deleting and restoring tiles invalidate that layout cache.

CMS templates and parsed classic blocks are cached per source file and refreshed
when file size or timestamps change. Validated document output is reused only
while its template, body, title and description match; published edits and theme
changes appear on the next render. These caches retain one entry per shipped
template, never visitor-specific or wallet responses. Managed Nginx compresses
JavaScript, CSS, SVG and text assets; JSON APIs are not added to gzip types.
- **Discover** (the existing Swipe route): one shuffled deck of every GIF and image post, mixed together, with the title, description and like count (all rounds) overlaid. Swipe right (or press →) to like and keep a post. Swipe left (or press ←) to dislike it: in round 1 this deletes the post and its media; from round 2 the dislike is only counted. Undo with ↺ or Backspace. Each post shows its largest attached GIF, or its largest image if it has no GIF. The shuffle is stable within a round, so leaving and coming back continues where you stopped; each new round is shuffled differently. Only published posts with a downloaded file are included. The next cards' media is downloaded and decoded in the background (always the next 5, and up to 12 within a 600 MB budget). Each card's still frame and blurred backdrop are prepared off the main thread, so swiping never waits on loading or decoding. Only the card on top plays; the cards behind it show a still frame. Each card shows up to 6 of its keyword tags as `#tag` chips (most used first); clicking one opens that tag's Trending gallery.
- **Navigation**: only Read and its reader/page routes show the reading sidebar; Discover, Trending, Gallery, Liked and Trash keep their full-width layouts. Pages/categories are fetched on first entering Read, not during unrelated page startup. On mobile and tablets up to 1024px, navigation starts collapsed below the header and expands into touch-friendly page/category chips. Read has labeled search/sort controls, two-column tablet cards and single-column phone cards; category filters persist through paging and can be cleared. FTHX and Whitepaper are available under Read and Pages rather than overcrowding the top tabs. Trash uses an icon-only bin button with an accessible label and a 44px touch target in the header and reading sidebar. `GET /api/public/reading-navigation` returns site-scoped published pages and category counts with `Cache-Control: no-store`; draft, private and trashed readings are excluded.
- **Read**: a separate menu that lists every published post with text. You can search it, filter by reading category and sort it by length (longest by default) or date, and open any post in a clean reader view. Category selection is preserved through search, sorting and pagination.
- **Reading votes**: the reader provides explicit Like/Dislike buttons using the separate `read` deck and its authoritative round. A first-round dislike moves the reading to Trash; later-round dislikes only affect counts. Repeating an active vote undoes it, and like/undo can restore a deletion owned by the current reading round. Reading likes never enter the media timeline or inflate media vote counts. Published CMS readings use negative IDs; their text and publication status remain intact while curation trash hides them from normal navigation. Trash links explicitly request `GET /api/public/texts/:id?trash=1` so the public reading can be opened and restored without exposing private or draft content.
- **Liked tabs**: All media, Readings and each signed-wallet-private folder appear as keyboard-accessible tabs. Media retains the original-size timeline. Liked readings use a two-column card grid, collapsing to one column on phones, with titles, snippets, reading time and vote counts. Readings uses `GET /api/public/liked?kind=read`, has its own recent/popular ordering, and retains 24-item infinite scrolling and manual retry. Custom folders remain media-only and wallet-private; the built-in Readings tab contains shared reading likes.
- **Trending**: a gap-free gallery of all photos (thumbnails included) and GIFs from the posts of the trending tags. GIFs are scattered: one after every 5 photos. It is sorted by likes + comments by default; it can also be sorted by most liked, most commented or newest. Tag heat is the sum over the tag's posts of likes + 2 × comments. More recent activity counts for more (up to 3×, fading over about a week), and the sum is divided by √(posts) so big tags don't always win. When fewer than 12 tags have activity, the most used tags fill the list. Click a tag chip to see only that tag. **＋ More tags** keeps loading the rest of the tags, 40 at a time (most active first, then by size). The search box searches every post's title and text (all words must match) plus tag names; matching tags show as chips. The viewer lists each post's tags, and clicking one opens that tag's gallery. 👍 likes the post (in its deck's current round), with infinite scroll. Tags come from **Keyword tags** below.
- **Branding & posting**: the media site is **x.featheral.com**. Its logo (`public/site/logo.svg`, also the favicon) is a black shiny feather with a red 18 above it. Posting is the round pink **＋** button floating at the bottom right of every page (hidden on the post page itself). A post can be a YouTube video, an image, a GIF or a link. For a YouTube link (`youtube.com/watch`, `youtu.be`, `/shorts/`, `/embed/`, `/live/`), the video's title and cover image (the largest of maxres/sd/hq) are fetched, and the post always goes to the Swipe deck. The video id is kept in `member_posts.video` and the post meta `_wpx_youtube`. The cover then shows like any image, with a ▶ button on swipe cards and a ▶ badge on gallery tiles; pressing play (or opening it in the viewer) plays it in a `youtube-nocookie.com` embed. The same video can't be posted twice. Posting still needs a connected wallet and 1 FTHX.
- **Liked**: a shared site-wide timeline ordered by the latest surviving like, newest first (post ID breaks timestamp ties). Choose **Most liked** for popularity order instead. Recent likes can be grouped by local day or month; grouping is disabled in popularity order. One uncropped post per row retains its original proportions and pixel size, scaled down only to fit the available screen width and height; small images are never enlarged. Captions sit below media. Infinite scrolling automatically fetches the next 24 items within 600px of the end, including in folder views; **Load more** remains available for manual loading and retry. Concurrent page requests are deduplicated, background paging pauses while the viewer is open, and leaving the route disconnects paging and aborts requests. Previews retain the viewport and media budgets above. Opening a card uses the shared full-media/comments viewer. Arrow buttons, keyboard arrows and horizontal touch/pen swipes navigate without voting or deleting; moving past the last loaded card requests the next page. Vertical scrolling remains available for media and comments.
- **Trash**: a public, site-scoped timeline of published media and readings that are either in curation trash or have strictly more dislikes than likes. Reading dislike counts are assessed separately from media counts. Trashed entries come first, newest deletion first, followed by net-disliked entries in descending dislike count. It uses 24-item infinite paging, reading cards and the same original-proportion media layout/viewer as Liked. No permanent-delete action is exposed publicly. Admin purge can permanently remove trashed CMS readings, but protects the active content homepage. Moved media are served only after checking that the post is published and belongs to the selected site; private/draft posts remain hidden. `GET /api/public/trash` supports `offset` and `limit`; `GET /api/public/posts/:id/media` serves that post's selected media, including files moved to trash.
- **Viewer voting**: explicit Like/Dislike buttons appear beside comments in Discover, Trending, Gallery, Liked and Trash. The viewer reads the authoritative current deck/round/vote from `GET /api/public/posts/:id/curation`; repeated active votes undo that round's vote. A round-1 dislike moves media to Trash; later dislikes only affect counts. A like or undo can restore a deletion owned by the same deck and current round; other deletions require Admin restoration. Navigation never votes. Pending votes block duplicate clicks/navigation, stale rounds return 409, and changed lists refresh when the viewer closes. Trashed posts retain readable approved comments but cannot receive new comments until restored.
- **Private folders**: sign in with an Ethereum wallet to create, rename or delete up to 100 folders, and use **Folders** on a card or in the viewer to save/remove it. Folder names are 1–80 characters and unique per wallet, case-insensitively. Folders sync across devices using verified wallet sessions, are isolated per site and wallet, and persist in `public.sqlite`. Saving, removing or deleting folders never changes shared likes, rounds, media or monetary data. Folder counts include saved memberships; their filtered timeline shows only media that is still public, kept and liked. Changing wallets clears the old private view. `GET /api/public/liked` defaults to `sort=recent&limit=24`, supports `sort=likes`, `offset` and an authenticated `collection` filter. Private folder APIs are `GET/POST /api/public/collections`, `PUT/DELETE /api/public/collections/:id` and `PUT/DELETE /api/public/collections/:id/posts/:post`; reads use `Cache-Control: no-store`.
- **Comments & wallet sign-in**: opening a thumbnail shows the image at its original pixel size (only scaled down if it doesn't fit, and the caption says so), with the post's comments beside it. Approved comments synced from WordPress are shown read-only; new comments need an Ethereum wallet. **Connect wallet** (header, or in the comment panel) asks MetaMask or any injected browser wallet to sign a one-time sign-in message. This is not a transaction and costs no gas. The server checks the signature locally (`lib/wallet.js`, EIP-191 `personal_sign`); each request expires after 10 minutes and works once. Comments are posted under the wallet address, kept in `public.sqlite` (the synced WordPress database is not changed), up to 2,000 characters, and can be deleted only by the wallet that wrote them. Every thumbnail shows a small 💬 comment count in its top-left corner (dimmed at 0). Every swipe card has a 💬 button with the comment count on its right edge. Click it or press **C** to open the same viewer and comment panel; swipe keys are paused and GIFs are frozen while it's open, and the card's count updates as you post or delete. Switching accounts in the wallet signs you out.
- **Views**: every post has a 👁 view count that goes up automatically as people look at it. A view counts when a swipe card reaches the top of the deck, when a post is opened in the viewer (Thumbs, Trending, Liked; each ← → step counts the post it lands on) or when a text is opened on the Read page. Each browser gets a random visitor id (in `localStorage`); the same visitor viewing the same post again within 30 minutes is not counted again (`VIEW_WINDOW_MS` in `lib/public.js`). Counts are kept in the `views` table in `public.sqlite` and shown on swipe cards, gallery tiles (👁 views · 💬 comments), the viewer bar, Liked tiles and the Read list and page. API: `POST /api/public/posts/:id/view` with `{ visitor }` returns `{ id, views, counted }`.
- **Visitor analytics** (Admin › 👥 Visitor analytics): the public site reports each page it shows (`POST /api/public/hit`). The admin page shows:
  - all-time and per-period visitors (new vs returning), live visitors (last 5 min), visits, page views, pages per visit, bounce rate and average visit length;
  - a daily traffic chart (hourly for the last 24 h);
  - traffic sources (direct, search, social, referral, campaign, paid, email), top referring sites and pages;
  - search-engine keywords: Bing, Yahoo, DuckDuckGo, Yandex and others pass the search terms, but Google usually hides them;
  - on-site searches from Trending and Read, including searches with no results;
  - UTM campaigns: tag shared links with `?utm_source=…&utm_campaign=…` or `?ref=…`;
  - pages and landing pages, most viewed posts, devices, browsers, systems and languages, and recent visits.

  Choose a period (24 h to all time); bots and crawlers are hidden unless you tick *bots*. A visit ends after 30 minutes without activity. No cookies, IP addresses or personal data are stored, only the random visitor id from `localStorage` and the browser's user agent. Data is kept in the `an_*` tables of `public.sqlite` (`lib/analytics.js`). Report API: `GET /api/sets/:key/analytics?days=7&bots=1`.
- **Posting (➕ Post)**: connected wallets can add posts. Image sources: drag & drop (files, images dragged from other pages, links), **Ctrl+V** paste (images, image links, `data:` images), 📁 upload, 📷 camera (live preview with Snap, or the phone camera picker), 🖥 screenshot of a screen, window or tab, 📋 clipboard button, a video file (scrub and pick a frame), or a link. A link can point at an image, or at a page whose preview image is used (`og:image`/`twitter:image`, Reddit posts and galleries, Imgur `.gifv`). The server fetches links (`lib/linkfetch.js`, 15 s / 20 MB limits) and refuses private, loopback and link-local addresses, re-checking every redirect. The browser compresses before uploading:
  - animated GIFs are kept as they are, up to 15 MB;
  - everything else (PNG, WebP, AVIF, SVG, photos, frames) is redrawn as a JPEG with the longest side ≤ 2048 px and ≤ about 1.5 MB, which also strips EXIF/GPS.

  The preview shows the result and where it will go: stills under 640 px go to **Thumbs**; everything else goes to the swipe deck, where member posts are shown first, newest first. The server (`lib/members.js`) accepts only JPEG/GIF, rejects exact duplicates, and writes a normal WordPress post plus attachment into `db.sqlite`, `uploads/` and `uploads-index.json`; the poster's wallet is stored in postmeta (`_wpx_member_wallet`) and in `public.sqlite`. A resync from the live site can overwrite `db.sqlite`, so member posts would need re-adding afterwards.
- **FTHX**: the system-native Featheral Exchange Token, recorded in the global Notes ledger on managed sites; it is not an Ethereum or private token. Legacy per-site `qprn_ledger` tables remain intact for the migration audit. New uploads use an `fthx-` prefix; existing media paths are unchanged.
  - **Top-ups**: click the wallet button in the header to see your balance and activity. **Add FTHX** (+10/+50/+100 or any whole amount up to 1,000) asks the wallet to sign a one-time top-up message (no transaction, no gas); the request expires after 10 minutes.
  - **Posting** costs 1 FTHX.
  - **Reaction rewards**: likes and comments never earn native FTH$ or FTHX. A configured community-note program can reward the creator once per wallet/post pair; standalone legacy sites do not pay automatic FTHX like rewards.
  - **Tips**: the viewer of a member post shows the poster, what the post has earned, and tip buttons (1 / 5 / 25 FTHX). Swipe cards show the poster and 🪙 earned; click it to open the viewer.

### Curation rounds

Swiping is a curation tool, so the stored site ends up with only well-liked posts:

- The mixed deck is reviewed in rounds. A round ends when every remaining post has a vote. Each like is an up-vote and each dislike a down-vote. Then **Start round N+1** reviews the kept posts again in a new shuffle. Only round 1 deletes: from round 2 on, likes and dislikes are both kept as votes and nothing is removed. Votes and rounds are still recorded per media type (GIF, JPG, PNG) underneath, so earlier per-type progress carries over; the progress label shows the round of the card on top.
- A dislike moves the post to the trash right away. The post is hidden everywhere, including the admin, and its files move from `data/<key>/uploads/` to `data/<key>/trash/`. A file that is also used by a post you're keeping stays where it is. Undo puts the post and its files back.
- **Admin › Trash** lists the trashed posts. **Restore** brings a post back. **Delete permanently** removes the posts, their attachments, revisions, comments and meta from `db.sqlite`, deletes their files and empties the trash folder. This step can't be undone. The database file doesn't shrink, because it isn't vacuumed.
- **Remove duplicates…** on the Trash page finds published posts whose media is the same, either the same file or a byte-identical copy (files with equal sizes are compared by SHA-1). It keeps the first published post of each group (oldest date, then lowest ID) and moves the others to the trash, where they are listed as "Duplicate of #ID" and can be restored. The scan can be run again at any time.
- **Thumbnails**: `node tools/thumbnails.js [siteKey] [--dry-run] [--max-side=640]` moves every published post whose image is small (longest side under 640 px; GIFs are never moved) into a WordPress category named **Thumbnails**. The post's other categories are removed and its tags are kept. These posts are left out of the swipe deck and shown instead in the public **Thumbs** tab: a gap-free gallery of justified rows: every row fills the page width exactly and no image is ever enlarged: each one shows at its original size or smaller. Each row is completed with nearby images of similar height, so most only shrink a little. To fill the rows, images can move a few places from strict sort order, with infinite scroll, sortable by newest, oldest, largest or smallest, plus a full-screen viewer (← → to step, Esc to close). Each thumbnail has a 👍 showing its like count (all rounds) and a 👎. In round 1 👎 deletes the post right away and the tile leaves the gallery (Undo in the pop-up). Scrolling to the end of the gallery starts the next round automatically; from round 2 👍 and 👎 are only counted. Click an active vote again to clear it. Liked thumbnails appear on the Liked page. Stop the server before running it. Running it again only moves posts that are not in the category yet.
- **PNG → JPG**: `node tools/png-to-jpg.js [siteKey] [--dry-run] [--quality=90]` converts every PNG in `uploads/` to JPG, flattening any transparency onto white. It updates the attachment records (file, MIME type, metadata, guid), the uploads index and the curation votes, which move from the PNG deck to the JPG deck. Stop the server before running it. PNGs of trashed posts are not converted; if one is restored, run the tool again.
- **Keyword tags**: `node tools/autotag.js [siteKey] [--dry-run] [--sample=10]` gives every published post WordPress tags (`post_tag`), so similar posts can be grouped: open a tag under **Categories & tags** or click a `#tag` chip on a post to list every post with it. Tags come from:
  - the `[bracket]` and `(paren)` labels in the title, such as kinks, fandoms and artists (age/gender codes like `[M25/F23]`, `[OC]` and `[4K]` are skipped);
  - JAV code series (`[ABP-102]` → `ABP series`);
  - names when the whole title is a name (`Sydney Sweeney`);
  - TF-IDF keywords and two-word phrases from the title and text. Title words count more. Stopwords, reddit boilerplate, story filler (character names, -ed/-ly words) and   words found in almost every post of a subreddit are skipped. Only meaningful keywords are kept: proper nouns (a word or phrase that is capitalised mid-sentence in at least 60% of its uses, e.g. `margot robbie`, `genshin impact`) or words from a curated topic list (`TOPIC` in `lib/autotag.js`: body, look, ethnicity, act, outfit, place, role, genre, holiday). Generic words (`story`, `sunset`), weekdays, months and title words like `master`/`queen` (`NOT_TOPIC`) are dropped.
  There are no subreddit (`r/…`) tags. The number of keywords grows with the length: about 3 for a photo title, up to 30 for a long story. Only tags on at least 10 posts are kept (`MIN_POSTS` in `lib/autotag.js`), so some posts get no tags. Posts in the local trash get no tags.

  Auto tags are marked `auto-tag`. Running the tool again replaces them and keeps hand-made tags. Stop the server before running it. New member posts are tagged on upload with the existing tags their title or description mentions. A full resync replaces the database and drops the tags, so run the tool again afterwards.
- Votes, rounds and the trash list are stored in `data/<key>/public.sqlite`. Likes and dislikes saved in the browser by older versions are imported once, the first time the site is opened.

Media is cached by the browser for 7 days, so a trashed image can still appear from the cache until then. In Settings' `ADMIN_CONFIG_JSON`, `publicBrand` sets the public site name (it defaults to the stored site title), `publicTagline` sets the line under it (it defaults to the stored site description; also used for the page description and the age gate), and `ageGate` (default `true`) shows an 18+ confirmation before any content.

The server listens on `127.0.0.1` by default. Setting `HOST` to `0.0.0.0` in Settings exposes it to other machines after restart. Configure Admin access first, terminate HTTPS at Nginx, and restrict network access appropriately.

## Original sync features

The app can connect to a **WordPress site through its REST API**, bulk-download the **original media files**, and organize the content into an explorer you can browse, search and export.

## Requirements

- Node.js **22.5+** (built-in SQLite managed through database; tested on Node 24)

## Run

```bash
npm install
npm start            # http://127.0.0.1:5178
```

1. Enter the site URL, for example `https://example.com`. The REST endpoint is discovered automatically: it tries the `Link` header, then `/wp-json/`, then `?rest_route=/`.
2. Optionally add a **username and Application Password** (WP Admin → Users → Profile → Application Passwords). Without credentials you get public content only. With them, the app also syncs drafts and private posts, raw (unrendered) content, every comment status, user details, menus, plugins and themes. The password is sent only to the site's own origin and is never saved.
3. Choose the media mode:
   - **Originals only**: one file per media item. WordPress's pre-scaling `original_image` is used when it exists.
   - **Originals + all sizes**: also downloads every generated size.
   - **Metadata only**: downloads no files. Images are proxied from the live site.
4. Use **Max items per type** for a quick sample sync (`0` = everything). Limited syncs take the newest items and also fetch the featured images of the synced content.
5. Click **Test connection** to preview counts, then **Sync & download**. The progress view shows each step and can be stopped. A stopped or interrupted sync saves completed API pages; re-syncing resumes from those pages and skips files that are already downloaded.

| View | What you get |
|---|---|
| Overview | Site info, sync details, media download stats, content-type and status matrix |
| Content | Filterable and searchable posts, pages and custom post types; detail view with preview, plain text, Markdown, HTML, custom fields, media, comments and revisions |
| Media library | Photo grid from the media library or the downloaded files, with a lightbox, sizes, EXIF data and "used in"/"featured in" links |
| Categories & tags, Menus, Comments, Users | Organized views of the taxonomies, nav menus, comments and users |
| Insights | Publishing timeline, length histogram, top words and terms, authors, media stats |
| Export | All post text (TXT or individual TXT files in a ZIP), AI/NLP corpus (JSONL), Markdown zip, posts CSV/JSON, original photos zip, media catalogue, taxonomies, menus, comments, users, stats |
| Plugins & themes, Database tables | Plugins and themes (with authentication), plus raw SQL tables including `rest_objects` with the untouched REST JSON |

On the **Export** page, use **All text** or **All text ZIP** to download full titles, excerpts and body text for every locally synced post, page and non-internal custom type, including all statuses. Media, revisions and other internal types are excluded. **Filtered text** and **Filtered ZIP** follow the type/status selectors. These exports contain UTF-8 plain text without HTML and are not limited to the current browsing page. Only synced content can be exported; use an unlimited sync (`Max items per type = 0`) to collect everything accessible on the site.

On the **Content** page, sort posts by plain-text character count, word count, photo file size/resolution, or video file size/resolution, in either direction. Text counts exclude HTML markup. Media metrics use the largest associated photo or video per post (featured, embedded uploads or WordPress media IDs, and attached media), using synced metadata or the local file index. Resolution is measured in pixels (width times height). Posts without known media sizes/resolutions appear last in either direction; remote media without synced metadata cannot be measured. Sorting applies to all matching posts before pagination and does not modify posts or files.

Use **Browse groups** on the Content page to see counted lists of short (1-299 words), medium (300-999), long (1,000+) and empty posts, or small/medium/large photos and videos by file size or resolution. Each group's exact thresholds are displayed; MiB means 1,048,576 bytes and MP means 1,000,000 pixels. Media with unknown measurements has a separate group. Group counts follow search, type, status and date filters, and selecting a group filters all matching posts before pagination. The Content page's CSV link includes the selected group.

Use **Image type** on the Content page to show only posts whose featured image, attached images or images used in the content are a given format (JPEG, PNG, GIF, WebP…); counts are shown per type and the CSV link honors the filter. The Media library (DB) view has a matching **Image type** filter for attachments.

## Data layout

```
data/<site-key>/
  manifest.json    # sync settings, counts, download stats, warnings (no password)
  db.sqlite        # WordPress-shaped tables (wp_posts, wp_postmeta, wp_terms, ...) + rest_objects
  uploads/         # original media, mirroring wp-content/uploads (YYYY/MM/file.jpg)
```

Any media file that is not stored locally (for example a generated size in Originals mode) is served by redirecting to the live site.

The server only listens on `127.0.0.1`.
# Frontend source locations

The backend and private data remain in this service directory. Editor assets live in `../../sites/admin.featheral.com/`; the shared public-page shell lives in `../../sites/x.featheral.com/`; shop/exchange demo assets live in `../../sites/ex.featheral.com/`. Both the standalone service and root gateway use those locations. Existing `/site/` asset URLs, host-based routing, CMS authentication and public previews are unchanged.
# Central wallet integration

Every site uses one central wallet renderer in the same compact 380px top-right
panel, inheriting its host's theme. Foundation/Gold use FTHG as the primary currency,
Dollar/World use FTH$, and Notes/Exchange/X/Sites/Stats and other hosts use FTHX.
The large balance is the active account's actual available primary currency.
Smaller lines directly below show the estimated portfolio USD total followed by
the estimated portfolio total in that primary currency, outside collapsed details.
The FTHG total is also visible on Dollar and other non-Gold wallets; Gold uses
its primary estimated-total line without repeating it. Held FTHX and funded,
priced community notes contribute to both Gold and USD estimates. Market-list
discovery failures are reported without suppressing available account balances
or authoritative portfolio estimates. Missing price sources remain unavailable.
Combined linked, World and Exchange estimates never replace the spendable balance;
unpriced assets and unavailable valuations remain explicit.
Shared controls use compact sizing: 28px Sites/dialog controls, 30px wallet icon
actions, 32px header wallet controls and 42px wallet tabs. Tooltips, accessible
labels, visible keyboard focus and the narrow-screen tab layout are retained.
Public-address embeds use read-only summaries; tokens, providers and signing authority
are not passed to parents. Portfolio results include exact 18-decimal equivalents
and partial flags in all three primary units, and recent activity appears on the
Assets screen. Native wallet amounts remain distinct from all-network estimates.
Profile editing is restricted to World's inline setup screen, never wallet panels.
The former X top-up panel is removed; obtaining FTHX uses real funded swaps/transfers.

Foundation and Gold keep their themed header controls; normal wallet clicks use
the central renderer rather than a separately selected provider portfolio. Shared profile assets
redirect to the wallet host and balances come from its cookie-free, read-only
`GET /api/wallet/accounts/:ethereumAddress` summary. The gateway allowlists reader
origins and rejects writes. The summary returns public holdings and combined
estimates only, excluding creation requests and site-owner metadata. Profile edits
retain their signed Dollar API contract; Ethereum/GAME/notes ownership is unchanged.

Public header controls no longer restore a second per-site extension account.
Legacy profile controls delegate to the inline wallet (with a retry message
while its embed loads); native admin/Ethereum approval controls explicitly opt into
`ethereumProvider` signing. Normal headers always follow the central active account,
never a site's cached commenting/trading owner. Connection, built-in creation,
restore, unlock, sending and Swap run inside the same site panel. Closing and
reopening it preserves the renderer, active session and unlocked signer (subject
to the existing inactivity lock); changing tabs does not reload the wallet.
Only a small **Powered by Wallet** link appears at the panel's end.
The host persists only the selected public address for reloads. The wallet-host
iframe keeps its own session and encrypted vault; built-in signing sessions remain
memory-only. Existing extension permissions restore balances through `eth_accounts`
without a permission popup. Explicit connection or transfer actions can authorize
the wallet session in-panel. Where extensions are not injected into an iframe, an
exact-origin/source checked bridge allows only account requests and `personal_sign`,
verifying the active extension account. No private keys or wallet tokens cross it.
Pinned address views remain read-only. Transfers and linking use explicit in-panel
review dialogs, not blocked cross-origin browser confirmation dialogs.

`FeatheralWallet.authenticate(challenge)` is the shared site sign-in transport used
by Notes/Sites creation, Exchange and X/community comments. Its inline wallet panel
selects the account and extension/built-in method, verifies the requesting network
origin, renderer window and nonce, accepts only fresh standard sign-in messages, and requires
explicit approval. The callback obtains a site-specific challenge for that public
address. Only `{address, signature}` returns; each site then exchanges the signature
for its own session. The central active address is updated after approval. No
password, private key or central token leaves the wallet. Financial transfer/admin
messages cannot be signed through this channel.
Approved public selections restore normal panels even when iframe storage is isolated.
Browsers that partition an existing built-in vault can grant storage access through
**Use existing device wallet** inside Account. If access is blocked, the panel
explains how to allow storage or restore an encrypted backup in place; it never
redirects to the wallet site or bypasses browser isolation with keys or tokens.
The legacy Exchange popup authorization endpoint remains compatible for old clients.

The gateway serves `wallet.featheral.com` and the schema-versioned `/api/wallet/ui`
configuration. `/api/creation/*` is available on that host with central-origin sessions.
`setWalletSources` supplies verified Gold-owned mainnet FTHG and native ETH balances
on Ethereum (1), Base (8453), Arbitrum One (42161), Optimism (10), zkSync Era (324)
and Linea (59144), plus read-only linked World funds. Native balances use a verified
chain ID and pinned block, a 30-second bounded cache and per-chain
`WALLET_RPC_<chainId>` overrides. Only native ETH is tracked on L2, not arbitrary
ERC20 tokens. A fresh ETH/USD feed values native ETH independently of the Gold bridge.
Portfolio valuation deduplicates legacy World/native wallet accounts.
Source failures remain visible and estimates are partial when any asset is unpriced.
Portfolio responses include `dollarReference`: an indicative opening rate of
100 FTHX per FTH$ only for a verified empty version-zero pool, then the live
reserve ratio after funding. Exchange market responses expose the same value as
`referencePrice`, separate from executable `notes[].price`. This valuation does
not fund pools, enable swaps or peg FTH$ to USD. Reserve errors and pending
settlements suppress the reference rather than reverting to the opening rate.
Portfolio `goldReference` similarly exposes `numerator`, `denominator`,
`currency: "FTH$"`, `decimals: 18`, `source` (`opening` or `bridge`) and `indicative`.
Its ratio is the 18-decimal FTH$ amount per one FTHG. The indicative opening ratio
is 1 FTHG = 10,000 FTH$ only when a fresh mainnet snapshot verifies the exact
FTHG token, a configured/deployed, unpaused, never-initialized bridge and explicit
zero reserves, custody, stake and spot rate. Funded snapshots use verified live
bridge reserve ratios instead. Missing, stale, paused, erroneous, previously
initialized empty or custody-inconsistent states return no reference, never an
opening fallback. Internal and World USD estimates always require a separate
fresh positive FTHG/USD estimate (Uniswap or the labeled $0.01 temporary
reference); no USD price is implied by opening reserve ratios.
A current `{ configured: false, deployed: false, initialized: false }` bridge
response is not historical proof that no bridge was previously funded: it is
returned immediately when no bridge address is configured, without an on-chain
initialization read. It therefore supplies no Gold opening reference. A configured
address with no current contract code likewise does not prove never-funded history.
Legacy Dollar explorer/landing helpers and the Ethereum balance panel read the
same public wallet-host `GET /api/creation/economy/reference` snapshot. USD
estimates expire with the verified reference/market timestamps and become
unavailable after fetch failures; they never use a fixed $0.01 FTHG value or
the legacy finite-reserve obligation ratio as a USD feed. Ethereum totals sum
integer USD base units before formatting. Existing bridge execution and fixed
finite-reserve obligations are unchanged.
The central UI and compatibility popups show the FTHX estimate alongside USD.
Six ARIA tabs (Assets, Send, Receive, Swap, Activity, Account) share one selected
panel and one keyboard stop; Left/Right wrap and Home/End jump. Compact icon actions
use accessible labels and hover/focus tooltips. Account holds the built-in-wallet
and World controls, while network explanations are expandable.
The first card shows one available balance, compact USD/primary estimates and a
top-right 30px connection icon. Its tooltip/ARIA label describes the action; the
dot distinguishes disconnected, selected and authorized states. Pinned read-only
views show a disabled labeled icon. The Estimates disclosure is removed.
A read-only address input and inline icon copy button sit below the two totals;
the button copies the full address and is disabled without an account. Pricing
provenance and unpriced assets remain available in the total tooltips.
Receive keeps the Mainnet/native-note safety warning visible. Swap stays inline; advanced Exchange tools remain separate.
Wallet configuration derives its accent from `shared/site-colors.json`, using the
parent site or a validated `theme` site name, not just the primary token.
The embed sends `featheral:wallet-theme` on readiness and host theme changes.
The renderer accepts only bounded color values and light/dark scheme from the exact
configured parent origin and window; no arbitrary CSS, assets or credentials are passed.
The iframe loads eagerly behind a host-colored loading surface and becomes visible
only after acknowledging that its host palette has been applied. Initialization
errors or a 20-second startup timeout show Retry and a full-wallet link instead of
a blank panel. Retrying replaces only the renderer and cancels any pending sign-in.
The full-wallet link retains the currency, view and site context without credentials.
User-initiated external wallet tools open outside the iframe sandbox; arbitrary
top-level navigation remains disallowed.
Embedded extension requests always use the validated parent bridge, even when an
extension injects a different or non-writable provider inside the frame. Only
account access and `personal_sign` are bridged; account/provider changes invalidate
signatures. The site's selected profile provider takes precedence over a generic
injected provider. EIP-6963-only wallets and legacy multi-provider extensions are
supported; when multiple providers are available, the panel offers a browser-wallet
selector rather than silently choosing one. Built-in wallets remain inside the
central renderer, and pinned public-address embeds receive no signing authority.
Normal `FeatheralWallet.open` panels set `followActive=1`: the central-origin
`featheral-wallet-active-account` public address takes priority over a site's login
address. Explicit `mount({address})` views remain pinned by default. Embedded views
read built-in public identity and verify linked-account proofs without unlocking
or creating a signer. Portfolio composition is identical to the full wallet.
Storage events propagate account selection, World sync and successful central
operations; no credentials or private keys are posted to parent sites.
Public-wallet synchronization is automatic; there is no manual sync button or
popup, and the old `/context/` handoff is no longer served. Embeds read only central
public storage, never the sign-in token or a parent-provided account context.
Storage events, focus/visibility changes and 30-second reads refresh holdings.
Browsers that isolate or block iframe storage (including some `*.localhost`
configurations) require opening the full central wallet; credentials and keys
are never shared to bypass that restriction.
Native FTH$ operations use `/api/v1/notes/*` with existing Dollar compatibility
aliases. Ethereum reads, including all six native ETH balances, belong to Gold's
API and are supplied to Note summaries by Gold, not separate RPC clients.
Public `/wallet/` routes contain only the central embed shell. Ethereum conversion
and staking remain available at the central host's `/ethereum/` route.

The top-level central wallet supports local self-custody without an injected provider.
`vault.js` uses the existing ethers bundle for random keys and password-encrypted
keystores. A downloaded and confirmed recovery backup is required before creation
persists anything. Only encrypted keystores and verified public link proofs persist;
plaintext keys/passwords and built-in signing sessions never enter local storage or
iframes. Lock clears the signer and logs out its session; ten minutes of inactivity
also locks. Recovery requires both the backup and password.
External linking requires both signatures and combines read-only portfolio estimates,
deduplicating owner addresses and shared World account IDs. Spending always uses the
explicitly selected owner; linking does not merge accounts or authorize transfers.
