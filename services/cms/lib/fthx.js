const pages = [
  {
    title: 'FTHX - Media freedom, rewarded',
    slug: 'fthx',
    excerpt: 'The privacy-ledger vision for Featheral X: share media, reward creators, and build a freer internet under Featheral governance.',
    body: `FTHX is the privacy ledger token envisioned for the Featheral X Media Archiving and Streaming Platform. Share discoveries, support creators, and help build a freer internet.

Share what matters
Add supported online media links, YouTube videos, images, and GIFs. Archive permitted images locally and stream YouTube through embedded playback. Keep source attribution and share only content you have the right to publish.

Earn through community support
Creators earn FTHX from eligible wallet likes and tips. Today, posting costs 1 FTHX and a first qualifying like transfers 1 FTHX from the voter to the creator. A future popularity-based reward program would recognize posts that earn enough genuine likes; its threshold and funding are not yet defined.

Freedom of speech, for the greater internet
Our mission is an open, censorship-resistant media network under Featheral governance. Protect lawful expression and diverse viewpoints while respecting consent, privacy, copyright, and applicable law. Freedom of expression is not a license for abuse or illegal content.

Privacy by design is the goal
FTHX's privacy-ledger network is a proposal, not a deployed private blockchain. The current platform uses a local site ledger and Ethereum wallet signatures. Wallet addresses and activity are stored by the operator, and author addresses are visible on posts.

Built with Featheral governance
The proposed governance model calls for transparent rules, community proposals, creator participation, and an appeal process. Voting, treasury controls, and decentralized governance are roadmap items, not active token-holder rights.

Start contributing
Explore the media platform, connect a wallet, and publish a supported media post. Read the FTHX whitepaper for current mechanics, safeguards, and the roadmap. FTHX currently has no promised monetary value, exchange listing, or investment return.`,
  },
  {
    title: 'FTHX Whitepaper',
    slug: 'fthx-whitepaper',
    excerpt: 'Project whitepaper v0.1: current ledger mechanics and the proposed privacy, creator-reward, and Featheral governance roadmap.',
    body: `FTHX Whitepaper v0.1 - Project proposal
FTHX is the privacy ledger token envisioned for Featheral X Media Archiving and Streaming Platform. This document separates the working local platform from the proposed network. It is not an investment offer or a claim that a private or decentralized ledger is live.

1. Mission
Build a freedom-of-speech, censorship-resistant media network for the good of the greater internet under Featheral governance. Support lawful expression, durable access to permitted media, and community recognition of useful contributions. Protect consent, privacy, and creator rights.

2. Platform and media lifecycle
Users connect an Ethereum-compatible wallet and submit supported online links, YouTube videos, images, or GIFs. Supported images are stored in the site's uploads folder; YouTube videos use remote embedded playback and are not downloaded or guaranteed to remain available. Not every source or media format is supported. Users must have the necessary rights and must not bypass access restrictions. Existing size, format, duplicate, and network-fetch checks continue to apply.

3. Current token implementation
FTHX is presently a whole-number balance in each site's local SQLite ledger. It is not an on-chain asset, a confidential payment system, or a cross-site transferable currency. Wallet signatures authenticate sign-in and top-up requests without a blockchain transaction or gas fee. A top-up creates local credits, not a purchase, deposit of cryptocurrency, or reserve-backed claim.

4. Posting, likes, and tips
Posting costs 1 FTHX. The first eligible like by another connected wallet transfers 1 FTHX from that voter's balance to the post's author. Self-likes, guest likes, and likes from wallets without sufficient balance do not pay. A wallet pays only once per post, and undo does not refund the reward. Tips transfer existing local credits. Likes do not mint tokens automatically.

5. Proposed popularity rewards
The intended network would reward media contributions that receive enough genuine community likes. A minimum qualifying-like threshold, reward budget, accounting period, eligibility rules, and funding source must be approved before implementation. No threshold or additional payout is promised today. Multiple wallet addresses do not prove distinct people; identity farming, collusion, and vote manipulation require stronger defenses before valuable rewards can launch.

6. Privacy-ledger design goals
The proposed ledger should minimize unnecessary personal data and explore confidential balances, selective disclosure, and independently audited cryptography. No privacy protocol, chain, or smart contract has been selected or deployed. Today the operator can inspect wallet addresses, balances, comments, and activity; post authors are publicly identified by wallet address. The platform records analytics, and external embeds may disclose network metadata to their providers. Wallet sign-in is not anonymity.

7. Featheral governance proposal
Featheral governance is envisioned as a transparent process for policy proposals, reward parameters, treasury accountability, and appeals. Decision rights, voting eligibility, quorum, conflicts of interest, and emergency powers remain to be specified. The current operator controls the server and policies. Holding local FTHX credits does not currently confer voting power, ownership, or revenue rights.

8. Expression, safety, and rights
Censorship resistance is a network goal, not a guarantee of unrestricted hosting. Adopt published rules and an appeal process that protect lawful speech while addressing illegal material, exploitation, threats, non-consensual content, privacy violations, and copyright claims. Existing age restrictions and moderation controls remain in place. The current swipe workflow can remove posts; this is not an immutable archive.

9. Storage and network architecture
Each managed site has separate imported-data, CMS, and public-state databases plus its own media folder. Local balances, votes, and content are site-specific. Federation, peer replication, encrypted storage, and decentralized availability are future work. A local archive depends on operator backups, hosting availability, and source rights; embedded content also depends on its external provider.

10. Supply and economic limitations
Current top-ups allow local credits without an economic scarcity guarantee. A production token would need an explicit supply policy, issuance limits, distribution, treasury controls, and an audited settlement model before launch. No fixed supply, market price, redemption, exchange listing, yield, or financial return is promised. Local credits should not be represented as a financial asset.

11. Roadmap and launch gates
Current stage: CMS-managed content, separate sites, supported media submissions, wallet authentication, and local like-and-tip accounting. Next: publish governance rules and consult the community on reward eligibility and funding. Later: prototype privacy technology and federation, evaluate abuse resistance, and obtain independent technical and legal review. Network rewards and governance should launch only after these requirements are met; no delivery date is committed.

12. Risks and document updates
Risks include operator trust, data loss, security flaws, manipulated votes, external media removal, metadata exposure, and legal constraints. Back up site databases and media, review operational controls, and do not rely on local credits for savings or income. This whitepaper and the landing page are editable in Featheral CMS; future revisions should clearly state changes to live behavior and proposed features.`,
  },
];

