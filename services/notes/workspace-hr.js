"use strict";
const { courses, experience, interests } = require("./work-learning");
const LEVELS = ["orientation", "learning", "practitioner", "mentor", "steward"];
const WEEK = 7 * 86400000, MONDAY = Date.UTC(1970, 0, 5);
const weekStart = now => Math.floor((now - MONDAY) / WEEK) * WEEK + MONDAY;
const fail = (status, message) => Object.assign(new Error(message), { status });
const siteTeams = [
  ["operations", "foundation", "Foundation governance", "Coordinate ecosystem priorities, risk and accountable ownership."],
  ["operations", "admin", "Administration", "Review protected cross-site operations and incident handovers."],
  ["learning", "app", "People & contribution", "Maintain onboarding, learning, reviewed tasks and fair weekly evaluations."],
  ["learning", "learning", "Learning & quality", "Review lessons, quizzes, accessibility and contributor support."],
  ["engineering", "wallet", "Wallet experience", "Validate connection, recovery, signing and public balance safety."],
  ["engineering", "db", "Data & infrastructure", "Review database integrity, backups and restore evidence."],
  ["engineering", "ledger", "Ledger reliability", "Verify service-owned activity and ledger read reliability."],
  ["engineering", "pay", "Payment experience", "Validate exact payment requests and clear recipient approval."],
  ["engineering", "world", "World product", "Review gameplay, profiles, funds separation and product quality."],
  ["research", "gold", "Gold & Ethereum", "Review Ethereum network safety and verified valuation sources."],
  ["research", "dollar", "Dollar operations", "Review native FTH$ ledger operations and conservation evidence."],
  ["research", "silver", "Silver marketplace", "Review FTHS terms, inventory, fulfillment and reward transparency."],
  ["research", "ex", "Exchange research", "Review funded pool execution, fees and market evidence."],
  ["research", "stats", "Ecosystem intelligence", "Distinguish verified circulation from estimates and report source gaps."],
  ["community", "media", "Media & moderation", "Review publication rights, moderation and reader experience."],
  ["community", "notes", "Notes & creators", "Support community notes and responsible site creation."],
  ["community", "sites", "Hosted sites", "Review hosted-site navigation, publication and deployment quality."],
  ["community", "x", "Legacy community", "Maintain safe legacy redirects and handovers to current Media services."],
];
class WorkspaceHR {
  constructor(workspace) {
    this.work = workspace; this.db = workspace.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS work_enrollment(address TEXT PRIMARY KEY,experience TEXT NOT NULL,interests TEXT NOT NULL,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS work_learning(address TEXT NOT NULL,course TEXT NOT NULL,score INTEGER NOT NULL,
        passed INTEGER NOT NULL,attempts INTEGER NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(address,course));
      CREATE TABLE IF NOT EXISTS work_positions(id TEXT PRIMARY KEY,parent TEXT,name TEXT NOT NULL,division TEXT NOT NULL,team TEXT NOT NULL,role TEXT NOT NULL,responsibility TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS work_pay_policy(effective INTEGER PRIMARY KEY,rates TEXT NOT NULL,incentive INTEGER NOT NULL,actor TEXT NOT NULL,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS work_assignments(mission TEXT NOT NULL,address TEXT NOT NULL,period INTEGER NOT NULL,
        title TEXT NOT NULL,configured INTEGER NOT NULL,base INTEGER NOT NULL,incentive INTEGER NOT NULL,
        completed INTEGER,cancelled INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(mission,address,period));
      CREATE TABLE IF NOT EXISTS work_payroll(address TEXT NOT NULL,period INTEGER NOT NULL,assigned INTEGER NOT NULL,
        accomplished INTEGER NOT NULL,qualified INTEGER NOT NULL,configured INTEGER NOT NULL,
        base INTEGER NOT NULL,incentive INTEGER NOT NULL,total INTEGER NOT NULL,status TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(address,period));
      CREATE TABLE IF NOT EXISTS work_paid_missions(mission TEXT PRIMARY KEY,address TEXT NOT NULL,period INTEGER NOT NULL);
    `);
    if (!this.db.readOnlyReplica) {
      const columns = new Set(this.db.prepare("PRAGMA table_info(work_missions)").all().map(row => row.name));
      if (!columns.has("min_level")) this.db.exec("ALTER TABLE work_missions ADD COLUMN min_level TEXT NOT NULL DEFAULT 'learning'");
      this.work.atomic(() => {
        this.db.prepare("UPDATE work_members SET status='visitor' WHERE status='pending'").run();
        this.db.prepare("INSERT OR IGNORE INTO work_positions VALUES ('foundation',NULL,'Foundation coordination','operations','','director','Coordinate governance, divisions and ecosystem priorities.')").run();
        for (const [division, name] of [["operations", "Governance & operations"], ["engineering", "Product & infrastructure"],
          ["research", "Finance & intelligence"], ["community", "Community & publishing"], ["learning", "People & learning"]]) {
          this.db.prepare("INSERT OR IGNORE INTO work_positions VALUES (?,'foundation',?,?,?,'manager',?)")
            .run(`division-${division}`, name, division, "", `Own ${name.toLowerCase()}, quality, staffing and weekly review.`);
          this.db.prepare("INSERT OR IGNORE INTO work_positions VALUES (?,?,?,?,?,'lead',?)")
            .run(`lead-${division}-general`, `division-${division}`, `${name} contributor lead`, division, `${division}-general`, "Support new members, assign clear tasks and review contributor evidence.");
          this.db.prepare("INSERT OR IGNORE INTO work_positions VALUES (?,?,?,?,?,'contributor',?)")
            .run(`contributors-${division}-general`, `lead-${division}-general`, `${name} contributors`, division, `${division}-general`, "Learn the ecosystem, deliver verified improvements and report blockers.");
          this.db.prepare(`INSERT OR IGNORE INTO work_missions(id,title,body,division,team,assignee,status,evidence,revision,at,min_level)
            VALUES (?,?,?,?,?,'','ready','',1,?,'learning')`)
            .run(`orientation-${division}`, `${name}: contributor checklist`, "Acceptance: review the division's ecosystem responsibilities, submit a public-safe checklist of verified improvements and hand it over for manager review.", division, `${division}-general`, this.work.now());
        }
        for (const [division, site, name, responsibility] of siteTeams) {
          const team = `${division}-${site}`;
          this.db.prepare("INSERT OR IGNORE INTO work_teams VALUES (?,?,?)").run(team, division, name);
          this.db.prepare("INSERT OR IGNORE INTO work_channels VALUES (?,?, 'team',?)").run(`team-${team}`, name, team);
          this.db.prepare("INSERT OR IGNORE INTO work_positions VALUES (?,?,?,?,?,'lead',?)")
            .run(`lead-${site}`, `division-${division}`, name, division, team, responsibility);
          this.db.prepare("INSERT OR IGNORE INTO work_positions VALUES (?,?,?,?,?,'contributor',?)")
            .run(`contributors-${site}`, `lead-${site}`, `${name} contributors`, division, team, "Deliver assigned work with evidence; report blockers and complete learning.");
          this.db.prepare(`INSERT OR IGNORE INTO work_missions(id,title,body,division,team,assignee,status,evidence,revision,at,min_level)
            VALUES (?,?,?,?,?,'','ready','',1,?,'learning')`)
            .run(`ecosystem-${site}`, `${name}: weekly quality review`, `${responsibility} Acceptance: provide a public-safe checklist, verified findings and a concrete handover. Never attach secrets.`, division, team, this.work.now());
        }
      });
    }
  }
  start() {
    if (this.timer || this.db.readOnlyReplica) return;
    this.settleDue();
    this.timer = setInterval(() => {
      try { this.settleDue(); }
      catch (error) { console.error("Weekly App evaluation failed:", error); }
    }, 60000);
    this.timer.unref();
  }
  close() { clearInterval(this.timer); this.timer = null; }
  enrollment(owner) {
    const row = this.db.prepare("SELECT * FROM work_enrollment WHERE address=?").get(owner);
    return row ? { ...row, interests: JSON.parse(row.interests) } : null;
  }
  enroll(owner, input) {
    if (!experience.some(choice => choice.id === input?.experience) || !Array.isArray(input?.interests)
      || !input.interests.length || input.interests.length > interests.length
      || new Set(input.interests).size !== input.interests.length || input.interests.some(key => !interests.some(choice => choice.id === key)))
      throw fail(400, "Choose your experience and at least one valid work interest.");
    this.db.prepare(`INSERT INTO work_enrollment VALUES (?,?,?,?) ON CONFLICT(address) DO UPDATE SET
      experience=excluded.experience,interests=excluded.interests,at=excluded.at`)
      .run(owner, input.experience, JSON.stringify(input.interests), this.work.now());
  }
  learning(owner) {
    const member = this.work.member(owner);
    const progress = this.db.prepare("SELECT course,score,passed,attempts,at FROM work_learning WHERE address=?").all(owner);
    const stage = member?.status === "active" ? member.level : "orientation";
    return { passPercent: 80, stage, experience, interests, enrollment: this.enrollment(owner),
      courses: courses.filter(course => LEVELS.indexOf(course.level) <= LEVELS.indexOf(stage)).map(course => ({
        id: course.id, level: course.level, title: course.title, body: course.body, sites: course.sites,
        questions: course.questions.map(({ prompt, options }) => ({ prompt, options })),
        progress: progress.find(row => row.course === course.id) || null,
      })) };
  }
  quiz(owner, key, input) {
    this.settleDue();
    const member = this.work.member(owner), course = courses.find(row => row.id === key);
    if (!member || !["visitor", "active"].includes(member.status)) throw fail(403, "Register as a visitor before taking quizzes.");
    if (!this.enrollment(owner)) throw fail(409, "Choose your experience and work interests before learning.");
    const stage = member.status === "active" ? member.level : "orientation";
    if (!course || LEVELS.indexOf(course.level) > LEVELS.indexOf(stage)) throw fail(403, "Complete your current learning level before this quiz.");
    const answers = input?.answers;
    if (!Array.isArray(answers) || answers.length !== course.questions.length
      || answers.some((value, index) => !Number.isInteger(value) || value < 0 || value >= course.questions[index].options.length))
      throw fail(400, "Answer every quiz question with a valid option.");
    const correct = answers.filter((answer, index) => answer === course.questions[index].answer).length;
    const score = Math.floor(correct * 100 / answers.length), passed = score >= 80;
    return this.work.atomic(() => {
      this.db.prepare(`INSERT INTO work_learning VALUES (?,?,?,?,1,?) ON CONFLICT(address,course) DO UPDATE SET
        score=MAX(work_learning.score,excluded.score),passed=MAX(work_learning.passed,excluded.passed),
        attempts=work_learning.attempts+1,at=excluded.at`).run(owner, key, score, Number(passed), this.work.now());
      const required = courses.filter(row => row.level === stage);
      const complete = required.length && required.every(row => this.db.prepare("SELECT passed FROM work_learning WHERE address=? AND course=?").get(owner, row.id)?.passed);
      if (complete && stage !== "steward") {
        const next = LEVELS[LEVELS.indexOf(stage) + 1];
        if (member.status === "visitor") {
          const division = this.enrollment(owner).interests[0];
          this.db.prepare("UPDATE work_members SET status='active',level=?,role='volunteer',division=?,team=? WHERE address=?")
            .run(next, division, `${division}-general`, owner);
        } else this.db.prepare("UPDATE work_members SET level=? WHERE address=?").run(next, owner);
        this.work.audit(owner, "learning.advance", owner, { previous: stage, level: next });
      }
      this.work.audit(owner, "learning.quiz", key, { score, passed });
      return { score, passed, member: this.work.member(owner) };
    });
  }
  chart() {
    return this.db.prepare("SELECT * FROM work_positions ORDER BY id").all().map(position => ({
      ...position, members: this.db.prepare(`SELECT address,role,level FROM work_members WHERE status='active' AND
        (?='director' OR division=?) AND (?='' OR team=?) AND (role=? OR ?='contributor' AND role IN ('volunteer','intern'))
        ORDER BY address`).all(position.role, position.division, position.team, position.team, position.role, position.role),
    }));
  }
  policy(period = weekStart(this.work.now())) {
    const row = this.db.prepare("SELECT * FROM work_pay_policy WHERE effective<=? ORDER BY effective DESC LIMIT 1").get(period);
    return row ? { ...row, rates: JSON.parse(row.rates) } : null;
  }
  configure(actor, input) {
    const rates = input?.rates, incentive = input?.incentive;
    if (!rates || typeof rates !== "object" || Array.isArray(rates) || Object.keys(rates).length !== LEVELS.length
      || LEVELS.some(level => !Number.isSafeInteger(rates[level]) || rates[level] < 0 || rates[level] > 1000000000)
      || !Number.isSafeInteger(incentive) || incentive < 0 || incentive > 1000000000
      || input.approval !== "CONFIGURE WEEKLY FTHS")
      throw fail(400, "Configure whole-unit base amounts for every level and a task incentive, then confirm CONFIGURE WEEKLY FTHS.");
    const effective = weekStart(this.work.now()) + WEEK;
    this.work.atomic(() => {
      this.db.prepare("INSERT OR REPLACE INTO work_pay_policy VALUES (?,?,?,?,?)")
        .run(effective, JSON.stringify(rates), incentive, actor, this.work.now());
      this.work.audit(actor, "payroll.configure", String(effective), { rates, incentive });
    });
    return { effective, rates, incentive };
  }
  track(mission, period = weekStart(this.work.now())) {
    if (!mission.assignee || ["draft", "cancelled"].includes(mission.status)) return;
    const policy = this.policy(period), member = this.work.member(mission.assignee);
    const existing = this.db.prepare("SELECT base FROM work_assignments WHERE address=? AND period=? LIMIT 1").get(mission.assignee, period);
    this.db.prepare(`INSERT OR IGNORE INTO work_assignments(mission,address,period,title,configured,base,incentive)
      VALUES (?,?,?,?,?,?,?)`).run(mission.id, mission.assignee, period, mission.title,
        Number(!!policy), existing ? existing.base : policy ? policy.rates[member.level] : 0, policy ? policy.incentive : 0);
    this.db.prepare("UPDATE work_assignments SET completed=? WHERE mission=? AND address=? AND period=?")
      .run(mission.status === "done" ? this.work.now() : null, mission.id, mission.assignee, period);
  }
  updateAssignment(previous, mission) {
    const period = weekStart(this.work.now());
    if (previous?.assignee && previous.assignee !== mission.assignee)
      this.db.prepare("UPDATE work_assignments SET cancelled=1 WHERE mission=? AND address=? AND period=?").run(previous.id, previous.assignee, period);
    if (mission.status === "cancelled") this.db.prepare("UPDATE work_assignments SET cancelled=1 WHERE mission=? AND period=?").run(mission.id, period);
    else if (previous?.status === "done" && mission.status === "done") return;
    else {
      this.track(mission);
      this.db.prepare("UPDATE work_assignments SET cancelled=0 WHERE mission=? AND address=? AND period=?").run(mission.id, mission.assignee, period);
    }
  }
  claim(owner, key, input) {
      const member = this.work.active(owner);
      const mission = this.db.prepare("SELECT * FROM work_missions WHERE id=?").get(key);
      if (!mission || mission.division !== member.division || mission.team !== member.team
        || LEVELS.indexOf(mission.min_level) > LEVELS.indexOf(member.level)) throw fail(404, "Task is unavailable for your team or level.");
      if (mission.assignee || mission.status !== "ready" || mission.revision !== input?.revision) throw fail(409, "Task changed or is already assigned. Reload the agenda.");
      return this.work.atomic(() => {
        this.db.prepare("UPDATE work_missions SET assignee=?,revision=revision+1,at=? WHERE id=?").run(owner, this.work.now(), key);
        const assigned = this.db.prepare("SELECT * FROM work_missions WHERE id=?").get(key);
        this.track(assigned);
        this.work.audit(owner, "mission.claim", key, { period: weekStart(this.work.now()) });
        return assigned;
      });
  }
  revoke(owner) {
    this.db.prepare(`UPDATE work_members SET status=CASE WHEN status='active' THEN 'visitor' ELSE status END,
      role='volunteer',level='orientation',division='learning',team='learning-general' WHERE address=?`).run(owner);
    this.db.prepare("DELETE FROM work_learning WHERE address=?").run(owner);
    this.db.prepare("DELETE FROM work_push WHERE address=?").run(owner);
    this.db.prepare("UPDATE work_calls SET status='ended' WHERE caller=? OR callee=?").run(owner, owner);
    this.db.prepare(`UPDATE work_missions SET assignee='',status=CASE WHEN status IN ('ready','in_progress','review')
      THEN 'ready' ELSE status END,revision=revision+1,at=? WHERE assignee=? AND status!='done'`).run(this.work.now(), owner);
  }
  settleDue() {
    const current = weekStart(this.work.now());
    if (this.settling || this.work.inTransaction || this.db.readOnlyReplica || this.lastWeek === current) return;
    this.settling = true;
    try {
      const query = this.db.prepare(`SELECT DISTINCT a.address,a.period FROM work_assignments a
        LEFT JOIN work_payroll p ON p.address=a.address AND p.period=a.period
        WHERE a.period<? AND p.address IS NULL ORDER BY a.period,a.address`);
      let due = query.all(current);
      while (due.length) {
        for (const cycle of due) this.work.atomic(() => this.settle(cycle.address, cycle.period));
        due = query.all(current);
      }
      // Unfinished assignments carry into the current week only for members who retained access.
      this.work.atomic(() => {
        for (const mission of this.db.prepare(`SELECT m.* FROM work_missions m JOIN work_members u ON u.address=m.assignee
          WHERE u.status='active' AND m.status IN ('ready','in_progress','review')`).all()) this.track(mission);
      });
      this.lastWeek = current;
    } finally { this.settling = false; }
  }
  settle(owner, period) {
    const assignments = this.db.prepare("SELECT * FROM work_assignments WHERE address=? AND period=? AND cancelled=0").all(owner, period);
    if (!assignments.length) {
      this.db.prepare("INSERT OR IGNORE INTO work_payroll VALUES (?,?,0,0,1,0,0,0,0,'no_assignments',?)").run(owner, period, this.work.now());
      return;
    }
    const completed = assignments.filter(row => row.completed !== null && row.completed < period + WEEK);
    const qualified = completed.length * 100 > assignments.length * 60;
    const configured = assignments.every(row => row.configured);
    const base = configured && qualified ? assignments[0].base : 0;
    const payable = completed.filter(row => !this.db.prepare("SELECT 1 FROM work_paid_missions WHERE mission=?").get(row.mission)
      && !this.db.prepare("SELECT 1 FROM work_grants WHERE mission=?").get(row.mission));
    const incentive = configured ? payable.reduce((sum, row) => sum + row.incentive, 0) : 0, total = base + incentive;
    if (!Number.isSafeInteger(total)) throw fail(409, "Weekly payroll exceeds safe reward limits. Review the configured policy.");
    if (total) {
      const supply = this.db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM notes_entries WHERE symbol='FTHS'").get().n;
      if (!Number.isSafeInteger(supply + total) || !Number.isSafeInteger(this.work.notes.balance(owner, "FTHS") + total))
        throw fail(409, "Silver supply exceeds safe unit limits.");
      this.db.prepare("INSERT INTO notes_entries(address,amount,kind,other,at,site,symbol) VALUES (?,?,'silver_weekly_reward',?,?,'featheral-app','FTHS')")
        .run(owner, total, `${owner}:${period}`, this.work.now());
    }
    if (configured) for (const row of payable)
      this.db.prepare("INSERT INTO work_paid_missions VALUES (?,?,?)").run(row.mission, owner, period);
    this.db.prepare("INSERT INTO work_payroll VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(owner, period, assignments.length, completed.length, Number(qualified), Number(configured), base, incentive, total,
        configured ? "recorded" : "unconfigured", this.work.now());
    if (!qualified) this.revoke(owner);
    else if (this.work.member(owner)?.status === "active") {
      for (const row of assignments.filter(row => row.completed === null)) {
        const mission = this.db.prepare("SELECT * FROM work_missions WHERE id=?").get(row.mission);
        if (mission?.assignee === owner && !["done", "cancelled", "draft"].includes(mission.status)) this.track(mission, period + WEEK);
      }
    }
    this.work.audit("weekly-evaluation", "payroll.settle", owner, { period, assigned: assignments.length,
      accomplished: completed.length, qualified, configured, base, incentive, total });
  }
  compensation(owner) {
    this.settleDue();
    const period = weekStart(this.work.now()), assignments = this.db.prepare("SELECT * FROM work_assignments WHERE address=? AND period=? AND cancelled=0").all(owner, period);
    const policy = this.policy(), level = this.work.member(owner)?.level || "orientation";
    return { period, ends: period + WEEK, threshold: 60, assigned: assignments.length,
      accomplished: assignments.filter(row => row.completed !== null).length,
      configured: assignments.length ? assignments.every(row => row.configured) : !!policy,
      base: assignments.length ? assignments[0].base : policy ? policy.rates[level] : 0,
      incentivePerTask: assignments.length ? assignments[0].incentive : policy ? policy.incentive : 0,
      history: this.db.prepare("SELECT * FROM work_payroll WHERE address=? AND status!='no_assignments' ORDER BY period DESC LIMIT 52").all(owner) };
  }
}
module.exports = { WorkspaceHR, weekStart, WEEK };
