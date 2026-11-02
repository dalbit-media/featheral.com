"use strict";
const applied = Symbol("operationsHttpPolicy");
function requestPolicy(req, res, settings) {
  if (req[applied]) return true;
  req[applied] = true;
  const { uploadLimitMiB, requestTimeoutSeconds } = settings.value;
  if (Number(req.headers["content-length"]) > uploadLimitMiB * 1024 ** 2) {
    console.error("HTTP body exceeds the configured upload limit.");
    res.writeHead(413, { "Content-Type": "application/json", "Connection": "close" });
    res.end(JSON.stringify({ error: `Upload exceeds the configured ${uploadLimitMiB} MiB limit.` }));
    return false;
  }
  req.setTimeout(requestTimeoutSeconds * 1000);
  res.setTimeout(requestTimeoutSeconds * 1000, () => {
    console.error("HTTP request timed out.");
    res.destroy(new Error("HTTP request timed out."));
  });
  return true;
}
function configureServer(server, settings) {
  const update = () => {
    server.requestTimeout = settings.value.requestTimeoutSeconds * 1000;
    server.headersTimeout = Math.min(60000, server.requestTimeout);
  };
  update();
  settings.listeners.add(update);
  server.once("close", () => settings.listeners.delete(update));
}
module.exports = { requestPolicy, configureServer };
