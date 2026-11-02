# Featheral

One Node server (`scripts/serve.js`) hosts the Foundation ecosystem, selected by the request host. Foundation, Gold and Dollar expose their currency APIs; Media owns social actions and the database service owns wallet profiles. CMS-managed hosts use their independent CMS/public APIs:

| Site | Production host | Local URL | Source |
| --- | --- | --- | --- |
| Foundation | featheral.com | http://localhost:8080/ | `sites/featheral.com/` |
| Featheral Gold (FTHG) | gold.featheral.com | http://gold.localhost:8080/ | `sites/gold.featheral.com/` |
| Featheral Silver (FTHS) | silver.featheral.com | http://silver.localhost:8080/ | `sites/silver.featheral.com/` |
| Featheral App (intranet) | app.featheral.com | http://app.localhost:8080/ | `sites/app.featheral.com/` |
| Featheral Dollar (FTH$) | dollar.featheral.com | http://dollar.localhost:8080/ (`/wallet/`, `/explorer/`) | `sites/dollar.featheral.com/` |
| Featheral Ledger | ledger.featheral.com | http://ledger.localhost:8080/ | `sites/ledger.featheral.com/` |
| Featheral World (settlement & federation game) | world.featheral.com | http://world.localhost:8080/ | `sites/world.featheral.com/play/` |
| Featheral Media (social community) | media.featheral.com | http://media.localhost:8080/ | `sites/media.featheral.com/` |
| Featheral Admin (CMS & operations) | admin.featheral.com | http://admin.localhost:8080/ | `sites/admin.featheral.com/` |
| Featheral X | x.featheral.com | http://x.localhost:8080/ | `sites/x.featheral.com/` |
| Featheral Exchange | ex.featheral.com | http://ex.localhost:8080/ | `sites/ex.featheral.com/` |

All frontend source lives under `sites/`, named by its public hostname. Common assets remain in `shared/`; backend services and private data stay in `services/` and their existing data directories. World game source remains nested in `sites/world.featheral.com/play/`. X supplies the shared CMS-managed public-page shell, also used by Exchange and newly registered sites; Exchange's demo assets live in its own directory. The CMS server preserves `/site/` asset URLs and authenticated preview behavior without copying the shared renderer.

Services are named by ownership: `database`, `gold`, `notes` (including Dollar and game funds), `identity`, `wallet`, `media`, `cms`, and `operations`. Admin screen modules live in `sites/admin.featheral.com/pages/`. The redundant Dollar API wrapper and empty social placeholder pages have been removed; tests, migration tooling and private data are retained.

Header title links return to the current site's landing page. Foundation, Gold, Dollar, Silver, Stats, World and Media share an identical compact family bar with exactly those seven links in that order and the same 11px text, spacing and layout. Readable foreground and panel colors follow each site's theme, with the current page marked in bold. Other sites retain their current-site and same-currency links alongside the family links. Every non-embedded site has the full core-site hierarchy in its footer, including cross-currency destinations and Admin.

The seven family sites align header contents and page containers to a shared 1280px width, with 24px side gutters (16px on mobile) and padded site headers. Media retains its feed columns inside that container. Active family links use themed foreground and button colors so they stay readable on light and dark backgrounds.
The family bar stays hidden until its links are initialized, avoiding a flash of legacy page navigation before the shared header takes over.
Wallet and Exchange join App, Media, X, Notes and Sites in the FTHX family navigation. Reapplying shared navigation preserves unchanged links and keyboard focus. Fixed-header public pages grow with their content instead of overlapping the ecosystem footer.
Public pages without their own skip link receive a keyboard-accessible skip-to-content control that preserves SPA routes. The ecosystem footer spans the page and uses two-column groups with larger link targets on mobile.

