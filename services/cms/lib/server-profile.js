"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const v8 = require("node:v8");
const { monitorEventLoopDelay, performance } = require("node:perf_hooks");
const express = require("express");

const SAMPLE_MS = 1000;
const HISTORY_SIZE = 60;
const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", "artifacts", "cache", "coverage", "dist", "out"]);
const DATABASE_FILE = /\.(?:sqlite|sqlite3|db)(?:-(?:wal|shm|journal))?$/i;
const CATEGORY_NAMES = ["databases", "ledgers", "uploads", "trash", "codebase", "otherData"];
const emptyCategories = () => Object.fromEntries(CATEGORY_NAMES.map(name => [name, { bytes: 0, files: 0 }]));
const percentile = (values, fraction) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
};

class ServerProfile {
  constructor({ root, dataDirectory, externalDirectories = [], networkLimitBytesPerSecond = null, now = Date.now, autoStart = true } = {}) {
    if (!root) throw new TypeError("A repository root is required.");
    this.root = path.resolve(root);
    this.dataDirectory = dataDirectory ? path.resolve(dataDirectory) : null;
    this.externalDirectories = externalDirectories.filter(entry => typeof entry === "string" ? Boolean(entry) : Boolean(entry?.directory)).map(entry => typeof entry === "string"
      ? { directory: path.resolve(entry), category: null }
      : { directory: path.resolve(entry.directory), category: entry.category || null });
    this.networkLimitBytesPerSecond = Number.isFinite(networkLimitBytesPerSecond) && networkLimitBytesPerSecond > 0
      ? networkLimitBytesPerSecond : null;
    this.now = now;
    this.loopDelay = monitorEventLoopDelay({ resolution: 20 });
    this.loopDelay.enable();
    this.history = [];
    this.buckets = [];
    this.current = this.newBucket();
    this.previousCpu = process.cpuUsage();
    this.previousCpuAt = performance.now();
    this.previousHostCpus = os.cpus();
    this.storage = {
      updatedAt: null, scanning: false, complete: false, scanError: null,
      categories: emptyCategories(), totalBytes: 0, totalFiles: 0,
    };
    this.disk = { available: false, error: "Waiting for filesystem sample." };
    this.closed = false;
    if (autoStart) {
      this.sample();
      this.sampleTimer = setInterval(() => this.sample(), SAMPLE_MS);
      this.sampleTimer.unref?.();
      this.storageTimer = setInterval(() => { this.refreshStorage(); }, 300000);
      this.storageTimer.unref?.();
      this.refreshStorage();
    }
  }

  newBucket() {
    return { at: this.now(), requests: 0, completed: 0, requestBytes: 0, responseBytes: 0, errors: 0, latencies: [], latencyCount: 0 };
  }

  recordRequest(req, res) {
    const started = performance.now();
    this.current.requests++;
    const declaredBytes = Number(req.headers["content-length"]);
    if (Number.isSafeInteger(declaredBytes) && declaredBytes > 0) this.current.requestBytes += declaredBytes;
    const countChunk = (chunk, encoding) => {
      if (typeof chunk === "string") this.current.responseBytes += Buffer.byteLength(chunk, typeof encoding === "string" ? encoding : "utf8");
      else if (Buffer.isBuffer(chunk) || ArrayBuffer.isView(chunk)) this.current.responseBytes += chunk.byteLength;
    };
    const write = res.write;
    const end = res.end;
    res.write = function (...args) { countChunk(args[0], args[1]); return write.apply(this, args); };
    res.end = function (...args) { countChunk(args[0], args[1]); return end.apply(this, args); };
    res.once("finish", () => {
      const duration = Math.max(0, performance.now() - started);
      this.current.completed++;
      if (res.statusCode >= 500) this.current.errors++;
      this.current.latencyCount++;
      if (this.current.latencies.length < 500) this.current.latencies.push(duration);
      else {
        const index = Math.floor(Math.random() * this.current.latencyCount);
        if (index < this.current.latencies.length) this.current.latencies[index] = duration;
      }
    });
  }

