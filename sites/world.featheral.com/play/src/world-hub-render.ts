import { publicFeaturePages } from './public-feature-content.ts';
import type { PublicCopy } from './public-feature-content.ts';
import { federationArt, federationStories, startingFederations } from './atlas.ts';
import { translate } from './i18n.ts';

const escape = (value: string) => value.replace(/[&<>"']/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const text = (tag: string, value: PublicCopy, attributes = '') =>
  `<${tag} data-public-en="${escape(value[0])}" data-public-ko="${escape(value[1])}" ${attributes}>${escape(value[0])}</${tag}>`;
export function publicHubTarget(path: string): string | undefined {
  const page = publicFeaturePages.find(page => path === page.path || path === `${page.path}index.html` || path === page.path.slice(0, -1));
  return page ? `/#${page.visual}` : undefined;
}
export function renderWorldHub(): string {
  const sections = publicFeaturePages.map(page => `<section id="${page.visual}" class="hub-section section-shell" aria-labelledby="hub-${page.visual}-title">
    <div class="hub-section-heading"><div>${text('p', page.label, 'class="eyebrow"')}${text('h2', page.headline, `id="hub-${page.visual}-title"`)}</div>
      ${text('a', page.action, `href="${page.gamePath}" class="btn btn-dark"`)}</div>
    <div class="hub-feature-content">${page.visual === 'exploration' || page.visual === 'settlements' ? `<figure class="hub-preview"><canvas width="720" height="420" data-public-map="${page.visual}" role="img" aria-label="Sample World scene" data-public-aria-en="Sample World scene" data-public-aria-ko="월드 예시 장면"></canvas>${text('figcaption', ['Sample scene · actual game artwork · not live player data', '예시 장면 · 실제 게임 그림 · 실시간 플레이어 데이터 아님'])}</figure>` : ''}
    <div>${text('p', page.lead, 'class="hub-lead"')}<div class="hub-cards">${page.cards.map(card => `<article>${text('h3', card.title)}${text('p', card.body)}</article>`).join('')}</div></div></div>
    ${page.visual === 'roadmap' ? `<div class="hub-cards hub-roadmap-phases">
      <article>${text('h3', ['Now · Perfect the World', '현재 · 월드 완성도 향상'])}${text('p', ['Refine the game loop, fair crafting, shared identity and polished site experiences. This is the active World-building phase.', '게임 흐름, 공정한 제작, 공통 계정과 사이트 경험을 다듬습니다. 현재 진행 중인 월드 구축 단계입니다.'])}</article>
      <article>${text('h3', ['Next · Standalone businesses', '다음 · 독립 사업'])}${text('p', ['Validate useful products and sustainable revenue for each site. These are planned experiments, not promised income.', '각 사이트의 유용한 제품과 지속 가능한 수익 모델을 검증합니다. 계획된 실험이며 수익을 보장하지 않습니다.'])}</article>
      <article>${text('h3', ['Then · Connected innovation', '이후 · 연결된 혁신'])}${text('p', ['Connect businesses through shared identity and business synergy. Web3 governance for future innovators is proposed, not a deployed governance right.', '공통 계정과 사업 시너지로 연결합니다. 미래 혁신가를 위한 Web3 거버넌스는 제안이며 배포된 권한이 아닙니다.'])}</article>
    </div><div class="hub-actions">${text('a', ['Full ecosystem roadmap', '전체 생태계 로드맵'], 'href="https://featheral.com/#roadmap" data-site="foundation" data-path="/#roadmap" class="hub-secondary"')}</div>` : ''}
    ${page.visual === 'federations' ? `<div class="hub-cards">${startingFederations.map(federation =>
      `<article>${federationArt(federation.name, 'flag')}${text('h3', [federation.name, federation.name])}<p>${escape(federation.motto)}</p><details>${text('summary', ['Origin story', '기원 이야기'])}${text('p', [federationStories[federation.name], translate(federationStories[federation.name], 'ko')])}</details></article>`).join('')}</div>` : ''}
    <details class="hub-scope">${text('summary', ['Scope and limitations', '범위 및 제한'])}${text('p', page.note)}</details></section>`).join('');
  return `<section class="hub-hero section-shell" aria-labelledby="hero-title"><div>
    ${text('p', ['WORLD BUILDING · PLAYABLE PROTOTYPE', '월드 구축 · 플레이 가능한 프로토타입'], 'class="eyebrow"')}
    ${text('h1', ['Your world. Our next chapter.', '나의 세계, 함께 여는 다음 장.'], 'id="hero-title"')}
    ${text('p', ['Explore, build, trade and connect. One World identity brings your settlement, community and future innovations together.',
      '탐험하고 건설하며 거래하고 연결하세요. 하나의 월드 계정으로 정착지, 커뮤니티와 미래의 혁신을 함께 만듭니다.'], 'class="hub-lead"')}
    <div class="hub-actions">${text('a', ['Start your World profile', '월드 프로필 시작'], 'href="/register/" class="btn btn-dark"')}${text('a', ['Sign in', '로그인'], 'href="/login/" class="hub-secondary"')}</div>
    ${text('p', ['Username and password or your wallet. No registration payment. Gameplay uses your approved FTH$ budget.', '아이디와 비밀번호 또는 지갑으로 가입하세요. 가입은 무료이며 게임은 승인한 FTH$ 예산을 사용합니다.'], 'class="hub-caption"')}
    </div><figure class="hub-hero-art"><img src="/images/featheral-world.svg" width="900" height="760" alt="Illustrated World settlement with trees, homes and a river" fetchpriority="high">${text('figcaption', ['A preview of what you can build', '내가 만들어 갈 세계의 미리보기'])}</figure></section>
    <section class="world-stats section-shell" aria-label="Live World statistics"><div class="world-stats-heading">${text('h2', ['A world in progress', '성장하는 세계'])}<p id="stats-status" role="status">Loading public statistics…</p></div>
    <dl class="world-stats-grid"><div>${text('dt', ['Settlements', '정착지'])}<dd><span data-total="settlements">—</span></dd></div><div>${text('dt', ['Residents', '주민'])}<dd><span data-total="population">—</span></dd></div><div>${text('dt', ['World game FTH$ budgets', '월드 게임 FTH$ 예산'])}<dd><span data-total="dollars">—</span></dd></div><div>${text('dt', ['Ethereum FTHG supply', '이더리움 FTHG 공급량'])}<dd><span data-gold-supply>—</span></dd></div></dl><p class="hub-caption">1 FTHG = <span data-public-gold-rate>—</span> FTH$. ${text('span', ['Verified service data, not investment projections.', '서비스 확인 데이터이며 투자 전망이 아닙니다.'])}</p></section>
    ${sections}
    <section id="community" class="hub-section section-shell" aria-labelledby="hub-community-title"><div class="hub-section-heading"><div>${text('p', ['COMMUNITY', '커뮤니티'], 'class="eyebrow"')}${text('h2', ['Build a world worth sharing.', '함께 나눌 가치가 있는 세계를 만드세요.'], 'id="hub-community-title"')}</div>${text('a', ['Open community feed', '커뮤니티 피드 열기'], 'href="/community/" class="btn btn-dark"')}</div>
    ${text('p', ['Share your settlement, discuss ideas and meet other builders. Your World username, avatar and sign-in follow you into Community. Public posting requires a complete profile; wallet approvals stay inside the web wallet.', '정착지를 공유하고 아이디어를 논의하며 다른 개척자를 만나세요. 월드 아이디, 아바타와 로그인이 커뮤니티에서도 이어집니다. 공개 게시에는 완성된 프로필이 필요하며 지갑 승인은 웹 지갑 안에서 진행합니다.'], 'class="hub-lead"')}
    <div class="hub-actions">${text('a', ['Edit your profile', '프로필 편집'], 'href="/account/" class="hub-secondary"')}${text('a', ['Read the full whitepaper', '전체 백서 읽기'], 'href="/whitepaper/" class="hub-secondary"')}</div></section>`;
}
