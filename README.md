# Featheral

One Node server (`scripts/serve.js`) hosts four sites, selected by the request host, plus the shared `/api/` APIs:

| Site | Production host | Local URL | Source |
| --- | --- | --- | --- |
| Foundation | featheral.com | http://localhost:8080/ | `sites/foundation/` |
| Featheral Gold (FTHG) | gold.featheral.com | http://gold.localhost:8080/ (admin: `/admin/`) | `sites/gold/` |
| Featheral Dollar (FTH$) | dollar.featheral.com | http://dollar.localhost:8080/ (`/wallet/`, `/explorer/`) | `sites/dollar/` |
| Featheral World | world.featheral.com | http://world.localhost:8080/ | `sites/world/` |

Unknown hosts serve the Foundation site. World embeds the Dollar wallet at `/wallet/` and `/play/bank/`; Foundation and Gold wallet links redirect to World's wallet page. `/admin/` serves each site's own console. The game is mounted on World at `/play/`; World home is the merged Getting-started landing page. Legacy `/about/` and `/play/about/` entries redirect there while preserving query parameters (static no-JavaScript marketing fallback remains). `npm start` builds `sites/world/featheral/` and runs its APIs in the gateway process. Shared assets live in `sites/shared/` and are served at `/shared/` on every host.

Wallet connection behaves the same on every site: page load only silently restores an already-authorized wallet for that origin, unless you previously disconnected. Connecting on another Featheral site never triggers an automatic permission prompt; click the wallet icon to authorize a new origin. The disconnect preference is shared across sites through a parent-domain cookie.

The shared header has one combined wallet/avatar button, with no separate balance chip. It shows a profile icon when disconnected and the account avatar when connected. Use it to connect, inspect balances or disconnect. World profile/avatar editing is inline on `/#/setup`, not in the wallet popup; other sites retain the shared editor. Play links to this main-page editor and keeps wallet controls inside its account-avatar menu.

Play uses World's canonical username/avatar and the same profile editor, not a separate nickname. Choose **Use World profile in Play** once to sign a session-specific link; subsequent chat requests read the authoritative World username. Changes propagate between World and its Play popup, with a refresh on window focus. Disconnecting or changing wallets removes the previous chat link without moving game saves or balances. Gameplay remains available without a wallet. The site server supplies `WORLD_PROFILE_API_ORIGIN` to the private game API automatically.

When multiple wallet apps are installed, the shared wallet icon opens a wallet-app picker on all sites, including admin pages. Apps are discovered through EIP-6963, with a legacy injected-provider fallback. With multiple apps, choose one explicitly before connecting; with one app, already-authorized accounts can restore silently. Profile/game signatures, FTH$ transfers, and Ethereum transactions all use the selected app.

World home defaults to Getting started for all visits; no wallet, profile or game-session creation is required. Optional inline avatar/username setup explains public persistence and free signing, with a direct skip-to-play action. Left navigation includes Getting started, Community feed (`/#/feed`), social Explore/search, Profile, Game guide and Docs. On mobile these remain accessible through the bottom bar. Play and Ledger remain in the compact header. Profile edit links use `/#/setup`; draft profile inputs survive same-wallet balance refreshes and feed/guide navigation. Wallet/account changes clear another wallet's draft and are revalidated before publication.

The social layout is centered within a 1,280px desktop container, with a 600px feed between navigation and suggestions. The feed fills its grid column rather than inheriting the shared marketing-page margins; tablets hide suggestions, and phones use a full-width feed.

World's colored Play icon sits beside the header wallet control. The header launches `/play/` in a separate, reusable popup window; browsers may open a tab instead according to their settings. If a popup is blocked, allow popups for World and try again.

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

- `sites/gold/` is the FTHG landing page. It shows live Mainnet statistics without a wallet: supply, the $0.01/FTHG reference value, holders, transfers, supply distribution across the fixed wallets, the FTHG/FTH$ rate and bridge status, recent transfers, and top holders.
- `sites/gold/admin/` is a static admin for managing that existing contract. Read-only stats use a public Ethereum Mainnet RPC without wallet connection; transactions require an authorized wallet. The contract address is fixed, and there is no token deployment workflow.
- The admin artifact contains the contract ABI and verification metadata only; it does not contain deployment bytecode.

The Gold admin is a public reserve dashboard: separate origin and FTH$ backing wallet flows, confirmed in/out since reserve initialization, OFF-SYNC incoming/outgoing obligations, immutable allocation cap, redeemable backing, and locked redeemed FTH$. Actual FTHG holdings are verified separately at one finalized Ethereum block. These wallets hold FTHG on Ethereum; FTH$ remains in the Dollar ledger.

