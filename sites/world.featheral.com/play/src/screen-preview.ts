const widthFeature = /^\(\s*(min|max)-width\s*:\s*([\d.]+)px\s*\)$/i;

// Returns whether a media query list matches at the simulated width, or null when it has no width feature we can simulate.
export function mediaMatchesWidth(media: string, width: number, matches: (query: string) => boolean): boolean | null {
  const queries = media.split(',').map(query => query.trim()).filter(Boolean);
  if (!queries.some(query => /\bwidth\b/i.test(query))) return null;
  let result = false;
  for (const query of queries) {
    if (/^(not|only)\b/i.test(query)) return null;
    let queryMatches = true;
    for (const part of query.split(/\s+and\s+/i).map(value => value.trim())) {
      const feature = widthFeature.exec(part);
      if (feature) queryMatches &&= feature[1].toLowerCase() === 'min' ? width >= Number(feature[2]) : width <= Number(feature[2]);
      else if (/\bwidth\b/i.test(part)) return null;
      else queryMatches &&= matches(part);
    }
    result ||= queryMatches;
  }
  return result;
}

export class ScreenPreview {
  private readonly original = new Map<CSSMediaRule, string>();
  private readonly observer = new MutationObserver(records => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (node instanceof HTMLLinkElement) node.addEventListener('load', () => this.refresh(), { once: true });
      }
    }
    this.refresh();
  });
  private width: number | null = null;

  get active(): boolean {
    return this.width !== null;
  }

  set(width: number | null): void {
    this.width = width;
    const root = document.documentElement;
    if (width === null) {
      this.observer.disconnect();
      delete root.dataset.screenPreview;
      root.style.removeProperty('--screen-preview-width');
    } else {
      this.observer.observe(document.head, { childList: true });
      root.dataset.screenPreview = '';
      root.style.setProperty('--screen-preview-width', `${width}px`);
    }
    this.refresh();
  }

  private refresh(): void {
    for (const [rule, media] of this.original) rule.media.mediaText = media;
    this.original.clear();
    if (this.width !== null) {
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          this.simulate(sheet.cssRules, this.width);
        } catch {
          // Cross-origin stylesheets cannot be inspected and keep their real media queries.
        }
      }
    }
    window.dispatchEvent(new Event('resize'));
  }

  private simulate(rules: CSSRuleList, width: number): void {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSMediaRule) {
        const media = rule.media.mediaText;
        const result = mediaMatchesWidth(media, width, query => matchMedia(query).matches);
        if (result !== null) {
          this.original.set(rule, media);
          rule.media.mediaText = result ? 'all' : 'not all';
        }
      }
      if ('cssRules' in rule) this.simulate((rule as CSSGroupingRule).cssRules, width);
    }
  }
}
