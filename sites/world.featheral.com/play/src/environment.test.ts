import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { displayServerTime, environmentAt, seasonMs, weatherMs, worldDayMs, worldEpoch, worldWeekMs, worldWeeksPerYear, worldYearMs } from './environment.ts';
import { compactServerCountdown, completionProgress, weekCalendar } from './environment-view.ts';
import { icon } from './icons.ts';

test('ordinary calendar ticks reuse DOM and update only transform scales and accessible values', () => {
  const properties = new Map<string, string>(), attributes = new Map<string, string>();
  const style = { setProperty: (name: string, value: string) => properties.set(name, value) };
  const time = { textContent: '' };
  const dayFill = { style };
  const week = { dataset: { dayOfWeek: '1' }, querySelector: () => ({ querySelector: () => dayFill }),
    setAttribute: (name: string, value: string) => attributes.set(`week-${name}`, value) };
  const seasons = { querySelector: () => ({ style }),
    setAttribute: (name: string, value: string) => attributes.set(`seasons-${name}`, value) };
  const e = environmentAt(worldEpoch);
  const root = {
    firstElementChild: {}, dataset: { calendarKey: `${e.year}:${e.weekOfYear}:${e.dayOfWeek}:${e.phase}:${e.season}` },
    ownerDocument: { createElement: () => { throw new Error('Unchanged calendar must not parse a template.'); } },
    querySelector: (selector: string) => selector === '.clock-week' ? week : selector === '.clock-seasons' ? seasons : time,
  };
  const source = stripTypeScriptTypes(readFileSync(new URL('./environment-view.ts', import.meta.url), 'utf8'))
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  runInNewContext(`${source}\nupdateWeekCalendar(root, e, worldEpoch + 1000);`, {
    root, e, worldEpoch, worldDayMs, worldYearMs, seasonMs, worldWeeksPerYear, environmentAt,
  });
  assert.equal(time.textContent, '00:01');
  assert.equal(Number(properties.get('--day-scale')), 1000 / worldDayMs);
  assert.equal(Number(properties.get('--season-scale')), 1000 / seasonMs);
  assert.equal(properties.has('--day-progress'), false, 'tick does not mutate layout widths');
  assert.ok(Number(attributes.get('week-aria-valuenow')) > 0);
});