`GET /api/v1/gold/reserve/activity?limit=20&cursor=height:index` pages the sealed reserve journal newest first (maximum 100 records, 2,000 transactions scanned per request). Follow `nextCursor` even on a filtered empty page. Off-chain obligations, treasury-only circulation and confirmed Ethereum receipts are distinct records; receipts reconcile pooled totals, not individual historical allocations. Journal and receipt links provide evidence. FTH$ display rounds to at most two decimals; exact base units remain available in amount tooltips.

Gold overview, conversion and admin share a responsive header. Foundation, Dollar and World retain accessible tabbed consoles and shared wallet controls. World moderation is checked against the service's actual moderator list and requires a signed, confirmed action; deleted posts cannot be restored by hide/unhide controls.

The origin `0xD2f1Be8414472E9f436B65e91A2B8dFDa418287c` and backing reserve `0x706CCb6109046a6a4A08dbAD4444A46408703ccb` are pinned by the ledger policy. Gold admin cannot change these wallets, supply or the fixed 1 FTHG = 1,000 FTH$ conversion rate.

Essential token safety retains pause/resume (`PAUSER_ROLE`), metadata publication (`DEFAULT_ADMIN_ROLE`), blacklist checks/changes (`COMPLIANCE_ROLE`) and safety-role checks/grants/revocations (administrator only). Writes require the actual corresponding on-chain role on Mainnet, explicit confirmation, simulation and wallet signing. Fixed project-wallet membership alone grants no write permission. Removing the last administrator can permanently disable administration. Legacy exchange, dynamic-bridge controls, DEX/liquidity tools, listing planning and local branding/settings were removed from Gold admin.

Conversion explains eligibility and previews amounts before free message signatures. World initial allocation funds markets, not personal wallets. Reconversion only unlocks existing redeemed currency after a confirmed return; redemption requires confirmed uncommitted backing. Manual sync previews actual balances and verifies existing receipts with a prominent Mainnet warning; it never submits Ethereum transfers.

## Run

1. Use Node.js 24 or newer (`node --version`).
2. `npm install`
3. `npm ci --prefix sites/world/featheral`
4. `npm test`
5. Copy `services/token-api/.env.example` to the repository-root `.env` and configure only the settings needed for the environment. `npm start` loads that optional file, compiles the source, exports ABI-only artifacts for both contracts, builds the Featheral game, and serves the four sites plus their APIs at the local URLs above (set `PORT` to change; `*.localhost` resolves to 127.0.0.1 in current browsers). For production, set `APP_ORIGIN` to the exact public HTTPS origin of `world.featheral.com`. The API defaults to `FTH_LEDGER_MODE=unconfigured`, which runs a standalone local FTH$ writer under `data/fth-ledger/local-node/` for development.
6. Browse public contract stats and wallet balances without connecting. To administer either contract, connect a wallet with its relevant on-chain role on Ethereum Mainnet using the wallet icon in the admin header. There is no network selector: the site always uses Mainnet and asks the wallet to switch to it on connect. Transactions are signed by the connected wallet; the admin/API does not handle wallet private keys.

Run `npm run abi` to regenerate the ABI-only admin artifacts after contract source changes. The existing FTHG token has no deployment workflow; the separate, explicitly authorized game-bridge deployment is documented below.

## Dynamic game bridge and API

### API ownership and World wallet

- `services/gold-api/` owns Ethereum FTHG, bridge and staking reads: `/api/v1/gold/stats`, `/wallets/:address`, `/quote` and `/rpc`. RPC is read-only, rate-limited and bounds log scans. Ethereum writes are signed by the selected browser wallet, never by World.
- `services/dollar-api/` owns `/api/v1/dollar/*`, including confirmed bridge settlement, transfers, balances, profiles and the native journal. `/api/v1/dollar/stats` works without Ethereum connectivity. Legacy `/api/v1/*` paths remain compatible.
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

