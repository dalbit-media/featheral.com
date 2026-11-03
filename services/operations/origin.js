"use strict";
const LOOPBACK = host => ["localhost", "127.0.0.1", "[::1]"].includes(host) || host.endsWith(".localhost");

// Deployed servers serve World at its assigned public host; settings copied from a dev machine must not pin a loopback origin there.
function worldOrigin(env, manifest, port) {
  const configured = env.APP_ORIGIN ? new URL(env.APP_ORIGIN) : null;
  const assigned = manifest?.hosts?.find(host => host.startsWith("world."));
  if (assigned && (!configured || LOOPBACK(configured.hostname))) return `https://${assigned}`;
  return configured ? configured.origin : `http://world.localhost:${port}`;
}
module.exports = { worldOrigin };
