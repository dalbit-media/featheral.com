"use strict";
const { TOKENS, fail } = require("./journal");

const COLLECTION = /^[a-z][a-z0-9_-]{0,39}$/;
const DOCUMENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9:_$@./-]{0,159}$/;
const DATABASE_NAME = /^[a-z0-9][a-z0-9.-]{0,99}$/;
const MAX_PAGE_SIZE = 100;

function collectionPrefix(collection) {
  if (typeof collection !== "string" || !COLLECTION.test(collection)) throw fail(400, "Invalid collection name.");
  return `${collection}:`;
}

function documentKey(collection, id) {
  const prefix = collectionPrefix(collection);
  if (typeof id !== "string" || !DOCUMENT_ID.test(id)) throw fail(400, "Invalid document ID.");
  return prefix + id;
}

function createDomainApi({ journals, sites }) {
  function storeFor(namespace) {
    return {
      get(collection, id) {
        const document = journals.get(namespace, documentKey(collection, id));
        return structuredClone(document);
      },
      list(collection, options = {}) {
        const prefix = collectionPrefix(collection);
        if (!options || typeof options !== "object" || Array.isArray(options)
          || Object.keys(options).some(key => !["after", "limit"].includes(key))) {
          throw fail(400, "Invalid collection query.");
        }
        const { after, limit = MAX_PAGE_SIZE } = options;
        if (after !== undefined && (typeof after !== "string" || !DOCUMENT_ID.test(after))) {
          throw fail(400, "Invalid document cursor.");
        }
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
          throw fail(400, `Page size must be between 1 and ${MAX_PAGE_SIZE}.`);
        }
        const matching = [...journals.replay(namespace).documents]
          .filter(([key, document]) => key.startsWith(prefix) && !document.deleted && (!after || key.slice(prefix.length) > after))
          .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
          .slice(0, limit + 1);
        const hasMore = matching.length > limit;
        const documents = matching.slice(0, limit).map(([key, document]) => ({
          id: key.slice(prefix.length),
          revision: document.revision,
          value: structuredClone(document.value),
        }));
        return { documents, nextCursor: hasMore ? documents[documents.length - 1].id : null };
      },
      transact(transaction) {
        if (!transaction || typeof transaction !== "object" || Array.isArray(transaction)
          || Object.keys(transaction).some(key => !["requestId", "changes"].includes(key))) {
          throw fail(400, "Invalid document transaction.");
        }
        const { requestId, changes } = transaction;
        if (!Array.isArray(changes)) throw fail(400, "Transaction changes must be an array.");
        const journalChanges = changes.map(change => {
          if (!change || typeof change !== "object" || Array.isArray(change)) throw fail(400, "Invalid document change.");
          const allowed = ["collection", "id", "op", "expectedRevision", "value"];
          if (Object.keys(change).some(key => !allowed.includes(key))) throw fail(400, "Unknown document change field.");
          const { collection, id, op, expectedRevision } = change;
          if (!["put", "delete"].includes(op) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
            throw fail(400, "Invalid document change.");
          }
          if (op === "put" && !Object.hasOwn(change, "value")) throw fail(400, "Put changes require a document value.");
          if (op === "delete" && Object.hasOwn(change, "value")) throw fail(400, "Deleted documents cannot contain a value.");
          return {
            key: documentKey(collection, id),
            op,
            expectedRevision,
            ...(op === "put" ? { value: change.value } : {}),
          };
        });
        return journals.transact(namespace, { requestId, changes: journalChanges });
      },
    };
  }

  return Object.freeze({
    site(host) {
      if (typeof host !== "string" || !sites().includes(host)) throw fail(404, "Unknown site database.");
      return storeFor(`sites/${host}`);
    },
    database(name) {
      if (typeof name !== "string" || !DATABASE_NAME.test(name) || name.includes("..") || name.endsWith(".")) {
        throw fail(400, "Invalid database name.");
      }
      return storeFor(`databases/${name}`);
    },
    token(symbol) {
      if (typeof symbol !== "string" || !Object.hasOwn(TOKENS, symbol)) throw fail(404, "Unknown token database.");
      const token = TOKENS[symbol];
      return storeFor(`tokens/${token}`);
    },
  });
}

module.exports = { createDomainApi };
