# Featheral Admin (CMS & operations)

The unified administration frontend is `sites/admin.featheral.com/`, served at **admin.featheral.com** (`admin.localhost:8080` locally). Foundation overview/access, Gold reserve/token safety, Dollar liquidity/rewards/ledger and World moderation are native views, not iframe consoles. Templates live in `views/`, scoped controllers in `js/operations/`; one signing-wallet control persists across navigation. Tab deep links use `#/operations/<service>?tab=<tab>` and preserve drafts while switching tabs. Leaving a view disposes its wallet listeners and blocks stale signatures/submissions. Product `/admin/` routes, legacy `/operations/<service>/` URLs and the retired CMS hostname redirect to the matching native entry. Old console scripts and their standalone styling were removed; ethers is served locally.

The Sites overview includes all fourteen core hosts, including Database, App, Silver and the central Wallet,
plus additional hostname-named applications and registered CMS/hosted sites.
Each site has API-provided management links to its actual service workspace.
Apps without editable templates show application, relevant native-feature and
reviewed Deployment links instead of an empty CMS editor. Managed CMS roots replace their
built-in catalog entries without hiding separate hosted paths. Native applications
are also included in traffic reporting and deployment hostname review.

The workspace and privileged APIs are protected by the existing `CMS_PASSWORD`; frontend assets contain no authority. The main gateway dispatches authenticated API requests to the original Gold, Dollar and World services; signing, moderator/on-chain roles and wallet confirmations still apply. Writes must come from the admin origin. The standalone CMS service explicitly reports that operational APIs require the main `npm start` server. Backend modules, environment names and private datasets remain under `services/cms/`; an existing old CMS-host page database is reused to preserve its content/themes.

CMS and Notes use Node's built-in SQLite with connections created and managed
through `services/db-api/sqlite.js`. Standalone modules and tools import its
`open(file, options)` directly; no external database driver is required.
Standalone CMS shutdown calls `database.sqlite.closeAll()` after service cleanup.

Admin's **Server profile** (`#/server-profile`) consolidates protected server
resource metrics, a one-minute unified chart, risk indicators, cached database /
ledger / upload / source inventory, Linux account browsing and root-password
vault actions. `GET /api/server-profile` requires the Admin host, HTTPS (except
loopback `admin.localhost`), configured `CMS_PASSWORD` and Admin authentication.
Storage is scanned at startup and every five minutes; an authenticated same-origin
`POST /api/server-profile/refresh` requests an early scan. The source inventory
skips `.git`, `node_modules`, `artifacts`, `cache`, `coverage`, `dist` and `out`;
those names are still counted inside data, upload and trash trees. Symlinks are
not followed. Set `SERVER_PROFILE_NETWORK_LIMIT_BPS` to a positive bytes-per-
second capacity to enable network utilization risk thresholds. Without that
setting, only observed HTTP traffic is reported because interface capacity is
not available from Node's portable OS APIs.

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

`services/notes-api/workspace.js` stores membership, channels, messages, reads,
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
`APP_VAPID_PRIVATE_KEY`, and `APP_VAPID_SUBJECT` (see `.env.example` for key generation).
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

