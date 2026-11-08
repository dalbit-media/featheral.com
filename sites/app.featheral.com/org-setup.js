"use strict";
// Planning examples only: these personas are not members, wallets or permission assignments.
window.FeatheralOrgSetup = Object.freeze({
  principles: [
    "Member mandate -> elected stewardship -> accountable division owners -> small delivery teams.",
    "One accountable owner and a different reviewer per mission; permissions remain explicitly assigned.",
    "Start with shared specialists across teams. Split a team only when sustained work requires it.",
    "Publish public-safe milestones; keep personnel records, keys and incident evidence in authorized channels.",
  ],
  coordination: {
    name: "Demo Atlas", role: "Foundation coordination / proposed director",
    experience: "Illustrative 10+ years in product delivery and governance",
    skills: "Portfolio planning, facilitation, risk prioritization",
    focus: "Connect viable standalone businesses; resolve cross-division dependencies; report to member governance.",
  },
  divisions: [
    { id: "operations", name: "Governance & operations", persona: "Demo Cedar", experience: "Illustrative 8 years in operational leadership",
      skills: "Governance design, delivery operations, incident coordination",
      focus: "Accountable decisions, policies, safe administration and ecosystem execution",
      teams: [
        ["foundation", "Foundation governance", "Demo Civic", "6 years in program operations", "Proposal analysis, facilitation, reporting", "Member mandates, roadmap dependencies and transparent decision records"],
        ["admin", "Administration", "Demo Harbor", "7 years in service operations", "Access reviews, release management, incident response", "Protected operations, deployment evidence and least-privilege reviews"],
      ] },
    { id: "engineering", name: "Product & infrastructure", persona: "Demo Forge", experience: "Illustrative 9 years in platform engineering",
      skills: "Architecture, reliability, accessible UX, engineering mentorship",
      focus: "Shared identity and reliable infrastructure supporting independently useful products",
      teams: [
        ["wallet", "Wallet experience", "Demo Key", "6 years in wallet UX", "Signing flows, recovery testing, accessibility", "Approvals, account safety and seamless cross-site identity"],
        ["db", "Data & infrastructure", "Demo Vault", "7 years in data reliability", "Database operations, backups, restore drills", "Integrity, disaster recovery and performant data access"],
        ["ledger", "Ledger reliability", "Demo Trace", "7 years in distributed services", "Accounting invariants, auditability, observability", "Conservation, replay safety and reliable ledger readers"],
        ["pay", "Payment experience", "Demo Relay", "5 years in payment products", "Exact amounts, recipient validation, integration testing", "Trustworthy requests and merchant payment journeys"],
        ["world", "World product", "Demo Terra", "6 years in simulation products", "Game economy, interaction design, performance", "World-building, shared profiles, settlement UX and economic balance"],
      ] },
    { id: "research", name: "Finance & intelligence", persona: "Demo Prism", experience: "Illustrative 8 years in financial systems research",
      skills: "Treasury reporting, market analysis, evidence-based risk review",
      focus: "Finite reserve safety, revenue evidence and transparent contribution economics",
      teams: [
        ["gold", "Gold & Ethereum", "Demo Aurum", "7 years in network research", "Ethereum operations, valuation sources, reserve review", "Verified reserve backing, network safety and risk reports"],
        ["dollar", "Dollar operations", "Demo Delta", "6 years in financial software", "Reconciliation, ledger analysis, settlement testing", "FTH$ conservation and cross-site settlement evidence"],
        ["silver", "Silver marketplace", "Demo Argent", "5 years in marketplace operations", "Reward transparency, digital fulfillment, inventory controls", "FTHS terms, sourced listings and reviewed contribution records"],
        ["ex", "Exchange research", "Demo Market", "6 years in market infrastructure", "Liquidity analysis, execution quality, fee testing", "Funded pools, honest quotes and standalone exchange economics"],
        ["stats", "Ecosystem intelligence", "Demo Signal", "5 years in analytics", "Data provenance, dashboards, experimentation", "Separate verified circulation from estimates and measure business synergy"],
      ] },
    { id: "community", name: "Community & publishing", persona: "Demo Bloom", experience: "Illustrative 7 years in creator communities",
      skills: "Moderation, communications, partnerships, creator support",
      focus: "Responsible distribution and growth for Media, Notes and hosted businesses",
      teams: [
        ["media", "Media & moderation", "Demo Story", "5 years in publishing", "Editorial review, moderation, rights checks", "Safe posting, reader experience and community growth"],
        ["notes", "Notes & creators", "Demo Ink", "4 years in creator tools", "Creator onboarding, product education, support", "Useful community notes and sustainable creator workflows"],
        ["sites", "Hosted sites", "Demo Canvas", "5 years in web delivery", "SEO, accessibility, publication QA", "Independent site quality, deployment handovers and conversion"],
        ["x", "Legacy community", "Demo Bridge", "4 years in community support", "Migration support, redirect testing, documentation", "Reliable transition to current Media and World experiences"],
      ] },
    { id: "learning", name: "People & learning", persona: "Demo Sage", experience: "Illustrative 8 years in contributor development",
      skills: "Curriculum design, mentorship, fair review, competency mapping",
      focus: "A clear path from visitor to steward without automatic management authority",
      teams: [
        ["app", "People & contribution", "Demo Compass", "6 years in contributor programs", "Mission briefs, review operations, progression", "Mobile organization workspace, assignment quality and transparent weekly evaluation"],
        ["learning", "Learning & quality", "Demo Lantern", "5 years in technical education", "Assessment design, accessibility, coaching", "Stepwise quizzes, mentoring, onboarding and reusable quality standards"],
      ] },
  ],
  levels: [
    ["orientation", "Visitor", "Learn shared identity, safety and the ecosystem; orientation unlocks membership."],
    ["learning", "Guided contributor", "Take scoped missions with a mentor; attach evidence and request independent review."],
    ["practitioner", "Independent contributor", "Own bounded delivery and propose improvements within granted access."],
    ["mentor", "Mentor", "Coach others and improve acceptance criteria; reviewer authority still requires an assigned role."],
    ["steward", "Steward", "Coordinate long-term quality and governance proposals; no automatic Admin access."],
  ],
  cadence: "Weekly: brief -> assign -> deliver -> independent review -> contribution evaluation. Monthly: division outcomes and risk review. Quarterly: member priorities, resource allocation and standalone business viability.",
});
