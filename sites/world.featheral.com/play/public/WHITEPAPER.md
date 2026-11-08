# Featheral
## A playful sandbox for communities, shared resources, and governance

[한국어 백서](./WHITEPAPER.ko.md)

**Status:** Research draft and playable prototype. Not a token offering.

**Main currency:** Featheral Dollar (FTH$), recorded on the authoritative Dollar ledger. **Gold:** Featheral Gold (FTHG), the actual Ethereum Mainnet token at `0xBa658127d93B17E577E1B8e8995cAB3aE7d7C665`.

**Network:** Ethereum Mainnet. The separate bridge requires operator deployment, funding and configuration.

> Featheral gameplay and governance are simulations, not a live DAO or political authority. Resources, residents and votes are virtual, but authorized gameplay spends actual FTH$ from the Dollar ledger and FTHG remains on Ethereum. This is not an investment product or a promise of monetary returns.

## 1. The idea

Governance can be difficult to understand through diagrams alone. Featheral takes a different starting point: a little world you can explore.

Find a place to settle. Welcome residents. Notice what happens when production takes time, storage has limits, and joining a federation requires more than accumulating a balance. Work toward a simulated assembly and consider a shared priority.

The goal is to make questions about resource coordination and collective decisions approachable through a casual browser game. The prototype is a learning environment, not evidence that any particular governance model works in the real world.

### Design principles

- **Play before jargon.** Explain ideas through visible actions and familiar game loops.
- **Time, not click volume.** Resource production follows an authoritative server clock.
- **Clear ownership.** Pending production is distinct from inventory a player has claimed.
- **Visible constraints.** Storage, population milestones, and recruitment pacing make trade-offs understandable.
- **Experiment without financial exposure.** Playing requires no wallet, purchase, gas payment, or token.
- **Be honest about the prototype.** Separate implemented features, research directions, and undeployed token ideas.

## 2. What is playable today

Each anonymous browser session owns an independent procedural world. Players can:

1. Establish a settlement on dry land and explore 21 terrain types with resident expeditions.
2. Let automatic resource allocation balance residents, or adjust resource headcounts manually, then collect weekly deliveries.
3. Build and upgrade warehouses.
4. Recruit simulated residents and advance settlement tiers.
5. Trade resources, crafted items and collectibles in an FTH$ marketplace and exchange Gold separately, using spot trades or limit bids/asks.
6. Craft and equip visibility gear from your item inventory; build a city bank and town hall as requirements permit.
7. Improve relationships, join a named mock federation, or satisfy founding requirements.
8. Record a simulated vote on the watershed restoration proposal.

Settlement management is **single-player**, not live cooperative multiplayer. The marketplace and chat connect browser sessions on the same backend. **Inbox** lists public Explore chats within the player's current exploration radius and public federation chats represented by those nearby settlements; the player's own public room stays available while travelling. **Contacts** lives under the avatar menu. Explore opens the same public conversations. Settlement pages host separate visitor group chats: anyone admitted by visiting a nearby settlement may participate, but these chats never appear in the public Inbox. They are not encrypted or invite-only rooms; never share secrets. Each room saves its latest 100 messages, with one message per three real seconds and a shared 1,000-participant process limit. The server rechecks public visibility before delivery; visitor admission and room histories persist across restarts. Visits disclose public names, coordinates and population, not other players' balances or gameplay controls. Residents and governance remain simulated; federation membership does not create an on-chain organization.

### Progression

| Tier | Population required to upgrade into this tier |
|---|---:|
| Settlement | 0; establishing it grants 12 initial residents |
| Camp | 25 |
| Neighborhood | 80 |
| Village | 250 |
| Town | 800 |
| District | 2,500 |
| City | 10,000 |
| Metropolis | 25,000 |
| Capital | 100,000 |

Each upgrade also consumes resources. The simulator lists its exact costs.

Joining Evergreen Union requires at least a Village and 50 relationship points. A goodwill shipment costs 2,000 kg of timber and 300 L of Water and adds 25 relationship points, up to 100.

Founding the named mock Verdant Federation requires at least a City, **strictly more than 10,000 residents**, and 50 t of Metal. Founding is not a contract deployment.

A Town with a town hall and federation membership can record its simulated vote once on the current proposal. There is no live on-chain tally, quorum mechanism, treasury execution, or legal representation.

### Marketplace

The standalone `/market/` exchange has **81 markets**: four resources, ten original crafted items, eight naming/title items, 21 keepsakes and 38 automation permits. All assets use the same demand-priced spot liquidity, 1% spread and player-order matching. Existing cost/effect-based starting prices are preserved; starting scarcity sets keepsake pools to 100 units and other pools to 10,000. Keepsakes remain unique per player and trade one at a time, including system spot trades. Other item orders support up to 10,000 whole units, subject to balances and storage; resource sales support the full owned amount within safe accounting limits. Each item occupies one slot. One equipped/placed copy is protected, while spares can be sold.

Card browsing highlights artwork, category, holdings and separate Buy/Sell FTH$ quotes. Missing offers are labelled rather than shown as fictitious prices. Account opens **Featheral Bank** (`/bank/`) from its FTHG card; Gold conversion is no longer embedded in the marketplace.

### Wallet and staking

**Closed issuance policy:** new FTHG conversions, new stakes and reward claims are disabled in the wallet because Dollar no longer credits new FTH$. Existing Ethereum stakes remain inspectable. This policy does not change a deployed contract or transfer any origin-wallet FTHG; externally submitted conversions/claims must not be treated as settled Dollar funds.

**Finite origin-backed market liquidity:** Gold alone authorizes market funding, capped by verified finalized origin holdings and pending obligations. Every asset uses the active Gold conversion rate and sale-sized replenishment without reseeding inventory. Pricing depth is pinned once and is not spendable money or inventory. Origin depletion stops replenishment; only remaining pool funds and player bids then pay sellers, with no automatic Dollar treasury fallback. Historical fixed-rate and treasury-funded entries remain replayable. Off-chain obligations are not Ethereum transfers. Pending backing cannot redeem; redeemed FTH$ stays locked until confirmed returned FTHG is reconverted using those same Dollars. Gold offers finalized receipt reconciliation, never automatic Mainnet submissions. New players receive no FTH$. Finite backing does not guarantee stable prices or endless liquidity.

