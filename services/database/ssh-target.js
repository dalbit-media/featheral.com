"use strict";
const { fail } = require("./journal");
function sshTarget(env, { allowUnpinned = false } = {}) {
  const match = /^([a-z_][a-z0-9_-]*)@([a-z0-9.-]+):(\/[a-zA-Z0-9/_-]+)$/.exec(env.DEPLOY_TARGET || "");
  if (!match || match[3] === "/" || match[3].includes("/../")) throw fail(400, "Set DEPLOY_TARGET=user@host:/opt/featheral in the server environment");
  const pinned = /^SHA256:[A-Za-z0-9+/]{43}=?$/.test(env.DEPLOY_HOST_KEY_SHA256 || "");
  if (!pinned && !allowUnpinned) throw fail(400, "Set DEPLOY_HOST_KEY_SHA256 to the independently verified SSH host-key fingerprint");
  const port = Number(env.DEPLOY_PORT || 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail(400, "Invalid DEPLOY_PORT");
  return { username: match[1], host: match[2], directory: match[3], port,
    fingerprint: pinned ? env.DEPLOY_HOST_KEY_SHA256.replace(/=+$/, "") : "" };
}
module.exports = { sshTarget };
