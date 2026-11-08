export type PublicCopy = readonly [en: string, ko: string];
export interface PublicFeature {
  path: string;
  label: PublicCopy;
  title: PublicCopy;
  description: PublicCopy;
  headline: PublicCopy;
  lead: PublicCopy;
  action: PublicCopy;
  gamePath: string;
  visual: 'exploration' | 'settlements' | 'marketplace' | 'federations' | 'guide' | 'roadmap';
  steps: readonly PublicCopy[];
  cards: readonly { title: PublicCopy; body: PublicCopy }[];
  note: PublicCopy;
}

export const worldPublicOrigin = 'https://world.featheral.com';
export const publicFeaturePages: readonly PublicFeature[] = [
  {
    path: '/features/exploration/', label: ['Exploration', '탐험'], visual: 'exploration',
    title: ['Exploration · Featheral World', '탐험 · Featheral World'],
    description: ['Explore 21 procedural terrain types in Featheral World. Discover resource sites, send expeditions and revisit known land in the browser.',
      'Featheral World의 21가지 절차 생성 지형을 탐험하세요. 자원지를 발견하고 탐험대를 보내며 브라우저에서 발견한 지역을 다시 방문하세요.'],
    headline: ['A little further. A new possibility.', '조금 더 멀리, 새로운 가능성.'],
    lead: ['Read the terrain, discover supplies and choose where your settlement begins. Exploration is a playable part of the current World prototype.',
      '지형을 살피고 자원을 발견하며 정착지를 시작할 곳을 고르세요. 탐험은 현재 World 프로토타입에서 플레이할 수 있습니다.'],
    action: ['Open exploration', '탐험 열기'], gamePath: '/explore/',
    steps: [['Discover', '발견'], ['Gather', '채집'], ['Return', '귀환']],
    cards: [
      { title: ['21 terrain types', '21가지 지형'], body: ['Procedural forests, rivers, deserts and mountains give the map its character. Different terrain reveals different resource sites.', '절차 생성 숲, 강, 사막, 산이 지도의 개성을 만듭니다. 지형마다 서로 다른 자원지를 발견할 수 있습니다.'] },
      { title: ['Send an expedition', '탐험대 보내기'], body: ['An expedition needs two available residents. Review its departure cost and game-time deadline before sending it into unknown land.', '탐험에는 대기 중인 주민 두 명이 필요합니다. 미탐험 지역으로 출발하기 전에 출발 비용과 게임 시간 기준 완료 시각을 확인하세요.'] },
      { title: ['Revisit known land', '발견한 지역 다시 방문'], body: ['Travel to discovered tiles without an expedition delay. Completed crew output can be collected from eligible resource tiles without a transport charge.', '발견한 타일은 탐험 대기 없이 이동할 수 있습니다. 조건에 맞는 자원 타일에서 완료된 채집량을 운송비 없이 받을 수 있습니다.'] },
    ],
    note: ['This is a procedural, server-backed simulation, not a shared real-time multiplayer map. The preview uses the game renderer and a fixed sample seed, not your saved world.',
      '절차 생성 지형을 사용하는 서버 기반 시뮬레이션이며 실시간 멀티플레이 지도는 아닙니다. 미리보기는 게임 렌더러와 고정 예시 시드를 사용하며 저장된 내 월드가 아닙니다.'],
  },
  {
    path: '/features/settlements/', label: ['Settlements', '정착지'], visual: 'settlements',
    title: ['Settlements · Featheral World', '정착지 · Featheral World'],
    description: ['Build and arrange a settlement in Featheral World. Manage residents, weekly resource crews, storage and buildings as your settlement grows toward a capital.',
      'Featheral World에서 정착지를 건설하고 배치하세요. 주민, 주간 채집팀, 창고와 건물을 관리하며 수도까지 성장시켜 보세요.'],
    headline: ['Small beginnings. A place of your own.', '작은 시작, 나만의 터전.'],
    lead: ['Choose dry land, establish your first settlement and welcome twelve residents. Growth comes from balancing people, supplies and the next upgrade.',
      '육지를 골라 첫 정착지를 세우고 주민 열두 명을 맞이하세요. 주민, 자원, 다음 업그레이드의 균형을 맞추며 성장하세요.'],
    action: ['Open settlement', '정착지 열기'], gamePath: '/settlement/',
    steps: [['Establish', '정착'], ['Build', '건설'], ['Grow', '성장']],
    cards: [
      { title: ['People with a purpose', '역할이 있는 주민'], body: ['Track gathering, exploring and available residents separately. Crew changes apply to the next work week, not an already running job.', '채집 중, 탐험 중, 대기 중인 주민을 구분해 확인하세요. 채집팀 변경은 진행 중인 작업이 아니라 다음 작업 주부터 적용됩니다.'] },
      { title: ['Build and arrange', '건설과 배치'], body: ['Upgrade storage and production buildings, craft items and arrange buildings and owned decorations on the isometric settlement map.', '창고와 생산 건물을 업그레이드하고 아이템을 제작하세요. 등각 정착지 지도에 건물과 보유 장식을 배치할 수 있습니다.'] },
      { title: ['Plan the next tier', '다음 단계 계획'], body: ['Each settlement tier has population and material requirements. Keep an eye on water, heating and repair demand as your settlement grows.', '정착지 단계마다 인구와 자원 조건이 있습니다. 성장하면서 물, 난방, 수리 수요를 함께 확인하세요.'] },
    ],
    note: ['The scene is a sample layout drawn with the actual game artwork, not a screenshot or a saved settlement. Gameplay costs and storage limits still apply.',
      '실제 게임 그림 코드로 그린 예시 배치이며 스크린샷이나 저장된 정착지가 아닙니다. 게임 내 비용과 저장 한도가 적용됩니다.'],
  },
  {
    path: '/features/marketplace/', label: ['Marketplace', '거래소'], visual: 'marketplace',
    title: ['Marketplace · Featheral World', '거래소 · Featheral World'],
    description: ['Discover the Featheral World marketplace for resources, equipment and decorations. Compare available quotes, manage orders and understand FTH$ spending.',
      'Featheral World 거래소에서 자원, 장비, 장식을 살펴보세요. 이용 가능한 호가를 비교하고 주문을 관리하며 FTH$ 사용 방식을 알아보세요.'],
    headline: ['Useful supplies. Considered trades.', '필요한 자원, 신중한 거래.'],
    lead: ['The in-game exchange connects your settlement inventory to resource and item trading. Browse first, then check the quote, quantity and available funds.',
      '게임 거래소는 정착지 인벤토리와 자원·아이템 거래를 연결합니다. 상품을 둘러본 다음 호가, 수량, 사용 가능한 자금을 확인하세요.'],
    action: ['Open marketplace', '거래소 열기'], gamePath: '/market/',
    steps: [['Browse', '둘러보기'], ['Review', '확인'], ['Trade', '거래']],
    cards: [
      { title: ['A compact catalog', '간결한 상품 목록'], body: ['Search and filter resources, equipment, automation items and decorations. Grid and table views show owned quantities and available buy or sell quotes.', '자원, 장비, 자동화 아이템, 장식을 검색하고 필터링하세요. 카드와 표 보기에서 보유량과 이용 가능한 매수·매도 호가를 확인할 수 있습니다.'] },
      { title: ['Orders and history', '주문과 내역'], body: ['The exchange supports market and limit orders, an order book and trade history. An absent quote or unfilled order is not a guaranteed trade.', '시장가·지정가 주문, 호가와 체결 내역을 제공합니다. 호가가 없거나 주문이 미체결 상태라면 거래가 보장되지 않습니다.'] },
      { title: ['Know what you spend', '사용하는 자금 이해'], body: ['FTH$ uses the authorized Dollar wallet ledger. Accounts and market pools start empty; selling requires owned assets and buying requires available funds.', 'FTH$는 승인된 Dollar 지갑 원장을 사용합니다. 계정과 시장 풀은 잔액 없이 시작하며 매도에는 보유 자산, 매수에는 사용 가능한 자금이 필요합니다.'] },
    ],
    note: ['FTH$ is not USD or an on-chain token. Game resources are not FTHG. No price, liquidity, investment return or cash withdrawal is promised.',
      'FTH$는 미국 달러나 온체인 토큰이 아닙니다. 게임 자원은 FTHG가 아닙니다. 가격, 유동성, 투자 수익이나 현금 출금을 보장하지 않습니다.'],
  },
  {
    path: '/features/federations/', label: ['Federations', '연방'], visual: 'federations',
    title: ['Federations · Featheral World', '연방 · Featheral World'],
    description: ['Learn about federation membership, relations, simulated assembly voting and the common resources vault in Featheral World.',
      'Featheral World의 연방 가입, 관계, 가상 의회 투표와 공동 자원 창고를 알아보세요.'],
    headline: ['A settlement with a wider horizon.', '정착지 너머로 넓어지는 시야.'],
    lead: ['Build relations, join a federation and take part in its simulated civic life. Membership, assembly voting and vault contributions are available in the prototype.',
      '관계를 쌓고 연방에 가입해 가상의 시민 활동에 참여하세요. 프로토타입에서 연방 가입, 의회 투표와 공동 창고 기여를 이용할 수 있습니다.'],
    action: ['Open federations', '연방 열기'], gamePath: '/federation/',
    steps: [['Build relations', '관계 쌓기'], ['Join', '가입'], ['Contribute', '기여']],
    cards: [
      { title: ['Earn membership', '연방 가입 준비'], body: ['Reach Village and build relations to 50 to join. Founding a federation requires City, more than 10,000 residents and the displayed material cost.', '마을 단계와 관계 50에 도달하면 가입할 수 있습니다. 연방 창설에는 도시 단계, 10,000명을 넘는 주민과 표시된 자원이 필요합니다.'] },
      { title: ['A simulated assembly', '가상 의회'], body: ['Members at Town with a town hall can record a vote on the watershed proposal. This is an in-game simulation, not deployed DAO governance.', '소도시 단계에서 마을 회관을 갖춘 연방 회원은 수계 복원 제안에 투표할 수 있습니다. 게임 내 시뮬레이션이며 배포된 DAO 거버넌스가 아닙니다.'] },
      { title: ['The common vault', '공동 자원 창고'], body: ['Contribute owned resources or existing FTH$ and inspect all-time and annual contribution shares. Contributions are permanent; withdrawals and payouts are not available.', '보유 자원이나 기존 FTH$를 기여하고 누적·연간 기여 비율을 확인하세요. 기여는 영구적이며 출금과 배당은 제공되지 않습니다.'] },
    ],
    note: ['Annual shares are reserved for possible future tax payouts. Tax collection, payout rates and eligibility are pending. Membership offers no real-world governance or financial return.',
      '연간 기여 비율은 향후 세금 배당 가능성을 위해 기록됩니다. 세금 수집, 배당률과 자격 조건은 미정입니다. 가입으로 현실의 거버넌스 권한이나 금전적 수익을 얻지 않습니다.'],
  },
  {
    path: '/guide/', label: ['Guide', '가이드'], visual: 'guide',
    title: ['Getting started guide · Featheral World', '시작 가이드 · Featheral World'],
    description: ['Start Featheral World with an account and public profile. Learn your first exploration, settlement, resource collection and account safety steps.',
      '계정과 공개 프로필로 Featheral World를 시작하세요. 첫 탐험, 정착지, 자원 받기와 계정 안전 수칙을 알아보세요.'],
    headline: ['Your first world, in a few clear steps.', '몇 가지 단계로 시작하는 첫 월드.'],
    lead: ['Play in your desktop or mobile browser. Registration needs no payment or Ethereum transaction; gameplay actions can require resources or FTH$.',
      'PC나 모바일 브라우저에서 플레이하세요. 가입에는 결제나 이더리움 거래가 필요 없지만 게임 행동에는 자원이나 FTH$가 필요할 수 있습니다.'],
    action: ['Register / sign in', '가입 / 로그인'], gamePath: '/#account',
    steps: [['Account', '계정'], ['Profile', '프로필'], ['Explore', '탐험']],
    cards: [
      { title: ['01 · Create your account', '01 · 계정 만들기'], body: ['Register on the homepage with a username and password to create a built-in wallet, or connect an external wallet. Save your password and encrypted wallet backup; there is no password reset.', '홈페이지에서 사용자 이름과 비밀번호로 가입해 내장 지갑을 만들거나 외부 지갑을 연결하세요. 비밀번호와 암호화된 지갑 백업을 보관하세요. 비밀번호 재설정은 없습니다.'] },
      { title: ['02 · Complete your profile', '02 · 프로필 완성'], body: ['Add an avatar, a valid public username and a profile description before entering the game. World and Media use the same public identity.', '게임에 들어가기 전에 아바타, 유효한 공개 사용자 이름과 프로필 설명을 설정하세요. World와 Media는 같은 공개 신원을 사용합니다.'] },
      { title: ['03 · Establish and gather', '03 · 정착하고 채집하기'], body: ['Open exploration and choose dry land for your first settlement. Review the next upgrade, weekly crews and available residents. Check each action’s cost before confirming.', '탐험을 열고 육지를 골라 첫 정착지를 세우세요. 다음 업그레이드, 주간 채집팀과 대기 중인 주민을 확인하세요. 각 행동의 비용을 확인한 뒤 진행하세요.'] },
    ],
    note: ['Progress is linked to the signed-in wallet. Switching accounts restores that wallet’s own settlement without transferring funds. Never share private keys or recovery phrases.',
      '진행 상황은 로그인한 지갑에 연결됩니다. 계정을 전환하면 자금 이동 없이 해당 지갑의 정착지를 복원합니다. 개인 키나 복구 문구를 공유하지 마세요.'],
  },
  {
    path: '/roadmap/', label: ['Roadmap', '로드맵'], visual: 'roadmap',
    title: ['Roadmap and current status · Featheral World', '로드맵과 현재 상태 · Featheral World'],
    description: ['See what is playable in Featheral World today and what remains pending. A transparent roadmap without launch dates, payout promises or investment claims.',
      'Featheral World에서 현재 플레이 가능한 기능과 미정인 기능을 확인하세요. 출시일, 배당이나 투자 수익을 약속하지 않는 투명한 로드맵입니다.'],
    headline: ['Playable now. Honest about what is next.', '지금 플레이 가능, 다음 단계는 솔직하게.'],
    lead: ['Current phase · World building. We are refining the browser simulation, shared profiles and community experience. This guide separates implemented systems from proposals; it is not a delivery schedule.',
      '현재 단계 · 월드 구축. 브라우저 시뮬레이션, 공통 프로필과 커뮤니티 경험을 다듬고 있습니다. 구현된 시스템과 제안을 구분하는 안내이며 출시 일정이 아닙니다.'],
    action: ['Explore the current build', '현재 버전 탐험하기'], gamePath: '/explore/',
    steps: [['Available', '이용 가능'], ['Pending', '미정'], ['Not promised', '보장하지 않음']],
    cards: [
      { title: ['Available · the core loop', '이용 가능 · 핵심 플레이'], body: ['Account and profile setup, procedural exploration, settlement construction, resource crews, item trading, federation membership, simulated voting and vault contributions are implemented.', '계정·프로필 설정, 절차 생성 탐험, 정착지 건설, 자원 채집팀, 아이템 거래, 연방 가입, 가상 투표와 공동 창고 기여가 구현되어 있습니다.'] },
      { title: ['Pending · federation economics', '미정 · 연방 경제'], body: ['Annual contribution shares are recorded, but tax collection, payout rates, eligibility and payouts remain pending. There is no withdrawal from the federation vault.', '연간 기여 비율은 기록하지만 세금 수집, 배당률, 자격 조건과 배당은 미정입니다. 연방 창고 출금은 제공하지 않습니다.'] },
      { title: ['Not promised · a different product', '보장하지 않음 · 다른 서비스'], body: ['Real-time cooperative play, deployed DAO governance, guaranteed liquidity and investment returns are not current World features. No release date is committed here.', '실시간 협동 플레이, 배포된 DAO 거버넌스, 보장된 유동성이나 투자 수익은 현재 World 기능이 아닙니다. 여기에서 출시일을 약속하지 않습니다.'] },
    ],
    note: ['Next direction: polish each site and standalone revenue-generating business, then connect them through business synergy. Web3 governance for future innovators is a proposed direction, not a deployed governance right. Read the whitepaper for context; plans can change and do not override current game rules or fund services.',
      '다음 방향: 각 사이트와 독립적인 수익 사업을 다듬은 뒤 사업 간 시너지로 연결합니다. 미래 혁신가를 위한 Web3 거버넌스는 제안된 방향이며 현재 제공되는 거버넌스 권한이 아닙니다. 설계 배경은 백서를 참고하세요. 계획은 바뀔 수 있으며 현재 게임 규칙이나 자금 서비스를 대체하지 않습니다.'],
  },
];

export const publicWorldLinks = [
  ...publicFeaturePages.map(({ visual, label }) => ({ path: `/#${visual}`, label })),
  { path: '/#community', label: ['Community', '커뮤니티'] as PublicCopy },
  { path: '/account/', label: ['Profile', '프로필'] as PublicCopy },
  { path: '/login/', label: ['Sign in', '로그인'] as PublicCopy },
  { path: '/register/', label: ['Register', '가입'] as PublicCopy },
  { path: '/login/?switch=1', label: ['Switch account', '계정 전환'] as PublicCopy },
  { path: '/explore/', label: ['Play', '플레이'] as PublicCopy },
];

export function publicFeatureAt(path: string): PublicFeature | undefined {
  return publicFeaturePages.find(page => page.path === path.split('?')[0].replace(/index\.html$/, ''));
}