  sample() {
    if (this.closed) return;
    const now = this.now();
    const elapsedMs = Math.max(1, performance.now() - this.previousCpuAt);
    const cpu = process.cpuUsage(this.previousCpu);
    const processCpuPct = (cpu.user + cpu.system) / (elapsedMs * 1000) * 100;
    this.previousCpu = process.cpuUsage();
    this.previousCpuAt = performance.now();
    const currentCpus = os.cpus();
    let idle = 0, total = 0;
    currentCpus.forEach((current, index) => {
      const previous = this.previousHostCpus[index];
      if (!previous) return;
      for (const key of Object.keys(current.times)) {
        const delta = current.times[key] - previous.times[key];
        total += delta;
        if (key === "idle") idle += delta;
      }
    });
    this.previousHostCpus = currentCpus;
    const memory = process.memoryUsage();
    const heapLimit = v8.getHeapStatistics().heap_size_limit;
    const point = {
      at: now,
      processCpuPct: Number(processCpuPct.toFixed(2)),
      hostCpuPct: total ? Number(((total - idle) / total * 100).toFixed(2)) : null,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapLimitBytes: heapLimit,
      eventLoopP95Ms: Number((this.loopDelay.percentile(95) / 1e6).toFixed(2)),
      eventLoopMaxMs: Number((this.loopDelay.max / 1e6).toFixed(2)),
      requestsPerSecond: this.current.requests,
      requestBytesPerSecond: this.current.requestBytes,
      responseBytesPerSecond: this.current.responseBytes,
    };
    this.loopDelay.reset();
    this.history.push(point);
    if (this.history.length > HISTORY_SIZE) this.history.shift();
    this.buckets.push(this.current);
    if (this.buckets.length > HISTORY_SIZE) this.buckets.shift();
    this.current = this.newBucket();
  }

