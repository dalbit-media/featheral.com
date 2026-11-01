# Featheral
## A playful sandbox for communities, shared resources, and governance

[한국어 백서](./WHITEPAPER.ko.md)

**Status:** Research draft and playable prototype. Not a token offering.

**Main currency:** Featheral Dollar (FTH$). **Gold:** Featheral Gold (FTHG), a separate off-chain balance for a future Ethereum-linked token.

**Intended network:** Ethereum. No deployment exists.

> Featheral is a single-player simulation with a server-backed mock economy. It is not a live DAO, investment product, source of monetary rewards, or system of real-world political authority. All game balances, residents, markets, votes, and rewards are simulated.

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

Joining Evergreen Union requires at least a Village and 50 relationship points. A goodwill shipment costs 4 m³ of timber and 0.3 m³ of Water and adds 25 relationship points, up to 100.

Founding the named mock Verdant Federation requires at least a City, **strictly more than 10,000 residents**, and 50 t of Metal. Founding is not a contract deployment.

A Town with a town hall and federation membership can record its simulated vote once on the current proposal. There is no live on-chain tally, quorum mechanism, treasury execution, or legal representation.

### Marketplace

The standalone `/play/market/` exchange has **53 markets**: four raw resources, ten crafted items, 21 keepsakes and 18 automation permits (12 collection, three exploration and three recruitment). All non-collectible assets are fungible, demand-priced liquid assets using the same reserve formula, 1% spread and player-order matching. Orders support up to 10,000 whole units, subject to balances and item storage; each item copy occupies one slot. Additional crafted copies are allowed. One equipped/placed copy is protected, while spares can be sold. Keepsakes remain unique, trade one at a time and use player orders only; without offers they show no quote. Existing collectible pool reserves are redistributed once to fund item liquidity without issuing FTH$ or changing monetary-policy constants, orders or receipts.

Card browsing highlights artwork, category, holdings and separate Buy/Sell FTH$ quotes. Missing offers are labelled rather than shown as fictitious prices. Account opens **Featheral Bank** (`/play/bank/`) from its FTHG card; Gold conversion is no longer embedded in the marketplace.

### Featheral Bank: funded long-term staking

Stake FTHG for **1, 2, 5, 10, 20 or 30 game years** and receive FTH$ simple interest. A year is exactly 52 game weeks: 6 real days 1 hour 36 minutes at production speed, or 7 hours 16 minutes 48 seconds at development 20x speed. Real-time duration and estimated maturity are displayed; saved game-time deadlines are unaffected by later clock-speed changes.

At deposit, the current Gold-pool reference ratio determines a fixed FTH$ valuation, rounded down to 0.0001. Interest is `floor(valuation subunits × APR basis points × years / 10,000)`; it does not compound. The valuation, approved APR, principal, total interest and term must match the reviewed quote exactly. Existing positions never change when exchange prices or council rates change.

Server-appointed councillors set APR through strict-majority votes, with one vote per member and the proposer initially voting yes. Rates range from 0% to 100% in 0.01% increments. A membership change cancels pending proposals; new rates apply only to new deposits. No configured council, no approved positive rate or insufficient funding means staking is unavailable.

Rewards come only from irrevocable voluntary donations of **existing FTH$**. Full-term interest is reserved before acceptance, separately from FTHG principal. At maturity, the owner claims original FTHG and reserved FTH$ atomically. There is no early withdrawal, new currency issuance or use of principal to pay interest. Bank rewards and locked principal remain included in currency-supply accounting.

This is in-game staking, not an Ethereum transaction or a guarantee of real-money returns. Unclaimed positions and councillors are protected from ordinary session cleanup; bank visits renew a 400-day browser cookie. Clearing this anonymous browser identity can lose access: exported records are not authentication or recoverable balances.

### Marketplace order rules and Gold conversion

