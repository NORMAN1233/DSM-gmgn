const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const code = source.slice(source.indexOf('  const social = {'), source.indexOf('  function sendSpeakMessage('));

function setup(html = '') {
  const dom = new JSDOM(html, { url: 'https://gmgn.ai', runScripts: 'outside-only' });
  const removed = [];
  dom.window.chrome = { storage: {
    local: {
      set: async () => {},
      remove: async (key) => { removed.push(key); }
    },
    onChanged: { addListener: () => {} }
  } };
  dom.window.console.debug = () => {};
  dom.window.eval(`${code}\nwindow.twitterTest = {
    social, captureTwitterRemark, sweepRemarks, normalizeRemarkText,
    mergeStoredTwitterMetadata, buildTwitterAnnouncement
  };`);
  return { ...dom.window.twitterTest, document: dom.window.document, removed, close: () => dom.window.close() };
}

function header(handle, name) {
  return `<div class="author-header"><span class="text-text-100 leading-[20px]">${name}</span>
    <a href="https://x.com/${handle}">@${handle}</a></div>`;
}

test('reply indicators with arrows cannot be persisted or spoken as author remarks', () => {
  const app = setup();
  try {
    for (const value of ['↪ 回复', '↩️ 回复', '➥ Replying to', '→ 回复 @himgajria', '（回复）']) {
      assert.equal(app.normalizeRemarkText(value, 'himgajria'), '', value);
      app.social.remarkMap.set('himgajria', value);
      assert.equal(app.buildTwitterAnnouncement([{ id: 'himgajria', name: 'Him' }]), 'Him 发推啦');
    }
  } finally { app.close(); }
});

test('loading an old arrow-prefixed reply remark removes the polluted cache', () => {
  const app = setup();
  try {
    app.mergeStoredTwitterMetadata({ 'dsmTwitterRemarkV2:himgajria': '↪ 回复' });
    assert.equal(app.social.remarkMap.has('himgajria'), false);
    assert.ok(app.removed.includes('dsmTwitterRemarkV2:himgajria'));
    assert.equal(app.buildTwitterAnnouncement([{ id: 'himgajria', name: 'Him' }]), 'Him 发推啦');
  } finally { app.close(); }
});

test('a header without an edit icon never takes an orange label from the tweet content', () => {
  const app = setup(`<article>${header('himgajria', 'Him')}
    <div><span style="color:rgb(248,185,81)">正文高亮</span>
      <div class="cursor-text select-text">正文和引用</div></div></article>`);
  try {
    app.sweepRemarks();
    assert.equal(app.social.remarkMap.has('himgajria'), false);
    assert.equal(app.buildTwitterAnnouncement([{ id: 'himgajria', name: 'Him' }]), 'Him 发推啦');
  } finally { app.close(); }
});

test('a real header remark wins while reply targets and quoted authors are excluded', () => {
  const app = setup(`<article><div class="author-header">
    <span class="text-text-100 leading-[20px]">Him</span>
    <span style="color:rgb(248,185,81)">我的备注</span>
    <a href="https://x.com/himgajria">@himgajria</a></div>
    <div class="cursor-text select-text"><span style="color:rgb(248,185,81)">↪ 回复</span>
      <a href="https://x.com/Chubbi230">@Chubbi230</a>
      <blockquote>${header('Chubbi230', '引用作者')}</blockquote></div></article>`);
  try {
    app.sweepRemarks();
    assert.equal(app.social.remarkMap.get('himgajria'), '我的备注');
    assert.equal(app.social.remarkMap.has('chubbi230'), false);
    assert.equal(app.buildTwitterAnnouncement([{ id: 'himgajria', name: 'Him' }]), '我的备注 发推啦');
  } finally { app.close(); }
});

test('legitimate symbol-prefixed remarks remain available', () => {
  const app = setup();
  try {
    app.social.remarkMap.set('himgajria', '🚀 老王');
    assert.equal(app.buildTwitterAnnouncement([{ id: 'himgajria', name: 'Him' }]), '老王 发推啦');
  } finally { app.close(); }
});
