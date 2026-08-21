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

  function dispatchTwitterEvent(raw) {
    if (typeof raw !== 'string' || !raw.includes('twitter_user_monitor_basic')) return;

    try {
      const payload = unwrapPayload(raw);
      if (payload?.channel !== 'twitter_user_monitor_basic' || !Array.isArray(payload.data)) return;

      const authors = new Map();
      const stableIds = [];
      for (const item of payload.data) {
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
      const fingerprint = stableIds.length
        ? stableIds.sort().join('|')
        : JSON.stringify(payload.data);

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
