import { collectionDurations, collectionItems, isCollectionItem } from './collection.ts';
import type { CollectionItem } from './collection.ts';

export const activityKinds = ['exploration', 'attraction'] as const;
export type ActivityKind = typeof activityKinds[number];
export type ActivityItem = `activity-${ActivityKind}-${typeof collectionDurations[number]}`;
export type AutomationItem = CollectionItem | ActivityItem;
export const activityItems = activityKinds.flatMap(kind =>
  collectionDurations.map(weeks => `activity-${kind}-${weeks}` as const));
export const automationItems = [...collectionItems, ...activityItems];
export function isActivityItem(value: unknown): value is ActivityItem {
  return typeof value === 'string' && activityItems.some(item => item === value);
}
export function isActivityKind(value: unknown): value is ActivityKind {
  return activityKinds.some(kind => kind === value);
}
export function isAutomationItem(value: unknown): value is AutomationItem {
  return isCollectionItem(value) || isActivityItem(value);
}
export function activityItemDetails(item: ActivityItem): { activity: ActivityKind; weeks: number } {
  const [, activity, weeks] = item.split('-');
  return { activity: activity as ActivityKind, weeks: Number(weeks) };
}
export function activityName(activity: ActivityKind): string {
  return activity === 'exploration' ? 'Auto-exploration' : 'Auto-recruitment';
}
export function activityItemName(item: ActivityItem): string {
  const { activity, weeks } = activityItemDetails(item);
  return `${activityName(activity)} · ${weeks} game ${weeks === 1 ? 'week' : 'weeks'}`;
}
