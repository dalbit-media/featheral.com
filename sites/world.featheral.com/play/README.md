# Featheral

A responsive, map-first civic world prototype for desktop and mobile browsers. Original procedural artwork is rendered with Canvas; the interface uses TypeScript and Vite.

Existing database paths, session cookie names, and legacy browser-save keys are retained across the rebrand so existing worlds remain accessible.

The shared wallet/profile and site-navigation scripts and styles are served by the
gateway at `/shared/`, not bundled by Vite. Their HTML tags use `vite-ignore` to
preserve the runtime URLs and classic-script ordering without build warnings.

## World account and required profile

Register at `/register/`, sign in at `/login/` and edit your profile at `/account/`
before playing. Credentials are no longer embedded in the public homepage.
Media and game account links preserve their destination; all three use the same
World identity and signing provider. Signed-out profile visits go to login.
Successful authentication returns to the profile page. The shared form is reused
for the dedicated Media signature approval popup at `/account/?approve=...`.
Old homepage `/#account` links redirect to the profile page.
Community is available on World at `/community/`, reusing Media's feed, signed
posting, shared profile store and social database on the World origin. Writes on
either social API alias require a complete World session on World/Media hosts.
Play opens in the same tab; optional `data-game-window` links retain the separate
map-window behavior. The game Account panel links back to World and Community.
Username/password registration
creates a password-encrypted built-in wallet with a server-stored encrypted backup
for cross-device access; connecting an external wallet is an alternative. If the
selected wallet already has a built-in encrypted backup on World in this browser,
signup asks only for a username and its existing wallet password. It unlocks and
reuses that same wallet and backup without overwriting local storage or moving
funds. Password login is enabled immediately, including on another device.
Credential registration does not require a finished public profile; an
generated or uploaded avatar, valid username and nonblank profile description are still
required before gameplay and Media writes.
The profile editor generates a deterministic PNG avatar for new wallets and offers
**Generate avatar** for variations. Existing uploaded avatars are never replaced
automatically; generated previews are published only through the normal signed save.
Media registration and editing also happen on World, with one shared public
profile. Existing guest settlements and wallet balances are preserved: restoring
a wallet-owned game moves no funds and refuses to discard guest money.

Each wallet owns its own settlement. Use **Account → Switch account** to sign in
with another World username/password, or connect and approve another wallet in
the World wallet panel. A public wallet selection alone is not a sign-in. Once
the authenticated World account changes, gameplay reloads and restores that
wallet's settlement, inventory and existing fund mode. Switching back restores
the previous settlement; no settlement is deleted and no funds are transferred.

Keep your password and an encrypted wallet backup. There is no password reset.
The original registration username remains the password sign-in name after a
public profile rename. Server account sessions expire after seven days; no
private key is stored unencrypted on the server or shared with Media. See the
root README for the credential database and writer/reader deployment boundary.

## Marketplace quantity presets

Marketplace buy quantities use the same **25%, 50%, 75%, 100%** presets as
resource sales. Buying percentages select the largest whole trading-lot quantity
within that share of available game FTH$, using executable market depth rather
than multiplying a one-lot ticker price. In **Choose price**, sizing uses the
full limit-order escrow cost. Resource buys have no fixed quantity cap: **100%**
selects the largest affordable whole-lot amount supported by actual liquidity,
with any remainder smaller than the next lot's cost. Inventory restrictions,
collectible uniqueness and the 10,000-lot item cap still apply.
**100%** never authorizes more than the
available budget, including spot-price slippage. The ticket shows the minimum
physical-unit increment and selected spending limit; editing quantity or using
the stepper switches back to manual sizing. Item sale presets use sellable copies,
excluding equipped/placed copies. Resource sale controls are unchanged.

## Marketplace browsing and charts

Game visuals use a shared duotone UI icon family and illustrated item/building
badges. Item effects and usage details are shared by inventory, recipes and
market cards; decoration and civic descriptions do not imply income or
production bonuses. Settlement panels include a persistent section switcher,
context descriptions and object inspectors. Controls keep stable hover
geometry, visible action labels, keyboard focus and 44px minimum touch targets.
Reduced-motion preferences suppress control transitions.

Marketplace browsing includes specialized categories, multi-word search across
localized/English names and item IDs, owned-only, available buy/sell quotes,
rarity and unlocked-recipe filters. Filters combine and Reset filters clears
them all. Sorting supports both price directions, ownership, changes, supply,
rarity and crafting tier; grid and sortable-table views share the same results.

Price history defaults to OHLC candles with volume bars and a closing-price
line alternative. Auto groups the available history into roughly 40 candles;
5m, 15m, 1h, 4h and 1d intervals use the game clock in UTC. The chart spans the
full marketplace width, appears before the mobile order ticket, and can open
in a fullscreen dialog (Escape or Close restores focus). Its axes use actual
panel dimensions so labels do not shrink with the screen.

Use 1D/1W/1M/All ranges, drag to pan, pinch or Ctrl/Command-scroll to zoom,
or use the navigation buttons. Normal scrolling remains page scrolling.
Arrow keys/Home/End inspect candles; +/- zoom. A crosshair exposes candle
time and OHLC/volume details. Volume and 5/20-candle moving averages are
optional; averages use recorded candles, not fabricated empty intervals,
and require a complete period. Ranges end at the latest recorded trade,
not wall-clock time. Zoom and pan survive price refreshes; Reset restores
all available history. Only the latest 120 executed
trades are available; missing intervals stay empty, not fabricated or carried
forward. This is a trade-history chart, not a guaranteed complete time series.

## Inventory inspection

Inventory shows equipped visibility and activity gear in the first slots of
each matching category, with illustrated icons and equipped badges. Identical
copies remain one stack; equipment still uses its ordinary storage slot.
The grid fills the panel width. Hover or keyboard-focus a slot for a bounded
item-detail popover; tap to inspect and select an owned item for its ordinary
actions. Reserved-only stacks can be inspected without making them usable.
Escape or clicking outside dismisses the popover.
Previews are bounded to the space above or below the slot and never intercept
pointer clicks. Select an item to read its full details below the grid.
The inventory panel uses compact icon filters and omits the redundant section
tabs; the settlement dock still provides navigation.

## Civilization progression and building designs

Capital is followed by seven finer milestones:

| Tier | Residents | Upgrade fee |
| --- | ---: | ---: |
| Regional Hub | 250,000 | FTH$1,000 |
| Urban Center | 500,000 | FTH$2,000 |
| Metropolitan Region | 1,000,000 | FTH$3,000 |
| World City | 2,000,000 | FTH$4,000 |
| Global City | 5,000,000 | FTH$5,000 |
| Megacity | 10,000,000 | FTH$15,000 |
| Great Megacity | 20,000,000 | FTH$40,000 |

Each upgrade also requires the
materials shown in Buildings. These are new-tier costs only: the original
nine tier costs, monetary policy and reserve catalogs remain unchanged.
Population can keep growing after the final tier; twenty million is an upgrade
threshold, not a population cap.

Oil upkeep doubles from Town through Capital, then rises in smaller steps:
0.024, 0.032, 0.040, 0.048, 0.064, 0.128 and 0.256 barrels per resident per
game day respectively. Global City, Megacity and Great Megacity retain their
landmark rates. Keep production and reserves supplied.
Settlement designs progress from pitched-roof homes to glazed urban towers,
green rooftops and paired megacity towers. The map uses at most 48 representative
residential blocks, not one building per resident. Existing placed buildings
retain their positions. Layout inspectors and upgrade cards use tier-aware art.

## Dollar-free starter crafting

Starter crafting at the first settlement tier needs no FTH$ for the Campfire
kit (2 Wood), Torch (1 Wood), Log seat (1 Wood), or Wildflower bed (1 Wood,
2 Water). Material discovery, inventory capacity and bulk-permit requirements
still apply. Other crafting fees and all reserve-market seed prices are unchanged.

## Inventory workspace and equipment refinement

Inventory displays up to 60 unlocked slots per page on desktop (1200px+), 40 on
tablets (700px+) and 20 on phones. Resizing keeps the current slot range in view.
This changes presentation only: storage capacities and expansion costs stay
unchanged. The final page shows only the remaining unlocked slots.
The inventory browser and selected-item inspector are independent layout columns,
so long descriptions cannot stretch search, filters or slot rows. Desktop uses a
320–380px inspector with full-width action buttons and stacked facts; narrower
screens place the inspector below the grid.

Refinement Cores remain craftable and player-tradeable, but are excluded from
automatic reserve funding alongside Merchant and Master Builder Charters.
All eight historical reserve catalogs remain unchanged for deployment preflight;
no ledger reset, key replacement or market-policy authorization is needed.

The primary **Inventory** menu opens `/inventory/` as a full-page workspace:
**Inventory**, **Craft**, and **Enhance**. Legacy settlement inventory/crafting
links redirect to the corresponding tab. Settlement controls now focus on
residents, production, buildings and layout. Upkeep cards grow with their content;
growth, consumption and allocation explanations use expandable disclosures.

Only permanent fee-saving equipment can be refined. Each refined copy has its
own persistent identity and level; ordinary stacks, batch permits, automation
timers, charters and cosmetic items remain unchanged. A successful level adds
**0.1% of the original discount**, not 0.1 percentage points: a base 10% discount
becomes 10.01% at level 1. Level 1,000 is the maximum; effective fee savings are
capped at 99%. Benefits affect newly priced actions, never previously paid jobs.

Each attempt consumes **one Refinement Core** and the following resources times
`current level + 1`: 1,000 Wood, 500 Water, 500 Metal, 100 Oil and FTH$100.
Craft a core at Settlement for 100 Wood, 50 Metal, 10 Oil and FTH$25. Success
starts at 90% and decreases to a 10% floor; the exact next-attempt chance,
cost and benefit are shown before confirmation. Failure consumes the confirmed
cost but never destroys equipment or removes levels. Results are determined by
the server; retries of the same accepted operation return the original result.
There is no automatic repeated spending.

Enhanced copies trade through separate, fixed-price player listings. Unequip
before listing. A listing reserves the exact copy and its level; cancellation
returns it unchanged. Purchases transfer existing FTH$ to the seller and that
copy to the buyer. Enhanced copies never enter ordinary item pools, base-price
orders, automatic merchant crafting or system-funded liquidity. Refinement is a
resource/FTH$ spending sink, not a promise of profit or resale liquidity. Existing
reserve catalogs, genesis prices, balances and financial authorization policies
are preserved.

## Master Builder Charter

Craft `builder-charter` at Settlement for 20 Wood, 10 Metal and FTH$100.
The consumable is stackable and player-tradeable, with unique blueprint artwork.
It does not add any automatic reserve market or change existing financial policies.

With an unused charter in inventory, click any upgrade/build button and choose
**Upgrade once** (no charter) or **Max upgrade**. Max targets only that selected
upgrade: settlement tiers, resource warehouse, inventory storage, every
construction, civic/commercial building or Water facility. Single-build facilities
can only be built once, so their maximum run is one build.

The preview totals every successive level's material and FTH$ cost, final level,
and one charter. Population/unlock requirements, normal costs and existing level
caps still apply. The server recomputes the exact plan and rejects changed totals.
One atomic action consumes the charter only after all planned upgrades succeed;
receipt retries never spend again. Reserved or pending charters cannot be used.

## Master Merchant Charter

Craft distinguishes a failed price request from a successfully loaded market
with no buyers. An incomplete paid profit snapshot shows **No sale quote** or
**Missing ingredient prices**, with **Why no quote?** listing the output and
specific missing ingredient markets. These links open the relevant buy/sell
ticket. Crafting from owned materials is not gated by market quote availability.
Refreshing analysis is paid and does not create liquidity; no substitute prices
are invented for missing quotes.
Craft catalog loads, paid analysis purchases and Merchant previews initialize
all existing reserve-eligible markets through the same on-demand authority path
as individual Marketplace reads before calculating quotes. Catalog loads and
paid analysis allow 60 seconds for this initialization. CSRF and revision checks
precede paid-analysis funding; invalid requests cannot trigger it. Immutable
reserve targets, finite funding limits and player-funded-only exclusions remain
unchanged. An older paid snapshot is not silently rewritten or charged again.

`merchant-charter` is the most expensive per-copy crafting recipe: FTH$10,000
**plus one of every terrain keepsake collectible**, unlocked at Capital.
Crafting consumes the full collectible set; pending and market-reserved copies
do not qualify. The recipe disclosure lists each required collectible.
It is consumable and player-tradeable, with the same dynamic pool pricing,
price-time player matching and actual-trade history as other items. Donated
liquidity and player offers set executable prices; there is no fixed sale price
or guaranteed liquidity. It remains excluded from automatic reserve markets.
No existing reserve catalog, seed price, ledger or key changes are required.

Select the charter in Inventory (Bulk actions), then **Review craft and sell**.
An immediate loading dialog distinguishes profit review from confirmed
crafting and selling, blocks duplicate clicks, and reports slower runs.
Merchant requests allow 60 seconds each (ordinary requests remain 10 seconds).
A lost confirmation response retries the same receipt ID once; if recovery
also times out, refresh inventory before retrying because the run may already
have completed. Preview timeouts never consume anything.
The server includes a fresh one-operation analysis without buying or extending
the ordinary paid analysis. It ranks recipes by estimated profit per copy,
tries owned 100/50/20/10-copy permits, and executes only complete batches with
available materials, bag space, positive estimated profit and fully funded
immediate sales. It keeps trying smaller permits and lower-ranked recipes
when a batch does not fit. Permit recipes and charters are not output targets.
The single-copy analysis determines ranking, not batch eligibility: every
otherwise eligible owned permit size gets its own executable profitability check.
If none qualify, the review reports the closest blocker (materials, item space,
fee ceiling, missing buyers, missing input valuation or a loss) and keeps the
message visible in Inventory. Missing input buy quotes cannot be replaced with
invented prices, even for owned materials.

The crafting-fee spending ceiling is **FTH$1,000,000 per run**, or the balance
at confirmation if lower. Preview and execution use the same ceiling and
stop paid crafting once it is reached; unused funds and permits remain.
Profitable zero-fee starter batches remain eligible, including at a zero starting
FTH$ balance. Sale proceeds do not
fund additional crafting. Materials and permits must already be owned and
unused (no escrow, equipped/placed items or pending finds). All originally
owned usable permits are eligible; unused permits remain. Exactly one charter
is consumed only on success. The popup lists crafting/material/permit costs,
sale proceeds, estimated total profit and actual cash increase separately.
Profit values owned materials and bulk permits at executable purchase prices,
including price impact; it excludes the already-paid charter acquisition cost.

