"use strict";
const path = require("node:path");
const { OperationsSettings } = require("./settings");
const settings = new OperationsSettings({ root: path.resolve(__dirname, "..", "..") });
settings.markStarted();
module.exports = settings;