**Authorized live mode:** after backup and operator approval, an unused zero-supply Dollar ledger can activate this model through an append-only signed policy block. Existing genesis and settlements remain intact. Established players obtain FTH$ by selling resources into one-time funded markets. Live off-chain allocations still do not submit Ethereum transfers or permit redemption of unconfirmed backing.

World embeds the real Dollar wallet at `/bank/`. Its Ethereum bridge supports FTHG staking for **1, 2, 5, 10, 20 or 30 game years**, with simple-interest FTH$ rewards and a spot-price lock at stake time. The deployed contract and its authorized game-service clock determine maturity; browser time and local gameplay speed do not advance that clock.

Gold API owns Ethereum reads. Ethereum approvals, conversion, staking and claims require the selected wallet's explicit signature. Confirmed conversion and reward events are settled on the Dollar ledger by unique transaction/log ID; a submitted transaction is not a settled FTH$ balance.

There is no simulated Gold balance, local bank council, or local staking treasury. Bridge reserve funding, APR administration and game-clock updates require their actual on-chain roles. The separate bridge must be deployed, funded and configured before these features are available.

Account's **Use wallet for gameplay** authorizes spending from the same Dollar wallet. FTH$ displays at most two decimals, gameplay accounts at four decimals, and the native journal retains 18-decimal amounts. Smaller wallet dust remains untouched. Disconnect or revoke removes the browser spending capability; a new wallet signature restores the same saved settlement.

FTH$ is not USD, a fiat deposit or a promise of cash redemption. FTH$ to FTHG redemption remains an authorized service flow, not an unrestricted public withdrawal form. Mainnet transactions involve gas, price impact and contract risk; no return is guaranteed.

### Marketplace order rules and Gold conversion

Player limit orders use price-time priority and cannot match themselves. Constant-product pools provide additional liquidity with a 1% spread per side. Exact BigInt arithmetic rounds buys up and sells down to 0.0001 FTH$; displays cap at two decimals. Spot orders enforce a maximum 2% total-price movement and either fill completely or fail without spending. Every pool starts empty. Owners may permanently donate existing assets and existing Dollar wallet funds; gameplay never creates liquidity.

Buy orders escrow FTH$ and sell orders escrow owned assets. Partial fills retain unfilled escrow; cancellation returns it. Item bids and asks reserve inventory slots. The limit is 50 open orders per session; orders expire with the seven-day session. Resource orders accept 1–10,000 accounting lots: timber 50–500,000 kg in 50 kg increments, Water 10–100,000 L in 10 L increments, Metal 0.01–100 t in 0.01 t increments, Oil 1–10,000 bbl. Liquid items use whole pieces; unique collectibles use one piece. Limit prices retain FTH$0.0001–1,000,000 per accounting lot; displayed per-unit prices and ticks are multiplied by lots per unit (0.02 for timber, 0.1 for Water, 100 for Metal, 1 for Oil/items). Charts show the latest 120 real executions, never fabricated history. Quotes refresh every five seconds. SQLite persists both accounts, escrow, reserves, trades and idempotent receipts atomically.

World has no Gold exchange pool. Actual FTHG conversion and staking belong to Ethereum and Gold API; FTH$ belongs to Dollar API. The game uses only existing Dollar wallet, market-pool and escrow balances.

The zero-start model refuses legacy simulated Gold/bank databases rather than converting old balances into real funds. Back up the game database, signing key and Dollar journal together. Local reset cannot reset deployed Ethereum contracts.

### Finite FTH$ balances and spending

New players and founding settlements start with **FTH$0**. Residents, banks, commercial buildings and exploration never grant FTH$, including offline time and previously dispatched expeditions. Existing balances, buildings, paid work and receipts remain intact; there are no retroactive refunds. The no-mint rule invalidates stale new action revisions once.

Recruitment costs **FTH$50 per arriving resident**. Exploration costs FTH$ by distance/difficulty but rewards discovery and collectibles, not currency. Transport and upgrades consume FTH$. Marketplace sales transfer player escrow or funded pool reserves into the seller's Dollar wallet. Default live pools have no automatic bootstrap. The isolated reserve prototype permits one-time Gold-authorized bootstrap only; no game action independently mints FTH$.

Commercial buildings retain their ownership, placement and material/FTH$ construction costs, but generate no income: Market stall (Camp; 4,000 kg timber + 0.4 t Metal + FTH$200), Commercial workshop (Neighborhood; 10,000 kg timber + 1 t Metal + FTH$600), Trade hub (Town; 25,000 kg timber + 3 t Metal + FTH$1,800). The city-bank building still unlocks Oil collection and resource trading; it does not manage funds. FTH$ is an off-chain ledger currency, not USD or an on-chain token.

**Settlement → Sell resources** is available immediately after founding, without a bank or commercial building. Review the live spot quote to sell `floor(owned / 2)` of every raw resource in one confirmation. Pending stock and sell-order escrow are excluded; zero quantities are skipped. Exact halves above 10,000 units are supported. Each resource retains the conservative 2% minimum-proceeds protection and existing market spread. One atomic transaction sells everything or nothing, including player orders, pool movements and fills; retries cannot sell twice. Selling Water can reduce upkeep reserves, so review the Water warning before confirming.

### Permanent monetary policy, version 1

New bridge conversion and staking-reward credits are closed. Only the authorized Gold reserve engine can issue finite origin-backed market liquidity. Gameplay payments transfer to the **system treasury** without changing supply; historical burns replay unchanged. Trades transfer existing wallet, escrow and pool balances; pool spreads stay in reserves. Pools start empty, then receive authorized origin-backed seeds or permanent donations of owned assets and existing FTH$. Donations grant no liquidity shares or withdrawal rights. Demand changes prices along the shared reserve curve. No virtual pricing depth can pay a seller.

