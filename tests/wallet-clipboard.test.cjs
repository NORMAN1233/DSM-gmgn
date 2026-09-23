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
  let messageListener;
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
      onMessage: { addListener: (listener) => { messageListener = listener; } },
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
    latest: () => { let response; messageListener({ type: 'DSM_WALLET_LATEST_TOKEN' }, {}, (value) => { response = value; }); return response; },
    enable: (value) => settingsChanged({
      dsmSetting_officialWalletCopyEnabled: { newValue: value }
    }, 'local')
  };
}

test('history is ignored; latest new cross-chain notification retains its real URL without copying', async (t) => {
  const h = await setup(t, { history: [SOL] });
  assert.equal(h.latest().ok, false);
  h.list.prepend(h.row(SOL_NEXT));
  await flush();
  assert.equal(h.latest().ca, SOL_NEXT);
  const next = h.row(RH);
  h.list.prepend(next);
  await flush();
  next.remove();
  await flush();
  assert.equal(h.latest().url, `https://gmgn.ai/robinhood/token/${RH}`);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.requests, []);
});

test('mixed batches retain the topmost notification and virtualized nodes update', async (t) => {
  const h = await setup(t);
  const top = h.row(RH);
  h.list.append(top, h.row(SOL));
  await flush();
  assert.equal(h.latest().ca, RH);
  top.href = `/sol/token/${SOL_NEXT}`;
  await flush();
  assert.equal(h.latest().ca, SOL_NEXT);
});

test('settings initialization retains new notifications but ignores history', async (t) => {
  const settings = deferred();
  const h = await setup(t, { settings, history: [RH] });
  h.list.prepend(h.row(SOL));
  await flush();
  assert.equal(h.latest().ok, false);
  settings.resolve({});
  await flush();
  assert.equal(h.latest().ca, SOL);
});

test('disable clears snapshots; re-enable waits for a fresh notification', async (t) => {
  const h = await setup(t);
  h.list.prepend(h.row(SOL));
  await flush();
  h.enable(false);
  assert.equal(h.latest().ok, false);
  h.enable(true);
  assert.equal(h.latest().ok, false);
  h.list.prepend(h.row(RH));
  await flush();
  assert.equal(h.latest().ca, RH);
});

test('foreign token links cannot become navigation targets', async (t) => {
  const h = await setup(t);
  const invalid = h.row(SOL);
  invalid.href = `https://evil.example/sol/token/${SOL}`;
  h.list.prepend(invalid);
  await flush();
  assert.equal(h.latest().ok, false);
});