test('one world day is exactly 24 server minutes and wraps at the millisecond boundary', () => {
  const first = environmentAt(worldEpoch);
  assert.equal(first.day, 1);
  assert.equal(first.minuteOfDay, 0);
  assert.equal(environmentAt(worldEpoch + 999).minuteOfDay, 0);
  assert.equal(environmentAt(worldEpoch + 1000).minuteOfDay, 1);
  assert.equal(environmentAt(worldEpoch + worldDayMs - 1).minuteOfDay, 1439);
  assert.equal(environmentAt(worldEpoch + worldDayMs).minuteOfDay, 0);
  assert.equal(environmentAt(worldEpoch + worldDayMs).day, 2);
});
test('compact server countdowns use mm:ss and retain hours without rounding down early', () => {
  for (const [seconds, expected] of [[-1, '00:00'], [0, '00:00'], [.001, '00:01'], [59, '00:59'], [59.001, '01:00'], [60, '01:00'], [1440, '24:00'], [3599, '59:59'], [3600, '1:00:00'], [3661, '1:01:01']] as const) {
    assert.equal(compactServerCountdown(seconds), expected);
  }
});
test('work completion bars clamp progress and show game days, hours and minutes without inventing completion', () => {
  const start = worldEpoch, due = start + worldWeekMs;
  assert.deepEqual(completionProgress(start, due, start), { percent: 0, countdown: '7d 0h' });
  assert.deepEqual(completionProgress(start, due, start + worldWeekMs / 2), { percent: 50, countdown: '3d 12h' });
  assert.equal(completionProgress(start, due, start - 1000).percent, 0);
  assert.equal(completionProgress(start, due, due - worldDayMs / 24 * 2 - 1000).countdown, '2h 1m');
  assert.equal(completionProgress(start, due, due - 1000).countdown, '1m');
  for (const time of [due, due + worldWeekMs]) {
    assert.deepEqual(completionProgress(start, due, time), { percent: 100, countdown: 'Awaiting server confirmation' });
  }
  const twoWeeks = completionProgress(start, start + worldWeekMs * 2, start + worldWeekMs);
  assert.equal(twoWeeks.percent, 50);
  assert.equal(twoWeeks.countdown, '7d 0h');
  const threeWeeks = completionProgress(start, start + worldWeekMs * 3, start + worldWeekMs);
  assert.ok(Math.abs(threeWeeks.percent - 100 / 3) < 1e-10);
  const frozen = displayServerTime(start, 90000, 20);
  assert.deepEqual(completionProgress(start, due, displayServerTime(start, 999999, 20)), completionProgress(start, due, frozen));
});
test('day phases use shared world hours with gradual dawn and dusk lighting', () => {
  const at = (hour: number) => environmentAt(worldEpoch + hour * 60000);
  for (const [hour, phase] of [[0, 'Night'], [5, 'Dawn'], [7, 'Day'], [18, 'Dusk'], [20, 'Night']] as const) {
    assert.equal(at(hour).phase, phase);
  }
  assert.equal(at(5).daylight, 0);
  assert.equal(at(6).daylight, 0.5);
  assert.equal(at(7).daylight, 1);
  assert.equal(at(18).daylight, 1);
  assert.equal(at(19).daylight, 0.5);
  assert.equal(at(20).daylight, 0);
});
test('each season lasts exactly 13 game weeks and four seasons align with a 52-week year', () => {
  assert.equal(seasonMs, 13 * worldWeekMs);
  assert.equal(worldYearMs, 4 * seasonMs);
  for (const [index, season] of ['Spring', 'Summer', 'Autumn', 'Winter', 'Spring'].entries()) {
    assert.equal(environmentAt(worldEpoch + index * seasonMs).season, season);
  }
  assert.equal(environmentAt(worldEpoch + seasonMs - 1).season, 'Spring');
  assert.equal(environmentAt(worldEpoch + 7 * worldDayMs).season, 'Spring');
});
test('calendar years span four seasons and day-of-year resets at the exact boundary', () => {
  const first = environmentAt(worldEpoch);
  assert.equal(first.year, 1);
  assert.equal(first.dayOfYear, 1);
  assert.equal(worldWeeksPerYear, 52);
  assert.equal(worldYearMs / worldDayMs, 364);
  const summer = environmentAt(worldEpoch + seasonMs);
  assert.equal(summer.year, 1);
  assert.equal(summer.dayOfYear, 92);
  assert.equal(summer.weekOfYear, 14);
  assert.equal(summer.season, 'Summer');
  const last = environmentAt(worldEpoch + worldYearMs - 1);
  assert.equal(last.year, 1);
  assert.equal(last.dayOfYear, 364);
  assert.equal(last.weekOfYear, 52);
  assert.equal(last.dayOfWeek, 7);
  assert.equal(last.season, 'Winter');
  const next = environmentAt(worldEpoch + worldYearMs);
  assert.equal(next.year, 2);
  assert.equal(next.dayOfYear, 1);
  assert.equal(next.day, 365);
  assert.equal(next.weekOfYear, 1);
  assert.equal(next.dayOfWeek, 1);
  assert.equal(next.season, 'Spring');
  assert.equal(environmentAt(worldEpoch - 1).year, 0);
  assert.equal(environmentAt(worldEpoch - 1).dayOfYear, 364);
});
test('all 52 calendar weeks have exactly seven days and roll over at exact boundaries', () => {
  for (let week = 1; week <= 52; week++) for (let day = 1; day <= 7; day++) {
    const time = worldEpoch + ((week - 1) * 7 + day - 1) * worldDayMs;
    for (const offset of [0, worldDayMs - 1]) {
      const environment = environmentAt(time + offset);
      assert.equal(environment.weekOfYear, week); assert.equal(environment.dayOfWeek, day);
      assert.equal(environment.year, 1);
    }
  }
  const previous = environmentAt(worldEpoch - 1);
  assert.equal(previous.weekOfYear, 52); assert.equal(previous.dayOfWeek, 7);
});
test('compact world clock has no analog dial and weekday segments track each day', () => {
  const weekdays = [['Monday', 'Mo'], ['Tuesday', 'Tu'], ['Wednesday', 'We'],
    ['Thursday', 'Th'], ['Friday', 'Fr'], ['Saturday', 'Sa'], ['Sunday', 'Su']];
  for (let day = 1; day <= 7; day++) {
    const html = weekCalendar(environmentAt(worldEpoch + (day - 1) * worldDayMs + 12 * 60000));
    assert.equal((html.match(/class="clock-day(?: current)?"/g) ?? []).length, 7);
    assert.equal((html.match(/class="clock-day-fill"/g) ?? []).length, 7);
    assert.doesNotMatch(html, /clock-face|clock-dial|clock-hour-hand|clock-minute-hand/);
    assert.equal((html.match(/--day-progress:100%/g) ?? []).length, day - 1);
    assert.equal((html.match(/--day-progress:50%/g) ?? []).length, 1);
    assert.match(html, new RegExp(`aria-valuenow="${day - .5}"`));
    assert.match(html, new RegExp(`Week 1 of 52 · Day ${day} of 7`));
    assert.match(html, /12:00/);
    const [name, label] = weekdays[day - 1];
    assert.ok(html.includes(`class="clock-current-day" title="${name}">${label}</span>`));
    assert.doesNotMatch(html, /Day \d+<\/span>/);
  }
  const next = weekCalendar(environmentAt(worldEpoch + worldYearMs));
  assert.match(next, /Year 2/); assert.match(next, /Week 1</); assert.match(next, /aria-valuenow="0"/);
  assert.equal((next.match(/--day-progress:0%/g) ?? []).length, 7);
});
test('calendar retains exact seasonal progress alongside the compact week line', () => {
  for (const [index, season] of ['Spring', 'Summer', 'Autumn', 'Winter'].entries()) {
    const html = weekCalendar(environmentAt(worldEpoch + index * seasonMs + seasonMs / 2));
    assert.equal((html.match(/class="clock-day(?: current)?"/g) ?? []).length, 7);
    assert.equal((html.match(/class="clock-season clock-season-/g) ?? []).length, 4);
    assert.equal((html.match(/class="clock-season clock-season-\w+ complete"/g) ?? []).length, index);
    assert.equal((html.match(/class="clock-season clock-season-\w+ current"/g) ?? []).length, 1);
    assert.ok(html.indexOf('class="clock-seasons"') > html.indexOf('class="clock-week"'));
    assert.match(html, new RegExp(`aria-label="Season progress"[^>]+aria-valuenow="${index + .5}"`));
    assert.match(html, new RegExp(`clock-season-${season.toLowerCase()} current"[^>]+--season-progress:50%`));
    assert.match(html, new RegExp(`${season} · Week 7 of 13`));
    for (const name of ['Spring', 'Summer', 'Autumn', 'Winter']) assert.ok(html.includes(`<span>${name}</span>`));
    for (const symbol of ['flower', 'sun', 'leaf', 'snowflake']) assert.ok(html.includes(icon(symbol, 'season-icon')));
  }
});
test('season bars roll over only at exact season and year boundaries, including before the epoch', () => {
  for (let index = 1; index <= 4; index++) {
    const before = weekCalendar(environmentAt(worldEpoch + index * seasonMs - 1));
    const next = weekCalendar(environmentAt(worldEpoch + index * seasonMs));
    assert.match(before, /--season-progress:99\.9992%/);
    assert.equal((before.match(/class="clock-season clock-season-\w+ complete"/g) ?? []).length, index - 1);
    assert.equal((next.match(/class="clock-season clock-season-\w+ complete"/g) ?? []).length, index % 4);
    assert.match(next, /current"[^>]+--season-progress:0%/);
  }
  const last = weekCalendar(environmentAt(worldEpoch - 1));
  assert.match(last, /clock-season-winter current/);
  assert.match(last, /aria-label="Season progress"[^>]+aria-valuenow="3\.999992"/);
  const frozen = displayServerTime(worldEpoch, 90000, 20);
  assert.equal(weekCalendar(environmentAt(displayServerTime(worldEpoch, 999999, 20))), weekCalendar(environmentAt(frozen)));
});
test('temperature responds to world daylight and seasons', () => {
  const midnight = environmentAt(worldEpoch);
  const noon = environmentAt(worldEpoch + 12 * 60000);
  assert.ok(noon.temperature > midnight.temperature);
  assert.ok(environmentAt(worldEpoch + seasonMs + 12 * 60000).temperature
    > environmentAt(worldEpoch + 3 * seasonMs + 12 * 60000).temperature);
});
test('weather is deterministic, varies over server time, and only snows in cold conditions', () => {
  const weather = new Set<string>();
  for (let elapsed = 0; elapsed < 4 * seasonMs; elapsed += weatherMs) {
    const time = worldEpoch + elapsed, environment = environmentAt(time);
    assert.deepEqual(environmentAt(time), environment);
    const later = environmentAt(time + weatherMs - 1);
    if (environment.weather === 'Clear skies' || environment.weather === 'Overcast') assert.equal(later.weather, environment.weather);
    else assert.ok(['Rain', 'Snow', 'Storm'].includes(later.weather));
    assert.ok(environment.temperature >= -20 && environment.temperature <= 40);
    assert.ok(environment.daylight >= 0 && environment.daylight <= 1);
    if (environment.weather === 'Snow') assert.ok(environment.temperature <= 1);
    weather.add(environment.weather);
  }
  assert.deepEqual([...weather].sort(), ['Clear skies', 'Overcast', 'Rain', 'Snow', 'Storm'].sort());
});
test('timestamps before the epoch remain deterministic and malformed times are rejected', () => {
  assert.equal(environmentAt(worldEpoch - 1).season, 'Winter');
  assert.equal(environmentAt(worldEpoch - 1).minuteOfDay, 1439);
  for (const time of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => environmentAt(time), /timestamp/);
});
test('cosmetic clock uses only server time and elapsed monotonic time and freezes after 90 seconds', () => {
  assert.equal(displayServerTime(worldEpoch, 1234.9), worldEpoch + 1234);
  assert.equal(displayServerTime(worldEpoch, -100), worldEpoch);
  assert.equal(displayServerTime(worldEpoch, 35000), worldEpoch + 35000);
  assert.equal(displayServerTime(worldEpoch, 90000), worldEpoch + 90000);
  assert.equal(displayServerTime(worldEpoch, 86400000), worldEpoch + 90000);
});
test('development interpolates the same server clock twentyfold and retains the real-time stale limit', () => {
  assert.equal(displayServerTime(worldEpoch, 1234.9, 20), worldEpoch + 24698);
  assert.equal(displayServerTime(worldEpoch, -100, 20), worldEpoch);
  assert.equal(displayServerTime(worldEpoch, 35000, 20), worldEpoch + 700000);
  assert.equal(displayServerTime(worldEpoch, 90000, 20), worldEpoch + 1800000);
  assert.equal(displayServerTime(worldEpoch, 86400000, 20), worldEpoch + 1800000);
  assert.equal(worldDayMs / 20, 72000);
  assert.equal(worldWeekMs / 20, 504000);
});