Resource and item pools use one integer constant-product rule. With currency reserve R, asset reserve S and quantity q: buys pay `ceil(R*q*101 / (100*(S-q)))`; sells receive `floor(R*q*99 / (100*(S+q)))`. R is in 10,000 FTH$ subunits; S and q are asset accounting units. Orders retain 2% quote protection and player orders keep price-time priority. Ethereum bridge pricing is separate.

Gameplay policy constants and their fingerprint are persisted and checked at startup. Signed Dollar `GAME` entries verify conservation, burns and available balances; a durable SQLite outbox recovers interrupted journal settlement exactly once. Pending settlement blocks further fund mutations until recovery. This remains an operational safeguard, not protection against a compromised authorized game service.

### Eight-level useful constructions

All materials and FTH$ below multiply by the **target level**, up to level 8. Effects apply only to new work; paid deliveries and expeditions remain unchanged.

| Construction | Unlock | Level-one materials and FTH$ | Benefit per level |
|---|---|---|---|
| Residential quarter | Settlement | 3,000 kg timber + 200 L Water + 0.1 t Metal + FTH$300 | Future recruitment batch +25%; no new population cap |
| Water reservoir | Settlement | 4,000 kg timber + 0.3 t Metal + FTH$380 | One additional population-scaled week of Water capacity, including 50% hot-weather reserve |
| Commercial workshop | Neighborhood | 10,000 kg timber + 1 t Metal + FTH$600 | Wood, Metal and Oil yield +25% |
| Trade hub | Town | 25,000 kg timber + 3 t Metal + FTH$1,800 | Effective collection distance reduced by two tiles |

Existing workshops and trade hubs count as level 1 without repurchase. Facilities never grant currency. Sustainable identity, session retention, sharding, moderation and large-scale social services are **deferred**; the current seven-day anonymous sessions, 10,000-session limit and 1,000-chat limit are not billion-user infrastructure.

### Upgrade fees and settlement quick sales

Every settlement upgrade after founding requires materials and FTH$. The fees are Camp FTH$200, Neighborhood FTH$300, Village FTH$400, Town FTH$500, District FTH$600, City FTH$700, Metropolis FTH$800 and Capital FTH$800 (its existing fee is retained). Founding has no FTH$ fee. Resource warehouses add FTH$50 × new level; item storage adds FTH$100 × new level, alongside existing materials.

Other buildings and visibility equipment without an existing FTH$ price add their material reference value: timber FTH$0.08/kg, Water FTH$0.20/L, Metal FTH$200/t and Oil FTH$24/bbl (equivalent to the preserved 4/2/2/24 FTH$ accounting-lot references). Thus banks cost an additional FTH$3,200; town halls FTH$1,500; wells FTH$280; rain collectors FTH$570; pumping stations FTH$1,140; campfire kits FTH$60; torches FTH$32; lamps FTH$96. Existing income-building FTH$ costs and the lantern's FTH$4 remain unchanged. Live reserve seed prices stay pinned independently of these crafting budgets. Already-owned upgrades are preserved, and moving or equipping owned items is free.

Construct a market stall, trade hub or city bank to unlock **Sell resources for FTH$** in Settlement → Buildings and Production. Choose a physical quantity or Max, check the live spot total, then review and confirm. Only owned, claimed resources can be sold, up to 10,000 accounting lots per order. Settlement sales use the same marketplace endpoint, player-order/pool matching, 1% pool spread and conservative 2% price protection; banks never invent a fixed sale price. New gathering waits for paid pickup unless funded automatic collection is active. The full marketplace remains accessible before constructing these buildings.

Pricing migration invalidates stale gameplay revisions once while preserving existing balances, buildings, paid crews and deadlines. Previously paid Metal transport is not refunded or charged again; its delivery completes normally. Only additional Wood/Water workers and all Metal/Oil workers pay FTH$ transport.

## 3. A server-authoritative game economy

### Resources

The gatherable resources are wood, water, metal and oil. FTH$ and Gold are balances, not resource crews.

#### National-scale commodity units

| Resource | Trading / storage unit | One exact accounting lot |
|---|---|---|
| Timber | kilogram (kg) | 50 kg |
| Water | liter (L) | 10 L |
| Generic Metal | metric tonne (t) | 0.01 t = 10 kg |
| Oil | barrel (bbl) | 1 bbl = 158.987294928 L |