- The fixed conversion rate is **1 FTHG = 1,000 FTH$**. Resource/item market prices remain dynamic.
- Initialization verifies the origin wallet's actual holdings at an Ethereum finalized block, also enforcing the configured confirmation minimum. That balance becomes an immutable initial allocation cap. Later deposits never enlarge it.
- Each eligible non-collectible market receives at most **one** bootstrap on first quote/trade/collect-and-sell use by an authenticated settled player. Targets are pinned in the Dollar genesis: at most 10,000 accounting lots at the configured base price. Gold spends the system treasury first, allocates origin FTHG only for the deficit, and may fund fewer whole lots if the finite budget is insufficient. No automatic refills or personal starter grants occur.
- Gold allocations are pending off-chain obligations, **not actual FTHG transfers**. The market's FTH$ allocation and reserve commitment share one atomic journal transaction; its resource seed is applied once in the recoverable game SQLite mirror. Back up both stores and their signing keys together.
- FTH$ → FTHG requires wallet authorization from one of the two pinned wallets and enough confirmed, uncommitted backing. Redeemed FTH$ is **locked in redemption escrow**, not burned or made available for market funding. After FTHG has actually returned to origin, a source-wallet-signed reconversion can unlock those same FTH$; it creates no new supply. Exhaustion ends initial issuance permanently.
- `/api/v1/gold/reserve` exposes the cap, allocations, pending transfers, confirmed redeemable backing and locked FTH$. `/reserve/sync-plan` adds actual finalized wallet holdings. `/reserve/reconcile` verifies finalized, canonical token Transfer receipts between the pinned wallets, with per-log deduplication. `/reserve/redeem` and `/reserve/convert` record signed off-chain obligations.
- Gold's `/conversion/` page prominently warns about Mainnet gas and irreversible token movements. **Sync previews and receipt reconciliation only:** this isolated deployment never submits Ethereum transactions. Test balances are not live redeemable money.

Opt in with `GOLD_RESERVE_MODE=isolated`, `HOST=127.0.0.1`, a separate `PORT`, local `APP_ORIGIN`, and `GOLD_RESERVE_TEST_DIR` pointing to a named empty directory under `data/reserve-tests/`. Startup marks the directory, creates separate Gold/game keys and journals, and refuses live directories or symlinks/junctions. Initialization failure exits nonzero. `GOLD_RESERVE_MODE=disabled` remains the default; no live journal is migrated or funded by these tests.

Production rollout requires separate authorization, a reviewed genesis or append-only activation policy/cap, secure key custody and backups, and a separately approved Mainnet synchronization workflow. A finite supply does not guarantee stable prices or indefinitely sufficient liquidity. Pools can deplete; exhausted/unaffordable markets honestly show no quote rather than manufacturing funds.

With explicit operator authorization and an offline backup, `GOLD_RESERVE_MODE=live` activates an existing **unused, zero-supply** Dollar writer. A `GOLD_POLICY` block, signed by its existing genesis-authorized game key, pins the new Gold authority and market targets without rewriting genesis or resetting settlements. Previously issued ledgers are refused rather than silently migrated. Gold keys persist under `data/gold-reserve/`; back them up with the Dollar journal and game database. Restarting replays the policy and preserves the cap. Live mode automatically funds markets on first eligible use; players obtain FTH$ by selling owned resources, not by receiving grants. Ethereum submission remains disabled, and redemption still requires confirmed backing.

FTH$ balances live in the native layer-3 ledger described below. Configure exactly one `FTH_LEDGER_MODE=writer`; other nodes use `FTH_LEDGER_MODE=reader`. Service authentication, ledger signing keys, node URLs, RPC, bridge address, CORS origins, ledger directory, and confirmation count are configured through the process environment; `services/token-api/.env.example` lists supported variables (legacy `TOKEN_LEDGER_*` names are still read as fallbacks). `npm start` loads the repository-root `.env`; the standalone bridge deployment command requires its variables in the invoking process environment or secret manager. Local `.env` files and the entire `data/` directory are ignored by Git.

To deploy the separate bridge, configure `TOKEN_API_RPC_URL`, `TOKEN_API_GAME_SERVICE_ADDRESS`, and `BRIDGE_DEPLOYER_PRIVATE_KEY` in a protected local environment, then run `npm run deploy:bridge`. Review the deployment and its constructor addresses before signing; this command sends a permanent Mainnet transaction and is not run by `npm start`. After deployment, configure `TOKEN_API_BRIDGE_ADDRESS`, set the writer's `FTH_LEDGER_SIGNING_PRIVATE_KEY` (and each reader's `FTH_LEDGER_WRITER_PUBLIC_KEY`) plus the game service keys, start the API, deposit only the desired actual FTHG reserve, and initialize the pool with the matching FTH$ budget already approved by the game ledger. Use `npm run generate:service-keys` to create Ed25519 service keypairs; register public keys in `TOKEN_API_SERVICES_JSON` and keep private keys in service secret managers. Do not expose a writer directly to the internet; terminate TLS and configure firewalling, request-rate limits, monitoring, and backups at the deployment edge.

## FTH$ layer-3 ledger

`services/fth-ledger/` is a small, dependency-free block ledger owned by Featheral. It settles to Ethereum only through the bridge contract's events; it is not an EVM chain and has no gas.