The core sites use the main `shared/logo.svg` feather emblem. Foundation uses it unchanged; the other sites add small symbol badges (including Silver ingots, the App phone and Ledger's account book), each colored for its site theme. Headers, favicons, Admin cards and traffic legends use these variants. The shared palette in `shared/site-colors.json` also colors chart lines. After editing the main SVG, palette or badge paths, run `npm run build:logos` to regenerate shared variants and legacy X/World favicon aliases, then `npm run build:world` to refresh the game build.

### Foundation App and Silver

`app.featheral.com` is a mobile-first, installable insider workspace. Connect the
shared wallet, create your World profile and bio directly in App, request access, and wait for approval in
Admin's **App insiders & missions** view (`#/intranet`). Administrators assign
division, team, role and progression level. Approved members have scoped channels,
direct messages, private attachments, revision-checked shared notes, missions with
evidence/review, and one-to-one audio calls with screen sharing. Work communication
belongs in App; World gameplay chat and existing World messages remain intact.

`silver.featheral.com` is the **FTHS digital marketplace**: Admin-managed gift cards
and redemption codes for silver and Featheral collectibles. Featheral does not ship
physical goods. Each listing specifies issuer, sourcing, redeemable region, face value,
FTHS price and issuer terms. No brands, stock or global acceptance are fabricated.
Its inline wallet defaults to FTHS; FTH$ conversion uses real Exchange quotes.
**Featheral Silver (FTHS)** is also called **Featheral Salary**. No automatic
salary, USD peg, fixed wage or guaranteed liquidity is promised. Each grant
requires explicit Admin approval; completing a mission does not issue funds.
Notes lists FTHS as a system-native whole-unit currency; Stats includes its
circulation. Exchange and wallet swaps use the existing FTHS/FTHX pool only when
explicitly funded with real treasury FTHX. Startup registers the currency but
neither mints Silver nor funds liquidity.

The App API is `/api/intranet` on App/Admin; Silver exposes its public supply/pool
summary there and its storefront at `/api/silver`. Admin manages products, encrypted
stock, manual delivery and undelivered FTHS refunds at `#/silver`. Checkout is disabled
until a receiving wallet and secure code storage are configured. Domain logic and
persistence belong to Notes, not Gold or Ethereum.
Browser push requires VAPID configuration; reliable cross-network calls need a
configured TURN relay. See [workspace administration and setup](services/cms/README.md#foundation-intranet).
These additions are application services, not deployment of a new L3 blockchain.

App and World reuse the same `shared/world-profile.js` editor, rendered from the
versioned JSON UX model at `GET /api/v1/world/profile/ui`. Username, resized avatar
and public bio are prepared through World's `/profile/prepare` API and approved
inside the central wallet. `POST /api/v1/world/profile` delegates to the canonical
Notes profile writer and DB API profile store; it creates no second identity store
and charges no fee. Bio text is signature-bound and limited to 1,000 characters.
Older name/avatar signatures remain valid and preserve an existing bio.

### Unified administration, CMS editing and reviewed deployment

The Foundation homepage now describes all fourteen current public sites and the
protected Admin host without a public administration link. Its Docs and Governance
routes contain the ecosystem guide and current operating principles: shared tabbed
wallet, native currencies, actual Exchange trading, site-and-note creation, Gold/Notes
API ownership, automatic public views and explicitly authorized Ethereum reserves.
They distinguish the writer/replica application ledger from a deployed L3 rollup.
Homepage supply cards read Gold and Note APIs and disclose unavailable data without
inventing a fixed USD price. Exact old published defaults upgrade once on the next
CMS page read, retaining a revision; custom bodies, titles, descriptions and drafts
are preserved. Source updates do not themselves deploy a public release.

**Featheral Notes** at `notes.featheral.com` owns currency/reward APIs. Its public homepage shows authoritative circulation totals for system-native **FTH$ (Featheral Dollar)** and **FTHX (Featheral Exchange Token)** separately from notes ranked by executed FTHX trading volume in the last 24 hours. There are 53 alphabet, digit and punctuation placeholder markets, each targeting 1,000,000 existing treasury FTHX plus 1,000,000 placeholder units. They stay unfunded until explicitly authorized and fully funded; no live funds are moved automatically. Native notes cannot be earned through regular rewards. Any authenticated wallet can create a new community reward currency for **1,000 FTHX**, transferred to treasury. FTHX balances use an audited global ledger; FTH$ retains its existing ledger, reserve rules and compatibility URLs. See [Notes management](services/cms/README.md#featheral-notes).

Of the 53 placeholder definitions, only the 34 letter/digit notes are eligible for funding and trading. The 19 punctuation symbols remain reserved, hidden from trends and public market listings, with trading and funding disabled. Existing balances and history are retained; native FTH$ is unchanged.

Both `notes.featheral.com` and `sites.featheral.com` offer websites and note minting with a required new website. Minting costs **1,000 FTHX + 500 real FTH$** and binds the note to a durable new-site request; note-only API requests are rejected. Failed reservations roll back the note fee; after reservation, a failed site payment/provisioning can be resumed without paying the note fee again. Websites live at `sites.featheral.com/site-name/`. Existing owned resources can still be linked. Owner tools edit pages, theme, name and directory description; public browsing searches website names, descriptions and linked notes. Rewards start disabled and no pool is automatically funded. Admin has no Add-site form; retired creation endpoints return 410. Private data stays ignored. See [website management](services/cms/README.md#free-websites).

`ex.featheral.com` uses real global FTHX note pools for swaps, exact liquidity quotes, deposits/withdrawals, positions and transaction history. This is ledger-based trading, not a deployed Layer 3 blockchain. Its old exchange demo endpoints return 410. Notes and Exchange display actual pool spot ratios and executed-trade price history; unfunded notes show no market price, never mock data. Initial funding remains explicitly authorized through Admin.

Exchange spot orders now spend a **separate trading account**: deposit existing
whole FTHX only, buy/sell FTH$ or funded community notes, and withdraw any acquired
asset to the same owner's main wallet. Transfers, trades and retries conserve
existing supplies. Dollar custody is backed by the authoritative Dollar pool;
withdrawals use a persisted, retry-safe settlement journal. Combined wallet
estimates include trading holdings without making them spendable outside Exchange.
The terminal shows executed OHLC candles, volume, SMA20, timeframes, zoom/pan,
full-screen charts, slippage previews, balances, trades, movement history and
wallet-funded liquidity positions. It does not simulate an order book or leverage.

Dollar retains its original CMS landing page at `/`, with the shared wallet at `/wallet/`: Assets, Send, Receive, Swap, Activity and Account. Every site's wallet dialog uses the same compact top-right renderer; Foundation and Gold lead with FTHG, Dollar and World with FTH$, and all other sites with FTHX. The large primary balance is the active account's actual available currency, never a combined valuation. Smaller lines beneath show the estimated portfolio USD total and the estimated total in the site's primary currency; linked accounts, World and Exchange funds remain separate. Unavailable prices and partial estimates are explicitly labeled. Host colors and themes are preserved. The shared central-origin renderer supports external Ethereum-compatible wallets and the encrypted built-in wallet inline; host sites never receive private keys or wallet sessions. Wallets continue to read authoritative holdings independently of Exchange liquidity. World’s existing wallet transfers, deposits/withdrawals and gameplay APIs are retained.

Empty wallet primary balances initially display `0.00` for FTH$/FTHX and `0.000` for FTHG/FTHS. Confirmed zero balances use the same precision; failed or unavailable reads remain explicitly unavailable.

The standalone wallet uses a spacious dark/gold layout with labeled connection state, 44px utility controls, responsive keyboard-accessible tabs and separate safety/recovery guidance above the ecosystem footer. Explicit themes and embedded host palettes still take precedence over its default gold accent; signing, balances and transfer approvals are unchanged.

The wallet's **Swap** tab replaces Thanks and executes through the shared Exchange engine without leaving the panel. It supports FTH$, FTHX and all funded native notes, routing note-to-note swaps through FTHX. Live pool quotes include the 0.3% fee per hop and price impact; approval sets the quoted output as a strict minimum. Unfunded markets and indicative FTHG/USD estimates are never executable liquidity. Each executed FTHX-pair leg updates Exchange reserves, trade history, volume and candles. Native-note routes settle atomically; signed FTH$ routes use the existing recoverable settlement journal. Pending requests can be resumed inline, and only unsubmitted preparations can be discarded. Exchange trading custody and World funds remain separate from spendable wallet funds. Ethereum FTHG conversion stays on Gold; no new peg, issuance or guaranteed redemption is introduced.

All public wallet headers open the central wallet without restoring a second
site-local extension account, even before the embed finishes loading. Connect/create
is visible above its tabs; without an extension the full wallet offers creation,
recovery or unlocking the existing built-in wallet. Explicit Ethereum/admin
transaction signers remain separately labeled and do not replace the public wallet.

Exchange, Notes/Sites creation and X/community sign-ins use
`FeatheralWallet.authenticate` through the central
`/exchange-auth.html?mode=site&origin=…&nonce=…` popup. Select a built-in wallet or
extension on the wallet host, review a fresh standard sign-in message and explicitly
approve. The exact network opener, nonce and account are checked; only an address
and signature return, never wallet keys/passwords or central sessions. Each site
keeps its own authenticated session. Payment messages are rejected by this sign-in
channel; financial approvals remain separate. The original Exchange-only built-in
protocol remains compatible. Public balances and estimates follow the central active
account, not a site's possibly older commenting or trading session.

Visible wallet views refresh balances and portfolio totals every 30 seconds, with overlapping scheduled refreshes suppressed. The explicit Refresh action remains available. Embedded views also accept a credential-free `featheral:wallet-updated` hint only from their configured parent window and exact origin; hidden views defer reads until visible again.

Initial pool funding remains explicitly approved using existing balances; no liquidity or volume is created automatically. Notes charts display completed trades and actual pool spot prices. Gold reserve and Ethereum bridge/staking screens are hosted at Exchange `/gold-channel/` and `/ethereum/`, reusing the central implementations and their original APIs/signing restrictions. Old Gold conversion and central Ethereum page URLs redirect there. FTHG is never relabeled as an internal note or made tradable through fictitious reserves.

World Play's **Account → Authorize World budget** explicitly switches to a separate gameplay fund without moving existing funds. Legacy direct-wallet sessions remain unchanged until signed approval; existing guest funds stay in World. Dollar's **Deposit / Withdraw** opens the same-origin World funds screen: signed deposits move existing wallet FTH$ into World, and signed withdrawals return it only to the authorized wallet. Exact requests and the original Dollar journal recover interrupted transfers without issuance or duplicate debits. Gameplay in separate mode spends only the World budget. Returning from World funds synchronizes its public account into Dollar; use **Sync World account** after changing the World identity elsewhere.

Dollar's portfolio reports combined wallet, Exchange trading and linked World assets,
with unpriced assets explicitly excluded. Initial indicative references are
**1 FTHG = 10,000 FTH$** and **1 FTH$ = 100 FTHX**, only for verified initial
unfunded states. Verified funded Gold-channel and Exchange reserves subsequently
set the ratios. USD requires a fresh positive market price for the exact FTHG
Ethereum contract (native ETH can use its own USD feed). Errors, paused or
inconsistent reserves never fall back to opening prices. These references do not
change existing reserve obligations, mint supply, fund pools or peg FTH$ to USD.
Estimates exclude fees/slippage and are not executable quotes. World funds are
shown separately and included once in the total.

Without an Ethereum wallet, Dollar also displays the existing World guest account. **Sync World account** briefly visits World to read its existing authenticated session, then returns only its public ledger account ID to Dollar. No session cookies, signing authority, funds or new accounts are shared/created. Dollar reads that account's actual ledger balance on refresh; guest transfers/swaps still require explicit wallet authorization in World. A missing World session is reported rather than replaced with a new zero-balance guest.

Public family navigation uses the groups described above. The shared gateway supplies navigation assets once per HTML page; screens up to 700px hide the top family bar and retain the full ecosystem footer. Administration links remain excluded from public headers.

`stats.featheral.com` opens a dedicated read-only statistics dashboard, independent of legacy X/media homepage settings. It uses shared aggregate and per-site traffic charts with minute, hourly and daily UTC intervals, plus a manual refresh. Its public report contains aggregate counts only; other managed sites still require the Stats feature to expose reports.

All gateway HTML pages receive shared telemetry, including World SPA route changes and application pages. Embedded admin consoles are excluded to avoid double counting. Telemetry stores only hostname/hour/count in `services/cms/data/telemetry.sqlite`; no visitor ID, IP, wallet, page content, referrer or URL is stored. It respects Do Not Track and Global Privacy Control. Existing X media analytics remain independent. Admin Sites overview, managed-site Overview and integrated site editors display last-24-hour and last-30-day UTC charts with zero-filled buckets. Collection starts when enabled; there is no historical backfill.

Admin **Sites** lists Foundation, Gold, Dollar, World and Admin alongside X/Exchange and registered sites. Foundation, Gold and Dollar homepages, their `/docs/` pages and Foundation `/governance/` are full CMS documents at the same public URLs. CMS-owned seed content/layouts live in `sites/admin.featheral.com/documents/`; published edits live in `services/cms/data/site-pages/`. The editor supports page titles, search descriptions, safe HTML sections, links, images and themes. Protected `<cms-widget name="..."></cms-widget>` slots retain live statistics, ledger tables and controls: each must appear exactly once, but can be repositioned. Scripts, inline styles and event handlers are rejected. Previous text-block edits migrate automatically on first access; old revisions remain in the database. Deployment includes document seeds and published bodies/metadata/themes.

World and Admin retain revision-checked plain-text blocks bound to their native application templates with stable `data-cms-copy` keys. World gameplay, wallets, profiles and feeds, plus conversion/wallet/explorer applications and APIs, are unchanged. X, Exchange and other registered sites retain their existing full CMS editor.

Administration uses native views in `sites/admin.featheral.com/pages/` and scoped controllers in `js/operations/`, not embedded legacy consoles. Foundation overview/access, Gold reserve/token safety, Dollar liquidity/rewards/ledger and World moderation share the Admin shell and one persistent signing-wallet control. All core and hosted sites are individually selectable; API-provided management links open the appropriate operations, App intranet, Silver marketplace, Notes rewards/markets or content workspace. `#/notes` consolidates market funding; existing `#/set/<key>/note-markets` links remain compatible. Legacy `/operations/<service>/` URLs redirect to native `#/operations/<service>` routes. Existing wallet role checks, signed message bytes, ledger formats and transaction confirmations remain unchanged. `admin.featheral.com` authenticates the workspace and forwards protected `/api/v1/*` requests to the owning Gold/Dollar/World services without parsing away request bodies. API writes also require the admin origin. Admin access and operations configuration are managed in **Settings**; CMS backend/private data remain in `services/cms/`. The old CMS-host content database is reused if present, preserving edits and themes.

The retired `cms.featheral.com` / `cms.localhost` hostnames redirect to Admin, and product `/admin/` URLs redirect to their matching unified console. Cross-site links point directly to Admin. Deployment plans/Nginx hosts now include `admin.featheral.com`; remote DNS/TLS changes still require reviewed deployment.

**Settings** (`#/settings`) contains one **Deployment** card: server host, SSH port,
root password or `user:password`, deployment directory and certificate email.
Sign and save the connection, then review and sign the deployment in the same card.
A credential is required for initial enrollment or a changed SSH target; blank
retains an already verified saved credential. Saving enables reviewed deployment,
but never launches it. The separate Deployment menu is removed; old `#/deployment`
links redirect to Settings. The in-page console polls persisted progress, including
upload, setup, build, PM2, Nginx and HTTPS phases. Only fixed installer markers are
shown; raw server output and secrets remain in `<target>/shared/logs/deployment.log`.
Logs retain the latest 200 events. Removed Admin/configuration cards do not clear
existing runtime values or limits; advanced configuration remains available through
the protected Settings API. Each site's **Server & service settings**
provides common service controls and a Shared/Separate server assignment; advanced
runtime configuration remains available through the protected Settings API.
The global **Logs** menu (`#/logs`) shows recorded deployment progress and provides
wallet-signed remote log reads for each configured server: deployment installer,
PM2 application output/errors, Nginx access/errors and Certbot. Reads are limited
to the latest 64 KiB/up to 400 lines, use fixed file paths, and redact known saved
secrets. Logs can still contain private operational or personal information;
review them before sharing. Missing/unreadable logs report an explicit error.
Enter `username:password`; password-only or `:password` means `root`. One password
is used for SSH and sudo. Saving a credential verifies SSH and sudo access; it does
not change the server password. Secrets are encrypted in
the private system database at `data/system-database/` and are never returned by the Settings API.
Admin access requires a wallet signature from either the origin wallet
`0xD2f1Be8414472E9f436B65e91A2B8dFDa418287c` or the Dollar reserve wallet
`0x706CCb6109046a6a4A08dbAD4444A46408703ccb`. No Admin password or HTTP Basic
login is accepted, including on localhost. Sign-in challenges are single-use,
browser/origin-bound and expire after five minutes. Sessions use host-only,
HttpOnly, SameSite=Strict cookies, expire after eight hours and are invalidated
by sign-out or a server restart. Wallet switching/disconnection signs out the UI.
Settings changes, deployments and account reads retain separate single-use
approval from the signed-in Admin wallet. SSH keys are automatically pinned after
the first successful credential verification; subsequent key changes are blocked.
Use a trusted network for first enrollment: automatic first-use trust cannot
independently authenticate an intercepted server.

Initialize once with `node scripts/init-settings.js` using the service account.
The external bootstrap defaults to `/etc/featheral/bootstrap.json` on Linux or
`%ProgramData%\Featheral\bootstrap.json` on Windows. It points to a separate private
encryption key. An optional `FEATHERAL_BOOTSTRAP_FILE` selects another absolute
external bootstrap location. Keep both outside the repository and ledger backups,
restrict Windows ACLs to the service account, and back up the key separately.
Open Admin, connect either authorized wallet and sign in before opening Settings.
Production requires HTTPS; HTTP is allowed only on loopback `admin.localhost`.

The deployment installer automatically detects new and existing installations;
there are no first-install checkboxes. Review the plan, enter its exact approval
phrase and sign with your Admin wallet. Existing storage and encryption keys
are reused. Only an empty shared Admin server without an existing `current` release
is initialized. Ambiguous or partially restored private data stops deployment
instead of being replaced. New storage includes encrypted Settings, with a service-account-owned
bootstrap/key under `<target>/shared/bootstrap/`, outside every code release.
It does not copy local SSH credentials, financial keys, balances or runtime secrets.
Gold remains disabled and production ledger writer roles remain unconfigured
(the default standalone local ledger can initialize its own empty state).
Back up this new key separately and configure production services in site settings.
Subsequent deployments and retries automatically reuse initialized storage.

If the managed-site registry is empty or absent, the installer automatically creates
new site records, published pages and presentation settings only, without source
ownership, balances, rewards, uploads or history. Media references may need
replacement. Existing managed sites or matching data folders are never replaced.
Existing nonempty registries must match the reviewed sites; restore their matching
private data when recovering an installation, rather than deleting the registry.
The Settings console also streams installer stdout/stderr with known credentials
redacted. Full server output stays in `<target>/shared/logs/deployment.log`.
Logs can contain operational data; review before sharing.

Existing installations should stop the writer, keep an offline backup, then run
`node scripts/init-settings.js --migrate-env` before restarting. This explicitly
imports all supported runtime configuration, Admin access and operations settings,
including an existing encrypted root vault or legacy password. After a successful
database read-back, it removes the migrated `.env` and any imported Admin config.
An encrypted copy of the exact source configuration is retained under
`migration-backups/` beside the external bootstrap, using its original encryption
key and AES-GCM AAD `featheral-legacy-migration-v1`.
Unrecognized names and conflicting aliases/database values stop migration without
removing the source file. Review any customized old Admin JSON before upgrading;
set `ADMIN_CONFIG` to its backup path to import it as `ADMIN_CONFIG_JSON`.
If encrypted JSON Settings were already configured, first run
`node scripts/init-settings.js --migrate-settings` with their original bootstrap/key.
Deployment is disabled after migration. SSH-key installations must re-enroll a
password credential; migration refuses to discard them. Existing balances,
For installations without an Admin password or using legacy SSH-key authentication,
run `node scripts/init-settings.js --migrate-env --setup`. This explicitly archives
the old configuration, preserves supported values and disables deployment without
converting or deleting the SSH key. Start the service, open `http://admin.localhost:8080/#/settings`
(or the migrated port), connect an authorized wallet and sign in.
Then enroll and verify the replacement SSH/sudo `username:password` before enabling
deployment. Normal Settings saves require a signed Admin wallet session, not a password. Existing balances,
In setup mode, an invalid or missing legacy host fingerprint is archived but left
unset in active Settings when no SSH credential is imported. Re-enrolling the
credential pins the key after successful SSH/sudo verification; no manual
fingerprint entry is required. Existing pins remain enforced.
New Windows bootstrap/key and migration-backup files have inheritance removed
and access granted only to the account running initialization. Existing balances,
profiles, domain data stores, signing identities and legacy vault journals are
preserved, not regenerated or relocated. Linux accounts remain OS-managed.
Runtime changes require typing `APPLY RUNTIME SETTINGS`, wallet approval and a
service restart. Back up data and keys before changing ledger paths, authorities
or reserve mode; enabling live reserves can allocate funds on restart.
The system database location is fixed to avoid a configuration-path bootstrap loop.
Only the external bootstrap/key location remains outside the database; operating
system environment such as `PATH`, `HOME` and `NODE_ENV` is not application config.
Application process environment no longer overrides saved configuration.
Startup refuses leftover application environment variables too. Export existing
service-manager values to a private migration file and remove those overrides
after migration. Use `--env-file <absolute-path>` for a real shared environment
file (not a symlink); `--bootstrap-file <absolute-path>` selects the existing
bootstrap. PM2 may retain old environment values: recreate the service from its
ecosystem file without those overrides after stopping the writer.
Binding port changes also need a reviewed deployment to update Nginx's upstream
and health checks. Nginx deployment supports loopback or wildcard `HOST` bindings.

**Deploy all sites** generates an expiring, digest-bound review plan before SFTP
uploads the release and SSH launches `scripts/deploy-release.sh`. Enable deployment
in Settings only after reviewing the target, certificate email and
prerequisites. The SSH account must own the deployment directory and have sudo
rights, or be root. Root password login must already be permitted; SSH policy is
never relaxed. The script provisions Node 24 when absent, PM2, Nginx and Certbot on
Ubuntu/Debian. Let’s Encrypt requires public DNS and ports 80/443 for every host.

All sites default to the shared server. To use different root passwords for
`featheral.com` and `db.featheral.com`:

1. In shared **Settings**, set SSH host `featheral.com`
   and `root:<shared-server-password>` (or just the password), certificate email
   and deployment directory. Sign and save the connection.
2. Select **db.featheral.com → Server & service settings → Separate server**.
   Set URL `https://db.featheral.com/`, SSH host `db.featheral.com` (or its IP),
   and its own `root:<db-server-password>`. Sign and save; each server key is pinned automatically.
3. Point DB's DNS A/AAAA records to the DB server; keep the other hosts on the
   shared server. This workflow does not modify your DNS provider's records.
4. In **Settings → Deployment**, review both targets/hostname lists, enter the approval
   phrase and sign. Both servers receive the **same ZIP** of Git-tracked
   working-tree files (tracked edits included; untracked files excluded), plus
   the published CMS snapshot. Each connection uses its own encrypted credential.

The DB target deploys first; the shared Admin target deploys last. Nginx/TLS and
the gateway expose only the hostnames assigned to each target. DB-only startup
serves the DB site and `/api/v1/db/*`, without starting Gold/Dollar/World writers.
A fresh DB-only server can initialize empty **staged** journals; this does not
migrate existing application data or make the remote journals authoritative.
Other separate service servers require preconfigured financial readers and
disabled Gold reserves; deployment refuses to start duplicate financial writers.
Separate assignments apply to whole hostnames, not hosted-site paths. Sites
using the same SSH server should remain on Shared rather than duplicate targets.

The archive records its Git-tracked inventory so later Admin deployments from
an extracted release still exclude newly introduced/untracked files, without
shipping `.git`. Status records each target's verified/failed outcome. A failed
target stops the batch; previously verified servers are not rolled back across
servers. Never retry a partially completed rollout without reviewing its logs.
Shell scripts use LF line endings in both the ZIP and uploaded installer so
releases prepared on Windows also run on Linux.

Before the **first** deployment, restore a consistent **offline backup** into
`<target>/shared/data/` (including the private system database, original keys,
ledgers and game saves) and `<target>/shared/cms-data/`. Provision the original
external bootstrap and encryption key separately on the target. Migrate legacy
`<target>/shared/.env` before deployment; releases do not load or symlink it. Private
databases, media, keys and credentials are not uploaded or committed. Deployment
stops when Settings/private-state prerequisites are missing; it never creates a
replacement economy. This requirement applies to full-stack/reader servers;
DB-only servers need no copy of financial keys or shared root credentials.

Admin **Server profile** (`#/server-profile`, old `#/server-users` alias) browses
Linux accounts with wallet approval, search and pagination, without exposing
password/GECOS fields. Root-password changing has been removed completely; old
change/challenge/status endpoints return 404. See the
[server-account workflow](services/cms/README.md#linux-server-accounts).

SSH launches the setup through a single remote `featheral-deployment` systemd job, so restarting CMS during self-deployment does not terminate setup or permit concurrent remote jobs. CMS records status locally; if its process restarts mid-deployment, it reports that the result is unknown and directs the operator to inspect `systemctl status featheral-deployment` and the deployment log before retrying.

The script runs locked npm installs, ABI export and the World build; starts **one**
writer on the shared server through `npm start` (DB-only targets use the isolated
DB entry point); saves PM2 state/startup; validates Nginx and configures
HTTPS. Before health checks, it saves PM2 state and ensures the persistent
`pm2-<ssh-user>` systemd service is running. On first installation or recovery of
an unmanaged daemon, it stops that daemon before the service resurrects the saved
processes, preventing duplicate writers and keeping the app alive after the
temporary deployment job exits. It applies the upload/body limit and proxy timeout from the reviewed Settings
revision. `certbot.timer` renews certificates automatically; a deployment hook
validates and reloads Nginx after renewal. Existing unrelated virtual hosts are
preserved. Failed activation restores prior code/configuration, **not** monetary
data. Inspect `<target>/shared/logs/deployment.log` and the remote systemd job before
retrying failures/timeouts. Local timeout/limit changes apply after save; Nginx
changes require another reviewed deployment. Feature-specific limits may be lower.

### File-ledger migration (staged)

`db.featheral.com` (`db.localhost:8080`) is the new database-service host.
Its in-process database API lives in `services/database`. It centrally opens and
closes the built-in Node SQLite connections used by existing domain modules;
no third-party database driver is used. Public `GET /api/v1/db/status` reports
the migration stage without exposing records.
Admin **Database journals** verifies and inspects metadata for per-token and
per-site journals through `/api/database`. Vault records are excluded from
all browse endpoints. Token folders map FTHG/FTH$/FTHX/FTHS to
`tokens/fthg`, `tokens/fth-dollar`, `tokens/fthx`, `tokens/fths`;
site folders use `sites/<hostname>`. Each stream uses
`<year>/<UTC-date>/<16-digit-sequence>.json` under `data/file-ledgers`
(override with `DB_LEDGER_DIR`). Legacy credential ciphertext remains in the
separate `internal/vault` stream; new operations credentials live in Settings.

This is **not a completed native-file site-storage migration**. Existing Notes,
CMS, App, Silver, telemetry and World stores remain SQL-backed, but connections
are routed through the shared in-process DB API. The document-journal API is
available for domains that can safely migrate. No reset or signing-identity
replacement has run. Generic journal writes are deliberately not exposed as
public financial APIs. Existing database files and production records are
preserved.

Journal transactions are hash-chained, revision-checked, retry-idempotent and
atomically published per namespace. They detect corruption and missing middle
records, but cannot detect a fully rewritten/truncated history without a
separately trusted checkpoint. Each commit replays the stream; production-size
indexes and cross-stream atomic settlements remain migration prerequisites.
Files are flushed before publication; directory metadata is also flushed on
Unix. Windows development does not promise power-loss durability of directory
metadata. A stale `.writer.lock` fails closed after interruption: stop all
writers, verify the journal and inspect its recorded PID before an operator
removes that exact lock. Do not delete journals to resolve a lock.
Use one gateway/writer, preserve the ledger root across releases, and back up
the encryption key separately with OS access controls (0600 on Unix; restricted
ACLs on Windows). Losing it makes stored credentials unrecoverable; wallet
signatures authorize use but cannot reconstruct the encryption key.

Validation: `npm run test:db` and the focused CMS deployment/server-users tests.

### Migrated CMS, X and Exchange

The former `qporn.eurasiahosting.com` project was moved (not copied) into `services/cms/`, including its dependencies and entire `data/` directory. The locked former root was left empty. Media, imported snapshots, CMS edits, wallets, analytics and exchange data retain their original data-set folders. These private data files remain ignored by Git; retain them when deploying or backing up the application. Do not replace them with empty sample data.

`npm install` installs the CMS workspace alongside foundation dependencies. `npm start` builds World and runs all sites through the gateway on port 8080. `npm run test:cms` runs the migrated tests. `npm run start:cms` optionally runs just the CMS service on port 5178; do not run both processes against the same CMS data simultaneously.

Admin requires signed wallet access from the origin or Dollar reserve wallet, including on `admin.localhost`. No password or localhost access bypass is accepted. Production uses HTTPS; only loopback `admin.localhost` permits HTTP. Public preview links retain the local port and require CMS access. The gateway routes registered CMS sites (including existing sample sites and newly registered hosts); Featheral subdomains also have `.localhost` aliases. Adding sites does not configure DNS or TLS. Existing Foundation, Gold, Dollar and World hosts take precedence over CMS registrations.

The X age gate and disabled live syncing are preserved. **Exchange assets, including its demo FTH$, are local simulations, separate from the Foundation Dollar ledger, with no real funds, deposits or bridge.** See the [CMS documentation](services/cms/README.md) for site management, content and API details.

Unknown hosts serve the Foundation site. World serves Getting started at `/`, exploration at `/explore/`, and settlement, federation and other game pages at their root paths. Legacy `/play/` redirects to `/explore/`; `/play/settlement/` and other deep links redirect to their root equivalents. `/about/` and `/play/about/` redirect to Getting started. Query strings are preserved. `npm start` builds `sites/world.featheral.com/play/` and runs its APIs in the gateway process. Shared assets live in `shared/` and are served at `/shared/` on every host.

Media serves the social feed, profile setup at `/#/setup`, guide at `/#/guide` and database explorer at `/ledger/`. Old World social hash links and `/ledger/` redirect to Media; old docs/news placeholders redirect to the Media guide/feed. `/api/v1/media` is canonical, while `/api/v1/world` remains compatible. Existing feed databases, signed messages, user profiles and financial records are not renamed or reset. Public deployment requires DNS and a reviewed TLS/deployment plan covering `media.featheral.com`.

Wallet connection behaves the same on every site: page load only silently restores an already-authorized wallet for that origin, unless you previously disconnected. Connecting on another Featheral site never triggers an automatic permission prompt; click the wallet icon to authorize a new origin. The disconnect preference is shared across sites through a parent-domain cookie.

The shared header has one combined wallet/avatar button, with no separate balance chip. It shows a profile icon when disconnected and the account avatar when connected. Use it to connect, inspect balances or disconnect. World profile/avatar editing is inline on `/#/setup`, not in the wallet popup; other sites retain the shared editor. Play links to this main-page editor and keeps wallet controls inside its account-avatar menu.

Play uses World's canonical username/avatar and the same profile editor, not a separate nickname. Choose **Use World profile in Play** once to sign a session-specific link; subsequent chat requests read the authoritative World username. Changes propagate between World and its Play popup, with a refresh on window focus. Disconnecting or changing wallets removes the previous chat link without moving game saves or balances. Gameplay remains available without a wallet. The site server supplies `WORLD_PROFILE_API_ORIGIN` to the private game API automatically.

When multiple wallet apps are installed, the shared wallet icon opens a wallet-app picker on all sites, including admin pages. Apps are discovered through EIP-6963, with a legacy injected-provider fallback. With multiple apps, choose one explicitly before connecting; with one app, already-authorized accounts can restore silently. Profile/game signatures, FTH$ transfers, and Ethereum transactions all use the selected app.

World home defaults to Getting started; no wallet or profile is required to read it. Media defaults to its community feed and provides optional inline avatar/username setup, social Explore/search, Profile and the Media guide. Draft profile inputs survive same-wallet refreshes and feed/guide navigation. Wallet/account changes clear another wallet's draft and are revalidated before publication.

The social layout is centered within a 1,280px desktop container, with a 600px feed between navigation and suggestions. The feed fills its grid column rather than inheriting the shared marketing-page margins; tablets hide suggestions, and phones use a full-width feed.

Gameplay links use ordinary browser navigation to World rather than a separate popup launcher.

The merged World landing combines the game introduction, first three steps, optional profile setup, community entry and read-only public totals. The guide explains resources, weather, finite reserve funding and privacy without leaving the main site. Content panes do not repeat sidebar menu titles; feed tabs, search context and profile/post back controls remain available.

World's main/social page is English. Play defaults to English; explicit language URLs and saved language preferences take precedence, and Korean remains selectable in Play account settings. The legacy static About fallback retains its language footer.

World game pages share a responsive navigation rail, compact resource header, and consistent panel styling. Explore and Settlement keep fullscreen canvases: contextual information sits in a left inspector and weather in a top-right overlay, with map controls and settlement actions in separate lower lanes. Nearby/visitor chat starts collapsed in the bottom-right and stays bottom-aligned when expanded, above mobile navigation; Escape closes it and visitor-chat links expand it. Chat and settlement tasks use one workspace at a time, preserving the chat session/draft without resizing the canvas. On smaller screens, the open workspace temporarily replaces the inspector and map controls; expanded chat also hides the settlement dock to avoid overlap. Closing chat restores the dock, and bottom navigation remains accessible.

Explore uses a compact, non-scrolling action menu. Wider/taller screens include settlement stats, inventory, and tile details; small screens prioritize action grids and management links. Short layouts omit inline cost details; spending confirmations still show costs before submission. Detailed information remains available in Settlement.

The chat bubble shows an unread badge for new messages from other players in the active channel while chat is hidden or scrolled away from the latest messages. Opening chat scrolls to the latest messages and clears the badge. Initial history and your own messages do not count; the badge displays `99+` for larger counts. The main Inbox remains available from navigation.

Weather appears in a top-right overlay on Explore and Settlement. Signed, color-coded production, recruitment suitability, and water-demand changes remain visible while collapsed; expand Expected effects for descriptions from the shared climate model. These describe current conditions, not guaranteed yields: gameplay uses daily or weekly averages. On phones, expanding the description temporarily hides the inspector to prevent overlap.

Gold's reserve admin is publicly linked in its header; token writes remain role-gated. Other shared headers show Admin only for wallets recognized by that site's console: either configured FTH$ or fixed project wallet lists on Foundation and Dollar, and the actual `WORLD_MODERATORS` / `FEATHERAL_ADMIN_WALLETS` moderator list on World. Those links hide on disconnect or account change while eligibility is checked. Navigation never replaces on-chain or server-side authorization.

- **FTHG** is the Ethereum Mainnet ERC-20 `0xBa658127d93B17E577E1B8e8995cAB3aE7d7C665` (source: `contracts/FeatheralGold.sol`). Its balances and history are read only from Ethereum; there is no local FTHG ledger.
- **FTH$** is a layer-3 currency with its own native block ledger (see [FTH$ layer-3 ledger](#fth-layer-3-ledger)).

## FTHG site and admin

- `sites/gold.featheral.com/` is the FTHG landing page. It shows live Mainnet statistics without a wallet: supply, estimated USD value, holders, transfers, supply distribution across the fixed wallets, the FTHG/FTH$ rate and bridge status, recent transfers, and top holders. Gold uses a labeled temporary **1 FTHG = $0.01** estimate until an Ethereum Uniswap estimate is available.
- `sites/gold.featheral.com/admin/` is a static admin for managing that existing contract. Read-only stats use a public Ethereum Mainnet RPC without wallet connection; transactions require an authorized wallet. The contract address is fixed, and there is no token deployment workflow.
- The admin artifact contains the contract ABI and verification metadata only; it does not contain deployment bytecode.

The Gold admin is a public reserve dashboard: separate origin and FTH$ backing wallet flows, confirmed in/out since reserve initialization, OFF-SYNC incoming/outgoing obligations, immutable allocation cap, redeemable backing, and locked redeemed FTH$. Actual FTHG holdings are verified separately at one finalized Ethereum block. These wallets hold FTHG on Ethereum; FTH$ remains in the Dollar ledger.

`GET /api/v1/gold/reserve/activity?limit=20&cursor=height:index` pages the sealed reserve journal newest first (maximum 100 records, 2,000 transactions scanned per request). Follow `nextCursor` even on a filtered empty page. Off-chain obligations, treasury-only circulation and confirmed Ethereum receipts are distinct records; receipts reconcile pooled totals, not individual historical allocations. Journal and receipt links provide evidence. FTH$ display rounds to at most two decimals; exact base units remain available in amount tooltips.

Gold overview, conversion and admin share a responsive header. Foundation, Dollar and World retain accessible tabbed consoles and shared wallet controls. World moderation is checked against the service's actual moderator list and requires a signed, confirmed action; deleted posts cannot be restored by hide/unhide controls.

The origin `0xD2f1Be8414472E9f436B65e91A2B8dFDa418287c` and backing reserve `0x706CCb6109046a6a4A08dbAD4444A46408703ccb` are pinned by the ledger policy. Gold admin cannot change these wallets, supply or the signed reserve pricing policy.

Essential token safety retains pause/resume (`PAUSER_ROLE`), metadata publication (`DEFAULT_ADMIN_ROLE`), blacklist checks/changes (`COMPLIANCE_ROLE`) and safety-role checks/grants/revocations (administrator only). Writes require the actual corresponding on-chain role on Mainnet, explicit confirmation, simulation and wallet signing. Fixed project-wallet membership alone grants no write permission. Removing the last administrator can permanently disable administration. Legacy exchange, dynamic-bridge controls, DEX/liquidity tools, listing planning and local branding/settings were removed from Gold admin.

Conversion explains eligibility and previews amounts before free message signatures. World initial allocation funds markets, not personal wallets. Reconversion only unlocks existing redeemed currency after a confirmed return; redemption requires confirmed uncommitted backing. Manual sync previews actual balances and verifies existing receipts with a prominent Mainnet warning; it never submits Ethereum transfers.

## Run

1. Use Node.js 24 or newer (`node --version`).
2. `npm install`
3. `npm ci --prefix sites/world.featheral.com/play`
4. `npm test`
5. Initialize the external bootstrap with `node scripts/init-settings.js`, then configure shared SSH/deployment and Admin access in Admin **Settings**. Configure common service options and optional independent URL/SSH server assignments from each site's **Server & service settings**, then apply assignments through reviewed **Deployment**. The compact UI preserves low-level values; use the protected Settings API or offline migration for advanced configuration. Do not create an environment file. `npm start` compiles the source, exports ABI-only artifacts for both contracts, builds the Featheral game, and serves the ecosystem sites plus their APIs at the local URLs above (change **HTTP port** under advanced server settings, then restart; `*.localhost` resolves to 127.0.0.1 in current browsers). For production, set **Public World origin** in World's service settings to the exact public HTTPS origin of `world.featheral.com`. The API defaults to `FTH_LEDGER_MODE=unconfigured`, which runs a standalone local FTH$ writer under `data/fth-ledger/local-node/` for development. Existing installations must migrate configuration offline first; startup refuses a leftover `.env`.
6. Browse public contract stats and wallet balances without connecting. To administer either contract, connect a wallet with its relevant on-chain role on Ethereum Mainnet using the wallet icon in the admin header. There is no network selector: the site always uses Mainnet and asks the wallet to switch to it on connect. Transactions are signed by the connected wallet; the admin/API does not handle wallet private keys.

Run `npm run abi` to regenerate the ABI-only admin artifacts after contract source changes. The existing FTHG token has no deployment workflow; the separate, explicitly authorized game-bridge deployment is documented below.

## Dynamic game bridge and API

### API ownership and World wallet

- `services/gold/` owns Ethereum FTHG, bridge and staking reads: `/api/v1/gold/stats`, `/wallets/:address`, `/quote` and `/rpc`. RPC is read-only, rate-limited and bounds log scans. Ethereum writes are signed by the selected browser wallet, never by World.
- `services/notes/dollar.js` owns `/api/v1/dollar/*`, including confirmed bridge settlement, transfers, balances, profiles and the native journal. `/api/v1/dollar/stats` works without Ethereum connectivity. Legacy `/api/v1/*` paths remain compatible.
- Dollar also owns `/api/dollar/game/*`: gameplay state, spending, market reserves and escrow. World owns sessions/chat under `/api/session` and `/api/chat*`, and consumes the two funding APIs via same-origin gateway namespaces. There is no separate World currency ledger.
- In Account, **Use wallet for gameplay** signs an origin/session/time-bound authorization. The settlement uses that wallet's actual available FTH$ balance. Disconnect, account switch, or **Stop wallet gameplay access** revokes the current browser capability; signing again restores the same settlement. Other authorized browser sessions remain independent.
- FTH$ displays at most **two decimals**. The journal retains 18-decimal integer amounts; gameplay retains four decimals, leaving smaller wallet dust untouched. Signed transfer amounts are never rounded for display.
- New players, the Dollar journal and all resource/item pools start at **zero**. Pools require explicit, permanent donations of existing FTH$ and owned assets; donations do not create liquidity shares or withdrawal rights. Gameplay costs transfer existing FTH$ to the system treasury without changing supply; trading transfers it between wallets, escrow and pools.
- Signed `GAME` journal entries enforce conservation and available-balance checks. SQLite records a durable settlement outbox before journal commit. Failed settlement blocks further fund mutations until recovery; restarts replay it exactly once.
- Game state and the authorized Ed25519 key live in `data/dollar-game/` (`DOLLAR_GAME_DIR` override). Back up the database, key and Dollar journal together. A legacy simulated Gold/bank database is explicitly refused, not silently migrated or credited. Reader nodes forward gameplay/session/chat requests to the Dollar writer, without creating a local funded game.

Local data reset does not reset Ethereum contracts. Public settlement refuses receipts predating the journal's genesis; historical recovery requires the authenticated service flow. Never discard a live production journal or re-index previously redeemed bridge history without a coordinated recovery plan. Bridge deployment, actual reserve deposits, configured writer signing and the authorized on-chain game clock remain operator prerequisites; no Mainnet transaction is sent by startup.

`contracts/FthgGameBridge.sol` is a separate exchange/staking contract; it does not replace, modify, mint, or burn the existing FTHG token. Both fixed FTHG source and FTH$ reserve addresses receive `DEFAULT_ADMIN_ROLE`, `TREASURY_ROLE`, and `PAUSER_ROLE` on the new bridge. A separately supplied game-service wallet receives `GAME_SERVICE_ROLE`. The existing FTHG contract still has its original fixed-rate bridge; it is labeled legacy and is not the dynamic curve.

The dynamic bridge begins at a spot rate of 1 FTHG : 1,000 FTH$. It uses a constant-product reserve curve in 18-decimal units and applies price impact to quotes. Pool initialization requires FTHG already transferred on-chain to the bridge and an FTH$ game-ledger budget exactly matching the opening ratio. The admin UI can deposit FTHG, initialize the pool, explicitly sync later FTHG deposits into the curve, add an approved game-ledger budget, change the base APR, grant the game-service role, and pause new trades/stakes. No source-wallet migration or funding occurs automatically. FTHG total supply, source-wallet balance, bridge custody, curve reserves, FTH$ budget, and user FTH$ ledger balances are reported separately.

Staking locks FTHG principal for 1, 2, 5, 10, 20, or 30 authoritative game-years. The initial base APR is 6% and rewards use simple interest; the bridge locks its current spot quote when each stake is created. Reward budget is reserved at stake time and FTH$ is credited only after a confirmed mature-claim event. A game-service wallet advances the on-chain game-year monotonically. Mature stake claims remain available while new bridge activity is paused. FTH$ is an off-chain game balance, not an on-chain token, fiat deposit, or USD redemption promise.

### Dollar liquidity and staking admin

Open `dollar.featheral.com/admin/` (locally `http://dollar.localhost:8080/admin/`). Bridge statistics are read directly from Mainnet at one block, including custody, curve reserves, unaccounted deposits, locked principal, APR, and game clock. If no deployed bridge or ABI is configured, transaction controls remain disabled and the error is displayed.

- Deposit FTHG from the selected wallet, then initialize once at the exact 1:1,000 budget ratio or explicitly sync later deposits, excluding locked staking principal.
- `TREASURY_ROLE` can initialize/sync reserves, add approved FTH$ budget, and set base APR (0–100%, two decimal places). Budget changes do not mint or credit wallet balances.
- `PAUSER_ROLE` can pause/resume new activity; `DEFAULT_ADMIN_ROLE` can grant `GAME_SERVICE_ROLE`. Only `GAME_SERVICE_ROLE` can initialize/advance the authoritative game-year; this is irreversible and may mature stakes immediately.
- Personal staking and claims are in `/wallet/#staking`, not admin. Any connected Mainnet wallet can stake its own FTHG with an exact approval and supported term, preview the reward, inspect a stake ID, and submit a mature claim. Claims return principal and attribute FTH$ rewards to the recorded owner, not the submitting wallet. FTH$ credit still depends on confirmed event indexing by the ledger.
- Transactions require explicit confirmation, are simulated before sending, and link to the Ethereum receipt. A receipt is not proof of ledger settlement. The existing bridge has no admin reserve-withdrawal method; no withdrawal control or new contract behavior is added.

The Gold API verifies successful Ethereum Mainnet bridge receipts and the configured confirmation count (12 by default). **FTH$ issuance is closed:** Dollar rejects new conversion and staking-reward credits, while existing confirmed journal entries remain replayable/idempotent. Wallet conversion, new staking and reward-claim submissions are disabled before requesting wallet signatures. This does not pause or modify any deployed Ethereum contract; do not submit those operations externally expecting a Dollar credit. Existing staking principal and maturity remain inspectable on Ethereum. FTH$ redemptions remain a service-authenticated reserve/on-chain-execution/confirmed-settlement flow, not a public wallet withdrawal form. Private signing keys remain in their owning service or wallet, not World.

`GET /api/v1/dollar/stats` exposes the closed monetary policy, current supply and system treasury account/balance without depending on Ethereum RPC. `GET /api/v1/gold/health` checks only service availability; `/api/v1/gold/stats` checks Ethereum and reports upstream failures explicitly. Ethereum HTTP requests time out after eight seconds. World gameplay uses `/api/dollar/game/*`; sessions and chat use `/api/session` and `/api/chat*`. All these routes are composed by `scripts/serve.js`.

In the default live mode, liquidity funding uses existing spendable FTH$ and owned assets only, subject to the existing 10,000-lot action limit and safe reserve limits. The constant-product curve increases marginal buy prices as demand depletes asset reserves. A zero-supply live journal cannot fund liquidity from its opening reference rate.

### Finite-origin reserve and live activation

Gold is the sole reserve/conversion engine; Dollar journals its signed authorizations and owns wallet, treasury and market balances. World never issues currency or submits Ethereum transactions. No bridge contract deployment, staking rewards or interest is required for this model.

- Reserve trading uses the append-only **origin-linear-v1** policy: spot price is `10,000 × (1 + netAllocated / initialOriginCap)` FTH$ per FTHG. Net allocation is initial allocations plus reconversions minus redemptions, including pending obligations so demand cannot reuse uncommitted origin Gold. Prices are 10,000 initially, 11,000 at 10%, 15,000 at 50%, 19,000 at 90%, and at most 20,000 at full allocation. Returns reduce the price; this is not a timed or guaranteed increase.
- Quotes integrate the linear curve over the entire trade, using integer base units and conservative rounding. Signed conversions and redemption memos bind the exact quote to the ledger and reserve position; changed quotes require fresh authorization. Wallet/Exchange valuations, Gold and World use the same spot reference. Existing journal entries and immutable market-bootstrap accounting retain their historical **1,000 FTH$/FTHG** rate; no historical amounts, supply, balances or deployed contracts are rewritten.
- On the next local server startup, a Gold-authority-signed `pricing-policy` journal entry activates this policy for an initialized positive cap; replay preserves it. Zero-cap reserves remain exhausted. The separate deployed constant-product Ethereum bridge is unchanged and is not this origin curve.
- Initialization verifies the origin wallet's actual holdings at an Ethereum finalized block, also enforcing the configured confirmation minimum. That balance becomes an immutable initial allocation cap. Later deposits never enlarge it.
- Each eligible non-collectible market receives at most **one** bootstrap on first quote/trade/collect-and-sell use by an authenticated settled player. Targets are pinned in the Dollar genesis: at most 10,000 accounting lots at the configured base price. Gold spends the system treasury first, allocates origin FTHG only for the deficit, and may fund fewer whole lots if the finite budget is insufficient. No automatic refills or personal starter grants occur.
- Gold allocations are pending off-chain obligations, **not actual FTHG transfers**. The market's FTH$ allocation and reserve commitment share one atomic journal transaction; its resource seed is applied once in the recoverable game SQLite mirror. Back up both stores and their signing keys together.
- FTH$ → FTHG requires wallet authorization from one of the two pinned wallets and enough confirmed, uncommitted backing. Redeemed FTH$ is **locked in redemption escrow**, not burned or made available for market funding. After FTHG has actually returned to origin, a source-wallet-signed reconversion can unlock those same FTH$; it creates no new supply. Exhaustion ends initial issuance permanently.
- `/api/v1/gold/reserve` exposes the cap, allocations, pending transfers, confirmed redeemable backing, locked FTH$, pricing policy and 18-decimal spot rate. `/reserve/quote?direction=fthg-to-fthdollar&amount=...` (or `fthdollar-to-fthg`) returns exact base-unit output and the quote authorization commitment. `/reserve/sync-plan` adds actual finalized wallet holdings. `/reserve/reconcile` requires `{txHash, logIndex, issuedAt, signature}` signed by the origin or backing wallet, bound to the ledger genesis and a fresh timestamp; it verifies finalized, canonical token Transfer receipts between the pinned wallets, with per-log deduplication. `/reserve/redeem` and `/reserve/convert` record signed off-chain obligations. Actual Ethereum transfers remain explicitly authorized by these administrators, never automatic.
- Gold's `/conversion/` page prominently warns about Mainnet gas and irreversible token movements. **Sync previews and receipt reconciliation only:** this isolated deployment never submits Ethereum transactions. Test balances are not live redeemable money.

Opt in with `GOLD_RESERVE_MODE=isolated`, `HOST=127.0.0.1`, a separate `PORT`, local `APP_ORIGIN`, and `GOLD_RESERVE_TEST_DIR` pointing to a named empty directory under `data/reserve-tests/`. Startup marks the directory, creates separate Gold/game keys and journals, and refuses live directories or symlinks/junctions. Initialization failure exits nonzero. `GOLD_RESERVE_MODE=disabled` remains the default; no live journal is migrated or funded by these tests.

Production rollout requires separate authorization, a reviewed genesis or append-only activation policy/cap, secure key custody and backups, and a separately approved Mainnet synchronization workflow. A finite supply does not guarantee stable prices or indefinitely sufficient liquidity. Pools can deplete; exhausted/unaffordable markets honestly show no quote rather than manufacturing funds.

With explicit operator authorization and an offline backup, `GOLD_RESERVE_MODE=live` activates an existing **unused, zero-supply** Dollar writer. A `GOLD_POLICY` block, signed by its existing genesis-authorized game key, pins the new Gold authority and market targets without rewriting genesis or resetting settlements. Previously issued ledgers are refused rather than silently migrated. Gold keys persist under `data/gold-reserve/`; back them up with the Dollar journal and game database. Restarting replays the policy and preserves the cap. Live mode automatically funds markets on first eligible use; players obtain FTH$ by selling owned resources, not by receiving grants. Ethereum submission remains disabled, and redemption still requires confirmed backing.

FTH$ balances live in the native layer-3 ledger described below. Configure exactly one `FTH_LEDGER_MODE=writer`; other nodes use `FTH_LEDGER_MODE=reader`. Service authentication, ledger signing keys, node URLs, RPC, bridge address, CORS origins, ledger directory and confirmation count are managed through the protected Settings API (common options also appear in site-level settings) and encrypted in the private system database. Offline migration canonicalizes legacy `TOKEN_LEDGER_*` names and rejects conflicting values. Startup and the standalone bridge command use database configuration, not `.env` or process overrides. The entire `data/` directory remains ignored by Git.

To deploy the separate bridge, configure `TOKEN_API_RPC_URL`, `TOKEN_API_GAME_SERVICE_ADDRESS`, and `BRIDGE_DEPLOYER_PRIVATE_KEY` through the protected Settings API or offline migration, then run `npm run deploy:bridge`. Review the deployment and its constructor addresses before signing; this command sends a permanent Mainnet transaction and is not run by `npm start`. After deployment, configure `TOKEN_API_BRIDGE_ADDRESS`, set the writer's `FTH_LEDGER_SIGNING_PRIVATE_KEY` (and each reader's `FTH_LEDGER_WRITER_PUBLIC_KEY`) plus the game service keys, start the API, deposit only the desired actual FTHG reserve, and initialize the pool with the matching FTH$ budget already approved by the game ledger. Use `npm run generate:service-keys` to create Ed25519 service keypairs; register public keys in `TOKEN_API_SERVICES_JSON` and keep private keys in service secret managers. Do not expose a writer directly to the internet; terminate TLS and configure firewalling, request-rate limits, monitoring, and backups at the deployment edge.

## FTH$ layer-3 ledger

`services/fth-ledger/` is a small, dependency-free block ledger owned by Featheral. It settles to Ethereum only through the bridge contract's events; it is not an EVM chain and has no gas.

- **Accounts.** Every wallet owns one account: its address left-padded to 32 bytes. Game-only accounts may use any other bytes32 id.
- **Transactions.** `GENESIS`, historical `CREDIT` (new ordinary issuance is closed), `TRANSFER` (wallet-signed), legacy `RESERVE`/`SETTLE`/`RELEASE`, historical `PROFILE`, `GAME` (conserved gameplay transfers), `GOLD_POLICY` (signed zero-supply live activation), and `GOLD` (authorized finite allocation/conversion/sync). New profile updates are managed by the DB API, not this ledger. A finite-reserve policy rejects ordinary `CREDIT` even during replay. Historical burns in older journals replay unchanged; new gameplay payments go to the system treasury. Amounts are 18-decimal integer strings; IDs and Ethereum transfer logs are idempotent.
- **Transfers.** The sender signs a readable `personal_sign` message (from, recipient, amount, base units, nonce, memo, issue time). Nonces are strict per wallet (`nonce` = last + 1), signatures expire after 10 minutes, and transfers cannot exceed the available (unreserved) balance. Replicas re-verify every signature when importing blocks.
- **Blocks.** The writer applies transactions immediately and seals pending ones into a block every `FTH_LEDGER_BLOCK_INTERVAL_MS` (1 s by default). The block hash is SHA-256 over the canonical JSON of height, time, previous hash, and transactions. With `FTH_LEDGER_SIGNING_PRIVATE_KEY` set, the writer adds an Ed25519 signature of the hash.
- **Storage.** Blocks are appended as one minified canonical JSON line each to daily files: `<FTH_LEDGER_DIR>/YYYY/YYYY-MM-DD.jsonl` (UTC). Files are append-only; `GET /api/v1/fth/files` lists each file's block range, size, and SHA-256. On startup the node replays them, verifying every hash link, and truncates a partially written last line. Back up or distribute the ledger by copying closed daily files.
- **Replication.** One writer, any number of readers. Readers poll the writer's `GET /api/v1/fth/sync?from=<height>` with `FTH_LEDGER_UPSTREAM_URL`, verify hash links and (with `FTH_LEDGER_WRITER_PUBLIC_KEY`) the writer signature on each block, re-validate every transaction, and write the same daily files locally. Profile and transfer writes sent to a reader are forwarded to the writer.

Public endpoints (no wallet needed):

| Endpoint | Returns |
| --- | --- |
| `GET /api/v1/fth/stats` | ledger summary, node info, latest blocks and transactions, top holders |
| `GET /api/v1/fth/blocks?before=&limit=`, `/blocks/<height>` | blocks with their transactions |
| `GET /api/v1/fth/transactions`, `/tx/<hash>` | transactions with their block receipt |
| `GET /api/v1/fth/accounts/<address or account id>` | balance, reserved, nonce, history |
| `GET /api/v1/fth/rich-list` | holders by balance |
| `GET /api/v1/fth/search?q=` | resolves a height, tx hash, address, account id, or @username |
| `GET /api/v1/fth/files`, `/files/YYYY/YYYY-MM-DD.jsonl` | daily file manifest and raw files |
| `GET /api/v1/fth/sync?from=&limit=` | block feed for readers |
| `POST /api/v1/fth/transfers` | submits a wallet-signed transfer |

`GET /api/v1/stats` and `GET /api/v1/wallets/<address>` include the same FTH$ data alongside the FTHG/bridge view.

## Wallet balance and profiles

On every site, clicking the wallet icon connects a wallet, switching it to Ethereum Mainnet if needed. Once connected, the icon shows the wallet's avatar and a chip beside it shows the username (or short address) with the FTHG and FTH$ balances (FTH$ first on the wallet page). Clicking either opens a panel with:

- the FTH$ ledger balance (and any amount reserved for a pending withdrawal), the FTHG and ETH balances read from public Mainnet RPC, and the total estimated USD value;
- the wallet's FTH$ game account ID, with a copy button;
- a username field (3–24 characters: letters, numbers, `_`, `.`, or `-`; unique regardless of case);
- an avatar upload. The browser crops it to a square and compresses it to at most 40 KiB as WebP or JPEG. Wallets without an avatar get a generated identicon.

Saving asks the wallet for a free `personal_sign` signature, not a transaction. The API (`POST /api/v1/profiles`; public read: `GET /api/v1/profiles/<address>`) checks that:

- the signature recovers to the address;
- the signature is less than 10 minutes old;
- the update is newer than the stored profile;
- the username is not already taken;
- the avatar is a real PNG, JPEG, or WebP. SVG is rejected.

New profile updates are stored by the in-process DB API in its wallet-profile SQLite store, separate from the FTH$ currency ledger. The API still verifies each wallet signature and enforces timestamp freshness and username uniqueness; read nodes forward writes to the configured writer. Each IP address is limited to 10 profile updates per minute. Profiles are public. Existing `PROFILE` transactions remain verifiable as legacy history, but new profile entries are no longer accepted by the currency ledger.

The small exit icon at the bottom-right of the panel disconnects the wallet. It asks the wallet to revoke the site's account permission (`wallet_revokePermissions`, where supported) and stores the choice in `localStorage`, so the page does not reconnect automatically until the wallet icon is clicked again.

## Featheral Dollar site

`sites/dollar.featheral.com/` is the FTH$ home. None of it requires a wallet to browse:

- **Landing** (`/`): live ledger statistics (supply, holders, height, transactions, transfer volume, bridge credits, withdrawals, price estimate), latest blocks and transactions, top holders, how FTH$ moves, and the storage/replication layout. Data reloads only when **Refresh** is clicked.
- **Wallet** (`/wallet/`): FTH$ balance (available and reserved), FTHG held on Ethereum, and total estimated USD. A connected wallet can send FTH$ to an address, account id, or `@username` (free signature, no gas), copy its receive address, and convert FTHG to FTH$. It also shows the wallet's activity.
- **Explorer** (`/explorer/`): blocks, transactions, rich list, ledger files, and block/transaction/account pages, plus a search box.

Each wallet's FTH$ account ID is its address left-padded to 32 bytes (`ethers.zeroPadValue(address, 32)`). The game uses this as `gameAccountId` when the wallet converts, redeems, or stakes. Valuation uses the live bridge spot rate once the pool is funded, otherwise the 1 FTHG = 1,000 FTH$ opening rate, so 1 FTH$ is about $0.00001 at the $0.01/FTHG estimate.

Converting FTHG to FTH$ is enabled only after the dynamic bridge is deployed and funded. The connected wallet approves FTHG and then calls `convertFthg` with 1% slippage protection and its derived account ID. FTH$ to FTHG withdrawals require an authorized settlement service, because only the game service role can call `redeemFthDollar`; the World interface does not currently offer a withdrawal request.

## FTHG admin

`gold.featheral.com/admin/` exposes public reserve flows and transaction history plus role-gated essential token safety. See [FTHG site and admin](#fthg-site-and-admin) for OFF-SYNC semantics and retained controls.

## Ledger SQL browsing

FTH$ keeps a derived SQLite index (`node:sqlite`, rebuilt from daily block files)
for queries; hash-chained currency files remain its source of truth. World feeds
and wallet profile metadata are stored separately through the in-process DB API,
using Node's built-in SQLite with no third-party database driver. `GET
/api/v1/fth/sql?q=` and `GET /api/v1/world/sql?q=` run one read-only
`SELECT`/`WITH` statement (also `POST` with `{ "query": ... }`); `/sql/schema`
lists tables and columns. Queries run under `PRAGMA query_only`, are limited to
4,000 characters and 500 rows, and reject `PRAGMA`, `ATTACH`, recursive CTEs and
similar. FTH$ retains the historical `profiles` projection for old blocks. The
**SQL** console is available in both the FTH$ explorer and World feed browser.

## Featheral World

`sites/world.featheral.com/` is an X-style social network. The feed (`/`) supports posts of up to 280 characters, replies, reposts, likes, follows, a Following timeline, profiles, search and threads. Social actions are wallet-authorized and persisted as application database records, not currency transactions or blocks. Usernames and avatars come from the DB API wallet-profile store. One wallet signature delegates a throwaway session key for six days, so later posts and likes need no wallet popup.

- Feed database browser: `/ledger/` (actions, database statistics and SQL). The dedicated `ledger.featheral.com` site hosts the FTH$ block explorer at `/explorer/` and a paginated Notes activity explorer for FTHX, FTHS and defined community notes. Notes activity is database-backed and is not represented as hash-chained blocks. The Dollar `/explorer/` URL redirects to the canonical Ledger explorer. Public Notes reads use `GET /api/notes/ledger/currencies` and `GET /api/notes/ledger/:symbol/entries?limit=50&before=<entry-id>`; pages are capped at 100 and use stable descending-ID cursors. API: `/api/v1/world/*`.
- The wallet connection is shared across the ecosystem sites.
- The empty Community feed (`/#/feed`) shows clearly labeled example posts for inspiration only; these are never submitted to the ledger or shown as real activity. Visitors can draft before connecting and use an example to start a blank draft. Drafts stay in memory across feed navigation, are separated by wallet, and are kept after cancelled or failed posting; reloading clears them. Publishing requires wallet sign-in.
- Getting started: `/`; optional profile editor: `/#/setup`; quick guide: `/#/guide`. Legacy About entries redirect to home.

## Admin consoles

Every site has its own console at `/admin/`, with consistent site styling and shared wallet controls. Gold keeps its public reserve admin link visible; its token writes remain role-gated.

| Console | Purpose |
| --- | --- |
| `gold.…/admin/` | Public reserve flows, OFF-SYNC history and essential token safety |
| `dollar.…/admin/` | Dynamic-bridge liquidity, reward policy, service roles and safety; ledger monitoring and SQL |
| `localhost:8080/admin/` (foundation) | Ecosystem status and admin wallet lists |
| `media.…/admin/` (legacy `world.…/admin/`) | Media moderation (hide/unhide posts, suspend/restore wallets) and SQL |

Foundation and Dollar project access uses `FEATHERAL_ADMIN_WALLETS` and configured FTHG project wallets; Dollar also recognizes the fixed bridge project wallets. Gold uses fixed project wallets and on-chain roles. World uses only the service's `WORLD_MODERATORS` / `FEATHERAL_ADMIN_WALLETS` moderator list. The pages only gate what they display; contract roles and server signature checks enforce actual authorization. World moderation is a wallet-signed `MOD` action recorded on the ledger rather than erasing anything. Personal staking and claims belong in the Dollar wallet at `/wallet/#staking`, not admin.

## Notes

- Consider hosting the management API/console behind additional authentication (e.g. IP allowlist/basic auth); on-chain roles are the real access control.
- The $0.01/FTHG figure is an admin reference estimate only. It must not be used in exchange applications as market price, valuation, or evidence of liquidity.
- Creating a DEX pair, approving token spending, adding/removing liquidity, and trading are separate, irreversible on-chain actions that require wallet confirmation. A task checkbox or listing URL never performs these actions.
# Central wallet

FTHX wallets use the previous Featheral X wallet's charcoal palette, gold balance
and compact layout, with the shared Dollar-style forms and actions. They open in a
380px top-right panel, not a centered modal. Other primary currencies retain their
existing base design. X's wallet button opens the same
FTHX central renderer (its posting/comment login stays site-scoped); obsolete local
top-up UI is removed. Balances lead with the estimated all-network total in the
selected FTHG/FTH$/FTHX unit, with spendable native balance separately labeled.
Missing prices are listed in valuation details without adding "subtotal" to balances.
The estimated token total is shown in FTHX alongside USD, even on FTH$/FTHG wallets.
Before the FTH$/FTHX pool is first funded, valuation uses the explicitly labeled
opening reference **1 FTH$ = 100 FTHX**. This is not a swap quote or a USD peg.
Once funded, estimates automatically use current verified Exchange reserve ratios;
completed trades move those ratios. Pending settlements, invalid reserves and price
reader failures never fall back to the opening reserve reference. Gold's USD reader
prefers a positive, liquid Ethereum Uniswap FTHG base-token pair from DEX Screener,
choosing the deepest USD-liquidity pair. If none is available or the lookup fails,
it publishes the explicitly labeled temporary **1 FTHG = $0.01** reference.
The lookup is retried after a one-minute cache; successful DEX estimates replace
the reference automatically. Neither price is a redemption guarantee or swap quote.
Internal assets still require verified Gold conversion ratios; native ETH keeps
its independent live USD feed.
Wallet portfolio totals sit below the available balance. Each asset shows smaller
USD and site-primary-currency estimates beneath its own balance, including linked
and Exchange custody holdings without mixing their spendable balances. Missing
prices remain unavailable. USD and primary-currency estimates show up to four
decimal places (USD always displays four); positive values below that precision display as `<$0.0001`
or `<0.0001` in the primary currency rather than zero.
An initialized native Gold reserve supplies its recorded FTHG/FTH$ valuation rate
even when the separate Ethereum bridge is undeployed. This values obligations,
not confirmed Ethereum backing, and does not enable redemption or trading.
The wallet uses six keyboard-accessible tabs: Assets, Send, Receive, Swap,
Activity and Account. Arrow keys wrap between tabs; Home/End jump to the first/last.
Icon actions have accessible names and hover/focus tooltips. Swap uses live Exchange
pools inline; advanced trading and liquidity remain on Exchange. Account contains built-in-wallet and
World controls; supported-network details are collapsed by default.
The balance card uses a top-right connection icon with a status dot and accessible
action tooltip (gray disconnected, accent selected, green authorized). USD and
primary-currency totals stay concise. There is no expandable Estimates section;
a read-only address field with an inline copy icon sits below the totals.
Site header wallet buttons retain the wallet icon and show the selected account's
public avatar (or a default profile icon) and last five address characters, with
the full address in the tooltip. Public selection does not authorize spending.
Headers share responsive horizontal padding; the wallet's monospace address suffix
is separated from its avatar and remains visible on small screens.
On mobile, ecosystem navigation moves from the top Sites bar to a fully expanded,
left-aligned footer tree: Foundation, then Currencies, Apps and Tools. Desktop
keeps the top cross-site navigation; embedded wallets omit the footer tree.
Pricing provenance and missing-asset details remain in the total tooltips.
Mainnet-only FTHG and native-note network warnings remain visible on Receive.
Embedded wallets inherit the host's colors and light/dark theme through a
strict parent-origin/window-checked, color-only message. Full-wallet links retain
the originating site's palette, independently of the selected primary token.
FTHX currency labels are smaller than the amounts, and embedded scrollbars sit at
the panel edge. Assets show equivalents in that same
unit; recent Featheral transactions are sorted newest-first on the main screen.
Ethereum FTHG history links to its token explorer. Native ETH balances are included
on Ethereum, Base, Arbitrum One, Optimism, zkSync Era and Linea. Other L2 tokens
are not tracked. Positive token holdings show icons and network labels; unavailable
RPCs and missing prices are disclosed rather than replaced with zero.
Wallets never contain profile editing forms: avatar/username setup is
available only on World `/#/setup`. Embedded addresses are public read-only context,
not authority or authentication; signing always requires the full central wallet.
FTHG wallets prominently link the separate Gold-themed Ethereum conversion screen;
FTHG is never offered as an internal L3 trading note.

Notes, Exchange, X and Sites share one Wallet header control and responsive layout:
brand and Wallet on the first mobile row, horizontally scrollable navigation below.
Header Swap links open the same panel rather than a separate wallet page.
Notes/Exchange pass only the signed-in account's public address to the read-only
embed; site login tokens stay on their original host.
Normal wallet panels on every site follow the public account selected on the
central wallet host, rather than a site's separate posting/login account. They
read the same linked-account portfolio even while the built-in wallet is locked.
Account switches and completed wallet operations notify other open panels through
central-origin storage events; visible wallets also refresh periodically. Only public
addresses and encrypted backup metadata persist, never built-in signing sessions.
Explicit address-only embeds remain pinned unless `followActive: true` is requested.
Foundation, Gold, Dollar and World header wallets use the same central renderer;
World profile authentication and dedicated Ethereum transaction screens retain their
separate provider connection. Synced World guest estimates are shown for every primary
currency, not only FTH$.
Public wallet selection, linked holdings and balances synchronize automatically through
central-origin storage events, focus/visibility updates and 30-second refreshes.
There is no public-wallet sync button, popup or parent-provided account handoff.
Interactive embedded views keep wallet-host sessions inside the iframe; pinned
address-only views remain read-only. Closing/reopening a panel preserves its
renderer and connection. The site stores only the public selection for reloads.
Account requests and extension signing use a narrowly scoped, origin/source-checked
provider bridge when necessary; no keys or wallet sessions reach the host.
Site sign-in, wallet authorization and native transfers stay inline with explicit
approval. The only wallet-site branding is a small **Powered by Wallet** footer.
Browsers may isolate or block iframe storage (notably across different `*.localhost`
sites); Account offers in-panel storage access or encrypted-backup restoration.
This restriction is not bypassed by sharing sessions or keys with parent sites.

Notes owns native FTH$ chain operations at `/api/v1/notes/*`; existing
`/api/v1/dollar/*` URLs remain compatibility aliases to the same Note ledger.
Gold exclusively owns Ethereum RPC, FTHG and native ETH reads, including
`/api/v1/gold/native/wallets/:address`. Site-local Gold API URLs are gateway aliases
to the Gold service, not independent RPC clients. Note wallet summaries call Gold's
readers rather than accessing Ethereum directly. These APIs share the existing
writer/replica network; they do not represent a deployed Layer 3 rollup.
Dollar wallet popups also display positive FTHX and community-note holdings. The
shared Swap screen lists FTHX pairs when FTHX or the paired note is held; funded
note swaps remain usable even when the separate Dollar pool is unfunded.

Without MetaMask, use Account in the site wallet panel to create a built-in Ethereum-compatible
FTHX wallet, also usable for FTH$ and community notes. Creation requires a password
of at least 12 characters and downloading/confirming an encrypted recovery backup
before saving the wallet. Restore and unlock use the same password; neither passwords
nor plaintext keys are sent to a server. The encrypted keystore stays in central-host
local storage; the unlocked signer and its session remain in memory. Locking, closing
the page or ten minutes of inactivity locks the signer. Keep the backup and password
separately: Featheral cannot recover either. Do not clear browser data without a backup.
Embeds never generate, unlock or receive keys.

An unlocked built-in wallet can link up to four external accounts with signatures
from both owners. Their portfolio is combined, but account balances remain separate:
select the active account and explicitly approve transfers/swaps. Linking never
migrates funds. Download a new backup after linking to preserve those public proofs.
The built-in address can receive native ETH without any external wallet; existing
Ethereum conversion/staking still requires an external wallet on its separate screen.
Public native-ETH reads use per-chain `WALLET_RPC_<chainId>` overrides or the defaults
in `services/gold/native.js`, with a fresh CoinGecko ETH/USD feed. USD estimates
include priced ETH even if the separate FTHG feed/Gold bridge is unavailable.

Foundation and Gold retain their existing header controls and wallet color themes;
normal header clicks open the shared central renderer. Their legacy
profile script/style URLs redirect to the central wallet assets. Portfolio reads use
the public, read-only `wallet.featheral.com/api/wallet/accounts/:ethereumAddress`
endpoint (allowlisted Featheral origins, no cookies or session tokens). Foundation
shows FTHX first and Gold shows FTHG first, with combined FTHG/USD estimates.
Gold/Dollar remain the authoritative ledger/Ethereum service owners; signed profile
editing continues through their compatible API routes, and asset management opens
the central wallet. Public summaries never expose sessions or authorize transactions.

`wallet.featheral.com` hosts the network wallet, profile compatibility assets and
Ethereum conversion/staking screens (`/ethereum/`). Public sites keep their Classic
landing pages; `/wallet/` embeds the central application instead of copying wallet code.
Gold defaults to FTHG, World/Dollar to FTH$, and all other sites to FTHX.

Load `https://wallet.featheral.com/embed.js` and add `<div data-wallet-embed></div>`,
or call `FeatheralWallet.mount(element, {primary: "FTHX", view: "swap", compact: true})`.
The versioned JSON contract is `/api/wallet/ui?primary=FTHX&view=assets&compact=1`.
Embeds add `embedded=1&parentOrigin=<origin>`; only Featheral and local development
origins are allowed. No HTML, arbitrary actions, provider bridge or credentials are
accepted through configuration. Embedded mutations are blocked; connection/signing
opens the central wallet top-level. Browser-blocked storage is reported explicitly.

Combined estimates include wallet FTH$/notes, verified mainnet ERC20 FTHG and linked
World funds. Legacy direct-wallet World accounts are counted once. Unlinked guest
funds require an explicit World top-level public-account sync and remain read-only.
Unavailable sources and unfunded/unpriced assets are explicit; partial estimates are
subtotals, not zero-value assumptions. USD requires a fresh verified market feed;
FTH$ is not USD. No migration moves funds or provisions keys or liquidity.