The petroleum barrel is [42 US gallons](https://www.eia.gov/tools/glossary/index.php?id=B). One metric tonne is 1,000 kg. Wood uses a fixed game conversion of 500 kg per former m³, not a universal timber density. Prices are FTH$ per displayed commodity unit, not per hidden lot. Inputs accept whole accounting lots: 50 kg timber, 10 L Water, 0.01 t Metal, or 1 bbl Oil. Items remain counted in pieces. These are real-world units with playable, simplified infrastructure budgets, not literal industrial engineering or real commodity contracts; generic Metal does not represent a quoted steel, copper or lithium grade, and FTH$ is not USD.

Physical model version 1 retains stored integers. Stocks, pending fractions, pool quantities, orders, prices, escrow, currency and receipts retain their economic value. Displayed quantities divide by lots per unit while displayed prices multiply by the same factor. Historical 100,000-lot raw pools correspond to 5,000,000 kg timber, 1,000,000 L Water, 1,000 t Metal and 100,000 bbl Oil. Monetary-policy version 1 and its fingerprint are unchanged. Migration records a cutover timestamp; earlier work uses its saved terms, and completed actions are not replayed. The kg/L display change requires no save migration.

There is **no passive resource production**. After settling, residents are automatically allocated by resource, not individual tiles. All explored resources are connected using the best net-value route from the settlement; ties favor shorter routes. Each resident has one job, with two residents reserved for expeditions. One crew per resource delivers every **seven world days**. Baseline weekly yields per resident are:

| Resource | Production |
|---|---|
| Wood | 500 kg multiplied by site yield |
| Water | 1,500 L multiplied by site yield |
| Metal | 100 kg multiplied by site yield |
| Oil | 2 bbl multiplied by site yield, with a city bank |

Settlement tier no longer multiplies physical output: larger populations provide more workers rather than multiplying each worker's productivity again. Terrain efficiency ranges from 80% to 180%; federation metal crews receive a further 20%. Facilities retain their production bonuses. New work additionally applies season, weather and temperature factors averaged over all eight daily weather windows in seven calendar days. Output is rounded down to whole accounting lots per worker, not whole displayed units, and locked when the work week starts. At baseline, one Water worker supplies about four residents; cold weather requires reserves, more Water workers or facilities. Production is real-world-inspired rather than a claim about actual national industrial productivity.

New games start with zero resources, FTH$ and FTHG. Manually gather only the founding requirement: 3,000 kg timber and 400 L Water, using the known clearing and lake at 3, 0. Founding consumes these supplies and welcomes 12 residents; hand gathering ends. Basic Wood/Water crews complete real work before output can be collected or sold. Selling completed production transfers funded marketplace FTH$, never a registration grant. Existing saves, earned balances, pending resources and locked jobs remain intact. Transport rules are unchanged.

Automatic allocation targets **50% total utilization**, rounded down, including residents already exploring. New gathering is limited to `max(0, min(floor(population / 2) - active explorers, population - max(2, active explorers)))` residents. Population-scaled Water storage and growth materials take priority within that budget. Explorers at or above the target pause new gathering, not paid expeditions. Gathering can start without FTH$, but completed production cannot be taken into inventory until its transport is paid. Automation of allocation is separate from item-enabled auto-collection. Workers need a whole game week; selling resources transfers existing marketplace FTH$ rather than creating money.

Water priority allocates one week's replacement consumption, not the entire tank's reserve deficit, before sharing remaining workers across materials. Wood/Metal goals include two peak-climate weeks of upkeep. This avoids dedicating every worker to filling Water storage while materials run out. Winter without facilities may still require a Well or manual allocation; the 50% auto budget is never silently exceeded.

After priority crews are allocated, extra gathering fills only the remaining 50% budget. Each extra worker selects the route with the highest marginal resource value after transport; value uses fixed resource reference prices, not live market quotes, and counts only output fitting in remaining storage. Full storage or supply shortages can lower utilization. Use the +/- controls, sliders or exact counts directly to switch to manual allocation; edits save on release, finishing an edit or Enter. Manual allocations may exceed 50% but must retain active explorers and two explorer slots. Existing paid work finishes unchanged. Extras still take a full game week, and finite storage bounds offline processing.

### Water production facilities

After founding, build any of these permanent facilities once in Settlement → Buildings, using owned Wood, Metal and the FTH$ upgrade fees listed above:

| Facility | Wood (kg) | Metal (t) | FTH$ | Additional base Water output |
|---|---:|---:|---:|---:|
| Well | 3,000 | 0.2 | 280 | +100% |
| Rain collector | 6,000 | 0.45 | 570 | +200% |
| Pumping station | 12,000 | 0.9 | 1,140 | +400% |

Water facility bonuses are additive: all three give 8x Water output per assigned resident, combined with tier and terrain before rounding. They need a discovered site and residents, have no extra upkeep, and apply only to new full-week crews. Warehouses and reservoirs provide room for the output; moving facilities does not change effects.

### Population Water upkeep

Household Water starts at **50 L/person/game day**, or 350 L per week, a playable service-level target informed by [WHO domestic water guidance](https://www.who.int/publications/i/item/9789240015241), not a universal household average. Demand increases with summer, heat and sunny hot weather, up to a 1.45x multiplier before aggregate rounding up to the next 10 L lot. Daily bills average all eight weather periods. Owned Water alone pays consumption; debt is never created. Shortages pause advanced activity without removing residents or cancelling paid jobs.

Water crew planning includes forecast consumption during the work week, so full tanks do not prevent replacement production. New crews reserve room against owned-plus-pending storage when starting. Existing stock and locked deliveries are never discarded if storage limits shrink or stock changes during the week; new work waits for room. Production cannot be replayed.

### Seasonal and daily climate effects

| Season | Timber | Water | Metal | Oil | Recruitment |
|---|---:|---:|---:|---:|---:|
| Spring | 1.15x | 1.15x | 1x | 1x | 1.2x |
| Summer | 1x | 0.85x | 1x | 1.05x | 1x |
| Autumn | 1.05x | 1x | 1.05x | 1x | 1.1x |
| Winter | 0.65x | 0.7x | 0.85x | 0.85x | 0.7x |

Rain improves Water capture while slowing outdoor work. Snow and storms reduce most yields and attraction; temperatures below 5°C or above 28°C reduce labour efficiency, with additional frozen-water and evaporation penalties. Recruitment uses its climate-adjusted housing batch and still costs exactly FTH$50 per confirmed arrival. Paid arrival counts and durations are fixed at departure.

New-territory expeditions have climate- and seed-dependent finds: 1–2 collection permits, 0–2 activity permits and a chance of the unique biome keepsake. Suitability averages the entire trip; harsh conditions lower expected discoveries but never reroll on refresh or restart. Existing expeditions without a find plan retain their original three-find rules. Unique keepsakes remain unique and excess items remain safely pending.

The simulated weather/temperature sequence has a deterministic **16-game-year cycle**. Daily consumption prefix sums make very long idle/offline periods exact and bounded, while processing resumes at arrivals, automation events or the first possible Water refill. Online and offline results use the same daily rounding and calendar conditions; weather is not a real forecast.

Water supply has priority before growth and surplus. Only owned Water pays daily upkeep; pending Water must first be picked up. Independent daily deadlines and same-time arrivals are preserved; new arrivals join after upkeep. Legacy weekly-upkeep saves receive one full day of grace. Offline processing settles daily consumption, pending production, funded item-enabled auto-collection and paid arrivals without deleting residents, and bulk-skips stationary periods without changing online results.

Explore and Settlement keep their respective public and visitor chats visible in translucent panels, with map controls arranged around them. Inbox fills its dedicated page. Profile and nickname settings live in the avatar menu and do not alter gameplay ownership or balances.

Inbox, Federation, Journal, Contacts and Field guide retain dedicated pages. Contacts, Journal and the guide are reached through the avatar menu; Inbox retains the former communication URL. Journal supports localized event search and snapshot exports. The scrolling field guide explains daily needs and weekly work in eight illustrated, searchable chapters, with reading progress and bilingual anonymized example screenshots.

### Exploration

The seeded map includes forests, meadows, lakes, mountains, oil seeps, crystal outcrops, rainforests, pine forests, mangroves, grasslands, savannas, deserts, dunes, wetlands, rivers, coasts, hills, canyons, volcanoes, tundra, and glaciers. Elevation, climate, moisture, and river channels create varied regions. Starter wood, water, and metal sites are guaranteed nearby.

Known-tile travel is instant and does not uncover new terrain. Each expedition reserves **two available residents** for one to three game weeks according to terrain difficulty. Send multiple teams concurrently, limited only by available residents and FTH$. Weekly resource allocation never reassigns residents who are still exploring. New teams reveal a radius-2 circle of at most 13 tiles and return independently; the player stays in place. Active duplicate destinations are rejected, and overlapping surveys count newly revealed tiles only once. Each team has its own countdown. Equipment expands visibility and destination reach, not survey area. Already-travelling teams retain their saved radii and deadlines. Open water, rivers, coasts, and glaciers are not valid founding sites.

An expedition costs `(10 + 5 * ceil(distance from settlement) + 5 * (terrain weeks - 1)) * 2 ** active field teams` FTH$ upfront: 1x, 2x, 4x, 8x, and so on. Investigate and Explore share the count taken at departure; returned teams no longer increase the next fee. Both map clicks and quick exploration confirm the same authoritative quote. Moving the player cannot reduce settlement-based costs; known-terrain travel stays free. Already-paid expeditions keep their original costs and deadlines.

FTH$ is the main game currency; Metal is a construction resource. Gold is separate and exchangeable with FTH$. Neither currency is cash or a promise of future token allocation.

**Investigate** is a cheaper, repeatable action on discovered land, shown left of Explore. Two idle residents work for exactly one game week. The upfront base fee is 10% of the undiscounted concurrent Explore route fee (minimum FTH$0.10 before equipment). Equipped investigation gear alone can reduce it by up to 50%. Every active Investigate or Explore team doubles the next field fee. Each job has a 10% chance of one collection or activity permit; successful finds are 90% one-week and 10% four-week permits, never keepsakes or high-tier items. The server locks the result at departure, so retries and reloads cannot reroll it. Different known destinations may be investigated concurrently and reused after return. Investigations do not reveal land, add contribution or block exploration automation. Paid jobs finish despite later shortages; full item storage retains findings as pending. Already-paid legacy investigations retain their original one-resident, one-day deadline.

### Item inventory, equipment, and crafting

The dedicated `/settlement/` page uses the exploration map's isometric grid, terrain colors, trees, house artwork and weather effects. The 21-by-21 settlement parcel grows through every tier and includes banks and town halls when built. A persistent task dock opens residents, production, inventory, crafting, Layout and buildings in focused, independently scrolling panels, with a bottom sheet on smaller screens. Select a building to manage it. In Layout, drag a building or owned decoration onto an empty land cell, or choose Move on map and tap a destination. Coordinates and arrow-key/Enter controls support precise and accessible placement. Drag empty ground to pan and use the wheel or zoom buttons. Buildings cannot be demolished or duplicated; movement costs nothing and changes no economy, workforce or exploration effects. This local parcel never reveals unexplored world resources. The tier button opens the overview; Escape cancels placement or closes a task. Camera position, task drafts, filters, disclosures and panel scroll survive navigation and server refreshes. The map and settlement share the same session and language.

Only permanent utility equipment, cosmetic decorations, and collectibles occupy item slots; raw resources and their existing warehouses remain separate. Equipped and placed items each occupy one slot. Discover each recipe's resource types through exploration before spending owned ingredients:

| Item | Recipe | Visibility radius |
|---|---|---|
| Campfire kit | 750 kg timber | 5 |
| Torch | 400 kg timber (including resin) | 6 |
| Lamp | 0.12 t Metal + 3 bbl Oil | 8 |
| Explorer lantern | 0.2 t Metal + 5 bbl Oil + FTH$4 | 10 |

Equip one visibility item; unequipped visibility radius is 4. Equipment never expires and expands the visible map and reachable destinations; new expeditions still survey at most 13 tiles. Equipment never reveals terrain instantly or changes locked teams. Better newly crafted equipment auto-equips. Legacy torch/lantern upgrades migrate free to torch/lamp items with their existing 6/8-radius view.

Material-and-FTH$ item storage tiers are Bag (20 slots), Carrier (40; 0.5 t Metal + FTH$100), Crate (60; 1.5 t Metal + FTH$200), Container (80; 4 t Metal + FTH$300), and Item warehouse (100; 10 t Metal + FTH$400). Identical items share one displayed stack with a quantity, including market-reserved copies; pending finds are also grouped. Pages show up to 20 distinct filtered stacks. Every individual owned or reserved copy still uses one storage slot, including equipped and placed copies. Each upgrade adds room for 20 copies, not unlimited stacks, and does not change resource storage. Existing saves keep their purchased tier and items. Using a permit consumes only one owned copy; equipped/placed copy protections remain unchanged.

Expeditions that reveal new tiles use the climate-dependent discovery plan above. No new tiles means no find; duplicate and overlapping surveys cannot duplicate unique keepsakes. Permits can be owned in multiple copies. Finds enter free slots automatically. Overflow remains pending without loss; expand item storage and collect as many as fit, leaving the rest pending. Weekly raw-resource output waits for paid pickup unless that resource has an active, funded auto-collection permit; already-paid legacy jobs still deliver normally.

Decorations can occupy any empty land cell in the settlement parcel, not just six designated spaces. Craft flower planters (12 Wood, 6 Water), benches (24 Wood, 2 Metal), pioneer banners (12 Wood, 4 Metal), fountains (60 Metal, 40 Water), boardwalks (45 Wood, 6 Metal), and market canopies (36 Wood, 8 Metal), using discovered ingredients and owned resources. The catalog adds 24 decorations across nine civilization tiers: simple log seats and wildflower beds, village gazebos and clock towers, town lighting and pavilions, city solar pergolas and living walls, and capital biodomes and sky beacons. Each has distinct artwork and variable resource budgets. Metal includes mineral construction supplies, Water includes planting/filling, and Oil includes fuel/polymer processing. These are simplified settlement supply bundles.

Wide desktop settlement panels show compact crafting/building cards with visible resource costs, small icon actions and **Recipe available/required item ingredient types** links. Raw resources and FTH$ remain mandatory costs but do not count in the recipe fraction. Details show separate owned/required item inputs and resource costs. New crafting charges use 10% of baseline raw-resource costs and explicit/material-valued FTH$ fees, with a minimum **FTH$1 per output copy**, including collector bundles. Item ingredients and bulk permit consumption remain unchanged. Bulk costs scale by output count. Cards show live per-item market sell prices, seven-real-day changes and estimated profit/loss including all inputs and fees; missing quotes never invent values and estimates do not guarantee profit. Higher-tier crafting requires the matching civilization level; owned-item trading and placement remain available. Each recipe, building, storage expansion and settlement upgrade has its own persisted two-real-second cooldown; quantities and alternate routes cannot bypass it. Investigation retains its separate cooldown. Requests remain serialized with activity animation. Failed validation or cancellation spends nothing; idempotent retries replay historical receipts unchanged. Catalog budgets, reserve seeds, financial policy and ledger history are preserved; new markets use signed additive authorization.

Placement is free after founding and uses owned items only. Each building or decoration occupies one cell; occupied cells, water and positions outside the parcel are rejected. Move or return a decoration to inventory before reusing its cell. Returning decorations never destroys items, and placed decorations still occupy one inventory slot. These cosmetics never change production, workforce, exploration visibility or rewards. Positions persist with transactional saves and exact-once retry receipts. Existing six-space layouts migrate onto the grid without losing items or ongoing work. New tier buildings find empty cells without moving existing custom layouts.

### Consumable bulk crafting permits

Reduced crafting resources round upward to whole accounting units per copy,
preserving integer inventory balances. FTH$ fees retain monetary precision and
never fall below FTH$1 per output. Small resource requirements therefore may
reduce by less than 90%; item ingredient counts remain unchanged.

Craft one copy without a permit, or consume one matching permit for an exact batch
of 10, 20, 50 or 100 copies. Four staged recipes combine existing decorations,
unused collector permits and raw materials: the 10-copy permit unlocks at
Settlement, 20 at Neighborhood, 50 at Town and 100 at City. Permits can also trade
at spot prices. Click Craft to see owned batch options, disabled shortfalls and
the largest feasible exact batch, then review total ingredients, permit consumption
and output count. A higher permit does not authorize smaller batches.

All spending is atomic and server-authoritative. Cancellation, shortages, invalid
quantities and failed requests consume nothing; retries never consume twice.
Storage accounts for the consumed permit before adding output. Batch and single
crafting share the same recipe cooldown. Existing monetary policy, historical
retry receipts, keys and ledger history are preserved; four additional markets
use signed additive authorization.

### Permanent activity equipment

Nine craftable equipment items reuse decorations, unused collector permits and raw
materials to lower new activity fees. Investigation has Survey satchel (10%,
Settlement), Field survey station (25%, Village) and Precision survey array (50%,
City). Exploration has Trail supply kit (10%, Settlement), Expedition outpost kit
(25%, Village) and Expedition logistics network (50%, City). Attraction, meaning
resident recruitment, has Settler welcome kit (10%, Settlement), Community welcome
pavilion (25%, Town) and Settler hospitality network (50%, City).

Equip one permanent item per activity in inventory. Owning additional copies does
not stack effects, and the maximum discount is 50%. Fees round upward to FTH$0.0001;
manual actions, automatic departures, affordability checks and confirmations use
the same server-validated equipment. Investigation starts from its undiscounted
route fee, not an exploration-discounted quote. Staffing, discovery probabilities,
arrival counts and already-paid jobs remain unchanged. Crafting consumes unused
ingredients atomically but does not automatically equip the result. Placed
decoration copies, pending finds, market escrow and active automation time cannot
be used as ingredients. Equipped copies are protected from sale; spares remain
spot-tradable. Existing monetary policy, keys, genesis and reserve targets are
preserved; the new markets use signed additive authorization only.

### Paid weekly collection and owned storage

Active residents complete a full game week before resources become ready for pickup. Each resource button opens its collection controls; there is no aggregate header Claim button or 50% threshold. Pickup costs `workers*(1+max(0,ceil((effectiveDistance-4)/4)))` FTH$ for every worker, including Wood and Water. No payment is taken at dispatch. Completed quantities and their transport fees remain pending until collected. Owned and pending quantities share storage room; full storage pauses new work.

Capacity calculations use integer accounting lots. Raw capacity is the largest of `100 + tierIndex*100 + warehouseLevel*500`, the largest next/current-tier material requirement times `warehouseLevel+1`, and two peak-climate weeks of population-scaled Wood/Metal upkeep. Water uses the larger of raw capacity and `ceil(population*35*1.5)*(2+reservoirLevel)` lots; there is no fixed extra 29,000 L allowance. A 12-resident Settlement starts with 12,600 L capacity, including a 50% hot-weather reserve. UI converts each resource's capacity to its own physical unit. Warehouses reach level 99 and cost `targetLevel*(4,000 kg timber + 0.2 t Metal + FTH$50)`; Water facility bonuses do not expand storage. Existing owned stock, pending fractions and full locked deliveries remain even above reduced limits; new gathering waits for space.

Existing balances, fractional remainders, currency, escrow, receipts and deadlines are preserved. Already-paid legacy deliveries complete under their existing terms without a second transport charge. New jobs use paid pickup.

Resource-specific automation consumables are discovered on expeditions that reveal new territory and can be traded between players. They last 1, 4 or 12 game weeks. Activation consumes one item and adds its duration to any remaining time for that resource. Auto-pickup pays the same transport fee; insufficient FTH$ leaves the output safely pending. Unused consumables may be owned in multiples and occupy one slot each.

Exploration and recruitment permits use the same 1/4/12-week consumable, stackable-duration model. Activate from inventory or Population → Allocation & automation. Auto-exploration keeps one team travelling, waiting for all manual teams to return. Auto-recruitment starts the next paid batch after arrival. Normal FTH$ fees, housing-adjusted recruitment cost, Water requirements and full-week deadlines apply. Blocked activity displays its reason and retries daily. Pausing and expiry stop new dispatches without cancelling paid jobs; the permit clock continues while paused. Offline catch-up and frequent polling settle the same scheduled work and fees.

Collect-and-sell atomically sells a resource's completed output at marketplace prices and deducts transport from the proceeds. The confirmation shows protected minimum net proceeds. Insufficient liquidity or a changed quote rolls back the entire operation. No FTH$ is minted, and selling Water still requires care. The population-health header opens the same recruitment, allocation, expedition and Water controls as Settlement.

These are game mechanics, not token staking or a cryptocurrency reward program.

### Recruitment

Recruitment costs only FTH$: **FTH$50 per arriving resident**. The quote is displayed before recruitment. Founding grants no FTH$; sell owned resources to fund the initial 18-person batch costing FTH$900. A successful batch adds the greater of:

- 18 residents; or
- 12% of the current population, rounded down.

The final batch is `floor(base * (1 + housingLevel / 4))`; each arriving resident still costs FTH$50. Housing affects only future dispatches and imposes no new population cap.

Recruitment can start after settling when Water is sufficient, but every batch, including the first, takes **one server game week (seven game days)** to arrive. FTH$ is paid upfront and batch size is locked at dispatch. Pending recruits do not count as residents or workers. Only one batch can be in progress, and completed batches never repeat automatically. Offline time completes the paid batch, not additional batches. Existing saves retain already-joined residents and any remaining legacy cooldown; no pending batch is fabricated.

Dispatch cost and the pending batch are committed atomically. State reads or actions settle arrivals at the deadline, updating population and the current global/federation census in the same transaction exactly once. Arrivals never receive retroactive production; any new work must take a full week. Retries or concurrent requests cannot turn one successful invitation into multiple batches.

## 4. One game clock

Development and production use the same continuous clock and identical game rates, costs, durations, thresholds, and batch sizes:

| Mode | Server game time |
|---|---|
| Production | 33.6 server seconds per real second |
| Local development | 33.6 server seconds per real second |

The clock drives resource accrual, recruitment, world days, seasons, weather, and temperature together. Recruitment takes the same full week as basic collection or exploration.

A work week is seven world days, or **168 server minutes**: **five real minutes at 33.6x**. Harder expeditions take ten or fifteen real minutes. Crews, expeditions and recruitment retain their game-time deadlines across restarts and clock migrations. Existing elapsed time is counted at the previous speed before switching. Real-time action limits and a 500-millisecond collection cooldown remain independent of this clock.

The clock anchor and speed persist. Restarting or changing speed preserves the game timeline rather than resetting it. Legacy rate-multiplied records migrate without discarding pending resources or remaining recruitment work.

### Calendar and environment

- Epoch: 2026-01-01 00:00 UTC.
- One world day: 24 server minutes.
- One week: seven world days.
- One season: 13 weeks, or 91 world days.
- Seasons: Spring, Summer, Autumn, Winter.
- One calendar year: 52 weeks / 364 world days, containing four seasons.
- Week 52 resets to Week 1 at each new year.
- Weather windows: three server minutes.
- Weather, temperature, and daylight are deterministic simulations, not forecasts.

The shared Explore, Settlement and Marketplace header shows Year, Week (out of 52), and game hours with a day/night icon. Seven daily segments show completed days, gradual progress through today, and days remaining. Accessible values identify the week and day. UTC-formatted server time is secondary; in development it is not wall-clock UTC. Season and weather stay in the top-right map overlay.

The former 1,680-day calendar is replaced by this 52-week calendar without modifying saved timestamps, paid work, pending resources or production/exploration deadlines. Seasons now align with the four 13-week quarters; weather windows and work-week durations are unchanged.

Browser interpolation uses the server timestamp, server-provided clock speed, and monotonic elapsed time. It does not award resources. Pending balances remain server-confirmed and refresh every 30-35 real seconds while visible. The display freezes after 90 real seconds without synchronization.

**Security and transport timers stay on real time.** Session expiry, request/action/claim abuse limits, network timeouts, and polling do not accelerate with the game clock.

## 5. Population and governance boundaries

The header shows:

- **Settlement:** the player's simulated residents.
- **Federation:** residents of all server settlements in the same named mock federation, including the player's settlement.
- **Global:** residents of server-owned settlements, not invented neighboring populations.

Nonmembers have no federation total. Global totals include inactive settlements after anonymous session expiry; aggregate population remains after session cleanup.

Counters are updated transactionally and read by indexed lookup. They are not verified real-person counts, token-holder counts, measures of democratic representation, or a claim that the service has a matching number of users.

The homepage shows established settlements, FTH$ circulation, the live Gold/FTH$ reserve rate and this same global population census. Circulating Metal is not displayed on the homepage. Inactive settlements and their last recorded balances remain in the totals.

The **Featheral Dollar · FTH$ circulation** counter reads total supply from the authoritative Dollar journal, including wallets, market reserves, escrow and system treasury. It displays at most two decimals without rounding stored funds. Gameplay fees, trades and donations transfer existing funds; new bridge conversions and reward credits are disabled. FTHG supply and staking principal are read separately from Ethereum. FTH$ is not USD or an on-chain token.

These are near-live snapshots, refreshed every 30-35 real seconds while the page is visible, with up to 15 seconds of shared-cache reuse. An arrival count-up reaches the real totals over 2.2 seconds; later increases or decreases animate over 1.4 seconds. The animation interpolates only toward actual reported totals, never predicts growth or continues beyond its target. Hidden tabs or failed updates settle at the last known target. Failed updates explicitly mark last-known totals; a first-load failure does not display invented zeros. Reduced-motion users and screen readers receive actual snapshot totals without stepping through animated intermediate values.

Settlement and metal totals initialize from worlds still persisted when the feature is first enabled. Previously purged worlds cannot be reconstructed. The older population census is retained as-is, so it may include residents from worlds purged before that initialization.

The current vote is a simulation record inside a player's world. Token-weighted governance, delegation, identity systems, sybil resistance, quorum rules, treasury execution, and real public decision-making are **not implemented**.

## 6. Featheral Gold on Ethereum

| Item | Current status |
|---|---|
| Name | Featheral Gold |
| Ticker | FTHG |
| Network | Ethereum Mainnet |
| Contract | `0xBa658127d93B17E577E1B8e8995cAB3aE7d7C665` |
| Live token supply | Read from Ethereum through Gold API |
| Token sale or presale | None |
| Airdrop or token claims | None |
| Wallet connection | Selected Ethereum wallet with explicit authorization |
| Gold exchange | Separate deployed/funded Ethereum bridge, when configured |
| Investment return or governance right | None promised |

FTHG is never simulated or issued by World. Token custody and staking principal remain on Ethereum. The separate bridge and reserve deposits are operator prerequisites, not consequences of starting the game. Always verify contract addresses and approvals independently.

This paper is not an offer to sell, solicitation to buy, financial advice, or a promise of profit. Access to the simulator does not create investment, ownership, revenue-sharing, redemption, voting, or other legal rights.

Never share private keys or seed phrases. Do not approve wallet transactions based on this prototype, a placeholder address, or an unverified social account.

## 7. Architecture and trust

The current implementation uses:

1. A TypeScript/Vite browser client.
2. Gold API for Ethereum reads and Dollar API for all FTH$ operations; World owns sessions and chat.
3. A replaceable Store boundary.
4. SQLite for gameplay state, sessions, receipts, clock anchors and aggregates; the signed Dollar journal is authoritative for currency, pools and escrow.

The browser sends a strictly allowlisted command, expected revision, and request identifier. The server derives ownership from the session cookie, obtains trusted time, validates the command, and commits accepted changes atomically.

### Implemented safeguards

- Random bearer sessions with hashed storage, HttpOnly cookies, and SameSite restrictions.
- Session-bound CSRF tokens, Origin checks, and Fetch Metadata checks.
- Strict command fields; clients cannot choose timestamps, balances, clock speed, or reward amounts.
- Transactional spending, claiming, recruitment, revisions, and census updates.
- Durable last-successful-request receipts for idempotent retry.
- Transactional state settlement that persists weekly transport charges exactly once without automatically claiming resources.
- Resource caps, claim thresholds, bounded requests, and real-time abuse limits.
- No import path that trusts an exported or browser-stored balance.

**CSRF does not prove a human is playing.** A script using a legitimate session can obtain tokens and submit valid actions. The aim is to constrain what any session can receive, not to promise absolute bot prevention.

Anonymous sessions also do not prevent multi-account farming or establish one-person-one-vote identity.

### Local mock limits and cloud adaptation

The mock has deliberately bounded sessions and in-process rate limits. It is not certified, independently audited, production-hardened, or demonstrated to support millions of players.

A production service needs authenticated identity and recovery, monitored authoritative time, shared abuse limits, durable distributed storage, coordinated clock configuration, transactional or conditional-write guarantees, backups, auditability, load testing, security review, and jurisdiction-appropriate legal and privacy review.

Exact global/federation, settlement, and metal counters become shared write hot spots at scale. Sharded counters or materialized aggregates with a durable idempotent outbox and an explicit display-lag policy are possible adaptations, not existing distributed infrastructure. Public statistics permit short shared-cache reuse; a production deployment must configure that cache and load-test its read tier.

## 8. Sessions and privacy

The landing page does not create a game identity, connect a wallet, enroll notifications, or collect an email address. It requests public aggregate statistics without sending session cookies; no individual world, credential, or wallet data is included in that response. Starting the simulator creates or resumes an anonymous cookie session.

Guest cookies grant access for seven real days and cannot recover an unlinked world once lost. Wallet-authorized sessions can last 400 days; a new wallet signature restores the same linked settlement. Revocation ends the current browser capability without deleting the settlement or wallet funds. Exports cannot restore balances.

The backend processes session credentials and direct connection addresses for authentication and request limiting. Hosting providers may process normal access logs. Deployment-specific retention, consent, identity, and privacy policies must be established before public production use.

The interface defaults to English with a 한국어 / English selector. Only this language preference is stored separately in the browser; switching does not change worlds, balances, sessions, or server time. Server identifiers and exported snapshots retain their language-independent source representation.

## 9. Research directions, not commitments

Questions worth exploring include:

- How do resource constraints affect willingness to coordinate?
- Which governance ideas are understandable through play?
- What should count as a meaningful contribution?
- How should representation differ from wealth?
- How can a system make uncertainty, disagreement, and trade-offs visible?
- Which functions, if any, benefit from on-chain implementation?
- How can identity and anti-abuse controls avoid excluding legitimate participants?

Possible future multiplayer, identity, delegation, protocol, and token experiments remain proposals. No feature delivery date, token event, funding outcome, or public deployment is promised.

## 10. Participate safely

The intended participation paths are playing the simulator, reading the design, following development on GitHub, and discussing ideas through official community channels.

**GitHub, Discord, X, Telegram, and the public website URL have not yet been published.** The landing page marks those links Coming soon until verified URLs are supplied. There is no working email list, automatic notification subscription, or social-account connection.

Use the links published on the landing page once available. Treat unsolicited token-sale, airdrop, support, or investment messages as unverified. Community participation does not require sending cryptocurrency.

---

**In one sentence:** Featheral is a little world for exploring bigger questions, not a financial promise.
