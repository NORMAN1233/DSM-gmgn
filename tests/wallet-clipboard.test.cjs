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

async function setup(t, { history = [], backend, settings, url = 'https://gmgn.ai/sol' } = {}) {
  const dom = new JSDOM('<main id="tracker"></main>', {
    url, runScripts: 'outside-only'
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const list = window.document.getElementById('tracker');
  const writes = [];
  const requests = [];
  const opens = [];
  const observed = { callbacks: 0, records: 0 };
  const NativeObserver = window.MutationObserver;
  window.MutationObserver = class extends NativeObserver {
    constructor(callback) {
      super((records, observer) => {
        observed.callbacks += 1;
        observed.records += records.length;
        callback(records, observer);
      });
    }
  };
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
    anchor.getBoundingClientRect = () => {
      const top = Math.max(0, Array.from(anchor.parentElement?.children || []).indexOf(anchor)) * 30;
      return { top, bottom: top + 30, left: 0, right: 200, width: 200, height: 30 };
    };
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
        if (message.type === 'DSM_WALLET_OPEN_LATEST') { opens.push(message); return { ok: true }; }
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
    window, list, row, writes, requests, opens, observed,
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

function press(h, options = {}, target = h.window.document.body) {
  const event = new h.window.KeyboardEvent('keydown', {
    code: 'KeyC', key: 'c', bubbles: true, cancelable: true, composed: true, ...options
  });
  target.dispatchEvent(event);
  return event;
}

test('single C synchronously clicks the latest actual row and bubbles to GMGN handlers', async (t) => {
  const h = await setup(t);
  const row = h.row(SOL);
  const clicks = [];
  h.list.addEventListener('click', (event) => { clicks.push(event.target); event.preventDefault(); });
  h.list.prepend(row);
  await flush();
  assert.equal(press(h).defaultPrevented, true);
  assert.deepEqual(clicks, [row]);
  await flush();
  assert.equal(h.opens.length, 0);
  assert.deepEqual(h.writes, []);
});

test('reused nodes click their current token immediately; removed nodes are never clicked', async (t) => {
  const h = await setup(t);
  const row = h.row(SOL);
  let clicks = 0;
  row.addEventListener('click', (event) => { clicks += 1; event.preventDefault(); });
  h.list.prepend(row);
  await flush();
  row.href = `/robinhood/token/${RH}`;
  press(h);
  assert.equal(clicks, 1);
  await flush();
  press(h);
  assert.equal(clicks, 2);
  row.remove();
  press(h);
  assert.equal(clicks, 2);
  assert.match(h.window.document.getElementById('dsm-wallet-click-status').textContent, /没有可见/);
  assert.equal(h.opens.length, 0);
});

test('a batch of new notifications clicks the topmost row only', async (t) => {
  const h = await setup(t);
  const top = h.row(RH);
  h.list.append(top, h.row(SOL));
  const clicks = [];
  h.list.addEventListener('click', (event) => { clicks.push(event.target); event.preventDefault(); });
  await flush();
  press(h);
  assert.deepEqual(clicks, [top]);
});

test('typing, composition, modifier keys, repeats and disabled mode do not navigate', async (t) => {
  const h = await setup(t);
  for (const options of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true },
    { repeat: true }, { isComposing: true }, { keyCode: 229 }, { code: 'KeyX' }]) {
    assert.equal(press(h, options).defaultPrevented, false);
  }
  for (const html of ['<input>', '<textarea></textarea>', '<select></select>',
    '<div contenteditable="true"><span>text</span></div>', '<div role="textbox"></div>']) {
    const host = h.window.document.createElement('div');
    host.innerHTML = html;
    h.window.document.body.append(host);
    assert.equal(press(h, {}, host.querySelector('span') || host.firstChild).defaultPrevented, false);
    host.remove();
  }
  h.enable(false);
  assert.equal(press(h).defaultPrevented, false);
  await flush();
  assert.equal(h.opens.length, 0);
});

test('C is not intercepted on Axiom', async (t) => {
  const h = await setup(t, { url: 'https://axiom.trade' });
  assert.equal(press(h).defaultPrevented, false);
  await flush();
  assert.equal(h.opens.length, 0);
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

test('high-frequency class and text updates do not wake the wallet observer', async (t) => {
  const h = await setup(t);
  const ticker = h.window.document.createElement('div');
  ticker.textContent = 'price';
  h.window.document.body.append(ticker);
  await flush();
  const before = h.observed.records;
  for (let i = 0; i < 1000; i += 1) {
    ticker.className = `price-${i}`;
    ticker.firstChild.data = String(i);
  }
  await flush();
  assert.equal(h.observed.records, before);
});

test('an older row changing A to B to A in one batch cannot replace the latest notification', async (t) => {
  const h = await setup(t);
  const older = h.row(SOL);
  h.list.append(older);
  await flush();
  h.list.prepend(h.row(RH));
  await flush();
  older.href = `/sol/token/${SOL_NEXT}`;
  older.href = `/sol/token/${SOL}`;
  await flush();
  assert.equal(h.latest().ca, RH);
});

test('a transient detached row cannot displace a live notification', async (t) => {
  const h = await setup(t);
  const live = h.row(SOL);
  const clicks = [];
  h.list.addEventListener('click', (event) => { clicks.push(event.target); event.preventDefault(); });
  h.list.append(live);
  await flush();
  const transient = h.row(RH);
  h.list.prepend(transient);
  transient.remove();
  await flush();
  press(h);
  assert.deepEqual(clicks, [live]);
});

test('a late tracker marker is detected without text or class observation', async (t) => {
  const h = await setup(t);
  const row = h.window.document.createElement('a');
  row.href = `/sol/token/${SOL}`;
  h.list.append(row);
  await flush();
  assert.equal(h.latest().ok, false);
  row.setAttribute('data-sentry-component', 'TrackerListItem');
  await flush();
  assert.equal(h.latest().ca, SOL);
});

test('a new row is clicked before any observer microtask runs', async (t) => {
  const h = await setup(t, { history: [SOL] });
  const clicked = [];
  h.list.addEventListener('click', (e) => { e.preventDefault(); clicked.push(e.target); });
  const next = h.row(RH);
  h.list.prepend(next);
  press(h);
  assert.deepEqual(clicked, [next]);
});

test('rapid list replacement resolves each current row without stale-cache misses', async (t) => {
  const h = await setup(t);
  const clicked = [];
  h.list.addEventListener('click', (e) => { e.preventDefault(); clicked.push(e.target); });
  for (let i = 0; i < 200; i += 1) {
    const current = h.row(i % 2 ? SOL : RH);
    h.list.replaceChildren(current);
    press(h);
    assert.equal(clicked[i], current);
  }
  assert.equal(clicked.length, 200);
  assert.deepEqual(h.opens, []);
});

test('visual order wins over DOM order and hidden or clipped rows are skipped', async (t) => {
  const h = await setup(t);
  const hidden = h.row(SOL), lower = h.row(RH), upper = h.row(SOL_NEXT);
  hidden.style.display = 'none';
  lower.getBoundingClientRect = () => ({ top: 100, bottom: 130, left: 0, right: 200, width: 200, height: 30 });
  upper.getBoundingClientRect = () => ({ top: 40, bottom: 70, left: 0, right: 200, width: 200, height: 30 });
  const clip = h.window.document.createElement('div');
  clip.style.overflowY = 'hidden';
  clip.getBoundingClientRect = () => ({ top: 200, bottom: 300, left: 0, right: 200, width: 200, height: 100 });
  clip.append(h.row(RH_NEXT));
  h.list.append(hidden, lower, upper, clip);
  const clicked = [];
  h.list.addEventListener('click', (e) => { e.preventDefault(); clicked.push(e.target); });
  press(h);
  assert.deepEqual(clicked, [upper]);
});

test('already-rendered history can be clicked immediately after enabling', async (t) => {
  const h = await setup(t, { history: [SOL] });
  const clicked = [];
  h.list.addEventListener('click', (e) => { e.preventDefault(); clicked.push(e.target); });
  h.enable(false);
  press(h);
  assert.equal(clicked.length, 0);
  h.enable(true);
  press(h);
  assert.deepEqual(clicked, [h.list.firstChild]);
});