Player limit orders use price-time priority and cannot match themselves. Constant-product pools provide additional liquidity with a 1% spread per side. Exact BigInt arithmetic rounds buys up and sells down to 0.0001 FTH$. Spot orders enforce a maximum 2% total-price movement and either fill completely or fail without spending. Initial pools hold 100,000 accounting lots per raw resource and 1,000 pieces per item, with reference-price FTH$ reserves. Metal starts at FTH$200/t before spread, not a peg. These finite simulated reserves have no real financial backing.

Buy orders escrow FTH$ and sell orders escrow owned assets. Partial fills retain unfilled escrow; cancellation returns it. Item bids and asks reserve inventory slots. The limit is 50 open orders per session; orders expire with the seven-day session. Resource orders accept 1–10,000 accounting lots: timber 0.1–1,000 m³ in 0.1 m³ increments, Water 0.01–100 m³ and Metal 0.01–100 t in 0.01 increments, Oil 1–10,000 bbl. Liquid items use whole pieces; unique collectibles use one piece. Limit prices retain FTH$0.0001–1,000,000 per accounting lot; displayed per-unit prices and ticks are multiplied by lots per unit (10 for timber, 100 for Water/Metal, 1 for Oil/items). Charts show the latest 120 real executions, never fabricated history. Quotes refresh every five seconds. SQLite persists both accounts, escrow, reserves, trades and idempotent receipts atomically.

FTH$ and Featheral Gold (FTHG) are separate balances, each stored as 10,000 integer subunits per unit. APIs expose ordinary amounts, not subunits. Gold remains the future Ethereum-linked token concept, not the marketplace quote currency. A separate reserve pool buys and sells fractional Gold (0.0001–10,000), with a live reference rate, 1% spread per side and 2% confirmation protection. A fresh world's pool starts with 1,000 Gold and FTH$1,000,000: FTH$1,000 per Gold before spread. Trades move the rate and retain fees in the pool. An existing world preserves its former market Gold reserves in this pool and seeds the corresponding FTH$ reserve at the same initial reference rate.

The version-4 migration converts owned and pending Lithium to FTH$ 1:1, preserves existing Gold wallets, cancels old Gold orders and refunds Gold buy escrow or original sell assets. Paid resource work and expedition deadlines remain; Lithium crews and allocations are removed. Historical Gold pools, orders, fills and receipts are archived in `legacy_gold_market_*`, never relabelled as FTH$ trades. Weekly income is disabled under the subsequent no-mint rules. Stale receipts and revisions are invalidated. Invalid balances or orphan escrow roll back the whole transaction; restart never refunds twice.

### Finite FTH$ balances and spending

New players and founding settlements start with **FTH$0**. Residents, banks, commercial buildings and exploration never grant FTH$, including offline time and previously dispatched expeditions. Existing balances, buildings, paid work and receipts remain intact; there are no retroactive refunds. The no-mint rule invalidates stale new action revisions once.

Recruitment still costs **FTH$50 per arriving resident**. Exploration still costs FTH$ by distance/difficulty but rewards discovery and collectibles, not currency. Transport and upgrades consume FTH$. Marketplace sales transfer existing player escrow or pool reserves into the seller's wallet; Gold exchanges transfer existing reserves. Initial market reserves are provisioned once and never replenished by gameplay. No action mints new FTH$, and fixed-price legacy trades and global currency reward claims are disabled.

Commercial buildings retain their ownership, placement and material/FTH$ construction costs, but generate no income: Market stall (Camp; 8 m³ timber + 0.4 t Metal + FTH$200), Commercial workshop (Neighborhood; 20 m³ timber + 1 t Metal + FTH$600), Trade hub (Town; 50 m³ timber + 3 t Metal + FTH$1,800). The bank still unlocks Oil collection and resource trading. FTH$ is simulated game currency, not USD or an on-chain token; cash withdrawals are disabled.

**Settlement → Sell resources** is available immediately after founding, without a bank or commercial building. Review the live spot quote to sell `floor(owned / 2)` of every raw resource in one confirmation. Pending stock and sell-order escrow are excluded; zero quantities are skipped. Exact halves above 10,000 units are supported. Each resource retains the conservative 2% minimum-proceeds protection and existing market spread. One atomic transaction sells everything or nothing, including player orders, pool movements and fills; retries cannot sell twice. Selling Water can reduce upkeep reserves, so review the Water warning before confirming.

