import { chatPing, chatSend, readChat } from './api.ts';
import { chatHistoryLimit, chatMessageLimit, chatProfileChangedEvent, chatProfileSettingsEvent } from './chat.ts';
import type { ChatInfo, ChatMessage, ChatSubmission } from './chat.ts';
import { locale, translate } from './i18n.ts';
import type { Language } from './i18n.ts';
import { localize } from './i18n-dom.ts';

export class Communicate {
  private readonly room?: string;
  private readonly privateRoom: boolean;
  private readonly root: HTMLElement;
  private readonly csrf: () => string;
  private readonly language: Language;
  private info: ChatInfo | null = null;
  private syncedAt = 0;
  private stream: EventSource | null = null;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  private attempt = 0;
  private connected = false;
  private saving = false;
  private readonly profileChanged = (): void => { if (!this.closed) void this.load(); };
  private cooldown = 0;
  private submission: ChatSubmission | null = null;
  private messages = new Map<number, ChatMessage>();
  private nodes = new Map<number, HTMLElement>();
  private unread = 0;
  constructor(root: HTMLElement, csrf: () => string, language: Language, room?: string, title = 'Public chat', privateRoom = false) {
    this.room = room; this.privateRoom = privateRoom;
    this.root = root; this.csrf = csrf; this.language = language;
    root.innerHTML = `<div class="chat-summary"><strong data-chat-title></strong><span data-chat-online></span></div>
      <p class="chat-status" data-chat-status role="status">Connecting to chat...</p>
      <div class="chat-tools"><button class="button" data-chat-reconnect hidden>Reconnect</button><button class="button" data-chat-settings>Profile settings</button><span data-chat-self data-no-localize></span><details class="chat-guidelines"><summary>Chat rules</summary><p class="chat-rules">Public chat · latest 100 messages saved · one message every 3 seconds · one active chat tab per player. Enter to send, Shift+Enter for a new line. Do not share personal information.</p></details></div>
      <div class="chat-messages" data-chat-messages role="log" aria-label="Chat messages" aria-live="off" tabindex="0"><p class="chat-empty">No messages yet. Start the conversation.</p></div>
      <button class="button chat-latest" data-chat-latest hidden>Jump to latest</button>
      <form class="chat-composer" data-chat-composer><label class="sr-only" for="chat-message">Message</label><textarea id="chat-message" data-chat-text rows="2" maxlength="600" placeholder="Send a message to everyone" disabled></textarea><div><span data-chat-count></span><button class="button primary" data-chat-send disabled>Send</button></div></form>`;
    localize(root);
    root.querySelector('[data-chat-title]')!.textContent = translate(title, language);
    root.querySelector('.chat-rules')!.textContent = translate(privateRoom
      ? 'Visitor group chat. Anyone visiting this settlement can join. Not listed in the public inbox. Never share secrets.'
      : 'Public nearby chat. Latest 100 messages saved. One message every 3 seconds. Enter to send; Shift+Enter for a new line.', language);
    this.input.placeholder = translate(privateRoom ? 'Message settlement visitors' : 'Message this public channel', language);
    window.addEventListener(chatProfileChangedEvent, this.profileChanged);
    root.querySelector('[data-chat-settings]')!.addEventListener('click', () => window.dispatchEvent(new Event(chatProfileSettingsEvent)));
    root.querySelector('[data-chat-composer]')!.addEventListener('submit', event => { event.preventDefault(); void this.send(); });
    this.input.addEventListener('input', () => { if (this.submission?.text !== this.input.value) this.submission = null; this.composer(); });
    this.input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        if (!this.root.querySelector<HTMLButtonElement>('[data-chat-send]')!.disabled) this.root.querySelector<HTMLFormElement>('[data-chat-composer]')!.requestSubmit();
      }
    });
    root.querySelector('[data-chat-reconnect]')!.addEventListener('click', () => { void this.load(); });
    root.querySelector('[data-chat-latest]')!.addEventListener('click', () => { this.list.scrollTop = this.list.scrollHeight; this.clearUnread(); });
    this.list.addEventListener('scroll', () => { if (this.atBottom()) this.clearUnread(); });
    this.timer = setInterval(() => this.composer(), 500);
    void this.load();
  }
  private get input(): HTMLTextAreaElement { return this.root.querySelector<HTMLTextAreaElement>('[data-chat-text]')!; }
  private get list(): HTMLElement { return this.root.querySelector<HTMLElement>('[data-chat-messages]')!; }
  private atBottom(): boolean { return this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 48; }
  private status(text: string, error = false): void {
    const status = this.root.querySelector<HTMLElement>('[data-chat-status]')!;
    status.textContent = translate(text, this.language); status.classList.toggle('error', error);
  }
  private presence(online: number, capacity: number): void {
    this.root.querySelector('[data-chat-online]')!.textContent = translate(`${online} / ${capacity} online`, this.language);
  }
  private stop(): void {
    this.connected = false; this.stream?.close(); this.stream = null; clearInterval(this.pingTimer); this.composer();
  }
  private fail(message: string): void {
    if (this.closed) return;
    this.stop(); this.status(message, true);
    this.root.querySelector<HTMLElement>('[data-chat-reconnect]')!.hidden = false;
  }
  private async load(): Promise<void> {
    const attempt = ++this.attempt;
    this.stop(); this.status('Connecting to chat...');
    this.root.querySelector<HTMLElement>('[data-chat-reconnect]')!.hidden = true;
    try {
      const info = await readChat(this.room);
      if (this.closed || attempt !== this.attempt) return;
      this.info = info; this.syncedAt = performance.now(); this.presence(info.online, info.capacity);
      if (!info.profile) { this.root.querySelector('[data-chat-self]')!.textContent = ''; this.status('Use your World profile in the avatar menu to join chat.'); return; }
      this.root.querySelector('[data-chat-self]')!.textContent = info.profile.nickname;
      if (info.online >= info.capacity && !info.connected) { this.fail('Global chat is full (1,000 users). Gameplay is still available. Try again later.'); return; }
      this.connect();
    } catch (error) { if (attempt === this.attempt) this.fail(error instanceof Error ? error.message : 'Connection failed.'); }
  }
  private connect(): void {
    const stream = new EventSource(`/api/chat/events${this.room ? `?room=${encodeURIComponent(this.room)}` : ''}`); this.stream = stream;
    const receive = (name: string, callback: (data: unknown) => void) => stream.addEventListener(name, event => {
      if (this.closed || this.stream !== stream) return;
      try { callback(JSON.parse((event as MessageEvent<string>).data)); }
      catch (error) { console.error('Invalid chat stream response', error); this.fail('Invalid chat response. Reconnect to try again.'); }
    });
    receive('welcome', data => {
      const welcome = data as ChatInfo;
      if (!welcome.profile || !Number.isSafeInteger(welcome.serverTime) || !Number.isInteger(welcome.online)) throw new Error('Invalid welcome');
      this.info = { ...welcome, connected: true }; this.syncedAt = performance.now(); this.connected = true;
      this.presence(welcome.online, welcome.capacity); this.status(this.privateRoom ? 'Connected · visitor chat' : 'Connected · public chat');
      this.root.querySelector<HTMLElement>('[data-chat-reconnect]')!.hidden = true;
      this.pingTimer = setInterval(() => { void this.ping(stream); }, 20000);
      this.composer();
    });
    const batch = (data: unknown, reset: boolean) => {
      if (!Array.isArray(data) || data.length > chatHistoryLimit || data.some(message => !message || !Number.isSafeInteger(message.id)
        || typeof message.author !== 'string' || typeof message.nickname !== 'string' || typeof message.text !== 'string' || !Number.isSafeInteger(message.time))) throw new Error('Invalid messages');
      this.paint(data as ChatMessage[], reset);
    };
    receive('history', data => batch(data, true));
    receive('messages', data => batch(data, false));
    receive('presence', data => {
      const presence = data as { online: number; capacity: number };
      if (!Number.isInteger(presence.online) || !Number.isInteger(presence.capacity)) throw new Error('Invalid presence');
      this.presence(presence.online, presence.capacity);
    });
    receive('replaced', () => this.fail('Chat opened in another tab. Reconnect here to switch back.'));
    receive('expired', () => this.fail('Chat connection expired. Reconnect to continue.'));
    stream.onerror = () => {
      if (this.stream !== stream || this.closed) return;
      this.fail('Chat connection lost. Reconnect to try again.');
      void readChat(this.room).then(info => {
        if (!this.closed && !this.stream && info.online >= info.capacity && !info.connected)
          this.status('Global chat is full (1,000 users). Gameplay is still available. Try again later.', true);
      }).catch(error => { if (!this.closed && !this.stream) this.status(error instanceof Error ? error.message : 'Connection failed.', true); });
    };
  }
  private async ping(stream: EventSource): Promise<void> {
    try { const presence = await chatPing(this.csrf()); if (this.stream === stream) this.presence(presence.online, presence.capacity); }
    catch (error) { if (this.stream === stream) this.fail(error instanceof Error ? error.message : 'Connection failed.'); }
  }
  private composer(): void {
    if (this.closed) return;
    const length = [...this.input.value].length;
    this.root.querySelector('[data-chat-count]')!.textContent = `${length} / ${chatMessageLimit}`;
    this.input.disabled = !this.connected || this.saving;
    const button = this.root.querySelector<HTMLButtonElement>('[data-chat-send]')!;
    button.disabled = !this.connected || this.saving || !this.input.value.trim() || length > chatMessageLimit || performance.now() < this.cooldown;
    button.textContent = translate(this.saving ? 'Sending...' : 'Send', this.language);
  }
  private async send(): Promise<void> {
    if (!this.connected || this.saving || !this.info || !this.input.value.trim() || [...this.input.value].length > chatMessageLimit || performance.now() < this.cooldown) return;
    const text = this.input.value;
    this.submission ??= { id: crypto.randomUUID(), text, createdAt: Math.floor(this.info.serverTime + performance.now() - this.syncedAt) };
    this.saving = true; this.composer();
    try {
      const message = await chatSend(this.csrf(), this.submission, this.room);
      if (this.closed) return;
      this.paint([message], false); this.input.value = ''; this.submission = null;
      this.cooldown = performance.now() + 3000; this.status(this.privateRoom ? 'Connected · visitor chat' : 'Connected · public chat');
    } catch (error) { if (!this.closed) this.status(error instanceof Error ? error.message : 'The action could not be completed.', true); }
    finally { this.saving = false; this.composer(); if (!this.closed && this.connected) this.input.focus({ preventScroll: true }); }
  }
  private paint(batch: ChatMessage[], reset: boolean): void {
    const bottom = this.atBottom(), anchor = [...this.list.children].find(node => node.getBoundingClientRect().bottom >= this.list.getBoundingClientRect().top);
    const anchorTop = anchor?.getBoundingClientRect().top ?? 0;
    if (reset) { this.messages.clear(); this.nodes.clear(); this.clearUnread(); }
    let added = 0;
    for (const message of batch) { if (!this.messages.has(message.id)) added++; this.messages.set(message.id, message); }
    const messages = [...this.messages.values()].sort((a, b) => a.id - b.id).slice(-chatHistoryLimit), retained = new Set(messages.map(message => message.id));
    for (const id of this.messages.keys()) if (!retained.has(id)) { this.messages.delete(id); this.nodes.delete(id); }
    const fragment = document.createDocumentFragment();
    for (const message of messages) {
      let node = this.nodes.get(message.id);
      if (!node) {
        node = document.createElement('article'); node.className = 'chat-message'; node.dataset.chatMessage = String(message.id); node.dataset.noLocalize = '';
        node.classList.toggle('own', message.author === this.info?.profile?.id);
        const header = document.createElement('header'), author = document.createElement('strong'), time = document.createElement('time'), text = document.createElement('p');
        author.textContent = message.nickname; time.dateTime = new Date(message.time).toISOString();
        time.textContent = `${new Date(message.time).toLocaleTimeString(locale(this.language), { timeZone: 'UTC', hour12: false })} UTC`;
        text.textContent = message.text; header.append(author, time); node.append(header, text); this.nodes.set(message.id, node);
      }
      fragment.append(node);
    }
    if (!messages.length) { const empty = document.createElement('p'); empty.className = 'chat-empty'; empty.textContent = translate('No messages yet. Start the conversation.', this.language); fragment.append(empty); }
    this.list.replaceChildren(fragment);
    if (bottom || reset) this.list.scrollTop = this.list.scrollHeight;
    else {
      if (anchor?.isConnected) this.list.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
      this.unread += added;
      const latest = this.root.querySelector<HTMLButtonElement>('[data-chat-latest]')!;
      latest.hidden = !this.unread; latest.textContent = translate(`Jump to latest (${this.unread})`, this.language);
    }
  }
  private clearUnread(): void { this.unread = 0; this.root.querySelector<HTMLElement>('[data-chat-latest]')!.hidden = true; }
  close(): void { this.attempt++; this.stop(); this.closed = true; clearInterval(this.timer); window.removeEventListener(chatProfileChangedEvent, this.profileChanged); }
}
