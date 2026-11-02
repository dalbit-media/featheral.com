'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { FileJournals } = require('../../db-api/journal');
const { createDomainApi } = require('../../db-api/domain');

let configuredDomain;
const standaloneDomains = new Map();
function configureDomain(domain) { configuredDomain = domain; }
function openDomain(file) {
  if (file && typeof file.get === 'function' && typeof file.transact === 'function') return file;
  const resolved = path.resolve(String(file));
  const directory = path.join(path.dirname(resolved), 'daily-files');
  let domain = configuredDomain || standaloneDomains.get(directory);
  if (!domain) {
    domain = createDomainApi({ journals: new FileJournals(directory), sites: () => [] });
    standaloneDomains.set(directory, domain);
  }
  const name = 'cms-' + crypto.createHash('sha256').update(resolved.toLowerCase()).digest('hex').slice(0, 40);
  return domain.database(name);
}

class DomainStore {
  constructor(file) { this.domain = openDomain(file); this.pending = null; }
  record(collection, id) {
    id = String(id);
    const key = `${collection}:${id}`;
    if (this.pending?.has(key)) return this.pending.get(key);
    const record = this.domain.get(collection, id);
    return { collection, id, ...record };
  }
  get(collection, id) {
    const record = this.record(collection, id);
    return record.deleted ? undefined : structuredClone(record.value);
  }
  list(collection) {
    const records = new Map();
    let after;
    do {
      const page = this.domain.list(collection, { ...(after ? { after } : {}), limit: 100 });
      for (const record of page.documents) records.set(record.id, record.value);
      after = page.nextCursor;
    } while (after);
    for (const record of this.pending?.values() || []) {
      if (record.collection !== collection) continue;
      if (record.deleted) records.delete(record.id);
      else records.set(record.id, record.value);
    }
    return [...records.values()].map(value => structuredClone(value));
  }
  put(collection, id, value) {
    if (!this.pending) return this.transaction(() => this.put(collection, id, value));
    const previous = this.record(collection, id);
    this.pending.set(`${collection}:${id}`, { ...previous, collection, id: String(id), deleted: false, value: structuredClone(value) });
    return value;
  }
  delete(collection, id) {
    if (!this.pending) return this.transaction(() => this.delete(collection, id));
    const previous = this.record(collection, id);
    this.pending.set(`${collection}:${id}`, { ...previous, collection, id: String(id), deleted: true });
  }
  next(collection) {
    const value = (this.get('sequences', collection)?.value || 0) + 1;
    this.put('sequences', collection, { value });
    return value;
  }
  transaction(work) {
    if (this.pending) return work();
    this.pending = new Map();
    try {
      const result = work();
      if (result && typeof result.then === 'function') throw new TypeError('Domain transactions must be synchronous');
      const changes = [...this.pending.values()].map(record => ({
        collection: record.collection, id: record.id, expectedRevision: record.revision,
        op: record.deleted ? 'delete' : 'put', ...(record.deleted ? {} : { value: record.value }),
      }));
      if (changes.length) this.domain.transact({ requestId: crypto.randomUUID(), changes });
      return result;
    } finally { this.pending = null; }
  }
  close() {}
}
module.exports = { DomainStore, openDomain, configureDomain };
