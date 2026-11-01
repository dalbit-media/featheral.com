import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { defaultLanguage, languageStorageKey, locale, resolveLanguage, translate } from './i18n.ts';
import { korean, koreanPatterns } from './translations.ts';
import { stages, terrainDetails } from './engine.ts';
import { craftableKeys, decorationSpaces, itemName, itemStorage } from './items.ts';
import { settlementTasks } from './settlement-ui.ts';
import { waterFacilityKeys, waterFacilities } from './water-facilities.ts';
import { guideTopics } from './guide.ts';
import { gamePages } from './game-pages.ts';
import { renderWhitepaper } from './whitepaper-render.ts';

test('English is the default regardless of browser language, with an explicit Korean preference', () => {
  assert.equal(defaultLanguage, 'en');
  for (const value of [undefined, null, '', 'fr', 'constructor']) assert.equal(resolveLanguage(value), 'en');
  assert.equal(resolveLanguage('ko'), 'ko');
  assert.equal(resolveLanguage('en'), 'en');
  assert.equal(translate('Explore'), 'Explore');
  assert.equal(translate('게임 안내'), 'How it works');
  assert.equal(locale('ko'), 'ko-KR');
  assert.equal(locale('en'), 'en-US');
  assert.equal(languageStorageKey, 'featheral-language');
  assert.notEqual(languageStorageKey, 'terra-world-v1');
});
test('every static catalog entry translates exactly and Korean text is idempotent', () => {
  for (const [source, target] of Object.entries(korean)) {
    assert.equal(translate(source, 'ko'), target, source);
    assert.equal(translate(target, 'ko'), target, target);
    assert.ok(translate(target, 'en').length > 0);
  }
  assert.equal(translate('  Explore  ', 'ko'), '  탐험  ');
  assert.equal(translate('Unknown phrase', 'ko'), 'Unknown phrase');
  assert.equal(translate('__proto__', 'ko'), '__proto__');
  assert.equal(translate('<img src=x onerror=alert(1)>', 'ko'), '<img src=x onerror=alert(1)>');
  assert.equal(translate('Explore', 'en'), 'Explore');
  assert.equal(translate('Confirming', 'ko'), '확인 중');
  assert.equal(translate('Confirming', 'en'), 'Confirming');
  assert.equal(translate('게임 안내', 'en'), 'How it works');
});
test('all population-health states have Korean labels and retain explicit English support', () => {
  for (const label of ['Recruit residents', 'Water shortage', 'Low Water reserve', 'No explorer crew', 'Healthy',
    'Resource settings', 'Crew allocation', 'Collecting']) {
    assert.notEqual(translate(label, 'ko'), label);
    assert.equal(translate(label, 'en'), label);
  }
});
test('homepage FTHG transaction count and its scope are bilingual', () => {
  assert.equal(translate('FTHG transactions', 'ko'), 'FTHG 누적 거래');
  assert.equal(translate('FTHG 누적 거래', 'en'), 'FTHG transactions');
  const scope = 'Recorded completed FTHG purchases and sales at Featheral Bank. Failed requests, retries and staking are excluded. These are not on-chain transactions.';
  assert.notEqual(translate(scope, 'ko'), scope);
  assert.equal(translate(translate(scope, 'ko'), 'en'), scope);
});
test('bank terms, funding warnings and council actions are Korean-first', () => {
  for (const label of ['Featheral Bank', 'Open Featheral Bank', 'Review staking', 'Fund rewards', 'Receive staking payout',
    'Council annual rate', 'Real-time lock duration', 'Approve rate', 'Reject rate', 'No quote',
    'The reward treasury cannot fund this entire term.', 'The council has not approved an interest rate.',
    'Bank quote changed. Review the new terms.', 'Staked FTHG cannot be withdrawn before maturity.']) {
    assert.notEqual(translate(label, 'ko'), label);
    assert.equal(translate(label, 'en'), label);
  }
  for (const years of [1, 2, 5, 10, 20, 30]) {
    assert.equal(translate(`${years} game ${years === 1 ? 'year' : 'years'}`, 'ko'), `게임 시간 ${years}년`);
  }
});
test('calendar season labels and progress descriptions are fully bilingual', () => {
  assert.equal(translate('Game clock', 'ko'), '게임 시계');
  for (const [full, short, koreanFull, koreanShort] of [
    ['Monday', 'Mo', '월요일', '월'], ['Tuesday', 'Tu', '화요일', '화'], ['Wednesday', 'We', '수요일', '수'],
    ['Thursday', 'Th', '목요일', '목'], ['Friday', 'Fr', '금요일', '금'], ['Saturday', 'Sa', '토요일', '토'],
    ['Sunday', 'Su', '일요일', '일'],
  ]) {
    assert.equal(translate(full, 'ko'), koreanFull);
    assert.equal(translate(short, 'ko'), koreanShort);
    assert.equal(translate(short, 'en'), short);
  }
  assert.equal(translate('Season progress', 'ko'), '올해 계절 진행도');
  for (const [season, name] of [['Spring', '봄'], ['Summer', '여름'], ['Autumn', '가을'], ['Winter', '겨울']]) {
    assert.equal(translate(season, 'ko'), name);
    assert.equal(translate(`${season} · Week 13 of 13`, 'ko'), `${name} · 이번 계절 13주 중 13주`);
    assert.equal(translate(`${season} · Week 1 of 13`, 'en'), `${season} · Week 1 of 13`);
  }
});
test('Water facility names, rules, construction feedback and yield labels are bilingual', () => {
  for (const label of ['Water facilities', 'Water output', 'Water per resident / week', 'Next work week']) {
    assert.notEqual(translate(label, 'ko'), label);
    assert.equal(translate(label, 'en'), label);
  }
  for (const key of waterFacilityKeys) {
    const name = waterFacilities[key].name;
    assert.notEqual(translate(name, 'ko'), name);
    assert.equal(translate(name, 'en'), name);
    assert.match(translate(`${name} constructed. Water production increases next work week.`, 'ko'), /건설 완료! 다음 작업 주부터 물 채집량이 늘어납니다/);
  }
});
test('account settings, wallet preparation and withdrawal restrictions are fully bilingual', () => {
  for (const label of ['Account', 'Close account', 'Back to account', 'YOUR PIONEER', 'Available FTHG', 'Open marketplace', 'Account resources',
    'Settings', 'Show world conditions', 'Wallet', 'Connect wallet', 'Disconnect wallet', 'Withdraw FTHG',
    'Withdrawal amount · FTHG', 'Maximum eligible amount', 'Withdrawals unavailable',
    'Enter a positive multiple of 1,000 FTHG.', 'Not enough available FTHG.',
    'Wallet connection is optional. Never share your recovery phrase or private key.',
    'Wallet connection does not sign in or link your game save.',
    'Disconnect removes the wallet from this app only.',
    'Withdrawals are not available yet. No tokens are sent and no FTHG is deducted.',
    'Withdrawals require multiples of 1,000 FTHG. A payout network, token and service must be configured first.',
    'The wallet returned an invalid address.', 'The wallet returned an invalid network.',
    'No compatible browser wallet found. Install an EVM wallet or open this page in its browser.',
    'Display preferences could not be read. Default settings are active.',
    'Display preference could not be saved. This change lasts until reload.',
    'Wallet disconnected from this app.', 'Network ID', 'Wallet connected. Withdrawals remain unavailable.',
    'Wallet connection failed.', 'Waiting for wallet approval...', 'No wallet account was selected.', 'Wallet connection cancelled.']) {
    assert.notEqual(translate(label, 'ko'), label);
    assert.equal(translate(label, 'en'), label);
  }
});
test('all guide chapters, descriptions, captions, actions and daily page labels are bilingual', () => {
  const labels: string[] = [...Object.values(gamePages).map(page => page.label),
    'Daily Water', 'Daily departures at risk', 'Last daily departures', 'Collection / week', 'Consumption / day',
    'Find a topic', 'Reading progress', 'Show all topics', 'Search your journal', 'Community census',
    'Screen preview', 'Exit preview', 'Preview mobile layout',
    'Preview tablet layout', 'Toggle fullscreen',
    'Fullscreen is not supported by this browser.', 'Fullscreen unavailable'];
  for (const topic of guideTopics) labels.push(topic.title, topic.tag, topic.intro, ...topic.paragraphs, topic.tip, topic.action, ...('alt' in topic ? [topic.alt] : []));
  for (const label of labels) {
    assert.notEqual(translate(label, 'ko'), label, label);
    assert.equal(translate(label, 'en'), label, label);
  }
  assert.equal(translate('Water shortage: 1 residents left your settlement.', 'ko'), '물 부족: 주민 1명 이탈');
  assert.equal(translate('Water shortage: 21 residents left your settlement.', 'en'), 'Water shortage: 21 residents left your settlement.');
  assert.equal(translate('Population: 30 residents · 26 active · 4 idle', 'ko'), '인구: 주민 30명 · 작업 중 26명 · 미배치 4명');
  assert.equal(translate('Water allocation slider', 'ko'), '물 배치 인원 슬라이더');
  assert.equal(translate('Recruiting', 'ko'), '모집 중');
  assert.equal(translate('3d 12h', 'ko'), '3일 12시간');
  assert.equal(translate('2h 1m', 'ko'), '2시간 1분');
  assert.equal(translate('1m', 'ko'), '1분');
  assert.equal(translate('20x DEV', 'ko'), '개발 20배속');
  assert.equal(translate('Development server time runs 20x faster. All gameplay rates and durations are unchanged.', 'ko'), '개발 서버의 시간이 20배 빠르게 흐릅니다. 게임의 생산량과 소요 시간 규칙은 동일합니다.');
});
test('translation templates preserve every placeholder without adding or dropping values', () => {
  for (const [source, target] of koreanPatterns) {
    const keys = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
    assert.deepEqual(keys(target), keys(source), source);
  }
});
test('weekly resource flow labels are fully translated', () => {
  for (const [source, target] of [
    ['Collection', '채집'], ['Consumption (transport)', '소모 (운송)'],
    ['1 game week', '게임 시간 1주'], ['Storage full', '창고 가득 참'],
    ['Consumption (population)', '소모 (주민)'], ['Weekly Water', '주간 물 소비'],
    ['Weekly departures at risk', '주간 이탈 위험 인원'], ['Last weekly departures', '지난주 이탈 인원'],
    ['Next consumption', '다음 소비까지'], ['Buy Water', '물 구매'],
  ]) {
    assert.equal(translate(source, 'ko'), target);
    assert.equal(translate(source, 'en'), source);
  }
});
test('settlement task controls, goals and placement instructions are localized', () => {
  for (const label of [...Object.values(settlementTasks).map(task => task.label), 'Close settlement panel', 'Settlement actions',
    'Cancel placement', 'Inventory rules', 'Crafting rules', 'Crafting filters', 'Allocation rules', 'Manage residents', 'Manage production',
    'Meet the highlighted requirements to upgrade.', 'Inventory capacity', 'Saving...', 'Layout', 'Arrange buildings',
    'Settlement centre', 'Your buildings and decorations', 'Layout controls', 'Place by coordinates', 'Save position',
    'Choose a land cell inside the settlement boundary.', 'That cell is occupied. Choose an empty cell.', 'World conditions']) {
    assert.notEqual(translate(label, 'ko'), label);
    assert.equal(translate(label, 'en'), label);
  }
  assert.equal(translate('Choose a space for Wooden bench.', 'ko'), '나무 벤치 배치: 원하는 공간을 선택하세요.');
  assert.equal(translate('12 / 25 residents', 'ko'), '주민 12 / 25명');
  assert.equal(translate('Residents for Camp: 12 / 25', 'ko'), '야영지 승급에 필요한 주민: 12 / 25명');
  assert.equal(translate('Choose an empty land cell for Residence 3.', 'ko'), '주택 3 배치: 빈 땅을 선택하세요.');
  assert.equal(translate('Moved Crafting workshop to -8, 7.', 'ko'), '제작 공방 배치 완료! 위치: -8, 7.');
  assert.equal(translate('Placed at -8, 7', 'ko'), '배치 위치: -8, 7');
  assert.equal(translate('Returned Wooden bench to inventory.', 'ko'), '나무 벤치 인벤토리 회수 완료.');
});
test('item catalogs, storage, finds and crafting messages are localized', () => {
  const labels = [...craftableKeys.map(itemName), ...Object.values(decorationSpaces).map(space => space.name), ...itemStorage.map(tier => tier.name),
    ...Object.keys(terrainDetails).map(terrain => itemName(`relic-${terrain}` as Parameters<typeof itemName>[0]))];
  for (const label of labels) {
    assert.notEqual(translate(label, 'ko'), label);
    assert.equal(translate(label, 'en'), label);
    assert.equal(translate(translate(label, 'ko'), 'ko'), translate(label, 'ko'));
  }
  for (const [source, expected] of [
    ['Carrier · 40 item slots', '운반차 · 아이템 40칸'],
    ['Inventory page 2 of 5', '인벤토리 5페이지 중 2페이지'],
    ['Page 2 of 5', '2 / 5페이지'],
    ['Crafted Torch. It is now in your item inventory.', '횃불 제작 완료! 인벤토리에 보관했습니다.'],
    ['Equipped Lamp. Visibility applies to future expeditions.', '램프 장착 완료! 다음 탐험대부터 시야 효과가 적용됩니다.'],
    ['Collected 3 exploration finds into item inventory.', '탐험 발견물 3개를 인벤토리로 받았습니다.'],
    ['Placed Wooden bench in Central square.', '중앙 광장에 나무 벤치 배치 완료!'],
    ['Decorate Community garden: Empty space', '공동 정원 꾸미기: 빈 공간'],
    ['Cleared Welcome gate. Your decoration stays in inventory.', '입구의 장식을 회수했습니다. 아이템은 인벤토리에 그대로 보관됩니다.'],
  ]) assert.equal(translate(source, 'ko'), expected);
});
test('all terrain, progression, season, weather and phase names are translated', () => {
  const labels = [...stages.map(stage => stage.name), ...Object.values(terrainDetails).map(terrain => terrain.name),
    'Spring', 'Summer', 'Autumn', 'Winter', 'Dawn', 'Day', 'Dusk', 'Night',
    'Clear skies', 'Overcast', 'Rain', 'Snow', 'Storm'];
  for (const label of labels) {
    assert.notEqual(translate(label, 'ko'), label);
    assert.equal(translate(label, 'en'), label);
  }
});
test('weekly crews, resource claims, clocks and historical logs translate dynamic values', () => {
  const examples = [
    ['Year 11', '11년'],
    ['Week 52', '52주'],
    ['Week 52 of 52 · Day 7 of 7', '연간 52주 중 52주 · 이번 주 7일 중 7일'],
    ['Year 11 · Day 1,399 · Winter', '11년 · 1,399일 · 겨울'],
    ['Year 11 · Day 1,399', '11년 · 1,399일'],
    ['Year 11 · Day 1,399 · 06:05 · Winter', '11년 · 1,399일 · 06:05 · 겨울'],
    ['Year 12 · Day 1 · 00:00 · Spring', '12년 · 1일 · 00:00 · 봄'],
    ['Winter · Day 1,399 · Night · Simulated', '겨울 · 1,399일 · 밤 · 가상 날씨'],
    ['0° N   3° W', '북위 0° 서경 3°'],
    ['3 residents · +90/week', '주민 3명 · 주간 채집량 +90'],
    ['Whispering woodland (-3,0) · 100%', '속삭이는 숲 (-3,0) · 100%'],
    ['2h 48m 0s server time', '서버 시간 2시간 48분 0초'],
    ['50 wood', '목재 50개'],
    ['50 wood, insufficient', '목재 50개, 부족'],
    ['Claim 90 wood', '목재 90개 수령'],
    ['Wood: 180 owned, 90 pending', '목재: 180개 보유, 90개 수령 대기'],
    ['2 metal per wood', '목재 1개당 금속 2개'],
    ['50% claim threshold', '저장 공간 50%부터 수령 가능'],
    ['Warehouse upgraded to level 2.', '창고를 2레벨로 확장했습니다.'],
    ['18 new residents joined your community.', '새 주민 18명이 정착지에 합류했습니다.'],
    ['Recruiting 18 residents. Arrival in one game week.', '주민 18명 모집을 시작했습니다. 게임 시간 1주 뒤에 합류합니다.'],
    ['Recruiting · 6d 23h', '모집 중 · 6일 23시간'],
    ['Recruiting 18 residents, ready in 10080 server seconds', '주민 18명 모집 중: 서버 시간 10080초 후 합류'],
    ['Settlement: 30 residents · 26 active · 4 idle', '정착지: 주민 30명 · 작업 중 26명 · 미배치 4명'],
    ['Explored forest at -2, 4.', '-2, 4의 숲 지형을 탐험했습니다.'],
    ['Collected 35 wood. A little more possibility.', '목재 35개 획득! 다음 성장을 준비하세요.'],
    ['3 residents assigned to wood. First delivery in one in-game week.', '주민 3명을 목재 채집팀에 배치했습니다. 첫 자원은 게임 시간 1주 뒤에 도착합니다.'],
    ['Pending storage must be at least 50% full (50 units per resource) to claim.', '각 자원은 저장량 50%(50개) 이상일 때 수령할 수 있습니다.'],
    ['Server state unavailable; reconnect before retrying. Failed to fetch', '서버 상태를 확인할 수 없습니다. 다시 연결한 뒤 시도하세요. 서버에 연결하지 못했습니다'],
    ['Enter a whole number between 0 and 12.', '0~12 사이의 정수를 입력하세요.'],
    ['Send 2 residents? Cost: 35 metal. Duration: 2 game weeks.', '주민 2명을 탐험에 보내시겠습니까? 비용: 금속 35개. 소요 시간: 게임 시간 2주.'],
    ['Next expedition: 35 metal · 2 game weeks', '다음 탐험: 금속 35개 · 게임 시간 2주'],
    ['3 expeditions exploring', '탐험대 3팀 탐험 중'],
    ['Expedition returned from Stillwater lake. Charted 0 new tiles; 2 residents are available.', '고요한 호수 탐험 완료! 새로운 지역 0칸을 밝혔습니다. 복귀한 주민 2명을 다시 배치할 수 있습니다.'],
  ];
  for (const [source, expected] of examples) {
    assert.equal(translate(source, 'ko'), expected, source);
    assert.equal(translate(source, 'en'), source, source);
    assert.equal(translate(expected, 'ko'), expected, expected);
  }
});
test('Korean game and Web3 copy uses familiar, consistent terms without changing English', () => {
  const examples = [
    ['Market', '거래소'], ['Journal', '활동 기록'], ['Crews', '채집팀'],
    ['Discovered site', '발견한 자원지'], ['Recruitment', '주민 모집'],
    ['Active', '작업 중'], ['Idle', '미배치'],
    ['Settlement workforce', '정착지 주민 배치 현황'],
    ['Upgrade', '업그레이드'], ['Town hall', '마을 회관'], ['Claim', '받기'],
    ['Claim eligible resources', '자원 모두 받기'],
    ['Simulated market · Fixed prices', '가상 거래소 · 고정 가격'],
    ['FREE SINGLE-PLAYER EXPLORATION & BUILDING GAME', '무료 싱글플레이 탐험·건설 게임'],
    ['In-game currency · off-chain', '게임 내 재화 · 오프체인'],
    ['4 available residents', '미배치 주민 4명'],
    ['Assign wood crew', '목재 채집팀 배치'],
    ['180% site yield', '자원지 효율 180%'],
    ['Warehouse level 3 of 10', '창고 3레벨 / 최대 10레벨'],
    ['Travelled to known terrain at -2, 4.', '이동 완료: 탐험한 지역 (-2, 4).'],
    ['Town hall constructed. New opportunities unlocked.', '마을 회관 건설 완료! 새로운 기능이 해금되었습니다.'],
    ['Claimed 30 metal from the simulated global reward pool.', '가상 보상 풀에서 게임 금속 30개를 받았습니다.'],
  ];
  for (const [source, target] of examples) {
    assert.equal(translate(source, 'ko'), target, source);
    assert.equal(translate(source, 'en'), source, source);
    assert.equal(translate(target, 'ko'), target, target);
  }
  const copy = [...Object.values(korean), ...koreanPatterns.map(([, target]) => target)].join('\n');
  assert.doesNotMatch(copy, /시제품|작업반|여유 주민|자원 산지|영 주소|공회당|주민 초대|모집[가는를]|콘셉트[은을]/);
  assert.match(copy, /게임 시간 1주 뒤에/);
  assert.doesNotMatch(copy, /서버 시간 10분마다|모집 쿨타임은 서버 시간 10분/);
  assert.match(translate('Do not send ETH or tokens to this address. It is the zero address, not a deployed FTHG contract.', 'ko'), /제로 주소/);
  const disclosure = translate('Metal is a gameplay resource; FTHG is the marketplace currency. Exchange them at floating in-game rates. Neither is an on-chain token or redeemable for cash. No investment returns or governance rights are promised.', 'ko');
  assert.match(disclosure, /FTHG는 거래소에서 쓰는 재화/);
  assert.match(disclosure, /변동 시세로 서로 교환/);
  assert.match(disclosure, /둘 다 온체인 토큰이 아니며 현금화할 수 없습니다/);
  assert.match(disclosure, /투자 수익이나 거버넌스 권리를 약속하지 않습니다/);
});
test('static Korean entry copy stays aligned with the catalog for English switching', () => {
  for (const file of ['../about/index.html', '../whitepaper/index.html', '../index.html', '../settlement/index.html', '../market/index.html']) {
    const html = readFileSync(new URL(file, import.meta.url), 'utf8');
    const strings = [
      ...[...html.matchAll(/>([^<>]+)</g)].map(match => match[1]),
      ...[...html.matchAll(/\b(?:content|aria-label|alt|title)="([^"]*)"/g)].map(match => match[1]),
    ];
    for (const text of strings) {
      if (!/[가-힣]/.test(text) || text.trim() === '한국어') continue;
      assert.notEqual(translate(text, 'en'), text, `${file}: ${text.trim()}`);
    }
    assert.doesNotMatch(html, /시제품|작업반|자원 산지|영 주소|공회당|주민 초대/);
  }
});
test('all static server-facing gameplay and HTTP errors have Korean translations', () => {
  let checked = 0;
  for (const file of ['engine.ts', '../server/economy.ts', '../server/inventory.ts', '../server/store.ts', '../server/http.ts', '../server/market.ts', '../server/gold.ts', '../server/chat.ts']) {
    const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node) && ['ApiError', 'GameError'].includes(node.expression.getText(source))) {
        for (const argument of node.arguments ?? []) if (ts.isStringLiteral(argument)) {
          assert.notEqual(translate(argument.text, 'ko'), argument.text, `${file}: ${argument.text}`);
          checked++;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.ok(checked >= 40);
});
test('both white papers expose all ten sections and retain all critical launch disclaimers', () => {
  for (const language of ['', '.ko']) {
    const paper = readFileSync(new URL(`../public/WHITEPAPER${language}.md`, import.meta.url), 'utf8');
    for (let section = 1; section <= 10; section++) assert.match(paper, new RegExp(`^## ${section}\\.`, 'm'));
    for (const token of ['FTHG', 'Ethereum', '0x0000000000000000000000000000000000000000']) {
      if (language === '.ko' && token === 'Ethereum') assert.match(paper, /이더리움/);
      else assert.ok(paper.includes(token), token);
    }
  }
  const koreanPaper = readFileSync(new URL('../public/WHITEPAPER.ko.md', import.meta.url), 'utf8');
  for (const term of ['채집팀', '자원지', '주민 모집', '쿨타임', '거버넌스', '제로 주소']) assert.ok(koreanPaper.includes(term), term);
  assert.doesNotMatch(koreanPaper, /시제품|작업반|자원 산지|영 주소|공회당|주민 초대|모집[가는를]|콘셉트[은을]/);
  assert.match(koreanPaper, /FTH\$는 게임 기본 재화, 금속은 건설 자원입니다/);
  assert.match(koreanPaper, /토큰 스테이킹이나 암호화폐 보상 프로그램이 아닙니다/);
  assert.match(koreanPaper, /게임 시간 7일마다/);
  assert.match(koreanPaper, /서버 시간 168분/);
  assert.match(koreanPaper, /저장량 50% 조건은 없습니다/);
  assert.match(koreanPaper, /창고레벨\*500/);
  assert.match(koreanPaper, /영구 소각/);
  assert.match(koreanPaper, /최대 8레벨/);
});
test('white paper pages render every chapter, table and contract disclosure with web language links', () => {
  for (const language of ['ko', 'en'] as const) {
    const source = readFileSync(new URL(`../public/WHITEPAPER${language === 'ko' ? '.ko' : ''}.md`, import.meta.url), 'utf8');
    const html = renderWhitepaper(source, language);
    assert.match(html, /<h1 id="paper-title">Featheral<\/h1>/);
    assert.equal(html.match(/<a href="#section-\d+">/g)?.length, 10);
    for (let section = 1; section <= 10; section++) assert.match(html, new RegExp(`<h2 id="section-${section}" tabindex="-1">`));
    assert.match(html, /<blockquote>/);
    assert.match(html, /<strong>/);
    assert.match(html, /<ol>/);
    assert.match(html, /<pre><code class="language-text">/);
    assert.match(html, /<div class="paper-table" tabindex="0" role="region"/);
    assert.match(html, /0x0000000000000000000000000000000000000000/);
    assert.match(html, /https:\/\/www\.who\.int\//);
    assert.ok(html.includes(`/play/whitepaper/?lang=${language === 'ko' ? 'en' : 'ko'}`));
    assert.doesNotMatch(html, /href="[^"]*WHITEPAPER[^"]*\.md"/);
    assert.ok(html.includes(language === 'ko' ? '토큰 투자 제안서가 아닙니다' : 'Not a token offering'));
  }
});
test('Dollar ticker is FTH$ in both languages, including historical F$ messages', () => {
  assert.equal(translate('F$', 'en'), 'FTH$');
  assert.equal(translate('F$', 'ko'), 'FTH$');
  assert.equal(translate('Not enough F$ for this order.', 'en'), 'Not enough FTH$ for this order.');
  assert.equal(translate('Not enough F$ for this order.', 'ko'), translate('Not enough FTH$ for this order.', 'ko'));
  assert.equal(translate('Available balance', 'ko'), '주문 가능 잔액');
  assert.equal(translate('Available FTH$ balance', 'ko'), '주문 가능한 FTH$ 잔액');
});
