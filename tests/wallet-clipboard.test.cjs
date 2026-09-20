const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require(process.env.DSM_TEST_DOM_MODULE || 'jsdom');
const source = fs.readFileSync(path.join(__dirname, '..', 'gmgn-wallet-clipboard.js'), 'utf8');
const SOL = '9HR5Uvyf95jgusXkEyoLipHMtw5FynKu1m8v9Nm9y7Kx';
const A = '0x' + '1'.repeat(40), B = '0x' + '2'.repeat(40), C = '0x' + '3'.repeat(40);
const flush = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function setup(t, { history = [], backend, settingsGate } = {}) {
  const dom = new JSDOM('<main id="tracker" style="overflow-y:auto;height:300px"></main>', {
    url: 'https://gmgn.ai/sol', runScripts: 'outside-only', pretendToBeVisual: true
  });
  t.after(() => { dom.window.dispatchEvent(new dom.window.Event('pagehide')); dom.window.close(); });
  const { window } = dom, list = window.document.getElementById('tracker');
  window.HTMLElement.prototype.getClientRects = function () { return this.hidden ? [] : [{}]; };
  const writes = [], requests = [], results = [];
  let changed, latestSequence = -1;
  // Construct DOM nodes as React does; an HTML parser would repair nested anchors.
  function row(ca, { maker = 'shah', side = '建仓', amount = '$137.95', age = '1s' } = {}) {
    const a = window.document.createElement('a');
    a.setAttribute('data-sentry-component', 'TrackerListItem');
    a.href = '/' + (ca.startsWith('0x') ? 'bsc' : 'sol') + '/token/' + ca;
    const stripe = window.document.createElement('span');
    const header = window.document.createElement('div');
    const user = window.document.createElement('div');
    user.dataset.testid = 'follow-tracking-row-maker';
    const link = window.document.createElement('a');
    link.href = '/sol/address/' + maker; link.textContent = maker; user.append(link);
    const sideNode = window.document.createElement('span');
    sideNode.dataset.testid = 'follow-tracking-row-side'; sideNode.textContent = side;
    const ageNode = window.document.createElement('div'); ageNode.textContent = age;
    header.append(user, sideNode, ageNode);
    const body = window.document.createElement('div');
    const amt = window.document.createElement('div'); amt.dataset.testid = 'follow-tracking-row-amount'; amt.textContent = amount;
    const symbol = window.document.createElement('div'); symbol.dataset.testid = 'follow-tracking-row-symbol'; symbol.textContent = 'Solana';
    const lens = window.document.createElement('a'); lens.href = 'https://lens.google.com/'; symbol.append(lens);
    body.append(amt, symbol); a.append(stripe, header, body); return a;
  }
  for (const ca of history) list.append(row(ca, { age: '1m' }));
  window.chrome = {
    storage: {
      local: { get: async () => { if (settingsGate) await settingsGate.promise; return {}; } },
      onChanged: { addListener: fn => { changed = fn; } }
    },
    runtime: { sendMessage: async message => {
      if (message.type === 'DSM_WALLET_COPY_PREPARE') return { ok: true };
      latestSequence = Math.max(latestSequence, message.sequence);
      if (message.type === 'DSM_WALLET_COPY_CANCEL') return { ok: true };
      assert.equal(message.type, 'DSM_WALLET_COPY_CA');
      requests.push(message);
      const ok = backend ? await backend(message, requests.length) : true;
      if (message.sequence !== latestSequence) return { ok: false, reason: 'superseded' };
      if (ok) writes.push(message.ca);
      return { ok };
    } }
  };
  window.addEventListener('dsm-gmgn-wallet-ca-copied', e => results.push(e.detail));
  window.eval(source); await flush();
  return { window, list, row, writes, requests, results, enable(value) { changed({ dsmSetting_officialWalletCopyEnabled: { newValue: value } }, 'local'); } };
}

test('the supplied official row copies token CA, never maker or nested image link', async t => {
  const h = await setup(t, { history: [A] });
  h.list.prepend(h.row(SOL)); await flush();
  assert.deepEqual(h.writes, [SOL]);
});

test('each new top alert follows the visible official order, buys and sells alike', async t => {
  const h = await setup(t, { history: [A] });
  h.list.prepend(h.row(B)); await flush();
  h.list.prepend(h.row(SOL, { side: '卖出' })); await flush();
  assert.deepEqual(h.writes, [B, SOL]);
});

test('a batch of 100 rows copies the final top row once without replaying older rows', async t => {
  const h = await setup(t, { history: [C] });
  const addresses = Array.from({length:100}, (_,i) => '0x' + (i+20).toString(16).padStart(40, '0'));
  h.list.prepend(...addresses.map(ca => h.row(ca))); await flush();
  assert.deepEqual(h.writes, [addresses[0]]);
  assert.equal(h.requests.length, 1);
});