Preview simulates market fills inside a rolled-back savepoint, including
depleted pools and player bids across batches. Confirmation recomputes the
plan and verifies its fingerprint and account revision. Changed quotes,
failed fills or ledger errors roll back the entire operation. One idempotent
market receipt covers all crafts and sales. It never mints currency or requests
additional reserve funding to force a sale.

## Squad dispatch vouchers

Squad vouchers have liquid buy/sell markets for both exploration and
investigation. Player offers and funded pools use ordinary dynamic pricing,
trade history and limit orders. Live reserve additions are pinned at 10,000
vouchers per market with initial price seeds of FTH$96/192/480/960 for
10/20/50/100 missions. These are seeds, not fixed execution prices.
Reserve funding remains finite and on demand; unavailable funding surfaces an
error rather than creating currency. Historical reserve catalogs and seeds
are unchanged. Deployment preflight approves only these additive targets,
and activation requires both original authorities through the existing
post-health-check authorization flow. Existing ledgers and keys are not reset.

Craft or trade `squad-10`, `squad-20`, `squad-50`, and `squad-100` to launch
up to that many field missions with one confirmation and one server action.
Click the normal **Explore** or **Investigate** action. If an unused voucher is
owned, choose one mission (no voucher) or an available voucher batch before
reviewing the final confirmation. Without a voucher the normal action flow is
unchanged. Reserved and pending vouchers do not unlock bulk options. There is
no separate bulk button in Explore, population management or inventory.
Bulk targets are selected automatically within the normal reach, without revisiting active destinations.
Exploration also skips destinations covered by another active or selected survey.

Each mission needs two idle residents and retains the normal duration, equipment
discounts, findings, and **exponential shared concurrency fees**. Squad sizes are
maximums, not guaranteed counts: residents, reachable targets, and funds may
reduce the batch, especially for 50/100 vouchers. Confirmation shows the exact
mission count, total fee, and residents. One voucher is consumed only when the
whole displayed batch successfully launches. Changed requirements fail without
spending; action receipts prevent retries from consuming another voucher.

## Hall of Fame and settlement atlas

The trophy rail link opens `/hall-of-fame/`: all persisted players or established
settlements, ranked by population by default, net worth, FTH$ balance, tier,
explored tiles or simulation points. Search, 25-row pagination and a 100 km
nearby filter work across the complete directory. `/api/dollar/game/atlas` is
session-authenticated and exposes public identities and ranking metrics, never
session keys, signing credentials or wallet balances outside the game.

Net worth uses fixed marketplace base valuations for owned resources/items,
game FTH$ and open buy/sell escrow. It excludes uncollected production, buildings,
permanent federation donations and external wallets. Rankings reflect each
account's last saved state; visiting the leaderboard does not advance other
players' production or create funds.

`/atlas/` assigns each established settlement a persistent, unique coordinate
in a 1,000 by 1,000 game-kilometer world. Distances are straight-line kilometers
from your settlement. Existing saves acquire locations lazily without changing
their local terrain, seed, home, exploration radius or chat/visit permissions.
The map derives informational federation territories from the nearest member
settlement on a 25 km display grid; independent settlements keep neutral areas.
Empty federations have no territory. Borders are not player claims or ownership.

The atlas fills the game viewport behind the navigation and resource bar.
Drag or use arrow keys to pan; scroll, pinch or use + / - to zoom (up to 16x).
Home and Fit map restore the whole map; Your settlement recenters it.
The searchable settlement directory and federation legend are collapsible overlays.
Territory geometry is generated only on atlas refresh; camera gestures update a
single composited transform at most once per animation frame, with no idle loop.
The chat overlay joins the authenticated global channel, retaining existing
profile requirements, moderation, message limits and single-chat-tab policy.

Five starting federations have distinct procedural flags, shields and mottos.
Each also has a bilingual origin story, available in expandable cards on the
public World hub and the in-game Federation page. Lore grants no gameplay bonuses.
The shared public header uses direct links without dropdown submenus; the hub
omits duplicate section navigation. Primary game navigation and feature tabs remain.
Each Federation card shows its joining requirements and a member-only link to the
common contribution vault. Choose one when the existing Village/50-relationship requirements
are met; goodwill, membership bonuses, founding costs and voting gates remain.
Newly founded federations get a seed-derived name and matching heraldry;
existing federation names and vault balances are preserved.

## Languages

The public site and simulator default to **English**, independent of the browser's preferred language. The 한국어 / English selector appears in the landing-page footer and the game's account settings. An explicit selection is saved as `featheral-language` in local storage and survives navigation/reloads. `?lang=ko` and `?lang=en` explicitly override the saved preference for the current page; the selector saves its choice and updates this URL. Homepage/game links carry the selected language. If storage is unavailable, an explicit console warning is emitted and these URLs retain the choice across navigation.

Language selection does not modify the session, seed, inventory, pending production, crew assignments, expedition deadlines, or gameplay clock. Resource IDs, command fields, stored server messages, and exported snapshots stay language-independent; user-facing gameplay messages, including existing journal records, are translated when displayed.

The shared catalog in [translations.ts](./src/translations.ts) covers Korean copy and parameterized messages; [i18n.ts](./src/i18n.ts) provides translation and locale selection. [i18n-dom.ts](./src/i18n-dom.ts) localizes text nodes and a strict allowlist of accessible text attributes after each owned render, never command values, CSS classes, IDs, numeric input values, or arbitrary HTML. Parameterized resource/count fields are constrained so unfamiliar text is not accidentally translated as a resource message. Add catalog entries and regression cases whenever adding UI or server-facing messages.

Korean copy uses familiar game terms: 채집팀 (resource crews), 자원지 (resource sites), 주민 모집 (recruitment), 업그레이드, 거래소 (the in-game exchange), and 마을 회관. Exchange controls use 시장가/지정가, 매수/매도, 호가, 미체결 and 체결 내역. Use 받기 for game-resource claim buttons, 수령 대기 for pending resources, and 쿨타임 for recruitment cooldowns. Web3 copy uses 거버넌스, 온체인/오프체인, 컨트랙트, and 제로 주소. Reserve 토큰 클레임 for token-specific disclosures, never game metal; do not describe the prototype as a live DAO, real-time cooperative world, staking product, or token-earning opportunity. Keep the static Korean HTML, metadata, white paper, and catalog wording aligned so English reverse translation still works.

World Hub and Play default to English, independent of browser language. An explicit `?lang=ko` or saved Korean preference still selects Korean. The hub renders English fallback copy with bilingual attributes at build time; localization selects the document language and content. Both languages use explicit number/date locales; the authoritative game clock remains UTC, not local wall time.

## Landing page and public materials

The homepage is the canonical public hub at `/`. Exploration, Settlements,
Marketplace, Federations, Guide, Roadmap and Community introductions share one
bilingual, build-time-rendered page with section anchors. Legacy
`/features/exploration/`, `/features/settlements/`, `/features/marketplace/`,
`/features/federations/`, `/guide/` and `/roadmap/` URLs redirect to the matching
hub anchor in production, Vite development and preview, preserving query parameters.
Static builds also retain forwarding entries and a no-JavaScript continuation link.
The sitemap includes the hub, Community feed and Whitepaper, not duplicate feature pages.
Sample scenes reuse actual game drawing code and are labeled as examples,
never live player activity. Gameplay routes remain unchanged.
Roadmap names the current World-building phase and separates available systems,
pending federation economics and proposed future business/governance direction.
Top-level navigation is World, Community, Guide and Roadmap, with direct Account
and Play links and no dropdown submenus or duplicate section menu.
The logo and World link return to the hub; its feature introductions remain in-page.
Community posting and game routes remain separate working applications. Login,
registration and profile remain dedicated pages with a unified responsive layout.
Switching displays the current identity and keeps its session until a replacement
sign-in succeeds; funds and settlements remain wallet-specific. Connected built-in
wallet registration still reuses that wallet and its password.
World and Community reuse the same navigation template and
explicit navigation font, size, weight and touch-target styles.

World public statistics appear once below the hero, not in the site header. The header retains site navigation and the wallet control.

Explorer and settlement cameras start at 2.1x and 2.4x respectively; wheel and
button zoom remain available. Both 2D maps cache terrain until their scene, camera,
viewport, selection, artwork or environment changes. Rain, snow and storms animate
over the cached scene at up to 30 fps; reduced motion keeps precipitation still.
Settlement drawing culls off-screen cells. Water and character motion is static, and
game button/scroll transitions and pickup particles are removed to prioritize
responsive panning and interaction. Collection-ready header resources use a
high-contrast **Collect** badge and pending quantity; existing pickup fees,
disabled-state explanations and server authorization are unchanged. Header
buttons are borderless, retaining keyboard focus outlines.

Paid pickup now reviews the full-output live market sell value and transport fee
before spending. If selling now would return less than transport, the review
warns explicitly but still allows a paid claim into inventory. Missing market
liquidity shows an unavailable estimate, never a fabricated profit. The review
links to Trade hub route upgrades (future deliveries only), crafting, and buying
transport vouchers. Collect-and-sell still requires positive net proceeds and
shows loss/break-even reasons separately from missing liquidity.

Three single-use vouchers reduce one resource's pickup fee: **Handcart (10%,
stage 0)**, **Freight wagon (25%, stage 2)** and **Shared convoy (50%, stage 4)**.
They use unused decorations and collector permits plus the shared reduced
resource/FTH$ crafting charges (minimum FTH$1 per copy). The strongest owned
voucher is used automatically for paid claims, collect-and-sell and automatic
collection; one voucher per resource pickup, no stacking. Free map pickups and
zero-fee pickups consume none. Fees round upward to the nearest 0.0001 FTH$.
Quotes include the voucher, and failed transactions/cancellations spend none;
receipts replay without consuming again. Escrowed/pending items are unavailable.
Voucher crafting/purchase cost is excluded from the pickup-sale estimate, so
vouchers do not guarantee profit. All three items can be bought/sold in spot
markets; the prior 118-market export and older catalogs remain unchanged, and the
121-market catalog uses signed append-only authorization without resetting keys,
balances, genesis or ledger history.

| Voucher | Item ingredients |
| --- | --- |
| Handcart · 10% | Log seat ×1, Wood 1-week collector ×1 |
| Freight wagon · 25% | Wooden bench ×1, Market canopy ×1, Metal 1-week collector ×1 |
| Shared convoy · 50% | Town information kiosk ×1, Garden boardwalk ×1, Wood 4-week collector ×1 |

The header's resource button opens four-week reserve-depletion charts for Water, Wood
heating, Metal repair and Oil fuel (from Town onward), with weekly consumption and approximate weeks left.
Warnings highlight reserves at or below one week, and critical shortages below
one day or when the server reports a shortage. Each row links to buying that
resource. Forecasts use owned stock and current authoritative weekly demand,
excluding pending/future collections, crafting and trades; climate and population
can change demand. Charts are no longer shown in the Explore sidebar. The
scrollable header dialog keeps forecasts reachable on small screens; its selector
also opens individual resource settings and the FTH$ treasury.

Population management separates **Gathering now**, **Exploring now** and
**Available now**; their sum is the total population. Available residents are
waiting, not inactive/deleted. Two available residents can start an expedition.
Manual assignments are explicitly for the **next work week** and do not cancel
current crews or immediately release them. Auto recalculates at that boundary;
its edit controls start from the actual current crews, not stale target counts.
Client and server share the same counts and editable allocation. Gathering
capacity remains `population - max(2, exploring residents)`: active explorers
count toward the two-person reserve, not in addition to it. Existing half-population
auto target, supply checks, storage limits, fees and full-week deadlines remain.

Completed crew output can be collected **free from discovered resource tiles on
the exploration map**, including at zero FTH$. At most one visible tile per
resource shows a Collect marker, only when completed output is waiting and its
transport fee exceeds the player's FTH$ (Oil still requires the bank). Other
tiles remain travel targets. Map pickup
clears the corresponding transport bill once; it never creates new raw output or
currency. Paid header pickup and paid automatic transport remain unchanged.

Resource warehouse, housing, reservoir, workshop and trade hub upgrades reach
**level 99**, with linear next-level costs. Compact cards show current/max level,
next level, benefit and total upgrade cost. One-time water facilities, bank and
town hall retain their existing unlock behavior.

Warehouse and building upgrades use a shared stacked card layout sized for the
settlement task panel, including on mobile. Each card shows its current/max level,
next-level benefit or capacity, exact physical-unit/FTH$ cost, owned balance and
shortfall. Locked cards name the required settlement tier; built/max-level cards
do not show another paid action. Warehouse upgrades are available at the top of
both Production and Buildings. **Review build / Review upgrade** opens the existing
spending confirmation; cancellation spends nothing and the server revalidates
costs, balances and level limits. Capacity previews share the server's warehouse
formula; prices, unlocks, production timing and the level-99 limit are unchanged.

Crafting supports **one copy without a permit**, or exact atomic batches of
**10, 20, 50 or 100 copies**, consuming one matching bulk crafting permit.
The crafting panel is bottom-aligned with the World chat dock. On mobile and
tablet widths up to 900px, long crafting lists extend over the game header in a
scrolling sheet; its close button and the settlement dock remain accessible.
Click Craft to choose among owned permits; insufficient ingredients or output
space disable the corresponding choice. The largest feasible batch is labelled.
Confirmation shows every batch ingredient, the consumed permit and output count.
Invalid/unaffordable batches spend nothing. Existing single-item commands and
historically accepted retry receipts remain valid.

