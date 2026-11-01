import type { DayPhase, Environment, Season } from './environment.ts';
import { worldDayMs, worldEpoch, worldWeeksPerYear } from './environment.ts';
import { icon } from './icons.ts';

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
  const time = root.querySelector('.clock-game-time>span')!;
  const text = `${String(Math.floor(minuteOfDay / 60)).padStart(2, '0')}:${String(Math.floor(minuteOfDay % 60)).padStart(2, '0')}`;
  if (time.textContent !== text) time.textContent = text;
  const week = root.querySelector<HTMLElement>('.clock-week')!;
  const progress = minuteOfDay / 1440;
  const currentDay = week.querySelector<HTMLElement>('.clock-day.current')!;
  currentDay.querySelector<HTMLElement>('.clock-day-fill')!.style.setProperty('--day-progress', `${Number((progress * 100).toFixed(6))}%`);
  week.setAttribute('aria-valuenow', String(Number((Number(week.dataset.dayOfWeek) - 1 + progress).toFixed(4))));
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
    return `<span class="clock-day${index === dayOfWeek - 1 ? ' current' : ''}" title="${name}" aria-hidden="true"><span class="clock-day-fill" style="--day-progress:${Number(dayProgress.toFixed(6))}%"></span></span>`;
  }).join('');
  return `<span class="clock-calendar"><span>Year ${year.toLocaleString('en-US')}</span><span class="clock-week-label">Week ${weekOfYear}<small> / ${worldWeeksPerYear}</small></span><span class="clock-current-day" title="${dayName}">${dayLabel}</span></span>
    <span class="clock-game-time" title="${phase}">${dayPhaseIcon(phase)}<span>${hour}:${minute}</span><small class="clock-current-season">${season}</small></span>
    <span class="clock-week" data-day-of-week="${dayOfWeek}" role="progressbar" aria-label="Week progress" aria-valuemin="0" aria-valuemax="7" aria-valuenow="${Number(progress.toFixed(4))}" aria-valuetext="${description}" title="${description}">${days}</span>
    <span class="clock-seasons" role="progressbar" aria-label="Season progress" aria-valuemin="0" aria-valuemax="4" aria-valuenow="${Number(seasonProgress.toFixed(6))}" aria-valuetext="${seasonDescription}" title="${seasonDescription}">${Object.entries(seasonIcons).map(([name, symbol], index) =>
      `<span class="clock-season clock-season-${name.toLowerCase()}${index < seasonIndex ? ' complete' : index === seasonIndex ? ' current' : ''}" aria-hidden="true" title="${name}" style="--season-progress:${index < seasonIndex ? 100 : index === seasonIndex ? Number(((seasonProgress - seasonIndex) * 100).toFixed(4)) : 0}%">${icon(symbol, 'season-icon')}<span>${name}</span></span>`).join('')}</span>`;
}
export function updateWeekCalendar(root: HTMLElement, environment: Environment,
  serverTime = worldEpoch + (environment.day - 1) * worldDayMs + environment.minuteOfDay * 1000): void {
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
    });
  }
  updateClockTime(root, serverTime);
}
export function environmentDetails(environment: Environment): string {
  const { season, phase, weather, daylight, temperature } = environment;
  const weatherIcon = weather === 'Clear skies' ? daylight < .25 ? 'moon' : 'sun'
    : ({ Overcast: 'cloud', Rain: 'rain', Snow: 'snow', Storm: 'storm' } as const)[weather];
  return `<div class="map-environment-calendar"><span class="map-season">${icon(seasonIcons[season], 'season-icon')}<span>${season}</span></span><span class="map-phase">${dayPhaseIcon(phase)}<span>${phase}</span></span></div>
    <div class="map-environment-weather" aria-label="Simulated world weather">${icon(weatherIcon)}<span>${weather}</span><strong>${temperature}°C</strong></div>`;
}
