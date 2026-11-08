export const actionThrottleMs = 2000;
export type TimedAction = 'craft' | 'investigate';
export type ActionReadyAt = Partial<Record<TimedAction, number>>;
export function isTimedAction(value: string): value is TimedAction {
  return value === 'craft' || value === 'investigate';
}
export function actionRemaining(readyAt: ActionReadyAt | undefined, action: TimedAction, now: number): number {
  return Math.max(0, (readyAt?.[action] ?? 0) - now);
}
export function renderActionControls(root: ParentNode, readyAt: ActionReadyAt | undefined, pending: TimedAction | null, now: number, workingLabel: string): void {
  root.querySelectorAll<HTMLButtonElement>('button[data-action="craft"],button[data-action="investigate"]').forEach(button => {
    const action = button.dataset.action;
    if (!action || !isTimedAction(action)) return;
    const remaining = actionRemaining(readyAt, action, now);
    const working = pending === action;
    button.disabled = button.dataset.actionEligible !== 'true' || working || remaining > 0;
    button.setAttribute('aria-busy', String(working || remaining > 0));
    button.classList.toggle('action-working', working);
    button.classList.toggle('action-cooling', remaining > 0);
    button.style.setProperty('--action-progress', String(Math.min(1, remaining / actionThrottleMs)));
    const feedback = button.querySelector<HTMLElement>('.action-feedback');
    if (feedback) feedback.textContent = working ? workingLabel : remaining ? `${(remaining / 1000).toFixed(1)}s` : '';
  });
}