- `/` is the search-readable landing page with optional live public totals; legacy `/about/` redirects there. Anonymous `/api/stats` reads remain available without cookies or a gameplay session, and the page stays readable if statistics are unavailable.
- `/` opens the simulator; all Start/Play calls to action go there and resume the same browser session.
- `/settlement/` uses the exploration map's shared isometric projection, tile palette, trees, house artwork and weather renderer. Its 21-by-21 local parcel grows through all sixteen tiers, including built banks and town halls. The settlement dock and section navigation open focused panels. Click buildings to manage them. In Layout, drag buildings or owned decorations to empty land cells, or choose Move on map and tap a destination. Coordinate inputs provide precise and keyboard-accessible placement; arrow keys and Enter also select grid cells. Pan by dragging empty ground and zoom with the wheel or buttons. Moves cost nothing and change no gameplay effects. Buildings cannot be demolished or duplicated; decorations can return to inventory without losing their item slot. Occupied cells, water and out-of-bounds positions are rejected by both client and authoritative API. Positions persist across reloads, retries and restarts; legacy six-space decorations migrate without losing items or paid work. New tier buildings find empty cells without displacing custom layouts. The parcel is cosmetic local space, not newly revealed exploration territory. The canvas and camera survive task changes and server refreshes alongside crew drafts, filters, disclosures and panel scroll. Direct `#inventory`, `#crafting`, `#management` and task links, sessions and language preferences remain supported.
- The complete white paper is a dedicated reading page at `/whitepaper/`, English by default, with Korean at `/whitepaper/?lang=ko`, a chapter table of contents, mobile-friendly tables and print styling. Both languages are rendered at build time from the [Korean source](./public/WHITEPAPER.ko.md) and [English source](./public/WHITEPAPER.md), keeping all rules and disclosures intact. The Korean fallback is readable without JavaScript; the language selector uses the site's existing preference. Site navigation no longer opens raw Markdown; both source documents remain available below `/`.
- The homepage includes an original illustrated world, keyboard-accessible gameplay tabs, native FAQ disclosures, community placeholders, and explicit token/simulation disclosures. The simulator's brand link and Field guide link back to the homepage.
- Landing copy leads with playable exploration, resident assignments, weekly gathering, and settlement-to-capital progression in both languages. Calls to action start the free browser game now; do not imply instant production, live multiplayer, token earnings, or active community links that do not exist.
- Featheral Dollar (**FTH$**) is the main game and marketplace currency. Featheral Gold (**FTHG**) is separate and exchanges with FTH$ at a dynamic reserve rate; it remains the future Ethereum-linked token concept. Wallet connection is optional; linking alone does not move funds. In separate World-budget mode, explicit wallet signatures authorize FTH$ deposits to and withdrawals from World funds. There is no cash redemption, token sale or airdrop. The all-zero address is only a placeholder; never send funds to it.

### Publishing links and search metadata

Set the root HTTPS website URL and official GitHub/Discord/X/Telegram URLs in [site.ts](./src/site.ts), then rebuild. Empty channels remain visibly **준비 중 / Coming soon**, with no fake accounts or active notification subscriptions. Nonempty links must be HTTPS without embedded credentials; the site URL must be a root origin, not a subdirectory.

The landing HTML contains the main content, title, description, Open Graph/Twitter text, and WebApplication structured data. The public build defaults to the verified production origin `https://world.featheral.com`, with canonical links, absolute social image URLs and a sitemap for public pages. `/robots.txt` excludes API crawling and points to `/sitemap.xml`. The simulator is excluded from indexing by its own `noindex,follow` metadata. The default Korean social image is `public/images/social-preview-ko.png`; `public/images/social-preview.png` remains the English version. Both use the original world artwork.

The World site serves this build at `/`; `dist/index.html` is the public hub, `dist/explore/index.html` is the exploration game entry, and the remaining HTML entries preserve game, account and whitepaper routes under `/`. Legacy public information URLs forward to hub sections. The repository's `npm start` builds this app before serving it and starts the game API alongside the other World services. Set `APP_ORIGIN` to the exact public HTTPS origin of the World site in production. Deployed servers default to `https://` plus their assigned `world.*` hostname when `APP_ORIGIN` is unset or a loopback origin copied from a development machine, so synced dev settings cannot reject the public site with "Origin rejected." The API remains same-origin at `/api/`; do not expose its internal port publicly. Missing routes and assets remain 404s instead of falling back to the game.

Before public release, supply verified links, confirm the canonical origin, review the white paper/disclosures for the actual deployment, and complete the production/security requirements below. SEO metadata and prototype disclaimers do not make this mock safe to expose publicly.

### Live world totals

Below the hero, four live totals show settlements, residents, World game FTH$ budgets and actual Ethereum FTHG supply. Card values below 10,000 remain unabbreviated; larger values use localized compact units (Korean 만/억/조 or English K/M/B/T) with at most one decimal, including during count-up animations. Hover text and screen-reader labels retain exact final totals, with up to four decimals for FTH$. The live Gold exchange rate remains unabbreviated. Wallets, marketplace displays, accounting and API totals retain their existing precision.

The homepage shows established settlements, stored World game FTH$ budgets and the live Gold exchange rate, and the same global population census as the simulator. Game budgets are not the complete Dollar ledger supply or the separate wallet balance. Circulating Metal is not displayed on the homepage. Its API aggregate remains available: Metal excludes pending production and unsettled visitors' starter supplies; it is not FTHG or cryptocurrency. Settlement/metal deltas commit atomically with claims, trades, spending, founding, and idempotent gameplay actions. Totals retain inactive settlements and their last recorded balances, matching the existing population-retention policy.

Settlement/metal aggregates initialize once from persisted settled worlds. Previously purged worlds cannot be reconstructed; the existing population census is preserved rather than rewritten. Later restarts and session cleanup do not reset these counters.

The **Featheral Dollar · FTH$ circulation** counter reads the authoritative Dollar journal supply, including wallet balances, buy escrow, marketplace reserves and the system treasury. No gameplay grants or new bridge/reward credits increase supply. Gameplay fees move to the system treasury; trades and donations transfer existing balances. Historical deleted balances cannot be reconstructed. FTHG remains on Ethereum; FTH$ is an off-chain ledger currency, not USD.

The client refreshes every **30–35 real seconds**. On arrival, the numbers count up to the real snapshot over 400 milliseconds; later actual changes animate from the displayed value over 280 milliseconds, including decreases. Identical totals do not replay, and nothing grows beyond the last server-reported target. Hidden tabs, unavailable updates, or reduced-motion preferences finish at the known target and stop animation frames; reduced-motion users see totals immediately. Screen readers receive the actual snapshot totals rather than intermediate animation frames. Polling pauses while hidden. On failure the page labels retained values as last known, or shows dashes if nothing has loaded. Invalid or more-than-90-second-old snapshots are rejected.

`GET /api/stats` performs indexed aggregate reads, not world scans or writes. Only successful public responses permit 15-second browser/shared-cache reuse; private game responses remain `no-store`. For production, put this cookie-free endpoint behind a shared CDN/cache, retain `Vary: Origin, Sec-Fetch-Site` and the response security headers, and never cache session/state/action responses. Public reads still have the mock's request limits; this is not a million-player deployment by itself.

## Run

`npm run zip` uses `git archive` to create `featheral.zip` from the latest commit (`HEAD`), replacing any existing archive with that name. It requires a Git repository with at least one commit. Uncommitted changes, untracked files, dependencies and local data are not included unless they were committed; commit the intended source changes before exporting. The generated ZIP is ignored by Git.

```sh
npm install
npm run server
```

In another terminal:

```sh
npm run dev
```

Open http://127.0.0.1:5173/ or http://localhost:5173/. HTTP development accepts the explicit loopback aliases `localhost`, `127.0.0.1`, and `[::1]` on the configured origin's port only. Each hostname has a separate browser session; keep using the same address to return to the same world. `npm run build` type-checks both backend and frontend and builds the application; `npm test` runs gameplay, economy, HTTP abuse, and persistence tests (Node 22.18+). Node's built-in SQLite currently prints an experimental warning. The API listens only on loopback port 3001. Vite proxies `/api` without rewriting Origin.

Restart any existing Vite process after adding this backend so that it loads the new proxy configuration.

For `npm run preview`, restart the API with `$env:APP_ORIGIN='http://127.0.0.1:4173'; npm run server` in PowerShell, then open http://127.0.0.1:4173/. Production hosting must serve the built frontend and reverse-proxy `/api` under **one HTTPS origin**, configured by `APP_ORIGIN`. Never expose the mock directly as a public service.

Both server commands use a continuous **33.6x game clock**: a full game week takes
**five real minutes**, and harder expeditions take ten or fifteen minutes. Clients
cannot set the speed. The store adapter still accepts explicit 1x/10x/20x/168x speeds
for compatibility and tests. Existing clock schemas migrate atomically; elapsed
time is counted at the previously saved speed before switching. Earned balances,
pending output, jobs and game-time deadlines are preserved, never reset.
Session expiry, network limits and stale-display warnings remain on real time.
Authenticated requests retain the 240-per-minute limit per verified canonical
owner rather than per shared IP; linked wallet session aliases share that quota.
Chat retains its separate limit, while anonymous statistics and session creation
remain IP-limited. Quota cleanup runs at most once per second and resets expired
buckets on access. Market catalog reads batch pool, depth, offer and latest-fill
queries without caching executable quotes or changing reserve policy.
Fund reconciliation still checks every balance against the native ledger; a
startup-populated SQLite balance projection follows session inserts, updates,
deletes and transaction rollbacks atomically. Only deterministic account IDs are
memoized. See the root README's concurrency fixture and production limitations.
Actions are bounded to four per second; collection has a 500-millisecond real-time
cooldown, shared by client and server. State polling stays at 30–35 seconds, with
an additional visible-page refresh when the nearest production/recruitment/
expedition deadline arrives. Hidden pages do not poll or paint maps.

## Explore and grow