**Deploy all sites** uses a digest-bound, expiring review plan followed by SFTP upload and pinned-host-key SSH execution. It is disabled by default and must be enabled in the private server environment, not a CMS form. See the root [deployment instructions](../../README.md#unified-administration-cms-editing-and-reviewed-deployment) and [environment example](../../.env.example). Initial private data must be restored from a consistent offline backup on the target; it is never copied from the active writer or added to Git. No deployment occurs merely by reviewing a plan.

This application and its complete local data were moved into the Featheral foundation at `services/cms/`; the old source root is empty. Run `npm start` from the foundation root to serve CMS, X, Exchange and all registered CMS sites through the same gateway as Foundation, Gold, Dollar and World. Root `npm install` includes this CMS workspace. Run `npm run test:cms` from the foundation root for the migrated suite.

Local gateway URLs are `http://admin.localhost:8080/`, `http://x.localhost:8080/` and `http://ex.localhost:8080/`. Existing sample Featheral hosts and new Featheral subdomains also support `.localhost` aliases. CMS preview links on `admin.localhost` keep their local origin. Set `CMS_PASSWORD` before exposing the production CMS; password-free access on `admin.localhost` is restricted to loopback. Imported data and uploads remain in this application's ignored `data/` directory, not in the foundation's ledger data directory.

For standalone operation, run `npm run start:cms` at the foundation root (default port 5178). Do not run standalone and gateway processes against the same data concurrently. The exchange remains a local demo and its FTH$ is not the foundation's Dollar currency.

Featheral CMS manages local content alongside the stored WordPress data set in `data/qporn-eurasiahosting-com`. CMS edits are kept separately so the imported WordPress snapshot remains unchanged.

## Local mode (default)

`admin.config.json` controls site names and local mode:

```json
{ "brand": "admin.featheral.com", "siteKey": "qporn-eurasiahosting-com", "allowSync": false, "siteManagement": true, "publicBrand": "x.featheral.com", "cmsHost": "admin.featheral.com", "publicHost": "x.featheral.com", "publicTagline": "Featheral X Media Archiving and Streaming Platform. Share media, support free expression, and earn FTHX.", "ageGate": true }
```

- `brand`: the CMS name shown in the sidebar, page title and overview.
- `siteKey`: the default stored data set for the public site on localhost. With site management disabled, every other set is hidden.
- `siteManagement: true`: enables the **Sites** dashboard and sidebar site selector independently of WordPress syncing. New public websites are created only on `sites.featheral.com`.
- `allowSync: false`: WordPress connect, sync, cancel and data-set deletion remain disabled. Missing media returns 404 rather than being fetched from the live site.

## Site management

### Linux server accounts

`#/server-users` is the Admin-only account browser for the SSH server configured
by `DEPLOY_TARGET`. It uses `getent passwd` to include system accounts and other
NSS-provided users, with search and 50-row pagination. Only username, UID, GID,
home and shell are returned; password fields and personal GECOS fields are not
exposed. UID 0 is marked as root privileges. This is separate from application
profiles and App membership; account creation/deletion and permission editing
are not enabled.

All `/api/server-users` routes require a nonempty `CMS_PASSWORD` and an
authenticated Admin login, even on localhost. Production requires HTTPS;
loopback `admin.localhost` may use HTTP for development. SSH credentials and
the independently verified host-key fingerprint use the deployment environment;
account browsing does not require `DEPLOY_ENABLED=true` or a TLS-registration
email. No remote user data is cached in browser storage.

Changing the Linux root password also requires the current root password,
an FTHG origin-wallet signature, `CHANGE ROOT PASSWORD`, and a new password with at least 16 characters, at most
256 UTF-8 bytes, and no colons or control characters. Keep an independent
recovery session open. Connect the canonical FTHG origin wallet
(`0xD2f1Be8414472E9f436B65e91A2B8dFDa418287c`) with the header signing control.
Admin issues a five-minute, single-use `personal_sign` challenge binding the
password-change action, Admin origin/session, exact password pair and pinned SSH
destination. Password binding uses a private, per-process HMAC, not a public
password hash; challenges expose neither passwords nor their hashes. Modified,
expired, wrong-wallet and replayed approvals are rejected before SSH.
Leaving the view or changing wallets while signing prevents submission.
The wallet private key is never requested or repurposed as a root password.
Restarting Admin invalidates pending challenges.

After signature verification, the backend freshly authenticates as root, confirms
UID 0, runs the fixed `/usr/sbin/chpasswd` command with the new password on stdin
(never in the command line), then verifies a new SSH connection. Existing
server SSH policy must permit root password login; this feature never enables
it. Attempts are rate-limited to five per 15 minutes per source address (ten challenge
requests per 15 minutes), and
concurrent password changes/deployments are blocked.

Passwords are not logged, included in plans or stored in an audit record. Private
audit entries in `services/cms/data/server-users/audit.jsonl` contain time,
host, action, outcome and optional encrypted-storage confirmation. Failures after submission are explicitly unverified:
the password may have changed, so check server access before retrying. Navigating
away does not cancel an in-flight password change. After verified success, a
configured external vault key enables automatic encrypted storage of the new
password. Storage failures are reported separately from the verified remote
change; re-enroll in Database & vault before using stored-credential operations.
Neither local nor remote environment files are rewritten.

The password card shows a prominent live result above its inputs: **SUCCESS**
only after both the change and a fresh SSH login are verified, **NOT SUBMITTED**
for validation/signing failures, or **NOT VERIFIED** when the submitted outcome
is uncertain. Required-field validation and cancellation also produce feedback.
**Refresh last recorded result** reads the latest credential-free audit outcome
and timestamp through the protected `/api/server-users/root-password/status`
endpoint, including after navigation or a restart. A historical result is labeled
as such; an interrupted/requested operation never displays as success. If the
network result is uncertain, keep the recovery session open and independently
test a new SSH login with the new password before retrying.

The single Admin site dropdown includes every core and hosted site individually. Selecting a site opens its primary management workspace, while cards expose service, content/appearance and deployment links as appropriate. `#/operations` lists native service workspaces and application shortcuts. App membership, teams, missions and grants use `#/intranet`; Silver products, encrypted stock and fulfillment use `#/silver`; Notes reward programs, balances and explicit market funding use `#/notes`. Old per-site `note-markets` URLs delegate to that same Notes view, not a second funding implementation. Reserved and already-funded markets cannot be funded, insufficient treasury disables funding, and the exact approval phrase and confirmation remain required.

**All sites**, **Service operations**, **Notes** and **Deployment** remain available while managing a site. Deployment (`#/deployment`) performs a reviewed release to the server; review, exact approval and status remain on that page, not the Sites overview. This does not change deployment permissions, enable remote deployment, synchronize balances or perform Ethereum reconciliation. Public site navigation does not show Admin links; existing administration URLs remain available.

Deployment needs no root password environment variable. Use
`DEPLOY_TARGET=root@featheral.com:/opt/featheral` and an external
`DB_VAULT_KEY_FILE`; enroll the current root password through Admin's
`#/database` view with an origin-wallet signature and a freshly verified SSH
login. The independent encryption key must remain outside the repository and
ledger. AES-256-GCM ciphertext lives in the `internal/vault` journal; there is no
view/export-password endpoint. Every stored-credential deployment and account
browse needs another action-bound, five-minute, single-use origin approval.
Alternatively, a restricted SSH deployment user can use an absolute
`DEPLOY_KEY_FILE`. Legacy password-environment configuration remains supported
during migration but is no longer in the example. An independently verified `DEPLOY_HOST_KEY_SHA256` and
`DEPLOY_TLS_EMAIL` are still required. Credentials never appear in review plans,
shell commands or persisted status. Enter passwords only into the protected
Admin enrollment/change forms, never chat. Restart to reload environment changes. Root password login must
already be permitted by server policy; no SSH configuration is changed. Keep
`DEPLOY_ENABLED=false` until prerequisites have been checked, then generate a fresh
plan and approve its exact digest. This uploads code and published CMS content
only. Private databases, balances, signing keys and the remote `.env` remain in
place; automatic data synchronization and offline-restore management are not
enabled by setting deployment credentials.

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

`GET /api/creation/wallet` includes a portfolio for native FTH$ and note holdings. Public `GET /api/creation/wallet/portfolio/:account` values a read-only World account's native FTH$ only. Funded FTHX/community-note spot ratios require authoritative matching reserves and no pending routed settlement; unpriced assets are listed separately. Gold supplies verified mainnet bridge ratios for FTHG estimates. Its timeout-bounded USD lookup prefers the deepest liquid Ethereum Uniswap FTHG base-token pair reported by DEX Screener. With no valid pair or a feed error, it publishes the labeled temporary **1 FTHG = $0.01** reference, including `fallback: true` and `marketError`; this is not a market quote. Results are cached for one minute before retrying; successful DEX results replace the reference automatically. Consumers require a source timestamp no older than five minutes. Internal USD estimates still require verified Gold conversion ratios; FTH$ is not USD. Neither the separate World budget nor legacy duplicate accounts are added to the connected-wallet subtotal.

Portfolio assets and native ETH entries expose exact 18-decimal USD base units as `usdValue`; mainnet FTHG uses `ethereumUsdValue`. Wallet rows show USD and primary-currency estimates beneath each asset balance, scaling combined wallet/custody valuations to the actual held portion. Totals remain below the available balance. USD estimates display four decimal places; primary-currency estimates use at most four. Both round using integer arithmetic; positive values below that precision show `<$0.0001` or `<0.0001` in the primary currency. Missing prices stay unavailable. Native ETH USD values retain their independent feed rather than inheriting the FTHG reference label.

Fresh mainnet Gold snapshots with an initialized native `goldReserve`, matching token, valid genesis/evidence and consistent cap/allocated/remaining totals supply their recorded conversion rate for valuation independently of the separate Ethereum bridge. The source is `native-reserve`, explicitly labeled as obligations rather than confirmed backing or executable liquidity. Unknown/malformed reserve and bridge states still cannot invent a conversion.

Dollar can display World guest funds without an injected wallet. `/wallet-sync.html` on the canonical World host makes a same-origin authenticated `GET /api/dollar/game/wallet/balance` (exact `{accountId,wallet,available}`; no-store), and returns to the fixed Dollar `/wallet/` URL with only the public `worldAccount` ID in a fragment. A top-level handoff preserves host-only/SameSite session protection even on `.localhost`, where a cross-site iframe cannot read the existing session. Dollar consumes/removes the fragment and stores only that public account ID; it polls `/api/v1/dollar/fth/accounts/:accountId` for the real spendable balance. Guest view is read-only and clearly labeled; a separately connected wallet is never merged with it. No session creation, cookie export, automatic fund transfer or signing capability is involved. Use **Sync World account** again after changing the linked World identity; missing sessions/errors are shown explicitly.

Each of the 34 letter/digit placeholders requests **1,000,000 existing treasury FTHX + 1,000,000 newly issued placeholder units**. Funding is never automatic. In Admin, select Notes and open **Note markets & funding**. The protected `POST /api/notes/markets/:symbol/fund` requires same origin and the exact phrase `FUND <symbol> 1000000 FTHX 1000000 NOTES`. Funding debits the existing system treasury, credits the pool and records initial placeholder issuance in one SQLite transaction. Insufficient treasury balance fails without any issuance. Each pool can be funded once. The 34 eligible pools would require 34,000,000 FTHX; the current supply is insufficient and must not be replaced with demo liquidity or newly minted FTHX.

Public `GET /api/creation/markets` lists funded/unfunded pools. On Notes, `POST /api/creation/markets/quote` returns a whole-unit constant-product quote with a 0.3% fee; `POST /api/creation/markets/trade` requires a wallet session, symbol, buy/sell direction, integer amount, minimum output and unique request ID. Buy spends real global FTHX; sell spends the selected placeholder. Four balanced entries, pool reserves and the trade record commit together. Retries return the original receipt and conflicting parameters are rejected. No Ethereum transaction or Dollar/demo balance is used. Fees remain in pool reserves. Trading does not mint FTHX; custom-note reward issuance remains separate. Existing system assets do not receive new placeholder pools.

The first content on the Notes homepage ranks all notes by **last-24-hour executed FTHX volume**, counting buy inputs and sell outputs once per trade, not reserves, reward activity or fabricated volume. FTHX shows aggregate quote volume across pairs; each other note shows its pair volume. These per-note volumes are not summed as independent totals. Native circulation is shown separately below the ranking. Unfunded markets show zero volume and disabled trading. Non-placeholder community currencies currently have no configured pool. A Refresh volumes control loads the latest ranking.

Notes owns the Dollar API implementation in `services/notes-api/dollar.js`; the original `services/dollar-api/server.js` remains a compatibility export. Existing `/api/v1/` endpoints, Dollar URLs, game funding, signing keys, ledger files and Gold backing rules remain unchanged. The same authenticated API is available on the Notes host. No second FTH$ ledger is created. Activation of either FTH$ or FTHX regular reward programs explicitly fails. Existing native program records are treated as disabled at read and execution time, without rewriting balances or historical payouts.

FTHX accounting is global in ignored `data/notes.sqlite`. At startup each registered site's old `qprn_ledger` is imported once with source IDs, row counts, totals and SHA-256 audit digest; old tables are preserved. Wallet balances sum all original site entries. A changed legacy source after migration prevents startup instead of double-crediting it. Public FTHX top-ups, tips, posting costs and shop/demo FTHX operations now use this global balance within SQLite transactions; other demo assets remain site-local and are not the real FTH$ ledger.

Community rewards are disabled by default until a community note is selected and enabled. The first authenticated like **or** comment from another wallet on member-created content records one server-side random draw for that site/content/reactor pair. Default chance is 10% and payout is 1 unit of the selected community note to the creator, not a transfer charged to the reactor. Self-reactions and guests are excluded; losing draws, retries, undo and switching from like to comment cannot reroll. Wallets are not proof of distinct people; this is credit issuance, not a valuable-token anti-abuse system. Existing paid-like records are imported as already-attempted. CMS-edited whitepapers are preserved; untouched original or previously upgraded FTHX documents receive revised mechanics with revision history.

Admin-authenticated APIs: `GET /api/notes`, `GET /api/notes/sites`, `PUT /api/notes/sites/:key/rewards`, and `GET /api/notes/wallets/:address`. Writes require same origin. Database backups must include `notes.sqlite` and all source datasets; no private balances/history are added to Git or remote-deployed automatically.

The Ledger site exposes public, read-only Notes browsing through `GET /api/notes/ledger/currencies` and `GET /api/notes/ledger/:symbol/entries`. Entry reads support an optional `address`, a `before` entry-ID cursor and a `limit` from 1 to 100. Pages are newest-first and keyset-paginated; Notes database entries are not hash-chained blocks. FTH$ remains on its separate native daily-file currency ledger.

All core frontend folders are under `sites/`, named by full hostname: `featheral.com`, `gold.featheral.com`, `dollar.featheral.com`, `ledger.featheral.com`, `world.featheral.com`, `admin.featheral.com`, `x.featheral.com`, `ex.featheral.com`, `stats.featheral.com`, `sites.featheral.com` and `notes.featheral.com`. Exchange and Stats serve their own shells while reusing the managed-site renderer/assets. CMS data stays in its existing private location. The site dropdown uses canonical full URLs as both labels and option values (including hosted website paths); selection resolves to existing dataset keys or integrated editors without renaming databases.

### Free websites

`sites.featheral.com` hosts wallet-owned websites at `sites.featheral.com/site-name/` (`sites.localhost:8080/site-name/` locally), with a one-time creation fee and no recurring hosting charge. Its frontend shell and assets live in `sites/sites.featheral.com/`; the homepage retains editable CMS content and lists published hosted websites.

On **sites.featheral.com**, connect your wallet, enter a lowercase website address and display name, then confirm the **500 FTH$** creation fee. The wallet signs a native Dollar treasury transfer in 18-decimal base units, not an Ethereum transaction. Demo balances are not accepted. A durable request reserves the address and binds the exact owner, payload, amount, recipient, nonce and memo before payment. After the transfer seals, the website and ownership record are provisioned. Retries reuse that ledger transfer; restart recovery resumes saved signed requests. If another transfer consumes the nonce, preparation can safely issue a replacement only after detecting the conflicting ledger transaction. Pending requests appear in the owner's dashboard; at most three unfinished addresses can be reserved per wallet.

Each website gets a separate dataset such as `data/sites-featheral-com--site-name/`, including pages, revisions, theme, feature settings, media and public databases. The owner dashboard edits safe page HTML, publishes additional pages, changes the theme and configures rewards using only the owner's registered community notes. FTH$ and FTHX are not reward choices. Ownership is checked on every operation, independent of Admin permissions. Registry records share the base hostname but have distinct `path` and `key` fields. API requests and browser storage are scoped to the selected website; unknown names return 404. Names must be at most 63 characters and cannot use reserved API/asset/admin routes. Existing websites are not reassigned to arbitrary wallets.

`notes.sqlite` contains currency definitions, creation fee entries, wallet sessions, durable payment requests and website ownership. Preserve it alongside original Dollar ledgers, signing keys, `sites.json` and CMS datasets in a consistent private backup. Ownership and paid-request state are private runtime data, not source-controlled deployment content. Old Admin `/api/sites` POST and Notes `/api/notes/sites` POST return 410; there is no unpaid public creation bypass. Internal fixture/import/bootstrap provisioning remains available for restoration, not as a public API.

Public wallet sign-in enables paid creation and ownership-scoped editing; Admin authentication still enables ecosystem administration. There is no automatic remote deployment. Content uses the existing safe CMS renderer, not arbitrary uploaded HTML/scripts; path-hosted websites share a browser origin and are not a security boundary for running untrusted code. Reviewed deployment snapshots preserve each website's path; private datasets still require the matching restored registry and Notes ownership database. Traffic overview and Stats identify each hosted website separately by hostname/path.

### Ecosystem statistics

**All-site overview** displays aggregate traffic for every integrated and registered site, including Admin and World. Each site card's **Overview** opens its own hourly/daily charts. The charts contain exactly 24 hourly and 30 daily UTC buckets, including zero-traffic periods, and can be refreshed.

Sites and All-site overview show the same chart-first dashboard. Each card has compact overlaid favicon, description, status and management links; descriptions are limited to two lines with an ellipsis. Charts default to hourly (24 hours); one header interval selector controls all charts. UTC windows and bucket scales are labeled. Only reviewed-deployment controls remain below the dashboard; Admin's Add-site feature is removed. No port badge is shown.

Charts default to hourly line charts for the last 24 hours, with minute and daily options. Minute collection starts with this update; earlier hourly totals are preserved, not interpolated into invented minute data. Minute storage retains only the last hour. The redundant All-site overview sidebar entry is removed; Sites opens the dashboard and old overview URLs still work. Admin Sites and Stats begin with a full-width aggregate chart showing summed page views for the selected period, the site count, colored per-site lines and favicon legends. Stats shows the same shared per-site charts before its editable homepage content. These are page views, not unique visitors.

One interval dropdown in the page header controls every chart, including the aggregate. Admin refresh preserves the selected interval. Charts include light quarter-step grids, numeric page-view axes and UTC time/date ticks. The redundant Admin overview header banner is removed.

All per-site traffic charts use one shared zero-based scale calculated from the largest minute, hourly or daily bucket across the complete report. Filtering a site or switching timeframes does not rescale it; equal counts have equal line heights across sites. The aggregate chart has its own explicitly labeled scale based on summed buckets across all sites and periods, so the total line is never clipped. Refreshing uses the updated report maximum. Core icon gradients and chart colors share `shared/site-colors.json`; regenerate assets with `npm run build:logos` after changing this palette.

Stats, the Sites directory and Notes have distinct blue, green and violet brand accents matching their icons. Their existing theme backgrounds and content remain unchanged; hosted websites keep their independently selected theme accents rather than inheriting the Sites directory color.

The existing `stats.featheral.com` has the same CMS content, revision, theme, feature and deployment management as X and Exchange. Edit its introductory homepage normally. **Site features → Show public ecosystem traffic charts** controls the live dashboard; the content homepage must remain selected. This template is not automatically provisioned as a sample. Local access is `http://stats.localhost:8080/`.

All served HTML receives the aggregate collector; SPA hash/history navigation is tracked, while embedded operation consoles are excluded to avoid double-counting the shell. It stores only hostname, UTC hour and page-view count in ignored `data/telemetry.sqlite`, never IPs, visitor IDs, wallet identities, referrers, route/query strings or page content. Do Not Track and Global Privacy Control suppress collection. Existing managed-site visitor analytics are separate and unchanged.

`POST /api/telemetry/hit` accepts only `{}` from a recognized same-origin site. `/api/telemetry/report` requires admin authentication. `/api/telemetry/public` exposes these aggregate-only charts on a Stats-enabled managed site (or authenticated CMS preview); richer visitor analytics are never included. Collection starts with this feature, not synthetic historical data. Adding Stats locally does not deploy or configure remote DNS/TLS.

The existing media data set is registered as **x.featheral.com** in `data/sites.json`; its original folder is retained to preserve all media and content. Use the sidebar selector or **Sites → Select site** to manage its content and theme.

Existing hostname-based sites remain manageable in Admin. Public creation supports only wallet-owned paths on `sites.featheral.com`, not new custom hostnames. Site datasets contain `db.sqlite` (an imported-data-compatible database), `cms.sqlite` (content and theme), `public.sqlite` (wallets, comments, votes and analytics), and `uploads/`. Content and settings remain isolated; FTHX wallet credits are global.

Public requests select the site by hostname; unregistered hostnames do not serve another site's data. On localhost, the selected site's **Public site** link uses `/?site=<key>` to preview it, including its own API requests and browser storage. Preview selection requires CMS access. Adding a site does not configure DNS or TLS; point each hostname at your HTTPS reverse proxy separately.

The app routes `admin.featheral.com` to the CMS and `x.featheral.com` to the public site using the request hostname. Configure DNS and your HTTPS reverse proxy to send both hostnames to this Node server. Set `CMS_PASSWORD` in the server environment before exposing the CMS; the CMS hostname requires HTTP Basic authentication, and CMS write APIs also require authentication. Localhost development remains available without a password.

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

- **Swipe**: one shuffled deck of every GIF and image post, mixed together, shown full-screen TikTok-style with the title, description and like count (all rounds) overlaid. Swipe right (or press →) to like and keep a post. Swipe left (or press ←) to dislike it: in round 1 this deletes the post and its media; from round 2 the dislike is only counted. Undo with ↺ or Backspace. Each post shows its largest attached GIF, or its largest image if it has no GIF. The shuffle is stable within a round, so leaving and coming back continues where you stopped; each new round is shuffled differently. Only published posts with a downloaded file are included. The next cards' media is downloaded and decoded in the background (always the next 5, and up to 12 within a 600 MB budget). Each card's still frame and blurred backdrop are prepared off the main thread, so swiping never waits on loading or decoding. Only the card on top plays; the cards behind it show a still frame. Each card shows up to 6 of its keyword tags as `#tag` chips (most used first); clicking one opens that tag's Trending gallery.
- **Read**: a separate menu that lists every published post with text. You can search it and sort it by length (longest by default) or date, and open any post in a clean reader view.
- **Trending**: a gap-free gallery of all photos (thumbnails included) and GIFs from the posts of the trending tags. GIFs are scattered: one after every 5 photos. It is sorted by likes + comments by default; it can also be sorted by most liked, most commented or newest. Tag heat is the sum over the tag's posts of likes + 2 × comments. More recent activity counts for more (up to 3×, fading over about a week), and the sum is divided by √(posts) so big tags don't always win. When fewer than 12 tags have activity, the most used tags fill the list. Click a tag chip to see only that tag. **＋ More tags** keeps loading the rest of the tags, 40 at a time (most active first, then by size). The search box searches every post's title and text (all words must match) plus tag names; matching tags show as chips. The viewer lists each post's tags, and clicking one opens that tag's gallery. 👍 likes the post (in its deck's current round), with infinite scroll. Tags come from **Keyword tags** below.
- **Branding & posting**: the media site is **x.featheral.com**. Its logo (`public/site/logo.svg`, also the favicon) is a black shiny feather with a red 18 above it. Posting is the round pink **＋** button floating at the bottom right of every page (hidden on the post page itself). A post can be a YouTube video, an image, a GIF or a link. For a YouTube link (`youtube.com/watch`, `youtu.be`, `/shorts/`, `/embed/`, `/live/`), the video's title and cover image (the largest of maxres/sd/hq) are fetched, and the post always goes to the Swipe deck. The video id is kept in `member_posts.video` and the post meta `_wpx_youtube`. The cover then shows like any image, with a ▶ button on swipe cards and a ▶ badge on gallery tiles; pressing play (or opening it in the viewer) plays it in a `youtube-nocookie.com` embed. The same video can't be posted twice. Posting still needs a connected wallet and 1 FTHX.
- **Liked**: the kept posts that were liked, most liked first within each media type. GIFs are spread through the images the way the swipe deck mixes them, never bunched together, with a fresh shuffle each time the page is opened. Each one has a "Dislike & delete" button.
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

Media is cached by the browser for 7 days, so a trashed image can still appear from the cache until then. In `admin.config.json`, `publicBrand` sets the public site name (it defaults to the stored site title), `publicTagline` sets the line under it (it defaults to the stored site description; also used for the page description and the age gate), and `ageGate` (default `true`) shows an 18+ confirmation before any content.

The server listens on `127.0.0.1` by default. Setting `HOST=0.0.0.0` exposes it to other machines, but that also exposes `/admin`, which has no login.

## Original sync features

The app can connect to a **WordPress site through its REST API**, bulk-download the **original media files**, and organize the content into an explorer you can browse, search and export.

## Requirements

- Node.js **22.5+** (built-in SQLite managed through db-api; tested on Node 24)

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