### Permanent monetary policy, version 1

After the one-time reserve bootstrap, FTH$ is never issued. Gameplay payments are **permanent burns**, not treasury deposits. Trades only transfer existing wallet, escrow and pool balances; pool spreads stay in the reserves. Advanced play can eventually exhaust currency or liquidity. Free basic gathering and non-destructive shortages keep residents and basic activity available, but do not promise endless monetary funding.

Resource and Gold pools share one integer constant-product rule. With currency reserve R, asset reserve S and quantity q: buys pay `ceil(R*q*101 / (100*(S-q)))`; sells receive `floor(R*q*99 / (100*(S+q)))`. R is in 10,000 FTH$ subunits; Gold uses subunits for S and q, while resources use whole units. Orders retain 2% quote protection. Player orders keep price-time priority. Market prices can change without changing this formula.

The policy constants and fingerprint are persisted alongside the measured initial supply. Startup refuses changed policy settings or holdings above that supply ceiling. New or missing markets after bootstrap start with zero system reserves, never newly issued FTH$; player orders remain available. This is an off-chain operational safeguard, not cryptographic immutability against future administrators.

### Eight-level useful constructions

All materials and FTH$ below multiply by the **target level**, up to level 8. Effects apply only to new work; paid deliveries and expeditions remain unchanged.

| Construction | Unlock | Level-one materials and FTH$ | Benefit per level |
|---|---|---|---|
| Residential quarter | Settlement | 6 m³ timber + 0.2 m³ Water + 0.1 t Metal + FTH$300 | Future recruitment batch +25%; no new population cap |
| Water reservoir | Settlement | 8 m³ timber + 0.3 t Metal + FTH$380 | One additional population-scaled week of Water capacity, including 50% hot-weather reserve |
| Commercial workshop | Neighborhood | 20 m³ timber + 1 t Metal + FTH$600 | Wood, Metal and Oil yield +25% |
| Trade hub | Town | 50 m³ timber + 3 t Metal + FTH$1,800 | Effective collection distance reduced by two tiles |

Existing workshops and trade hubs count as level 1 without repurchase. Facilities never grant currency. Sustainable identity, session retention, sharding, moderation and large-scale social services are **deferred**; the current seven-day anonymous sessions, 10,000-session limit and 1,000-chat limit are not billion-user infrastructure.

### Upgrade fees and settlement quick sales

Every settlement upgrade after founding requires materials and FTH$. The fees are Camp FTH$200, Neighborhood FTH$300, Village FTH$400, Town FTH$500, District FTH$600, City FTH$700, Metropolis FTH$800 and Capital FTH$800 (its existing fee is retained). Founding has no FTH$ fee. Resource warehouses add FTH$50 × new level; item storage adds FTH$100 × new level, alongside existing materials.

Other buildings and visibility equipment without an existing FTH$ price add their material reference value: timber FTH$40/m³, Water FTH$200/m³, Metal FTH$200/t and Oil FTH$24/bbl (equivalent to the preserved 4/2/2/24 FTH$ accounting-lot references). Thus banks cost an additional FTH$3,200; town halls FTH$1,500; wells FTH$280; rain collectors FTH$570; pumping stations FTH$1,140; campfire kits FTH$70; torches FTH$120; lamps FTH$320. Existing income-building FTH$ costs and the lantern's FTH$4 remain unchanged. Already-owned upgrades are preserved, and moving or equipping owned items is free.

Construct a market stall, trade hub or city bank to unlock **Sell resources for FTH$** in Settlement → Buildings and Production. Choose a physical quantity or Max, check the live spot total, then review and confirm. Only owned, claimed resources can be sold, up to 10,000 accounting lots per order. Settlement sales use the same marketplace endpoint, player-order/pool matching, 1% pool spread and conservative 2% price protection; banks never invent a fixed sale price. New gathering waits for paid pickup unless funded automatic collection is active. The full marketplace remains accessible before constructing these buildings.

