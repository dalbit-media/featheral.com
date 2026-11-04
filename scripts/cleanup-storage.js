#!/usr/bin/env node
"use strict";
const path = require("node:path");
const { cleanupStorage } = require("../services/operations/storage-cleanup");

const root = path.resolve(__dirname, ".."), args = process.argv.slice(2);
try {
  if (args.some(arg => arg !== "--apply" && !/^--min-age-hours=\d+(?:\.\d+)?$/.test(arg)))
    throw new Error("Use [--apply] [--min-age-hours=24]. Zero is only for reviewed, inactive staging.");
  const hours = args.find(arg => arg.startsWith("--min-age-hours="))?.split("=")[1] ?? 24;
  console.log(JSON.stringify(cleanupStorage({ root, apply: args.includes("--apply"), minAgeMs: Number(hours) * 3600000 }), null, 2));
} catch (error) {
  console.error("Storage cleanup failed:", error.message);
  process.exitCode = 1;
}