- Click nearby terrain, use arrow keys / WASD, or tap on touchscreens. Travel to already discovered tiles is instant but never reveals more land. Each unknown destination within reach dispatches **two available residents**, with multiple expeditions allowed. New teams reveal a radius-2 circular survey (at most 13 tiles, fewer when overlapping known land) and become available again on return without moving the player. Equipment expands visibility and destination reach, not the new survey area; already-travelling teams keep their saved radius.
- The Explore sidebar prioritizes **Investigate**, **Explore** and **Invite** side by side, with Investigate left of Explore and **Collect finds** below when finds are waiting. Claim remains in the resource header and Settlement → Production, not the sidebar. Settlement upgrades use a smaller secondary button. Compact links open resident allocation, storage, crafting, and inventory on the dedicated Settlement page; detailed panels and construction controls are not duplicated in the sidebar. On mobile, primary settlement actions are visible immediately in a compact panel below the map, with direct Residents and Settlement links. Founding remains available before settling; advanced details, Water upkeep and upgrades are on the Settlement page. The old mobile drawer and redundant location card are omitted; small screens hide supplementary map decorations so map controls remain usable. Focus and sidebar scroll survive state refreshes; recruitment cooldowns, resource thresholds, resident/metal requirements, and reserved inventory slots still apply.
- A softly feathered fog fringe previews terrain silhouettes less than four tiles beyond every explored boundary, fading into opaque fog with distance on the map and minimap. This is visual only: previews do not discover tiles, unlock resources, or bypass expedition costs, residents, or travel rules.
- Explore **21 terrain types**: meadows, forests, lakes, mountains, oil seeps, crystal outcrops, rainforests, pine forests, mangroves, grasslands, savannas, deserts, dunes, wetlands, rivers, coasts, hills, canyons, volcanoes, tundra, and glaciers. Seeded elevation, temperature, moisture, and river channels create coherent regions, with different colors, landmarks, resource yields, and **1–3-week exploration durations**. Unknown terrain details remain hidden. Starter wood, water, and metal sites are guaranteed within the initial survey. Open water, rivers, coasts, and glaciers cannot host settlements.
- A work week is **seven world days = 168 server minutes = five real minutes at 33.6x**. Every crew and recruitment batch still requires a full week; difficult expeditions take two or three weeks.
- Found a settlement with 12 residents and FTH$0; sell owned resources to fund work. Recruit for FTH$50 per arriving resident: `max(18, floor(population × .12))`. Initial recruitment costs FTH$900, so earn first. Pay upfront and wait one game week; one batch at a time, no automatic repeat. Legacy paid arrivals and cooldowns remain intact.
- Progress through settlement, camp, neighborhood, village, town, district, city, metropolis, and capital. The dedicated Settlement page lists exact requirements.
- Modals and the sidebar use owned-storage meters, automatic delivery indicators, level dots, icon cost chips, and met/locked requirement badges. Expand **All tiers** or the Field guide's rule sections for details; disclosures retain their open state during server refreshes. Icons supplement short labels rather than replacing accessible action names.
- Send **multiple simultaneous expeditions**, limited only by idle residents and FTH$: each reserves two residents and pays its route fee multiplied by `2 ** active field teams` at departure (1x, 2x, 4x, 8x...). Investigate and Explore share the active team count; returned teams no longer increase the next fee. Active teams keep their workers across automatic/manual weekly allocation. Duplicate active destinations are rejected without payment; distinct survey areas may overlap, but contribution counts each newly revealed tile once. Quick exploration and confirmation use the same concurrent quote as the server. Teams return independently, including offline. Existing paid teams and retry receipts retain their original deadlines and costs.
- Craft permanent visibility equipment in the Settlement inventory and equip one item. Campfire kits, torches, lamps, and explorer lanterns give a 5/6/8/10-tile view (unequipped: 4). Better gear affects **future expeditions**, never instant discovery or ongoing teams. Existing torch/lantern upgrades migrate free into owned torch/lamp items, preserving their 6/8-tile visibility.
- **Investigate known land** using two idle residents for exactly **one game week**. Its base cost is **10% of the undiscounted concurrent Explore route fee**, rounded up to four-decimal FTH$ precision with a **FTH$0.10 minimum before equipment discounts**. Only equipped investigation gear discounts this fee, by up to 50%. Each active Investigate or Explore team doubles the next field fee. Quick Investigate chooses the cheapest reachable discovered tile without an active team. Findings are locked at departure: **10% chance** of one collection or activity permit; successful finds are **90% one-week, 10% four-week** permits, never high-tier items or keepsakes. Teams return independently and release their residents; no terrain or contribution is added. Investigations do not block exploration automation. Repeat a known tile after return or investigate different tiles concurrently; shortages, storage overflow, confirmation and exact-once retries use existing rules. Already-paid legacy investigations retain their one-resident, one-day schedule. Explore sidebar buttons show only the action, FTH$ price and compact crew/week indicators; detailed requirements and unavailable reasons remain in tooltips, accessible descriptions and spending confirmations. Sidebar progress bars are 3px high; recurring buttons target 68–72px and secondary controls 36px on desktop or at least 44px on touch layouts. Recruitment retains its live countdown and progress while active. Other pages keep their detailed controls.
- **Stacked item inventory** shows identical owned and market-reserved items once with their total quantity and reservation counts. Each distinct item type uses one slot regardless of quantity; equipped, placed and market-reserved copies share that slot. Mixed stacks remain selectable; fully reserved stacks cannot be used. One-copy equipment/activation rules and protected placed/equipped copies remain unchanged. Pending finds are also grouped by quantity. Each upgrade unlocks 20 slots and one page, up to 200 slots across 10 pages. Empty unlocked pages remain navigable. Full bags accept more copies of existing stacks; new stacks overflow safely into pending finds.
- Sell any resource or unequipped item for FTH$, then buy resources or items in the marketplace. Trading has no bank requirement; production gates still apply.
- **Trader-friendly marketplace:** the initially expanded compact grid browses all 81 markets together; Resources and Item marketplace filter the catalog without changing a prepared order. Search, category, owned-only and reset controls work in either grid or table view. Sort by name, buy price or sell price in either direction, or most owned; unavailable quotes remain last, and prices/quantities use physical units. Table headers are keyboard-accessible sort controls. Buy/sell price buttons prepare a spot draft without spending; only the shared confirmation submits a trade. Resource selling is inside the ticket, retaining Owned/Ready-to-collect source selection, 25/50/75/100% presets and exact physical-unit quantity. Its redundant resource picker and slider are hidden only in Marketplace; other selling surfaces retain them. New resource/source or successful sales default to 50%; manual edits persist across refreshes. Metal uses decimal tonnes; percentage quantities round down to whole lots with a one-lot minimum. 100% includes inventories above 10,000 lots. Item sales retain quick amounts, protected equipped/placed copies and storage limits. Local settlement selling still requires a commercial facility; Marketplace does not. Liquidity donations are collapsed separately. Shared confirmation, 2% spot protection, four-decimal FTH$ accounting, reservations and actual-sale charts are unchanged.
- **Federation:** compact membership, relationship, contribution and assembly cards show actionable eligibility and material shortages. Villages with 50 relationship points can join any of the five starting federations without a fee. Membership is exclusive, and contributions go only to the joined federation. Each starting federation card offers goodwill, with its recipient named in confirmation and the result. Goodwill costs 40 Wood lots and 30 Water lots for +25 to the existing shared relationship score, usable for joining any starting federation. Members at Town with a town hall can vote once on Watershed; a City with **more than** 10,000 residents and 5,000 Metal lots can found its own federation. Costs are displayed in physical units. A direct Federation chat link opens the nearby federation channel. Assembly votes confer no real-world authority.
- **Paid craft-profit analysis:** a confirmed **FTH$100** purchase saves an owner-private latest-quote snapshot for every craftable item, expiring at exactly **one game day** (24 game hours). Purchase and refresh it in Settlement → Crafting; recipe cards show the snapshot's one-copy profit and ingredient breakdown alongside live batch estimates. Reloading and ordinary market polling are free; each explicit refresh costs another FTH$100. Retrying the same request cannot charge twice or extend expiry. For one output copy, full replacement cost includes the crafting fee plus executable full-quantity purchase quotes for every ingredient; profit subtracts that total from executable one-copy sale proceeds. The report fee is separate from per-item profit. Missing ingredient or sale liquidity remains unavailable, never a made-up price; if no profit can be calculated, no fee is charged. Quotes do not reserve funds, items or prices, and profit is not guaranteed. Expired reports hide snapshot figures; live crafting estimates remain separate.
- **Dynamic market rarity:** free rarity, available-quantity and crafting-tier sorts complement existing price, ownership and trend sorts. Item colors and labels follow currently purchasable funded-pool inventory plus other players' active sell escrow: **Legendary 1-9**, **Epic 10-49**, **Rare 50-199**, **Uncommon 200-999**, **Common 1,000+**. Zero is unavailable, not legendary; unavailable and unknown supply sort last for rarity. Virtual liquidity depth, unfunded pools and the viewer's own offers are not item stock. Resource quantities have no item-rarity tier. This describes current market availability, not worldwide supply.
- **Common federation vault:** members can permanently contribute owned Wood, Water, Metal, Oil and FTH$ after exact-amount review. Resource input is whole accounting lots (each option shows its physical size); FTH$ accepts four decimal places. The vault displays all contributed quantities and FTH$, every member's all-time and current-game-year totals, and both contribution percentages. Resources are valued at the existing fixed marketplace base price per lot at deposit; FTH$ is valued one-for-one. Values are recorded in four-decimal integer units and never revalued with spot prices. Exploration points and goodwill costs are not vault contributions and are not backfilled. Game-year records persist in `game.sqlite`; the current annual denominator resets at the existing 52-week year boundary, never at a real-calendar anniversary. Native Dollar journals debit the World budget and credit a federation-specific escrow with balanced, exact-once recovery; no minting, burning or automatic wallet transfer occurs. Public FTH$ and Metal totals include the vault. Tax collection, payout rate and eligibility remain pending: annual shares are retained for future tax distributions, but no tax, withdrawal or payout is enabled.
- **Channels and chat:** searchable nearby public rooms keep the current conversation and per-room drafts intact during filtering and directory refresh. Phones use a compact room selector; settlement visit and profile settings are accessible icon controls. The auto-growing composer sends with Enter (except during IME composition), uses Shift+Enter for a newline, and shows the three-second cooldown. Failed sends retain text and reuse the original submission ID on Retry. Reading position and unread controls are preserved rather than jumping when returning to the tab. Connection/profile errors and reconnect controls remain explicit; public visibility and 100-message retention are unchanged.
- **Allocation is resource-based, automatic by default, targeting 50% total utilization.** The new weekly gathering budget is `max(0, min(floor(population / 2) - active explorers, population - max(2, active explorers)))`. Auto prioritizes one week of Water replacement, then shares remaining workers across growth and maintenance materials before surplus gathering; it does not prioritize filling the whole Water reserve over materials. Wood/Metal goals include two peak-climate upkeep weeks. Priority demand cannot exceed the budget. Winter without Water facilities can require a Well or manual allocation. Active paid jobs finish before new allocations apply. Explorers at or above the target pause new gathering rather than cancelling paid expeditions. Manual allocation can exceed 50% while retaining active explorers and the two-resident exploration reserve.
- **Extra automatic gathering fills only the remaining 50% budget.** Workers choose the highest storage-limited reference value after transport, with stable distance/resource tie-breaking. All resource transport is paid at pickup; cash shortage does not prevent a new gathering job, but does prevent taking its completed output into owned inventory. Full storage, unavailable routes and supply shortages can reduce utilization below the target. Extras cannot displace priority crews, exceed storage, use locked resources or produce fractional-week rewards.
- **Manual population allocation:** use the +/- buttons, release a resource slider, or enter an exact count directly, even while auto mode is on; saving an edit switches to manual mode. Exact counts save when editing finishes or Enter is pressed. Requests are serialized, with rapid edits coalesced to the latest committed value while other requests finish. Sliders and number fields stay synchronized through server refreshes. Saving and failed-save states are visible; failed drafts remain available with a Retry action. Limits are rechecked against the latest server state, preserving active explorers, the two-resident exploration reserve and other saved assignments; invalid or newly out-of-range drafts show an error instead of being silently applied. Paid crews and weekly deadlines are unchanged.
- **Explore quick actions and countdowns:** Explore and Recruit share one two-column row in the desktop sidebar and always-visible mobile action panel. The sidebar no longer duplicates Claim; use the resource header or Settlement → Production instead. Recruitment, the next returning expedition, individual expeditions and active gathering crews show completion bars, percentages and compact game-time countdowns. Recruitment displays the arriving batch size instead of its already-paid cost. Bars derive from persisted deadlines and fixed job durations (including two-/three-week expeditions), advance on the authoritative clock, freeze after the existing stale-sync cutoff, and show “Awaiting server confirmation” at 100% without granting arrivals, discoveries or resources locally.
- Sidebar action costs use a high-contrast spending panel with the resource name and a larger amount. Disabled actions keep their costs readable, with insufficient resources highlighted; active recruitment still hides its already-paid cost. Construction and other existing cost chips are unchanged.
- The header resource button opens weekly reserve-depletion charts with low-supply warnings and direct marketplace links; Explore's sidebar does not duplicate them. Detailed Water upkeep cards elsewhere retain their fixed height. Timers use compact server-time `mm:ss` (or `h:mm:ss`), with full timing in the accessible label; “Confirming” at zero still waits for the server. Daily consumption, clock speed and stale-sync behavior are unchanged.
- **Mobile navigation and Account:** five primary tabs keep Explore, Settlement, Market, Communicate and Federation easy to reach. The avatar beside the game clock opens a right-side account pane, full-screen on mobile, with the available FTHG balance, language and world-condition display settings. Activity and the Field guide open as subviews inside that same pane, with a Back to account control; the underlying game page and URL remain unchanged. Activity keeps search and snapshot/recovery exports, and the guide keeps all chapters, screenshots, search and reading progress. Guide chapter links scroll only the pane, without changing game hashes. Account drafts and scroll position survive returning from these views. Dedicated Journal/Help URLs remain available for existing links. FTHG balance counters are no longer duplicated in the shared header or Marketplace heading; order costs and affordability checks remain unchanged. Display preferences are local to the browser.
- **Wallet / withdrawal preparation only:** Account can request a connection to an injected EVM browser wallet and reacts to account, network and disconnect events. It never requests signatures, transfers tokens, authenticates the game account, or stores wallet credentials. Withdrawal inputs accept positive multiples of **1,000 FTHG**, capped by the authoritative available balance (excluding escrow); fractional remainders stay in the game. Actual withdrawals are explicitly unavailable and the submit button stays disabled, even with a valid amount and connected wallet. No FTHG is deducted. A payout network, token, conversion policy and service must be configured before real withdrawals can be implemented.
- **Phone-first layout:** all five resource/currency controls remain visible, including undiscovered Oil. Compact balances retain exact accessible values. Population health and full resource/population management open in responsive dialogs without leaving the page. Settlement's existing dock, collapsible marketplace catalog, sticky chat composer, account pane and safe-area navigation remain intact. Spending confirmations show transport and protected sale proceeds; wallet limitations and server authority are unchanged.
- **Unified spending confirmation:** exploration (map clicks, quick exploration and keyboard movement into fog), recruitment, founding/upgrades, facilities, warehouses, item-storage expansion, crafting, paid diplomacy, resource pickup, collect-and-sell, auto-collection activation and marketplace purchases/sales use one Korean/English confirmation dialog. It shows resource/FTH$ costs, consumed items, assigned/arriving residents, duration and relevant timing/held-order notes. Market purchases show their maximum payment and sales their minimum proceeds, preserving four-decimal currency limits. Cancel, Escape or an outside click spend nothing; focus returns to the triggering control. Duplicate submission and background game movement are blocked while reviewing. Gameplay requirements are refreshed before submission; changed quotes require a fresh review rather than silently accepting a new cost. Free travel, equipment/layout changes, allocation settings, votes, federation joining and market-offer cancellation remain immediate; item-enabled auto-collection and daily upkeep are not interrupted by dialogs. The server remains authoritative; full-week work timings are unchanged.
- Weekly baseline yield **per worker** is 500 kg timber, 1,500 L Water, 100 kg Metal or 2 bbl Oil. Settlement tier no longer multiplies physical output; population growth supplies more workers instead. Terrain efficiency, facilities, federation bonuses and the week’s season/weather/temperature factor still apply, then output is rounded down to accounting lots per worker. Oil requires a discovered matching deposit and city bank. FTH$ is not a gatherable resource. New jobs lock their yield at departure; paid work is never recalculated. Unassigned residents produce nothing. At baseline, one Water worker supplies about four residents; cold weather needs reserves, additional workers or Water facilities.
- **Zero-resource onboarding:** new games receive no Wood, Water, Metal, Oil, FTH$ or FTHG. In Explore, manually gather up to the founding requirement: 60 Wood lots (3,000 kg) and 40 Water lots (400 L). The initial known clearing and lake at 3, 0 make this possible without funds. Founding consumes these supplies and welcomes 12 residents. Hand gathering then stops; crews can start full-week production without upfront Dollar, but pickups still charge transport. The zero-balance **Collect and sell** link opens Production: sell completed output to cover its transport from funded sale proceeds, then collect Water and fund growth. Existing saves and earned balances are not zeroed. Storage and shortage rules remain unchanged.
- **Water facilities** are permanent, one-time constructions: **Well** (3,000 kg timber + 0.2 t Metal, +100% Water output), **Rain collector** (6,000 kg timber + 0.45 t Metal, +200%), **Pumping station** (12,000 kg timber + 0.9 t Metal, +400%). Bonuses add to give **8× baseline Water per assigned worker** with all facilities, before climate adjustments. They grant no residents, instant Water or recurring fee. Bonuses affect new full-week crews, not locked deliveries. Moving facilities does not change output or storage.
- **Daily Water:** baseline household use is **50 L/person/game day** (5 accounting lots), inspired by a service-level target rather than a universal average. Heat, summer and hot clear weather increase demand, rounded up once per population bill to 10 L lots. Shortages pause new advanced production, exploration and recruitment and contribute to gradual weekly population decline; paid work is not cancelled. Water crews and basic Wood gathering remain available. Daily deadlines, same-time arrivals and offline/online equivalence are preserved.
- **Daily heating, repairs and fuel:** Wood uses an estimated **2 kg/person/game day** reference rate, adjusted by heating-degree temperature, season and wet/stormy weather. Metal repairs use **0.2 kg/person/game day**, increased by rain, snow, storms and temperature extremes. All eight daily weather periods contribute. Oil fuel starts at the **Town civilization tier**, regardless of Town Hall ownership, and doubles each tier: **0.001 bbl/person/day** at Town, **0.002** District, **0.004** City, **0.008** Metropolis, **0.016** Capital. Oil demand is not climate-adjusted; existing activity costs remain separate. Fractional bills carry forward at 1/10000-lot precision until a whole accounting lot can be consumed; inventory stays integer-compatible. Only owned resources are consumed, never pending pickup. Existing settlements receive a fresh Oil first-day deadline without retroactive Oil billing or resetting Wood/Metal deadlines. Supply shortages stop new exploration and recruitment (including automation) and contribute to weekly population decline, preserving buildings and paid jobs; basic gathering, collection and trade remain available. Consumption shares the daily event loop and bounded climate-prefix calculation; offline processing stops at every population boundary so later bills use the changed population and tier. Automatic allocation includes two weeks of Oil demand in reserve goals. Resource details, daily meters, forecasts and Korean help expose the new demands. Resource pricing and reserve-authority catalogs are unchanged.
- **Weekly population and downgrades:** a fully supplied nonempty settlement gains `max(1, floor(population * 0.01))` residents each game week, without FTH$ rewards or a recruitment fee. Daily Water, Wood, Metal and active Oil bills track the week's actual demand and unmet demand. The largest resource's unmet-demand fraction sets loss at `population * 0.05 * fraction`, capped at 5% total, not compounded across resources; fractional resident losses carry forward, and a fully supplied week clears that carry. Zero Oil demand before Town does not prevent growth. Supply recovery midweek does not erase earlier shortages. Population can reach zero; paid recruitment can restore it, but zero population does not generate natural arrivals. At weekly updates, a settlement downgrades as many tiers as needed when `population < current tier requirement / 2` (strictly below, never at equality), stopping at Settlement. Buildings, items, home, paid crews/expeditions, arrivals and funds remain; tier-gated actions use the lower tier, and re-upgrading is manual with normal requirements. Old saves start a fresh population week without retroactive growth/loss. The server persists the deadline, supply counters and fractional losses atomically, updates census deltas, and never applies a week twice. Settlement production shows the next update and last change.
- **Paid pickup and recovery:** all new crews pay `workers*(1+max(0,ceil((effectiveDistance-4)/4)))` FTH$ on pickup, including Wood and Water. Gathering can start with zero FTH$, but completed output stays pending until transport is paid. Collect-and-sell collects all whole completed lots, sells the selected quantity (50% by default), stores the rest and deducts the full pickup fee from proceeds. The selected sale must cover transport and protected minimum net proceeds; bad quotes and insufficient liquidity roll back everything. The collection quote endpoint accepts an optional whole-lot `quantity`; omitted quantity retains the historical full-sale quote. Fractional pending output remains pending. Two explorer slots remain reserved. No currency grants or free transport are introduced.
- **Owned and pending storage:** active residents complete a full game week before resources become ready to collect. Each resource has its own header control. Owned stock and pending output share capacity; Water planning also reserves space for upcoming consumption of owned Water, never unclaimed Water. New jobs reserve their output space at dispatch. Raw capacity is the largest of `100+tierIndex*100+warehouseLevel*500`, the next/current tier's largest material requirement multiplied by `warehouseLevel+1`, and two peak-climate weeks of population-scaled Wood/Metal upkeep. Water capacity is `max(rawCapacity,ceil(population*35*1.5)*(2+reservoirLevel))`; the fixed extra 29,000 L allowance is removed. A 12-resident Settlement without upgrades holds 12,600 L Water, including hot-weather reserve. Warehouse costs are `targetLevel*(4,000 kg timber + 0.2 t Metal + FTH$50)`, up to level 99. Existing stock, pending fractions and full locked deliveries remain even above smaller limits; new gathering waits for room. Escrow, receipts and deadlines are preserved.
- **Timed auto-collection:** original expedition finds last 1, 4 or 12 game weeks. Craftable individual-resource and all-resource bundles last 4, 12, 26 or 52 game weeks. Activation consumes one item and stacks duration independently on each affected resource's remaining time. Insufficient FTH$ keeps completed resources and fees pending; automation does not sell Water, waive transport or bypass Oil's normal unlock. Unused consumables may be owned in multiples, using one item slot each. The persisted collection policy and original discovery durations are unchanged.
- **Collector recipes:** for each resource, 4 weeks uses four 1-week permits; 12 weeks uses three 4-week permits; 26 weeks uses two 12-week and two 1-week permits; 52 weeks uses four 12-week and one 4-week permit. All-resource bundles consume the same recipe for **each of Wood, Water, Metal and Oil**. Each recipe conserves total time per resource, without extra raw-resource or currency costs. Only owned, unused original permits count as ingredients, not pending finds, active timers or market escrow. Batches consume all inputs and add all outputs atomically; combining in a full bag is allowed when the resulting contents fit.
- **Tradable names and titles:** settlement/region naming permits and six fixed player-title badges (Pioneer, Explorer, Steward, Artisan, Trader, Naturalist) are resource recipes and expedition finds. Use one owned permit from **Names & titles** in inventory, review the exact name/title, then confirm. Names allow 2–40 Unicode letters/numbers with spaces, apostrophes, periods or hyphens, normalized before saving. Invalid or unchanged values consume nothing. Region names are settlement-region display labels only; neither names nor titles change geometry, ownership or permissions. Names appear in the settlement/account and chat directory, and titles in the account and new chat messages; historical messages retain their title at sending. Unused copies trade like collection permits.
- **Unified resource header and population management:** Wood, Water, Metal, Oil and FTH$ share one flat strip on desktop and mobile. Resource buttons directly collect completed output and show owned stock, storage bars and ready-output badges. One separate **Resource settings** button opens the last-used resource or FTH$ view; its persistent selector switches between all four resources and treasury without closing the dialog. Individual resource settings remain available in production and crew panels. FTH$ also opens resource-sale funding directly. The population-health control visualizes total, active and unallocated residents, warns below a one-week Water reserve or two available explorers, and opens the same full population manager used in Settlement.