- **Accounts.** Every wallet owns one account: its address left-padded to 32 bytes. Game-only accounts may use any other bytes32 id.
- **Transactions.** `GENESIS`, historical `CREDIT` (new ordinary issuance is closed), `TRANSFER` (wallet-signed), legacy `RESERVE`/`SETTLE`/`RELEASE`, `PROFILE`, `GAME` (conserved gameplay transfers), `GOLD_POLICY` (signed zero-supply live activation), and `GOLD` (authorized finite allocation/conversion/sync). A finite-reserve policy rejects ordinary `CREDIT` even during replay. Historical burns in older journals replay unchanged; new gameplay payments go to the system treasury. Amounts are 18-decimal integer strings; IDs and Ethereum transfer logs are idempotent.
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

`gold.featheral.com/admin/` exposes public reserve flows and transaction history plus role-gated essential token safety. See [FTHG site and admin](#fthg-site-and-admin) for OFF-SYNC semantics and retained controls.

## Ledger SQL browsing

Both ledgers keep a derived, in-memory SQLite index (`node:sqlite`, rebuilt from the daily block files on start) next to the hash-chained files, which remain the source of truth. `GET /api/v1/fth/sql?q=` (FTH$) and `GET /api/v1/world/sql?q=` (World) run one read-only `SELECT`/`WITH` statement (also `POST` with `{ "query": ... }`); `/sql/schema` lists tables and columns. Queries run under `PRAGMA query_only`, are limited to 4,000 characters and 500 rows, and reject `PRAGMA`, `ATTACH`, recursive CTEs and similar. FTH$ tables: `blocks`, `transactions`, `accounts`, `profiles`, `redemptions`. The console is the **SQL** tab of the FTH$ explorer, of the World ledger explorer, and of the admin consoles.

## Featheral World

`sites/world/` is an X-style social network. The feed (`/`) supports posts of up to 280 characters, replies, reposts, likes, follows, a Following timeline, profiles, search and threads. Everything is an action signed by the connected wallet and recorded on a **separate communication ledger** (`services/social-ledger/`, same engine as FTH$, files under `WORLD_LEDGER_DIR`); no money moves on it. Usernames and avatars come from the FTH$ profile ledger. One wallet signature delegates a throwaway session key for six days, so later posts and likes need no wallet popup.

- Ledger explorer: `/ledger/` (blocks, actions, daily files, SQL). API: `/api/v1/world/*`.
- The wallet connection is shared across all four sites.
- The empty Community feed (`/#/feed`) shows clearly labeled example posts for inspiration only; these are never submitted to the ledger or shown as real activity. Visitors can draft before connecting and use an example to start a blank draft. Drafts stay in memory across feed navigation, are separated by wallet, and are kept after cancelled or failed posting; reloading clears them. Publishing requires wallet sign-in.
- Getting started: `/`; optional profile editor: `/#/setup`; quick guide: `/#/guide`. Legacy About entries redirect to home.

## Admin consoles

Every site has its own console at `/admin/`, with consistent site styling and shared wallet controls. Gold keeps its public reserve admin link visible; its token writes remain role-gated.

| Console | Purpose |
| --- | --- |
| `gold.…/admin/` | Public reserve flows, OFF-SYNC history and essential token safety |
| `dollar.…/admin/` | Dynamic-bridge liquidity, reward policy, service roles and safety; ledger monitoring and SQL |
| `localhost:8080/admin/` (foundation) | Ecosystem status and admin wallet lists |
| `world.…/admin/` | World moderation (hide/unhide posts, suspend/restore wallets) and SQL |

Foundation and Dollar project access uses `FEATHERAL_ADMIN_WALLETS` and configured FTHG project wallets; Dollar also recognizes the fixed bridge project wallets. Gold uses fixed project wallets and on-chain roles. World uses only the service's `WORLD_MODERATORS` / `FEATHERAL_ADMIN_WALLETS` moderator list. The pages only gate what they display; contract roles and server signature checks enforce actual authorization. World moderation is a wallet-signed `MOD` action recorded on the ledger rather than erasing anything. Personal staking and claims belong in the Dollar wallet at `/wallet/#staking`, not admin.

## Notes

- Consider hosting the management API/console behind additional authentication (e.g. IP allowlist/basic auth); on-chain roles are the real access control.
- The $0.01/FTHG figure is an admin reference estimate only. It must not be used in exchange applications as market price, valuation, or evidence of liquidity.
- Creating a DEX pair, approving token spending, adding/removing liquidity, and trading are separate, irreversible on-chain actions that require wallet confirmation. A task checkbox or listing URL never performs these actions.
