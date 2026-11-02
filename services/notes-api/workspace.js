"use strict";
const crypto = require("node:crypto");
const W = require("../cms/lib/wallet");
const { SYSTEM_TREASURY_ACCOUNT } = require("../dollar-api/funds");
const fail = (status, message) => Object.assign(new Error(message), { status });
const ROLES = ["volunteer", "intern", "contributor", "lead", "manager", "director"];
const LEVELS = ["orientation", "learning", "practitioner", "mentor", "steward"];
const STATES = ["draft", "ready", "in_progress", "review", "done", "cancelled"];
const text = (value, name, max = 2000) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw fail(400, `${name} must contain 1-${max} characters.`);
  return value.trim();
};
const address = value => {
  if (!W.isAddress(value)) throw fail(400, "A valid wallet address is required.");
  return value.toLowerCase();
};
const id = value => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw fail(400, "Invalid workspace identifier.");
  return value;
};
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
class Workspace {
  constructor(notes, markets, profileReader = () => null, now = Date.now) {
    this.notes = notes; this.db = notes.db; this.markets = markets; this.profileReader = profileReader; this.now = now;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS work_members(address TEXT PRIMARY KEY,status TEXT NOT NULL,role TEXT NOT NULL,
        level TEXT NOT NULL,division TEXT NOT NULL,team TEXT NOT NULL,motivation TEXT NOT NULL,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS work_divisions(id TEXT PRIMARY KEY,name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS work_teams(id TEXT PRIMARY KEY,division TEXT NOT NULL,name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS work_challenges(address TEXT PRIMARY KEY,message TEXT NOT NULL,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS work_sessions(token TEXT PRIMARY KEY,address TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS work_channels(id TEXT PRIMARY KEY,name TEXT NOT NULL,scope TEXT NOT NULL,scope_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS work_dm(channel TEXT NOT NULL,address TEXT NOT NULL,PRIMARY KEY(channel,address));
      CREATE TABLE IF NOT EXISTS work_messages(id INTEGER PRIMARY KEY,channel TEXT NOT NULL,author TEXT NOT NULL,
        request TEXT NOT NULL,body TEXT NOT NULL,file TEXT,at INTEGER NOT NULL,UNIQUE(author,request));
      CREATE INDEX IF NOT EXISTS work_messages_channel ON work_messages(channel,id);
      CREATE TABLE IF NOT EXISTS work_reads(address TEXT NOT NULL,channel TEXT NOT NULL,message INTEGER NOT NULL,PRIMARY KEY(address,channel));
      CREATE TABLE IF NOT EXISTS work_files(id TEXT PRIMARY KEY,channel TEXT NOT NULL,owner TEXT NOT NULL,name TEXT NOT NULL,
        bytes BLOB NOT NULL,size INTEGER NOT NULL,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS work_documents(channel TEXT PRIMARY KEY,body TEXT NOT NULL,revision INTEGER NOT NULL,author TEXT NOT NULL,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS work_missions(id TEXT PRIMARY KEY,title TEXT NOT NULL,body TEXT NOT NULL,division TEXT NOT NULL,
        team TEXT NOT NULL,assignee TEXT NOT NULL,status TEXT NOT NULL,evidence TEXT NOT NULL,revision INTEGER NOT NULL,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS work_audit(id INTEGER PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,data TEXT NOT NULL,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS work_grants(request TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,address TEXT NOT NULL,
        amount INTEGER NOT NULL,reason TEXT NOT NULL,mission TEXT UNIQUE,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS work_calls(id TEXT PRIMARY KEY,channel TEXT NOT NULL,caller TEXT NOT NULL,callee TEXT NOT NULL,
        status TEXT NOT NULL,at INTEGER NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS work_signals(id INTEGER PRIMARY KEY,call TEXT NOT NULL,sender TEXT NOT NULL,body TEXT NOT NULL,at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS work_signals_call ON work_signals(call,id);
      CREATE TABLE IF NOT EXISTS work_push(endpoint TEXT PRIMARY KEY,address TEXT NOT NULL,subscription TEXT NOT NULL,at INTEGER NOT NULL);
    `);
    this.atomic(() => {
      for (const [key, name] of [["operations", "Foundation operations"], ["engineering", "Engineering & infrastructure"],
        ["community", "Community & support"], ["research", "Research & ecosystem"], ["learning", "Learning & mentorship"]]) {
        this.db.prepare("INSERT OR IGNORE INTO work_divisions VALUES (?,?)").run(key, name);
        this.db.prepare("INSERT OR IGNORE INTO work_teams VALUES (?,?,?)").run(`${key}-general`, key, "General");
        this.db.prepare("INSERT OR IGNORE INTO work_channels VALUES (?,?,?,?)").run(`division-${key}`, name, "division", key);
        this.db.prepare("INSERT OR IGNORE INTO work_channels VALUES (?,?,?,?)").run(`team-${key}-general`, `${name} / General`, "team", `${key}-general`);
      }
      this.db.prepare("INSERT OR IGNORE INTO work_channels VALUES ('foundation','Foundation commons','foundation','')").run();
      const silver = this.db.prepare("SELECT * FROM note_currencies WHERE symbol='FTHS'").get();
      if (silver && (silver.owner !== SYSTEM_TREASURY_ACCOUNT || silver.name !== "Featheral Silver"))
        throw fail(409, "FTHS already belongs to an existing note. Resolve ownership before enabling the intranet.");
      this.db.prepare("INSERT OR IGNORE INTO note_currencies VALUES ('FTHS','Featheral Silver',?,?)").run(SYSTEM_TREASURY_ACCOUNT, now());
      this.db.prepare("INSERT INTO note_markets(symbol,placeholder) VALUES ('FTHS',0) ON CONFLICT(symbol) DO UPDATE SET placeholder=0").run();
    });
  }
  atomic(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  audit(actor, action, target, data) {
    this.db.prepare("INSERT INTO work_audit(actor,action,target,data,at) VALUES (?,?,?,?,?)")
      .run(actor, action, target, JSON.stringify(data), this.now());
  }
  challenge(value, origin) {
    const owner = address(value), now = this.now();
    this.db.prepare("DELETE FROM work_challenges WHERE at<?").run(now - 300000);
    this.db.prepare("DELETE FROM work_sessions WHERE expires<=?").run(now);
    const message = `Sign in to Featheral App.\n\nOrigin: ${origin}\nWallet: ${W.checksum(owner)}\nNonce: ${crypto.randomBytes(24).toString("hex")}\nIssued: ${new Date(now).toISOString()}\n\nPrivate Foundation workspace. No transfer or salary approval. Insider access requires administrator approval.`;
    this.db.prepare("INSERT OR REPLACE INTO work_challenges VALUES (?,?,?)").run(owner, message, now);
    return { address: owner, message };
  }
  login(input, origin) {
    const owner = address(input?.address), challenge = this.db.prepare("SELECT * FROM work_challenges WHERE address=?").get(owner);
    if (!challenge || challenge.at < this.now() - 300000 || !challenge.message.includes(`Origin: ${origin}\n`))
      throw fail(401, "Sign-in expired. Connect again.");
    if (typeof input.signature !== "string" || W.recoverAddress(challenge.message, input.signature).toLowerCase() !== owner)
      throw fail(401, "Invalid wallet signature.");
    const token = crypto.randomBytes(32).toString("hex");
    this.atomic(() => {
      this.db.prepare("DELETE FROM work_challenges WHERE address=?").run(owner);
      this.db.prepare("INSERT INTO work_sessions VALUES (?,?,?)").run(digest(token), owner, this.now() + 86400000);
    });
    return token;
  }
  owner(token) {
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) throw fail(401, "Connect your wallet to Featheral App.");
    const session = this.db.prepare("SELECT * FROM work_sessions WHERE token=? AND expires>?").get(digest(token), this.now());
    if (!session) throw fail(401, "App session expired. Connect again.");
    return session.address;
  }
  logout(token) { if (typeof token === "string") this.db.prepare("DELETE FROM work_sessions WHERE token=?").run(digest(token)); }
  member(owner) { return this.db.prepare("SELECT * FROM work_members WHERE address=?").get(owner) || null; }
  active(owner) {
    const member = this.member(owner);
    if (member?.status !== "active") throw fail(403, "Administrator-approved insider access is required.");
    return member;
  }
  org() {
    return { divisions: this.db.prepare("SELECT * FROM work_divisions ORDER BY name").all(),
      teams: this.db.prepare("SELECT * FROM work_teams ORDER BY division,name").all(), roles: ROLES, levels: LEVELS, states: STATES };
  }
  async me(owner) {
    const profile = await this.profileReader(owner);
    return { address: owner, profile: profile ? { username: profile.username, avatar: profile.avatar, bio: profile.bio || "", address: owner } : null,
      member: this.member(owner), org: this.org(), silver: this.notes.balance(owner, "FTHS") };
  }
  async apply(owner, input) {
    const profile = await this.profileReader(owner);
    if (!profile?.username) throw fail(409, "Create your World profile before requesting insider access.");
    const motivation = text(input?.motivation, "Introduction", 1000), existing = this.member(owner);
    if (existing) throw fail(409, "Your application is already recorded. Contact an administrator for changes.");
    this.db.prepare("INSERT INTO work_members VALUES (?,'pending','volunteer','orientation','learning','learning-general',?,?)")
      .run(owner, motivation, this.now());
    this.audit(owner, "membership.request", owner, { motivation });
    return this.member(owner);
  }
  setMember(actor, value, input) {
    const owner = address(value), previous = this.member(owner);
    if (!previous) throw fail(404, "Membership application not found.");
    const { status, role, level, division, team } = input || {};
    if (!["pending", "active", "suspended", "rejected"].includes(status) || !ROLES.includes(role) || !LEVELS.includes(level))
      throw fail(400, "Choose a valid membership status, role and level.");
    if (!this.db.prepare("SELECT 1 FROM work_teams WHERE id=? AND division=?").get(id(team), id(division)))
      throw fail(400, "The selected team must belong to this division.");
    return this.atomic(() => {
      this.db.prepare("UPDATE work_members SET status=?,role=?,level=?,division=?,team=? WHERE address=?")
        .run(status, role, level, division, team, owner);
      if (status !== "active") {
        this.db.prepare("DELETE FROM work_push WHERE address=?").run(owner);
        this.db.prepare("UPDATE work_calls SET status='ended' WHERE caller=? OR callee=?").run(owner, owner);
      }
      this.audit(actor, "membership.update", owner, { previous, status, role, level, division, team });
      return this.member(owner);
    });
  }
  addTeam(actor, input) {
    const division = id(input?.division), name = text(input?.name, "Team name", 80), key = crypto.randomUUID();
    if (!this.db.prepare("SELECT 1 FROM work_divisions WHERE id=?").get(division)) throw fail(400, "Unknown division.");
    return this.atomic(() => {
      this.db.prepare("INSERT INTO work_teams VALUES (?,?,?)").run(key, division, name);
      this.db.prepare("INSERT INTO work_channels VALUES (?,?,?,?)").run(`team-${key}`, name, "team", key);
      this.audit(actor, "team.create", key, { division, name });
      return this.org();
    });
  }
  canChannel(member, channel) {
    return channel.scope === "foundation" || channel.scope === "division" && channel.scope_id === member.division
      || channel.scope === "team" && channel.scope_id === member.team
      || channel.scope === "dm" && !!this.db.prepare("SELECT 1 FROM work_dm WHERE channel=? AND address=?").get(channel.id, member.address);
  }
  channel(owner, key) {
    const member = this.active(owner), channel = this.db.prepare("SELECT * FROM work_channels WHERE id=?").get(id(key));
    if (!channel || !this.canChannel(member, channel)) throw fail(404, "Channel unavailable.");
    if (channel.scope === "dm") {
      const others = this.db.prepare("SELECT address FROM work_dm WHERE channel=?").all(key);
      if (others.some(row => this.member(row.address)?.status !== "active")) throw fail(403, "This conversation includes an inactive member.");
    }
    return channel;
  }
  channels(owner) {
    const member = this.active(owner);
    return this.db.prepare("SELECT * FROM work_channels ORDER BY scope,name").all().filter(row => this.canChannel(member, row))
      .map(row => ({ ...row, peer: row.scope === "dm" ? this.db.prepare("SELECT address FROM work_dm WHERE channel=? AND address!=?").get(row.id, owner)?.address : null,
        unread: this.db.prepare(`SELECT COUNT(*) AS n FROM work_messages WHERE channel=? AND author!=? AND id>
        COALESCE((SELECT message FROM work_reads WHERE address=? AND channel=?),0)`).get(row.id, owner, owner, row.id).n }));
  }
  direct(owner, value) {
    this.active(owner); const other = address(value); this.active(other);
    if (owner === other) throw fail(400, "Choose another insider.");
    const members = [owner, other].sort(), key = `dm-${digest(members.join(":")).slice(0, 40)}`;
    return this.atomic(() => {
      this.db.prepare("INSERT OR IGNORE INTO work_channels VALUES (?,?,'dm','')").run(key, "Direct conversation");
      for (const member of members) this.db.prepare("INSERT OR IGNORE INTO work_dm VALUES (?,?)").run(key, member);
      return this.channel(owner, key);
    });
  }
  recipients(key) {
    const channel = this.db.prepare("SELECT * FROM work_channels WHERE id=?").get(key);
    return this.db.prepare("SELECT * FROM work_members WHERE status='active'").all().filter(member => this.canChannel(member, channel)).map(member => member.address);
  }
  messages(owner, key, after = 0) {
    this.channel(owner, key);
    if (!Number.isSafeInteger(after) || after < 0) throw fail(400, "Invalid message cursor.");
    const rows = after ? this.db.prepare("SELECT * FROM work_messages WHERE channel=? AND id>? ORDER BY id LIMIT 100").all(key, after)
      : this.db.prepare("SELECT * FROM work_messages WHERE channel=? ORDER BY id DESC LIMIT 100").all(key).reverse();
    return rows.map(row => ({ ...row, attachment: row.file ? this.db.prepare("SELECT id,name,size FROM work_files WHERE id=?").get(row.file) : null }));
  }
  send(owner, key, input) {
    this.channel(owner, key);
    const request = id(input?.request), body = input?.body === "" ? "" : text(input?.body, "Message", 4000);
    const attachment = input?.attachment;
    if (!body && !attachment) throw fail(400, "Write a message or attach a file.");
    const previous = this.db.prepare("SELECT * FROM work_messages WHERE author=? AND request=?").get(owner, request);
    if (previous) {
      const file = previous.file && this.db.prepare("SELECT name,bytes FROM work_files WHERE id=?").get(previous.file);
      if (previous.channel !== key || previous.body !== body || !!file !== !!attachment || file &&
        (file.name !== attachment.name || Buffer.from(file.bytes).toString("base64") !== attachment.base64))
        throw fail(409, "Message retry parameters changed.");
      return previous;
    }
    if (this.db.prepare("SELECT 1 FROM work_messages WHERE author=? AND at>?").get(owner, this.now() - 1000))
      throw fail(429, "Wait a second before sending another message.");
    let file;
    if (attachment) {
      const name = text(attachment.name, "Filename", 160);
      if (/[\x00-\x1f\\/]/.test(name) || typeof attachment.base64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(attachment.base64))
        throw fail(400, "Invalid attachment.");
      const bytes = Buffer.from(attachment.base64, "base64");
      if (!bytes.length || bytes.length > 5 * 1024 * 1024 || bytes.toString("base64") !== attachment.base64)
        throw fail(413, "Files must be 1 byte to 5 MiB.");
      const total = this.db.prepare("SELECT COALESCE(SUM(size),0) AS n FROM work_files").get().n;
      const daily = this.db.prepare("SELECT COALESCE(SUM(size),0) AS n FROM work_files WHERE owner=? AND at>?").get(owner, this.now() - 86400000).n;
      if (total + bytes.length > 100 * 1024 * 1024 || daily + bytes.length > 20 * 1024 * 1024)
        throw fail(413, "Workspace file quota reached (100 MiB total, 20 MiB per member per day).");
      file = { id: crypto.randomUUID(), name, bytes };
    }
    return this.atomic(() => {
      if (file) this.db.prepare("INSERT INTO work_files VALUES (?,?,?,?,?,?,?)").run(file.id, key, owner, file.name, file.bytes, file.bytes.length, this.now());
      const result = this.db.prepare("INSERT INTO work_messages(channel,author,request,body,file,at) VALUES (?,?,?,?,?,?)")
        .run(key, owner, request, body, file?.id || null, this.now());
      return this.db.prepare("SELECT * FROM work_messages WHERE id=?").get(result.lastInsertRowid);
    });
  }
  file(owner, key) {
    const file = this.db.prepare("SELECT * FROM work_files WHERE id=?").get(id(key));
    if (!file) throw fail(404, "File not found.");
    this.channel(owner, file.channel); return file;
  }
  read(owner, key, message) {
    this.channel(owner, key);
    if (!Number.isSafeInteger(message) || message < 0 || message && !this.db.prepare("SELECT 1 FROM work_messages WHERE id=? AND channel=?").get(message, key))
      throw fail(400, "Invalid read receipt.");
    this.db.prepare(`INSERT INTO work_reads VALUES (?,?,?) ON CONFLICT(address,channel)
      DO UPDATE SET message=MAX(message,excluded.message)`).run(owner, key, message);
    return { read: message };
  }
  document(owner, key, input) {
    this.channel(owner, key);
    if (input) {
      if (typeof input.body !== "string" || input.body.length > 50000 || !Number.isSafeInteger(input.revision) || input.revision < 0)
        throw fail(400, "Document requires text up to 50,000 characters and its current revision.");
      this.atomic(() => {
        const current = this.db.prepare("SELECT revision FROM work_documents WHERE channel=?").get(key)?.revision || 0;
        if (current !== input.revision) throw fail(409, "Document changed. Reload the latest version before saving; your draft is preserved.");
        this.db.prepare(`INSERT INTO work_documents VALUES (?,?,?,?,?) ON CONFLICT(channel)
          DO UPDATE SET body=excluded.body,revision=excluded.revision,author=excluded.author,at=excluded.at`)
          .run(key, input.body, current + 1, owner, this.now());
        this.audit(owner, "document.save", key, { revision: current + 1 });
      });
    }
    return this.db.prepare("SELECT * FROM work_documents WHERE channel=?").get(key) || { channel: key, body: "", revision: 0 };
  }
  manages(member, mission) {
    return member.role === "director" || member.division === mission.division
      && (member.role === "manager" || member.role === "lead" && member.team === mission.team);
  }
  missions(owner) {
    const member = this.active(owner);
    return this.db.prepare("SELECT * FROM work_missions ORDER BY at DESC LIMIT 1000").all()
      .filter(mission => member.role === "director" || mission.division === member.division);
  }
  saveMission(owner, input, key, admin = false) {
    const member = admin ? null : this.active(owner), previous = key && this.db.prepare("SELECT * FROM work_missions WHERE id=?").get(id(key));
    if (key && !previous) throw fail(404, "Mission not found.");
    const manager = admin || this.manages(member, previous || input);
    if (!manager && (!previous || previous.assignee !== owner)) throw fail(403, "Only the assignee or scoped manager can update this mission.");
    const status = input?.status;
    if (!STATES.includes(status)) throw fail(400, "Unknown mission status.");
    if (previous && input.revision !== previous.revision) throw fail(409, "Mission changed. Reload before updating.");
    let mission;
    if (manager) {
      const division = id(input.division), team = id(input.team), assignee = input.assignee ? address(input.assignee) : "";
      if (!this.db.prepare("SELECT 1 FROM work_teams WHERE division=? AND id=?").get(division, team)) throw fail(400, "Invalid mission team.");
      if (!admin && !this.manages(member, { division, team })) throw fail(403, "Mission is outside your management scope.");
      if (assignee) {
        const assigned = this.active(assignee);
        if (assigned.division !== division || assigned.team !== team) throw fail(400, "Assignee must belong to the mission team.");
      }
      mission = { title: text(input.title, "Title", 160), body: text(input.body, "Mission brief", 6000), division, team, assignee };
    } else {
      const transitions = { ready: ["in_progress"], in_progress: ["review"], review: ["in_progress"] };
      if (!transitions[previous.status]?.includes(status)) throw fail(403, "Submit work for review; a manager must approve completion.");
      mission = previous;
    }
    const evidence = input.evidence === undefined ? previous?.evidence || "" : typeof input.evidence === "string" && input.evidence.length <= 6000 ? input.evidence : null;
    if (evidence === null || status === "review" && !evidence.trim()) throw fail(400, "Provide completion evidence before review.");
    const missionId = key || crypto.randomUUID(), revision = (previous?.revision || 0) + 1;
    return this.atomic(() => {
      this.db.prepare(`INSERT INTO work_missions VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        title=excluded.title,body=excluded.body,division=excluded.division,team=excluded.team,assignee=excluded.assignee,
        status=excluded.status,evidence=excluded.evidence,revision=excluded.revision,at=excluded.at`)
        .run(missionId, mission.title, mission.body, mission.division, mission.team, mission.assignee, status, evidence, revision, this.now());
      this.audit(owner, "mission.save", missionId, { status, revision });
      return this.db.prepare("SELECT * FROM work_missions WHERE id=?").get(missionId);
    });
  }
  grant(actor, input) {
    const owner = address(input?.address), amount = input?.amount, request = id(input?.request), reason = text(input?.reason, "Grant reason", 1000);
    this.active(owner);
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1000000000 || input.approval !== `ISSUE ${amount} FTHS`)
      throw fail(400, "Approve an exact whole-unit grant with ISSUE <amount> FTHS (1-1,000,000,000).");
    const mission = input.mission ? id(input.mission) : null, fingerprint = JSON.stringify({ owner, amount, reason, mission });
    return this.atomic(() => {
      const previous = this.db.prepare("SELECT * FROM work_grants WHERE request=?").get(request);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw fail(409, "Grant retry parameters changed.");
        return previous;
      }
      if (mission) {
        const work = this.db.prepare("SELECT * FROM work_missions WHERE id=?").get(mission);
        if (!work || work.status !== "done" || work.assignee !== owner) throw fail(409, "A mission grant requires approved completed work by this member.");
        if (this.db.prepare("SELECT 1 FROM work_grants WHERE mission=?").get(mission)) throw fail(409, "This mission has already received a grant.");
      }
      const supply = this.db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM notes_entries WHERE symbol='FTHS'").get().n;
      if (!Number.isSafeInteger(supply + amount) || !Number.isSafeInteger(this.notes.balance(owner, "FTHS") + amount)) throw fail(409, "Silver supply exceeds safe unit limits.");
      this.db.prepare("INSERT INTO notes_entries(address,amount,kind,other,at,site,symbol) VALUES (?,?,'silver_admin_grant',?,?,'featheral-app','FTHS')")
        .run(owner, amount, request, this.now());
      this.db.prepare("INSERT INTO work_grants VALUES (?,?,?,?,?,?,?)").run(request, fingerprint, owner, amount, reason, mission, this.now());
      this.audit(actor, "silver.issue", request, { owner, amount, reason, mission });
      return this.db.prepare("SELECT * FROM work_grants WHERE request=?").get(request);
    });
  }
  silver() {
    const supply = this.db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM notes_entries WHERE symbol='FTHS'").get().n;
    return { symbol: "FTHS", name: "Featheral Silver", alias: "Featheral Salary", decimals: 0, supply,
      market: this.markets.catalog().find(row => row.symbol === "FTHS"), automaticSalary: false, usdPeg: false };
  }
  startCall(owner, input) {
    this.channel(owner, input?.channel);
    const callee = address(input?.callee); this.channel(callee, input.channel);
    if (callee === owner) throw fail(400, "Choose another member to call.");
    this.prune();
    if (this.db.prepare("SELECT 1 FROM work_calls WHERE status!='ended' AND (caller IN (?,?) OR callee IN (?,?))")
      .get(owner, callee, owner, callee)) throw fail(409, "One of these members is already in a call.");
    const key = crypto.randomUUID();
    this.db.prepare("INSERT INTO work_calls VALUES (?,?,?,?,'ringing',?,?)").run(key, input.channel, owner, callee, this.now(), this.now() + 60000);
    return this.call(owner, key);
  }
  prune() {
    this.db.prepare("DELETE FROM work_signals WHERE at<?").run(this.now() - 3600000);
    this.db.prepare("UPDATE work_calls SET status='ended' WHERE expires<?").run(this.now());
    this.db.prepare("DELETE FROM work_calls WHERE expires<?").run(this.now() - 86400000);
  }
  call(owner, key) {
    const call = this.db.prepare("SELECT * FROM work_calls WHERE id=?").get(id(key));
    if (!call || ![call.caller, call.callee].includes(owner)) throw fail(404, "Call not found.");
    this.channel(owner, call.channel);
    this.channel(call.caller === owner ? call.callee : call.caller, call.channel);
    return call;
  }
  signal(owner, key, input) {
    this.prune(); const call = this.call(owner, key), type = input?.type;
    if (call.status === "ended") throw fail(409, "Call has ended.");
    if (!["accept", "end", "heartbeat", "offer", "answer", "candidate"].includes(type)) throw fail(400, "Unsupported call signal.");
    if (type === "accept" && (owner !== call.callee || call.status !== "ringing")) throw fail(409, "Only the invited member can accept a ringing call.");
    if (!["accept", "end", "heartbeat"].includes(type) && call.status !== "active") throw fail(409, "Accept the call before sharing media signals.");
    if (["offer", "answer"].includes(type) && (typeof input.sdp !== "string" || input.sdp.length > 32000))
      throw fail(400, "Invalid session description.");
    if (type === "candidate" && (!input.candidate || typeof input.candidate.candidate !== "string" || JSON.stringify(input.candidate).length > 4096))
      throw fail(400, "Invalid ICE candidate.");
    if (this.db.prepare("SELECT COUNT(*) AS n FROM work_signals WHERE sender=? AND at>?").get(owner, this.now() - 10000).n > 150)
      throw fail(429, "Too many call signals.");
    return this.atomic(() => {
      this.db.prepare("UPDATE work_calls SET status=?,expires=? WHERE id=?")
        .run(type === "end" ? "ended" : type === "accept" ? "active" : call.status,
          type === "end" ? this.now() : call.status === "ringing" && type !== "accept" ? call.expires : this.now() + 60000, key);
      if (type !== "heartbeat") this.db.prepare("INSERT INTO work_signals(call,sender,body,at) VALUES (?,?,?,?)").run(key, owner, JSON.stringify(input), this.now());
      return this.call(owner, key);
    });
  }
  calls(owner) {
    this.active(owner); this.prune();
    return this.db.prepare("SELECT * FROM work_calls WHERE (caller=? OR callee=?) AND status!='ended'").all(owner, owner)
      .filter(call => { const other = call.caller === owner ? call.callee : call.caller; return this.member(other)?.status === "active"; });
  }
  signals(owner, key, after) {
    this.prune(); const call = this.call(owner, key);
    if (!Number.isSafeInteger(after) || after < 0) throw fail(400, "Invalid signal cursor.");
    return { call, signals: this.db.prepare("SELECT id,sender,body FROM work_signals WHERE call=? AND id>? AND sender!=? ORDER BY id LIMIT 200")
      .all(key, after, owner).map(row => ({ ...row, body: JSON.parse(row.body) })) };
  }
  admin() {
    return { org: this.org(), members: this.db.prepare("SELECT * FROM work_members ORDER BY at DESC LIMIT 1000").all(),
      missions: this.db.prepare("SELECT * FROM work_missions ORDER BY at DESC LIMIT 1000").all(),
      grants: this.db.prepare("SELECT * FROM work_grants ORDER BY at DESC LIMIT 100").all(),
      audit: this.db.prepare("SELECT * FROM work_audit ORDER BY id DESC LIMIT 100").all(), silver: this.silver() };
  }
}
module.exports = { Workspace, ROLES, LEVELS, STATES };