Pricing migration invalidates stale gameplay revisions once while preserving existing balances, buildings, paid crews and deadlines. Previously paid Metal transport is not refunded or charged again; its delivery completes normally. Only additional Wood/Water workers and all Metal/Oil workers pay FTH$ transport.

## 3. A server-authoritative game economy

### Resources

The gatherable resources are wood, water, metal and oil. FTH$ and Gold are balances, not resource crews.

#### National-scale commodity units

| Resource | Trading / storage unit | One exact accounting lot |
|---|---|---|
| Timber | m³ | 0.1 m³ |
| Water | m³ | 0.01 m³ = 10 L |
| Generic Metal | metric tonne (t) | 0.01 t = 10 kg |
| Oil | barrel (bbl) | 1 bbl = 158.987294928 L |

The petroleum barrel is [42 US gallons](https://www.eia.gov/tools/glossary/index.php?id=B). One metric tonne is 1,000 kg; one m³ is 1,000 L. Prices are FTH$ per displayed commodity unit, not per hidden lot. Inputs accept whole accounting lots: 0.1 m³ timber, 0.01 m³ Water, 0.01 t Metal, or 1 bbl Oil. Items remain counted in pieces. These are real-world units with playable, simplified infrastructure budgets, not literal industrial engineering or real commodity contracts; generic Metal does not represent a quoted steel, copper or lithium grade, and FTH$ is not USD.

Physical model version 1 assigns these exact lot sizes without rescaling stored integers. Stocks, pending fractions, pool quantities, orders, prices, escrow, currency and receipts retain their economic value. Displayed quantities divide by lots per unit while displayed prices multiply by the same factor. Initial raw pools therefore contain 10,000 m³ timber, 1,000 m³ Water, 1,000 t Metal and 100,000 bbl Oil. Monetary-policy version 1 and its fingerprint are unchanged. Migration records a cutover timestamp; earlier work uses its saved terms, and completed actions are not replayed.

There is **no passive resource production**. After settling, residents are automatically allocated by resource, not individual tiles. All explored resources are connected using the best net-value route from the settlement; ties favor shorter routes. Each resident has one job, with two residents reserved for expeditions. One crew per resource delivers every **seven world days**. Baseline weekly yields per resident are:

| Resource | Production |
|---|---|
| Wood | 10 m³ multiplied by tier number and site yield |
| Water | 6 m³ multiplied by tier number and site yield |
| Metal | 1 t multiplied by tier number and site yield |
| Oil | 14 bbl multiplied by tier number and site yield, with a city bank |

Settlement is tier number 1. Terrain efficiency ranges from 80% to 180%; federation metal crews receive a further 20%. New work additionally applies season, weather and temperature factors averaged over all eight daily weather windows in seven calendar days. Output is rounded down to whole accounting lots per worker, not whole m³ or tonnes, and locked when the work week starts. Production is real-world-inspired rather than a claim about actual national industrial productivity.

New games receive 18 m³ timber, 25.6 m³ Water and 0.8 t Metal, leaving 25.2 m³ Water after founding for 12 residents. FTH$ starts at zero. Sell owned resources or collect-and-sell completed production to fund transportation. Every crew pays transport at pickup; there is no free-transport allowance for new jobs. Water storage scales to at least two population-weeks with a 50% hot-weather reserve.

Automatic allocation targets **50% total utilization**, rounded down, including residents already exploring. New gathering is limited to `max(0, min(floor(population / 2) - active explorers, population - max(2, active explorers)))` residents. Population-scaled Water storage and growth materials take priority within that budget. Explorers at or above the target pause new gathering, not paid expeditions. Gathering can start without FTH$, but completed production cannot be taken into inventory until its transport is paid. Automation of allocation is separate from item-enabled auto-collection. Workers need a whole game week; selling resources transfers existing marketplace FTH$ rather than creating money.

After priority crews are allocated, extra gathering fills only the remaining 50% budget. Each extra worker selects the route with the highest marginal resource value after transport; value uses fixed resource reference prices, not live market quotes, and counts only output fitting in remaining storage. Full storage or supply shortages can lower utilization. Use the +/- controls, sliders or exact counts directly to switch to manual allocation; edits save on release, finishing an edit or Enter. Manual allocations may exceed 50% but must retain active explorers and two explorer slots. Existing paid work finishes unchanged. Extras still take a full game week, and finite storage bounds offline processing.

### Water production facilities

After founding, build any of these permanent facilities once in Settlement → Buildings, using owned Wood, Metal and the FTH$ upgrade fees listed above:

| Facility | Wood (m³) | Metal (t) | FTH$ | Additional base Water output |
|---|---:|---:|---:|---:|
| Well | 6 | 0.2 | 280 | +100% |
| Rain collector | 12 | 0.45 | 570 | +200% |
| Pumping station | 24 | 0.9 | 1,140 | +400% |

Water facility bonuses are additive: all three give 8x Water output per assigned resident, combined with tier and terrain before rounding. They need a discovered site and residents, have no extra upkeep, and apply only to new full-week crews. Warehouses and reservoirs provide room for the output; moving facilities does not change effects.

### Population Water upkeep

Household Water starts at **50 L/person/game day**, or 0.35 m³ per week, a playable service-level target informed by [WHO domestic water guidance](https://www.who.int/publications/i/item/9789240015241), not a universal household average. Demand increases with summer, heat and sunny hot weather, up to a 1.45x multiplier before aggregate rounding up to the next 10 L lot. Daily bills average all eight weather periods. Owned Water alone pays consumption; debt is never created. Shortages pause advanced activity without removing residents or cancelling paid jobs.

Water crew planning includes forecast consumption during the work week, so full tanks do not prevent replacement production. Completed deliveries still obey actual owned-plus-pending storage limits. Changing population or buying Water cannot overfill storage or replay production.

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

Known-tile travel is instant and does not uncover new terrain. Each expedition reserves **two available residents** for one to three game weeks according to terrain difficulty. Send multiple teams concurrently, limited only by available residents and FTH$. Weekly resource allocation never reassigns residents who are still exploring. Teams reveal their survey areas and return independently; the player stays in place. Active duplicate destinations are rejected, and overlapping surveys count newly revealed tiles only once. Each team has its own countdown. Lighting affects only future teams. Existing single-team saves retain their deadlines when migrated. Open water, rivers, coasts, and glaciers are not valid founding sites.

An expedition costs `(10 + 5 * ceil(distance from settlement) + 5 * (terrain weeks - 1)) * (active expeditions + 1)` FTH$ upfront: 1x for the first concurrent team, 2x for the second, 3x for the third, and so on. The count is taken at departure; returned teams no longer increase the next fee. Both map clicks and quick exploration confirm the same authoritative quote. Moving the player cannot reduce settlement-based costs; known-terrain travel stays free. Already-paid expeditions keep their original costs and deadlines.

FTH$ is the main game currency; Metal is a construction resource. Gold is separate and exchangeable with FTH$. Neither currency is cash or a promise of future token allocation.

### Item inventory, equipment, and crafting

The dedicated `/play/settlement/` page uses the exploration map's isometric grid, terrain colors, trees, house artwork and weather effects. The 21-by-21 settlement parcel grows through every tier and includes banks and town halls when built. A persistent task dock opens residents, production, inventory, crafting, Layout and buildings in focused, independently scrolling panels, with a bottom sheet on smaller screens. Select a building to manage it. In Layout, drag a building or owned decoration onto an empty land cell, or choose Move on map and tap a destination. Coordinates and arrow-key/Enter controls support precise and accessible placement. Drag empty ground to pan and use the wheel or zoom buttons. Buildings cannot be demolished or duplicated; movement costs nothing and changes no economy, workforce or exploration effects. This local parcel never reveals unexplored world resources. The tier button opens the overview; Escape cancels placement or closes a task. Camera position, task drafts, filters, disclosures and panel scroll survive navigation and server refreshes. The map and settlement share the same session and language.

Only permanent utility equipment, cosmetic decorations, and collectibles occupy item slots; raw resources and their existing warehouses remain separate. Equipped and placed items each occupy one slot. Discover each recipe's resource types through exploration before spending owned ingredients:

| Item | Recipe | Survey radius |
|---|---|---|
| Campfire kit | 1.5 m³ timber + 0.05 m³ Water | 5 |
| Torch | 3 m³ timber | 6 |
| Lamp | 6 m³ timber + 0.4 t Metal | 8 |
| Explorer lantern | 8 m³ timber + 8 bbl Oil + FTH$4 | 10 |

Equip one visibility item; unequipped radius is 4. Equipment never expires and changes only future expeditions, not ongoing teams or already explored terrain. Better newly crafted equipment auto-equips. Legacy torch/lantern upgrades migrate free to torch/lamp items with their existing 6/8-radius view.

Material-and-FTH$ item storage tiers are Bag (20 slots), Carrier (40; 0.5 t Metal + FTH$100), Crate (60; 1.5 t Metal + FTH$200), Container (80; 4 t Metal + FTH$300), and Item warehouse (100; 10 t Metal + FTH$400). Each tier adds another compact 20-slot inventory page. Each cost upgrades one tier and does not change resource storage. Existing saves keep their purchased tier and items with the increased capacity.

Expeditions that reveal new tiles use the climate-dependent discovery plan above. No new tiles means no find; duplicate and overlapping surveys cannot duplicate unique keepsakes. Permits can be owned in multiple copies. Finds enter free slots automatically. Overflow remains pending without loss; expand item storage and collect as many as fit, leaving the rest pending. Weekly raw-resource output waits for paid pickup unless that resource has an active, funded auto-collection permit; already-paid legacy jobs still deliver normally.

Decorations can occupy any empty land cell in the settlement parcel, not just six designated spaces. Craft flower planters (2 m³ timber, 0.1 m³ Water), benches (3 m³ timber), pioneer banners (2 m³ timber, 0.1 t Metal), fountains (3 m³ timber, 0.4 m³ Water, 0.3 t Metal), boardwalks (4.5 m³ timber), and market canopies (5 m³ timber, 0.15 t Metal), using discovered ingredients and owned resources. Equipment and decoration recipes represent settlement supply bundles, not literal material bills for individual handheld objects.

Placement is free after founding and uses owned items only. Each building or decoration occupies one cell; occupied cells, water and positions outside the parcel are rejected. Move or return a decoration to inventory before reusing its cell. Returning decorations never destroys items, and placed decorations still occupy one inventory slot. These cosmetics never change production, workforce, exploration visibility or rewards. Positions persist with transactional saves and exact-once retry receipts. Existing six-space layouts migrate onto the grid without losing items or ongoing work. New tier buildings find empty cells without moving existing custom layouts.

### Paid weekly collection and owned storage

Active residents complete a full game week before resources become ready for pickup. Each resource button opens its collection controls; there is no aggregate header Claim button or 50% threshold. Pickup costs `workers*(1+max(0,ceil((effectiveDistance-4)/4)))` FTH$ for every worker, including Wood and Water. No payment is taken at dispatch. Completed quantities and their transport fees remain pending until collected. Owned and pending quantities share storage room; full storage pauses new work.

Capacity calculations use integer accounting lots. Raw capacity is the larger of `100 + tierIndex*100 + warehouseLevel*500` and the largest next-tier material requirement times `warehouseLevel+1`. Water uses the larger of raw capacity +2,900 and `ceil(population*35*1.5)*(2+reservoirLevel)` lots. UI converts each resource's capacity to its own physical unit. Warehouses have ten levels and cost `targetLevel*(8 m³ timber + 0.2 t Metal + FTH$50)`; Water facility bonuses do not expand storage.

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

Development and production use identical game rates, costs, durations, thresholds, and batch sizes. The only difference is clock speed:

| Mode | Server game time |
|---|---|
| Production | 1 server second per real second |
| Local development | 20 server seconds per real second |

The clock drives resource accrual, recruitment, world days, seasons, weather, and temperature together. Recruitment takes the same full week as basic collection or exploration.

A work week is seven world days, or **168 server minutes**: 2h48m in production and 8m24s in development. A development day takes 1m12s. It is not seven real-world days or a season. Crews, expeditions and pending recruitment persist with game-clock deadlines across restarts and speed changes, including migration from the previous 10x development clock.

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

The **Featheral Dollar · FTH$ circulation** counter includes player balances, buy escrow, marketplace reserves, the Gold pool and bank treasury (available and reserved), including inactive accounts, at four-decimal precision. Locked staking principal stays in FTHG supply. No founding, resident, building or exploration grants increase supply. Gameplay fees burn FTH$; trades, donations and staking payouts transfer existing balances. Historical deleted balances cannot be reconstructed. These are simulated statistics, not USD or on-chain supply.

These are near-live snapshots, refreshed every 30-35 real seconds while the page is visible, with up to 15 seconds of shared-cache reuse. An arrival count-up reaches the real totals over 2.2 seconds; later increases or decreases animate over 1.4 seconds. The animation interpolates only toward actual reported totals, never predicts growth or continues beyond its target. Hidden tabs or failed updates settle at the last known target. Failed updates explicitly mark last-known totals; a first-load failure does not display invented zeros. Reduced-motion users and screen readers receive actual snapshot totals without stepping through animated intermediate values.

Settlement and metal totals initialize from worlds still persisted when the feature is first enabled. Previously purged worlds cannot be reconstructed. The older population census is retained as-is, so it may include residents from worlds purged before that initialization.

The current vote is a simulation record inside a player's world. Token-weighted governance, delegation, identity systems, sybil resistance, quorum rules, treasury execution, and real public decision-making are **not implemented**.

## 6. Featheral Gold: in-game utility, not an on-chain deployment

| Item | Current status |
|---|---|
| Name | Featheral Gold |
| Ticker | FTHG |
| Intended network | Ethereum |
| Contract deployment | None |
| Live token supply | No token has been issued by this prototype |
| Token sale or presale | None |
| Airdrop or token claims | None |
| Wallet connection | None |
| Gold exchange | Two-way FTH$/Gold reserve exchange at a dynamic rate |
| Investment return or governance right | None promised |

### Placeholder contract address

```text
0x0000000000000000000000000000000000000000
```

**This is the zero address. It is a display placeholder, not a deployed FTHG contract, funding address, sale address, or wallet you should pay. Do not send ETH or tokens to it. This project includes no Solidity implementation or deployment through this placeholder.**

FTHG is usable now only as an off-chain game currency. Any future on-chain token remains a separate research topic: no on-chain supply cap, allocation, vesting schedule, launch date, redemption program or right to future issuance is finalized. In-game FTHG is not a claim on any future token.

Any future token proposal would require separate technical specifications, public disclosures, legal analysis, independent contract review, operational controls, and a deliberate decision about whether a token is appropriate at all. No such outcome is guaranteed by this paper.

This paper is not an offer to sell, solicitation to buy, financial advice, or a promise of profit. Access to the simulator does not create investment, ownership, revenue-sharing, redemption, voting, or other legal rights.

Never share private keys or seed phrases. Do not approve wallet transactions based on this prototype, a placeholder address, or an unverified social account.

## 7. Architecture and trust

The current implementation uses:

1. A TypeScript/Vite browser client.
2. A Node HTTP mock API.
3. A replaceable Store boundary.
4. SQLite for sessions, authoritative account state, action receipts, clock anchors, and population aggregates.

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

The cookie grants access to one server-owned world for seven real days. Losing or expiring it loses access; recovery is not available. Keep the same browser and hostname to return. Exports are informational and cannot restore authoritative balances.

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
