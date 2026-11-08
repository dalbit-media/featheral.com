export function watchWorldIdentity(
  target: EventTarget,
  account: string,
  reload: () => void,
  setup: () => void,
): () => void {
  let changing = false;
  const changed = (event: Event): void => {
    if (!(event instanceof CustomEvent) || !event.detail || changing) return;
    const next = event.detail as { account?: unknown; complete?: unknown };
    if (typeof next.account === 'string' && next.account.toLowerCase() === account.toLowerCase() && next.complete === true) return;
    changing = true;
    if (typeof next.account === 'string' && next.complete === true) reload();
    else setup();
  };
  target.addEventListener('featheral:world-session', changed);
  return () => target.removeEventListener('featheral:world-session', changed);
}