test('appending historical rows or rebuilding the same content does not change clipboard', async t => {
  const h = await setup(t, { history: [A, B] });
  h.list.append(h.row(C, { age: '3m' })); await flush();
  h.list.replaceChildren(...[...h.list.children].map(row => row.cloneNode(true))); await flush();
  assert.deepEqual(h.writes, []);
});

test('downward virtual scrolling and returning to the top do not replay history', async t => {
  const h = await setup(t, { history: [A, B] });
  h.list.scrollTop = 100;
  h.list.dispatchEvent(new h.window.Event('scroll')); await flush();
  h.list.firstElementChild.href = '/bsc/token/' + C; await flush();
  h.list.scrollTop = 0;
  h.list.dispatchEvent(new h.window.Event('scroll')); await flush();
  assert.deepEqual(h.writes, []);
  h.list.prepend(h.row(SOL)); await flush();
  assert.deepEqual(h.writes, [SOL]);
});

test('new A→B→A alerts are followed when the final A is a distinct official message', async t => {
  const h = await setup(t, { history: [C] });
  h.list.prepend(h.row(A)); await flush();
  h.list.prepend(h.row(B)); await flush();
  h.list.prepend(h.row(A, { maker: 'another-wallet', amount: '$200' })); await flush();
  assert.deepEqual(h.writes, [A, B, A]);
});

test('slow old request cannot delay or overwrite the newer top alert', async t => {
  const gate = deferred(); t.after(gate.resolve);
  const h = await setup(t, { history: [C], backend: async (_, n) => { if (n === 1) await gate.promise; return true; } });
  h.list.prepend(h.row(A)); await flush();
  h.list.prepend(h.row(B)); await flush();
  assert.deepEqual(h.writes, [B]);
  gate.resolve(); await flush();
  assert.deepEqual(h.writes, [B]);
  assert.deepEqual(h.results.map(r => r.ca), [B]);
});

test('reusing a row only copies its final href, never intermediate oldValues', async t => {
  const h = await setup(t, { history: [C] });
  const top = h.list.firstElementChild;
  top.href = '/bsc/token/' + A; top.href = '/bsc/token/' + B; await flush();
  assert.deepEqual(h.writes, [B]);
});

test('closing the view cancels the in-flight copy', async t => {
  const gate = deferred(); t.after(gate.resolve);
  const h = await setup(t, { history: [C], backend: async () => { await gate.promise; return true; } });
  h.list.prepend(h.row(A)); await flush();
  h.list.replaceChildren(); await flush(); gate.resolve(); await flush();
  assert.deepEqual(h.writes, []);
});

test('new head arriving during settings load is kept, while pre-existing history is ignored', async t => {
  const gate = deferred();
  const h = await setup(t, { history: [C], settingsGate: gate });
  h.list.prepend(h.row(A)); await flush();
  h.list.prepend(h.row(B)); await flush(); gate.resolve(); await flush();
  assert.deepEqual(h.writes, [B]);
});

test('turning off cancels old work; re-enabling seeds the current list', async t => {
  const gate = deferred(); t.after(gate.resolve);
  const h = await setup(t, { history: [C], backend: async (_,n) => { if(n===1) await gate.promise; return true; } });
  h.list.prepend(h.row(A)); await flush(); h.enable(false); h.enable(true);
  gate.resolve(); await flush(); assert.deepEqual(h.writes, []);
  h.list.prepend(h.row(B)); await flush(); assert.deepEqual(h.writes, [B]);
});

test('newly mounted unrelated history after a chain/filter change is only seeded', async t => {
  const h = await setup(t, { history: [A, B] });
  h.window.history.pushState({}, '', '/bsc');
  h.list.replaceChildren(h.row(C, { age: '3m' })); await flush();
  assert.deepEqual(h.writes, []);
});

test('ordinary token links outside the official feed are ignored', async t => {
  const h = await setup(t, { history: [A] });
  const a = h.window.document.createElement('a'); a.href = '/sol/token/' + SOL;
  h.window.document.body.prepend(a); await flush(); assert.deepEqual(h.writes, []);
});

test('identical transaction fields in a newly prepended row still follow A→B→A', async t => {
  const h = await setup(t, { history: [C] });
  h.list.prepend(h.row(A)); await flush();
  h.list.prepend(h.row(B)); await flush();
  h.list.prepend(h.row(A)); await flush();
  assert.deepEqual(h.writes, [A, B, A]);
});

test('automatic scroll event at zero does not cancel a new top alert', async t => {
  const gate = deferred(); t.after(gate.resolve);
  const h = await setup(t, { history: [C], backend: async () => { await gate.promise; return true; } });
  h.list.prepend(h.row(A)); await flush();
  h.list.dispatchEvent(new h.window.Event('scroll')); await flush();
  gate.resolve(); await flush(); assert.deepEqual(h.writes, [A]);
});
