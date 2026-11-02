"use strict";
const path = require("node:path");
const { OperationsSettings } = require("./settings");
const settings = new OperationsSettings({ root: path.resolve(__dirname, "..", "..") });
settings.markStarted();
settings.replica = require("./replica").readReplica(settings.root);
const environment = settings.environment.bind(settings);
settings.environment = () => require("./replica").replicaEnvironment(settings.root, environment());
module.exports = settings;
