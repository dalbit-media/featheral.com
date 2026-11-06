import type { DayPhase, Environment, Season } from './environment.ts';
import { environmentAt, worldDayMs, worldEpoch, worldWeeksPerYear, worldYearMs, seasonMs } from './environment.ts';
import { icon } from './icons.ts';
import { productionClimate, recruitmentClimate, waterDemandClimate } from './climate.ts';

const seasonIcons: Record<Season, string> = { Spring: 'flower', Summer: 'sun', Autumn: 'leaf', Winter: 'snowflake' };
const phaseIcons: Record<DayPhase, string> = { Dawn: 'sunrise', Day: 'sun', Dusk: 'sunset', Night: 'moon' };
const weekDays = [
  ['Monday', 'Mo'], ['Tuesday', 'Tu'], ['Wednesday', 'We'], ['Thursday', 'Th'],
  ['Friday', 'Fr'], ['Saturday', 'Sa'], ['Sunday', 'Su'],
] as const;

export function compactServerCountdown(remaining: number): string {
  const seconds = Math.max(0, Math.ceil(remaining));
  const minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60);
  const clock = `${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  return hours ? `${hours}:${clock}` : clock;
}
export function completionProgress(startedAt: number, readyAt: number, serverTime: number) {
  const duration = Math.max(1, readyAt - startedAt);
  const percent = Math.max(0, Math.min(100, (serverTime - startedAt) / duration * 100));
  const minutes = Math.ceil(Math.max(0, readyAt - serverTime) / (worldDayMs / 1440));
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60);
  const countdown = !minutes ? 'Awaiting server confirmation' : days ? `${days}d ${hours}h`
    : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
  return { percent, countdown };
}
export function dayPhaseIcon(phase: DayPhase): string {
  return icon(phaseIcons[phase], 'phase-icon');
}
function clockMinuteOfDay(serverTime: number): number {
  if (!Number.isSafeInteger(serverTime) || serverTime < 0) throw new RangeError('Invalid server timestamp.');
  const elapsed = serverTime - worldEpoch;
  return ((elapsed % worldDayMs + worldDayMs) % worldDayMs) / 1000;
}
export function updateClockTime(root: HTMLElement, serverTime: number): void {
  const minuteOfDay = clockMinuteOfDay(serverTime);
  const dayOfWeek = ((Math.floor((serverTime - worldEpoch) / worldDayMs) % 7 + 7) % 7) + 1;
  if (Number(root.querySelector<HTMLElement>('.clock-week')!.dataset.dayOfWeek) !== dayOfWeek) {
    updateWeekCalendar(root, environmentAt(serverTime), serverTime);
    return;
  }
  const time = root.querySelector('.clock-game-time>span')!;
  const text = `${String(Math.floor(minuteOfDay / 60)).padStart(2, '0')}:${String(Math.floor(minuteOfDay % 60)).padStart(2, '0')}`;
  if (time.textContent !== text) time.textContent = text;
  const week = root.querySelector<HTMLElement>('.clock-week')!;
  const progress = minuteOfDay / 1440;
  const currentDay = week.querySelector<HTMLElement>('.clock-day.current')!;
  currentDay.querySelector<HTMLElement>('.clock-day-fill')!.style.setProperty('--day-scale', String(progress));
  week.setAttribute('aria-valuenow', String(Number((Number(week.dataset.dayOfWeek) - 1 + progress).toFixed(4))));
  const seasons = root.querySelector<HTMLElement>('.clock-seasons')!;
  const elapsed = serverTime - worldEpoch;
  const yearProgress = ((elapsed % worldYearMs + worldYearMs) % worldYearMs) / seasonMs;
  seasons.querySelector<HTMLElement>('.clock-season.current')!.style.setProperty('--season-scale', String(yearProgress % 1));
  seasons.setAttribute('aria-valuenow', String(Number(yearProgress.toFixed(6))));
}
export function weekCalendar(environment: Environment): string {
  const { year, weekOfYear, dayOfWeek, minuteOfDay, phase, season } = environment;
  const hour = String(Math.floor(minuteOfDay / 60)).padStart(2, '0');
  const minute = String(minuteOfDay % 60).padStart(2, '0');
  const progress = dayOfWeek - 1 + minuteOfDay / 1440;
  const description = `Week ${weekOfYear} of ${worldWeeksPerYear} · Day ${dayOfWeek} of 7`;
  const [dayName, dayLabel] = weekDays[dayOfWeek - 1];
  const weeksPerSeason = worldWeeksPerYear / 4;
  const seasonProgress = (weekOfYear - 1 + progress / 7) / weeksPerSeason;
  const seasonIndex = Math.floor(seasonProgress);
  const seasonDescription = `${season} · Week ${(weekOfYear - 1) % weeksPerSeason + 1} of ${weeksPerSeason}`;
  const days = weekDays.map(([name], index) => {
    const dayProgress = index < dayOfWeek - 1 ? 100 : index === dayOfWeek - 1 ? minuteOfDay / 1440 * 100 : 0;
    return `<span class="clock-day${index === dayOfWeek - 1 ? ' current' : ''}" title="${name}" aria-hidden="true"><span class="clock-day-fill" style="--day-progress:${Number(dayProgress.toFixed(6))}%;--day-scale:${dayProgress / 100}"></span></span>`;
  }).join('');
  return `<span class="clock-calendar"><span>Year ${year.toLocaleString('en-US')}</span><span class="clock-week-label">Week ${weekOfYear}<small> / ${worldWeeksPerYear}</small></span><span class="clock-current-day" title="${dayName}">${dayLabel}</span></span>
    <span class="clock-game-time" title="${phase}">${dayPhaseIcon(phase)}<span>${hour}:${minute}</span><small class="clock-current-season">${season}</small></span>
    <span class="clock-week" data-day-of-week="${dayOfWeek}" role="progressbar" aria-label="Week progress" aria-valuemin="0" aria-valuemax="7" aria-valuenow="${Number(progress.toFixed(4))}" aria-valuetext="${description}" title="${description}">${days}</span>
    <span class="clock-seasons" role="progressbar" aria-label="Season progress" aria-valuemin="0" aria-valuemax="4" aria-valuenow="${Number(seasonProgress.toFixed(6))}" aria-valuetext="${seasonDescription}" title="${seasonDescription}">${Object.entries(seasonIcons).map(([name, symbol], index) =>
      `<span class="clock-season clock-season-${name.toLowerCase()}${index < seasonIndex ? ' complete' : index === seasonIndex ? ' current' : ''}" aria-hidden="true" title="${name}" style="--season-progress:${index < seasonIndex ? 100 : index === seasonIndex ? Number(((seasonProgress - seasonIndex) * 100).toFixed(4)) : 0}%;--season-scale:${index < seasonIndex ? 1 : index === seasonIndex ? seasonProgress - seasonIndex : 0}">${icon(symbol, 'season-icon')}<span>${name}</span></span>`).join('')}</span>`;
}
export function updateWeekCalendar(root: HTMLElement, environment: Environment,
  serverTime = worldEpoch + (environment.day - 1) * worldDayMs + environment.minuteOfDay * 1000): void {
  const calendarKey = `${environment.year}:${environment.weekOfYear}:${environment.dayOfWeek}:${environment.phase}:${environment.season}`;
  if (root.firstElementChild && root.dataset.calendarKey === calendarKey) {
    updateClockTime(root, serverTime);
    return;
  }
  root.dataset.calendarKey = calendarKey;
  if (!root.firstElementChild) {
    root.innerHTML = weekCalendar(environment);
    updateClockTime(root, serverTime);
    return;
  }
  const template = root.ownerDocument.createElement('template');
  template.innerHTML = weekCalendar(environment);
  for (const selector of ['.clock-calendar', '.clock-game-time']) {
    const target = root.querySelector<HTMLElement>(selector)!;
    const next = template.content.querySelector<HTMLElement>(selector)!;
    if (target.innerHTML !== next.innerHTML) target.innerHTML = next.innerHTML;
    target.title = next.title;
  }
  for (const selector of ['.clock-week', '.clock-seasons']) {
    const target = root.querySelector<HTMLElement>(selector)!;
    const next = template.content.querySelector<HTMLElement>(selector)!;
    for (const attribute of ['aria-valuenow', 'aria-valuetext', 'title']) {
      target.setAttribute(attribute, next.getAttribute(attribute)!);
    }
    if (selector === '.clock-week') target.dataset.dayOfWeek = next.dataset.dayOfWeek!;
    const nextSegments = next.querySelectorAll<HTMLElement>(':scope > span');
    target.querySelectorAll<HTMLElement>(':scope > span').forEach((segment, index) => {
      const incoming = nextSegments[index];
      if (segment.className !== incoming.className) segment.className = incoming.className;
      const property = selector === '.clock-week' ? '--day-progress' : '--season-progress';
      if (selector === '.clock-week') {
        segment.querySelector<HTMLElement>('.clock-day-fill')!.style.setProperty(property,
          incoming.querySelector<HTMLElement>('.clock-day-fill')!.style.getPropertyValue(property));
      } else segment.style.setProperty(property, incoming.style.getPropertyValue(property));
      const fill = selector === '.clock-week' ? segment.querySelector<HTMLElement>('.clock-day-fill')! : segment;
      const nextFill = selector === '.clock-week' ? incoming.querySelector<HTMLElement>('.clock-day-fill')! : incoming;
      const scale = selector === '.clock-week' ? '--day-scale' : '--season-scale';
      fill.style.setProperty(scale, nextFill.style.getPropertyValue(scale));
    });
  }
  updateClockTime(root, serverTime);
}
export function environmentDetails(environment: Environment, effects = false): string {
  const { season, phase, weather, daylight, temperature } = environment;
  const weatherIcon = weather === 'Clear skies' ? daylight < .25 ? 'moon' : 'sun'
    : ({ Overcast: 'cloud', Rain: 'rain', Snow: 'snow', Storm: 'storm' } as const)[weather];
  return `<div class="map-environment-calendar"><span class="map-season">${icon(seasonIcons[season], 'season-icon')}<span>${season}</span></span><span class="map-phase">${dayPhaseIcon(phase)}<span>${phase}</span></span></div>
    <div class="map-environment-weather" aria-label="Simulated world weather">${icon(weatherIcon)}<span>${weather}</span><strong>${temperature}°C</strong></div>${effects ? environmentEffects(environment) : ''}`;
}
export function overallWeatherImpact(environment: Environment): 'best' | 'good' | 'bad' | 'worst' {
  const production = (['wood', 'water', 'metal', 'oil'] as const)
    .reduce((sum, resource) => sum + productionClimate(resource, environment) - 1, 0);
  const score = (production + recruitmentClimate(environment) - 1 - (waterDemandClimate(environment) - 1)) / 6;
  return score >= .05 ? 'best' : score >= 0 ? 'good' : score > -.25 ? 'bad' : 'worst';
}
export function environmentEffects(environment: Environment): string {
  const change = (factor: number, demand = false): string => {
    const value = Math.round((factor - 1) * 100);
    const tone = value === 0 ? 'neutral' : (value > 0) !== demand ? 'benefit' : 'penalty';
    return `<strong class="climate-${tone}" data-no-localize>${value > 0 ? '+' : ''}${value}%</strong>`;
  };
  const impact = overallWeatherImpact(environment);
  const label = { best: 'Best overall conditions', good: 'Good overall conditions', bad: 'Bad overall conditions', worst: 'Worst overall conditions' }[impact];
  const symbol = { best: 'spark', good: 'check', bad: 'minus', worst: 'close' }[impact];
  return `<details class="weather-effects"><summary class="weather-impact weather-impact-${impact}" aria-label="${label}" title="${label}">${icon(symbol)}</summary><p><strong>Expected effects</strong></p><p>Season, weather and temperature compared with normal conditions:</p><dl>
    ${(['wood', 'water', 'metal', 'oil'] as const).map(resource => `<div><dt>${{ wood: 'Wood production', water: 'Water production', metal: 'Metal production', oil: 'Oil production' }[resource]}</dt><dd>${change(productionClimate(resource, environment))}</dd></div>`).join('')}
    <div><dt>Recruitment suitability</dt><dd>${change(recruitmentClimate(environment))}</dd></div>
    <div><dt>Water demand</dt><dd>${change(waterDemandClimate(environment), true)}</dd></div></dl>
    <p>Overall indicator averages four production modifiers and recruitment suitability, with higher water demand counted as a penalty.</p>
    <p>Current-condition estimates. Actual production and recruitment use daily averages; expedition finds use weekly averages.</p></details>`;
}
