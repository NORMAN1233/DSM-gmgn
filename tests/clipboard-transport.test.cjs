const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const code = source.slice(source.indexOf('const walletWriterEpoch'), source.indexOf('async function sendEdgeTtsCommand'));

test('timed-out setup cannot later write an older CA or block a newer one', async () => {
  let release, calls = 0;
  const sent = [];
  const gate = new Promise((resolve) => { release = resolve; });
  const context = vm.createContext({ setTimeout, clearTimeout,
    ensureOffscreenDocument: async () => { if (++calls === 1) await gate; },
    chrome: { storage: { local: { get: async () => ({}) } }, runtime: { sendMessage: async (message) => { sent.push(message); return { ok: true }; } } }
  });
  vm.runInContext(code, context);
  const old = await vm.runInContext('copyWalletCA({ca:"old", deadline:Date.now()+20})', context);
  assert.equal(old.reason, 'clipboard-timeout');
  const fresh = await vm.runInContext('copyWalletCA({ca:"new", deadline:Date.now()+500})', context);
  assert.equal(fresh.ok, true);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent.map((message) => message.ca), ['new']);
});

test('disabled copying does not create or call the clipboard document', async () => {
  const context = vm.createContext({ setTimeout, clearTimeout,
    ensureOffscreenDocument: () => assert.fail('must not create document'),
    chrome: { storage: { local: { get: async () => ({ dsmSetting_officialWalletCopyEnabled: false }) } } }
  });
  vm.runInContext(code, context);
  const result = await vm.runInContext('copyWalletCA({ca:"test"})', context);
  assert.equal(result.reason, 'copy-disabled');
});

test('offscreen rejects an expired request before touching the clipboard', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'offscreen.js'), 'utf8');
  let listener, reply;
  const context = vm.createContext({
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } },
    document: { createElement() { assert.fail('expired request reached clipboard'); } }
  });
  vm.runInContext(source.slice(source.indexOf('let walletWriteWatermark')), context);
  listener({ target: 'offscreen', type: 'DSM_WALLET_COPY_CA', writerEpoch: 1, revision: 1, deadline: Date.now() - 10, ca: 'old' }, {}, (result) => { reply = result; });
  assert.equal(reply.reason, 'clipboard-timeout');
});

test('new target bypasses pending old setup and suppresses it before its deadline', async () => {
  let release, calls = 0;
  const sent = [];
  const gate = new Promise((resolve) => { release = resolve; });
  const context = vm.createContext({ setTimeout, clearTimeout,
    ensureOffscreenDocument: async () => { if (++calls === 1) await gate; },
    chrome: { storage: { local: { get: async () => ({}) } }, runtime: { sendMessage: async (message) => { sent.push(message); return { ok: true }; } } }
  });
  vm.runInContext(code, context);
  const old = vm.runInContext('copyWalletCA({ca:"old",streamId:"feed",sequence:1})', context);
  await new Promise((resolve) => setImmediate(resolve));
  const fresh = await vm.runInContext('copyWalletCA({ca:"new",streamId:"feed",sequence:2})', context);
  assert.equal(fresh.ok, true);
  release();
  assert.equal((await old).reason, 'superseded');
  assert.deepEqual(sent.map((message) => message.ca), ['new']);
  const late = await vm.runInContext('copyWalletCA({ca:"late-old",streamId:"feed",sequence:1})', context);
  assert.equal(late.reason, 'superseded');
});

test('offscreen rejects reordered old writes and honors a cancellation watermark', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'offscreen.js'), 'utf8');
  let listener, area;
  const writes = [];
  const context = vm.createContext({
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } },
    document: { body: { appendChild() {} }, createElement() { area = { focus() {}, select() {}, remove() {} }; return area; }, execCommand() { writes.push(area.value); return true; } }
  });
  vm.runInContext(source.slice(source.indexOf('let walletWriteWatermark')), context);
  function send(revision, ca, type = 'DSM_WALLET_COPY_CA') {
    let reply;
    listener({ target: 'offscreen', type, writerEpoch: 1, revision, deadline: Date.now() + 1000, ca }, {}, (r) => { reply = r; });
    return reply;
  }
  assert.equal(send(2, 'new').ok, true);
  assert.equal(send(1, 'old').reason, 'superseded');
  send(4, '', 'DSM_WALLET_COPY_CANCEL');
  assert.equal(send(3, 'cancelled').reason, 'superseded');
  assert.deepEqual(writes, ['new']);
});
