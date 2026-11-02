import { Marked, Renderer } from 'marked';
import type { Language } from './i18n.ts';

const attribute = (text: string): string => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function renderWhitepaper(source: string, language: Language): string {
  const chapters: string[] = [];
  const renderer = new Renderer();
  renderer.heading = function ({ tokens, depth, text }) {
    const content = this.parser.parseInline(tokens);
    const chapter = depth === 2 ? /^(\d+)\./.exec(text) : null;
    if (chapter) chapters.push(`<a href="#section-${chapter[1]}">${content}</a>`);
    const id = depth === 1 ? ' id="paper-title"' : chapter ? ` id="section-${chapter[1]}" tabindex="-1"` : '';
    return `<h${depth}${id}>${content}</h${depth}>\n`;
  };
  renderer.link = function ({ href, title, tokens }) {
    const destination = href === './WHITEPAPER.md' ? '/whitepaper/?lang=en'
      : href === './WHITEPAPER.ko.md' ? '/whitepaper/?lang=ko' : href;
    return `<a href="${attribute(destination)}"${title ? ` title="${attribute(title)}"` : ''}>${this.parser.parseInline(tokens)}</a>`;
  };
  const table = renderer.table;
  renderer.table = function (token) {
    return `<div class="paper-table" tabindex="0" role="region" aria-label="${language === 'ko' ? '자료 표' : 'Data table'}">${table.call(this, token)}</div>`;
  };
  const content = new Marked({ renderer, gfm: true }).parse(source, { async: false });
  return `<aside class="paper-sidebar" data-no-localize><details open><summary id="paper-contents-title">${language === 'ko' ? '목차' : 'Table of contents'}</summary><nav aria-labelledby="paper-contents-title">${chapters.join('')}</nav></details></aside>
<article class="whitepaper-copy" aria-labelledby="paper-title" data-no-localize>${content}</article>`;
}
