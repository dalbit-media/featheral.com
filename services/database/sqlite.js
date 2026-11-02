"use strict";
const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");

const connections = new Set();

function open(file, options) {
  if (typeof file !== "string" || !file.length) throw new TypeError("A database file path is required.");
  const replica = file !== ":memory:" && require("../operations/replica").readReplica(path.resolve(__dirname, "..", ".."));
  const connection = new DatabaseSync(file, replica ? { ...options, readOnly: true } : options === undefined ? {} : options);
  connection.readOnlyReplica = Boolean(replica);
  if (replica) connection.exec("PRAGMA query_only=ON");
  connections.add(connection);
  const close = connection.close.bind(connection);
  let closed = false;
  connection.close = (...args) => {
    if (closed) return;
    closed = true;
    connections.delete(connection);
    return close(...args);
  };
  return connection;
}

function closeAll() {
  const errors = [];
  for (const connection of [...connections]) {
    try { connection.close(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "One or more database connections could not be closed.");
}

module.exports = Object.freeze({
  open,
  closeAll,
  get activeConnections() { return connections.size; },
});
