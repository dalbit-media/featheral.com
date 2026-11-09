import type { Command } from './api-types.ts';

export const actionThrottleMs = 2000;
export type TimedAction = 'investigate' | 'warehouse' | 'upgrade' | 'item-storage'
  | 'refine-equipment'
  | `craft:${string}` | `building:${string}`;
export type ActionReadyAt = Partial<Record<TimedAction, number>>;
export function timedActionKey(command: Command): TimedAction | null {
  if (command.type === 'refine-equipment') return 'refine-equipment';
  if (command.type === 'max-upgrade') return timedActionKey(command.target);
  if (command.type === 'dispatch-squad') return 'investigate';
  if (command.type === 'craft') return `craft:${command.item}`;
  if (command.type === 'construction') return `building:${command.kind}`;
  if (command.type === 'build') return `building:${command.kind === 'trade-hub' ? 'logistics' : command.kind}`;
  return command.type === 'investigate' || command.type === 'warehouse' || command.type === 'upgrade' || command.type === 'item-storage' ? command.type : null;
}
export function actionRemaining(readyAt: ActionReadyAt | undefined, action: TimedAction, now: number): number {
  return Math.max(0, (readyAt?.[action] ?? 0) - now);
}
export function renderActionControls(root: ParentNode, readyAt: ActionReadyAt | undefined, pending: TimedAction | null, now: number, workingLabel: string): void {
  root.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach(button => {
    const { action: type, item, construction, facility } = button.dataset;
    const action: TimedAction | null = type === 'craft' && item ? `craft:${item}`
      : type === 'construction' && construction ? `building:${construction}`
        : (type === 'water-facility' || type === 'income-facility') && facility ? `building:${facility === 'trade-hub' ? 'logistics' : facility}`
          : type === 'bank' || type === 'townhall' ? `building:${type}`
            : type === 'dispatch-squad' ? 'investigate'
              : type === 'refine-equipment' ? 'refine-equipment'
              : type === 'investigate' || type === 'warehouse' || type === 'upgrade' || type === 'item-storage' ? type : null;
    if (!action) return;
    button.dataset.actionEligible ??= String(!button.disabled);
    const remaining = actionRemaining(readyAt, action, now);
    const working = pending === action;
    button.disabled = button.dataset.actionEligible !== 'true' || working || remaining > 0;
    button.setAttribute('aria-busy', String(working || remaining > 0));
    button.classList.toggle('action-working', working);
    button.classList.toggle('action-cooling', remaining > 0);
    button.style.setProperty('--action-progress', String(Math.min(1, remaining / actionThrottleMs)));
    let feedback = button.querySelector<HTMLElement>('.action-feedback');
    if (!feedback) {
      feedback = button.ownerDocument.createElement('span');
      feedback.className = 'action-feedback';
      feedback.setAttribute('role', 'status');
      button.append(feedback);
    }
    feedback.textContent = working ? workingLabel : remaining ? `${(remaining / 1000).toFixed(1)}s` : '';
  });
}