  async refreshStorage() {
    if (this.storage.scanning || this.closed) return;
    this.storage.scanning = true;
    const categories = emptyCategories();
    let complete = true, scanError = null;
    const roots = [{ directory: this.root, label: "repository" }];
    for (const { directory, category } of this.externalDirectories) {
      const relative = path.relative(this.root, directory);
      if (directory === this.root || (!relative.startsWith("..") && !path.isAbsolute(relative))) continue;
      const overlaps = roots.some(root => {
        const fromRoot = path.relative(root.directory, directory);
        const fromDirectory = path.relative(directory, root.directory);
        return root.directory === directory || !path.isAbsolute(fromRoot) && !fromRoot.startsWith("..")
          || !path.isAbsolute(fromDirectory) && !fromDirectory.startsWith("..");
      });
      if (!overlaps) roots.push({ directory, category, label: `external-${roots.length}` });
    }
    const visit = async (directory, relativeParts = [], dataRoot = false, categoryHint = null) => {
      let entries;
      try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); }
      catch (error) {
        if (error.code === "ENOENT") return;
        complete = false;
        scanError = "Some filesystem entries could not be inspected.";
        return;
      }
      const files = [];
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          const name = entry.name.toLowerCase();
          const managedData = dataRoot || name === "data" || relativeParts.some(part => ["uploads", "trash"].includes(part.toLowerCase()));
          if (EXCLUDED_DIRECTORIES.has(name) && !managedData) continue;
          const parts = [...relativeParts, entry.name];
          const childDirectory = path.join(directory, entry.name);
          const childHint = categoryHint || this.externalDirectories.find(configured => {
            const relative = path.relative(configured.directory, childDirectory);
            return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
          })?.category || null;
          await visit(childDirectory, parts, dataRoot || entry.name.toLowerCase() === "data", childHint);
        } else if (entry.isFile()) files.push(entry);
      }
      for (let offset = 0; offset < files.length; offset += 64) {
        const inspected = await Promise.all(files.slice(offset, offset + 64).map(async entry => {
          try { return { entry, info: await fs.promises.lstat(path.join(directory, entry.name)) }; }
          catch (error) { return { entry, error }; }
        }));
        for (const { entry, info, error } of inspected) {
          if (error) {
            if (error.code !== "ENOENT") {
              complete = false;
              scanError = "Some filesystem entries could not be inspected.";
            }
            continue;
          }
          if (!info.isFile()) continue;
          const parts = [...relativeParts, entry.name], lower = parts.map(part => part.toLowerCase());
          const name = entry.name.toLowerCase(), filePath = path.resolve(directory, entry.name);
          const dataRelative = this.dataDirectory ? path.relative(this.dataDirectory, filePath) : null;
          const inDataDirectory = dataRelative === "" || dataRelative !== null &&
            dataRelative !== ".." && !dataRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(dataRelative);
          let category = "codebase";
          if (DATABASE_FILE.test(name)) category = "databases";
          else if (lower.includes("trash")) category = "trash";
          else if (lower.includes("uploads")) category = "uploads";
          else if (lower.some(part => part.includes("ledger") || ["journals", "blocks"].includes(part))) category = "ledgers";
          else if (categoryHint) category = categoryHint;
          else if (dataRoot || inDataDirectory) category = "otherData";
          categories[category].bytes += info.size;
          categories[category].files++;
        }
      }
    };
    try {
      for (const root of roots) {
        try {
          const info = await fs.promises.lstat(root.directory);
          if (!info.isDirectory() || info.isSymbolicLink()) {
            complete = false;
            scanError = "A configured storage directory could not be inspected.";
            continue;
          }
        } catch {
          complete = false;
          scanError = "A configured storage directory could not be inspected.";
          continue;
        }
        await visit(root.directory, [], false, root.category || null);
      }
      let disk;
      try {
        const stat = await fs.promises.statfs(this.root);
        const totalBytes = Number(stat.blocks) * Number(stat.bsize);
        const freeBytes = Number(stat.bavail) * Number(stat.bsize);
        disk = { available: true, totalBytes, freeBytes, usedBytes: Math.max(0, totalBytes - freeBytes),
          usedPct: totalBytes ? Number(((totalBytes - freeBytes) / totalBytes * 100).toFixed(2)) : null };
      } catch {
        disk = { available: false, error: "Filesystem capacity is unavailable on this platform." };
      }
      this.disk = disk;
      const values = Object.values(categories);
      this.storage = { updatedAt: this.now(), scanning: false, complete, scanError,
        categories, totalBytes: values.reduce((sum, item) => sum + item.bytes, 0),
        totalFiles: values.reduce((sum, item) => sum + item.files, 0) };
    } catch (error) {
      console.error("Server profile storage scan failed:", error.code || error.name || "Error");
      this.storage = { ...this.storage, scanning: false, complete: false, scanError: "Storage inventory scan failed." };
    } finally {
      if (this.storage.scanning) this.storage.scanning = false;
    }
  }

  risks(metrics) {
    const risks = [];
    const disk = this.disk;
    if (disk.available && disk.usedPct !== null) {
      const severity = disk.usedPct >= 95 ? "critical" : disk.usedPct >= 85 ? "warning" : "healthy";
      risks.push({ key: "disk", severity, message: `${disk.usedPct}% of the filesystem is used; ${Math.round(disk.freeBytes / 1024 ** 3 * 10) / 10} GB is available.` });
    } else risks.push({ key: "disk", severity: "unknown", message: disk.error });
    const heapPct = metrics.heapLimitBytes ? metrics.heapUsedBytes / metrics.heapLimitBytes * 100 : null;
    const memoryPct = metrics.memoryTotalBytes ? (metrics.memoryTotalBytes - metrics.memoryFreeBytes) / metrics.memoryTotalBytes * 100 : null;
    if (heapPct !== null) risks.push({ key: "memory", severity: heapPct >= 95 || memoryPct >= 95 ? "critical" : heapPct >= 80 || memoryPct >= 85 ? "warning" : "healthy",
      message: `Process heap ${heapPct.toFixed(1)}% of its V8 limit; host memory ${memoryPct === null ? "unavailable" : `${memoryPct.toFixed(1)}% used`}.` });
    else risks.push({ key: "memory", severity: "unknown", message: "Memory limits are unavailable." });
    const cpuPct = metrics.processCpuPct;
    const loopMs = metrics.eventLoopP95Ms;
    const cpuSeverity = cpuPct >= 95 || loopMs >= 250 ? "critical" : cpuPct >= 80 || loopMs >= 100 ? "warning" : "healthy";
    risks.push({ key: "compute", severity: cpuSeverity, message: `Process CPU ${cpuPct.toFixed(1)}% of one core; event-loop p95 ${loopMs.toFixed(1)} ms.` });
    const totalRequests = this.buckets.reduce((sum, bucket) => sum + bucket.requests, 0);
    const completedRequests = this.buckets.reduce((sum, bucket) => sum + bucket.completed, 0);
    const totalErrors = this.buckets.reduce((sum, bucket) => sum + bucket.errors, 0);
    const errorPct = completedRequests ? totalErrors / completedRequests * 100 : 0;
    risks.push({ key: "usage", severity: errorPct >= 20 ? "critical" : errorPct >= 5 ? "warning" : "healthy",
      message: `${totalRequests} HTTP requests observed in the last minute; ${errorPct.toFixed(1)}% returned server errors.` });
    const bytesPerSecond = this.buckets.reduce((sum, bucket) => sum + bucket.responseBytes, 0) / Math.max(1, this.buckets.length);
    const networkPct = this.networkLimitBytesPerSecond ? bytesPerSecond / this.networkLimitBytesPerSecond * 100 : null;
    const networkSeverity = networkPct === null ? "unknown" : networkPct >= 95 ? "critical" : networkPct >= 80 ? "warning" : "healthy";
    risks.push({ key: "network", severity: networkSeverity, message: networkPct === null
      ? `HTTP response traffic ${formatRate(bytesPerSecond)} average; set SERVER_PROFILE_NETWORK_LIMIT_BPS to assess configured capacity.`
      : `HTTP response traffic ${formatRate(bytesPerSecond)} average, ${networkPct.toFixed(1)}% of configured capacity.` });
    return risks;
  }

  snapshot() {
    const latest = this.history[this.history.length - 1] || {
      at: this.now(), processCpuPct: 0, hostCpuPct: null, rssBytes: process.memoryUsage().rss,
      heapUsedBytes: process.memoryUsage().heapUsed, heapLimitBytes: v8.getHeapStatistics().heap_size_limit,
      eventLoopP95Ms: 0, eventLoopMaxMs: 0, requestsPerSecond: 0, requestBytesPerSecond: 0, responseBytesPerSecond: 0,
    };
    const memory = os.totalmem(), free = os.freemem();
    const metrics = { ...latest, uptimeSeconds: Math.floor(process.uptime()), memoryTotalBytes: memory, memoryFreeBytes: free,
      requestCount60s: this.buckets.reduce((sum, bucket) => sum + bucket.requests, 0),
      requestBytes60s: this.buckets.reduce((sum, bucket) => sum + bucket.requestBytes, 0),
      responseBytes60s: this.buckets.reduce((sum, bucket) => sum + bucket.responseBytes, 0),
      completedRequestCount60s: this.buckets.reduce((sum, bucket) => sum + bucket.completed, 0),
      latencyP95Ms: percentile(this.buckets.flatMap(bucket => bucket.latencies), 0.95),
      latencySampleCount: this.buckets.reduce((sum, bucket) => sum + bucket.latencies.length, 0) };
    return { sampledAt: this.now(), metrics, disk: this.disk, storage: this.storage,
      history: this.history, risks: this.risks(metrics),
      notes: { cpu: "Process CPU is normalized to one logical core; values can exceed 100%.",
        network: "Request bytes use declared Content-Length; response body bytes are measured by the gateway, excluding headers. Network-interface capacity is unavailable unless configured.",
        storage: "Repository code inventory excludes .git, node_modules, artifacts, cache, coverage, dist and out. Those names are still counted inside data, upload and trash trees. Symlinks are not followed." } };
  }

  close() {
    this.closed = true;
    clearInterval(this.sampleTimer);
    clearInterval(this.storageTimer);
    this.loopDelay.disable();
  }
}

