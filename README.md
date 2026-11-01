# Featheral

One Node server (`scripts/serve.js`) hosts four sites, selected by the request host, plus the shared `/api/` APIs:

| Site | Production host | Local URL | Source |
| --- | --- | --- | --- |
| Foundation | featheral.com | http://localhost:8080/ | `sites/foundation/` |
| Featheral Gold (FTHG) | gold.featheral.com | http://gold.localhost:8080/ (admin: `/admin/`) | `sites/gold/` |
| Featheral Dollar (FTH$) | dollar.featheral.com | http://dollar.localhost:8080/ (`/wallet/`, `/explorer/`) | `sites/dollar/` |
| Featheral World | world.featheral.com | http://world.localhost:8080/ | `sites/world/` |

Unknown hosts serve the Foundation site. `/wallet/` on any other site redirects to the Dollar site; `/admin/` serves each site's own console. The Featheral game is mounted on World at `/play/`, with its marketing page at `/play/about/`; World `/about/` serves that same landing page and `/play/about/` remains its canonical URL. Its frontend is built from `sites/world/featheral/` when the server starts, and its same-origin API is proxied to a local service. Shared assets (styles, wallet/profile widget, cross-site links, logos, ABI artifacts) live in `sites/shared/` and are served at `/shared/` on every host. Each site sets its accent through a `site-*` body class in `featheral.css` (gold for FTHG, green for FTH$, violet for World, ivory for Foundation); the World site uses a light color scheme by default, and the wallet/profile widget follows the site accent. Logos: `logo.svg` (gold, Foundation and Gold), `logo-dollar.svg` (green coin, Dollar), `logo-world.svg` (violet, World).

Wallet connection behaves the same on every site: page load only silently restores an already-authorized wallet for that origin, unless you previously disconnected. Connecting on another Featheral site never triggers an automatic permission prompt; click the wallet icon to authorize a new origin. The disconnect preference is shared across sites through a parent-domain cookie.

The shared header has one combined wallet/avatar button, with no separate balance chip. It shows a profile icon when disconnected and the account avatar when connected. Use the same button to connect or open the wallet/profile menu, where balances, profile editing and disconnect remain available. Play keeps its wallet controls inside its single account-avatar menu.

Play uses World's canonical username/avatar and the same profile editor, not a separate nickname. Choose **Use World profile in Play** once to sign a session-specific link; subsequent chat requests read the authoritative World username. Changes propagate between World and its Play popup, with a refresh on window focus. Disconnecting or changing wallets removes the previous chat link without moving game saves or balances. Gameplay remains available without a wallet. The site server supplies `WORLD_PROFILE_API_ORIGIN` to the private game API automatically.

When multiple wallet apps are installed, the shared wallet icon opens a wallet-app picker on all sites, including admin pages. Apps are discovered through EIP-6963, with a legacy injected-provider fallback. With multiple apps, choose one explicitly before connecting; with one app, already-authorized accounts can restore silently. Profile/game signatures, FTH$ transfers, and Ethereum transactions all use the selected app.

World's social app uses the same branded top header and shared wallet/profile control as the other sites. Its side navigation contains only Home, Explore and Profile, plus the Post action. Its feed and side panels stick below that header; on mobile, the same social navigation remains in the bottom bar while wallet connection stays in the header. Play, Ledger, About and Docs remain header links.

The social layout is centered within a 1,280px desktop container, with a 600px feed between navigation and suggestions. The feed fills its grid column rather than inheriting the shared marketing-page margins; tablets hide suggestions, and phones use a full-width feed.

World's colored Play icon sits beside the header wallet control. The header launches `/play/` in a separate, reusable popup window; browsers may open a tab instead according to their settings. If a popup is blocked, allow popups for World and try again.

World About and the canonical Play landing page share World's header, ecosystem navigation (including Foundation), Play launcher and wallet/avatar menu. Header styles are shared through `sites/shared/featheral.css`; the landing content retains its responsive game presentation on World's light theme.

World About and Play default to English. Explicit language URLs and saved language preferences take precedence; Korean remains selectable in the landing footer and Play account settings.

