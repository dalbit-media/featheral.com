"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { readReplica } = require("../../operations/replica");
const { cleanupStorage, DAY } = require("../../operations/storage-cleanup");
const WEEK = 7 * DAY;

class Maintenance {
  constructor({ root, sites, publicByKey, invalidateSite, deployment, siteSync, busy = () => false,
    now = Date.now, logger = console, replica = () => !!readReplica(root), cleanup = cleanupStorage }) {
    Object.assign(this, { root, sites, publicByKey, invalidateSite, deployment, siteSync, busy, now, logger, replica, cleanup });
    this.file = path.join(root, "data", "maintenance", "state.json");
    this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, "utf8")) : { sites: {} };
    if (!this.state.sites || typeof this.state.sites !== "object" || Array.isArray(this.state.sites))
      throw new Error("Invalid maintenance state");
  }
  saveSite(key, schedule) {
    const state = { ...this.state, sites: { ...this.state.sites } };
    if (schedule) state.sites[key] = schedule;
    else delete state.sites[key];
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file + ".tmp", JSON.stringify(state), { mode: 0o600, flush: true });
    fs.renameSync(this.file + ".tmp", this.file);
    this.state = state;
  }
  runNow() {
    if (this.busy() || this.deployment?.running || this.siteSync?.running)
      throw Object.assign(new Error("A server operation is active. Wait before cleaning storage."), { status: 409 });
    const now = this.now();
    const temporary = this.cleanup({ root: this.root, apply: true, now, deployment: this.deployment, siteSync: this.siteSync });
    if (temporary.blocked) throw Object.assign(new Error("Storage cleanup is blocked by an active server operation."), { status: 409 });
    this.logger.info(`Manual storage cleanup removed ${temporary.candidates.length} temporary entries (${temporary.removedBytes} bytes).`);
    const result = { temporary, sites: [], errors: [], trashSkipped: null };
    if (this.replica()) {
      result.trashSkipped = "This server is a read-only replica. Trash must be emptied on the writable source and synced normally.";
      return result;
    }
    for (const site of this.sites()) {
      try {
        const pub = this.publicByKey(site.key);
        const weeklyTrash = pub.cms.siteSettings().weeklyTrash;
        let trash;
        try { trash = pub.emptyTrash(); }
        finally { this.invalidateSite(site.key); }
        result.sites.push({ key: site.key, hostname: site.hostname, ...trash });
        if (weeklyTrash)
          this.saveSite(site.key, { nextTrashAt: now + WEEK, lastTrashAt: now, result: trash });
        this.logger.info(`Manual storage cleanup for ${site.hostname || site.key}: ${trash.posts} posts, ${trash.files} files, ${trash.bytes} bytes permanently deleted.`);
      } catch (error) {
        this.logger.error(`Manual storage cleanup failed for ${site.key}:`, error);
        result.errors.push({ key: site.key, message: error.message });
      }
    }
    return result;
  }
  tick() {
    try {
      if (this.busy() || this.deployment?.running || this.siteSync?.running) return;
      const now = this.now();
      const report = this.cleanup({ root: this.root, apply: true, now, deployment: this.deployment, siteSync: this.siteSync });
      if (report.blocked) return;
      if (report.candidates.length) this.logger.info(`Storage maintenance removed ${report.candidates.length} temporary entries (${report.removedBytes} bytes).`);
      // Staging is disposable on replicas, but their published data must never be purged.
      if (this.replica()) return;
      for (const site of this.sites()) {
        try {
          const pub = this.publicByKey(site.key);
          if (!pub.cms.siteSettings().weeklyTrash) {
            if (this.state.sites[site.key]) this.saveSite(site.key, null);
            continue;
          }
          const previous = this.state.sites[site.key];
          if (!previous) {
            this.saveSite(site.key, { nextTrashAt: now + WEEK });
            continue;
          }
          if (!Number.isFinite(previous.nextTrashAt)) throw new Error("Invalid weekly trash schedule");
          if (previous.nextTrashAt > now) continue;
          let result;
          try { result = pub.emptyTrash(); }
          finally { this.invalidateSite(site.key); }
          this.saveSite(site.key, { nextTrashAt: now + WEEK, lastTrashAt: now, result });
          this.logger.info(`Weekly trash maintenance for ${site.hostname || site.key}: ${result.posts} posts, ${result.files} files, ${result.bytes} bytes permanently deleted.`);
        } catch (error) {
          this.logger.error(`Weekly trash maintenance failed for ${site.key}:`, error);
        }
      }
    } catch (error) { this.logger.error("Storage maintenance failed:", error); }
  }
  start() {
    if (this.timer) return;
    this.initial = setTimeout(() => this.tick(), 60000);
    this.initial.unref();
    this.timer = setInterval(() => this.tick(), 60 * 60 * 1000);
    this.timer.unref();
  }
  close() {
    clearTimeout(this.initial);
    clearInterval(this.timer);
    this.timer = null;
  }
}
module.exports = { Maintenance, WEEK };
