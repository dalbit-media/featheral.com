export function createCountUp(render: (value: number) => void) {
  let displayed: number | undefined;
  let target = 0;
  let frame: number | undefined;
  function paint(value: number): void {
    if (displayed === value) return;
    displayed = value;
    render(value);
  }
  function cancel(): void {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
  }
  function finish(): void {
    cancel();
    if (displayed !== undefined) paint(target);
  }
  function set(next: number, animate: boolean): void {
    if (displayed !== undefined && next === target) {
      if (!animate) finish();
      return;
    }
    cancel();
    const first = displayed === undefined;
    const from = displayed ?? 0;
    target = next;
    if (!animate || from === target) {
      paint(target);
      return;
    }
    const started = performance.now();
    const duration = first ? 2200 : 1400;
    paint(from);
    function step(now: number): void {
      frame = undefined;
      const progress = Math.min(1, Math.max(0, (now - started) / duration));
      const eased = 1 - (1 - progress) ** 3;
      paint(progress === 1 ? target : Math.round(from + (target - from) * eased));
      if (progress < 1) frame = requestAnimationFrame(step);
    }
    frame = requestAnimationFrame(step);
  }
  return { set, finish };
}
