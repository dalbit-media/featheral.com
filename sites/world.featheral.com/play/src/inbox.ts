import { readChatDirectory, readVisitedSettlement, visitSettlement } from './api.ts';
import { chatProfileChangedEvent } from './chat.ts';
import type { ChatDirectory, ChatRoom } from './chat.ts';
import { Communicate } from './communicate.ts';
import { locale, translate } from './i18n.ts';
import type { Language } from './i18n.ts';
import { localize } from './i18n-dom.ts';

export class Inbox {
  private readonly root: HTMLElement;
  private readonly csrf: () => string;
  private readonly language: Language;
  private readonly contacts: boolean;
  private readonly compact: boolean;
  private rooms: ChatRoom[] = [];
  private chat: Communicate | null = null;
  private selected: string | null = null;
  private closed = false;
  private loading = false;
  private timer: ReturnType<typeof setInterval>;
  private readonly drafts = new Map<string, string>();
  private readonly profileChanged = (): void => { void this.load(); };
  constructor(root: HTMLElement, csrf: () => string, language: Language, contacts = false, compact = false) {
    this.root = root; this.csrf = csrf; this.language = language; this.contacts = contacts;
    this.compact = compact;
    root.innerHTML = compact
      ? '<label class="dock-channel"><span>Public channel</span><select data-inbox-select aria-label="Public channel"></select></label><p data-inbox-status role="status" hidden></p><section class="chat-page"><div data-communicate></div></section>'
      : '<div class="inbox-layout"><aside class="inbox-directory"><h2>Nearby settlements</h2><p class="fineprint">Public channels within your current exploration radius and their federations.</p><button class="button" data-inbox-refresh>Refresh contacts</button><p data-inbox-status role="status"></p><div data-inbox-rooms></div></aside><section class="chat-page page-card"><div data-communicate></div></section></div>';
    localize(root);
    window.addEventListener(chatProfileChangedEvent, this.profileChanged);
    root.querySelector('[data-inbox-refresh]')?.addEventListener('click', () => { void this.load(); });
    root.querySelector<HTMLSelectElement>('[data-inbox-select]')?.addEventListener('change', event => {
      const room = this.rooms.find(value => value.id === (event.currentTarget as HTMLSelectElement).value);
      if (room) this.select(room);
    });
    this.timer = setInterval(() => { void this.load(); }, 15000);
    void this.load();
  }
  private status(message: string): void {
    const status = this.root.querySelector<HTMLElement>('[data-inbox-status]')!;
    status.textContent = translate(message, this.language); status.hidden = !message;
  }
  private label(room: ChatRoom): string {
    return `${translate(room.kind === 'federation' ? 'Federation chat' : 'Explore chat', this.language)} · ${this.name(room.name)}`;
  }
  private select(room: ChatRoom): void {
    const chatRoot = this.root.querySelector<HTMLElement>('[data-communicate]')!;
    if (room.id === this.selected && this.chat) {
      chatRoot.querySelector('[data-chat-title]')!.textContent = this.label(room);
      return;
    }
    if (this.selected) this.drafts.set(this.selected, chatRoot.querySelector<HTMLTextAreaElement>('[data-chat-text]')?.value ?? '');
    this.chat?.close(); this.selected = room.id;
    this.chat = new Communicate(chatRoot, this.csrf, this.language, room.id);
    chatRoot.querySelector('[data-chat-title]')!.textContent = this.label(room);
    const input = chatRoot.querySelector<HTMLTextAreaElement>('[data-chat-text]')!;
    input.value = this.drafts.get(room.id) ?? ''; input.dispatchEvent(new Event('input'));
    this.root.querySelectorAll<HTMLButtonElement>('[data-inbox-room]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.inboxRoom === room.id)));
    const selector = this.root.querySelector<HTMLSelectElement>('[data-inbox-select]');
    if (selector) selector.value = room.id;
  }
  private render(directory: ChatDirectory): void {
    this.rooms = directory.rooms;
    const list = this.root.querySelector('[data-inbox-rooms]') ?? this.root.querySelector('[data-inbox-select]')!;
    list.replaceChildren();
    for (const room of directory.rooms) {
      if (this.compact) {
        const option = document.createElement('option'); option.value = room.id; option.textContent = this.label(room);
        list.append(option);
        continue;
      }
      const card = document.createElement('div'); card.className = 'inbox-contact';
      const button = document.createElement('button'); button.className = 'button';
      button.dataset.inboxRoom = room.id; button.setAttribute('aria-pressed', String(this.selected === room.id));
      button.textContent = this.label(room);
      button.addEventListener('click', () => this.select(room)); card.append(button);
      const settlement = directory.settlements.find(value => value.id === room.settlement);
      if (settlement) {
        const detail = document.createElement('small');
        detail.textContent = `${settlement.x}, ${settlement.y} · ${settlement.population.toLocaleString(locale(this.language))} ${translate('residents', this.language)}`;
        const visit = document.createElement('button'); visit.className = 'button';
        visit.textContent = translate('Visit settlement', this.language);
        visit.addEventListener('click', async () => {
          visit.disabled = true;
          try { await visitSettlement(this.csrf(), settlement.id); if (!this.closed) location.assign(`/play/settlement/?visit=${encodeURIComponent(settlement.id)}`); }
          catch (error) { this.status(error instanceof Error ? error.message : 'The action could not be completed.'); visit.disabled = false; }
        });
        card.append(detail, visit);
      }
      list.append(card);
    }
    const preferred = new URL(location.href).searchParams.get('room');
    const room = directory.rooms.find(value => value.id === this.selected)
      ?? directory.rooms.find(value => value.id === preferred)
      ?? directory.rooms.find(value => value.kind === 'explore' && value.settlement === directory.ownSettlement)
      ?? directory.rooms[0];
    if (!room) {
      this.chat?.close(); this.chat = null; this.selected = null;
      this.root.querySelector('[data-communicate]')!.textContent = translate('No nearby public chats yet. Establish a settlement or explore closer to another settlement.', this.language);
    } else this.select(room);
    const selector = this.root.querySelector<HTMLSelectElement>('[data-inbox-select]');
    if (selector) { selector.value = room?.id ?? ''; selector.disabled = !room; }
    this.status(this.compact ? '' : this.contacts ? 'Choose a public channel or visit a settlement for its visitor chat.' : 'Private visitor chats are available only on settlement pages.');
  }
  private async load(): Promise<void> {
    if (this.loading || this.closed) return;
    this.loading = true;
    try { const directory = await readChatDirectory(); if (!this.closed) this.render(directory); }
    catch (error) { if (!this.closed) this.status(error instanceof Error ? error.message : 'Connection failed.'); }
    finally { this.loading = false; }
  }
  private name(name: string): string { return name === 'Unnamed settlement' ? translate(name, this.language) : name; }
  close(): void {
    if (this.selected) this.drafts.set(this.selected, this.root.querySelector<HTMLTextAreaElement>('[data-chat-text]')?.value ?? '');
    this.closed = true; clearInterval(this.timer); this.chat?.close(); this.chat = null;
    window.removeEventListener(chatProfileChangedEvent, this.profileChanged);
  }
  resume(): void {
    if (!this.closed) return;
    this.closed = false;
    window.addEventListener(chatProfileChangedEvent, this.profileChanged);
    this.timer = setInterval(() => { void this.load(); }, 15000);
    void this.load();
  }
}

export class SettlementChat {
  private readonly root: HTMLElement;
  private readonly language: Language;
  private chat: Communicate | null = null;
  private closed = false;
  private readonly profileChanged: () => void;
  constructor(root: HTMLElement, csrf: () => string, language: Language, settlement?: string) {
    this.root = root; this.language = language;
    this.profileChanged = () => { void this.load(csrf, settlement); };
    window.addEventListener(chatProfileChangedEvent, this.profileChanged);
    root.innerHTML = '<p data-visitor-status role="status">Loading settlement chat...</p><div data-communicate></div>';
    localize(root);
    void this.load(csrf, settlement);
  }
  private async load(csrf: () => string, settlement?: string): Promise<void> {
    try {
      const id = settlement ?? (await readChatDirectory()).ownSettlement;
      if (!id) throw new Error('Establish a settlement to open visitor chat.');
      if (settlement) await visitSettlement(csrf(), id);
      const target = await readVisitedSettlement(id);
      if (this.closed) return;
      this.root.querySelector('[data-visitor-status]')!.textContent = `${target.name === 'Unnamed settlement' ? translate(target.name, this.language) : target.name} · ${target.x}, ${target.y} · ${target.population.toLocaleString(locale(this.language))} ${translate('residents', this.language)}`;
      if (!this.chat) this.chat = new Communicate(this.root.querySelector<HTMLElement>('[data-communicate]')!, csrf, this.language, id, 'Settlement visitor chat', true);
    } catch (error) {
      if (!this.closed) this.root.querySelector('[data-visitor-status]')!.textContent = translate(error instanceof Error ? error.message : 'Connection failed.', this.language);
    }
  }
  close(): void { this.closed = true; this.chat?.close(); window.removeEventListener(chatProfileChangedEvent, this.profileChanged); }
}