- Resource panels show completed output, FTH$ pickup fees, full-week progress and active automation expiry. Daily Water consumption is separate from transport.
- The shared header shows **Year · Week / 52 · weekday · HH:mm**, day/night lighting, week progress and four season ticks. **5 MIN / WEEK** identifies the default continuous pace. One game day takes about 42.86 real seconds; a season takes 65 minutes and a year 4 hours 20 minutes. Existing game-time deadlines remain intact. Header calendar updates are limited to once every five real seconds, with smooth transform-based fills; work countdowns still update every second independently. Work, storage, population and native progress bars transition smoothly unless reduced motion is requested. Both maps skip hidden/disconnected/zero-sized canvases, preserve interaction redraws and animate precipitation over cached terrain. The minimap redraws only when exploration, position, home or season changes. Visible keyboard focus remains available.
- The header population-health control shows **total**, **active**, and **unallocated** residents with an activity bar and healthy/warning/critical indicators. Tap it to open the same recruitment, allocation and exploration manager used in Settlement. Health accounts for Water supply and available explorer capacity. Counts come only from the authoritative state; simulated neighbors do not contribute. Federation/global totals remain available on their relevant pages and through the API, including inactive settlements in the global aggregate. Recruitment countdowns use the synchronized server clock, freeze when synchronization is stale, and always submit to server validation.
- A visible **Population** heading groups aligned population icons. **Active** and **Idle** counts describe your settlement only: active means residents gathering or exploring, while idle is the server-confirmed `availableWorkers` count, including reserved explorers. Pending recruits are excluded until arrival; queued allocations and unfunded workers are not counted as active work. Exact totals and definitions are available in the settlement population tooltip and accessible label. Narrow screens retain these details in a compact population row.
- Simulated weather changes on three-server-minute windows (about 5.36 real seconds at 33.6x). Temperature, seasonal terrain colors and day/night lighting follow the same server-time model; reduced motion keeps precipitation still. New work locks its climate-adjusted yield at dispatch.
- Collapsed weather shows a single colored overall-impact icon, not the six effect percentages. Expand it to see signed production, recruitment and water-demand estimates. The indicator equally averages four production modifiers and recruitment, subtracting increased water demand: best at +5% or more, good from 0% to below +5%, bad above -25% to below 0%, worst at -25% or below. It describes current conditions, not guaranteed outcomes or daily averages. Phone weather and menus remain compact.
- The visual clock advances each second using the latest server timestamp plus monotonic elapsed time multiplied by the server-provided clock speed, not the device's wall clock. Recruitment countdowns use this same interpolation and display server-time durations. The display freezes and shows **SYNC PAUSED** if no fresh server snapshot arrives for 90 real seconds. Balances and pending rewards are never interpolated and remain server-confirmed.

Progress and pending production are persisted by SQLite in `.data` (gitignored); restarting the API preserves balances, sessions, and the most recent action receipt. Back up this directory using SQLite-aware backup procedures. Protect it with OS permissions; it contains private session data. The anonymous browser cookie grants access to one world for seven days. Losing/expiring that cookie loses access; mock identity has no recovery. An expired cookie retained by a client must be cleared before creating a new anonymous world.

Existing worlds retain inventory, population, explored coordinates, pending balances and active expeditions. A one-time persisted migration settles legacy completed crews under their old free rules, preserves unfinished delivery deadlines without transport backcharges, removes tile assignments and enables automatic allocation for subsequent weeks. Existing fractions are preserved unless storage overflow discards them. Crews and expeditions retain absolute game-clock deadlines across restarts and clock-speed changes.

Journal and Field guide export informational server snapshots, **not importable balances**. Existing local saves are untouched; Field guide can export them separately. Browser storage and browser clocks are never accepted as authoritative state.

### Marketplace

The header displays the spendable **FTH$ balance**, refreshed from authoritative state after trades and other balance changes, excluding order escrow. Compact text, tables and trade tickets fit more information while preserving 44px touch targets and mobile inputs of at least 16px.

The marketplace card grid highlights artwork, category, holdings, distinct Buy/Sell quotes and FTH$ units. Missing liquidity is shown as **No quote**, never a sentinel price or invented return. Table browsing and order safeguards remain. FTH$/FTHG conversion is now on **Featheral Bank** (`/bank/`), opened from the Account FTHG card. Account groups balances and quick resources first, keeps settings handy, and folds wallet/withdrawal preparation into a separate expandable section.

### Featheral Bank and council staking

The bank reuses the unchanged Gold exchange API, reserve formula, 1% spread and 2% conversion protection. Staking is an **in-game** feature, not on-chain staking or a guarantee of cash returns.

- Stake available FTHG for **1, 2, 5, 10, 20 or 30 game years**, each exactly 52 game weeks. The bank displays real-time estimates using the current server speed (4 hours 20 minutes per game year at 33.6x). A speed change changes estimates, not saved game-time maturity or independent on-chain authorization.
- At deposit, lock `valuation = floor(FTHG subunits × Gold-pool FTH$ subunits / Gold-pool FTHG subunits)`. Lock simple interest `floor(valuation × APR basis points × years / 10,000)` in FTH$ subunits. No compounding or later repricing applies. Confirmation shows valuation, APR, principal, full interest, game-time term and real-time duration; stale rates or valuations require a fresh review.
- Anyone may **irrevocably donate existing FTH$** to the reward treasury. The entire interest obligation is reserved atomically before acceptance. Insufficient funding rejects a stake without spending; principal is never used to fund interest and no currency is minted. At maturity the owner explicitly receives the original FTHG principal and reserved FTH$ interest. No early withdrawal is available.
- Server-appointed councillors propose annual rates between 0% and 100%, in 0.01% increments. A proposal includes the proposer's affirmative vote; approval or rejection requires a strict majority of all appointed members. Each member votes once. Membership changes cancel pending proposals. Approved rates apply only to future stakes; a missing council, unapproved/zero rate or unfunded reward blocks staking.
- Configure `BANK_COUNCIL_IDS` with comma-separated **existing account IDs** (the SHA-256 session IDs in SQLite, not bearer cookies or CSRF tokens). An omitted variable preserves the existing council; an explicit empty value removes it. Invalid or duplicate IDs refuse startup. Council appointment is server-only, never an unauthenticated client action.
- Council accounts and owners with unclaimed positions are exempt from ordinary expired-session cleanup. Bank visits renew their HttpOnly cookie for up to 400 real days; account rows and expiry columns stay synchronized. Do not clear this anonymous browser identity: exports cannot restore access, and this prototype has no wallet-based account recovery.
- Bank commands and receipts share the authoritative SQLite transaction, revision, CSRF and four-decimal accounting. Public counters and the permanent supply ceiling include treasury rewards and locked principal, preserving the original monetary-policy fingerprint.

The standalone `/market/` exchange has **81 unique markets**: four raw resources, ten original crafted items, eight naming/title items, 21 keepsakes and 38 automation permits (12 original collection, 20 crafted collector bundles, three exploration and three recruitment). All assets share gently moving spot liquidity, player-order matching and a 1% spread. Existing cost/effect-based seed prices remain unchanged. Starting scarcity determines inventory: keepsakes target 100 units, other assets 10,000. Buys and item orders support up to 10,000 whole units, subject to balances and item storage; resource sales can use the full owned amount within safe accounting limits. Each distinct item stack occupies one slot, including all owned and reserved copies. One equipped/placed copy is protected, but spares can be sold. Keepsakes remain unique per player and trade one at a time, including system spot trades.

All markets use the existing pinned nine-times virtual pricing depth; depth is neither spendable money nor inventory and never grows with refills. Sale-sized replenishment converts available origin FTHG at the active Gold rate and adds real FTH$ without reseeding inventory. Finalized Ethereum holdings, pending obligations, finite allocation caps and accounting precision still constrain backing; no automatic Ethereum transfer is sent. When origin backing is depleted, replenishment stops without spending the Dollar treasury. Remaining real pool funds and player bids can still pay sellers. Historical resource/treasury transactions remain replayable; new `market-liquidity` entries reject treasury fallback.

The public World roadmap marks **World building** as active. Subsequent milestone gates are standalone revenue validation, consent-based ecosystem integrations and accountable Web3 governance for future innovators. Foundation home, Docs and Principles carry the connected full-picture roadmap; proposed revenues and governance are not claimed as launched services, investment returns or token-holder rights.

Adding the 28 identity/bundle markets and 21 keepsake markets uses the explicitly approved target list in
[`market-expansion.js`](../../../services/gold/market-expansion.js). Deployment
preflight permits only these exact additions, never removal or repricing of
existing markets or changes to monetary/collection policy. On the live writer,
startup appends one `GOLD_MARKETS` journal transaction signed by **both original
game and Gold authorities**, pinned to the preceding ledger tip. It changes only
market eligibility: no balances, caps, allocations, pool seeds, escrow or
Ethereum funds move during authorization. Repeated startup is a no-op; replay
preserves the original genesis block and all prior history. New pools are funded
on demand through the existing finite reserve rules. Replicas must run code that
supports `GOLD_MARKETS` before ingesting the new transaction. Do not downgrade to
a release lacking the approved catalog after authorization, reset ledger data,
rotate keys or bypass preflight.

During managed deployment, preflight marks approved additions as pending.
The historical `liquidityTargets()` export remains the original 32 liquid
markets so an already-running self-sync worker can perform its old exact-match
bootstrap check. `authorizedLiquidityTargets()` retains the 60-market
identity/collector catalog for workers from that running release; they cannot
approve relic additions with their old allowlist. The fetched installer and new
gateway explicitly use `reserveLiquidityTargets()` (81 liquid markets). The installer's expanded
comparison still rejects changed original targets and unapproved additions
before any cutover; passing the legacy check does not authorize funding.
Startup validates both signatures without committing the expansion. The installer
signals that specific gateway process only **after all gateway/HTTPS health checks
and PM2 persistence succeed**. Before that point, ordinary rollback remains safe.
Once authorization starts, an unconfirmed outcome retains the HTTPS-verified
candidate for operator review instead of restoring an incompatible old reader.

Exploration and recruitment permits last 1, 4 or 12 game weeks, like collection permits. Activate from inventory or Population → Allocation & automation; activation consumes one copy and stacks its duration. Auto-exploration keeps one team travelling and waits for all existing manual teams to return. Auto-recruitment starts the next paid batch after the previous arrival. Both use normal FTH$ fees, Water requirements and full-week deadlines; recruitment includes housing bonuses and their cost. Blocked activity exposes its reason and retries once per game day. Pausing or expiry prevents new jobs, never cancels paid jobs, and does not stop the permit clock. Offline settlement follows the same scheduled events as frequent polling.

Player limit orders use price-time priority and cannot match themselves. Better player offers take priority over resource pools. Exact integer accounting uses 0.0001 FTH$ subunits. Spot orders enforce a maximum 2% total-price movement and either fill completely or fail without spending. Live pools start empty and can receive permanent donations of existing funds and owned assets. Gold can bootstrap each eligible market once, up to 10,000 accounting lots at its unchanged genesis-pinned seed price.

