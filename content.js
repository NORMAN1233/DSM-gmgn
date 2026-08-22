(() => {
  'use strict';

  // ============================================================
  // DSM-gmgn v2.6.1 Content Script
  // 原插件 1：GMGN 已看 CA 标记（jiankongtiao）
  // 原插件 2：GMGN 5秒极速辅助决策（GMGN-5s-Decision / C:\repo 圆形倒计时版）
  // 设计目标：功能可开关、设置持久化、UI 对齐 DataStorm、尽量不拖慢 GMGN 页面。
  // ============================================================

  const SETTINGS_KEY = 'dsmSettings'; // legacy aggregate, read-only after v2.0.2 migration
  const SETTING_FIELD_PREFIX = 'dsmSetting_';
  const DEFAULT_SETTINGS = {
    dsmEnabled: true,
    viewedCAEnabled: true,
    twitterVoiceEnabled: true,
    twitterVoiceVolume: 100,
    twitterVoiceName: 'zh-CN-XiaoxiaoNeural',
    twitterVoiceRate: 115,
    selectionSearchEnabled: true,
    decisionEnabled: true,
    batteryEnabled: true,
    decisionSeconds: 5,
    circleSize: 120,
    circlePosition: null,
    batteryMinutes: 40,
    restMinutes: 20
  };

  const SETTING_FIELDS = Object.keys(DEFAULT_SETTINGS);
  const EDGE_TTS_VOICE_IDS = new Set([
    'zh-CN-XiaoxiaoNeural',
    'zh-CN-YunjianNeural',
    'zh-CN-XiaoyiNeural',
    'en-US-AvaMultilingualNeural'
  ]);
  const settingFieldKey = (name) => `${SETTING_FIELD_PREFIX}${name}`;
  const SETTING_FIELD_KEYS = SETTING_FIELDS.map(settingFieldKey);

  let settings = { ...DEFAULT_SETTINGS };

  function settingsFromStorage(data) {
    const next = { ...DEFAULT_SETTINGS, ...(data[SETTINGS_KEY] || {}) };
    for (const field of SETTING_FIELDS) {
      const key = settingFieldKey(field);
      if (Object.prototype.hasOwnProperty.call(data, key)) next[field] = data[key];
    }
    if (!EDGE_TTS_VOICE_IDS.has(String(next.twitterVoiceName || ''))) {
      next.twitterVoiceName = DEFAULT_SETTINGS.twitterVoiceName;
    }
    if (![115, 150, 175].includes(Number(next.twitterVoiceRate))) {
      next.twitterVoiceRate = DEFAULT_SETTINGS.twitterVoiceRate;
    }
    return next;
  }

  function migrateLegacySettings(data, snapshot) {
    const seed = {};
    for (const field of SETTING_FIELDS) {
      const key = settingFieldKey(field);
      if (!Object.prototype.hasOwnProperty.call(data, key)) seed[key] = snapshot[field];
    }
    if (Object.keys(seed).length) chrome.storage.local.set(seed).catch(() => {});
  }

  async function readSettingsSnapshot() {
    const data = await chrome.storage.local.get([SETTINGS_KEY, ...SETTING_FIELD_KEYS]);
    return { data, snapshot: settingsFromStorage(data) };
  }

  function clampInt(value, min, max, fallback) {
    const n = parseInt(value, 10);
    if (Number.isNaN(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function clampSize(value) {
    return clampInt(value, 60, 400, 120);
  }

  async function loadSettings() {
    try {
      const { data, snapshot } = await readSettingsSnapshot();
      settings = snapshot;
      migrateLegacySettings(data, snapshot);
    } catch (error) {
      settings = { ...DEFAULT_SETTINGS };
    }
    applyAll();
  }

  function isMasterOn() {
    return !!settings.dsmEnabled;
  }

  // ============================================================
  // 模块一：已看 CA 标记（事件驱动 + 轻量 DOM 观察）
  // ============================================================
  const viewed = {
    started: false,
    STORAGE_KEY: 'gmgnViewedCAs',
    CLEAR_KEY: 'gmgnViewedCAsClearedAt',
    LS_KEY: 'gmgn_viewed_cas',
    // GMGN 2026-08 已移除 TrackerListItem 的 data-sentry-component。
    // 用稳定的 token 路由识别卡片，避免再绑定到 React/Sentry 内部实现细节。
    CARD_SELECTOR: 'a[href*="/token/"]',
    VIEWED_CLASS: 'gmgn-viewed-ca-card-viewed',
    TOKEN_PATH_RE: /\/(?:sol|eth|base|bsc|ton|sui|btc|trx|tron)\/token\/([^/?#]+)/i,
    TOKEN_HREF_RE: /\/(?:sol|eth|base|bsc|ton|sui|btc|trx|tron)\/token\/([^/?#]+)/i,
    viewedMap: new Map(),
    lastUrl: location.href,
    scanQueued: false,
    onMonitorPage: false,
    styleInjected: false,
    ac: null,
    processedCards: new WeakSet(),
    hiddenBarsByCard: new WeakMap(),
    persistTimer: null,
    observer: null,
    rescanTimers: new Set(),
    clearedAt: 0
  };

  function normalizeCA(value) {
    const ca = String(value || '').trim();
    if (!ca) return '';
    return /^0x/i.test(ca) ? ca.toLowerCase() : ca;
  }

  function getCAFromHref(href) {
    const match = String(href || '').match(viewed.TOKEN_HREF_RE);
    return match ? normalizeCA(match[1]) : '';
  }

  function getCurrentTokenCA() {
    const match = location.pathname.match(viewed.TOKEN_PATH_RE);
    return match ? normalizeCA(match[1]) : '';
  }


  function readLocalViewed() {
    try {
      const raw = localStorage.getItem(viewed.LS_KEY);
      if (!raw) return new Map();
      return new Map(Object.entries(JSON.parse(raw)));
    } catch (error) {
      return new Map();
    }
  }

  function writeLocalViewed() {
    try {
      localStorage.setItem(viewed.LS_KEY, JSON.stringify(Object.fromEntries(viewed.viewedMap)));
    } catch (error) {
      // ignore
    }
  }

  function clearLocalViewed() {
    try {
      localStorage.removeItem(viewed.LS_KEY);
    } catch (error) {
      // ignore
    }
  }

  function pruneViewedByClearTime() {
    if (!viewed.clearedAt) return false;
    let changed = false;
    for (const [ca, ts] of viewed.viewedMap) {
      if (Number(ts) < viewed.clearedAt) {
        viewed.viewedMap.delete(ca);
        changed = true;
      }
    }
    return changed;
  }

  function mergeViewedMap(sourceMap, addedMembership = null) {
    let changed = false;
    for (const [rawCA, rawTs] of sourceMap || []) {
      const ca = normalizeCA(rawCA);
      const ts = Number(rawTs) || 0;
      if (!ca || (viewed.clearedAt && ts < viewed.clearedAt)) continue;
      const current = Number(viewed.viewedMap.get(ca) || 0);
      if (!current || ts > current) {
        viewed.viewedMap.set(ca, ts || Date.now());
        if (!current && addedMembership) addedMembership.add(ca);
        changed = true;
      }
    }
    return changed;
  }

  async function saveViewed() {
    // 写入前再次合并浏览器存储 + 同源 localStorage，避免多个 GMGN 标签页
    // 各自拿着旧快照做整表覆盖，造成“最后写入者”吞掉另一标签页的新 CA。
    const data = await chrome.storage.local.get([viewed.STORAGE_KEY, viewed.CLEAR_KEY]);
    viewed.clearedAt = Math.max(viewed.clearedAt, Number(data[viewed.CLEAR_KEY] || 0));
    mergeViewedMap(new Map(Object.entries(data[viewed.STORAGE_KEY] || {})));
    mergeViewedMap(readLocalViewed());
    pruneViewedByClearTime();
    writeLocalViewed();
    await chrome.storage.local.set({ [viewed.STORAGE_KEY]: Object.fromEntries(viewed.viewedMap) });
  }

  async function loadViewed() {
    try {
      const data = await chrome.storage.local.get([viewed.STORAGE_KEY, viewed.CLEAR_KEY]);
      viewed.clearedAt = Number(data[viewed.CLEAR_KEY] || 0);
      viewed.viewedMap = new Map();
      mergeViewedMap(new Map(Object.entries(data[viewed.STORAGE_KEY] || {})));
      mergeViewedMap(readLocalViewed());
      pruneViewedByClearTime();
      writeLocalViewed();
      saveViewed().catch(() => {});
      scheduleViewedRescans();
    } catch (error) {
      console.warn('[DSM-gmgn] 读取已看 CA 失败：', error);
    }
  }

  function markViewed(ca) {
    ca = normalizeCA(ca);
    if (!ca) return;

    // localStorage 在同一 gmgn.ai origin 的标签页之间共享。先吸收其他标签页
    // 最新数据，再追加当前 CA；立即写本地用于跨标签页快速传播，Chrome storage
    // 仍保持 1 秒节流持久化，兼顾性能与可靠性。
    mergeViewedMap(readLocalViewed());
    if (viewed.viewedMap.has(ca)) return;
    viewed.viewedMap.set(ca, Date.now());
    writeLocalViewed();
    applyViewedForCA(ca);
    persistViewedDebounced();
  }

  // 已看集合持久化节流：高频浏览时避免每次访问都对整个（持续增大的）Map 做
  // 同步 JSON 序列化（localStorage 写入会阻塞主线程），合并到每秒最多一次。
  function persistViewedDebounced() {
    if (viewed.persistTimer !== null) return;
    viewed.persistTimer = setTimeout(() => {
      viewed.persistTimer = null;
      try {
        writeLocalViewed();
      } catch (error) {
        // ignore
      }
      saveViewed().catch((error) => {
        console.warn('[DSM-gmgn] 保存已看 CA 失败：', error);
      });
    }, 1000);
  }

  function injectViewedStyle() {
    if (viewed.styleInjected) return;
    viewed.styleInjected = true;
    const style = document.createElement('style');
    style.id = 'dsm-viewed-style';
    style.textContent = `
      .${viewed.VIEWED_CLASS} {
        border-left-color: transparent !important;
      }
      .${viewed.VIEWED_CLASS}::before,
      .${viewed.VIEWED_CLASS}::after {
        display: none !important;
      }
      .${viewed.VIEWED_CLASS} [class*="border-l"],
      .${viewed.VIEWED_CLASS} [style*="border-left"] {
        border-left-color: transparent !important;
      }
      /* Current GMGN monitor rail: CSS handles React re-creation instantly, so
         JS does not need to rediscover/rewrite the rail on every repaint. */
      .${viewed.VIEWED_CLASS} > .left-0.top-0.bottom-0,
      .${viewed.VIEWED_CLASS} [class~="left-0"][class~="top-0"][class~="bottom-0"],
      .${viewed.VIEWED_CLASS} > [style*="rgb(123, 68, 242)"],
      .${viewed.VIEWED_CLASS} > [style*="rgb(123,68,242)"],
      .${viewed.VIEWED_CLASS} > [style*="#7b44f2"] {
        display: none !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function hideCardLeftBars(card) {
    // Fast path for GMGN's current left rail. Avoid walking every descendant and
    // calling getBoundingClientRect() on each node — that can force layout on a
    // busy monitoring feed. Only inspect elements that can plausibly be the rail.
    // The injected stylesheet handles the current rail shape without any inline
    // mutation. If such a rail exists, there is nothing for JS to do.
    if (card.querySelector('.left-0.top-0.bottom-0, [class~="left-0"][class~="top-0"][class~="bottom-0"]')) return;

    const selector = [
      ':scope > span.left-0.top-0.bottom-0',
      ':scope > [class~="left-0"][class~="top-0"][class~="bottom-0"]',
      ':scope > [style*="rgb(123, 68, 242)"]',
      ':scope > [style*="rgb(123,68,242)"]',
      ':scope > [style*="#7b44f2"]'
    ].join(',');

    let candidates = [];
    try { candidates = Array.from(card.querySelectorAll(selector)); } catch (error) {}

    // Structural fallback stays deliberately narrow. It preserves compatibility
    // if GMGN moves the rail one wrapper deeper without turning this into an
    // expensive card-wide layout scan.
    if (!candidates.length) {
      try {
        candidates = Array.from(card.querySelectorAll(
          '[class~="left-0"][class~="top-0"][class~="bottom-0"],'
          + '[style*="rgb(123, 68, 242)"],[style*="rgb(123,68,242)"],[style*="#7b44f2"]'
        )).slice(0, 6);
      } catch (error) {}
    }

    if (!candidates.length) return;
    const hidden = viewed.hiddenBarsByCard.get(card) || new Set();
    for (const el of candidates) {
      const cls = typeof el.className === 'string' ? el.className : '';
      const inlineBg = String(el.style?.backgroundColor || '').replace(/\s+/g, '');
      const isKnownPurple = inlineBg === 'rgb(123,68,242)' || inlineBg === '#7b44f2';
      const isRail = cls.includes('left-0') && cls.includes('top-0') && cls.includes('bottom-0');
      if (!isKnownPurple && !isRail) continue;

      if (el.dataset.gmgnPrevDisplay === undefined) el.dataset.gmgnPrevDisplay = el.style.display || '';
      if (el.style.display !== 'none') el.style.setProperty('display', 'none', 'important');
      hidden.add(el);
    }
    if (hidden.size) viewed.hiddenBarsByCard.set(card, hidden);
  }

  function restoreCardLeftBars(card) {
    const hidden = viewed.hiddenBarsByCard.get(card);
    if (!hidden) return;
    for (const el of hidden) {
      if (!el?.style || el.dataset?.gmgnPrevDisplay === undefined) continue;
      el.style.display = el.dataset.gmgnPrevDisplay;
      delete el.dataset.gmgnPrevDisplay;
    }
    viewed.hiddenBarsByCard.delete(card);
  }

  function applyToCard(card) {
    const href = card.getAttribute && card.getAttribute('href');
    const ca = getCAFromHref(href);
    if (!ca) return;

    const isViewed = viewed.viewedMap.has(ca);
    card.classList.toggle(viewed.VIEWED_CLASS, isViewed);

    if (isViewed) {
      // 已应用过则跳过，避免每次扫描重复写相同样式触发样式失效/重排
      if (card.style.borderLeftColor !== 'transparent') {
        card.style.setProperty('border-left-color', 'transparent', 'important');
      }
      if (card.style.borderLeftWidth !== '0') {
        card.style.setProperty('border-left-width', '0', 'important');
      }
      if (!viewed.processedCards.has(card)) {
        hideCardLeftBars(card);
        viewed.processedCards.add(card);
      }
    } else {
      if (card.style.borderLeftColor !== '') {
        card.style.removeProperty('border-left-color');
      }
      if (card.style.borderLeftWidth !== '') {
        card.style.removeProperty('border-left-width');
      }
      if (viewed.processedCards.has(card)) {
        restoreCardLeftBars(card);
        viewed.processedCards.delete(card);
      }
    }
  }

  function applyViewedToAll() {
    if (!viewed.started) return;
    const cards = document.querySelectorAll(viewed.CARD_SELECTOR);
    viewed.onMonitorPage = cards.length > 0 || /\/(?:follow|wallet|monitor|tracker|watch)(?:\/|$)/i.test(location.pathname);
    if (!cards.length) return;
    for (const card of cards) applyToCard(card);
  }

  function applyViewedForCA(ca) {
    if (!viewed.started || !ca) return;
    // CA values are base58/hex in practice; CSS.escape also makes this safe if a
    // future chain uses punctuation. Targeted updates avoid rescanning the whole
    // monitor list every time the user opens one token.
    const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(ca) : ca.replace(/[\"\\]/g, '\\$&');
    let cards = [];
    try { cards = document.querySelectorAll(`a[href*="/token/${escaped}"]`); } catch (error) {}
    for (const card of cards) {
      if (getCAFromHref(card.getAttribute('href')) === ca) applyToCard(card);
    }
  }

  function scheduleViewedScan() {
    if (!viewed.started) return;
    if (viewed.scanQueued) return;
    viewed.scanQueued = true;

    const run = () => {
      viewed.scanQueued = false;
      applyViewedToAll();
    };

    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(run, { timeout: 400 });
    } else {
      setTimeout(run, 120);
    }
  }

  function scheduleViewedRescans() {
    if (!viewed.started) return;
    scheduleViewedScan();

    // pageshow + focus + visibilitychange can arrive together. One pending retry
    // sequence is enough; stacking identical timers only creates redundant wakeups.
    if (viewed.rescanTimers.size) return;

    // GMGN 列表是 React/SPA 异步渲染。首次 URL 变化时 DOM 可能尚未落地，
    // 做几次短时补扫兜底；真正的持续变化由下方 MutationObserver 驱动。
    for (const delay of [120, 400, 1000]) {
      const id = setTimeout(() => {
        viewed.rescanTimers.delete(id);
        scheduleViewedScan();
      }, delay);
      viewed.rescanTimers.add(id);
    }
  }

  function startViewedObserver() {
    if (viewed.observer || !document.documentElement) return;

    viewed.observer = new MutationObserver((mutations) => {
      if (!viewed.started) return;
      const cardsToApply = new Set();
      let fallbackScan = false;

      for (const mutation of mutations) {
        const target = mutation.target?.nodeType === 1 ? mutation.target : mutation.target?.parentElement;
        const ownerCard = target && (target.matches?.(viewed.CARD_SELECTOR)
          ? target
          : target.closest?.(viewed.CARD_SELECTOR));
        if (ownerCard) cardsToApply.add(ownerCard);

        if (mutation.type !== 'childList') continue;
        for (const node of mutation.addedNodes) {
          if (!node || node.nodeType !== 1) continue;
          if (node.matches?.(viewed.CARD_SELECTOR)) {
            cardsToApply.add(node);
            continue;
          }
          const cards = node.querySelectorAll?.(viewed.CARD_SELECTOR);
          if (cards?.length) for (const card of cards) cardsToApply.add(card);
        }
      }

      // A mutation batch can contain dozens of records for one React card. Apply
      // that card once per batch instead of once per mutation record.
      for (const card of cardsToApply) {
        viewed.processedCards.delete(card);
        applyToCard(card);
      }
      if (fallbackScan) scheduleViewedScan();
    });

    viewed.observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href']
    });
  }

  function stopViewedObserver() {
    if (viewed.observer) {
      viewed.observer.disconnect();
      viewed.observer = null;
    }
    for (const id of viewed.rescanTimers) clearTimeout(id);
    viewed.rescanTimers.clear();
  }

  function handleViewedUrlChange() {
    if (!viewed.started) return;
    const ca = getCurrentTokenCA();
    if (ca) markViewed(ca);

    scheduleViewedRescans();
  }

  function watchedViewedUrl() {
    if (location.href !== viewed.lastUrl) {
      viewed.lastUrl = location.href;
      handleViewedUrlChange();
    }
  }

  // 监控页直接点击 / Ctrl+点击 / 中键打开新标签时，原标签页 URL 不会变化。
  // 在点击发生的这一刻就记录 CA，可让紫色条立即消失，也不依赖后台新标签页
  // 是否及时加载、是否被浏览器节流。
  function handleTokenClick(event) {
    const anchor = event.target && event.target.closest
      ? event.target.closest(viewed.CARD_SELECTOR)
      : null;
    if (!anchor) return;
    const ca = getCAFromHref(anchor.getAttribute && anchor.getAttribute('href'));
    if (ca) markViewed(ca);
  }

  function startViewed() {
    if (viewed.started) return;
    viewed.started = true;

    injectViewedStyle();
    startViewedObserver();
    loadViewed();
    handleViewedUrlChange();
    watchedViewedUrl();
    patchHistory();

    viewed.ac = new AbortController();
    document.addEventListener('click', handleTokenClick, { capture: true, signal: viewed.ac.signal });
    document.addEventListener('auxclick', handleTokenClick, { capture: true, signal: viewed.ac.signal });
    window.addEventListener('popstate', watchedViewedUrl, { signal: viewed.ac.signal });
    window.addEventListener('hashchange', watchedViewedUrl, { signal: viewed.ac.signal });
    window.addEventListener('pageshow', scheduleViewedRescans, { signal: viewed.ac.signal });
    window.addEventListener('focus', scheduleViewedRescans, { signal: viewed.ac.signal });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) scheduleViewedRescans();
    }, { signal: viewed.ac.signal });
    window.addEventListener('storage', (event) => {
      if (event.key !== viewed.LS_KEY) return;
      const beforeSize = viewed.viewedMap.size;
      let incoming = new Map();
      try {
        incoming = new Map(Object.entries(event.newValue ? JSON.parse(event.newValue) : {}));
      } catch (error) {
        return;
      }
      const added = new Set();
      const changed = mergeViewedMap(incoming, added);
      const pruned = pruneViewedByClearTime();
      if (changed || pruned || viewed.viewedMap.size !== beforeSize) {
        writeLocalViewed();
        if (pruned) scheduleViewedScan();
        else for (const ca of added) applyViewedForCA(ca);
        persistViewedDebounced();
      }
    }, { signal: viewed.ac.signal });
  }

  function stopViewed() {
    if (!viewed.started) return;
    viewed.started = false;

    if (viewed.ac) {
      viewed.ac.abort();
      viewed.ac = null;
    }
    stopViewedObserver();
    viewed.scanQueued = false;

    document.querySelectorAll('.' + viewed.VIEWED_CLASS).forEach((card) => {
      card.classList.remove(viewed.VIEWED_CLASS);
      card.style.removeProperty('border-left-color');
      card.style.removeProperty('border-left-width');
      if (viewed.processedCards.has(card)) {
        restoreCardLeftBars(card);
        viewed.processedCards.delete(card);
      }
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    // Settings are stored per-field from v2.0.2 onward so concurrent tabs cannot
    // overwrite unrelated values. Batch all changed fields into one local update.
    const settingsPatch = {};
    for (const field of SETTING_FIELDS) {
      const change = changes[settingFieldKey(field)];
      if (change) settingsPatch[field] = change.newValue;
    }
    if (Object.keys(settingsPatch).length) {
      applySettingsUpdate({ ...settings, ...settingsPatch });
    } else if (changes[SETTINGS_KEY]) {
      // Legacy writer compatibility: re-read with per-field keys taking priority.
      readSettingsSnapshot()
        .then(({ snapshot }) => applySettingsUpdate(snapshot))
        .catch(() => {});
    }

    let membershipChanged = false;
    let requiresFullViewedScan = false;
    const addedViewedCAs = new Set();

    if (changes[viewed.CLEAR_KEY]) {
      viewed.clearedAt = Number(changes[viewed.CLEAR_KEY].newValue || 0);
      const pruned = pruneViewedByClearTime();
      membershipChanged = pruned || membershipChanged;
      requiresFullViewedScan = pruned || requiresFullViewedScan;
      writeLocalViewed();
    }

    if (changes[viewed.STORAGE_KEY]) {
      const next = new Map(Object.entries(changes[viewed.STORAGE_KEY].newValue || {}));
      const beforeSize = viewed.viewedMap.size;
      const merged = mergeViewedMap(next, addedViewedCAs);
      const pruned = pruneViewedByClearTime();
      membershipChanged = merged || pruned || viewed.viewedMap.size !== beforeSize || membershipChanged;
      requiresFullViewedScan = pruned || requiresFullViewedScan;

      // 如果收到的是另一个标签页的旧快照，绝不反向删掉本页已有记录；
      // 检测到远端缺项后，节流回写当前并集，让 chrome.storage 最终收敛。
      let remoteMissingLocal = false;
      for (const ca of viewed.viewedMap.keys()) {
        if (!next.has(ca)) {
          remoteMissingLocal = true;
          break;
        }
      }

      if (viewed.viewedMap.size === 0) clearLocalViewed();
      else writeLocalViewed();

      if (remoteMissingLocal && viewed.started) persistViewedDebounced();
    }

    if (viewed.started && membershipChanged) {
      if (requiresFullViewedScan) scheduleViewedScan();
      else for (const ca of addedViewedCAs) applyViewedForCA(ca);
    }
  });

  // ============================================================
  // 模块二：GMGN 推特监控增强
  // 1) 从 GMGN WebSocket 直接取得博主名字并低延迟播报
  // 2) 推文正文划词或点击 GMGN 高亮词后，优先投送另一屏，单窗口时使用当前页顶部代币搜索
  // ============================================================
  const social = {
    started: false,
    observer: null,
    scanTimer: null,
    retryPending: new WeakSet(),
    armedAt: 0,
    ac: null,
    seenTweetKeys: new Map(),
    selectionTimer: null,
    selectionSeq: 0,
    remoteSearchSeq: 0,
    selectionPointerDown: false,
    pendingSelection: null,
    lastSelectionSearch: { query: '', at: 0 },
    BODY_SELECTOR: 'div.cursor-text.select-text',
    MAX_SEEN: 800,
    OLD_TWEET_SECONDS: 12,
    // 用户在 GMGN 给博主设置的自定义备注：小写 @handle → 备注文本。
    // 备注只存在于页面 DOM（内联橙色），WS 帧里拿不到，需从卡片头部抓取缓存。
    remarkMap: new Map(),
    REMARK_STORAGE_KEY: 'dsmTwitterRemarksV1',
    REMARK_ITEM_PREFIX: 'dsmTwitterRemarkV2:',
    // 小写昵称 → 小写 handle：WS 帧里的 id/tw 都对不上时的第三路反查。
    nickToHandleMap: new Map(),
    NICK_MAP_MAX: 500,
    remarksLoaded: false,
    lastRemarkSignature: '',
    REMARK_WAIT_MS: 1200,
    REMARK_POLL_MS: 160
  };

  function cleanText(value) {
    return String(value || '').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  }


  function sanitizeSpokenAuthor(value) {
    let text = cleanText(value).normalize('NFKC');

    // v2.3.1 strict author-name mode: drop entire emoji grapheme clusters first
    // (including flags, ZWJ families and keycaps), then allow only Unicode
    // letters/numbers/spaces. This prevents TTS engines from verbalising emoji
    // names such as "火箭", "红心", "中国国旗", etc.
    try {
      const emojiCluster = /(?:[0-9#*]\uFE0F?\u20E3|[\p{Regional_Indicator}]{2}|\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)*)/gu;
      text = text.replace(emojiCluster, ' ');
      text = text.replace(/[^\p{L}\p{N}\s]/gu, ' ');
    } catch (error) {
      text = text
        .replace(/[0-9#*]\uFE0F?\u20E3/g, ' ')
        .replace(/[\u2600-\u27BF]/g, ' ')
        .replace(/[\uD83C-\uDBFF][\uDC00-\uDFFF]/g, ' ')
        .replace(/[^A-Za-z0-9\u3400-\u9FFF\s]/g, ' ');
    }
    return text.replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  function hashText(value) {
    // Small deterministic FNV-1a hash — enough for de-duping transient UI rows.
    let h = 0x811c9dc5;
    const text = String(value || '');
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  function pruneSeenTweets() {
    if (social.seenTweetKeys.size <= social.MAX_SEEN) return;
    const removeCount = social.seenTweetKeys.size - Math.floor(social.MAX_SEEN * 0.75);
    let removed = 0;
    for (const key of social.seenTweetKeys.keys()) {
      social.seenTweetKeys.delete(key);
      removed += 1;
      if (removed >= removeCount) break;
    }
  }

  function profileHandleAnchors(scope) {
    if (!scope?.querySelectorAll) return [];
    return Array.from(scope.querySelectorAll('a[href^="https://x.com/"], a[href^="http://x.com/"]')).filter((anchor) => {
      const href = String(anchor.getAttribute('href') || '');
      const text = cleanText(anchor.textContent);
      if (!text.startsWith('@')) return false;
      if (/\/status\//i.test(href)) return false;
      try {
        const url = new URL(href, location.href);
        const parts = url.pathname.split('/').filter(Boolean);
        return parts.length === 1;
      } catch (error) {
        return true;
      }
    });
  }

  function authorCandidates(scope) {
    if (!scope?.querySelectorAll) return [];
    return Array.from(scope.querySelectorAll('span.text-text-100')).filter((span) => {
      if (!span.classList.contains('leading-[20px]')) return false;
      if (span.closest(social.BODY_SELECTOR)) return false;
      const text = sanitizeSpokenAuthor(span.textContent);
      return !!text && text.length <= 80 && !/^\d+(?:\.\d+)?[smhd]$/i.test(text);
    });
  }

  function findAuthorNearHandle(handle, card) {
    if (!handle || !card) return '';
    let node = handle.parentElement;
    for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
      if (!card.contains(node)) break;
      const hasEdit = !!node.querySelector?.('svg[data-icon="IconEdit16pxRegular"]');
      if (!hasEdit) continue;
      const candidates = authorCandidates(node);
      if (candidates.length === 1) return sanitizeSpokenAuthor(candidates[0].textContent);
    }
    return '';
  }

  // GMGN 只把用户自定义备注渲染成内联橙色 rgb(248,185,81)；普通昵称没有这个
  // 颜色，编辑图标则无论有无备注都在。颜色是区分备注与昵称的唯一可靠信号。
  function isRemarkOrange(span) {
    if (!span) return false;
    if (/248\s*,\s*185\s*,\s*81/.test(String(span.style?.color || ''))) return true;
    try {
      const match = String(getComputedStyle(span).color || '').match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
      return !!match && Math.abs(Number(match[1]) - 248) <= 12
        && Math.abs(Number(match[2]) - 185) <= 12
        && Math.abs(Number(match[3]) - 81) <= 12;
    } catch (error) {
      return false;
    }
  }

  function remarkItemStorageKey(handleLower) {
    return `${social.REMARK_ITEM_PREFIX}${handleLower}`;
  }

  function rememberRemark(handleLower, remark) {
    const text = cleanText(remark).slice(0, 80);
    if (!handleLower || !text) return;
    if (social.remarkMap.get(handleLower) === text) return;
    // 先 delete 再 set，让最近捕获的备注保持在 Map 尾部，便于诊断时查看。
    social.remarkMap.delete(handleLower);
    social.remarkMap.set(handleLower, text);
    // 每个 handle 独立存储，多个 GMGN 标签页更新不同备注时不会整表互相覆盖。
    try {
      chrome.storage.local.set({ [remarkItemStorageKey(handleLower)]: text }).catch(() => {});
    } catch (error) {}
  }

  function rememberNickPair(nickText, handleLower) {
    const nick = cleanText(nickText).toLowerCase();
    if (!nick || !handleLower || nick.startsWith('@')) return;
    if (social.nickToHandleMap.get(nick) === handleLower) return;
    if (social.nickToHandleMap.size >= social.NICK_MAP_MAX) {
      const drop = social.nickToHandleMap.size - Math.floor(social.NICK_MAP_MAX * 0.75);
      let removed = 0;
      for (const key of social.nickToHandleMap.keys()) {
        social.nickToHandleMap.delete(key);
        removed += 1;
        if (removed >= drop) break;
      }
    }
    social.nickToHandleMap.set(nick, handleLower);
  }

  // 备注是 GMGN 的内联橙色样式，颜色本身是唯一可靠信号：不再要求特定类名，
  // 避免备注 span 与普通昵称类名不一致时永远抓不到。跳过推文正文里的高亮词。
  function findOrangeRemarkSpan(scope) {
    for (const span of scope.querySelectorAll('span')) {
      if (span.closest(social.BODY_SELECTOR)) continue;
      const text = cleanText(span.textContent);
      if (!text || text.length > 80) continue;
      if (isRemarkOrange(span)) return span;
    }
    return null;
  }

  function captureTwitterRemark(handleAnchor, scope) {
    if (!handleAnchor || !scope?.contains?.(handleAnchor)) return;
    let handleLower = '';
    try {
      const url = new URL(String(handleAnchor.getAttribute('href') || ''), location.href);
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length === 1) handleLower = parts[0].toLowerCase();
    } catch (error) {
      return;
    }
    if (!handleLower) return;

    let node = handleAnchor.parentElement;
    for (let depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
      if (!scope.contains(node)) break;
      const handles = profileHandleAnchors(node);
      if (handles.length > 1) break; // 越过卡片进入列表容器，避免误配他人

      // 命中橙色即写入缓存；从最内层向外找，优先取离 handle 最近的那个。
      const orange = findOrangeRemarkSpan(node);
      if (orange) {
        rememberRemark(handleLower, orange.textContent);
        return;
      }

      // 未命中橙色只能说明当前卡片显示了昵称，不能证明用户删除了备注。
      // GMGN 的不同卡片布局和 React 过渡帧经常不渲染橙色备注，因此绝不据此删缓存。
      if (!node.querySelector?.('svg[data-icon="IconEdit16pxRegular"]')) continue;
      const candidates = authorCandidates(node);
      if (candidates.length !== 1 || handles.length !== 1 || handles[0] !== handleAnchor) continue;
      rememberNickPair(candidates[0].textContent, handleLower);
      return;
    }
  }

  function loadTwitterRemarks() {
    if (social.remarksLoaded) return;
    social.remarksLoaded = true;
    try {
      chrome.storage.local.get(null).then((data) => {
        const stored = data?.[social.REMARK_STORAGE_KEY];
        if (stored && typeof stored === 'object') {
          for (const [handle, remark] of Object.entries(stored)) {
            if (typeof remark === 'string' && cleanText(remark)) {
              social.remarkMap.set(String(handle).toLowerCase(), cleanText(remark));
            }
          }
        }
        // V2 单条记录优先于旧版整表，读取时顺便兼容已有用户数据。
        for (const [key, remark] of Object.entries(data || {})) {
          if (!key.startsWith(social.REMARK_ITEM_PREFIX) || typeof remark !== 'string') continue;
          const handle = key.slice(social.REMARK_ITEM_PREFIX.length).toLowerCase();
          const text = cleanText(remark);
          if (handle && text) social.remarkMap.set(handle, text);
        }
      }).catch(() => {});
    } catch (error) {}
  }

  // React 卡片晚于 DOMContentLoaded 挂载，且橙色备注常在首帧后才经属性变更刷入
  // （childList observer 感知不到）。低频全量扫描兜底，保证缓存始终新鲜。
  function sweepRemarks() {
    if (!document.body) return;
    for (const anchor of profileHandleAnchors(document)) captureTwitterRemark(anchor, document.body);
    const signature = JSON.stringify(Array.from(social.remarkMap.entries()).sort(([a], [b]) => (a < b ? -1 : 1)));
    if (signature !== social.lastRemarkSignature) {
      social.lastRemarkSignature = signature;
      console.debug('[DSM remark] 缓存更新:', Object.fromEntries(social.remarkMap));
    }
  }

  // 控制台诊断：默认控制台上下文是页面主世界，需切到本扩展上下文后调用。
  try {
    window.__dsmRemarks = () => ({
      remarks: Object.fromEntries(social.remarkMap),
      nickPairs: Object.fromEntries(social.nickToHandleMap)
    });
  } catch (error) {}

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    // 兼容旧版整表写入，但只合并，绝不让其他标签页的不完整快照清空本页缓存。
    const legacy = changes[social.REMARK_STORAGE_KEY]?.newValue;
    if (legacy && typeof legacy === 'object') {
      for (const [handle, remark] of Object.entries(legacy)) {
        const text = typeof remark === 'string' ? cleanText(remark) : '';
        if (text) social.remarkMap.set(String(handle).toLowerCase(), text);
      }
    }
    for (const [key, change] of Object.entries(changes)) {
      if (!key.startsWith(social.REMARK_ITEM_PREFIX)) continue;
      const handle = key.slice(social.REMARK_ITEM_PREFIX.length).toLowerCase();
      const text = typeof change.newValue === 'string' ? cleanText(change.newValue) : '';
      if (handle && text) {
        social.remarkMap.set(handle, text);
      } else if (handle && change.newValue === undefined) {
        // 只有明确删除对应 V2 存储项时才删除，普通昵称渲染不再触发删除。
        social.remarkMap.delete(handle);
      }
    }
  });

  function findAuthorInTweetCard(card) {
    if (!card?.querySelectorAll) return '';

    // Strongest binding: GMGN's author @handle and display name must both live
    // inside this one tweet card. This handles both current header layouts:
    // handle on the same row (Arbital) and handle on the second row (DEGEN NEWS).
    const handles = profileHandleAnchors(card);
    if (handles.length === 1) {
      const nearby = findAuthorNearHandle(handles[0], card);
      if (nearby) return nearby;
    }

    // Some compact monitor rows omit @handle. Only accept the fallback if this
    // card has exactly one edit icon AND one display-name candidate. Ambiguous
    // cards are intentionally silent rather than announcing the wrong person.
    const edits = card.querySelectorAll('svg[data-icon="IconEdit16pxRegular"]');
    const candidates = authorCandidates(card);
    if (edits.length === 1 && candidates.length === 1) {
      return sanitizeSpokenAuthor(candidates[0].textContent);
    }
    return '';
  }

  function findTweetAgeSeconds(scope) {
    if (!scope || !scope.querySelectorAll) return null;
    let best = null;
    for (const span of scope.querySelectorAll('span')) {
      if (span.closest?.(social.BODY_SELECTOR)) continue;
      const text = cleanText(span.textContent);
      const match = text.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d|秒|分钟|小时|天)$/i);
      if (!match) continue;
      const value = Number(match[1]);
      const unit = match[2].toLowerCase();
      let seconds = value;
      if (unit === 'm' || unit === '分钟') seconds *= 60;
      else if (unit === 'h' || unit === '小时') seconds *= 3600;
      else if (unit === 'd' || unit === '天') seconds *= 86400;
      if (best === null || seconds < best) best = seconds;
    }
    return best;
  }

  function getTweetContext(body) {
    if (!body) return null;
    const fallbackCards = [];
    let node = body.parentElement;
    for (let depth = 0; node && depth < 14; depth += 1, node = node.parentElement) {
      if (!node.querySelectorAll) continue;
      const bodies = node.querySelectorAll(social.BODY_SELECTOR);
      if (bodies.length > 1) break; // crossed into the feed/list container
      if (bodies.length !== 1 || bodies[0] !== body) continue;

      const handles = profileHandleAnchors(node);
      const edits = node.querySelectorAll('svg[data-icon="IconEdit16pxRegular"]');
      if (handles.length > 1 || edits.length > 1) break;

      // Preferred path: bind the body to exactly one @handle and resolve the
      // display name from the same compact header. This covers both GMGN layouts
      // supplied by the user (Arbital same-row handle and DEGEN NEWS second-row handle).
      if (handles.length === 1) {
        captureTwitterRemark(handles[0], node);
        const author = findAuthorNearHandle(handles[0], node);
        if (author) return { card: node, author, ageSeconds: findTweetAgeSeconds(node) };
      }

      // Keep an edit-icon-only card as a last-resort candidate, but do not use it
      // until we have finished looking for a real @handle. This trades one missed
      // announcement for never announcing the neighbouring blogger by mistake.
      if (handles.length === 0 && edits.length === 1) fallbackCards.push(node);
    }

    for (const card of fallbackCards) {
      const author = findAuthorInTweetCard(card);
      if (author) return { card, author, ageSeconds: findTweetAgeSeconds(card) };
    }
    return null;
  }

  function getTweetKey(body, context) {
    const statusAnchor = context.card.querySelector && context.card.querySelector('a[href*="/status/"]');
    const href = statusAnchor && statusAnchor.getAttribute('href');
    const statusMatch = String(href || '').match(/\/status\/(\d+)/i);
    if (statusMatch) return `status:${statusMatch[1]}`;

    const bodyText = cleanText(body.innerText || body.textContent).slice(0, 500);
    return `tweet:${hashText(`${context.author}\n${bodyText}`)}`;
  }

  function normalizeHandleKey(value) {
    return String(value || '').trim().toLowerCase().replace(/^@+/, '');
  }

  // WS 帧里 id/tw 字段的实际内容不受我们控制（可能是 handle 也可能是数字 ID），
  // 匹配备注时把所有候选 key 都试一遍，再用昵称反查表兜底。
  function remarkCandidateKeys(trigger) {
    const keys = [];
    for (const raw of [trigger?.id, trigger?.tw]) {
      const key = normalizeHandleKey(raw);
      if (key && !keys.includes(key)) keys.push(key);
    }
    const nickKey = cleanText(trigger?.name).toLowerCase();
    const viaNick = nickKey ? social.nickToHandleMap.get(nickKey) : '';
    if (viaNick && !keys.includes(viaNick)) keys.push(viaNick);
    return keys;
  }

  // 命中 GMGN 备注返回可播报名；空串表示未命中。
  function resolveSpokenName(trigger) {
    for (const key of remarkCandidateKeys(trigger)) {
      const hit = sanitizeSpokenAuthor(social.remarkMap.get(key));
      if (hit) return hit;
    }
    return '';
  }

  function buildTwitterAnnouncement(triggers) {
    const counts = new Map();
    for (const trigger of Array.isArray(triggers) ? triggers : []) {
      let spokenName = resolveSpokenName(trigger);
      if (spokenName) {
        console.debug('[DSM speak] 备注命中 →', spokenName, '| key:', remarkCandidateKeys(trigger).join(','));
      } else {
        spokenName = sanitizeSpokenAuthor(trigger?.name || trigger?.id);
        if (spokenName) console.debug('[DSM speak] 无备注，回退昵称 →', spokenName, '| key:', remarkCandidateKeys(trigger).join(','));
      }
      if (!spokenName) continue;
      counts.set(spokenName, (counts.get(spokenName) || 0) + 1);
    }
    const labels = Array.from(counts.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, count]) => count > 1 ? `${name}${count}条` : name);
    if (!labels.length) return '';
    return labels.length > 3 ? `${labels.join('、')}一起发推啦` : `${labels.join('、')} 发推啦`;
  }

  function sendSpeakMessage(text, tweetKey) {
    try {
      chrome.runtime.sendMessage({
        type: 'DSM_SPEAK_TWITTER_AUTHOR',
        text,
        key: tweetKey,
        volume: Math.min(1, Math.max(0, Number(settings.twitterVoiceVolume) / 100 || 0)),
        voiceName: String(settings.twitterVoiceName || 'zh-CN-XiaoxiaoNeural'),
        rate: Math.min(200, Math.max(50, Number(settings.twitterVoiceRate) || 115)),
        enqueue: true
      }).catch(() => {});
    } catch (error) {
      // AI TTS failure must never block or alter GMGN page behavior.
    }
  }

  function speakTwitterAnnouncement(triggers, tweetKey) {
    if (!settings.twitterVoiceEnabled) return;
    // 新推文卡片头部常比 WS 帧晚渲染，而备注只存在于页面 DOM：立即播必然
    // 错过刚发推博主的备注。先短暂轮询补抓，全部命中立刻播，最多等 ~1.2s。
    const list = Array.isArray(triggers) ? triggers : [];
    const deadline = Date.now() + social.REMARK_WAIT_MS;
    const unresolved = () => list.some((trigger) => !resolveSpokenName(trigger));
    const attempt = () => {
      if (!social.started || !settings.twitterVoiceEnabled || !isMasterOn()) return;
      if (unresolved() && Date.now() < deadline) {
        sweepRemarks();
        if (unresolved()) {
          setTimeout(attempt, social.REMARK_POLL_MS);
          return;
        }
      }
      const text = buildTwitterAnnouncement(list);
      if (text) sendSpeakMessage(text, tweetKey);
    };
    attempt();
  }

  function handleTwitterWsMessage(event) {
    if (!social.started || !settings.twitterVoiceEnabled || !isMasterOn()) return;
    const detail = event?.detail || {};
    const triggers = Array.isArray(detail.triggers) ? detail.triggers : [];
    if (!triggers.length) return;
    const key = String(detail.eventId || `twitter:${hashText(JSON.stringify(triggers))}`);
    if (social.seenTweetKeys.has(key)) return;
    social.seenTweetKeys.set(key, Date.now());
    pruneSeenTweets();
    speakTwitterAnnouncement(triggers, key);
  }

  function inspectTweetBody(body, allowSpeech = true) {
    if (!body || !body.isConnected) return;
    const context = getTweetContext(body);
    if (!context) return;

    const key = getTweetKey(body, context);
    if (social.seenTweetKeys.has(key)) return;
    social.seenTweetKeys.set(key, Date.now());
    pruneSeenTweets();

    if (!allowSpeech || !settings.twitterVoiceEnabled) return;

    // Prevent page refresh from reading the entire historical feed aloud. New
    // monitor entries normally have an age of only a few seconds. Older rows
    // discovered by lazy rendering/scrolling are seeded silently.
    if (context.ageSeconds !== null && context.ageSeconds > social.OLD_TWEET_SECONDS) return;
    if (Date.now() < social.armedAt && (context.ageSeconds === null || context.ageSeconds > 3)) return;

    // Voice announcements use the GMGN WebSocket path. DOM card parsing remains
    // available only for tweet-bound selection/search behavior.
  }


  function retryTweetBody(body) {
    if (!body || !body.isConnected || social.retryPending.has(body)) return;
    social.retryPending.add(body);
    // React can mount the body before author/header. Three targeted retries cost
    // far less than a document-wide fallback scan and keep speech latency low.
    const delays = [24, 100, 320];
    delays.forEach((delay, index) => {
      setTimeout(() => {
        if (body.isConnected) inspectTweetBody(body, true);
        if (index === delays.length - 1) social.retryPending.delete(body);
      }, delay);
    });
  }

  function scanTwitterBodies(allowSpeech = true) {
    if (!social.started || !settings.twitterVoiceEnabled) return 0;
    const bodies = document.querySelectorAll(social.BODY_SELECTOR);
    for (const body of bodies) inspectTweetBody(body, allowSpeech);
    return bodies.length;
  }

  function startTwitterObserver() {
    if (!settings.twitterVoiceEnabled || social.observer || !document.documentElement) return;
    social.observer = new MutationObserver((mutations) => {
      const bodiesToInspect = new Set();
      for (const mutation of mutations) {
        if (mutation.type !== 'childList') continue;
        const target = mutation.target?.nodeType === 1 ? mutation.target : mutation.target?.parentElement;
        const ownerBody = target?.closest?.(social.BODY_SELECTOR);
        if (ownerBody) bodiesToInspect.add(ownerBody);

        for (const node of mutation.addedNodes || []) {
          if (!node || node.nodeType !== 1) continue;
          if (node.matches?.(social.BODY_SELECTOR)) {
            bodiesToInspect.add(node);
            continue;
          }
          // Most GMGN mutations are unrelated to Twitter cards. querySelector()
          // is a cheap existence gate; only enumerate all bodies for the rare
          // subtree that actually contains monitor text.
          const firstBody = node.querySelector?.(social.BODY_SELECTOR);
          if (firstBody) {
            bodiesToInspect.add(firstBody);
            const bodies = node.querySelectorAll?.(social.BODY_SELECTOR);
            if (bodies?.length > 1) for (const body of bodies) bodiesToInspect.add(body);
          }
        }
      }

      for (const body of bodiesToInspect) {
        inspectTweetBody(body, true);
        retryTweetBody(body);
      }
    });

    // Do NOT observe characterData document-wide: GMGN updates prices, ages and
    // counters constantly, which caused needless observer wakeups. New tweet DOM
    // arrives through childList; the 2.5s safety scan still covers rare node reuse.
    social.observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }

  function isVisibleElement(element) {
    if (!element || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 20 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0;
  }

  function findVisibleGmgnGlobalSearchLauncher() {
    // GMGN's top navigation search has a stable component marker. Do not fall
    // back to `new-search-input`: the scan-chain page uses that name too and
    // would receive the selected text instead of the global token search.
    const exactSelectors = [
      '[data-sentry-component="Search"] input.pi-input[placeholder*="搜索代币名"][placeholder*="合约"][placeholder*="钱包"]',
      '[data-sentry-component="Search"] input.pi-input[placeholder*="Search name"]',
      'input.pi-input[placeholder*="搜索代币名"]',
      'input.pi-input[placeholder*="Search name"]'
    ];
    for (const selector of exactSelectors) {
      const input = Array.from(document.querySelectorAll(selector)).find((candidate) => {
        if (!isVisibleElement(candidate)) return false;
        const rect = candidate.getBoundingClientRect();
        return rect.top >= 0 && rect.top < Math.min(180, window.innerHeight * 0.25);
      });
      if (input) return input;
    }
    return null;
  }

  function dispatchMouseLike(element, type) {
    try {
      element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 }));
    } catch (error) {
      // ignore
    }
  }

  function activateGmgnSearchInput(input) {
    const wrapper = input.closest('.pi-input-inside-wrap') || input.closest('.pi-input-wrap') || input.parentElement;
    if (wrapper) dispatchMouseLike(wrapper, 'mousedown');
    dispatchMouseLike(input, 'mousedown');
    try { input.focus({ preventScroll: true }); } catch (error) { input.focus(); }
    try { input.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); } catch (error) { /* ignore */ }
    dispatchMouseLike(input, 'mouseup');
    dispatchMouseLike(input, 'click');
  }

  function setReactInputValue(input, value) {
    // Use the native prototype setter so React's value tracker sees a genuine
    // change instead of treating it as the controlled input writing to itself.
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    const oldValue = input.value;
    if (descriptor && descriptor.set) descriptor.set.call(input, value);
    else input.value = value;

    // Older React trackers may suppress an input event when their cached value
    // equals the DOM value. Put the tracker back on the previous value first.
    try {
      if (input._valueTracker && typeof input._valueTracker.setValue === 'function') {
        input._valueTracker.setValue(oldValue);
      }
    } catch (error) {
      // ignore
    }

    try {
      input.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: value
      }));
    } catch (error) {
      // ignore
    }
    try {
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    } catch (error) {
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: value.slice(-1) || 'a', code: 'KeyA', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: value.slice(-1) || 'a', code: 'KeyA', bubbles: true }));
  }

  function fillGmgnSearch(query, attempt = 0, seq = ++social.remoteSearchSeq) {
    // This function runs on the selected GMGN target tab. It intentionally does
    // not depend on social.started because the target may be another window.
    if (!query || seq !== social.remoteSearchSeq) return false;
    const input = findVisibleGmgnGlobalSearchLauncher();
    if (input) {
      activateGmgnSearchInput(input);
      setReactInputValue(input, query);

      // GMGN can rebuild the controlled header input after focus opens the
      // dropdown. Resolve the current input again instead of holding a stale
      // node, then re-assert the value.
      for (const delay of [60, 160, 320, 650]) {
        setTimeout(() => {
          if (seq !== social.remoteSearchSeq) return;
          const current = findVisibleGmgnGlobalSearchLauncher();
          if (!current) return;
          activateGmgnSearchInput(current);
          if (cleanText(current.value) !== query) setReactInputValue(current, query);
          else current.dispatchEvent(new Event('input', { bubbles: true }));
        }, delay);
      }
      return true;
    }

    // SPA/header hydration fallback for about 1.6s.
    if (attempt < 20) {
      setTimeout(() => fillGmgnSearch(query, attempt + 1, seq), 80);
    }
    return false;
  }

  function showSelectionRouteToast(text, ok = true) {
    let toast = document.getElementById('dsm-selection-route-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'dsm-selection-route-toast';
      Object.assign(toast.style, {
        position: 'fixed',
        zIndex: '2147483647',
        left: '50%',
        top: '12px',
        transform: 'translateX(-50%)',
        maxWidth: '88vw',
        padding: '7px 11px',
        borderRadius: '7px',
        fontSize: '12px',
        lineHeight: '16px',
        fontFamily: 'system-ui, sans-serif',
        color: '#fff',
        boxShadow: '0 4px 18px rgba(0,0,0,.28)',
        pointerEvents: 'none',
        transition: 'opacity .18s ease',
        opacity: '0'
      });
      document.documentElement.appendChild(toast);
    }
    toast.textContent = text;
    toast.style.background = ok ? 'rgba(35, 126, 74, .94)' : 'rgba(185, 52, 52, .94)';
    toast.style.opacity = '1';
    clearTimeout(showSelectionRouteToast.timer);
    showSelectionRouteToast.timer = setTimeout(() => {
      if (toast) toast.style.opacity = '0';
    }, 1300);
  }

  function handleSearchRouteResponse(response, query) {
    if (response && response.ok) {
      showSelectionRouteToast(`顶部代币搜索：${query}`, true);
    } else {
      showSelectionRouteToast('未找到 GMGN 顶部代币搜索框', false);
    }
  }

  function sendSelectionToScanPage(query) {
    if (!query) return;
    try {
      const maybePromise = chrome.runtime.sendMessage({
        type: 'DSM_CROSS_TAB_GMGN_SEARCH',
        query
      });
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then((response) => handleSearchRouteResponse(response, query)).catch(() => {
          showSelectionRouteToast('顶部代币搜索路由失败，请刷新插件', false);
        });
      }
    } catch (error) {
      // Background service worker may be restarting; retry once.
      setTimeout(() => {
        try {
          const retry = chrome.runtime.sendMessage({ type: 'DSM_CROSS_TAB_GMGN_SEARCH', query });
          if (retry && typeof retry.then === 'function') {
            retry.then((response) => handleSearchRouteResponse(response, query)).catch(() => {});
          }
        } catch (retryError) { /* ignore */ }
      }, 120);
    }
  }

  function findTweetCardForNode(element) {
    if (!element) return null;
    let fallback = null;
    let node = element.parentElement;
    for (let depth = 0; node && depth < 14; depth += 1, node = node.parentElement) {
      if (!node.querySelectorAll) continue;
      const bodies = node.querySelectorAll(social.BODY_SELECTOR);
      if (bodies.length > 1) break;
      if (bodies.length !== 1) continue;
      const handles = profileHandleAnchors(node);
      const edits = node.querySelectorAll('svg[data-icon="IconEdit16pxRegular"]');
      if (handles.length > 1 || edits.length > 1) break;
      if (handles.length === 1 && findAuthorNearHandle(handles[0], node)) return node;
      if (!fallback && handles.length === 0 && edits.length === 1 && authorCandidates(node).length === 1) fallback = node;
    }
    return fallback;
  }

  function highlightedKeywordFromEvent(event) {
    if (!settings.selectionSearchEnabled || !isMasterOn()) return null;
    if (typeof event.button === 'number' && event.button !== 0) return null;
    const target = nodeElement(event.target);
    const keyword = target?.closest?.('[data-keyword][data-keyword-type="cooking-ai"]');
    if (!keyword) return null;

    // IMPORTANT: do not gate suppression on tweet-card/author detection. GMGN may
    // render an original body + translated body in the same card, which can make
    // card-boundary heuristics intentionally return null. The data-keyword-type
    // attribute itself is GMGN's explicit cooking/launch affordance, so it is the
    // most stable and cheapest signal for click interception. Author/card logic is
    // kept completely separate and is used only for voice announcements.
    const query = normalizeSelectedSearchText(keyword.getAttribute('data-keyword') || keyword.textContent);
    return query ? { keyword, query } : null;
  }

  function suppressGmgnKeywordAction(event) {
    const hit = highlightedKeywordFromEvent(event);
    if (!hit) return null;
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
    return hit;
  }

  function routeHighlightedKeyword(event) {
    const hit = suppressGmgnKeywordAction(event);
    if (!hit) return;
    const { query } = hit;
    const now = Date.now();
    // Pointerup + mouseup + click can all fire for one physical click. Keep the
    // first route only, while every phase remains blocked from GMGN's launcher.
    if (social.lastSelectionSearch.query === query && now - social.lastSelectionSearch.at < 900) return;
    social.lastSelectionSearch = { query, at: now };
    social.pendingSelection = null;
    sendSelectionToScanPage(query);
  }

  function handleHighlightedKeywordGuard(event) {
    suppressGmgnKeywordAction(event);
  }

  let earlyKeywordInterceptorsInstalled = false;
  function installEarlyKeywordInterceptors() {
    if (earlyKeywordInterceptorsInstalled) return;
    earlyKeywordInterceptorsInstalled = true;
    // Installed synchronously by the document_start content script. Window
    // capture runs before React's document/root delegation. Keeping these
    // listeners permanent is intentional: they are tiny no-ops when disabled
    // and avoids a race where GMGN registers its launch handler before settings
    // finish loading from chrome.storage.
    window.addEventListener('pointerdown', handleHighlightedKeywordGuard, true);
    window.addEventListener('mousedown', handleHighlightedKeywordGuard, true);
    window.addEventListener('pointerup', routeHighlightedKeyword, true);
    window.addEventListener('mouseup', routeHighlightedKeyword, true);
    window.addEventListener('click', handleHighlightedKeywordGuard, true);
  }

  function normalizeSelectedSearchText(value) {
    let text = cleanText(value);
    text = text.replace(/^[\s$#@“”‘’'"`《》【】()（）\[\]{}]+|[\s,，。.!！?？;；:：“”‘’'"`《》【】()（）\[\]{}]+$/g, '');
    if (!text || text.length > 80) return '';
    return text;
  }

  function nodeElement(node) {
    if (!node) return null;
    return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  }

  function isInsideTweetBody(node) {
    const element = nodeElement(node);
    if (!element) return false;
    if (element.closest?.(social.BODY_SELECTOR)) return true;
    // GMGN translated text does not always carry cursor-text/select-text. Allow
    // selection inside its font-mono text only when it belongs to a real tweet card.
    const translatedText = element.closest?.('span.font-mono');
    return !!translatedText && !!findTweetCardForNode(translatedText);
  }

  function readTweetSelection(eventTarget = null) {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    const common = nodeElement(range.commonAncestorContainer);
    const anchor = nodeElement(selection.anchorNode);
    const focus = nodeElement(selection.focusNode);
    const target = nodeElement(eventTarget);
    const inside = !!(
      isInsideTweetBody(common) ||
      (isInsideTweetBody(anchor) && isInsideTweetBody(focus)) ||
      isInsideTweetBody(target)
    );
    if (!inside) return null;
    const query = normalizeSelectedSearchText(selection.toString());
    if (!query) return null;
    return { query, at: Date.now() };
  }

  function triggerSelectionSearch(captured) {
    if (!captured || !social.started || !settings.selectionSearchEnabled) return;
    const now = Date.now();
    if (social.lastSelectionSearch.query === captured.query && now - social.lastSelectionSearch.at < 700) return;
    social.lastSelectionSearch = { query: captured.query, at: now };
    social.pendingSelection = null;
    sendSelectionToScanPage(captured.query);
  }

  function captureAndTriggerSelection(event) {
    // Critical: capture the Selection synchronously, before GMGN's own mouseup
    // handler has a chance to collapse it. v2.1.0 read it in setTimeout(0), which
    // is why selection search could appear completely dead on current GMGN.
    const captured = readTweetSelection(event && event.target);
    if (!captured) return;
    social.pendingSelection = captured;
    queueMicrotask(() => triggerSelectionSearch(captured));
  }

  function handleSelectionChange() {
    if (!social.started || !settings.selectionSearchEnabled) return;
    const captured = readTweetSelection();
    if (!captured) return;
    social.pendingSelection = captured;
    clearTimeout(social.selectionTimer);
    // Keyboard selection / unusual pointer stacks may never surface a normal
    // mouseup to our listener. Only auto-fire after the pointer is no longer down.
    social.selectionTimer = setTimeout(() => {
      if (!social.selectionPointerDown && social.pendingSelection) {
        triggerSelectionSearch(social.pendingSelection);
      }
    }, 220);
  }

  function startSocialModule() {
    if (social.started || (!settings.twitterVoiceEnabled && !settings.selectionSearchEnabled)) return;
    social.started = true;
    social.armedAt = Date.now() + 1200;
    social.ac = new AbortController();

    loadTwitterRemarks();

    if (settings.twitterVoiceEnabled) {
      sweepRemarks();
      if (social.scanTimer === null) {
        social.scanTimer = setInterval(() => {
          if (document.visibilityState !== 'visible') return;
          sweepRemarks();
        }, 5000);
      }
      window.addEventListener('DSM_TWITTER_WS_MSG_RECEIVED', handleTwitterWsMessage, { signal: social.ac.signal });
    }

    if (settings.selectionSearchEnabled) {
      // cooking-ai interception is installed once at document_start (see bottom)
      // so it precedes GMGN/React listeners. The social module only owns text
      // selection listeners, which can be cleanly restarted with this AbortSignal.
      document.addEventListener('pointerdown', (event) => {
        social.selectionPointerDown = isInsideTweetBody(event.target);
        if (social.selectionPointerDown) social.pendingSelection = null;
      }, { capture: true, signal: social.ac.signal });

      document.addEventListener('pointerup', (event) => {
        captureAndTriggerSelection(event);
        social.selectionPointerDown = false;
      }, { capture: true, signal: social.ac.signal });

      // Mouse events remain as a fallback for browsers/devices where PointerEvent
      // is intercepted by GMGN's drag/select layer. Duplicate calls are de-duped.
      document.addEventListener('mouseup', captureAndTriggerSelection, { capture: true, signal: social.ac.signal });
      document.addEventListener('dblclick', captureAndTriggerSelection, { capture: true, signal: social.ac.signal });
      document.addEventListener('selectionchange', handleSelectionChange, { signal: social.ac.signal });
    }
  }

  function stopSocialModule() {
    if (!social.started) return;
    social.started = false;
    if (social.ac) {
      social.ac.abort();
      social.ac = null;
    }
    if (social.observer) {
      social.observer.disconnect();
      social.observer = null;
    }
    if (social.scanTimer !== null) {
      clearInterval(social.scanTimer);
      social.scanTimer = null;
    }
    social.selectionPointerDown = false;
    social.pendingSelection = null;
    clearTimeout(social.selectionTimer);
    social.selectionTimer = null;
  }

  function restartSocialModule() {
    stopSocialModule();
    if (isMasterOn() && (settings.twitterVoiceEnabled || settings.selectionSearchEnabled)) startSocialModule();
  }

  // Cross-tab search receiver. The background probes every GMGN tab and sends
  // the query only to a tab whose real header search input is currently visible.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return;

    if (message.type === 'DSM_PROBE_GMGN_SEARCH_TARGET') {
      const input = findVisibleGmgnGlobalSearchLauncher();
      sendResponse({
        ok: true,
        hasGlobalSearch: !!input,
        visible: document.visibilityState === 'visible',
        focused: document.hasFocus(),
        href: location.href
      });
      return;
    }

    if (message.type === 'DSM_FILL_GMGN_SEARCH') {
      const query = normalizeSelectedSearchText(message.query);
      if (!query) {
        sendResponse({ ok: false, reason: 'empty-query' });
        return;
      }
      const hadInput = !!findVisibleGmgnGlobalSearchLauncher();
      fillGmgnSearch(query);
      sendResponse({ ok: true, accepted: true, hadInput });
    }
  });

  // ============================================================
  // 模块三：圆形 5 秒决策 + 非阻塞休息提醒
  // ============================================================
  const decision = {
    started: false,
    circle: null,
    circleText: null,
    resizeDot: null,
    restToast: null,
    restBtn: null,
    countdownTimer: null,
    currentUrl: location.href,
    currentTokenKey: null,
    inKlinePage: false,
    decisionRemaining: 0,
    manualConfirmed: false,
    batteryEnd: 0,
    restEnd: 0,
    restShown: false,
    ac: null,
    LS_BATTERY_END: 'dsm_battery_until_v2',
    LS_REST_END: 'dsm_rest_until_v2',
    TOKEN_PATH_RE: /\/(?:token|pump)\/([^/?#]{20,})/i,
    ADDRESS_ONLY_RE: /\/(?:sol|eth|base|bsc|ton|sui|btc|trx|tron)\/((?:0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}))\/?([?#]|$)/i
  };

  function getDecisionSeconds() {
    return clampInt(settings.decisionSeconds, 1, 60, 5);
  }

  function getCircleSize() {
    return clampSize(settings.circleSize);
  }

  function getBatteryMinutes() {
    return clampInt(settings.batteryMinutes, 10, 240, 40);
  }

  function getRestMinutes() {
    return clampInt(settings.restMinutes, 5, 120, 20);
  }

  function getTokenKey(href) {
    try {
      const url = new URL(href);
      const route = (url.pathname + url.hash).split('?')[0] || '';
      const parts = route.split('/').filter(Boolean);
      return (parts[parts.length - 1] || url.href).toLowerCase();
    } catch (error) {
      return String(href).toLowerCase();
    }
  }

  function isKlinePage(href) {
    try {
      const url = new URL(href);
      const route = (url.pathname + url.hash).split('?')[0] || '';
      if (/\/token\//i.test(route) || /\/pump\//i.test(route)) return true;
      const segments = route.split('/').filter(Boolean);
      const last = segments[segments.length - 1] || '';
      if (/^0x[a-fA-F0-9]{40}$/i.test(last)) return true;
      if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(last)) return true;
    } catch (error) {
      // ignore
    }
    return false;
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function formatDuration(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${pad2(m)}:${pad2(s)}`;
  }

  function persistSettings(changed) {
    // v2.0.2: only write the fields that actually changed. Writing the whole
    // dsmSettings object lets a stale GMGN tab overwrite newer values (especially
    // decisionSeconds) when it later persists an unrelated position/size change.
    settings = { ...settings, ...changed };
    const payload = {};
    for (const [field, value] of Object.entries(changed || {})) {
      if (SETTING_FIELDS.includes(field)) payload[settingFieldKey(field)] = value;
    }
    if (Object.keys(payload).length) chrome.storage.local.set(payload).catch(() => {});
  }

  // ---------- 圆形倒计时 UI ----------
  function ensureCircle() {
    if (decision.circle) return;

    decision.circle = document.createElement('div');
    decision.circle.id = 'dsm-decision-circle';
    decision.circle.className = 'dsm-circle-red dsm-circle-hidden';
    decision.circle.innerHTML = `
      <span id="dsm-circle-text">${getDecisionSeconds()}</span>
      <span id="dsm-resize-dot" title="拖动调整大小"></span>
    `;
    (document.documentElement || document.body).appendChild(decision.circle);

    decision.circleText = decision.circle.querySelector('#dsm-circle-text');
    decision.resizeDot = decision.circle.querySelector('#dsm-resize-dot');

    applyCircleSize();
    applyCirclePosition();
    initCircleDrag();
    initCircleResize();
    initCircleInteractions();
  }

  function applyCircleSize() {
    if (!decision.circle) return;
    const size = getCircleSize();
    decision.circle.style.width = `${size}px`;
    decision.circle.style.height = `${size}px`;
    if (decision.circleText) {
      decision.circleText.style.fontSize = `${Math.round(size * 0.28)}px`;
    }
  }

  // 圆球位置持久化：拖到哪就记住哪，刷新页面后保持原位
  function applyCirclePosition() {
    if (!decision.circle) return;
    const pos = settings.circlePosition;
    if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
      const maxLeft = Math.max(0, window.innerWidth - decision.circle.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - decision.circle.offsetHeight);
      decision.circle.style.left = `${Math.min(maxLeft, Math.max(0, Math.round(pos.left)))}px`;
      decision.circle.style.top = `${Math.min(maxTop, Math.max(0, Math.round(pos.top)))}px`;
      decision.circle.style.right = 'auto';
    } else {
      // 无保存位置 → 回落到 CSS 默认（右上角）
      decision.circle.style.left = '';
      decision.circle.style.top = '';
      decision.circle.style.right = '';
    }
  }

  function persistCirclePosition() {
    if (!decision.circle) return;
    const rect = decision.circle.getBoundingClientRect();
    persistSettings({ circlePosition: { left: Math.round(rect.left), top: Math.round(rect.top) } });
  }

  function setCircleState(state) {
    if (!decision.circle) return;
    decision.circle.classList.remove('dsm-circle-red', 'dsm-circle-green');
    decision.circle.classList.add(`dsm-circle-${state}`);
  }

  function showCircle() {
    ensureCircle();
    if (!decision.circle) return;
    if (decision.circle.classList.contains('dsm-circle-hidden')) {
      // 先强制浏览器计算隐藏态样式，再移除隐藏类
      // → 保证入场淡入/缩放过渡必然执行（含圆球首次创建时）
      void decision.circle.offsetWidth;
      decision.circle.classList.remove('dsm-circle-hidden');
    }
  }

  function hideCircle() {
    if (decision.circle) decision.circle.classList.add('dsm-circle-hidden');
  }

  function initCircleInteractions() {
    decision.circle.addEventListener('click', handleCircleClick);
    decision.circle.addEventListener('wheel', handleCircleWheel, { passive: false });
    decision.circle.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      closeDecisionCycle();
    });
    decision.resizeDot.addEventListener('pointerdown', (e) => e.stopPropagation());
    decision.resizeDot.addEventListener('click', (e) => e.stopPropagation());
  }

  function initCircleDrag() {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;
    let circleWidth = 0;
    let circleHeight = 0;

    const onPointerDown = (e) => {
      if (e.target && e.target.id === 'dsm-resize-dot') return;
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      const rect = decision.circle.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      originLeft = rect.left;
      originTop = rect.top;
      circleWidth = rect.width;
      circleHeight = rect.height;
      decision.circle.style.left = `${originLeft}px`;
      decision.circle.style.top = `${originTop}px`;
      decision.circle.style.right = 'auto';
      try {
        decision.circle.setPointerCapture(e.pointerId);
      } catch (error) {
        // ignore
      }
    };

    const onPointerMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const maxLeft = Math.max(0, window.innerWidth - circleWidth);
      const maxTop = Math.max(0, window.innerHeight - circleHeight);
      decision.circle.style.left = `${Math.min(maxLeft, Math.max(0, originLeft + dx))}px`;
      decision.circle.style.top = `${Math.min(maxTop, Math.max(0, originTop + dy))}px`;
      decision.circle.style.right = 'auto';
    };

    const stopDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      try {
        decision.circle.releasePointerCapture(e.pointerId);
      } catch (error) {
        // ignore
      }
      persistCirclePosition();
    };

    decision.circle.addEventListener('pointerdown', onPointerDown);
    decision.circle.addEventListener('pointermove', onPointerMove);
    decision.circle.addEventListener('pointerup', stopDrag);
    decision.circle.addEventListener('pointercancel', stopDrag);
  }

  function initCircleResize() {
    let resizing = false;
    let startX = 0;
    let startY = 0;
    let startSize = 0;

    const onPointerDown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      resizing = true;
      startX = e.clientX;
      startY = e.clientY;
      startSize = decision.circle.offsetWidth;
      try {
        decision.resizeDot.setPointerCapture(e.pointerId);
      } catch (error) {
        // ignore
      }
    };

    const onPointerMove = (e) => {
      if (!resizing) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const next = Math.min(400, Math.max(60, Math.round(startSize + Math.max(dx, dy))));
      settings.circleSize = next;
      applyCircleSize();
    };

    const stopResize = (e) => {
      if (!resizing) return;
      resizing = false;
      try {
        decision.resizeDot.releasePointerCapture(e.pointerId);
      } catch (error) {
        // ignore
      }
      persistSettings({ circleSize: settings.circleSize });
    };

    decision.resizeDot.addEventListener('pointerdown', onPointerDown);
    decision.resizeDot.addEventListener('pointermove', onPointerMove);
    decision.resizeDot.addEventListener('pointerup', stopResize);
    decision.resizeDot.addEventListener('pointercancel', stopResize);
  }

  function handleCircleClick() {
    // 仅 K 线页可交互：防止退出页面后的淡出动画期间误触重启倒计时
    if (!decision.inKlinePage) return;
    if (decision.decisionRemaining > 0 && !decision.manualConfirmed) {
      decision.manualConfirmed = true;
      stopDecisionCycle();
      setCircleState('green');
      decision.circleText.textContent = '✓';
      return;
    }

    if (decision.decisionRemaining <= 0) {
      startDecisionCycle();
    }
  }

  function handleCircleWheel(e) {
    if (!decision.inKlinePage) return;
    e.preventDefault();
    const delta = e.deltaY < 0 ? 1 : -1;
    const next = Math.min(60, Math.max(1, getDecisionSeconds() + delta));
    settings.decisionSeconds = next;
    if (decision.circleText) decision.circleText.textContent = String(next);
    persistSettings({ decisionSeconds: next });
    if (decision.decisionRemaining > 0 && !decision.manualConfirmed) startDecisionCycle();
  }

  // ---------- 圆形决策流程 ----------
  function stopDecisionCycle() {
    if (decision.countdownTimer) {
      clearInterval(decision.countdownTimer);
      decision.countdownTimer = null;
    }
    decision.decisionRemaining = 0;
  }

  function startDecisionCycle() {
    stopDecisionCycle();
    ensureCircle();
    showCircle();

    decision.manualConfirmed = false;

    decision.decisionRemaining = getDecisionSeconds();
    setCircleState('red');
    decision.circleText.textContent = String(decision.decisionRemaining);

    decision.countdownTimer = setInterval(() => {
      if (decision.manualConfirmed) return;
      decision.decisionRemaining -= 1;
      if (decision.decisionRemaining <= 0) {
        stopDecisionCycle();
        finishDecision();
      } else {
        decision.circleText.textContent = String(decision.decisionRemaining);
      }
    }, 1000);
  }

  function finishDecision() {
    // 未在倒计时内点击确认 → 超时标记（红 ✕）；点击圆圈 = 手动确认（绿 ✓）
    setCircleState('red');
    decision.circleText.textContent = '✕';
  }

  function closeDecisionCycle() {
    stopDecisionCycle();
    hideCircle();
  }

  // ---------- 休息提醒（非阻塞） ----------
  function loadRestState() {
    try {
      decision.batteryEnd = Number(localStorage.getItem(decision.LS_BATTERY_END)) || 0;
      decision.restEnd = Number(localStorage.getItem(decision.LS_REST_END)) || 0;

      const nowTime = Date.now();
      if (!decision.batteryEnd) {
        decision.batteryEnd = nowTime + getBatteryMinutes() * 60 * 1000;
        localStorage.setItem(decision.LS_BATTERY_END, String(decision.batteryEnd));
      }
      if (decision.restEnd && decision.restEnd <= nowTime) {
        decision.restEnd = 0;
        localStorage.removeItem(decision.LS_REST_END);
      }
    } catch (error) {
      decision.batteryEnd = Date.now() + getBatteryMinutes() * 60 * 1000;
      decision.restEnd = 0;
    }
  }

  function ensureRestToast() {
    if (decision.restToast) return;
    decision.restToast = document.createElement('div');
    decision.restToast.id = 'dsm-rest-toast';
    decision.restToast.className = 'dsm-hidden';
    decision.restToast.innerHTML = `
      <span class="dsm-rest-icon">🔋</span>
      <div class="dsm-rest-copy">
        <b>盯盘休息提醒</b>
        <small id="dsm-rest-text">建议休息一下，放松眼睛。</small>
      </div>
      <button id="dsm-rest-btn" type="button">已休息</button>
    `;
    (document.documentElement || document.body).appendChild(decision.restToast);

    decision.restBtn = decision.restToast.querySelector('#dsm-rest-btn');
    decision.restBtn.addEventListener('click', resetBattery);
  }

  function showRestToast() {
    ensureRestToast();
    decision.restShown = true;
    decision.restToast.classList.remove('dsm-hidden');
  }

  function hideRestToast() {
    if (decision.restToast) decision.restToast.classList.add('dsm-hidden');
    decision.restShown = false;
  }

  function updateRestTimer() {
    if (!decision.started) return;

    const nowTime = Date.now();
    if (!settings.batteryEnabled) {
      hideRestToast();
      return;
    }

    const batteryRemaining = decision.batteryEnd - nowTime;
    if (batteryRemaining <= 0 && decision.restEnd <= 0) {
      decision.restEnd = nowTime + getRestMinutes() * 60 * 1000;
      try {
        localStorage.setItem(decision.LS_REST_END, String(decision.restEnd));
      } catch (error) {
        // ignore
      }
      showRestToast();
    }

    if (decision.restEnd > 0) {
      const restRemaining = decision.restEnd - nowTime;
      const textEl = decision.restToast ? decision.restToast.querySelector('#dsm-rest-text') : null;
      if (textEl) {
        const text = restRemaining > 0 ? `建议休息 ${formatDuration(restRemaining)}` : '休息时间已到，可继续操作';
        // 文案没变则跳过写入，避免每秒无谓的文本节点替换
        if (textEl.textContent !== text) textEl.textContent = text;
      }
      showRestToast();

      if (restRemaining <= 0) {
        // 非阻塞提醒：休息时间结束后自动重开电池计时
        resetBattery(false);
        hideRestToast();
      }
    }
  }

  function resetBattery(showMessage = true) {
    const nowTime = Date.now();
    decision.batteryEnd = nowTime + getBatteryMinutes() * 60 * 1000;
    decision.restEnd = 0;
    try {
      localStorage.setItem(decision.LS_BATTERY_END, String(decision.batteryEnd));
      localStorage.removeItem(decision.LS_REST_END);
    } catch (error) {
      // ignore
    }
    if (decision.restToast) {
      const textEl = decision.restToast.querySelector('#dsm-rest-text');
      if (textEl) textEl.textContent = showMessage ? '已重置，继续盯盘' : '休息时间到，已自动重置';
    }
    setTimeout(hideRestToast, showMessage ? 1200 : 0);
  }

  // ---------- 路由监听（SPA，极轻量） ----------
  function handleLocationChange() {
    const url = window.location.href;
    decision.currentUrl = url;
    const kline = isKlinePage(url);

    if (kline) {
      const tokenKey = getTokenKey(url);
      if (!decision.inKlinePage || tokenKey !== decision.currentTokenKey) {
        decision.currentTokenKey = tokenKey;
        startDecisionCycle();
      }
      decision.inKlinePage = true;
    } else {
      decision.inKlinePage = false;
      decision.currentTokenKey = null;
      stopDecisionCycle();
      hideCircle();
    }
  }

  function watchUrl() {
    if (!decision.started) return;
    if (window.location.href !== decision.currentUrl) {
      decision.currentUrl = window.location.href;
      handleLocationChange();
    }
  }

  function startDecisionModule() {
    if (decision.started) return;
    decision.started = true;

    // 主页面不创建圆形 DOM，只有进入 K 线页时才创建
    loadRestState();
    patchHistory();

    decision.ac = new AbortController();
    window.addEventListener('popstate', watchUrl, { signal: decision.ac.signal });
    window.addEventListener('hashchange', watchUrl, { signal: decision.ac.signal });

    handleLocationChange();
    updateRestTimer();
  }

  function stopDecisionModule() {
    if (!decision.started) return;
    decision.started = false;

    stopDecisionCycle();
    if (decision.ac) {
      decision.ac.abort();
      decision.ac = null;
    }
    if (decision.circle) {
      decision.circle.remove();
      decision.circle = null;
      decision.circleText = null;
      decision.resizeDot = null;
    }
    hideRestToast();
    if (decision.restToast) {
      decision.restToast.remove();
      decision.restToast = null;
      decision.restBtn = null;
    }
    decision.currentTokenKey = null;
    decision.inKlinePage = false;
    decision.restShown = false;
  }

  // ============================================================
  // 公共 history 监听（只包装一次）
  // ============================================================
  function patchHistory() {
    if (window.__dsmHistoryPatched) return;
    window.__dsmHistoryPatched = true;

    const originalPush = history.pushState;
    const originalReplace = history.replaceState;
    const wrappedPush = function (...args) {
      const result = originalPush.apply(this, args);
      setTimeout(() => {
        watchUrl();
        watchedViewedUrl();
      }, 0);
      return result;
    };
    const wrappedReplace = function (...args) {
      const result = originalReplace.apply(this, args);
      setTimeout(() => {
        watchUrl();
        watchedViewedUrl();
      }, 0);
      return result;
    };

    try {
      history.pushState = wrappedPush;
    } catch (error) {
      // ignore
    }
    try {
      history.replaceState = wrappedReplace;
    } catch (error) {
      // ignore
    }
  }

  // ============================================================
  // 共享轮询 ticker：三个独立轮询合并为单一定时器，每秒 1 次
  // ============================================================
  let tickerId = null;

  function tick() {
    // URL changes are handled by the dedicated route watcher. Keep the 1s ticker
    // only for the user-visible rest countdown; this avoids duplicate URL polling.
    if (decision.started) updateRestTimer();
  }

  function startTicker() {
    if (tickerId !== null) return;
    tickerId = setInterval(tick, 1000);
  }

  function stopTicker() {
    if (tickerId !== null) {
      clearInterval(tickerId);
      tickerId = null;
    }
  }

  // SPA 路由的主路径由 history 包装 / popstate / hashchange 即时处理。
  // 这里仅保留 500ms 低频兜底，替代旧版每秒约 60 次的 rAF URL 比对。
  let routeWatcherId = null;

  function startUrlWatcher() {
    if (routeWatcherId !== null) return;
    routeWatcherId = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      if (viewed.started) watchedViewedUrl();
      if (decision.started) watchUrl();
    }, 500);
  }

  function stopUrlWatcher() {
    if (routeWatcherId !== null) {
      clearInterval(routeWatcherId);
      routeWatcherId = null;
    }
  }

  // 任一模组启用即开低频兜底；常规 SPA 路由仍由 history 事件零延迟处理。
  function refreshTicker() {
    if (decision.started) startTicker();
    else stopTicker();

    if (viewed.started || decision.started) startUrlWatcher();
    else stopUrlWatcher();
  }

  // ============================================================
  // 设置更新与统一开关控制
  // ============================================================
  function applySettingsUpdate(next) {
    const prev = settings;
    settings = next;

    // 总开关变化：按最终开关状态统一启停
    if (prev.dsmEnabled !== next.dsmEnabled) {
      if (!next.dsmEnabled) {
        stopViewed();
        stopSocialModule();
        stopDecisionModule();
      } else {
        if (next.viewedCAEnabled) startViewed();
        if (next.twitterVoiceEnabled || next.selectionSearchEnabled) startSocialModule();
        if (next.decisionEnabled) startDecisionModule();
      }
      refreshTicker();
      return;
    }

    // 已看 CA 独立开关：不影响决策圆球
    if (prev.viewedCAEnabled !== next.viewedCAEnabled) {
      if (next.dsmEnabled && next.viewedCAEnabled) {
        startViewed();
      } else {
        stopViewed();
      }
      refreshTicker();
    }

    // 推特监控增强：语音 / 划词搜索任一开关变化时重新绑定对应监听。
    if (prev.twitterVoiceEnabled !== next.twitterVoiceEnabled ||
        prev.selectionSearchEnabled !== next.selectionSearchEnabled) {
      restartSocialModule();
    }

    // 决策模块独立开关：不影响已看 CA
    if (prev.decisionEnabled !== next.decisionEnabled) {
      if (next.dsmEnabled && next.decisionEnabled) {
        startDecisionModule();
      } else {
        stopDecisionModule();
      }
      refreshTicker();
      return;
    }

    // 仅数值/电池开关变化：原地更新，不重建 DOM
    if (decision.started) {
      if (prev.circleSize !== next.circleSize) applyCircleSize();
      if (prev.decisionSeconds !== next.decisionSeconds && decision.decisionRemaining > 0 && !decision.manualConfirmed) {
        startDecisionCycle();
      }
      if (prev.batteryEnabled !== next.batteryEnabled) {
        if (next.batteryEnabled) {
          loadRestState();
          updateRestTimer();
        } else {
          hideRestToast();
        }
      } else if (!next.batteryEnabled) {
        hideRestToast();
      }
    }
  }

  function applyAll() {
    stopViewed();
    stopSocialModule();
    stopDecisionModule();
    stopTicker();
    stopUrlWatcher();

    if (!isMasterOn()) return;

    if (settings.viewedCAEnabled) startViewed();
    if (settings.twitterVoiceEnabled || settings.selectionSearchEnabled) startSocialModule();
    if (settings.decisionEnabled) startDecisionModule();
    refreshTicker();
  }

  // ---------- 初始化 ----------
  // 高亮词必须比 GMGN 的 React 委托更早截获，因此不等待 DOMContentLoaded
  // 或 storage 读取；开关状态仍由 handler 内的 settings 实时判断。
  installEarlyKeywordInterceptors();

  // 尽早安装 history 补丁：content script 在 document_start 注入，
  // 先于页面路由捕获原始 pushState/replaceState，SPA 跳转可被零延迟感知。
  patchHistory();

  function init() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', loadSettings, { once: true });
      return;
    }
    loadSettings();
  }

  init();
})();
