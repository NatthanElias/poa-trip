const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const html = fs.readFileSync('index.html', 'utf8');
const moduleSource = html.slice(html.indexOf('      const GroupSync ='), html.indexOf('\n      document.addEventListener("DOMContentLoaded",'));

function device(server, stored = {}, storageFails = false) {
  const storage = { log: JSON.stringify(stored) };
  const timers = new Map();
  const listeners = {};
  let timerId = 0;
  const status = {};
  const context = {
    POA_TRIP_DATA: { meta: { groupSync: {snapshotUrl: 'snapshot', topic: 'topic'}, logKey: 'log', deviceKey: 'device' } },
    getAllConfirmedStops: () => [{id: 'a'}, {id: 'b'}],
    loadVisitedLog: () => JSON.parse(storage.log || '{}'),
    state: { visited: new Set() }, saveVisited() {}, updateProgressUI() {}, renderMainContent() {}, syncMapLayers() {}, showToast() {},
    document: {hidden: false, getElementById: () => status, addEventListener: (k, v) => {listeners[k] = v;}},
    window: { crypto: require('node:crypto'), localStorage: {
      getItem: (k) => storage[k], setItem: (k, v) => {if(storageFails) throw Error('storage blocked'); storage[k] = v;}
    }, addEventListener: (k, v) => {listeners[k] = v;} },
    setTimeout: (fn, delay) => {timers.set(++timerId, {fn, delay}); return timerId;},
    clearTimeout: (id) => timers.delete(id), setInterval() {},
    AbortController, fetch: (...args) => server.fetch(...args), Date, console
  };
  status.classList = {remove() {}, add: (v) => {status.value = v;}};
  vm.runInNewContext(moduleSource + '\nglobalThis.sync = GroupSync;', context);
  return { sync: context.sync, context, storage, listeners, timers, status,
    flush: async () => { const t = [...timers.entries()].find(([, t]) => t.delay !== 12000); if(t) {timers.delete(t[0]); await t[1].fn();} },
    settle: async () => { for(let i = 0; i < 30; i++) await new Promise(setImmediate); }
  };
}
function server() {
  return { snapshot: {v: 1, stops: {}}, offline: false, writes: 0, hook: null,
    async fetch(url, options = {}) {
      if(this.offline) throw Error('offline');
      if(url === 'topic') return {ok: true, text: async () => ''};
      if(options.method === 'POST') {
        this.writes++;
        if(this.hook) await this.hook();
        this.snapshot = JSON.parse(options.body);
      }
      return {ok: true, text: async () => JSON.stringify(this.snapshot)};
    }
  };
}
test('offline write retries after reconnect, including after reload', async () => {
  const s = server(); s.offline = true;
  const a = device(s); a.sync.recordLocal('a', true); a.sync.init(); await a.settle();
  assert.equal(a.status.value, 'is-off');
  const reloaded = device(s, JSON.parse(a.storage.log));
  s.offline = false; reloaded.sync.init(); await reloaded.settle();
  assert.equal(s.snapshot.stops.a.on, true);
  // Existing offline page also retries without needing another click.
  await a.flush(); await a.settle(); assert.equal(a.status.value, 'is-ok');
});
test('an edit during an upload is included in the next pass', async () => {
  const s = server(); const a = device(s);
  let release; let started;
  const ready = new Promise(r => started = r);
  s.hook = () => new Promise(r => {release = r; started();});
  a.sync.recordLocal('a', true); a.sync.init(); await ready;
  a.sync.recordLocal('b', true); s.hook = null; release(); await a.settle();
  assert.equal(s.snapshot.stops.a.on, true); assert.equal(s.snapshot.stops.b.on, true);
  assert.equal(s.writes, 2);
});
test('a surviving device repairs a snapshot overwritten by another writer', async () => {
  const s = server(); const a = device(s, {a: {t: 10, on: true}});
  a.sync.init(); await a.settle();
  s.snapshot = {stops: {b: {t: 20, on: true}}};
  await a.listeners.online(); await a.settle();
  assert.equal(s.snapshot.stops.a.on, true); assert.equal(s.snapshot.stops.b.on, true);
});
test('equal timestamps converge regardless of merge order; unchecking propagates', async () => {
  const s = server(); s.snapshot = {stops: {a: {t: 10, on: false, d: 'z'}}};
  const a = device(s, {a: {t: 10, on: true, d: 'a'}}); a.sync.init(); await a.settle();
  assert.equal(JSON.parse(a.storage.log).a.on, false);
  const b = device(s, {a: {t: 10, on: true, d: 'a'}}); b.sync.init(); await b.settle();
  assert.equal(JSON.parse(b.storage.log).a.on, false);
});
test('storage failure keeps local edits available for upload', async () => {
  const s = server(); const a = device(s, {}, true);
  a.sync.recordLocal('a', true); a.sync.init(); await a.settle();
  assert.equal(s.snapshot.stops.a.on, true);
});
test('invalid and unknown remote entries do not affect visited stops', async () => {
  const s = server(); s.snapshot = {stops: {a: {t: Infinity, on: true}, b: {t: 5, on: 'yes'}, stranger: {t: 5, on: true}}};
  const a = device(s); a.sync.init(); await a.settle();
  assert.equal(a.context.state.visited.size, 0);
});
test('malformed snapshots are not overwritten and get retried', async () => {
  const s = server(); s.snapshot = {unexpected: true};
  const a = device(s); a.sync.recordLocal('a', true); a.sync.init(); await a.settle();
  assert.equal(a.status.value, 'is-off'); assert.equal(s.writes, 0);
});