Resource prices have no fixed commodity floor; only the accounting increment remains.
The resource curve pins virtual offsets of nine times its first funded inventory
and dollars in `market_resource_depth`, providing tenfold initial pricing depth.
Both directions use the same curve and conservative rounding, with no profitable
round trip. Offsets are never spendable or recalculated on trades/refills. Actual
inventory and dollars cap execution, including collect-and-sell and half-sales.
Other item pools keep their ordinary curve. Existing balances, receipts, valid
low-price orders, filled history and genesis reserve seeds are preserved.

An authenticated settled player's resource sale quotes and trades check funding
for the actual owned/pending quantity, including large half-sales. Funding solves
the shared sell curve against real reserves and the matcher’s final marginal
accounting increment. This prevents historical sub-increment prices from returning
an unavailable quote despite ample origin backing. Sufficient funds require no top-up.
Gold converts verified origin FTHG first using its active rate, issuing quoted
whole-game-unit FTH$, updating allocated Gold and the dynamic rate. The original
finite cap and confirmed origin holdings less pending obligations bound issuance.
Initial resource inventory seeds once; subsequent signed `resource-liquidity`
journal operations add only dollars.

Only after actual origin holdings are zero at a finalized Ethereum block and all
incoming obligations are reconciled does funding use existing available system
treasury FTH$. Exhausting the allocation cap while tokens remain at origin blocks
new conversions and asks for authorized Ethereum settlement; it never silently
falls back to treasury. Redemption escrow is never spent. Exhausted backing or
failed verification is explicit; orders never partially spend inventory on failure.
Conversions remain off-chain obligations, not automatic Ethereum transfers.
Historical treasury-only entries replay unchanged, but new entries require an
updated ledger reader; older releases cannot replay this new operation.

Physical production and consumption quantities are unchanged. The expandable
market reference values them at the current Buy/Sell ticker, not a static price.
Automatic crew planning retains its stable physical-value estimates (not price
guarantees), keeping needed Water prioritized and offline behavior unchanged.
Per-unit displays retain enough precision for very small Water prices.
Reserve seed prices remain immutable and separate from trading floors. In
particular, the existing Oil reserve seed is FTH$24/lot even though the trading
base is FTH$30/bbl; the shop can pay FTH$30 only while its existing funds cover it.
Deployment preflight refuses changes to the live reserve manifest before cutover.

Buy orders escrow FTH$ and sell orders escrow owned assets. Partial fills retain unfilled escrow; cancellation returns it. Item bids and asks reserve inventory slots. The limit is 50 open orders per session; orders expire with the seven-day session. Raw quantities are 1–10,000 accounting lots with the physical increments below. Items use whole pieces; collectibles use one. Limit prices are FTH$0.0001–1,000,000 per accounting lot with four decimals, converted to physical-unit display prices. Charts show the latest 120 real executions, never fabricated history. Quotes refresh every five seconds. SQLite persists both accounts, escrow, reserves, trades and idempotent receipts atomically.

FTH$ and Featheral Gold (FTHG) are separate balances, each stored as 10,000 integer subunits per unit. APIs expose ordinary amounts, not subunits. Gold remains the future Ethereum-linked token concept, not the marketplace quote currency. A separate reserve pool buys and sells fractional Gold (0.0001–10,000), with a live reference rate, 1% spread per side and 2% confirmation protection. A fresh world's pool starts with 1,000 Gold and FTH$1,000,000: FTH$1,000 per Gold before spread. Trades move the rate and retain fees in the pool. An existing world preserves its former market Gold reserves in this pool and seeds the corresponding FTH$ reserve at the same initial reference rate.

The version-4 migration converts owned and pending Lithium to FTH$ 1:1, preserves existing Gold wallets, cancels old Gold orders and refunds Gold buy escrow or original sell assets. Paid resource work and expedition deadlines remain; Lithium crews and allocations are removed. Historical Gold pools, orders, fills and receipts are archived in `legacy_gold_market_*`, never relabelled as FTH$ trades. Weekly income is disabled under the subsequent no-mint rules. Stale receipts and revisions are invalidated. Invalid balances or orphan escrow roll back the whole transaction; restart never refunds twice.

### Finite FTH$ balances and spending

New players and founding settlements start with **FTH$0**. Residents, banks, commercial buildings and exploration never grant FTH$, including offline time and previously dispatched expeditions. Existing balances, buildings, paid work and receipts remain intact; there are no retroactive refunds. The no-mint rule invalidates stale new action revisions once.

Recruitment still costs **FTH$50 per arriving resident**. Exploration still costs FTH$ by distance/difficulty but rewards discovery and collectibles, not currency. Transport and upgrades consume FTH$. Marketplace sales transfer existing player escrow or pool reserves into the seller's wallet; Gold exchanges transfer existing reserves. Initial market reserves are provisioned once and never replenished by gameplay. No action mints new FTH$, and fixed-price legacy trades and global currency reward claims are disabled.

New recruitment batches start at **5% of current population**, rounded down with
a minimum of one resident. Housing and climate apply before a final cap of
**20% of current population, rounded up**. Manual and automatic recruitment share
this rule and charge only for the final arrivals. Already-paid batches retain
their stored arrival counts and deadlines.

Commercial buildings retain ownership, placement and costs but generate no income: Market stall (Camp; 4,000 kg timber + 0.4 t Metal + FTH$200), Commercial workshop (Neighborhood; 10,000 kg timber + 1 t Metal + FTH$600), Trade hub (Town; 25,000 kg timber + 3 t Metal + FTH$1,800). The bank still unlocks Oil collection and resource trading. FTH$ is simulated game currency, not USD or an on-chain token; cash withdrawals are disabled.

**Settlement → Sell resources** is available immediately after founding, without a bank or commercial building. Review the current funded quote to sell `floor(owned / 2)` of every raw resource in one confirmation. Pending stock and sell-order escrow are excluded; zero quantities are skipped. Exact halves above 10,000 units are supported. Each resource uses static base pricing (or better player bids) and retains conservative 2% minimum-proceeds protection. One atomic transaction sells everything or nothing, including player orders, pool movements and fills; retries cannot sell twice. Selling Water can reduce upkeep reserves, so review the Water warning before confirming.

Authenticated Dollar routes include `GET /api/dollar/game/market?asset=metal&quantity=1`, `POST /api/dollar/game/market/actions` and `GET /api/dollar/game/market/half`. Submit `{type:'sell-half', sales:[{asset,quantity,limitDollars}]}` with the existing UUID, revision, Origin and CSRF protections. Snapshot `income` remains `{weekly:0,readyAt:0}` for compatibility; `game.dollars` stays integer subunits. FTHG conversion belongs to Gold's `/conversion/`, not a World bank.

### Permanent monetary policy, version 1

Ordinary FTH$ credits and staking rewards remain closed. Only signed Gold operations may issue finite origin-backed market liquidity; World cannot issue dollars. Gameplay payments transfer to the **system treasury** without changing supply. Historical burns replay unchanged. Trades transfer wallet, escrow and pool balances; pool spreads stay in reserves. Resource prices remain demand-driven without commodity floors. Without a configured finite Gold engine, zero-funded pools require voluntary donations of owned assets and existing FTH$.

**Isolated finite-reserve exception:** the opt-in test deployment uses Gold-authorized initial allocations capped by verified finalized origin holdings, at 1 FTHG = 1,000 FTH$. Dollar uses treasury funds first and issues only the exact reserve-backed deficit for one-time market bootstrap. No repeat refills, staking rewards or personal grants occur. Unsynced backing cannot redeem; redeemed FTH$ remains locked until confirmed returned FTHG is reconverted without increasing supply. Gold shows actual holdings separately from pending obligations and offers a prominently warned sync preview, not Mainnet submission. The live ledger remains unchanged. See the root README for isolation settings and production prerequisites.

**Authorized live activation:** `GOLD_RESERVE_MODE=live` enables the same finite funding model on an unused zero-supply Dollar ledger after backup. A signed `GOLD_POLICY` block preserves the original genesis and existing settlements. Market funding becomes available on first use after founding; sell owned resources to obtain FTH$. No Ethereum transfer is submitted, and unconfirmed backing still cannot redeem. Previously issued ledgers require a separate migration and are refused.

Non-resource item pools use one integer constant-product rule. With currency reserve R, asset reserve S and quantity q: buys pay `ceil(R*q*101 / (100*(S-q)))`; sells receive `floor(R*q*99 / (100*(S+q)))`. Resource shops instead pay/charge `q * resourceBasePrice` in exact FTH$ subunits, capped by real funds/stock. Orders retain 2% quote protection. Gold's reserve conversion rate is separate from gameplay resource base prices.

The game policy fingerprint and measured opening supply are persisted. Startup refuses changed policy constants; the authoritative Dollar journal, not that SQLite snapshot, enforces monetary conservation and the finite Gold cap. New markets outside the genesis-pinned bootstrap catalog start empty; player orders remain available. These are operational safeguards, not immutability against future administrators.

### Eight-level useful constructions

All materials and FTH$ below multiply by the **target level**, up to level 8. Effects apply only to new work; paid deliveries and expeditions remain unchanged.

| Construction | Unlock | Level-one materials and FTH$ | Benefit per level |
|---|---|---|---|
| Residential quarter | Settlement | 3,000 kg timber + 200 L Water + 0.1 t Metal + FTH$300 | Future recruitment batch +25%; no new population cap |
| Water reservoir | Settlement | 4,000 kg timber + 0.3 t Metal + FTH$380 | One additional population-week of Water capacity plus 50% hot-weather reserve |
| Commercial workshop | Neighborhood | 10,000 kg timber + 1 t Metal + FTH$600 | Wood, Metal and Oil yield +25% |
| Trade hub | Town | 25,000 kg timber + 3 t Metal + FTH$1,800 | Effective collection distance reduced by two tiles |

Existing workshops and trade hubs count as level 1 without repurchase. Facilities never grant currency. Sustainable identity, session retention, sharding, moderation and large-scale social services are **deferred**; the current seven-day anonymous sessions, 10,000-session limit and 1,000-chat limit are not billion-user infrastructure.

### Upgrade fees and settlement quick sales

Every settlement upgrade after founding requires materials and FTH$. The fees are Camp FTH$200, Neighborhood FTH$300, Village FTH$400, Town FTH$500, District FTH$600, City FTH$700, Metropolis FTH$800 and Capital FTH$800 (its existing fee is retained). Founding has no FTH$ fee. Resource warehouses add FTH$50 × new level; item storage adds FTH$100 × new level, alongside existing materials.

API resource access exposes `dollarsPerWorker` and new paid crews expose `weeklyDollarsCost`, both in ordinary FTH$. `weeklyMetalCost` is retained only for already-paid legacy crews. Completed action receipts remain replayable without another payment; the one-time pricing revision rejects stale new requests.

Other buildings and visibility equipment without an existing FTH$ price add their material reference value: timber FTH$0.08/kg, Water FTH$0.20/L, Metal FTH$200/t and Oil FTH$24/bbl. These equal the preserved 4/2/2/24 FTH$ per-accounting-lot references. Existing FTH$ fees, ownership and completed work are unchanged.

Construct a market stall, trade hub or city bank to unlock **Sell resources for FTH$** in Settlement → Buildings and Production. Choose a resource, quantity or Max, check the funded total, then review and confirm. Only owned resources can be sold there, up to 10,000 per order. Settlement sales use the same marketplace endpoint, static base price or better player bids, actual market funds and conservative 2% price protection. Pending output and market escrow are excluded. The resource-header **Collect and sell** action separately funds pickup from its sale proceeds. The full marketplace remains accessible before constructing these buildings.

Pricing and collection migrations invalidate stale gameplay revisions once while preserving existing balances, buildings, paid crews and deadlines. Previously paid transport is not refunded or charged again; those deliveries complete normally. Every worker on a new gathering job pays FTH$ transport at pickup, including basic Wood and Water crews.

### Physical units, climate and API accounting

Timber/Wood trades in **kilograms (kg)** and Water in **liters (L)**, generic Metal in **metric tonnes (t)**, Oil in **42-US-gallon barrels (bbl)** and items in **pieces** (Korean: 개). Wood uses a fixed game conversion of 500 kg per former m³, not a universal timber density. Metal remains a game-wide basket, not an exchange-specific copper or steel contract; FTH$ is not a real commodity-price/USD peg. One bbl is 158.987294928 L.

[resource-units.ts](./src/resource-units.ts) defines exact accounting lots: timber 50 kg, Water 10 L, Metal 0.01 t (10 kg), Oil 1 bbl. Resource API payloads, orders, fills, reserves and saved quantities remain integer **lots**, including historical pending fractions; currency APIs retain their existing ordinary-FTH$ convention. UI quantity = lots / lots-per-unit; UI price = price-per-lot × lots-per-unit. This preserves every existing payment and escrow without destructive rounding. Resource orders have no fixed lot cap; available funds, real liquidity and safe-integer accounting still apply. Displayed price ticks scale with physical units. Changing display units requires no save migration.

Physical model version 1 adds an idempotent `physicalVersion`/`physicalStartedAt` save marker. Earlier events retain legacy rules; paid crews, promised recruitment, old expedition rewards, financial tables and receipts are preserved. New recruitment charges FTH$50 per climate-adjusted, confirmed arrival. The 16-game-year deterministic climate cycle enables cached exact daily-consumption sums and bounded idle skipping without assuming constant weather. Calendar years continue normally. Online polling and offline catch-up use the same scheduled deadlines.

