"use strict";

// Featheral World: a wallet-signed social network. Every action is a message signed by the wallet (or a
// short-lived session key the wallet delegated once) and recorded on the World communication ledger.
(() => {
  const API = "/api/v1/world";
  const MAX_TEXT = 280;
  const SESSION_DAYS = 6;
  const $ = (id) => document.getElementById(id);
  const column = $("feed");
  const state = { account: "", profile: null, session: null, route: "", renderId: 0, cursor: 0, topId: "", suspended: false };
  const drafts = new Map();
  const EXAMPLE_POSTS = [
    { title: "Say hello to World", text: "Hello, Featheral World! I'm here to meet the community and share what I'm building.", prompt: "Hello, Featheral World! " },
    { title: "Share something you're working on", text: "What are you building, learning or exploring today? Share an update and invite others into the conversation.", prompt: "Today I'm working on " },
    { title: "Start a conversation", text: "What's one idea you'd like to see in Featheral World? A question is a great way to start your first thread.", prompt: "One idea I'd love to see in Featheral World is " },
  ];

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key.startsWith("aria-") || key.startsWith("data-")) node.setAttribute(key, value);
      else node[key] = value;
    }
    node.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
    return node;
  }

  async function api(path, init) {
    const response = await fetch(`${API}${path}`, { cache: "no-store", ...init, headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body.error || `HTTP ${response.status}`), { status: response.status });
    return body;
  }

  let toastTimer;
  function toast(text, error = false) {
    document.querySelector(".toast")?.remove();
    document.body.append(el("div", { className: `toast${error ? " err" : ""}`, textContent: text, role: "status" }));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => document.querySelector(".toast")?.remove(), 3500);
  }

  const short = (address) => `${address.slice(0, 6)}…${address.slice(-4)}`;
  function timeAgo(ms) {
    const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: ms < Date.now() - 31536e6 ? "numeric" : undefined });
  }
  const count = (value) => (value ? Number(value).toLocaleString("en-US") : "");

  const identicons = new Map();
  function identicon(address) {
    const key = address.toLowerCase();
    if (identicons.has(key)) return identicons.get(key);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 80;
    const ctx = canvas.getContext("2d");
    const hex = key.replace(/^0x/, "");
    const hue = parseInt(hex.slice(0, 6), 16) % 360;
    ctx.fillStyle = `hsl(${(hue + 180) % 360} 30% 18%)`;
    ctx.fillRect(0, 0, 80, 80);
    ctx.fillStyle = `hsl(${hue} 65% 58%)`;
    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 3; x += 1) {
        if (parseInt(hex[6 + y * 3 + x], 16) % 2 === 0) {
          ctx.fillRect(8 + x * 13, 8 + y * 13, 13, 13);
          ctx.fillRect(8 + (4 - x) * 13, 8 + y * 13, 13, 13);
        }
      }
    }
    const url = canvas.toDataURL();
    identicons.set(key, url);
    return url;
  }
  const avatarSrc = (profile, address) => profile?.avatar || identicon(address);
  const nameOf = (profile, address) => (profile?.username ? profile.username : short(address));
  const handleOf = (profile, address) => (profile?.username ? `@${profile.username}` : short(address));
  const avatarImg = (profile, address, cls = "") => el("img", { className: `avatar ${cls}`, src: avatarSrc(profile, address), alt: "", width: 44, height: 44, loading: "lazy" });

  /* ------------------------------- signing ------------------------------- */

  // Must stay identical to socialMessage() in services/social-ledger/social.js.
  function socialMessage(kind, d) {
    const lines = ["Featheral World social action", "", `Action: ${kind}`, `Author: ${d.w}`];
    if (kind === "POST") lines.push(`Reply to: ${d.rp || "(none)"}`, `Text: ${JSON.stringify(d.text)}`);
    else if (kind === "SESSION") lines.push(`Session key: ${d.k}`, `Expires: ${new Date(d.exp).toISOString()}`);
    else if (kind === "FOLLOW" || kind === "UNFOLLOW") lines.push(`Account: ${d.u}`);
    else if (kind === "MOD") lines.push(`Moderation: ${d.act}`, `Target: ${d.tg}`);
    else lines.push(`Post: ${d.p}`);
    lines.push(`Nonce: ${d.n}`, `Issued at: ${d.ts}`, "Ledger: Featheral World communication ledger", "", "Signing is free and only authorizes this action on the World ledger.");
    return lines.join("\n");
  }

  const nonce = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const sessionStorageKey = (account) => `featheral.world.session.${account.toLowerCase()}`;

  async function walletSign(account, message) {
    return FeatheralProfile.getProvider().request({ method: "personal_sign", params: [ethers.hexlify(ethers.toUtf8Bytes(message)), account] });
  }

  async function submit(wallet, kind, fields, signer) {
    const data = { w: wallet, by: signer ? signer.address : wallet, n: nonce(), ts: new Date().toISOString(), ...fields };
    const message = socialMessage(kind, data);
    data.sig = signer ? await signer.signMessage(message) : await walletSign(wallet, message);
    return api("/actions", { method: "POST", body: JSON.stringify({ kind, data }) });
  }

  // One wallet signature delegates a throwaway key for several days, so later posts and likes need no popups.
  async function ensureSession() {
    if (!state.account) throw new Error("Connect your wallet first.");
    if (state.suspended) throw new Error("This wallet is suspended from Featheral World.");
    const wallet = ethers.getAddress(state.account);
    if (state.session && state.session.wallet === wallet && state.session.exp > Date.now() + 3_600_000) return state.session;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(sessionStorageKey(wallet))); } catch { /* ignore */ }
    if (saved && saved.exp > Date.now() + 3_600_000) {
      const remote = await api(`/session?address=${wallet}`).catch(() => ({ session: null }));
      if (remote.session && remote.session.key === saved.address.toLowerCase() && remote.session.expiresAt === saved.exp) {
        state.session = { wallet, exp: saved.exp, signer: new ethers.Wallet(saved.pk) };
        return state.session;
      }
    }
    const key = ethers.Wallet.createRandom();
    const exp = Date.now() + SESSION_DAYS * 86_400_000;
    toast("Approve once in your wallet to sign in to Featheral World");
    await submit(wallet, "SESSION", { k: key.address, exp });
    localStorage.setItem(sessionStorageKey(wallet), JSON.stringify({ pk: key.privateKey, address: key.address, exp }));
    state.session = { wallet, exp, signer: key };
    return state.session;
  }

  async function act(kind, fields) {
    try {
      const account = state.account;
      const session = await ensureSession();
      if (account !== state.account) throw new Error("Wallet changed. Review your draft before posting.");
      return await submit(session.wallet, kind, fields, session.signer);
    } catch (error) {
      if (error?.code === 4001 || error?.code === "ACTION_REJECTED") throw new Error("Request cancelled in your wallet.");
      if (/Session key/.test(error.message)) {
        state.session = null;
        localStorage.removeItem(sessionStorageKey(state.account));
        return act(kind, fields);
      }
      throw error;
    }
  }

  async function guarded(work) {
    try { return await work(); } catch (error) { toast(error.message || String(error), true); return null; }
  }

  /* -------------------------------- views -------------------------------- */

  function postCard(post, { focus = false, ancestor = false } = {}) {
    if (post.deleted || post.hidden) return el("div", { className: "removed", textContent: post.hidden ? "This post was hidden by a moderator." : "This post was deleted by its author." });
    const profile = post.authorProfile;
    const mine = state.account && post.author.toLowerCase() === state.account.toLowerCase();
    const btn = (label, cls, on, handler, title) => {
      const button = el("button", { type: "button", className: `act ${cls}${on ? " on" : ""}`, title, "aria-label": title, textContent: label });
      button.addEventListener("click", (event) => { event.stopPropagation(); handler(button); });
      return button;
    };
    const toggle = (kind, field, countField) => (button) => guarded(async () => {
      const turningOn = !post[field];
      button.disabled = true;
      await act(turningOn ? kind : `UN${kind}`, { p: post.id });
      post[field] = turningOn;
      post[countField] += turningOn ? 1 : -1;
      button.disabled = false;
      button.classList.toggle("on", turningOn);
      button.textContent = `${kind === "LIKE" ? (turningOn ? "♥" : "♡") : "⟳"} ${count(post[countField])}`;
    }).finally(() => { button.disabled = false; });
    const actions = el("div", { className: "post-actions" },
      btn(`💬 ${count(post.replies)}`, "reply", false, () => openReply(post), "Reply"),
      btn(`⟳ ${count(post.reposts)}`, "repost", post.reposted, toggle("REPOST", "reposted", "reposts"), "Repost"),
      btn(`${post.liked ? "♥" : "♡"} ${count(post.likes)}`, "like", post.liked, toggle("LIKE", "liked", "likes"), "Like"),
      btn("↗", "share", false, async () => { await navigator.clipboard?.writeText(`${location.origin}/#/post/${post.id}`); toast("Link copied"); }, "Copy link"),
      el("a", { className: "act", href: `/ledger/#/tx/${post.id}`, title: "View this post on the ledger", textContent: "⛓", onclick: (event) => event.stopPropagation() }),
      mine ? btn("🗑", "del", false, () => guarded(async () => {
        if (!confirm("Delete this post? It stays in the public ledger history but is hidden everywhere.")) return;
        await act("DELETE", { p: post.id });
        post.deleted = true;
        card.replaceWith(postCard(post));
      }), "Delete") : null,
    );
    const meta = el("div", { className: "post-meta" },
      el("b", { textContent: nameOf(profile, post.author) }),
      el("a", { href: `#/user/${post.author}`, textContent: handleOf(profile, post.author), onclick: (event) => event.stopPropagation() }),
      el("span", { className: "muted", textContent: `· ${timeAgo(post.timeMs)}`, title: new Date(post.timeMs).toLocaleString() }),
    );
    const text = el("div", { className: "post-text", textContent: post.text });
    const body = el("div", { className: "post-main" }, meta, text, actions);
    const avatarLink = el("a", { href: `#/user/${post.author}`, onclick: (event) => event.stopPropagation() }, avatarImg(profile, post.author));
    const card = el("article", { className: `post${focus ? " focus" : ""}${ancestor ? " ancestor" : ""}` });
    if (focus) {
      card.append(el("div", { className: "row" }, avatarLink, el("div", {}, el("b", { textContent: nameOf(profile, post.author) }), el("br"), el("span", { className: "muted", textContent: handleOf(profile, post.author) }))), text, el("p", { className: "muted fine", textContent: `${new Date(post.timeMs).toLocaleString()} · ${count(post.likes) || 0} likes · ${count(post.reposts) || 0} reposts` }), actions);
    } else {
      card.append(avatarLink, body);
      card.addEventListener("click", () => { location.hash = `#/post/${post.id}`; });
    }
    const wrapper = post.repostedBy ? el("div", {}, el("div", { className: "post-note", textContent: `⟳ ${post.repostedByProfile?.username ? `@${post.repostedByProfile.username}` : short(post.repostedBy)} reposted` }), card) : card;
    return wrapper;
  }

  function composer({ replyTo = "", placeholder = "What's happening?", onPosted, autofocus = false, compact = false } = {}) {
    const author = state.account;
    const draftKey = `${author.toLowerCase()}:${replyTo}`;
    let busy = false;
    const area = el("textarea", { placeholder, value: drafts.get(draftKey) || "", maxLength: 600, "aria-label": replyTo ? "Write a reply" : "Write a post" });
    const counter = el("span", { className: "count" });
    const label = () => !author ? "Connect to post" : replyTo ? "Reply" : "Post";
    const send = el("button", { type: "button", className: "btn primary", textContent: label(), style: "border-radius:999px" });
    const status = el("p", { className: "composer-status muted fine", role: "status", "aria-live": "polite" });
    const hint = el("p", { className: "composer-hint muted fine", textContent: state.suspended ? "This wallet is suspended from posting." : author ? "Public on the World ledger. First post: approve a free sign-in. Ctrl+Enter to post." : "Draft first, then choose your wallet to publish. Posting is free; posts remain in public ledger history." });
    const update = () => {
      const length = Array.from(area.value.trim()).length;
      counter.textContent = `${length} / ${MAX_TEXT}`;
      counter.classList.toggle("over", length > MAX_TEXT);
      counter.setAttribute("aria-label", `${length} of ${MAX_TEXT} characters`);
      send.disabled = busy || state.suspended || length < 1 || length > MAX_TEXT;
    };
    area.addEventListener("input", () => { drafts.set(draftKey, area.value); status.textContent = ""; update(); });
    area.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); if (!send.disabled) send.click(); }
    });
    send.addEventListener("click", async () => {
      if (send.disabled || busy) return;
      if (!author) { $("walletButton").click(); return; }
      if (author.toLowerCase() !== state.account.toLowerCase()) { toast("Wallet changed. Review your draft before posting.", true); return; }
      busy = true;
      area.disabled = true;
      update();
      send.textContent = "Posting…";
      status.textContent = "Signing and recording your post...";
      const text = area.value.trim();
      try {
        const result = await act("POST", { text, rp: replyTo });
        drafts.delete(draftKey);
        area.value = "";
        status.textContent = "Posted to the World ledger.";
        toast("Posted to the World ledger");
        onPosted?.(result.post);
      } catch (error) {
        status.textContent = `${error.message || String(error)} Your draft has been kept.`;
        toast(error.message || String(error), true);
      } finally {
        busy = false;
        area.disabled = false;
        send.textContent = label();
        update();
      }
    });
    const box = el("div", { className: `composer${compact ? " reply" : ""}` },
      author ? avatarImg(state.profile, author) : el("img", { className: "avatar", src: "/shared/logo-world.svg", alt: "", width: 44, height: 44 }),
      el("div", { className: "composer-body" }, area, hint, el("div", { className: "composer-bar" }, counter, send), status),
    );
    update();
    if (autofocus) setTimeout(() => area.focus(), 0);
    return box;
  }

  function focusComposer(prompt = "") {
    const area = $("composerHost").querySelector("textarea");
    if (!area) return;
    if (prompt && !area.value.trim()) {
      area.value = prompt;
      area.dispatchEvent(new Event("input"));
    }
    area.focus();
    area.scrollIntoView({ block: "center", behavior: "smooth" });
    area.setSelectionRange(area.value.length, area.value.length);
  }

  function emptyHome() {
    return el("section", { className: "empty-home", "aria-label": "Welcome to Featheral World" },
      el("div", { className: "empty-intro pad" },
        el("h2", { textContent: "Your World starts with a conversation" }),
        el("p", { className: "muted", textContent: "No posts yet. Be the first to share an idea, ask a question or say hello." }),
        el("button", { type: "button", className: "btn primary", textContent: "Write the first post", onclick: () => focusComposer() }),
        el("p", { className: "muted fine", textContent: "Examples below are inspiration only, not real posts or ledger activity." })),
      ...EXAMPLE_POSTS.map((example) => el("article", { className: "post example-post" },
        el("img", { className: "avatar", src: "/shared/logo-world.svg", alt: "", width: 44, height: 44 }),
        el("div", { className: "post-main" },
          el("div", { className: "post-meta" }, el("b", { textContent: example.title }), el("span", { className: "badge", textContent: "Example post" })),
          el("div", { className: "post-text", textContent: example.text }),
          el("button", { type: "button", className: "btn small", textContent: "Use this idea", "aria-label": `Use idea: ${example.title}`, onclick: () => focusComposer(example.prompt) })))),
    );
  }

  function openReply(post) {
    if (!state.account) { toast("Connect your wallet to reply.", true); return; }
    const modal = el("div", { className: "modal", role: "dialog", "aria-label": "Reply" });
    const close = () => modal.remove();
    modal.addEventListener("click", (event) => { if (event.target === modal) close(); });
    document.addEventListener("keydown", function onKey(event) { if (event.key === "Escape") { close(); document.removeEventListener("keydown", onKey); } });
    modal.append(el("div", { className: "modal-box" },
      el("div", { className: "post", style: "cursor:default" }, avatarImg(post.authorProfile, post.author), el("div", { className: "post-main" }, el("div", { className: "post-meta" }, el("b", { textContent: nameOf(post.authorProfile, post.author) }), el("span", { className: "muted", textContent: handleOf(post.authorProfile, post.author) })), el("div", { className: "post-text", textContent: post.text }))),
      composer({ replyTo: post.id, placeholder: "Post your reply", autofocus: true, onPosted: () => { close(); route(); } }),
    ));
    document.body.append(modal);
  }

  function setHead(...children) { $("colHead").replaceChildren(...children); }
  function title(text, sub, back) {
    return el("div", { className: "col-title" }, back ? el("a", { className: "back", href: "#/", textContent: "←", "aria-label": "Back" }) : null, el("div", {}, el("h1", { textContent: text }), sub ? el("small", { textContent: sub }) : null));
  }
  function tabs(items, selected, onSelect) {
    return el("div", { className: "tabs-row", role: "tablist" }, ...items.map(([id, label]) => el("button", { type: "button", role: "tab", textContent: label, "aria-selected": String(id === selected), onclick: () => onSelect(id) })));
  }

  async function loadFeed(query, { empty = "Nothing here yet.", examples = false, host = $("feed"), id = state.renderId } = {}) {
    const list = el("div");
    let cursor = 0;
    let more = null;
    host.replaceChildren(list);
    async function page() {
      const data = await api(`${query}${query.includes("?") ? "&" : "?"}limit=25${cursor ? `&before=${cursor}` : ""}${state.account ? `&viewer=${ethers.getAddress(state.account)}` : ""}`);
      if (id !== state.renderId) return;
      if (!cursor && !data.posts.length) list.append(examples ? emptyHome() : el("p", { className: "muted pad", textContent: empty }));
      if (!cursor && !data.posts.length) state.topId = "";
      if (!cursor && data.posts[0]) state.topId = data.posts[0].id;
      data.posts.forEach((post) => list.append(postCard(post)));
      cursor = data.next;
      more?.remove();
      more = null;
      if (cursor) {
        more = el("button", { type: "button", className: "btn", style: "margin:16px", textContent: "Show more", onclick: () => guarded(page) });
        host.append(more);
      }
    }
    await page();
  }

  async function showHome(scope) {
    const id = state.renderId;
    setHead(title("Home"), tabs([["all", "For you"], ["following", "Following"]], scope, (next) => { location.hash = next === "all" ? "#/" : "#/following"; }));
    $("composerHost").replaceChildren(composer({ onPosted: () => { route(); loadSide(); } }));
    if (scope === "following" && !state.account) {
      $("feed").replaceChildren(el("p", { className: "muted pad", textContent: "Connect your wallet to see posts from people you follow." }));
      return;
    }
    await loadFeed(`/timeline?scope=${scope}`, { id, examples: scope === "all", empty: "Follow people to fill this timeline. Find people in Explore." });
  }

  async function showPost(postId) {
    const id = state.renderId;
    setHead(title("Post", null, true));
    $("composerHost").replaceChildren();
    const data = await api(`/posts/${postId}${state.account ? `?viewer=${ethers.getAddress(state.account)}` : ""}`);
    if (id !== state.renderId) return;
    const list = el("div", {}, ...data.ancestors.map((post) => postCard(post, { ancestor: true })), postCard(data.post, { focus: true }));
    const reply = composer({ replyTo: data.post.id, placeholder: "Post your reply", compact: true, onPosted: () => route() });
    $("feed").replaceChildren(list, reply, ...data.replies.map((post) => postCard(post)));
    if (!data.replies.length) $("feed").append(el("p", { className: "muted pad", textContent: "No replies yet." }));
  }

  async function showUser(address, tab) {
    const id = state.renderId;
    const viewer = state.account ? ethers.getAddress(state.account) : "";
    const { profile, stats, moderator } = await api(`/users/${address}${viewer ? `?viewer=${viewer}` : ""}`);
    if (id !== state.renderId) return;
    const mine = viewer && viewer === address;
    const followButton = mine
      ? el("button", { type: "button", className: "btn", textContent: "Edit profile", onclick: () => $("walletButton").click() })
      : el("button", { type: "button", className: "btn primary", textContent: stats.viewerFollows ? "Following" : "Follow", onclick: (event) => guarded(async () => {
        const button = event.currentTarget;
        button.disabled = true;
        await act(stats.viewerFollows ? "UNFOLLOW" : "FOLLOW", { u: address });
        route();
      }) });
    setHead(title(nameOf(profile, address), `${count(stats.posts + stats.replies) || 0} posts`, true));
    $("composerHost").replaceChildren();
    const head = el("div", {},
      el("div", { className: "profile-banner" }),
      el("div", { className: "profile-head" },
        el("div", { className: "profile-top" }, avatarImg(profile, address, "big"), followButton),
        el("h2", {}, nameOf(profile, address), moderator ? el("span", { className: "badge", textContent: "Admin" }) : null, stats.suspended ? el("span", { className: "badge", textContent: "Suspended" }) : null),
        el("div", { className: "muted", textContent: `${handleOf(profile, address)} · ${address}` }),
        el("div", { className: "muted fine", textContent: stats.firstSeen ? `On the World ledger since ${new Date(stats.firstSeen).toLocaleDateString("en-US", { month: "long", year: "numeric" })}` : "Not on the World ledger yet" }),
        el("div", { className: "profile-counts" }, el("span", {}, el("b", { textContent: count(stats.following) || "0" }), " Following"), el("span", {}, el("b", { textContent: count(stats.followers) || "0" }), " Followers")),
      ),
      tabs([["posts", "Posts"], ["replies", "Replies"], ["likes", "Likes"]], tab, (next) => { location.hash = `#/user/${address}${next === "posts" ? "" : `/${next}`}`; }),
    );
    const host = el("div");
    $("feed").replaceChildren(head, host);
    await loadFeed(`/timeline?author=${address}&tab=${tab}`, { host, id, empty: tab === "likes" ? "No likes yet." : "No posts yet." });
  }

  async function showSearch(query) {
    const id = state.renderId;
    setHead(title("Explore", query ? `Results for “${query}”` : null, Boolean(query)));
    $("composerHost").replaceChildren();
    if (!query) {
      $("feed").replaceChildren(el("p", { className: "muted pad", textContent: "Search posts, @usernames or wallet addresses. Showing the latest posts from everyone." }));
      await loadFeed("/timeline", { host: el("div"), id }).catch(() => {});
      const host = el("div");
      $("feed").append(host);
      await loadFeed("/timeline", { host, id });
      return;
    }
    const data = await api(`/search?q=${encodeURIComponent(query)}${state.account ? `&viewer=${ethers.getAddress(state.account)}` : ""}`);
    if (id !== state.renderId) return;
    const users = data.users.map((user) => el("a", { className: "post", href: `#/user/${user.address}`, style: "text-decoration:none;color:inherit" }, avatarImg(user, user.address), el("div", { className: "post-main" }, el("b", { textContent: nameOf(user, user.address) }), el("div", { className: "muted", textContent: handleOf(user, user.address) }))));
    $("feed").replaceChildren(...users, ...data.posts.map((post) => postCard(post)));
    if (!users.length && !data.posts.length) $("feed").append(el("p", { className: "muted pad", textContent: "No posts or people matched." }));
  }

  /* ------------------------------ side panels ----------------------------- */

  async function loadSide() {
    try {
      const { ledger } = await api("/stats");
      $("ledgerCard").replaceChildren(el("h2", { textContent: "World ledger" }), el("dl", {},
        ...[["Block height", `#${ledger.height.toLocaleString("en-US")}`], ["Posts", ledger.posts.toLocaleString("en-US")], ["Authors", ledger.authors.toLocaleString("en-US")], ["Actions", ledger.transactions.toLocaleString("en-US")]].flatMap(([key, value]) => [el("dt", { className: "muted", textContent: key }), el("dd", { textContent: value })])),
        el("p", { className: "fine" }, el("a", { href: "/ledger/", textContent: "Browse blocks" }), " · ", el("a", { href: "/ledger/#/sql", textContent: "SQL" })));
    } catch { $("ledgerCard").querySelector("p").textContent = "Ledger unavailable."; }
    try {
      const viewer = state.account ? ethers.getAddress(state.account) : "";
      const { users } = await api(`/suggestions${viewer ? `?viewer=${viewer}` : ""}`);
      $("followCard").replaceChildren(el("h2", { textContent: "Who to follow" }), ...(users.length ? users.map((user) => {
        const row = el("div", { className: "suggest" }, avatarImg(user.profile, user.address, "small"),
          el("div", { className: "who" }, el("a", { href: `#/user/${user.address}`, textContent: nameOf(user.profile, user.address) }), el("span", { className: "muted fine", textContent: `${count(user.followers) || 0} followers` })),
          el("button", { type: "button", className: "btn small", textContent: "Follow", onclick: (event) => guarded(async () => { event.currentTarget.disabled = true; await act("FOLLOW", { u: user.address }); event.currentTarget.textContent = "Following"; }) }));
        return row;
      }) : [el("p", { className: "muted fine", textContent: "No suggestions yet." })]));
    } catch { /* suggestions are optional */ }
  }

  function renderRail() {
    const me = document.querySelector('[data-nav="me"]');
    me.href = state.account ? `#/user/${ethers.getAddress(state.account)}` : "#/me";
  }

  /* -------------------------------- router -------------------------------- */

  async function route() {
    const id = ++state.renderId;
    const parts = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
    const [name, arg, extra] = parts;
    state.route = name || "home";
    document.querySelectorAll(".rail-nav a").forEach((link) => link.classList.toggle("active", link.dataset.nav === (name === "following" || !name ? "home" : name === "user" && state.account && arg?.toLowerCase() === state.account.toLowerCase() ? "me" : name === "search" ? "explore" : name)));
    $("newBanner").hidden = true;
    try {
      if (name === "post" && /^0x[0-9a-f]{64}$/.test(arg || "")) await showPost(arg);
      else if (name === "user" && /^0x[0-9a-fA-F]{40}$/.test(arg || "")) await showUser(ethers.getAddress(arg.toLowerCase()), ["replies", "likes"].includes(extra) ? extra : "posts");
      else if (name === "me") {
        if (state.account) location.hash = `#/user/${ethers.getAddress(state.account)}`;
        else { setHead(title("Profile")); $("composerHost").replaceChildren(composer()); $("feed").replaceChildren(); }
      } else if (name === "explore") await showSearch("");
      else if (name === "search") await showSearch(arg || "");
      else if (name === "following") await showHome("following");
      else await showHome("all");
    } catch (error) {
      if (id !== state.renderId) return;
      $("feed").replaceChildren(el("p", { className: "muted pad", textContent: error.status === 404 ? "That post or profile was not found on the World ledger." : `Could not load the World ledger: ${error.message}` }));
    }
  }

  $("searchForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const query = $("searchInput").value.trim();
    location.hash = query ? `#/search/${encodeURIComponent(query)}` : "#/explore";
  });
  $("railPost").addEventListener("click", () => {
    if (state.route !== "home" && state.route !== "following") location.hash = "#/";
    setTimeout(() => focusComposer(), 50);
  });
  window.addEventListener("hashchange", () => { route(); window.scrollTo({ top: 0 }); });

  // The wallet chip is shared by every Featheral site; react whenever it connects, disconnects, or changes profile.
  let lastAccount = null;
  window.addEventListener("featheral:wallet", async (event) => {
    const { account, profile } = event.detail;
    state.profile = profile;
    const changed = (account || "") !== lastAccount;
    state.account = account || "";
    renderRail();
    if (!changed) return;
    if (account && !lastAccount && drafts.has(":") && !drafts.has(`${account.toLowerCase()}:`)) {
      drafts.set(`${account.toLowerCase()}:`, drafts.get(":"));
      drafts.delete(":");
    }
    lastAccount = account || "";
    state.session = null;
    state.suspended = false;
    if (account) {
      const session = await api(`/session?address=${ethers.getAddress(account)}`).catch(() => null);
      if (state.account !== account) return;
      state.suspended = Boolean(session?.suspended);
    }
    route();
    loadSide();
  });

  // Light polling: offer new posts instead of shifting the timeline under the reader.
  setInterval(async () => {
    if (document.hidden || !["home", "following"].includes(state.route) || window.scrollY > 0 && $("newBanner").hidden === false) return;
    try {
      const scope = state.route === "following" ? "following" : "all";
      const data = await api(`/timeline?scope=${scope}&limit=1${state.account ? `&viewer=${ethers.getAddress(state.account)}` : ""}`);
      if (data.posts[0] && data.posts[0].id !== state.topId) {
        const banner = $("newBanner");
        banner.hidden = false;
        banner.replaceChildren(el("button", { type: "button", textContent: "Show new posts", onclick: () => { banner.hidden = true; route(); } }));
      }
    } catch { /* offline */ }
  }, 12_000);
  setInterval(loadSide, 60_000);

  FeatheralProfile.mount($("walletButton"), { primaryCurrency: "fthDollar", walletUrl: FeatheralSites.url("dollar", "/wallet/") });
  const siteHeader = document.querySelector(".world-header");
  const ecoBar = document.querySelector(".eco-bar");
  const updateHeaderHeight = () => {
    document.body.style.setProperty("--world-header-height", `${siteHeader.getBoundingClientRect().height}px`);
    document.body.style.setProperty("--world-eco-height", `${ecoBar.getBoundingClientRect().height}px`);
  };
  const headerObserver = new ResizeObserver(updateHeaderHeight);
  headerObserver.observe(siteHeader);
  headerObserver.observe(ecoBar);
  updateHeaderHeight();
  renderRail();
  route();
  loadSide();
})();
