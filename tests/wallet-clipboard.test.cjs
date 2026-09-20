const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require(process.env.DSM_TEST_DOM_MODULE || 'jsdom');

const source = process.env.DSM_TEST_SOURCE === 'HEAD'
  ? execFileSync('git', ['show', 'HEAD:gmgn-wallet-clipboard.js'], { encoding: 'utf8' })
  : readFileSync(path.join(__dirname, '..', 'gmgn-wallet-clipboard.js'), 'utf8');
const SOL = 'So11111111111111111111111111111111111111112';
const SOL_NEXT = '11111111111111111111111111111111';
const RH = '0x1111111111111111111111111111111111111111';
const RH_NEXT = '0x2222222222222222222222222222222222222222';
const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(check) {
  for (let i = 0; i < 100 && !check(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(check(), 'clipboard work did not finish');
}

async function setup(t, { history = [], backend, settings } = {}) {
  const dom = new JSDOM('<main id="tracker"></main>', {
    url: 'https://gmgn.ai/sol', runScripts: 'outside-only'
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const list = window.document.getElementById('tracker');
  const writes = [];
  const requests = [];
  let settingsChanged;
  const row = (ca, side = 'Buy') => {
    const anchor = window.document.createElement('a');
    anchor.setAttribute('data-sentry-component', 'TrackerListItem');
    anchor.href = `/${ca.startsWith('0x') ? 'robinhood' : 'sol'}/token/${ca}`;
    const symbol = window.document.createElement('span');
    symbol.setAttribute('data-testid', 'follow-tracking-row-symbol');
    symbol.textContent = 'TOKEN';
    const direction = window.document.createElement('span');
    direction.setAttribute('data-testid', 'follow-tracking-row-side');
    direction.textContent = side;
    anchor.append(symbol, direction);
    return anchor;
  };
  for (const ca of history) list.append(row(ca));
  window.document.execCommand = (command) => {
    assert.equal(command, 'copy');
    if (backend) return false;
    writes.push(window.document.querySelector('textarea').value);
    return true;
  };
  window.chrome = {
    storage: {
      local: { get: async () => settings ? settings.promise : ({}) },
      onChanged: { addListener: (listener) => { settingsChanged = listener; } }
    },
    runtime: {
      sendMessage: async (message) => {
        assert.equal(message.type, 'DSM_WALLET_COPY_CA');
        requests.push(message.ca);
        const ok = await backend(message.ca, requests.length);
        if (ok) writes.push(message.ca);
        return { ok };
      }
    }
  };
  window.eval(source);
  await flush();
  return {
    window, list, row, writes, requests,
    enable: (value) => settingsChanged({
      dsmSetting_officialWalletCopyEnabled: { newValue: value }
    }, 'local')
  };
}

test('existing history stays untouched; new SOL and robinhood rows copy their CA', async (t) => {
  const h = await setup(t, { history: [RH_NEXT] });
  assert.deepEqual(h.writes, []);
  h.list.prepend(h.row(SOL));
  await flush();
  h.list.prepend(h.row(RH));
  await flush();
  assert.deepEqual(h.writes, [SOL, RH]);
});

test('a captured robinhood alert still copies after its DOM node disappears', async (t) => {
  const gate = deferred();
  t.after(gate.resolve);
  const h = await setup(t, { backend: async (_, n) => {
    if (n === 1) await gate.promise;
    return true;
  } });
  h.list.prepend(h.row(SOL));
  await flush();
  assert.deepEqual(h.requests, [SOL]);
  const next = h.row(RH);
  h.list.prepend(next);
  await flush();
  next.remove();
  await flush();
  gate.resolve();
  await flush();
  assert.deepEqual(h.writes, [SOL, RH]);
});

test('reusing a queued node preserves both cross-chain alert snapshots', async (t) => {
  const gate = deferred();
  t.after(gate.resolve);
  const h = await setup(t, { backend: async (_, n) => {
    if (n === 1) await gate.promise;
    return true;
  } });
  h.list.prepend(h.row(SOL));
  await flush();
  const reused = h.row(RH);
  h.list.prepend(reused);
  await flush();
  reused.href = `/sol/token/${SOL_NEXT}`;
  await flush();
  gate.resolve();
  await flush();
  assert.deepEqual(h.writes, [SOL, RH, SOL_NEXT]);
});

test('A to B to A on one node copies the final A after an in-flight B', async (t) => {
  const gate = deferred();
  t.after(gate.resolve);
  const h = await setup(t, { backend: async (_, n) => {
    if (n === 2) await gate.promise;
    return true;
  } });
  const reused = h.row(SOL);
  h.list.prepend(reused);
  await flush();
  reused.href = `/robinhood/token/${RH}`;
  await flush();
  assert.deepEqual(h.requests, [SOL, RH]);
  reused.href = `/sol/token/${SOL}`;
  await flush();
  gate.resolve();
  await flush();
  assert.deepEqual(h.writes, [SOL, RH, SOL]);
});

test('mixed batches copy oldest to newest and retain the top alert last', async (t) => {
  const h = await setup(t);
  h.list.append(h.row(RH_NEXT), h.row(SOL_NEXT), h.row(RH), h.row(SOL));
  await flush();
  assert.deepEqual(h.writes, [SOL, RH, SOL_NEXT, RH_NEXT]);
});

test('a filtered official row copies as soon as its CA arrives without waiting for side text', async (t) => {
  const h = await setup(t);
  const delayed = h.row(RH, '');
  h.list.append(delayed);
  await flush();
  assert.deepEqual(h.writes, [RH]);
  delayed.querySelector('[data-testid="follow-tracking-row-side"]').textContent = '买入';
  await flush();
  assert.deepEqual(h.writes, [RH]);
});

test('new rows arriving during settings load are copied, pre-existing rows are not', async (t) => {
  const settings = deferred();
  const h = await setup(t, { settings, history: [RH_NEXT] });
  h.list.prepend(h.row(SOL));
  await flush();
  assert.deepEqual(h.writes, []);
  settings.resolve({});
  await flush();
  assert.deepEqual(h.writes, [SOL]);
});

test('disabled settings discard rows collected during initialization', async (t) => {
  const settings = deferred();
  const h = await setup(t, { settings });
  h.list.prepend(h.row(SOL));
  await flush();
  settings.resolve({ dsmSetting_officialWalletCopyEnabled: false });
  await flush();
  assert.deepEqual(h.writes, []);
});

test('a newer switch change wins over a stale settings read', async (t) => {
  const settings = deferred();
  const h = await setup(t, { settings });
  h.enable(false);
  settings.resolve({ dsmSetting_officialWalletCopyEnabled: true });
  await flush();
  h.list.prepend(h.row(SOL));
  await flush();
  assert.deepEqual(h.writes, []);
});

test('a missing backend response times out and retries without permanently blocking the next CA', async (t) => {
  const h = await setup(t, { backend: async (_, n) => n === 1 ? new Promise(() => {}) : true });
  h.list.prepend(h.row(SOL));
  await flush();
  h.list.prepend(h.row(RH));
  await new Promise((resolve) => setTimeout(resolve, 700));
  await waitFor(() => h.writes.includes(RH));
  assert.deepEqual(h.writes, [SOL, RH]);
});

test('each alert retries a temporary failure even when another chain is queued', async (t) => {
  const h = await setup(t, { backend: async (_, n) => n !== 1 });
  h.list.append(h.row(RH), h.row(SOL));
  await waitFor(() => h.writes.includes(RH));
  assert.deepEqual(h.requests, [SOL, SOL, RH]);
  assert.deepEqual(h.writes, [SOL, RH]);
});

test('turning copying off and back on cancels previously queued alerts', async (t) => {
  const gate = deferred();
  t.after(gate.resolve);
  const h = await setup(t, { backend: async (_, n) => {
    if (n === 1) await gate.promise;
    return true;
  } });
  h.list.prepend(h.row(SOL));
  await flush();
  h.list.prepend(h.row(RH));
  await flush();
  h.enable(false);
  h.enable(true);
  gate.resolve();
  await flush();
  assert.deepEqual(h.writes, [SOL]);
});