See the [English whitepaper](./public/WHITEPAPER.md) and [Korean whitepaper](./public/WHITEPAPER.ko.md) for seasonal/weather coefficients and production/storage tables. The 50 L household target is inspired by [WHO domestic Water service guidance](https://www.who.int/publications/i/item/9789240015241), not a universal average; barrel units follow the [EIA glossary](https://www.eia.gov/tools/glossary/index.php?id=B). Construction and equipment recipes remain simplified settlement supply budgets, not literal engineering bills.

### Items, crafting, and storage

#### Consumable bulk crafting permits

Crafting cost labels use a compact 9 px treatment. New crafting charges use
10% of the catalog's raw-resource costs and original explicit/material-valued
FTH$ fee, with a minimum **FTH$1 per output copy**. Reduced resources round up
to whole accounting units per copy; FTH$ fees retain monetary precision. Item ingredients and bulk
permit consumption are unchanged. Catalog budgets remain the original baseline
for discovery and reserve compatibility; use `craftingCost` for payable costs.
For example, one bench costs Wood 3, Metal 1 and FTH$10 in accounting units.
Existing receipts replay unchanged; no market seeds, keys or ledger data are reset.
Each card highlights estimated profit, loss or break-even for the
displayed batch: current output sell quote minus FTH$ fees and the current sell
value of every consumed raw resource/item, including a bulk permit when applicable.
This measures opportunity cost, not replacement purchase cost or guaranteed income.
Recipe details disclose revenue, input valuation and fees. Missing input/output
sell quotes show an unavailable estimate; liquidity, slippage and execution are
not guaranteed. Estimates use accounting-unit quotes, not physical display units.

| Permit | Crafting civilization | Decoration inputs | Unused collector inputs | Additional raw materials |
|---|---|---|---|---|
| 10 copies | Settlement | Wooden bench, Pioneer banner | Wood 1-week ×1 | 8 Wood, 2 Metal |
| 20 copies | Neighborhood | Market canopy, Picnic table | Wood 4-week ×1, Metal 1-week ×1 | 16 Wood, 6 Metal |
| 50 copies | Town | Town information kiosk, Civic pavilion | Metal 4-week ×2, Wood 4-week ×1 | 24 Metal, 2 Oil |
| 100 copies | City | Decorative tram shelter, Solar pergola | Metal 12-week ×2, Oil 4-week ×1 | 60 Metal, 6 Oil |

Permits are craftable and spot-tradable, not permanent equipment. Each grants
exactly one batch of its printed size, not an arbitrary smaller batch or a lasting
unlock. A 100-copy permit cannot replace a 10-copy permit. Click any recipe's Craft
button to choose a single copy or a matching owned permit, then review the full
consumption confirmation. No permit is spent on choosing, cancellation or failure.
The server verifies the exact quantity, ownership, all ingredients, discovery,
stage and final storage occupancy before consuming anything. The consumed permit
frees its own slot, so 100 outputs fit in an otherwise empty 100-slot warehouse.
Bulk crafting uses the same per-recipe two-second cooldown as single crafting;
changing batch size cannot bypass it. Placed items, escrow and pending finds are
not usable inputs. Existing reserve catalogs remain pinned; four new markets use
signed additive authorization without resetting funds, keys or ledger history.

Raw-resource pickup uses individual resource controls, not an aggregate header Claim button. Item overflow finds are still collected separately in Settlement.

Item inventory contains utility equipment, cosmetic decorations, collectibles and consumable collection, exploration and recruitment permits. Owned and pending raw resources remain separate. Each distinct item type uses one slot regardless of quantity, including equipped gear, placed decorations and market reservations. Crafting releases an ingredient slot only when its last owned copy is consumed and no reserved copies remain. Crafting still requires discovering every recipe resource and owning its ingredients. Automation permits are found or traded, not crafted.

| Permanent item | Recipe | View |
|---|---|---|
| Campfire kit | 750 kg timber | 5 tiles |
| Torch | 400 kg timber (including resin) | 6 tiles |
| Lamp | 0.12 t Metal, 3 bbl Oil | 8 tiles |
| Explorer lantern | 0.2 t Metal, 5 bbl Oil, FTH$4 | 10 tiles |

Nine permanent **cost-saving equipment** recipes combine crafted decorations,
unused resource-collector permits and raw materials. The crafting panel's
Cost-saving equipment filter lists exact batch requirements; inventory contains
one independent equipment slot for **Investigation**, **Exploration** and
**Attraction (resident recruitment)**. Crafting does not equip these items.

| Activity | 10% discount · Settlement | 25% discount | 50% discount · City |
|---|---|---|---|
| Investigation | Survey satchel | Field survey station · Village | Precision survey array |
| Exploration | Trail supply kit | Expedition outpost kit · Village | Expedition logistics network |
| Attraction | Settler welcome kit | Community welcome pavilion · Town | Settler hospitality network |

Only the equipped item for that activity applies: owning spare copies or other
tiers does not stack discounts. Discounts are capped at **50%**, rounded upward
to the nearest FTH$0.0001, and apply to new manual and automated jobs without
changing staffing, discovery odds, travel times or already-paid jobs. Investigation
uses its own discount on 10% of the **undiscounted** concurrent exploration fee
(minimum FTH$0.10 before equipment), never the exploration equipment discount.
Equip, replace and unequip are free, server-validated and persistent. Equipped
copies cannot be sold; spare copies can trade at market spot prices.

Mixed recipes permanently consume only unused owned decoration copies and
collector permits. A placed decoration's protected copy, market escrow, pending
finds and active automation timers cannot be consumed. Return a decoration to
inventory first or use a spare. The entire batch is validated before spending;
combining items can free slots even when the bag is full. Original reserve catalogs
and keys remain unchanged; nine pinned equipment markets are added only through
the existing signed additive authorization process.

Investigation, each individual crafting recipe, each building/construction, resource warehouse, item-storage expansion and settlement-tier upgrade have independent **2-real-second minimum intervals** between successful requests, regardless of game clock speed. For example, `craft:torch` does not block `craft:bench`; `building:housing` does not block `building:cistern`. The cooldown is shared across quantities/levels of the same recipe/building and across alternate routes to the same building. The authoritative API persists per-account `actionReadyAt` deadlines; new request IDs, another tab, reloads and server restarts do not bypass them. A failed or cancelled action starts no cooldown; retries of an already accepted idempotency key return the original receipt without spending twice. Buttons show request activity and a remaining-time progress strip. Batch crafting remains one atomic action, not one delay per copy. Confirmations and server writes remain serialized for safe balance/revision updates, but unrelated buttons are available once the request completes.

Desktop settlement task panels share a wider right-side shell (560–800 px, bounded by the viewport). Crafting and building/upgrade cards use small artwork, visible resource/FTH$ consumption chips, small **Recipe 4/8** links and accessible icon action buttons. Recipe counts include only item ingredient types, not raw resources or FTH$. Costs remain required and visible in a separate owned/required section; recipes without item inputs omit the fraction. Every crafted copy uses 10% of the baseline raw-resource cost and explicit/material-valued FTH$ fee, with a minimum FTH$1 per copy. Item ingredients remain unchanged. Single/bulk affordability, confirmations and server spending share this cost; historical reserve seed prices and monetary policy are unchanged. Crafting cards show live per-item market sell quotes, seven-real-day changes and estimated profit/loss including all inputs and fees. Missing quotes/history never invent values; market-fetch errors show a retry. One catalog request supplies all recipes, refreshed on the normal server-sync interval only while Crafting is open. Upgrade disclosures retain shortfalls, civilization tier and next-level benefits. Touch screens retain 44 px controls; expanded mobile recipes span both columns. Counts update with authoritative balances; escrow, pending finds and active permits are not usable ingredients. Civilization requirements restrict crafting, not trading or placing owned cosmetics.

Item storage progresses **Bag (20 slots) → Carrier (40, 0.5 t Metal + FTH$100) → Crate (60, 1.5 t Metal + FTH$200) → Container (80, 4 t Metal + FTH$300) → Item warehouse (100, 10 t Metal + FTH$400)**, followed by warehouse II–VI at **120/140/160/180/200 slots**, costing **20/40/80/160/320 t Metal + FTH$500/600/700/800/900** respectively. Each price buys the next tier once; there is no upkeep. Each upgrade adds one **20-slot page**, reaching **10 pages** at the maximum. Inventory uses a compact five-column/four-row grid of square, unnumbered slots, including empty and market-reserved slots. Existing saves retain their purchased tier and contents. Storage and recipes spend owned balances only; equipment recipes are settlement supply bundles, not literal handheld-object material bills.

A returned expedition that reveals new terrain uses a deterministic, locked departure plan: 1–2 resource collection permits, 0–2 activity permits and a climate-adjusted 20–85% keepsake chance, with at most one unique keepsake per biome. Season, all eight daily weather windows and temperature contribute across the trip. Old expeditions without a plan retain their promised three finds. Destination difficulty selects 1/4/12-week permits. Fully overlapping surveys award nothing. Overflow remains pending; partial collection and retries preserve every copy.

The decoration catalog has **30 items**, each with distinct shared SVG artwork for crafting, inventory, marketplace and parcel placement. Existing decorations use more material-appropriate budgets: Flower planter (12 Wood, 6 Water), Wooden bench (24 Wood, 2 Metal), Pioneer banner (12 Wood, 4 Metal), Courtyard fountain (60 Metal, 40 Water), Garden boardwalk (45 Wood, 6 Metal), and Market canopy (36 Wood, 8 Metal). Metal stands in for mineral construction supplies; Water includes planting/filling needs, and Oil represents fuel/polymer processing. These are simplified construction supply budgets, not literal engineering bills.

New crafting tiers: **Settlement** — Log seat, Wildflower bed; **Camp** — Picket fence, Birdhouse, Vine trellis, Rain barrel; **Neighborhood** — Picnic table, Garden arch, Garden swing; **Village** — Village gazebo, Village clock tower, Founders monument; **Town** — Town streetlamp, Town information kiosk, Civic pavilion; **District** — Glass garden, Modern sculpture; **City** — Decorative tram shelter, Solar pergola, Living wall; **Metropolis** — Sky observatory, Metropolis light spire; **Capital** — Capital biodome, Capital sky beacon. Exact variable resource budgets are displayed in each recipe. All remain cosmetic: no free power, transport, production or research is granted.

Live reserve seed prices for existing items remain pinned even when crafting budgets change. New assets use explicitly approved additive market targets and the existing signed expansion process; no ledger reset, key replacement or genesis rewrite is required. Place decorations on empty parcel land. Moving/replacing/removing them never destroys items or frees inventory slots. Placement is free and cosmetic-only.

The strictly validated `decorate` command takes `slot` and an owned cosmetic `item` (or `null` to remove). For example: `{"type":"decorate","slot":"garden","item":"planter"}`. Inventory snapshots include `placements`; legacy inventories and retry receipts gain empty placements without resetting equipment or paid work.

## Inbox, Contacts and settlement chats

All nine game pages share Korean-first navigation. **Inbox** retains `/communicate/`; **Contacts** (`/contacts/`) is reached through the avatar menu, not a new primary tab. Federation retains census and membership management. Journal, guide and Bank keep their existing routes and avatar entry points.

Inbox fills its page with a public directory and conversation. Inbox and Contacts list public **Explore** rooms of settlements within the player's current exploration radius, plus public federation rooms represented by those settlements. The player's own public room remains reachable while travelling. Explore and Settlement use a collapsible chat overlay with one borderless chat icon and an unread badge; expanding it never resizes the fullscreen scene. On desktop (at least 901px wide and 501px tall), Explore's minimap stays at the bottom-right, with the collapsed chat icon over its top-right corner. Expanded chat opens above the minimap. On smaller screens the minimap sits above the bottom-right chat launcher, becomes a compact thumbnail beside the menu on short phones, and joins the bottom map controls on short landscape screens. Expanded chat temporarily hides the minimap on smaller screens, as do expanded weather details on phones. Each channel has isolated history and broadcasts; the server checks visibility again before sending or delivering messages, so moving out of range revokes public access. Nearby listings expose only public room IDs, nicknames, coordinates, population and federation—not session IDs, credentials, inventories or balances.

Explore's compact translucent tile panel sits at the upper-left of the usable map, beside weather when space permits. It shows the explorer's current terrain, grid coordinates, associated resource and that resource's settlement collection queue in physical units, with a 44px-minimum Crews action. Weather wraps independently rather than stretching the card across the map. Short landscape screens show a compact location/action summary; screens at or below 750px retain the weather-and-controls-only map to leave room for exploration and persistent chat.

The header's single Resource settings control retains a 44px-minimum target on both desktop and mobile; individual settings inside resource panels use compact 28px targets on mobile. One-tap resource claims retain their 44px-minimum height. The compact header frees map space without hiding resources, balances or population health. On short phones, Explore and Settlement allow vertical page scrolling instead of collapsing the scene or overlapping camera controls and quick actions; bottom navigation stays sticky. Management drawers retain a usable viewport above navigation when there is not enough height to also reserve the full chat area.

The Explore and Settlement chat launcher shows the selected room's live connected-user count, including the player when connected. Unknown/disconnected presence displays a dash rather than a stale count. The separate upper badge still reports unread messages.

**Visit settlement** opens `/settlement/?visit=<public-room-id>`. Its visitor group chat is private from public feeds, but **any admitted settlement visitor can participate**; it is not an encrypted or invite-only direct-message room. Private rooms appear only on settlement pages, never in Inbox or Contacts. Explicit CSRF-protected admission requires the settlement to be nearby; previous admission persists across restarts. Own settlement chat is available directly. Visitor pages expose only public settlement details and no other player's gameplay controls.

World is the canonical profile source. World home is the Getting-started landing with optional inline avatar/username editing at `/#/setup`; setup never blocks gameplay. The **avatar menu** shows your World identity and links to this main-page editor, rather than editing inside Play. Select **Use World profile in Play** to sign a free, session-specific wallet link before joining chat. World usernames use the shared 3–24 character rule; Play no longer edits an independent nickname. Profile changes refresh across World and the Play popup, including on window focus; chat reads the authoritative username before accepting messages. Disconnecting or switching wallets removes the previous chat link. Existing game saves, balances, chat identifiers and historical messages remain intact. The latest **100 messages per room** persist across restarts. Legacy global history remains stored but is not exposed as an unrestricted global feed. Messages use real UTC timestamps and allow 300 Unicode characters/five lines. Enter sends; Shift+Enter inserts a newline; Korean IME confirmation does not send prematurely. User messages and usernames are rendered literally, never interpreted as HTML.

The repository site server configures `WORLD_PROFILE_API_ORIGIN` automatically. When running the game API separately, set it to the trusted World profile API origin (for example `http://127.0.0.1:8080`); the game API must be able to reach that origin. The signature binds the wallet to the current session's CSRF token and expires after five minutes. Arbitrary posted addresses/usernames are not accepted. Without this integration setting, the standalone backend retains its legacy nickname endpoint for compatibility; the integrated Play UI always uses World profiles.

- The room admits at most **1,000 connected players**, with one active chat tab per session. A second tab replaces the first. Additional players receive a retry message; gameplay remains available. Leaving the page releases its stream and timers; a back/forward-cache return reconnects once. State refreshes retain the composer and connection.
- A player can send once per three real seconds, including across reconnects/restarts. A global token bucket allows a burst of ten and replenishes ten messages/second. Requests are idempotent and expire after two minutes; five-minute retry receipts are bounded to 4,096.
- Authenticated Server-Sent Events deliver room-filtered batches every 100 ms. Pending batches cap at 100 messages; each room's client history/DOM caps at 100. The server bounds each stream to 256 KiB and disconnects stalled consumers instead of growing queues.
- CSRF-authenticated pings run every 20 seconds. A five-second sweep expires sessions or connections without activity for 60 seconds; SSE heartbeats run every 15 seconds. Chat authentication does not load/accrue/write the game. A separate bounded 10,000-requests/minute/IP chat budget keeps heartbeats out of gameplay's IP allowance.
- The capacity and hub are **single API process only**. Multi-replica deployment requires shared presence/admission, fan-out and rate limits. Proxies must permit streaming without buffering. Tests verify exact 1,000-subscriber admission/fan-out, bounded backpressure, persistence and real HTTP/SSE behavior; these are not a production network-load certification.
- Anonymous sessions are not verified accounts. Public channels and visitor group chats are not suitable for secrets. This prototype has no moderation, reporting or blocking tools.

| Route | Request | Result |
|---|---|---|
| `GET /api/chat/directory` | Session cookie | Nearby public rooms and settlement summaries; never private rooms |
| `GET /api/chat?room=<id>` | Session cookie; room authorization | Profile, selected room, public directory, presence, real server time |
| `GET /api/chat/events?room=<id>` | Same-origin session; room authorization | SSE welcome, room-only history/batches, presence, replacement/expiry events |
| `POST /api/chat/visit` | Session, Origin, CSRF; `{settlement}` | Admit nearby settlement visitor without mutating gameplay |
| `GET /api/chat/visit?settlement=<id>` | Owner or admitted visitor | Public settlement summary, no inventory or controls |
| `POST /api/chat/profile` | Session, Origin, CSRF; `{address,issuedAt,signature}` or `{}` to unlink | Verify wallet signature and use authoritative World profile; never changes the game save |
| `GET /api/chat/profile` | Session; no query parameters | Current public nickname/profile, or `null`; does not join a room or accrue gameplay |
| `POST /api/chat/messages?room=<id>` | Session, Origin, CSRF; `{id,text,createdAt}` | Room-bound message or identical UUID-v4 retry; mismatched active room rejected |
| `POST /api/chat/ping` | Session, Origin, CSRF; `{}` | Renewed connection lease and current presence |

The client preserves `null` profile responses as an unlinked profile, including after unlinking or reconnecting. Only responses carrying a `fundAccountId` publish World wallet context; profile reads never create or replace a gameplay fund.

## API and security boundary

### Signed World funds

The integrated server owns these routes under `/api/dollar/game/wallet`. Every write requires the existing session cookie, exact Origin and `X-CSRF-Token`; reads are authenticated and `no-store`.

| Route | Request | Result |
|---|---|---|
| `GET /balance` | Session | Exact `{accountId,wallet,available}` for read-only Dollar display |
| `GET /funds` | Session | World and wallet balances in 18-decimal base units, mode, transfer requests and CSRF |
| `POST /funds/authorization` | `{address}` | Canonical wallet-link message and timestamp |
| `POST /link` | `{address,issuedAt,signature,moveGuestFunds,separateWorldFunds}` | Verify a session/Origin-bound authorization (five-minute freshness window) |
| `POST /funds/prepare` | `{id,direction,amount}` | Immutable owner/request parameters and exact signing message |
| `POST /funds/complete` | `{id,signature}` | Settle once or return the existing receipt |
| `POST /funds/cancel` | `{id}` | Discard an unsigned preparation |

Separate authorization never moves funds. It retains the deterministic World guest account and makes gameplay spend **only World funds**, including after reconnect/restart; legacy direct-wallet sessions remain compatible until explicit opt-in and cannot silently downgrade afterwards. Restoring another wallet's settlement does not silently merge funded guest accounts. Legacy guest-to-wallet moves require explicit signed approval, preserve dust, and are journaled once per browser capability; replay does not claim later guest credits.

The Bank route uses the same native wallet panel as the other sites, not a blocked wallet iframe. One World budget is displayed across FTH$ wallet panels; it is not merged with spendable wallet balances or other Ethereum addresses. Game state responses include `fundMode`, `fundWallet` and the public `fundAccountId`. Separate-budget gameplay does not require a connected extension and does not revoke the settlement when the displayed wallet changes; legacy direct-wallet sessions retain their signer checks and explicit revocation remains available.

Successful World reads publish only the public budget account to the same-origin wallet panels. Cross-origin panels use the existing explicit World account sync popup; it shares no session, key or spending authority. Synced public accounts remain readable on Dollar ledger replicas. Wallet panels always show the World balance in FTH$, independently of their selected portfolio valuation currency. Fund transfers notify other World tabs, and returning to a visible game tab refreshes authoritative balances.

Account and Bank embed one shared World funds component: Deposit/Withdraw, exact 18-decimal entry, Max, before/after previews, explicit review and pending-transfer recovery. No separate page or manual synchronization step is required. Visible balances refresh every 30 seconds and on focus; successful transfers refresh gameplay and wallet views. World's authenticated built-in wallet signs after explicit review/unlock, or the linked external wallet signs; the central native approval flow remains the fallback. Legacy direct mode already shares one balance and remains unchanged unless explicitly switched to a separate budget. Separate game budgets stay isolated, never silently merged with wallet funds. No balance moves automatically; interrupted transfers reuse the persisted request and durable receipt. The old World funds URL mounts the same component and bootstraps the signed-in settlement before reading balances.

Deposits use native Dollar signatures with the exact destination, amount and nonce; the memo hashes the World owner, request ID, Origin and session CSRF. Withdrawals sign the exact World account, authorized destination, base-unit amount, request ID, Origin and CSRF. A request ID is 16–128 ASCII letters/digits/underscores/hyphens; amounts are positive canonical integer strings. Transfers are bounded by spendable balances and the safe gameplay accounting ceiling (including pending deposits), with at most 1,000 active requests per owner. Views show all active requests and the latest 100 closed requests; durable replay receipts are retained. No transfer mints currency or falls back to another funding source.

Signed deposits are persisted before submission and sealed before gameplay can consume them. Balanced withdrawal/guest-move journals are persisted atomically before ledger commit. Lost receipts and restarts reuse those exact native payments/journals, never another debit. Retry a `paying` request with an empty signature; a conflicting deposit nonce requires refreshed preparation and a new signature. Unsigned preparations do not reserve funds; affordability is checked again on completion. Discarding a preparation cannot revoke a native payment already signed and submitted outside this API. Back up the World SQLite database and Dollar ledger together; this integration assumes their existing single-writer deployment.

| Route | Request | Result |
|---|---|---|
| `GET /api/stats` | No session or credentials needed | Public `settlements`, owned game `metal`, global `population`, FTH$ `dollars`, Gold `fthg`, live `goldRate`, and `updatedAt` (real UTC Unix milliseconds); cacheable for 15 seconds |
| `POST /api/session` | Empty JSON object; exact `Origin` | Anonymous HttpOnly session cookie; CSRF token |
| `GET /api/state` | Session cookie | Game, pending whole units, rates/game week, workforce (resource crews and expedition with game-clock deadlines), availableWorkers, per-resource capacity, claimThreshold (50% of cap, rounded up), warehouse level/cost, revision, serverTime (game-clock Unix milliseconds), deterministic environment, clockSpeed (1 production, 20 development; legacy 10 supported), inviteReadyAt (game-clock Unix milliseconds), population (global and federation; null for nonmembers), CSRF token |
| `POST /api/actions` | Session cookie, exact `Origin`, `X-CSRF-Token`; `{id, revision, command}` | Updated state and message, or explicit error |

Snapshots expose `recruitment: { population, startedAt, readyAt } | null`; timestamps use the trusted server game clock. `inviteReadyAt` mirrors the pending arrival deadline (or a retained legacy cooldown), and resets to zero when a queued batch arrives.

`id` is a UUID v4. Commands are strictly allowlisted in [api-types.ts](./src/api-types.ts). `{"type":"assign","resource":"wood","workers":3}` saves manual resource allocation; tile fields are rejected. `{"type":"automatic","enabled":true}` restores automatic balancing. `{"type":"construction","kind":"housing"}` upgrades one of `housing`, `cistern`, `workshop`, or `logistics`. Other commands are `move`, `trade`, `build`, `diplomacy`, `upgrade`, `invite`, `home`, `warehouse`, `claim`, `collect-sell`, `activate-collection`, `craft`, `equip`, `decorate`, `item-storage`, and `collect-items`. Resource-specific `claim` pays transport and collects completed whole units without a half-storage threshold. `collect-sell` takes `resource`, whole `quantity` and integer FTH$-subunit `minimumDollars` for protected net proceeds; `activate-collection` consumes an owned catalog permit. `craft` takes a catalog `item`; `equip` takes an owned visibility item or `null` to unequip. `build` accepts bank, townhall and catalog Water/commercial facilities, not legacy standalone lighting. Snapshots include versioned `inventory`, `game.constructionLevels`, collection fees and automation deadlines, resource crews and `waterUpkeep.paused`. Discovery, stage/bank gates, explorer reserves, affordability and full-week work are server-validated. Forged costs, yields, timestamps and extra fields are rejected.

- Random 256-bit bearer session cookies are hashed in storage. Cookie sessions use `HttpOnly`, `SameSite=Strict`, no Domain, and `Path=/`; HTTPS uses `Secure` and the `__Host-` prefix. HTTP is accepted only for loopback development.
- State-changing requests require an exact allowlisted Origin (only the configured origin for HTTPS; the explicit same-port loopback aliases for HTTP development), JSON content type, session-bound synchronizer CSRF token, and compatible Fetch Metadata. No CORS permissions are granted. Tokens/state responses are `no-store`; all displayed dynamic strings are escaped. These layers follow [OWASP CSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html); XSS or stolen sessions can bypass CSRF protections.
- Owner identity is derived exclusively from the cookie. All gameplay mutations, owned balances, production, claims, warehouse costs, and receipts run within **one SQLite write transaction**. Errors roll back the entire operation. Competing commands must match the current revision; only one wins.
- Recruitment costs, pending batch size and deadline persist atomically at dispatch. Completion adds residents and updates the global/current-federation census in the same transaction, exactly once. Global/federation counters use indexed point reads, not per-poll scans of world JSON. Initial clock/census migration scans existing records only once; later startups check the latest saved timestamp to avoid rewinding persisted account time. A duplicate in-progress recruitment returns 409 without spending resources or altering counters.
- The last successful request ID and result are durable. Retrying that exact request returns its original result without paying twice. Reusing its ID with different content or replaying older revisions returns 409. The browser retries transport failures once using the same ID; it never creates another ID for that retry.
- Production uses integer fixed-point arithmetic and one trusted timestamp per operation. Persisted per-world time never moves backward. **State GETs transactionally settle weekly production, pending transport fees, item-enabled auto-collection, population changes and recruitment arrivals**, including treasury payments and census updates, exactly once. Ordinary output stays pending; active, funded collection permits and already-paid legacy deliveries may increase owned raw-resource balances. Completed expeditions can deliver collectibles and collection permits. New residents cannot earn production before arrival or retroactive partial-week rewards. Revisions count commands and effective weekly population/tier changes, so drafts prepared before a population update must refresh. Low-level `Store.read` remains isolated and read-only. Pickups recompute elapsed work in the same transaction. Polling remains every 30–35 seconds, without client-clock reward extrapolation.
- Mock limits: 2 KiB JSON bodies; bounded headers and request timeouts; 240 requests/minute and 5 new sessions/minute per direct socket IP; four accepted actions/second per world; one claim/second; 10,000 live sessions and limiter entries. Unauthenticated identity creation is intentionally demo-only. The API ignores spoofable forwarded IP headers.
- Errors use `{error: string}` with 400/401/403/409/413/415/429/503 as appropriate; unexpected failures are logged and return a generic 500.

## Cloud adaptation

[Store](./server/store.ts) is the synchronous local adapter contract; the HTTP boundary and [economy rules](./server/economy.ts) are independent of SQLite. Its `read` operation must return an isolated snapshot without writes; `transaction` must atomically persist successful mutations and population/settlement/owned-metal deltas; `population` and `publicTotals` return authoritative aggregate counts. Callbacks receive both authoritative game time and real time; `clockSpeed` is server-controlled. For a managed SQL/document store, adapt the HTTP calls to await an asynchronous implementation of the same operations. A cloud transaction **must** load only the authenticated owner's record, obtain one trusted database/service timestamp, derive shared game time from the durable clock anchor, verify the revision, recruitment cooldown, and per-resource claim threshold, update the ledger and pending amounts, and persist the idempotency receipt atomically. Use a serializable transaction or conditional write with retry; never implement this as separate unguarded reads and writes. Coordinate clock speed changes across replicas. Do not copy the in-memory rate limiter across replicas: use a shared limiter/gateway.

The local census uses exact, transactionally maintained global and per-federation counters. At cloud scale these shared write keys can become hot: use sharded counters/materialized aggregates with a durable idempotent outbox and a cached aggregate read tier, explicitly documenting any display lag. Large deployments also need a coordinated schema/clock migration rather than a startup scan, and all replicas sharing a store must use the same clock configuration.

The threshold reduces claim frequency and jittered 30–35-second polling reduces requests, but weekly transport requires transactional settlement on state reads. At scale, use a durable scheduled ledger/read model rather than this synchronous SQLite polling adapter. One million visible clients still generate roughly 29,000–33,000 state requests/second before gameplay actions; this prototype does not guarantee that capacity. Partitioned storage, shared abuse limits, a read/push tier and load testing remain necessary.

The local adapter trusts the host clock and clamps backward movement; it cannot detect an operator's erroneous forward clock jump. Production needs a monitored, synchronized authoritative clock (preferably database transaction time), durable storage/backups, authenticated account binding instead of anonymous sessions, session rotation/revocation/recovery, audit logging, and infrastructure-specific secret and access controls. Add security headers/CSP for the static frontend at its host, TLS termination, distributed abuse limits, and risk-based bot challenges where appropriate. Validate these guarantees with the chosen provider before public deployment.

## Scope and trust boundary

This is a **single-player settlement simulation with a local mock backend, asynchronous player exchange and scoped public/visitor chats**, not a production service, financial product, or replacement for government. Residents, relationships, votes, rewards and market assets are simulated; settlement contacts, exchange orders and chat connect browser sessions on the same backend. No verified accounts, real-money trades, real-world authority, or external transactions exist.

**CSRF protection does not prove a human is playing.** A script with its own legitimate session can obtain CSRF tokens and claim earned production, but cannot exceed time-based generation or claim the same balance twice. Anonymous identity creation does not prevent multi-account farming. Absolute bot prevention is not achievable with CSRF tokens, client-side secrets, or button cooldowns.

Production civic infrastructure still requires an independently reviewed architecture: authenticated identities, consent and representation, verifiable voting, economic safeguards, fraud prevention, privacy protections, accessibility audits, legal review, and disaster recovery.

The application requests Google Fonts for typography; system sans-serif fonts provide an offline fallback. Game data is stored by the configured API.