function install(cms) {
  const key = 'fthx-pages-v1';
  if (cms.store.get('settings', key)) return;
  cms.store.transaction(() => {
    for (const page of pages) {
      if (!cms.store.get('slugs', page.slug)) {
        cms.save({ ...page, type: 'page', status: 'publish' });
      }
    }
    cms.store.put('settings', key, { value: 'installed' });
  });
}

function installNotes(cms) {
  install(cms);
  const mechanics = 'FTHX is a global whole-number credit managed by Featheral Notes, not a backed token or Ethereum asset. Existing per-site balances are summed per wallet with a migration audit trail. Posting still costs 1 FTHX; tips spend existing global credits. The first authenticated like or comment by another wallet on a member post has an administrator-configurable chance to issue a creator reward (default 10%, 1 FTHX). Guests and self-reactions do not qualify. Losing attempts and successful rewards are recorded so retries, undo and additional comments cannot reroll the same wallet/content pair. Wallets are not proof of unique people; these credits have no promised monetary value. FTH$ rewards remain disabled until an authorized existing budget is implemented and funded.';
  const nativeMechanics = 'FTHX (Featheral Exchange Token) and FTH$ (Featheral Dollar) are system-native notes. Neither can be earned through regular likes, comments or community reward programs. FTHX uses a global whole-number ledger managed by Featheral Notes; FTH$ retains its reserve-backed Dollar ledger. Neither is an Ethereum token. Existing balances and audited reward history are preserved. Posting costs 1 FTHX; tips transfer existing FTHX. Creators may earn community-created notes through an enabled reward program. The first authenticated like or comment by another wallet records one draw; self-reactions, guests and repeat attempts cannot earn or reroll. Live native circulation totals are displayed on Featheral Notes.';
  for (const seed of pages) {
    const current = cms.list().find(page => page.slug === seed.slug);
    if (!current) continue;
    const previousBody = seed.body
      .replace(/Creators earn FTHX from eligible wallet likes and tips\.[^\n]+/, mechanics)
      .replace(/FTHX is presently a whole-number balance[^\n]+/, mechanics)
      .replace(/Posting costs 1 FTHX\. The first eligible like[^\n]+/, mechanics)
      .replace(/The intended network would reward media contributions[^\n]+/, 'Reaction rewards are implemented in Featheral Notes. Valuable or reserve-backed rewards require stronger abuse prevention and authorized funding before activation.')
      .replace('Local balances, votes, and content are site-specific.', 'FTHX balances are global in Notes; votes and content remain site-specific.')
      .replace('local like-and-tip accounting', 'global credit and randomized reaction-reward accounting');
    if (current.body !== seed.body && current.body !== previousBody) continue;
    const body = previousBody.split(mechanics).join(nativeMechanics)
      .replace('Reaction rewards are implemented in Featheral Notes. Valuable or reserve-backed rewards require stronger abuse prevention and authorized funding before activation.', 'Community-note rewards are implemented in Featheral Notes. System-native FTH$ and FTHX are never regular reward currencies.')
      .replace('global credit and randomized reaction-reward accounting', 'global native-note accounting and community-note rewards');
    cms.save({ ...current, body }, current.id);
  }
}
module.exports = { install, installNotes };
