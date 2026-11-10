export const publicSite = {
  url: '',
  channels: {
    github: '',
    discord: '',
    x: '',
    telegram: '',
  },
};

export function formatPublicTotal(value: number, locale: string, fullText = value.toLocaleString(locale)): string {
  return value < 10000 ? fullText
    : new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 3 }).format(value);
}

export function resolvePublicSite(config = publicSite): typeof publicSite {
  const https = (value: string, label: string): string => {
    if (!value) return '';
    if (!URL.canParse(value)) throw new Error(`${label} must be a valid HTTPS URL or empty.`);
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error(`${label} must use HTTPS without embedded credentials.`);
    return url.href;
  };
  const resolved = { url: https(config.url, 'Public site'), channels: { ...config.channels } };
  if (resolved.url) {
    const url = new URL(resolved.url);
    if (url.pathname !== '/' || url.search || url.hash) throw new Error('Public site must be a root origin, without a path, query, or fragment.');
    resolved.url = url.origin;
  }
  for (const channel of ['github', 'discord', 'x', 'telegram'] as const) {
    resolved.channels[channel] = https(config.channels[channel], channel);
  }
  return resolved;
}
