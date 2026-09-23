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
    window, list, row, writes, requests, opens,
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

test('removed or reused notifications never fall back to URL navigation or click another token', async (t) => {
  const h = await setup(t);
  const row = h.row(SOL);
  let clicks = 0;
  row.addEventListener('click', (event) => { clicks += 1; event.preventDefault(); });
  h.list.prepend(row);
  await flush();
  row.href = `/robinhood/token/${RH}`;
  press(h);
  assert.equal(clicks, 0);
  await flush();
  press(h);
  assert.equal(clicks, 1);
  row.remove();
  press(h);
  assert.equal(clicks, 1);
  assert.match(h.window.document.getElementById('dsm-wallet-click-status').textContent, /消失或更新/);
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