function formatRate(bytes) {
  if (bytes < 1024) return `${bytes.toFixed(0)} B/s`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB/s`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MB/s`;
}

function serverProfileApi({ service, cmsAuth, passwordConfigured, adminHost = "admin.featheral.com" }) {
  const router = express.Router();
  let lastRefreshAt = 0;
  router.use((req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    if (![adminHost, "admin.localhost"].includes(req.hostname)) return res.status(404).json({ error: "Use the administration site." });
    const secure = req.secure || req.get("x-forwarded-proto") === "https";
    const local = req.hostname === "admin.localhost" && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
    if (!secure && !local) return res.status(403).json({ error: "Server profile requires HTTPS." });
    if (!passwordConfigured && !local) return res.status(503).json({ error: "Set CMS_PASSWORD before using the server profile." });
    cmsAuth(req, res, next);
  });
  router.get("/", (_req, res) => res.json(service.snapshot()));
  router.post("/refresh", express.json({ limit: "1kb" }), (req, res) => {
    const protocol = req.secure || req.get("x-forwarded-proto") === "https" ? "https" : "http";
    if (req.get("origin") !== `${protocol}://${req.get("host")}`) return res.status(403).json({ error: "Same-origin server profile requests are required." });
    if (Date.now() - lastRefreshAt < 15000) return res.status(429).json({ error: "A storage rescan was requested recently. Wait before requesting another." });
    lastRefreshAt = Date.now();
    service.refreshStorage();
    res.status(202).json({ scanning: true });
  });
  return router;
}

module.exports = { ServerProfile, serverProfileApi, percentile, formatRate };