The shared header shows an Admin link only for a connected wallet recognized by that site's console: fixed FTHG project wallets or Mainnet `DEFAULT_ADMIN_ROLE` holders on Gold, either configured FTH$ or fixed project wallet list on Foundation and Dollar, and the actual `WORLD_MODERATORS` / `FEATHERAL_ADMIN_WALLETS` moderator list on World. Dollar includes fixed project wallets because they manage the dynamic bridge. It hides on disconnect or account change while eligibility is checked. This navigation is advisory and does not replace on-chain or server-side authorization.

- **FTHG** is the Ethereum Mainnet ERC-20 `0xBa658127d93B17E577E1B8e8995cAB3aE7d7C665` (source: `contracts/FeatheralGold.sol`). Its balances and history are read only from Ethereum; there is no local FTHG ledger.
- **FTH$** is a layer-3 currency with its own native block ledger (see [FTH$ layer-3 ledger](#fth-layer-3-ledger)).

## FTHG site and admin

- `sites/gold/` is the FTHG landing page. It shows live Mainnet statistics without a wallet: supply, the $0.01/FTHG reference value, holders, transfers, supply distribution across the fixed wallets, the FTHG/FTH$ rate and bridge status, recent transfers, and top holders.
- `sites/gold/admin/` is a static admin for managing that existing contract. Read-only stats use a public Ethereum Mainnet RPC without wallet connection; transactions require an authorized wallet. The contract address is fixed, and there is no token deployment workflow.
- The admin artifact contains the contract ABI and verification metadata only; it does not contain deployment bytecode.

The Gold admin includes dashboard, token analytics, token management, read-only bridge status, roles/compliance, legacy exchange, Uniswap V2, listings/planning, and settings. Public checks query CoinGecko, DEX Screener, GeckoTerminal, Uniswap V2, Blockscout, and Sourcify by the fixed contract address. Analytics show indexed holder/transfer pages, filters, and CSV exports; loaded records are not a guaranteed complete history. Token branding is a local working profile, with metadata and token-list exports; image previews do not host public logos. On-chain metadata publication and external platform updates require separate actions.

Listings/planning contains official submission portals, the copy-ready dossier, local DEX/CEX preparation checklists, and preparation-hour/labor-cost estimates. Checkboxes are not application outcomes. Estimates exclude platform review time, legal/audit work, gas, market making, and liquidity capital; the default $50/hour labor rate is configurable in this tab and stored locally. No platform credentials are stored or applications submitted. Speculative CEX market-registry controls, duplicate bridge management, obsolete canonical-SQLite ledger instructions, and the misleading LP-transfer-as-lock control have been removed. Uniswap V2 pool/approval/liquidity/trade tools remain separate from the FTHG/FTH$ bridge.

All four admin consoles share accessible tabs (arrow keys, Home/End, URL fragments), card styling, and wallet controls with per-site accents. Foundation has Overview and Wallet access; Dollar has Overview, Liquidity, Reward policy, Service & safety, and Ledger & queries; World has Overview, Posts, Wallets, and Ledger queries. Hidden panels retain their input state. Gold retains its contract-specific admin gating. World moderation is checked against the service's actual moderator list and requires a signed, confirmed action; deleted posts cannot be restored by hide/unhide controls.

Treasury wallets must be created externally (for example, as a Safe). The admin pins the FTH$ reserve to `0x706CCb6109046a6a4A08dbAD4444A46408703ccb`; if the contract treasury differs, an authorized wallet can update it only to that fixed address through this admin. The fixed source wallet `0xD2f1Be8414472E9f436B65e91A2B8dFDa418287c` is displayed as reference only; this admin does not transfer from it or migrate existing balances. Changing the contract treasury affects future exchanges only. The deployed token contract initializes its treasury to the deployment admin, and its on-chain `TREASURY_ROLE` can still change it outside this admin.

The dashboard uses a public Ethereum Mainnet read-only RPC, so coin stats and fixed source/reserve wallet balances are available without connecting a wallet. Both FTHG balances are read at the same block and shown with an estimated value of $0.01 per FTHG; that estimate is not a market price. The Legacy exchange tab shows on-chain enablement, rate, configured reserve, and recent `ExchangedForFthDollar` events (latest 5,000 blocks, latest 100 displayed). Those events are historical credit requests, not confirmed FTH$ settlement; the current ledger settles the separate dynamic bridge.

Connecting a wallet is only needed for administration. Role assignment uses the deployed contract's `DEFAULT_ADMIN_ROLE`: the connected account must already have that role on Ethereum Mainnet. The admin page checks whether the fixed source and reserve wallets have that role; an existing administrator must grant it to either address before it can manage roles or assign other administrators.

## Run

1. Use Node.js 24 or newer (`node --version`).
2. `npm install`
3. `npm ci --prefix sites/world/featheral`
4. `npm test`
5. Copy `services/token-api/.env.example` to the repository-root `.env` and configure only the settings needed for the environment. `npm start` loads that optional file, compiles the source, exports ABI-only artifacts for both contracts, builds the Featheral game, and serves the four sites plus their APIs at the local URLs above (set `PORT` to change; `*.localhost` resolves to 127.0.0.1 in current browsers). For production, set `APP_ORIGIN` to the exact public HTTPS origin of `world.featheral.com`. The API defaults to `FTH_LEDGER_MODE=unconfigured`, which runs a standalone local FTH$ writer under `data/fth-ledger/local-node/` for development.
6. Browse public contract stats and wallet balances without connecting. To administer either contract, connect a wallet with its relevant on-chain role on Ethereum Mainnet using the wallet icon in the admin header. There is no network selector: the site always uses Mainnet and asks the wallet to switch to it on connect. Transactions are signed by the connected wallet; the admin/API does not handle wallet private keys.

Run `npm run abi` to regenerate the ABI-only admin artifacts after contract source changes. The existing FTHG token has no deployment workflow; the separate, explicitly authorized game-bridge deployment is documented below.

## Dynamic game bridge and API

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

The API is integrated into the site server. It verifies successful Ethereum Mainnet bridge receipts, waits for the configured confirmation count (12 by default), and credits/debits the FTH$ ledger by unique transaction/log ID. FTH$ redemptions first reserve the user's available ledger balance, use a unique on-chain redemption ID and deadline, then settle only from the matching confirmed event. Stake rewards require the corresponding stake event to have been indexed before its claim. Account reads and game-service writes use Ed25519-signed HTTP requests with short timestamps and unique nonces. Private signing keys stay in the owning game/replica services or deployment environment; the API stores only configured public keys. The dynamic bridge must be deployed and its address configured before quotes or settlements work.

FTH$ balances live in the native layer-3 ledger described below. Configure exactly one `FTH_LEDGER_MODE=writer`; other nodes use `FTH_LEDGER_MODE=reader`. Service authentication, ledger signing keys, node URLs, RPC, bridge address, CORS origins, ledger directory, and confirmation count are configured through the process environment; `services/token-api/.env.example` lists supported variables (legacy `TOKEN_LEDGER_*` names are still read as fallbacks). `npm start` loads the repository-root `.env`; the standalone bridge deployment command requires its variables in the invoking process environment or secret manager. Local `.env` files and the entire `data/` directory are ignored by Git.

To deploy the separate bridge, configure `TOKEN_API_RPC_URL`, `TOKEN_API_GAME_SERVICE_ADDRESS`, and `BRIDGE_DEPLOYER_PRIVATE_KEY` in a protected local environment, then run `npm run deploy:bridge`. Review the deployment and its constructor addresses before signing; this command sends a permanent Mainnet transaction and is not run by `npm start`. After deployment, configure `TOKEN_API_BRIDGE_ADDRESS`, set the writer's `FTH_LEDGER_SIGNING_PRIVATE_KEY` (and each reader's `FTH_LEDGER_WRITER_PUBLIC_KEY`) plus the game service keys, start the API, deposit only the desired actual FTHG reserve, and initialize the pool with the matching FTH$ budget already approved by the game ledger. Use `npm run generate:service-keys` to create Ed25519 service keypairs; register public keys in `TOKEN_API_SERVICES_JSON` and keep private keys in service secret managers. Do not expose a writer directly to the internet; terminate TLS and configure firewalling, request-rate limits, monitoring, and backups at the deployment edge.

## FTH$ layer-3 ledger

`services/fth-ledger/` is a small, dependency-free block ledger owned by Featheral. It settles to Ethereum only through the bridge contract's events; it is not an EVM chain and has no gas.

- **Accounts.** Every wallet owns one account: its address left-padded to 32 bytes. Game-only accounts may use any other bytes32 id.
- **Transactions.** `GENESIS`, `CREDIT` (confirmed FTHG conversion or stake reward), `TRANSFER` (wallet-signed), `RESERVE`/`SETTLE`/`RELEASE` (FTH$ to FTHG withdrawals), and `PROFILE` (signed username/avatar). Amounts are 18-decimal integer strings. Each transaction has a unique id, so replays and duplicate bridge events are rejected.
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

Each accepted update is recorded as an immutable `PROFILE` transaction in the FTH$ ledger that includes the signature, and read nodes re-verify the signature when importing it. Writer and standalone (`unconfigured`) nodes accept profile updates; read nodes forward them to their configured writer. Each IP address is limited to 10 profile updates per minute. Profiles are public, and earlier usernames and avatars remain in the append-only journal.

The small exit icon at the bottom-right of the panel disconnects the wallet. It asks the wallet to revoke the site's account permission (`wallet_revokePermissions`, where supported) and stores the choice in `localStorage`, so the page does not reconnect automatically until the wallet icon is clicked again.

## Featheral Dollar site

`sites/dollar/` is the FTH$ home. None of it requires a wallet to browse:

- **Landing** (`/`): live ledger statistics (supply, holders, height, transactions, transfer volume, bridge credits, withdrawals, price estimate), latest blocks and transactions, top holders, how FTH$ moves, and the storage/replication layout. Data reloads only when **Refresh** is clicked.
- **Wallet** (`/wallet/`): FTH$ balance (available and reserved), FTHG held on Ethereum, and total estimated USD. A connected wallet can send FTH$ to an address, account id, or `@username` (free signature, no gas), copy its receive address, and convert FTHG to FTH$. It also shows the wallet's activity.
- **Explorer** (`/explorer/`): blocks, transactions, rich list, ledger files, and block/transaction/account pages, plus a search box.

Each wallet's FTH$ account ID is its address left-padded to 32 bytes (`ethers.zeroPadValue(address, 32)`). The game uses this as `gameAccountId` when the wallet converts, redeems, or stakes. Valuation uses the live bridge spot rate once the pool is funded, otherwise the 1 FTHG = 1,000 FTH$ opening rate, so 1 FTH$ is about $0.00001 at the $0.01/FTHG estimate.

Converting FTHG to FTH$ is enabled only after the dynamic bridge is deployed and funded. The connected wallet approves FTHG and then calls `convertFthg` with 1% slippage protection and its derived account ID. FTH$ to FTHG withdrawals require an authorized settlement service, because only the game service role can call `redeemFthDollar`; the World interface does not currently offer a withdrawal request.

## FTHG admin

`gold.featheral.com/admin/` includes Dashboard, Token analytics, Token, Bridge status, Roles & Compliance, Legacy exchange, Uniswap V2, Listings & planning, and Settings tabs. Dashboard, analytics, and bridge status are readable without a wallet. Management tabs appear only when the connected wallet is the fixed source wallet, the FTH$ reserve wallet, or any wallet holding `DEFAULT_ADMIN_ROLE`, with an **Admin** badge next to the title. This only controls what the page shows; on-chain roles still decide which transactions succeed. Current dynamic-bridge management lives exclusively in Dollar admin; the separate legacy exchange controls are explicitly labeled and warn that the current ledger does not settle their events.

## Ledger SQL browsing

Both ledgers keep a derived, in-memory SQLite index (`node:sqlite`, rebuilt from the daily block files on start) next to the hash-chained files, which remain the source of truth. `GET /api/v1/fth/sql?q=` (FTH$) and `GET /api/v1/world/sql?q=` (World) run one read-only `SELECT`/`WITH` statement (also `POST` with `{ "query": ... }`); `/sql/schema` lists tables and columns. Queries run under `PRAGMA query_only`, are limited to 4,000 characters and 500 rows, and reject `PRAGMA`, `ATTACH`, recursive CTEs and similar. FTH$ tables: `blocks`, `transactions`, `accounts`, `profiles`, `redemptions`. The console is the **SQL** tab of the FTH$ explorer, of the World ledger explorer, and of the admin consoles.

## Featheral World

`sites/world/` is an X-style social network. The feed (`/`) supports posts of up to 280 characters, replies, reposts, likes, follows, a Following timeline, profiles, search and threads. Everything is an action signed by the connected wallet and recorded on a **separate communication ledger** (`services/social-ledger/`, same engine as FTH$, files under `WORLD_LEDGER_DIR`); no money moves on it. Usernames and avatars come from the FTH$ profile ledger. One wallet signature delegates a throwaway session key for six days, so later posts and likes need no wallet popup.

- Ledger explorer: `/ledger/` (blocks, actions, daily files, SQL). API: `/api/v1/world/*`.
- The wallet connection is shared across all four sites.
- The empty Home feed shows clearly labeled example posts for inspiration only; these are never submitted to the ledger or shown as real activity. Visitors can draft before connecting and use an example to start a blank draft. Drafts stay in memory across feed navigation, are separated by wallet, and are kept after cancelled or failed posting; reloading clears them. Publishing requires wallet sign-in.
- About page: `/about/` (the Play landing page; canonical URL `/play/about/`).

## Admin consoles

Every site has its own console at `/admin/`, with shared accessible tabs and consistent styling. Its header shows an Admin link only when the connected wallet meets that site's access rules.

| Console | Purpose |
| --- | --- |
| `gold.…/admin/` | FTHG token, roles, bridge status, labeled legacy exchange, Uniswap V2 and listing preparation |
| `dollar.…/admin/` | Dynamic-bridge liquidity, reward policy, service roles and safety; ledger monitoring and SQL |
| `localhost:8080/admin/` (foundation) | Ecosystem status and admin wallet lists |
| `world.…/admin/` | World moderation (hide/unhide posts, suspend/restore wallets) and SQL |

Foundation and Dollar project access uses `FEATHERAL_ADMIN_WALLETS` and configured FTHG project wallets; Dollar also recognizes the fixed bridge project wallets. Gold uses fixed project wallets and on-chain roles. World uses only the service's `WORLD_MODERATORS` / `FEATHERAL_ADMIN_WALLETS` moderator list. The pages only gate what they display; contract roles and server signature checks enforce actual authorization. World moderation is a wallet-signed `MOD` action recorded on the ledger rather than erasing anything. Personal staking and claims belong in the Dollar wallet at `/wallet/#staking`, not admin.

## Notes

- Consider hosting the management API/console behind additional authentication (e.g. IP allowlist/basic auth); on-chain roles are the real access control.
- Uniswap integration targets V2 router/factory; a V3 module can be added later.
- The exchange tab is a planning registry only; a real exchange needs custody, legal and audit work.
- Listing checks depend on third-party public APIs and can be unavailable due to rate limits or network restrictions. A missing public record does not indicate that a submission was rejected. Listing portals, eligibility rules, and URLs may change; verify the official site before submitting.
- The $0.01/FTHG figure is an admin reference estimate only. It must not be used in exchange applications as market price, valuation, or evidence of liquidity.
- Per-platform work estimates are approximate hands-on preparation hours. Estimated labor costs multiply those hours by the user-configured internal rate; unknown external fees are explicitly not included in sorting or totals.
- Creating a DEX pair, approving token spending, adding/removing liquidity, and trading are separate, irreversible on-chain actions that require wallet confirmation. A task checkbox or listing URL never performs these actions.
