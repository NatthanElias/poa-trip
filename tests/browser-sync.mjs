// Requires Chromium already running with --remote-debugging-port=9222.
// Each phone gets its own incognito browser context and disposable sync endpoints.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const base = process.argv[2] || 'http://127.0.0.1:8397/index.html';
const endpoint = 'https://textdb.dev/api/data/poa-test-' + randomUUID();
const topic = 'https://ntfy.sh/poa-test-' + randomUUID();
const seeded = await fetch(endpoint, {method: 'POST', headers: {'Content-Type':'text/plain'}, body: JSON.stringify({v: 1, stops: {}})});
assert(seeded.ok, 'seed disposable snapshot');
function connection(url) {
  const ws = new WebSocket(url); let next = 0; const pending = new Map(); const events = [];
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if(msg.id) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(Error(JSON.stringify(msg.error))) : p.resolve(msg.result); }
    else events.push(msg);
  });
  return {ws, events, open: new Promise(r => ws.addEventListener('open', r)),
    send(method, params = {}) {return new Promise((resolve,reject) => {const id = ++next; pending.set(id,{resolve,reject}); ws.send(JSON.stringify({id,method,params}));});}
  };
}
const meta = await (await fetch('http://127.0.0.1:9222/json/version')).json();
const browser = connection(meta.webSocketDebuggerUrl); await browser.open;
const contexts = [], pages = [], errors = [];
const delay = ms => new Promise(r => setTimeout(r,ms));
async function phone() {
  const {browserContextId} = await browser.send('Target.createBrowserContext'); contexts.push(browserContextId);
  const {targetId} = await browser.send('Target.createTarget', {url:'about:blank', browserContextId});
  const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const page = connection(targets.find(t => t.id === targetId).webSocketDebuggerUrl); await page.open; pages.push(page);
  await page.send('Page.enable'); await page.send('Runtime.enable');
  await page.send('Page.addScriptToEvaluateOnNewDocument', {source: `
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, options) => {
      let url = String(input);
      url = url.replace('https://textdb.dev/api/data/poa-11bc3fe4415e485821f6b8ba', ${JSON.stringify(endpoint)});
      url = url.replace('https://ntfy.sh/poa-trip-finados-5af55d3107922f4d', ${JSON.stringify(topic)});
      return realFetch(url, options);
    };
    const RealEventSource = window.EventSource;
    window.EventSource = function(url) { return new RealEventSource(String(url).replace('https://ntfy.sh/poa-trip-finados-5af55d3107922f4d', ${JSON.stringify(topic)})); };
  `});
  await page.send('Page.navigate', {url: base}); return page;
}
async function evaluate(page, expression) {
  const r = await page.send('Runtime.evaluate', {expression, awaitPromise:true, returnByValue:true});
  assert(!r.exceptionDetails, JSON.stringify(r.exceptionDetails)); return r.result.value;
}
async function until(page, expression, label) {
  const deadline = Date.now()+30000;
  do {if(await evaluate(page, expression)) return; await delay(250);} while(Date.now()<deadline);
  throw Error('Timed out: '+label);
}
const entry = id => `JSON.parse(localStorage.getItem('poa_trip_2026_visited_log_v1') || '{}')[${JSON.stringify(id)}]?.on`;
const click = (p,id) => evaluate(p, `document.querySelector('[data-toggle-visited="${id}"]').click()`);
try {
  const A = await phone(), B = await phone();
  await until(A, "document.querySelector('#sync-pill')?.classList.contains('is-ok')", 'A boot');
  await until(B, "document.querySelector('#sync-pill')?.classList.contains('is-ok')", 'B boot');
  await evaluate(A, "localStorage.setItem('isolation-test', 'A')");
  assert.equal(await evaluate(B, "localStorage.getItem('isolation-test')"), null, 'independent localStorage');
  await click(A,'stop-1'); await until(B, entry('stop-1')+' === true', 'A -> B live');
  await click(B,'stop-2'); await until(A, entry('stop-2')+' === true', 'B -> A live');
  assert.notEqual(await evaluate(A, "localStorage.getItem('poa_trip_2026_device_id')"), await evaluate(B, "localStorage.getItem('poa_trip_2026_device_id')"), 'independent device IDs');
  await click(A,'stop-1'); await until(B, entry('stop-1')+' === false', 'uncheck -> B');
  await Promise.all([click(A,'stop-1'),click(B,'stop-2')]);
  await until(A, entry('stop-2')+' === false', 'simultaneous changes merge A');
  await until(B, entry('stop-1')+' === true', 'simultaneous changes merge B');
  await A.send('Network.enable');
  await A.send('Network.emulateNetworkConditions', {offline:true,latency:0,downloadThroughput:-1,uploadThroughput:-1});
  await click(A,'stop-1'); await until(A, "document.querySelector('#sync-pill').classList.contains('is-off')", 'offline status');
  await A.send('Network.emulateNetworkConditions', {offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
  await until(B, entry('stop-1')+' === false', 'offline write replay');
  await B.send('Page.reload');
  await until(B, "document.querySelector('#sync-pill')?.classList.contains('is-ok')", 'reload');
  assert.equal(await evaluate(B, entry('stop-1')), false);
  assert.equal(await evaluate(B, entry('stop-2')), false);
  for(const p of pages) errors.push(...p.events.filter(e => e.method === 'Runtime.exceptionThrown'));
  assert.equal(errors.length,0,JSON.stringify(errors));
  console.log(JSON.stringify({url:base, independentContexts: contexts.length, checks:['bidirectional live sync','uncheck','simultaneous edits','offline replay','reload persistence','no runtime exceptions'], disposableSnapshot:endpoint},null,2));
} finally {
  for(const p of pages) p.ws.close();
  for(const browserContextId of contexts) await browser.send('Target.disposeBrowserContext',{browserContextId});
  browser.ws.close();
}
