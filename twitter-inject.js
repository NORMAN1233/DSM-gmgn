(function () {
  'use strict';

  if (window.__DSM_TWITTER_WS_ACTIVE) return;
  window.__DSM_TWITTER_WS_ACTIVE = true;

  const OriginalWebSocket = window.WebSocket;

  function hashText(value) {
    let hash = 0x811c9dc5;
    const text = String(value || '');
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
  }

  function isGmgnSocket(url) {
    try {
      const parsed = new URL(String(url || ''));
      const host = parsed.hostname.toLowerCase();
      return (parsed.protocol === 'ws:' || parsed.protocol === 'wss:')
        && (host === 'gmgn.ai' || host.endsWith('.gmgn.ai'));
    } catch (error) {
      return false;
    }
  }

  function unwrapPayload(raw) {
    let payload = JSON.parse(String(raw).replace(/^\d+/, ''));
    if (Array.isArray(payload) && payload.length >= 2) payload = payload[1];
    if (typeof payload === 'string') payload = JSON.parse(payload);
    return payload;
  }

  // 监控频道同时推送「发推」和「回复」两种事件；用户只要求播报发推。
  // GMGN 标记回复的字段名未公开，这里按常见命名的超集识别（Twitter API v1.1
  // 的 in_reply_to_*、v2 的 referenced_tweets、自造的 reply_*/parent_* 与
  // type 文本），命中任一即视为回复事件。字段名猜漏时真机样本可从
  // __dsmLastWsRawSample 拿到，再补进清单即可。
  function isReplyItem(item, scope) {
    const source = scope === 'user' ? item?.u : item;
    if (!source || typeof source !== 'object') return false;
    const meaningful = (value) => {
      if (value === undefined || value === null || value === false || value === 0 || value === '') return false;
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === 'object') return Object.keys(value).length > 0;
      return true;
    };
    for (const key of [
      'in_reply_to_status_id', 'in_reply_to_status_id_str', 'in_reply_to_tweet_id',
      'in_reply_to_id', 'in_reply_to_screen_name', 'in_reply_to_user_id',
      'reply_status_id', 'reply_tweet_id', 'reply_to_status_id',
      'reply_to', 'reply_to_screen_name', 'reply_to_user_id',
      'parent_status_id', 'parent_tweet_id'
    ]) {
      if (key in source && meaningful(source[key])) return true;
    }
    if (Array.isArray(source.referenced_tweets)
      && source.referenced_tweets.some((ref) => /repl/i.test(String(ref?.type || '')))) {
      return true;
    }
    const typeText = [source.type, source.tweet_type, source.event_type, source.action_type, source.category]
      .filter((value) => typeof value === 'string').join(' ').toLowerCase();
    return typeText.includes('reply');
  }

  function dispatchTwitterEvent(raw) {
    if (typeof raw !== 'string' || !raw.includes('twitter_user_monitor_basic')) return;

    try {
      const payload = unwrapPayload(raw);
      if (payload?.channel !== 'twitter_user_monitor_basic' || !Array.isArray(payload.data)) return;

      const rawItems = payload.data.filter((item) => item && typeof item === 'object');
      const activeItems = [];
      const replyItems = [];
      for (const item of rawItems) {
        (isReplyItem(item, 'item') || isReplyItem(item, 'user') ? replyItems : activeItems).push(item);
      }
      // 诊断用：页面主世界控制台输入 __dsmLastWsRawSample 可查看最近一帧的
      // 完整原始字段，用于核对回复识别是否误判/漏判。
      try {
        window.__dsmLastWsRawSample = {
          at: Date.now(),
          kept: activeItems.length,
          droppedAsReply: replyItems.length,
          items: rawItems
        };
      } catch (error) {}

      const authors = new Map();
      const stableIds = [];
      for (const item of activeItems) {
        const twitterId = String(item?.u?.s || '').trim();
        if (!twitterId) continue;
        authors.set(twitterId.toLowerCase(), {
          id: twitterId,
          name: String(item?.u?.n || twitterId).trim(),
          tw: String(item?.tw || 'unknown').toLowerCase()
        });
        const stableId = item?.tweet_id ?? item?.tweetId ?? item?.status_id
          ?? item?.statusId ?? item?.id_str ?? item?.id;
        if (stableId !== undefined && stableId !== null && String(stableId).trim()) {
          stableIds.push(String(stableId).trim());
        }
      }

      const triggers = Array.from(authors.values());
      if (!triggers.length) return;
      // 诊断用：页面控制台直接输入 __dsmLastWsSample 可查看最近一帧的原始
      // 字段（id/tw/name 到底是什么），用于排查备注匹配不上的问题。
      try { window.__dsmLastWsSample = triggers; } catch (error) {}
      const fingerprint = stableIds.length
        ? stableIds.sort().join('|')
        : JSON.stringify(activeItems);

      window.dispatchEvent(new CustomEvent('DSM_TWITTER_WS_MSG_RECEIVED', {
        detail: { triggers, eventId: `twitter:${hashText(fingerprint)}` }
      }));
    } catch (error) {
      // A malformed or unrelated GMGN frame must never affect the page socket.
    }
  }

  window.WebSocket = function (url, protocols) {
    const socket = protocols === undefined
      ? new OriginalWebSocket(url)
      : new OriginalWebSocket(url, protocols);
    if (isGmgnSocket(url)) {
      socket.addEventListener('message', (event) => dispatchTwitterEvent(event.data));
    }
    return socket;
  };

  window.WebSocket.prototype = OriginalWebSocket.prototype;
  for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
    try { window.WebSocket[key] = OriginalWebSocket[key]; } catch (error) {}
  }
})();
