const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

test('Twitter remarks stay within verified tweet cards and respect the event handle', () => {
  const source = readFileSync(require.resolve('../content.js'), 'utf8');
  const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
  const author = { getAttribute: () => 'toly', closest: () => null };
  const quotedAuthor = { getAttribute: () => 'phoenixtrade', closest: () => null };
  const tweetBody = {};
  const quotedBody = {};
  const walletBody = {};
  const header = {
    matches: () => false,
    querySelector: () => null,
    querySelectorAll: () => [{}],
    contains: () => true
  };
  const quoteHeader = { ...header };
  const inner = { ...header, parentElement: header, querySelector: selector => selector.startsWith('svg') ? {} : null };
  author.parentElement = inner;
  quotedAuthor.parentElement = quoteHeader;
  const tweetCard = {
    querySelector: () => tweetBody,
    querySelectorAll: selector => selector === 'div.cursor-text.select-text' ? [tweetBody, quotedBody] : [{}, {}]
  };
  const quoteCard = { querySelector: () => quotedBody, parentElement: tweetCard };
  const walletPanel = { querySelector: () => walletBody, querySelectorAll: () => [walletBody] };
  const page = { querySelector: () => tweetBody, querySelectorAll: () => [tweetBody, quotedBody, walletBody] };
  tweetBody.parentElement = tweetCard;
  tweetBody.previousElementSibling = header;
  quotedBody.parentElement = quoteCard;
  quotedBody.previousElementSibling = quoteHeader;
  walletBody.parentElement = walletPanel;
  walletPanel.parentElement = page;
  const captures = [];
  const social = {
    BODY_SELECTOR: 'div.cursor-text.select-text',
    nextRemarkSweepAt: 0,
    REMARK_ITEM_PREFIX: 'dsmTwitterRemarkV3:',
    REMARK_NICK_PREFIX: 'dsmTwitterNickV3:',
    remarkMap: new Map(),
    nickToHandleMap: new Map([['shared nickname', 'other_account']]),
    persistedNickMap: new Map(),
    ambiguousNickKeys: new Set()
  };
  const { sweepRemarks, mergeStoredTwitterMetadata, resolveSpokenName } = runInNewContext([
    section('  function captureTwitterRemark', '  function mergeStoredTwitterMetadata'),
    section('  function mergeStoredTwitterMetadata', '  function loadTwitterRemarks'),
    section('  function findTwitterRemarkHeader', '  // 控制台诊断'),
    section('  function normalizeHandleKey', '  function buildTwitterAnnouncement'),
    section('  function findTweetCardForNode', '  function highlightedKeywordFromEvent'),
    '({ sweepRemarks, mergeStoredTwitterMetadata, resolveSpokenName });'
  ].join('\n'), {
    social,
    performance: { now: () => 1000 },
    document: {
      body: {},
      querySelectorAll(selector) {
        assert.equal(selector, social.BODY_SELECTOR);
        return [tweetBody, quotedBody, walletBody];
      }
    },
    profileHandleAnchors: scope => (scope === header || scope === inner) ? [author] : scope === quoteHeader ? [quotedAuthor] : [],
    findAuthorNearHandle: () => 'Actual author',
    authorCandidates: scope => scope === inner ? [{ textContent: 'Toly' }] : [],
    profileHandleFromHref: value => value,
    findOrangeRemarkSpan: scope => scope === header ? { textContent: 'sol创始人' } : null,
    rememberRemark(handle, remark) {
      captures.push([handle, remark]);
      social.remarkMap.set(handle, remark);
    },
    cleanText: value => value.trim(),
    normalizeRemarkText: value => value || '',
    sanitizeSpokenAuthor: value => value,
    normalizeNickKey: value => value.toLowerCase(),
    rememberNickPair() {}
  });

  sweepRemarks();
  assert.deepEqual(captures, [['toly', 'sol创始人']]);
  assert.equal(resolveSpokenName({ id: 'toly', tw: 'phoenixtrade', name: 'Toly' }), 'sol创始人');
  mergeStoredTwitterMetadata({
    dsmTwitterRemarksV1: { actual_author: 'Old wallet label' },
    'dsmTwitterRemarkV2:actual_author': 'Wallet label',
    'dsmTwitterRemarkV3:other_account': 'Other account remark'
  });
  assert.equal(resolveSpokenName({ id: 'actual_author', tw: 'other_account', name: 'Shared nickname' }), '');
  mergeStoredTwitterMetadata({ 'dsmTwitterRemarkV3:actual_author': 'Correct remark' });
  assert.equal(resolveSpokenName({ id: 'actual_author', name: 'Shared nickname' }), 'Correct remark');
});

test('announcement uses available remarks and falls back without waiting', async () => {
  const source = readFileSync(require.resolve('../content.js'), 'utf8');
  const timers = [];
  const messages = [];
  const social = { started: true, sessionId: 1, announcedTexts: new Map(), remarkMap: new Map(),
    nickToHandleMap: new Map(), ANNOUNCE_TEXT_COOLDOWN_MS: 25000 };
  let rendered = false;
  const speak = runInNewContext(source.slice(source.indexOf('  function normalizeHandleKey'),
    source.indexOf('  function sendSpeakMessage')) + source.slice(source.indexOf('  async function speakTwitterAnnouncement'),
    source.indexOf('  function handleTwitterWsMessage')) + 'speakTwitterAnnouncement', {
    social, settings: { twitterVoiceEnabled: true }, isMasterOn: () => true,
    loadTwitterRemarks: () => new Promise(() => {}), setTimeout: callback => { timers.push(callback); },
    sweepRemarks: () => { if (rendered) social.remarkMap.set('alice', '小林'); },
    normalizeRemarkText: value => value || '', sanitizeSpokenAuthor: value => value || '',
    normalizeNickKey: value => value.toLowerCase(), rememberNickPair() {},
    sendSpeakMessage: text => messages.push(text)
  });
  const triggers = [{ id: 'alice', name: 'alice' }];
  await speak(triggers, 'first');
  assert.deepEqual(messages, ['alice 发推啦']);

  rendered = true;
  await speak(triggers, 'rendered');
  rendered = false;
  social.announcedTexts.clear();
  await speak(triggers, 'cached');
  await speak([{ id: 'bob', name: 'Bob' }], 'missing');
  assert.equal(timers.length, 0);
  assert.deepEqual(messages, ['alice 发推啦', '小林 发推啦', '小林 发推啦', 'Bob 发推啦']);
});
