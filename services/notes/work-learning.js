"use strict";
const question = (prompt, options, answer) => ({ prompt, options, answer });
const courses = [
  {
    id: "ecosystem", level: "orientation", title: "The ecosystem and your visitor journey",
    body: "Foundation coordinates the ecosystem. App is open to anyone: register as a visitor, share your experience and interests, and pass all orientation quizzes to become a member. Membership opens level-appropriate internal work, not administrator credentials. Admin manages protected operations across sites. Learning advances your access level; management roles remain assigned responsibilities.",
    sites: ["foundation", "app", "admin"],
    questions: [
      question("Who can register in App?", ["Anyone with a wallet", "Only approved administrators", "Only directors"], 0),
      question("What grants initial membership?", ["Requesting administrator credentials", "Passing every orientation quiz at 80% or more", "Buying a token"], 1),
      question("Does membership grant protected Admin access?", ["Yes, automatically", "Only after a profile photo", "No, Admin authorization stays separate"], 2),
      question("What is a visitor allowed to access?", ["Private team files", "Onboarding and learning", "All internal agendas"], 1),
      question("Who coordinates protected cross-site operations?", ["Any visitor", "A public chat room", "Authorized administrators"], 2),
    ],
  },
  {
    id: "currencies", level: "orientation", title: "Gold, Dollar, Silver and Exchange",
    body: "Gold owns Ethereum FTHG and native ETH reads; Ethereum writes require network checks and gas. Dollar represents FTH$ ledger operations. Silver uses whole-unit FTHS for contribution rewards and its digital marketplace. Exchange prices come from funded pools, not guaranteed fixed rates. Wallet estimates are not spendable balances or promises of redemption. Pay requests need exact recipient, asset and amount review.",
    sites: ["gold", "dollar", "silver", "ex", "pay", "wallet", "ledger"],
    questions: [
      question("Which operation normally needs ETH gas?", ["An Ethereum transaction", "Reading an agenda", "Taking a quiz"], 0),
      question("FTHS amounts use what units?", ["Fractional cents only", "Whole units", "Silver kilograms"], 1),
      question("What determines an executable Exchange quote?", ["A guaranteed salary rate", "A profile avatar", "Funded pools and current prices"], 2),
      question("Is an estimated portfolio total spendable cash?", ["Always", "No; check actual available balances", "Only on mobile"], 1),
      question("What must you review before approving payment?", ["Recipient, asset, network and exact amount", "Only the logo", "Only the task title"], 0),
    ],
  },
  {
    id: "content-world", level: "orientation", title: "World, Media, Notes and hosted sites",
    body: "World contains gameplay and public profiles shared across the ecosystem. World gameplay funds can remain separate from wallet funds. Media presents published content. Notes defines community-note currencies and site creation flows; Sites lists hosted sites. Public profiles are public; team documents and private files require live membership and channel access. Publication needs rights checks, moderation and a verified destination.",
    sites: ["world", "media", "notes", "sites", "x"],
    questions: [
      question("Are World gameplay funds always extra spendable wallet funds?", ["Yes", "No; balances can be separate or overlap", "Only after login"], 1),
      question("Where is the shared public profile managed?", ["World profile", "A payroll spreadsheet", "A private file"], 0),
      question("What protects a private team attachment?", ["Its filename", "A public profile", "Live membership and channel authorization"], 2),
      question("What should be checked before publishing?", ["Rights, moderation and destination", "Only image size", "Only salary level"], 0),
      question("What does Notes support?", ["Unlimited free admin access", "Community notes and site creation flows", "A guaranteed USD peg"], 1),
    ],
  },
  {
    id: "operations-safety", level: "orientation", title: "Infrastructure, data and safe administration",
    body: "Database stores service data; Ledger and Stats expose activity and circulation views. Hosted content and deployment use managed operations. Do not expose keys, passwords, private files or session tokens. A wallet signature is not consent to arbitrary transactions. Verify changes with tests and evidence, use least privilege, and escalate incidents through the responsible division. Research must distinguish verified results from estimates.",
    sites: ["db", "ledger", "stats", "sites", "admin"],
    questions: [
      question("What must never go into public task evidence?", ["Public test results", "Passwords, private keys or session tokens", "A public issue link"], 1),
      question("What is least privilege?", ["Giving every member all credentials", "Skipping review", "Only the access needed for the responsibility"], 2),
      question("What makes work ready for review?", ["Evidence against acceptance criteria", "Changing your role label", "A promise without a result"], 0),
      question("How should incidents be handled?", ["Hidden until payroll", "Escalated to the responsible division", "Published with secrets"], 1),
      question("What should research distinguish?", ["Verified results from estimates", "Avatars from names only", "Salary from attendance only"], 0),
    ],
  },
  {
    id: "weekly-work", level: "orientation", title: "Tasks, weekly rewards and membership",
    body: "Work is assigned in weekly UTC cycles starting Monday. Only manager-approved completion counts, not a self-reported review status. More than 60% completion earns the configured base plus completed-task incentives. Exactly 60% or less earns completed-task incentives only, no base, and returns you to visitor access. With no assigned tasks, membership remains and no salary is recorded. Amounts must be configured in FTHS before a new cycle starts. Requalification requires fresh quizzes; balances already earned remain yours.",
    sites: ["app", "silver"],
    questions: [
      question("What counts as accomplished work?", ["Any task marked in progress", "Only manager-approved completion", "Opening the task"], 1),
      question("At exactly 60%, is base salary earned?", ["Yes", "Only if you ask", "No; the rule is strictly above 60%"], 2),
      question("What happens at 60% or below?", ["Incentives for completed work only, and return to visitor", "Full base with no consequences", "Existing wallet funds disappear"], 0),
      question("What happens with zero assigned tasks?", ["Membership is lost", "Membership stays; no salary record", "Automatic base salary"], 1),
      question("How do demoted visitors regain membership?", ["Changing a browser flag", "Buying FTHS", "Completing fresh required quizzes"], 2),
    ],
  },
  {
    id: "delivery", level: "learning", title: "Reliable delivery and review",
    body: "Practitioners turn briefs into measurable acceptance criteria. Keep task evidence concise, avoid secret data, and record tests and verified results. Submit for review rather than approving your own work. Shared documents use revisions to prevent overwriting teammates. Report blockers before the weekly deadline; a manager can cancel a withdrawn assignment, but missed work is not silently removed.",
    sites: ["app", "admin"],
    questions: [
      question("What should a brief contain?", ["Measurable acceptance criteria", "Only a vague idea", "Private keys"], 0),
      question("Who approves an assignee's completion?", ["The assignee alone", "A responsible manager", "A browser extension"], 1),
      question("Why check shared-document revisions?", ["To increase salary", "To hide edits", "To protect concurrent changes"], 2),
      question("When should blockers be reported?", ["Before the deadline", "Never", "After losing access only"], 0),
      question("Should missed work vanish from evaluation?", ["Yes", "No", "Only for directors"], 1),
    ],
  },
  {
    id: "mentoring", level: "practitioner", title: "Mentoring and cross-site handovers",
    body: "Mentors explain acceptance criteria, support learners and preserve privacy. Handover records include ownership, destination, evidence and unresolved risks. Member organization charts show responsibilities and vacancies, not private application answers. Level access never bypasses team authorization or grants credentials. Reward records are auditable and retries must never issue twice.",
    sites: ["app", "foundation"],
    questions: [
      question("What is a useful handover?", ["Only a greeting", "Ownership, evidence and remaining risks", "A password dump"], 1),
      question("What belongs in the member org chart?", ["Responsibilities and vacancies", "Private application answers", "Session cookies"], 0),
      question("Can a learning level bypass team authorization?", ["Yes", "Only mentors", "No"], 2),
      question("How should duplicate reward retries behave?", ["Issue again", "Return the original result", "Delete the record"], 1),
      question("How should mentors support learners?", ["Explain criteria and preserve privacy", "Share admin keys", "Approve everything without evidence"], 0),
    ],
  },
  {
    id: "stewardship", level: "mentor", title: "Stewardship and accountable ecosystem management",
    body: "Stewards coordinate divisions with scoped access, risk review and accountable delivery. Foundation governance, people and learning, product operations, infrastructure, finance and community need clear ownership. Administrators retain protected cross-site visibility. Salary is an internal FTHS reward record, not a USD peg or employment contract; supply and liquidity remain separate. Preserve audit history and never retroactively change a closed evaluation.",
    sites: ["foundation", "admin", "app", "stats"],
    questions: [
      question("How should closed evaluations be treated?", ["Rewritten to improve metrics", "Deleted monthly", "Preserved with their audit history"], 2),
      question("Does FTHS salary imply a USD peg or employment contract?", ["No", "Yes", "Only for stewards"], 0),
      question("Who retains protected all-site administration?", ["Every visitor", "Authorized administrators", "Any quiz participant"], 1),
      question("What makes division management lean?", ["Clear ownership and scoped responsibilities", "Duplicated credentials", "No handovers"], 0),
      question("Are issued supply and funded liquidity the same?", ["Yes", "Only on weekends", "No; they are separate"], 2),
    ],
  },
];
const experience = [
  { id: "new", icon: "seed", label: "New to ecosystem work" },
  { id: "building", icon: "tools", label: "Building products" },
  { id: "operations", icon: "settings", label: "Operating services" },
  { id: "leadership", icon: "people", label: "Leading teams" },
];
const interests = [
  { id: "engineering", icon: "code", label: "Engineering" },
  { id: "operations", icon: "settings", label: "Operations & governance" },
  { id: "community", icon: "people", label: "Community & support" },
  { id: "research", icon: "search", label: "Research & finance" },
  { id: "learning", icon: "book", label: "People & learning" },
];
module.exports = { courses, experience, interests };
