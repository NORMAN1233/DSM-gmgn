(() => {
  'use strict';

  // ============================================================
  // DSM-gmgn v2.9.1 Content Script
  // 原插件 1：GMGN 已看 CA 标记（jiankongtiao）
  // 原插件 2：GMGN 5秒极速辅助决策（GMGN-5s-Decision / C:\repo 圆形倒计时版）
  // 设计目标：功能可开关、设置持久化、UI 对齐 DataStorm、尽量不拖慢 GMGN 页面。
  // ============================================================

  const SETTINGS_KEY = 'dsmSettings'; // legacy aggregate, read-only after v2.0.2 migration
  const SETTING_FIELD_PREFIX = 'dsmSetting_';
  const DEFAULT_SETTINGS = {
    dsmEnabled: true,
    viewedCAEnabled: true,
    aiNarrativeEnabled: true,
    trendNote: '',
    twitterVoiceEnabled: true,
    twitterVoiceVolume: 100,
    xPostViewsEnabled: true,
    xPostViewThreshold: 1_000_000,
    twitterVoiceName: 'zh-CN-XiaoxiaoNeural',
    twitterVoiceRate: 115,
    selectionSearchEnabled: true,
    axiomPrimaryEnabled: false,
    devArkmEnabled: false,
    decisionEnabled: true,
    countdownVoiceEnabled: true,
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
  let settingsLoaded = false;

  const PAGE_HOST = location.hostname.toLowerCase();
  const PAGE_PLATFORM = PAGE_HOST === 'axiom.trade' || PAGE_HOST.endsWith('.axiom.trade')
    ? 'axiom'
    : 'gmgn';
  const IS_GMGN = PAGE_PLATFORM === 'gmgn';
  const TOKEN_CA_SOURCE = '(?:0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})';
  const TOKEN_ROUTE_RE = new RegExp(`/(?:token|pump|t|meme|trade)/(${TOKEN_CA_SOURCE})(?=/|$|[?#])`, 'i');
  const CHAIN_ADDRESS_RE = new RegExp(`/(?:sol|eth|base|bsc|ton|sui|btc|trx|tron)/(${TOKEN_CA_SOURCE})(?=/|$|[?#])`, 'i');

  if (document.documentElement) document.documentElement.dataset.dsmPlatform = PAGE_PLATFORM;

  function extractTokenCA(value) {
    const raw = String(value || '');
    let url = null;
    try { url = new URL(raw, location.href); } catch (error) { /* use raw fallback */ }
    const route = url ? `${url.pathname}${url.hash}` : raw;
    const match = route.match(TOKEN_ROUTE_RE) || route.match(CHAIN_ADDRESS_RE);
    if (match) return /^0x/i.test(match[1]) ? match[1].toLowerCase() : match[1];
    if (url) {
      for (const key of ['address', 'ca', 'mint', 'token']) {
        const candidate = String(url.searchParams.get(key) || '').trim();
        if (new RegExp(`^${TOKEN_CA_SOURCE}$`, 'i').test(candidate)) {
          return /^0x/i.test(candidate) ? candidate.toLowerCase() : candidate;
        }
      }
    }
    return '';
  }

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
    settingsLoaded = true;
    if (IS_GMGN) {
      updateTrendNote();
      if (document.readyState === 'loading' && document.body) updateAiNarrative();
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', applyAll, { once: true });
    } else {
      applyAll();
    }
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
    // GMGN 使用 /token/，Axiom 当前使用 /meme/；其余路由保留作兼容兜底。
    CARD_SELECTOR: 'a[href*="/token/"],a[href*="/pump/"],a[href*="/t/"],a[href*="/meme/"],a[href*="/trade/"]',
    VIEWED_CLASS: 'gmgn-viewed-ca-card-viewed',
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
    return normalizeCA(extractTokenCA(href));
  }

  function getCurrentTokenCA() {
    return normalizeCA(extractTokenCA(location.href));
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
    if (!ca || viewed.viewedMap.has(ca)) return;

    // localStorage 在同一站点的标签页之间共享。先吸收其他标签页
    // 最新数据，再追加当前 CA；立即写本地用于跨标签页快速传播，Chrome storage
    // 仍保持 1 秒节流持久化，兼顾性能与可靠性。
    mergeViewedMap(readLocalViewed());
    if (viewed.viewedMap.has(ca)) return;
    viewed.viewedMap.set(ca, Date.now());
    writeLocalViewed();
    applyViewedForCA(ca);
    persistViewedDebounced();
  }

  // markViewed 已同步同源标签；跨站持久化前由 saveViewed 合并最新快照。
  function persistViewedDebounced() {
    if (viewed.persistTimer !== null) return;
    viewed.persistTimer = setTimeout(() => {
      viewed.persistTimer = null;
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
        border-left-width: 0 !important;
        border-left-color: transparent !important;
      }
      html[data-dsm-platform="gmgn"] .${viewed.VIEWED_CLASS}::before,
      html[data-dsm-platform="gmgn"] .${viewed.VIEWED_CLASS}::after {
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
      html[data-dsm-platform="axiom"] .${viewed.VIEWED_CLASS} {
        position: relative !important;
        opacity: .62 !important;
        filter: saturate(.55) !important;
      }
      html[data-dsm-platform="axiom"] .${viewed.VIEWED_CLASS}::after {
        content: "已看" !important;
        display: block !important;
        position: absolute !important;
        z-index: 2 !important;
        top: 5px !important;
        right: 6px !important;
        padding: 1px 5px !important;
        border-radius: 4px !important;
        background: rgba(91, 98, 111, .88) !important;
        color: #fff !important;
        font: 600 10px/16px system-ui, sans-serif !important;
        pointer-events: none !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  const VIEWED_LEGACY_RAIL_SELECTOR = '[style*="rgb(123, 68, 242)"],[style*="rgb(123,68,242)"],[style*="#7b44f2"]';

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
    if (!ca && !card.classList.contains(viewed.VIEWED_CLASS)) return;
    const isViewed = !!ca && viewed.viewedMap.has(ca);
    card.classList.toggle(viewed.VIEWED_CLASS, isViewed);

    if (isViewed) {
      if (!viewed.processedCards.has(card)) {
        hideCardLeftBars(card);
        viewed.processedCards.add(card);
      }
    } else {
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
    try { cards = document.querySelectorAll(`a[href*="${escaped}"]`); } catch (error) {}
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
      for (const mutation of mutations) {
        if (mutation.type === 'attributes') {
          const card = mutation.target;
          if (card.classList.contains(viewed.VIEWED_CLASS) || card.matches(viewed.CARD_SELECTOR)) cardsToApply.add(card);
          continue;
        }

        if (!mutation.addedNodes.length) continue;
        let viewedCard;
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE || !node.isConnected) continue;
          if (viewedCard === undefined) {
            const card = mutation.target.closest?.(viewed.CARD_SELECTOR);
            viewedCard = card?.classList.contains(viewed.VIEWED_CLASS) ? card : null;
          }
          if (node.matches(viewed.CARD_SELECTOR)) cardsToApply.add(node);
          if (node.childElementCount) {
            for (const card of node.querySelectorAll(viewed.CARD_SELECTOR)) cardsToApply.add(card);
          }

          if (viewedCard && (node.matches(VIEWED_LEGACY_RAIL_SELECTOR) ||
              (node.childElementCount && node.querySelector(VIEWED_LEGACY_RAIL_SELECTOR)))) {
            viewed.processedCards.delete(viewedCard);
            cardsToApply.add(viewedCard);
          }
        }
      }

      for (const card of cardsToApply) {
        if (card.isConnected) applyToCard(card);
      }
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
    scanTimer: null,
    keepAliveTimer: null,
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
    // 用户在 GMGN 给博主设置的自定义备注：小写 @handle → 备注文本。
    // 备注只存在于页面 DOM（内联橙色），WS 帧里拿不到，需从卡片头部抓取缓存。
    remarkMap: new Map(),
    REMARK_ITEM_PREFIX: 'dsmTwitterRemarkV3:',
    // 小写昵称 → 小写 handle：WS 帧里的 id/tw 都对不上时的第三路反查。
    nickToHandleMap: new Map(),
    persistedNickMap: new Map(),
    ambiguousNickKeys: new Set(),
    NICK_MAP_MAX: 500,
    remarksLoaded: false,
    remarksLoadPromise: null,
    REMARK_NICK_PREFIX: 'dsmTwitterNickV3:',
    nextRemarkSweepAt: 0,
    // v2.9.3 同文冷却：GMGN 会把同一条推文随监控快照反复重发（实测 2~10s 一帧），
    // 注入层 eventId 取帧内推文 ID 列表哈希，item 缺 ID 字段时退化为易变 JSON，
    // 重发即换指纹，SW 的 60s key 去重挡不住 → 同一句「XX 发推啦」连播两三遍。
    // 对最终播报文本按 25s 冷却，同文只播首条。
    announcedTexts: new Map(),
    ANNOUNCE_TEXT_COOLDOWN_MS: 25000,
    sessionId: 0
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
    return Array.from(scope.querySelectorAll('a[href]')).filter((anchor) => {
      const text = cleanText(anchor.textContent);
      if (!text.startsWith('@')) return false;
      return !!profileHandleFromHref(anchor.getAttribute('href'));
    });
  }

  function profileHandleFromHref(href) {
    try {
      const url = new URL(String(href || ''), location.href);
      const host = url.hostname.toLowerCase().replace(/^www\./, '');
      if (host !== 'x.com' && host !== 'twitter.com') return '';
      const parts = url.pathname.split('/').filter(Boolean);
      return parts.length === 1 ? normalizeHandleKey(decodeURIComponent(parts[0])) : '';
    } catch (error) {
      return '';
    }
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

  // 备注候选必须像“人起的名字”：GMGN 现在把 @handle 链接文字、"$6.9M" 徽标和
  // 「回复 @某人」标签（text-yellow-100 与备注同款色，真机日志实证被念成
  // “回复 XXX 发推啦”）都渲染成同款橙色。硬校验：与锚点句柄相同（忽略 @ 和
  // 大小写）、纯金额/数字徽标、回复标签形状（回复/Reply 开头）的文本，一律拒绝。
  function normalizeRemarkText(text, handleLower) {
    let value = cleanText(text);
    if (!value) return '';
    const handle = normalizeHandleKey(handleLower);
    if (handle) {
      // Older builds could persist an orange wrapper whose text was
      // "GMGN备注 @twitter_handle". Strip only this account's explicit handle;
      // never concatenate it into the text sent to TTS.
      const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      value = cleanText(value.replace(new RegExp(`@${escaped}(?=$|[^a-z0-9_])`, 'ig'), ' '));
    }
    if (!value || normalizeHandleKey(value) === handle) return '';
    // Any remaining @handle means this is still a composite UI wrapper rather
    // than the user's plain GMGN remark. Reject it instead of caching mixed text.
    if (/@[a-z0-9_]{1,15}\b/i.test(value)) return '';
    if (/^[$€£￥]?\d+(?:[.,]\d+)?\s*[kmb]?$/i.test(value)) return '';
    // Validate the spoken text: arrows/punctuation can otherwise hide a reply label.
    // This also rejects polluted remarks loaded from older cached metadata.
    if (/^(?:回复|repl)/i.test(sanitizeSpokenAuthor(value))) return '';
    return value.slice(0, 80);
  }

  function rememberRemark(handleLower, remark) {
    const text = normalizeRemarkText(remark, handleLower);
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

  function normalizeNickKey(value) {
    return cleanText(value).normalize('NFKC').toLowerCase();
  }

  function remarkNickStorageKey(nickKey) {
    return `${social.REMARK_NICK_PREFIX}${nickKey}`;
  }

  function rememberNickPair(nickText, handleLower, persist = false) {
    const nick = normalizeNickKey(nickText);
    if (!nick || !handleLower || nick.startsWith('@')) return;
    const currentHandle = social.nickToHandleMap.get(nick);
    if (currentHandle && currentHandle !== handleLower) {
      // Display names are not unique. Once the same nickname is observed for two
      // handles, it is unsafe as a reverse-lookup key: remove the persisted pair
      // so it can never make one account speak another account's GMGN remark.
      social.ambiguousNickKeys.add(nick);
      social.nickToHandleMap.delete(nick);
      social.persistedNickMap.delete(nick);
      try { chrome.storage.local.remove(remarkNickStorageKey(nick)).catch(() => {}); } catch (error) {}
      return;
    }
    if (social.ambiguousNickKeys.has(nick)) return;
    const unchanged = social.nickToHandleMap.get(nick) === handleLower;
    const alreadyPersisted = social.persistedNickMap.get(nick) === handleLower;
    if (unchanged && (!persist || alreadyPersisted)) return;
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
    if (persist) {
      social.persistedNickMap.set(nick, handleLower);
      try {
        chrome.storage.local.set({ [remarkNickStorageKey(nick)]: handleLower }).catch(() => {});
      } catch (error) {}
    }
  }

  // 备注是 GMGN 的内联橙色样式，颜色本身是唯一可靠信号：不再要求特定类名，
  // 避免备注 span 与普通昵称类名不一致时永远抓不到。跳过推文正文里的高亮词；
  // 跳过 X/Twitter 链接内（v2.7.2：@handle 文字被染成同款橙色）和内含账号链接的
  // span（v2.7.4：「回复 @某人」标签外层黄色 span 把链接包在里面，真机日志
  // 实证污染备注缓存），以及校验不通过的候选，继续找下一个，
  // 这样无效橙色不会挡住后面的昵称反查。
  function findOrangeRemarkSpan(scope, handleLower) {
    const matches = [];
    for (const span of scope.querySelectorAll('span')) {
      if (span.closest(social.BODY_SELECTOR)) continue;
      // 真备注永远是纯文本；span 里包着 x.com/twitter.com 链接的一定是
      // 「回复 @某人」这类标签外壳，不是备注。
      let wrapsProfileLink = false;
      for (const link of span.querySelectorAll('a')) {
        if (profileHandleFromHref(link.getAttribute('href'))) {
          wrapsProfileLink = true;
          break;
        }
      }
      if (wrapsProfileLink) continue;
      const anchorOwner = span.closest('a');
      if (anchorOwner && profileHandleFromHref(anchorOwner.getAttribute('href'))) continue;
      const text = normalizeRemarkText(span.textContent, handleLower);
      if (!text) continue;
      if (!isRemarkOrange(span)) continue;
      matches.push({ span, text, nested: span.querySelectorAll('span').length });
    }
    // querySelectorAll is outer-first. Prefer the smallest/deepest orange node so
    // a valid inner remark wins over an inherited-color wrapper around the header.
    matches.sort((left, right) => left.nested - right.nested || left.text.length - right.text.length);
    return matches[0]?.span || null;
  }

  function captureTwitterRemark(handleAnchor, scope) {
    if (!handleAnchor || !scope?.contains?.(handleAnchor)) return;
    if (handleAnchor.closest(social.BODY_SELECTOR)) return;
    const handleLower = profileHandleFromHref(handleAnchor.getAttribute('href'));
    if (!handleLower) return;

    let node = handleAnchor.parentElement;
    for (let depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
      if (!scope.contains(node)) break;
      // Do not climb past the author header into reply labels or quoted content.
      if (node.matches(social.BODY_SELECTOR) || node.querySelector(social.BODY_SELECTOR)) break;
      const handles = profileHandleAnchors(node);
      if (handles.length > 1) break; // 越过卡片进入列表容器，避免误配他人

      // 命中有效橙色即写入缓存；从最内层向外找，优先取离 handle 最近的那个。
      const orange = findOrangeRemarkSpan(node, handleLower);
      if (orange) {
        rememberRemark(handleLower, orange.textContent);
        // 有些 WS 帧的 id/tw 不是页面 handle；同时保存同卡片昵称别名，后续可由
        // u.n 反查到 handle，再严格命中备注。排除橙色备注本身，避免自映射。
        const aliases = new Map();
        for (const candidate of authorCandidates(node)) {
          if (candidate === orange || candidate.contains(orange) || orange.contains(candidate)) continue;
          const alias = cleanText(candidate.textContent);
          const aliasKey = normalizeNickKey(alias);
          if (aliasKey) aliases.set(aliasKey, alias);
        }
        if (aliases.size === 1) rememberNickPair(Array.from(aliases.values())[0], handleLower, true);
        return;
      }

      // 未命中橙色只能说明当前卡片显示了昵称，不能证明用户删除了备注。
      // GMGN 的不同卡片布局和 React 过渡帧经常不渲染橙色备注，因此绝不据此删缓存。
      if (!node.querySelector?.('svg[data-icon="IconEdit16pxRegular"]')) continue;
      const candidates = authorCandidates(node);
      if (candidates.length !== 1 || handles.length !== 1 || handles[0] !== handleAnchor) continue;
      rememberNickPair(candidates[0].textContent, handleLower, social.remarkMap.has(handleLower));
    }
  }

  function mergeStoredTwitterMetadata(data) {
    for (const [key, value] of Object.entries(data || {})) {
      if (key.startsWith(social.REMARK_ITEM_PREFIX) && typeof value === 'string') {
        const handle = normalizeHandleKey(key.slice(social.REMARK_ITEM_PREFIX.length));
        const text = normalizeRemarkText(value, handle);
        if (!handle) continue;
        if (!text) {
          social.remarkMap.delete(handle);
          try { chrome.storage.local.remove(key).catch(() => {}); } catch (error) {}
          continue;
        }
        social.remarkMap.set(handle, text);
        if (text !== cleanText(value)) {
          try { chrome.storage.local.set({ [key]: text }).catch(() => {}); } catch (error) {}
        }
      } else if (key.startsWith(social.REMARK_NICK_PREFIX) && typeof value === 'string') {
        const nick = normalizeNickKey(key.slice(social.REMARK_NICK_PREFIX.length));
        const handle = normalizeHandleKey(value);
        if (nick && handle && !social.ambiguousNickKeys.has(nick)) {
          social.nickToHandleMap.set(nick, handle);
          social.persistedNickMap.set(nick, handle);
        }
      }
    }
  }

  function loadTwitterRemarks() {
    if (social.remarksLoaded) return Promise.resolve();
    if (social.remarksLoadPromise) return social.remarksLoadPromise;
    try {
      social.remarksLoadPromise = chrome.storage.local.get(null)
        .then((data) => mergeStoredTwitterMetadata(data))
        .catch(() => {})
        .finally(() => {
          social.remarksLoaded = true;
          social.remarksLoadPromise = null;
        });
    } catch (error) {
      social.remarksLoaded = true;
      social.remarksLoadPromise = Promise.resolve();
    }
    return social.remarksLoadPromise;
  }

  function findTwitterRemarkHeader(body) {
    for (let node = body, depth = 0; node?.parentElement && depth < 14; node = node.parentElement, depth += 1) {
      for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling.matches(social.BODY_SELECTOR) || sibling.querySelector(social.BODY_SELECTOR)) return null;
        const edits = sibling.querySelectorAll('svg[data-icon="IconEdit16pxRegular"]');
        if (edits.length !== 1) continue;
        const handles = profileHandleAnchors(sibling);
        if (handles.length === 1) return { anchor: handles[0], scope: sibling };
      }
      // An earlier body in this branch belongs to a different post.
      if (node.parentElement.querySelector(social.BODY_SELECTOR) !== body) return null;
    }
    return null;
  }

  // React 卡片晚于 DOMContentLoaded 挂载，且橙色备注常在首帧后才经属性变更刷入
  // （childList observer 感知不到）。低频全量扫描兜底，保证缓存始终新鲜。
  function sweepRemarks(force = false) {
    const now = performance.now();
    if (!document.body || (!force && now < social.nextRemarkSweepAt)) return;
    social.nextRemarkSweepAt = now + 1000;
    for (const body of document.querySelectorAll(social.BODY_SELECTOR)) {
      const header = findTwitterRemarkHeader(body);
      if (header) {
        captureTwitterRemark(header.anchor, header.scope);
        continue;
      }
      const card = findTweetCardForNode(body);
      if (!card) continue;
      const [anchor] = profileHandleAnchors(card);
      if (anchor) captureTwitterRemark(anchor, card);
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
    for (const [key, change] of Object.entries(changes)) {
      if (key.startsWith(social.REMARK_ITEM_PREFIX)) {
        const handle = normalizeHandleKey(key.slice(social.REMARK_ITEM_PREFIX.length));
        const rawText = typeof change.newValue === 'string' ? cleanText(change.newValue) : '';
        const text = normalizeRemarkText(rawText, handle);
        if (handle && text) {
          social.remarkMap.set(handle, text);
          if (text !== rawText) {
            try { chrome.storage.local.set({ [key]: text }).catch(() => {}); } catch (error) {}
          }
        } else if (handle && rawText) {
          social.remarkMap.delete(handle);
          try { chrome.storage.local.remove(key).catch(() => {}); } catch (error) {}
        } else if (handle && change.newValue === undefined) {
          // 只有明确删除对应 V2 存储项时才删除，普通昵称渲染不再触发删除。
          social.remarkMap.delete(handle);
        }
      } else if (key.startsWith(social.REMARK_NICK_PREFIX)) {
        const nick = normalizeNickKey(key.slice(social.REMARK_NICK_PREFIX.length));
        const handle = normalizeHandleKey(change.newValue);
        if (nick && handle && !social.ambiguousNickKeys.has(nick)) {
          social.nickToHandleMap.set(nick, handle);
          social.persistedNickMap.set(nick, handle);
        } else if (nick && change.newValue === undefined) {
          social.nickToHandleMap.delete(nick);
          social.persistedNickMap.delete(nick);
        }
      }
    }
  });

  function normalizeHandleKey(value) {
    const handle = String(value || '').trim().toLowerCase().replace(/^@+/, '');
    if (!/^[a-z0-9_]{1,15}$/.test(handle) || handle === 'unknown') return '';
    return handle;
  }

  // WS 帧里 id/tw 字段的实际内容不受我们控制（可能是 handle 也可能是数字 ID），
  // 匹配备注时把所有候选 key 都试一遍，再用昵称反查表兜底。
  function remarkCandidateKeys(trigger) {
    const keys = [];
    for (const raw of [trigger?.id, trigger?.tw]) {
      const key = normalizeHandleKey(raw);
      if (key && !keys.includes(key)) keys.push(key);
    }
    const handle = keys.find((key) => !/^\d+$/.test(key));
    if (handle) return [handle];
    const nickKey = normalizeNickKey(trigger?.name);
    const viaNick = nickKey ? social.nickToHandleMap.get(nickKey) : '';
    if (viaNick && !keys.includes(viaNick)) keys.push(viaNick);
    return keys;
  }

  // 命中 GMGN 备注返回可播报名；空串表示未命中。
  function resolveSpokenName(trigger) {
    for (const key of remarkCandidateKeys(trigger)) {
      const hit = sanitizeSpokenAuthor(normalizeRemarkText(social.remarkMap.get(key), key));
      if (hit) {
        // 一旦由任一 WS 字段准确命中备注，就固化昵称别名；下次即使 id/tw
        // 字段换成数字 ID，也可直接从 u.n 反查到用户备注。
        rememberNickPair(trigger?.name, key, true);
        return hit;
      }
    }
    return '';
  }

  function buildTwitterAnnouncement(triggers) {
    const identities = new Map();
    for (const trigger of Array.isArray(triggers) ? triggers : []) {
      const candidateKeys = remarkCandidateKeys(trigger);
      let spokenName = resolveSpokenName(trigger);
      const usedRemark = !!spokenName;
      if (spokenName) {
        console.debug('[DSM speak] 备注命中 →', spokenName, '| key:', candidateKeys.join(','));
      } else {
        spokenName = sanitizeSpokenAuthor(trigger?.name || trigger?.id);
        if (spokenName) console.debug('[DSM speak] 无备注，回退昵称 →', spokenName, '| key:', candidateKeys.join(','));
      }
      if (!spokenName) continue;

      // Merge by account identity before formatting labels. If duplicate WS rows
      // resolve at different times, a GMGN remark replaces the fallback handle
      // for that identity instead of both names being spoken together.
      const identity = candidateKeys.find((key) => social.remarkMap.has(key))
        || normalizeHandleKey(trigger?.id)
        || normalizeHandleKey(trigger?.tw)
        || `nick:${normalizeNickKey(trigger?.name)}`;
      const current = identities.get(identity);
      if (!current) {
        identities.set(identity, { name: spokenName, count: 1, usedRemark });
      } else {
        current.count += 1;
        if (usedRemark && !current.usedRemark) {
          current.name = spokenName;
          current.usedRemark = true;
        }
      }
    }
    const counts = new Map();
    for (const item of identities.values()) {
      counts.set(item.name, (counts.get(item.name) || 0) + item.count);
    }
    const labels = Array.from(counts.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, count]) => count > 1 ? `${name}${count}条` : name);
    if (!labels.length) return '';
    return labels.length > 3 ? `${labels.join('、')}一起发推啦` : `${labels.join('、')} 发推啦`;
  }

  function sendSpeakMessage(text, tweetKey, waitMs = 0) {
    try {
      chrome.runtime.sendMessage({
        type: 'DSM_SPEAK_TWITTER_AUTHOR',
        text,
        key: tweetKey,
        volume: Math.min(1, Math.max(0, Number(settings.twitterVoiceVolume) / 100 || 0)),
        voiceName: String(settings.twitterVoiceName || 'zh-CN-XiaoxiaoNeural'),
        rate: Math.min(200, Math.max(50, Number(settings.twitterVoiceRate) || 115)),
        enqueue: true,
        waitMs: Math.max(0, Math.round(Number(waitMs) || 0))
      }).catch(() => {});
    } catch (error) {
      // AI TTS failure must never block or alter GMGN page behavior.
    }
  }

  async function speakTwitterAnnouncement(triggers, tweetKey) {
    if (!settings.twitterVoiceEnabled) return;
    const list = Array.isArray(triggers) ? triggers : [];
    if (!social.started || !isMasterOn()) return;
    const startedAt = Date.now();
    if (list.some(trigger => !resolveSpokenName(trigger))) sweepRemarks();
    const text = buildTwitterAnnouncement(list);
    if (!text) return;
    const nowMs = Date.now();
    for (const [spoken, at] of social.announcedTexts) {
      if (nowMs - at >= social.ANNOUNCE_TEXT_COOLDOWN_MS) social.announcedTexts.delete(spoken);
    }
    if (social.announcedTexts.has(text)) {
      console.debug('[DSM speak] 同文冷却内跳过 →', text);
      return;
    }
    social.announcedTexts.set(text, nowMs);
    sendSpeakMessage(text, tweetKey, Date.now() - startedAt);
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
    speakTwitterAnnouncement(triggers, key).catch(() => {});
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
    const isTopArea = (candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.top >= 0 && rect.top < Math.min(180, window.innerHeight * 0.25);
    };
    // v2.9.5：占位词命中但不在页头（滚动后头部非吸顶/被弹窗遮挡）也算有搜索框，
    // 优先取页头那个。旧版在此直接判 false，探针整页误报「无全局搜索框」→
    // no-gmgn-search-page；真实注入由 background 的同款放宽判定完成。
    for (const selector of exactSelectors) {
      const inputs = Array.from(document.querySelectorAll(selector)).filter(isVisibleElement);
      const topInput = inputs.find(isTopArea);
      if (topInput) return topInput;
      if (inputs.length) return inputs[0];
    }
    // v2.9.5 兜底：GMGN 改占位词时，只要搜索组件标记还在就能认出来。
    return Array.from(document.querySelectorAll('[data-sentry-component="Search"] input'))
      .find(isVisibleElement) || null;
  }

  function findVisibleAxiomGlobalSearchLauncher() {
    const searchText = /search|token|ticker|symbol|contract|address|mint|搜索|合约/i;
    const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]),textarea')).filter((candidate) => {
      if (!isVisibleElement(candidate)) return false;
      const hint = `${candidate.getAttribute('placeholder') || ''} ${candidate.getAttribute('aria-label') || ''}`;
      return searchText.test(hint);
    });
    if (inputs.length) {
      return inputs.sort((a, b) => {
        const aDialog = a.closest('[role="dialog"],[aria-modal="true"]') ? 1 : 0;
        const bDialog = b.closest('[role="dialog"],[aria-modal="true"]') ? 1 : 0;
        return bDialog - aDialog || a.getBoundingClientRect().top - b.getBoundingClientRect().top;
      })[0];
    }

    const buttons = Array.from(document.querySelectorAll('button,[role="button"]')).filter(isVisibleElement);
    const labelled = buttons.find((button) => /search|搜索/i.test([
      button.getAttribute('aria-label'),
      button.getAttribute('title'),
      button.dataset?.tooltip,
      button.textContent
    ].filter(Boolean).join(' ')));
    if (labelled) return labelled;

    // Axiom 的全局搜索是顶部导航中的无文字放大镜按钮。它稳定地位于页面
    // 宽度 55%–70% 区域；严格限制尺寸和纵向位置，避免命中交易面板按钮。
    return buttons.find((button) => {
      const rect = button.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      return rect.top >= 0 && rect.bottom <= 70
        && rect.width >= 24 && rect.width <= 56
        && rect.height >= 24 && rect.height <= 56
        && centerX >= window.innerWidth * .55 && centerX <= window.innerWidth * .70;
    }) || null;
  }

  function findVisiblePlatformSearchLauncher() {
    return PAGE_PLATFORM === 'axiom'
      ? findVisibleAxiomGlobalSearchLauncher()
      : findVisibleGmgnGlobalSearchLauncher();
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

  function showSelectionRouteToast(text, ok = true, prominent = false) {
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
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    Object.assign(toast.style, {
      top: prominent ? '24%' : '12px',
      padding: prominent ? '22px 32px' : '7px 11px',
      fontSize: prominent ? '22px' : '12px',
      lineHeight: prominent ? '32px' : '16px',
      fontWeight: prominent ? '700' : '400'
    });
    toast.style.background = ok ? 'rgba(35, 126, 74, .94)' : 'rgba(185, 52, 52, .94)';
    toast.style.opacity = '1';
    clearTimeout(showSelectionRouteToast.timer);
    showSelectionRouteToast.timer = setTimeout(() => {
      if (toast) toast.style.opacity = '0';
    }, prominent ? 4500 : 1300);
  }

  function handleSearchRouteResponse(response, query) {
    if (response && response.ok) {
      if (response.action === 'detail' && response.platform === 'axiom') {
        showSelectionRouteToast(`Axiom K 线详情：${query}`, true);
        return;
      }
      const targetName = response.platform === 'axiom' ? 'Axiom' : 'GMGN';
      showSelectionRouteToast(`${targetName} 代币搜索：${query}`, true);
    } else if (response?.reason === 'no-axiom-search-page' || response?.reason === 'no-axiom-page' || response?.platform === 'axiom') {
      showSelectionRouteToast('请先打开 Axiom 页面', false);
    } else {
      showSelectionRouteToast('未找到 GMGN 代币搜索框', false);
    }
  }

  function sendSelectionToScanPage(query) {
    if (!query) return;
    try {
      const maybePromise = chrome.runtime.sendMessage({
        type: 'DSM_CROSS_TAB_GMGN_SEARCH',
        query,
        preferAxiom: !!settings.axiomPrimaryEnabled
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
          const retry = chrome.runtime.sendMessage({
            type: 'DSM_CROSS_TAB_GMGN_SEARCH',
            query,
            preferAxiom: !!settings.axiomPrimaryEnabled
          });
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
    // 推特 WS 播报和正文取词只存在于 GMGN；Axiom 页面仅作为跨屏搜索目标。
    const voiceEnabledHere = IS_GMGN && settings.twitterVoiceEnabled;
    const selectionEnabledHere = IS_GMGN && settings.selectionSearchEnabled;
    if (social.started || (!voiceEnabledHere && !selectionEnabledHere)) return;
    social.sessionId += 1;
    social.started = true;
    social.ac = new AbortController();

    if (voiceEnabledHere) {
      social.nextRemarkSweepAt = 0;
      const sessionId = social.sessionId;
      loadTwitterRemarks().then(() => {
        if (social.started && social.sessionId === sessionId) sweepRemarks();
      }).catch(() => {});
    }

    if (voiceEnabledHere) {
      sweepRemarks();
      if (social.scanTimer === null) {
        social.scanTimer = setInterval(() => {
          if (document.visibilityState !== 'visible') return;
          sweepRemarks();
        }, 5000);
      }
      // v2.9.2 SW 保活：20s 心跳保持 service worker 常驻并预建 offscreen，
      // 播报免去 ~0.1-0.6s 冷启动。后台标签的定时器会被 Chrome 节流到约
      // 1 次/分钟，仍足以覆盖 30s 的 SW 空闲回收线。
      if (social.keepAliveTimer === null) {
        social.keepAliveTimer = setInterval(() => {
          try { chrome.runtime.sendMessage({ type: 'DSM_KEEPALIVE' }).catch(() => {}); } catch (error) {}
        }, 20000);
      }
      window.addEventListener('DSM_TWITTER_WS_MSG_RECEIVED', handleTwitterWsMessage, { signal: social.ac.signal });
    }

    if (selectionEnabledHere) {
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
    social.sessionId += 1;
    if (social.ac) {
      social.ac.abort();
      social.ac = null;
    }
    if (social.scanTimer !== null) {
      clearInterval(social.scanTimer);
      social.scanTimer = null;
    }
    if (social.keepAliveTimer !== null) {
      clearInterval(social.keepAliveTimer);
      social.keepAliveTimer = null;
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

  // Cross-tab search receiver. The background probes GMGN + Axiom tabs and sends
  // the query only to a tab whose real global search launcher is currently visible.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return;

    if (message.type === 'DSM_REPORT_NARRATIVE_MISSING') {
      const visit = aiNarrativeVisit;
      if (!visit || visit.route !== location.pathname) { sendResponse({ ok: false }); return; }
      logNarrativeDelay(visit, '用户反馈标注未显示');
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'DSM_WALLET_COPY_STATUS') {
      showSelectionRouteToast(String(message.text || ''), !String(message.text).includes('关闭'), true);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'DSM_PROBE_GMGN_SEARCH_TARGET') {
      const input = findVisiblePlatformSearchLauncher();
      sendResponse({
        ok: true,
        hasGlobalSearch: !!input,
        platform: PAGE_PLATFORM,
        visible: document.visibilityState === 'visible',
        focused: document.hasFocus(),
        href: location.href,
        // v2.9.5：诊断辅助——探针报「无搜索框」时，pi-input 总数能区分
        // 「GMGN 改了占位词/结构」(N>0) 和「页面真没有搜索框」(N=0)。
        piInputCount: document.querySelectorAll('input.pi-input').length
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
  // Axiom 快捷键：C 触发原生 Paste CA，X 按住预览原生 X 信息
  // ============================================================
  const axiomHotkeys = { xPressed: false, xQueue: Promise.resolve(), cSeq: 0 };
  const AXIOM_PASTE_REQUEST_EVENT = 'dsm-axiom-native-paste-ca';
  const AXIOM_PASTE_RESULT_ATTR = 'data-dsm-axiom-native-paste-result';

  function isTypingTarget(target) {
    return target instanceof Element
      && !!target.closest('input,textarea,select,[contenteditable="true"],[role="textbox"]');
  }

  function triggerAxiomNativePasteCa() {
    const root = document.documentElement;
    if (!root) return 'bridge-unavailable';
    root.removeAttribute(AXIOM_PASTE_RESULT_ATTR);
    document.dispatchEvent(new CustomEvent(AXIOM_PASTE_REQUEST_EVENT));
    const result = root.getAttribute(AXIOM_PASTE_RESULT_ATTR) || 'bridge-unavailable';
    root.removeAttribute(AXIOM_PASTE_RESULT_ATTR);
    return result;
  }

  function isAxiomKlineLocation(href = location.href) {
    try {
      return /\/(?:meme|token|trade)\//i.test(new URL(href).pathname);
    } catch (error) {
      return false;
    }
  }

  function verifyAxiomPasteNavigation(initialHref, seq, attempt = 0) {
    if (seq !== axiomHotkeys.cSeq) return;
    if (location.href !== initialHref && isAxiomKlineLocation()) {
      showSelectionRouteToast('Axiom K 线已打开', true);
      return;
    }
    if (attempt < 23) {
      setTimeout(() => verifyAxiomPasteNavigation(initialHref, seq, attempt + 1), 250);
      return;
    }
    showSelectionRouteToast('Axiom 已点击但未跳转，请确认剪贴板里是有效 CA', false);
  }

  function sendAxiomHotkeyMessage(message) {
    try {
      const result = chrome.runtime.sendMessage(message);
      return result && typeof result.then === 'function' ? result : Promise.resolve(null);
    } catch (error) {
      return Promise.resolve(null);
    }
  }

  function queueAxiomXPreview(action) {
    axiomHotkeys.xQueue = axiomHotkeys.xQueue.then(() =>
      sendAxiomHotkeyMessage({ type: 'DSM_AXIOM_X_PREVIEW', action }).catch(() => null));
    return axiomHotkeys.xQueue;
  }

  async function handleAxiomHotkeyDown(event) {
    if (PAGE_PLATFORM !== 'axiom' || !isMasterOn() || event.repeat || event.metaKey || event.ctrlKey || event.altKey
        || isTypingTarget(event.target) || isTypingTarget(document.activeElement)) return;
    if (event.code === 'KeyC') {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const initialHref = location.href;
      const result = triggerAxiomNativePasteCa();
      if (result === 'busy') {
        showSelectionRouteToast('Axiom 正在读取 CA…', true);
        return;
      }
      if (!result.startsWith('clicked:')) {
        const message = result === 'bridge-unavailable'
          ? 'Axiom 原生桥接未加载，请重新加载扩展并刷新页面'
          : result === 'click-error'
            ? 'Axiom Paste CA 点击失败，请重试'
            : '未找到 Axiom 原生 Paste CA 按钮，请刷新页面';
        showSelectionRouteToast(message, false);
        return;
      }
      const seq = ++axiomHotkeys.cSeq;
      showSelectionRouteToast('正在打开 Axiom K 线…', true);
      setTimeout(() => verifyAxiomPasteNavigation(initialHref, seq), 250);
      return;
    }
    if (event.code === 'KeyX') {
      event.preventDefault();
      if (axiomHotkeys.xPressed) return;
      axiomHotkeys.xPressed = true;
      const opening = queueAxiomXPreview('open');
      const result = await opening;
      if (axiomHotkeys.xQueue === opening && !result?.ok) {
        showSelectionRouteToast('当前页面未找到项目 X 链接', false);
      }
    }
  }

  function closeAxiomXPreview() {
    if (PAGE_PLATFORM !== 'axiom' || !axiomHotkeys.xPressed) return;
    axiomHotkeys.xPressed = false;
    void queueAxiomXPreview('close');
  }

  if (PAGE_PLATFORM === 'axiom') {
    addEventListener('keydown', (event) => { handleAxiomHotkeyDown(event).catch(() => {}); }, true);
    addEventListener('keyup', (event) => { if (event.code === 'KeyX') closeAxiomXPreview(); }, true);
    addEventListener('blur', closeAxiomXPreview);
  }

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
    keepAliveTimer: null,
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
    const ca = extractTokenCA(href);
    if (ca) return ca.toLowerCase();
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
    return !!extractTokenCA(href);
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
    decision.circle.className = 'dsm-circle-green dsm-circle-hidden';
    if (IS_GMGN) decision.circle.classList.add('dsm-circle-docked');
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

  // 数字/符号每次变化轻弹一下，读秒更有“跳动”的生命感
  function popCircleText() {
    if (!decision.circleText) return;
    if (decision.circle.classList.contains('dsm-circle-docked')) return;
    decision.circleText.classList.remove('dsm-tick');
    void decision.circleText.offsetWidth;
    decision.circleText.classList.add('dsm-tick');
  }

  // 圆球整体弹一下（超时换红灯时用）；先摘类再强排重挂，保证可重复触发
  function pulseCircle(cls) {
    if (!decision.circle) return;
    decision.circle.classList.remove(cls);
    void decision.circle.offsetWidth;
    decision.circle.classList.add(cls);
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
    if (!decision.circle) return;
    // 摘掉超时弹跳：animation 会盖过 transform 过渡，不清掉淡出会瞬移
    decision.circle.classList.remove('dsm-circle-alarm');
    decision.circle.classList.add('dsm-circle-hidden');
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
      popCircleText();
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
    if (decision.circleText) {
      decision.circleText.textContent = String(next);
      popCircleText();
    }
    persistSettings({ decisionSeconds: next });
    if (decision.decisionRemaining > 0 && !decision.manualConfirmed) startDecisionCycle();
  }

  // ---------- 倒计时配音（offscreen 独立声道，不与推文播报排队） ----------
  function isCountdownVoiceOn() {
    return isMasterOn() && settings.decisionEnabled && settings.countdownVoiceEnabled;
  }

  function countdownVoicePayload() {
    return {
      volume: Math.min(1, Math.max(0, Number(settings.twitterVoiceVolume) / 100 || 0)),
      voiceName: String(settings.twitterVoiceName || 'zh-CN-XiaoxiaoNeural'),
      rate: Math.min(200, Math.max(50, Number(settings.twitterVoiceRate) || 115))
    };
  }

  function sendCountdownMessage(message) {
    try {
      chrome.runtime.sendMessage(message).catch(() => {});
    } catch (error) {
      // 配音失败绝不影响倒计时本身
    }
  }

  function speakCountdown(kind, value = 0) {
    if (!decision.started || !isCountdownVoiceOn()) return;
    sendCountdownMessage({ type: 'DSM_COUNTDOWN_SPEAK', kind, value, ...countdownVoicePayload() });
  }

  // 进决策模块即按当前设定秒数预合成全部片段，保证第一轮倒计时就是零延迟
  function prefetchCountdownClips() {
    if (!decision.started || !isCountdownVoiceOn()) return;
    sendCountdownMessage({
      type: 'DSM_COUNTDOWN_PREFETCH',
      maxValue: getDecisionSeconds(),
      ...countdownVoicePayload()
    });
  }

  // 决策页（含仅开 Axiom 的场景）20s 心跳：SW/offscreen 常驻，配音不冷启动
  function startCountdownKeepAlive() {
    if (decision.keepAliveTimer !== null || !isCountdownVoiceOn()) return;
    decision.keepAliveTimer = setInterval(() => {
      try { chrome.runtime.sendMessage({ type: 'DSM_KEEPALIVE' }).catch(() => {}); } catch (error) {}
    }, 20000);
  }

  function stopCountdownKeepAlive() {
    if (decision.keepAliveTimer !== null) {
      clearInterval(decision.keepAliveTimer);
      decision.keepAliveTimer = null;
    }
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
    // 红绿灯：读秒中绿灯，走完未确认才变红灯（finishDecision）
    // 摘掉可能残留的超时弹跳，避免它盖过本轮入场动画
    decision.circle.classList.remove('dsm-circle-alarm');
    setCircleState('green');
    decision.circleText.textContent = String(decision.decisionRemaining);
    popCircleText();
    // 读秒全程逐秒报数（设定几秒就从几报到 1）
    speakCountdown('number', decision.decisionRemaining);

    decision.countdownTimer = setInterval(() => {
      if (decision.manualConfirmed) return;
      decision.decisionRemaining -= 1;
      if (decision.decisionRemaining <= 0) {
        stopDecisionCycle();
        finishDecision();
      } else {
        decision.circleText.textContent = String(decision.decisionRemaining);
        popCircleText();
        speakCountdown('number', decision.decisionRemaining);
      }
    }, 1000);
  }

  function finishDecision() {
    // 走完未确认 → 红灯 ✕（读秒内点击圆圈 = 手动确认，绿灯 ✓）
    setCircleState('red');
    decision.circleText.textContent = '✕';
    if (!decision.circle.classList.contains('dsm-circle-docked')) pulseCircle('dsm-circle-alarm');
    speakCountdown('timeout');
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

    decision.ac = new AbortController();
    window.addEventListener('popstate', watchUrl, { signal: decision.ac.signal });
    window.addEventListener('hashchange', watchUrl, { signal: decision.ac.signal });

    handleLocationChange();
    updateRestTimer();
    prefetchCountdownClips();
    startCountdownKeepAlive();
  }

  function stopDecisionModule() {
    if (!decision.started) return;
    decision.started = false;

    stopDecisionCycle();
    stopCountdownKeepAlive();
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
  function syncRoute() {
    if (!settingsLoaded) return;
    if (IS_GMGN) {
      updateTrendNote();
      updateAiNarrative();
      updateXPostBadge();
    }
    if (viewed.started) watchedViewedUrl();
    if (decision.started) watchUrl();
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

  // SPA 路由的主路径由 Navigation API / popstate / hashchange 即时处理。
  // 这里仅保留 500ms 低频兜底，替代旧版每秒约 60 次的 rAF URL 比对。
  let routeWatcherId = null;
  let xPost = null;
  let xPostBadge = null;
  const xPostViewFormatter = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });
  const X_POST_LINK = /^https:\/\/(?:(?:www|mobile)\.)?(?:x|twitter)\.com\/(?:[^/]+\/status|i\/web\/status)\/(\d{1,20})(?=[/?#]|$)/i;
  const X_PREVIEW_PANEL = '.pi-tooltip, [data-radix-popper-content-wrapper], .ant-tooltip, .rc-tooltip, [role="tooltip"]';
  const X_PREVIEW_EYE = 'svg[data-icon="IconDisplay16pxRegular"], svg[data-icon*="eye" i], svg[data-icon*="view" i], svg[data-icon*="impression" i], svg.lucide-eye, [aria-label*="views" i], [aria-label*="展现"]';

  function readXPreview(postId) {
    for (const link of document.querySelectorAll(`a[href*="/status/${postId}"]`)) {
      if (!link.closest(X_PREVIEW_PANEL) || link.href.match(X_POST_LINK)?.[1] !== postId ||
          (!link.matches('[data-sentry-component="XPreviewLinkButton"]') &&
           !/read more on (?:x|twitter)|在\s*X\s*上/i.test(link.textContent))) continue;
      for (let panel = link.parentElement, depth = 0; panel && depth < 5; panel = panel.parentElement, depth++) {
        // GMGN places the quoted post before the outer post's timestamp and views.
        const eye = panel.querySelector(X_PREVIEW_EYE);
        if (!eye) continue;
        const metric = eye.getAttribute('aria-label') || eye.nextElementSibling?.textContent ||
          eye.parentElement?.textContent?.trim() ||
          eye.parentElement?.parentElement?.textContent || '';
        const match = metric.trim().match(/^(?:views?\s*:?\s*|展现(?:量)?\s*[:：]?\s*)?([\d,.]+)\s*([KMB万亿])?(?:\s*(?:views?|次))?$/i);
        if (!match) break;
        const multiplier = { K: 1e3, M: 1e6, B: 1e9, 万: 1e4, 亿: 1e8 }[match[2]?.toUpperCase()] || 1;
        const views = Math.round(Number(match[1].replaceAll(',', '')) * multiplier);
        if (Number.isSafeInteger(views)) {
          const linkedIds = new Set();
          for (const anchor of panel.querySelectorAll('a[href]')) {
            const id = anchor.href.match(X_POST_LINK)?.[1];
            if (id && id !== postId) linkedIds.add(id);
          }
          // Some preview text contains a full status URL without a link element.
          for (const url of panel.textContent.match(/https:\/\/[^\s<>"']+/gi) || []) {
            const id = url.replace(/[)\]。，,。！？.!?]+$/, '').match(X_POST_LINK)?.[1];
            if (id && id !== postId) linkedIds.add(id);
          }
          return { views, linkedIds: [...linkedIds] };
        }
        break;
      }
    }
    return null;
  }

  async function loadLinkedXViews(request, linkedIds) {
    for (let index = 0; index < linkedIds.length; index += 4) {
      if (xPost !== request || location.pathname !== request.route) return;
      await Promise.all(linkedIds.slice(index, index + 4).map(async (postId) => {
        const views = await chrome.runtime.sendMessage({
          type: 'DSM_X_POST_VIEWS', postId, readLinkedPost: true
        }).catch(() => null);
        if (xPost !== request || location.pathname !== request.route || !Number.isSafeInteger(views)) return;
        if (views <= (request.linkedViews ?? -1)) return;
        request.linkedViews = views;
        updateXPostBadge();
      }));
    }
  }

  function updateXPostBadge() {
    const route = location.pathname;
    let nameGroup = null;
    let link = null;
    if (settings.dsmEnabled && settings.xPostViewsEnabled && TOKEN_ROUTE_RE.test(route)) {
      if (xPost?.route === route && xPost.nameGroup.isConnected && xPost.link.isConnected) {
        nameGroup = xPost.nameGroup;
        link = xPost.link;
      } else {
        for (const name of document.querySelectorAll('[data-testid="token-detail-symbol"], #token-base-symbol')) {
          const group = name.parentElement?.parentElement;
          const socialRow = group?.parentElement?.nextElementSibling;
          const postLink = socialRow?.querySelector('.g-x-post a[href*="/status/"], a[aria-label="twitter"][href*="/status/"]');
          if (!postLink || !name.getClientRects().length) continue;
          nameGroup = group;
          link = postLink;
          break;
        }
      }
    }
    const postId = link?.href.match(X_POST_LINK)?.[1];
    const samePost = postId && xPost?.route === route && xPost.id === postId;
    const preview = postId ? (samePost ? xPost.preview : null) ?? readXPreview(postId) : null;
    if (!postId) xPost = null;
    else if (!samePost) {
      xPost = { route, id: postId, nameGroup, link, views: null, preview: null, retryAt: 0, retryDelay: 15_000 };
    } else {
      xPost.nameGroup = nameGroup;
      xPost.link = link;
    }

    if (preview && !xPost.preview) {
      xPost.preview = preview;
      if (preview.linkedIds.length) void loadLinkedXViews(xPost, preview.linkedIds);
    }

    if (xPost?.preview === null && document.visibilityState !== 'hidden' && Date.now() >= xPost.retryAt) {
      const request = xPost;
      request.retryAt = Infinity;
      chrome.runtime.sendMessage({ type: 'DSM_X_POST_VIEWS', postId })
        .catch(() => null)
        .then((views) => {
          if (xPost !== request || location.pathname !== route) return;
          request.views = views;
          if (!Number.isSafeInteger(views)) {
            request.retryAt = Date.now() + request.retryDelay;
            request.retryDelay = Math.min(request.retryDelay * 2, 120_000);
          }
          updateXPostBadge();
        });
    }
    const views = Math.max(xPost?.preview?.views ?? xPost?.views ?? -1, xPost?.linkedViews ?? -1);
    const threshold = settings.xPostViewThreshold ?? DEFAULT_SETTINGS.xPostViewThreshold;
    if (!Number.isSafeInteger(views) || views <= threshold) {
      xPostBadge?.remove();
      return;
    }

    if (!xPostBadge) {
      xPostBadge = document.createElement('span');
      xPostBadge.className = 'dsm-x-post-views-badge';
    }
    if (xPostBadge.dataset.views !== String(views)) {
      const label = `X 最高展现量 ${views.toLocaleString('zh-CN')} 次`;
      xPostBadge.dataset.views = String(views);
      xPostBadge.textContent = `X${xPostViewFormatter.format(views)}展现`;
      xPostBadge.title = label;
      xPostBadge.setAttribute('aria-label', label);
    }
    if (nameGroup.nextElementSibling !== xPostBadge) nameGroup.after(xPostBadge);
  }

  const AI_NARRATIVE_FOOTER = /(?:免[责責][声聲]明|disclaimer)\s*[：:]\s*(?=[^。.!?\n]{0,96}(?:人工(?:智能|智慧)\s*生成|AI\s*生成|AI[-\s‑–]generated|generated\s+by\s+(?:AI\b|artificial intelligence)))/i;
  const AI_NARRATIVE_DISCLAIMER = /(?:人工(?:智能|智慧)生成[内內]容|AI\s*生成[内內]容|AI[-\s‑–]generated(?:\s+content)?|generated by (?:AI|artificial intelligence))\s*(?=$|[，,。.;；])/i;
  const AI_NARRATIVE_TOOLTIP = '.narrative-tooltip';
  const AI_NARRATIVE_ICON = '[data-icon="IconNarrative16pxRegular"]';
  const AI_PUMP_LINK = 'a[href^="https://pump.fun/coin/"], a[href^="https://www.pump.fun/coin/"]';
  const narrativeCacheKey = 'dsmAiNarrativeCacheV4';
  const aiNarrativeCache = new Map();
  function mergeNarrativeCache(raw, now) {
    const entries = JSON.parse(raw || '[]');
    if (!Array.isArray(entries)) return;
    for (const [route, entry] of entries.slice(-32)) {
      if (typeof route === 'string' && typeof entry?.summary === 'string' && entry.summary.trim()
          && entry.summary.length <= 2400 && entry.expiresAt > now && entry.expiresAt <= now + 600000
          && !(aiNarrativeCache.get(route)?.expiresAt >= entry.expiresAt)) {
        aiNarrativeCache.delete(route);
        aiNarrativeCache.set(route, entry);
      }
    }
    while (aiNarrativeCache.size > 32) aiNarrativeCache.delete(aiNarrativeCache.keys().next().value);
  }
  try { mergeNarrativeCache(sessionStorage.getItem(narrativeCacheKey), Date.now()); } catch {}

  const aiNarrativeSources = new WeakMap();
  let aiNarrativeVisit = null;
  let lastNarrative = null;

  function readAiNarrativeText(value) {
    const text = (value || '').trim();
    const footer = text.search(AI_NARRATIVE_FOOTER);
    const index = footer >= 0 ? footer : text.search(AI_NARRATIVE_DISCLAIMER);
    if (index < 1) return null;
    const summary = text.slice(0, index).trim();
    if (!summary) return null;

    return summary.slice(0, 2400).replace(/[\uD800-\uDBFF]$/, '');
  }

  function narrativeLabel(node) {
    return readAiNarrativeText(node.getAttribute('title')) || readAiNarrativeText(node.getAttribute('aria-label'));
  }

  function narrativeDescriptions(icon) {
    const ids = icon?.closest('[aria-describedby]')?.getAttribute('aria-describedby');
    return ids?.trim().split(/\s+/).map(id => document.getElementById(id)).filter(Boolean) || [];
  }

  function aiNarrativeIcon(route) {
    const mint = TOKEN_ROUTE_RE.exec(route)?.[1];
    let staleHeader = false;
    for (const name of document.querySelectorAll('[data-testid="token-detail-symbol"], #token-base-symbol')) {
      if (!name.getClientRects().length) continue;
      const group = name.parentElement?.parentElement?.parentElement;
      const header = group?.parentElement;
      const links = header && mint ? Array.from(header.querySelectorAll(AI_PUMP_LINK))
        .filter(link => link.getClientRects().length) : [];
      // SPA navigation may commit the URL before React commits the new token header.
      const headerMints = links.map(link => link.href.split('/coin/')[1]?.split(/[/?#]/)[0]).filter(Boolean);
      const row = group?.nextElementSibling;
      const icon = row && Array.from(row.querySelectorAll(AI_NARRATIVE_ICON))
        .find(candidate => candidate.getClientRects().length);
      if (headerMints.length && !headerMints.includes(mint)) {
        staleHeader = true;
        const oldRoute = route.replace(mint, headerMints[0]);
        for (let node = icon, depth = 0; node && depth < 3; node = node.parentElement, depth++) {
          const summary = narrativeLabel(node);
          if (summary) aiNarrativeSources.set(node, { route: oldRoute, summary });
        }
        for (const panel of [...narrativeDescriptions(icon), ...document.querySelectorAll(AI_NARRATIVE_TOOLTIP)]) {
          const summary = readAiNarrativeText(panel.textContent);
          if (summary) aiNarrativeSources.set(panel, { route: oldRoute, summary });
        }
        continue;
      }
      if (icon?.getClientRects().length) return icon;
    }
    if (staleHeader) return null;
    const visible = Array.from(document.querySelectorAll(AI_NARRATIVE_ICON)).filter(icon => icon.getClientRects().length);
    // The persistent tracker may be the only mounted narrative icon during navigation.
    const tracker = '#MainLayouLeftContanerId';
    if (visible.length <= 1) {
      const icon = visible[0];
      return icon && !icon.closest(tracker) ? icon : null;
    }
    if (!mint) return null;
    // The tracking sidebar can mount its own icons before the detail header
    // gets its symbol marker. Use a visible link for this exact mint.
    const selector = `a[href="https://pump.fun/coin/${mint}"], a[href="https://solscan.io/token/${mint}#metadata"]`;
    for (const link of document.querySelectorAll(selector)) {
      if (!link.getClientRects().length || link.closest(tracker)) continue;
      for (let group = link.parentElement, depth = 0; group && depth < 6; group = group.parentElement, depth++) {
        const nearby = visible.filter(icon => group.contains(icon));
        if (nearby.length === 1 && !nearby[0].closest(tracker)) return nearby[0];
        if (nearby.length > 1) break;
      }
    }
    return null;
  }

  function findAiNarrativeTooltip(route, icon) {
    if (!icon) return null;
    const candidates = new Set(narrativeDescriptions(icon));
    // A header label belongs to the token icon even while an unrelated portal is mounted.
    for (let node = icon, depth = 0; node && depth < 3; node = node.parentElement, depth++) {
      const narrative = narrativeLabel(node);
      if (!narrative || (lastNarrative?.route !== route && lastNarrative?.summary === narrative)) continue;
      const previous = aiNarrativeSources.get(node);
      if (previous && previous.route !== route && previous.summary === narrative) continue;
      aiNarrativeSources.set(node, { route, summary: narrative });
      return narrative;
    }
    const panels = Array.from(document.querySelectorAll(AI_NARRATIVE_TOOLTIP)).filter(panel =>
      panel.getClientRects().length && !panel.closest('[hidden], [aria-hidden="true"]'));
    if (panels.length === 1) candidates.add(panels[0]);
    for (const element of candidates) {
      const narrative = readAiNarrativeText(element.textContent);
      if (!narrative || (lastNarrative?.route !== route && lastNarrative?.summary === narrative)) continue;
      const previous = aiNarrativeSources.get(element);
      if (previous && previous.route !== route && previous.summary === narrative) continue;
      aiNarrativeSources.set(element, { route, summary: narrative });
      return narrative;
    }
    return null;
  }

  function observeAiNarrative(visit) {
    const panel = `${AI_NARRATIVE_TOOLTIP}, ${X_PREVIEW_PANEL}`;
    const selector = `${panel}, ${AI_NARRATIVE_ICON}`;
    const observer = new MutationObserver(records => {
      if (aiNarrativeVisit !== visit || visit.drawingKey || document.visibilityState === 'hidden'
          || location.pathname !== visit.route || visit.scanQueued) return;
      const relevant = records.some(({ type, target, addedNodes }) =>
        (type === 'attributes' && (target.matches(AI_NARRATIVE_ICON) || target.matches(AI_PUMP_LINK) ||
          (visit.requestedIcon && target.contains(visit.requestedIcon)))) ||
        (target.nodeType === 1 ? target : target.parentElement)?.closest(panel) ||
        Array.from(addedNodes).some(node => node.nodeType === 1 && (node.matches(selector) ||
          (node.childElementCount && node.querySelector(selector)))));
      if (!relevant) return;
      visit.scanQueued = true;
      queueMicrotask(() => {
        if (!visit.scanQueued) return;
        visit.scanQueued = false;
        if (aiNarrativeVisit === visit) updateAiNarrative();
      });
    });
    observer.observe(document.body, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['aria-describedby', 'title', 'aria-label', 'data-icon', 'href']
    });
    return observer;
  }

  function stopAiNarrativeCapture(visit) {
    visit.scanQueued = false;
    clearTimeout(visit.headerTimer);
    visit.headerTimer = null;
    visit.observer?.disconnect();
    visit.observer = null;
    releaseAiNarrativeHover(visit);
  }

  function dispatchNarrativeHover(icon, entering) {
    const rect = icon.getBoundingClientRect();
    const point = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    const send = (target, type, bubbles) => {
      const options = { ...point, bubbles, composed: bubbles };
      target.dispatchEvent(type.startsWith('pointer')
        ? new PointerEvent(type, { ...options, pointerId: 1, pointerType: 'mouse', isPrimary: true })
        : new MouseEvent(type, options));
    };
    const path = [icon];
    // Native enter/leave events are delivered independently to the SVG and
    // its wrapper. Dispatching enter only on the SVG skips wrapper listeners.
    for (let parent = icon.parentElement; parent && path.length < 4; parent = parent.parentElement) {
      if (parent === document.body || (path.length > 1 && parent.childElementCount !== 1)) break;
      path.push(parent);
    }
    send(icon, entering ? 'pointerover' : 'pointerout', true);
    send(icon, entering ? 'mouseover' : 'mouseout', true);
    for (const target of entering ? path.reverse() : path) {
      send(target, entering ? 'pointerenter' : 'pointerleave', false);
      send(target, entering ? 'mouseenter' : 'mouseleave', false);
    }
    if (entering) {
      send(icon, 'pointermove', true);
      send(icon, 'mousemove', true);
    }
  }

  function releaseAiNarrativeHover(visit) {
    clearTimeout(visit.probeTimer);
    visit.probeTimer = null;
    clearTimeout(visit.hoverTimer);
    visit.hoverTimer = null;
    const icon = visit.hoverIcon;
    visit.hoverIcon = null;
    if (!icon?.isConnected || icon.matches(':hover')) return;
    dispatchNarrativeHover(icon, false);
  }

  function requestAiNarrative(visit, icon) {
    if (!icon || visit.requestedIcon === icon) return;
    releaseAiNarrativeHover(visit);
    visit.requestedIcon = icon;
    // Native previews can reveal already-mounted text using CSS alone.
    const probeDelays = [80, 240, 640];
    const probe = index => {
      visit.probeTimer = setTimeout(() => {
        visit.probeTimer = null;
        if (aiNarrativeVisit !== visit || visit.route !== location.pathname ||
            document.visibilityState === 'hidden' || visit.requestedIcon !== icon) return;
        updateAiNarrative();
        if (!visit.summary && visit.requestedIcon === icon && index + 1 < probeDelays.length) {
          probe(index + 1);
        }
      }, probeDelays[index]);
    };
    probe(0);
    const retry = () => {
      const delay = visit.retryDelay || 2000;
      visit.retryDelay = Math.min(30000, delay * 2);
      visit.hoverTimer = setTimeout(() => {
        if (aiNarrativeVisit !== visit || location.pathname !== visit.route ||
            document.visibilityState === 'hidden' || visit.drawingKey) return;
        visit.requestedIcon = null;
        updateAiNarrative();
      }, delay);
    };
    if (icon.matches(':hover')) {
      dispatchNarrativeHover(icon, true);
      retry();
      return;
    }
    visit.hoverIcon = icon;
    const openTime = visit.openTime || 4000;
    const checkOpenPreview = allowGrace => {
      if (aiNarrativeVisit !== visit || location.pathname !== visit.route ||
          document.visibilityState === 'hidden' || visit.hoverIcon !== icon) return;
      // A mounted tooltip can become visible through CSS without a DOM mutation.
      updateAiNarrative();
      if (visit.hoverIcon !== icon || visit.summary) return;
      if (allowGrace && Array.from(document.querySelectorAll(AI_NARRATIVE_TOOLTIP)).some(panel =>
        panel.getClientRects().length && !panel.closest('[hidden], [aria-hidden="true"]'))) {
        // Give the mounted native preview time to finish its in-flight request.
        visit.hoverTimer = setTimeout(() => checkOpenPreview(false), 12000);
        return;
      }
      releaseAiNarrativeHover(visit);
      // Closing every attempt at four seconds starves slow native requests.
      visit.openTime = Math.min(32000, openTime * 2);
      retry();
    };
    visit.hoverTimer = setTimeout(() => checkOpenPreview(true), openTime);
    dispatchNarrativeHover(icon, true);
  }

  function logNarrativeDelay(visit, title) {
    const stage = visit.created ? '图表已返回绘制结果' : visit.summary
      ? (visit.drawingKey ? '等待图表返回绘制结果' : '绘制失败或图表尚未接收')
      : (visit.requestedIcon ? '已触发预览，等待可识别正文' : '等待详情页叙事图标');
    const elapsed = Date.now() - visit.startedAt;
    try {
      chrome.runtime.sendMessage({ type: 'DSM_ADD_LOG', category: 'AI 叙事', level: 'warn',
        title, detail: visit.route + ' | ' + elapsed + ' ms | ' + stage }).catch(() => {});
    } catch {}
  }

  window.addEventListener('DSM_NARRATIVE_DRAWING_CREATED', ({ detail }) => {
    const visit = aiNarrativeVisit;
    if (!visit || !detail?.key || visit.drawingKey !== detail.key) return;
    visit.created = true;
    clearTimeout(visit.logTimer);
  });

  function finishAiNarrative(visit) {
    clearTimeout(visit.logTimer);
    if (visit.startedAt != null && !visit.created && !visit.delayLogged && location.pathname !== visit.route) {
      logNarrativeDelay(visit, '切币时标注尚未完成');
    }
    if (visit.summary) lastNarrative = { route: visit.route, summary: visit.summary };
    // GMGN can remount the outgoing tooltip just before it replaces the detail header.
    if (visit.summary && location.pathname !== visit.route) {
      for (const panel of document.querySelectorAll(AI_NARRATIVE_TOOLTIP)) {
        if (readAiNarrativeText(panel.textContent) === visit.summary) {
          aiNarrativeSources.set(panel, { route: visit.route, summary: visit.summary });
        }
      }
    }
    stopAiNarrativeCapture(visit);
    if (visit.drawingKey) {
      window.dispatchEvent(new CustomEvent('DSM_NARRATIVE_DRAWING', {
        detail: { key: visit.drawingKey, remove: true }
      }));
    }
  }

  window.addEventListener('DSM_NARRATIVE_DRAWING_FAILED', ({ detail }) => {
    const visit = aiNarrativeVisit;
    if (!visit?.drawingKey || detail?.key !== visit.drawingKey) return;
    visit.drawingKey = null;
    if (visit.startedAt != null && !visit.failureLogged && location.pathname === visit.route) {
      visit.failureLogged = true;
      logNarrativeDelay(visit, '图表报告标注失败或已丢失');
    }
    visit.created = false;
    visit.retryAt = Date.now();
  });

  function sendChartDrawing(detail) {
    const event = new CustomEvent('DSM_NARRATIVE_DRAWING', { detail, cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  }

  function showAiNarrative(visit, summary) {
    stopAiNarrativeCapture(visit);
    if (summary !== visit.summary) {
      try { mergeNarrativeCache(localStorage.getItem(narrativeCacheKey), Date.now()); } catch {}
      aiNarrativeCache.delete(visit.route);
      aiNarrativeCache.set(visit.route, { summary, expiresAt: Date.now() + 10 * 60_000 });
      if (aiNarrativeCache.size > 32) aiNarrativeCache.delete(aiNarrativeCache.keys().next().value);
      try { localStorage.setItem(narrativeCacheKey, JSON.stringify([...aiNarrativeCache])); } catch {
        try { sessionStorage.setItem(narrativeCacheKey, JSON.stringify([...aiNarrativeCache])); } catch {}
      }
    }
    visit.summary = summary;
    visit.drawingKey = crypto.randomUUID();
    if (!sendChartDrawing({ key: visit.drawingKey, route: visit.route, summary, reportCreation: visit.startedAt != null })) {
      visit.drawingKey = null;
      visit.retryAt = Date.now();
    }
  }

  function updateAiNarrative() {
    const route = location.pathname;
    const enabled = IS_GMGN && settings.dsmEnabled && settings.aiNarrativeEnabled && TOKEN_ROUTE_RE.test(route);
    if (aiNarrativeVisit && (!enabled || aiNarrativeVisit.route !== route)) {
      finishAiNarrative(aiNarrativeVisit);
      aiNarrativeVisit = null;
    }
    if (!enabled || !document.body || document.visibilityState === 'hidden') return;

    const now = Date.now();
    if (!aiNarrativeVisit) {
      for (const legacy of document.querySelectorAll('.dsm-narrative-entry, .dsm-ai-narrative')) legacy.remove();
      const visit = aiNarrativeVisit = { route };
      if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
        visit.startedAt = now;
        visit.logTimer = setTimeout(() => {
          if (aiNarrativeVisit !== visit || visit.created || location.pathname !== route ||
              document.visibilityState === 'hidden') return;
          visit.delayLogged = true;
          logNarrativeDelay(visit, '进入详情页 5 秒后仍未确认绘制');
        }, 5000);
      }
      try { mergeNarrativeCache(localStorage.getItem(narrativeCacheKey), now); } catch {}
      const cached = aiNarrativeCache.get(route);
      if (cached?.expiresAt > now) {
        aiNarrativeVisit.summary = cached.summary;
        showAiNarrative(aiNarrativeVisit, cached.summary);
        return;
      }
    }
    const visit = aiNarrativeVisit;
    if (visit.drawingKey) return;
    if (visit.summary) {
      if (now >= visit.retryAt) showAiNarrative(visit, visit.summary);
      return;
    }
    const icon = aiNarrativeIcon(route);
    if (!visit.observer) visit.observer = observeAiNarrative(visit);
    if (!icon) {
      if (visit.requestedIcon) {
        releaseAiNarrativeHover(visit);
        visit.requestedIcon = null;
      }
      // Responsive layout and in-place header swaps can reveal an icon without adding a node.
      if (visit.headerTimer == null) {
        const delay = visit.headerDelay || 100;
        visit.headerDelay = Math.min(5000, delay * 2);
        visit.headerTimer = setTimeout(() => {
          visit.headerTimer = null;
          if (aiNarrativeVisit === visit && location.pathname === route) updateAiNarrative();
        }, delay);
      }
      return;
    }
    clearTimeout(visit.headerTimer);
    visit.headerTimer = null;
    visit.headerDelay = 0;
    const narrative = findAiNarrativeTooltip(visit.route, icon);
    if (narrative) {
      showAiNarrative(visit, narrative);
    } else {
      requestAiNarrative(visit, icon);
    }
  }

  if (IS_GMGN) window.addEventListener('storage', event => {
    const visit = aiNarrativeVisit;
    if (event.key !== narrativeCacheKey || !visit || visit.summary || visit.route !== location.pathname
        || !settings.dsmEnabled || !settings.aiNarrativeEnabled || document.visibilityState === 'hidden') return;
    try { mergeNarrativeCache(event.newValue, Date.now()); } catch { return; }
    const cached = aiNarrativeCache.get(visit.route);
    if (cached?.expiresAt > Date.now()) {
      visit.summary = cached.summary;
      showAiNarrative(visit, cached.summary);
    }
  });

  if (IS_GMGN) window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      updateAiNarrative();
    } else if (aiNarrativeVisit) {
      stopAiNarrativeCapture(aiNarrativeVisit);
      aiNarrativeVisit.requestedIcon = null;
    }
  }, true);

  let trendNoteDrawing;

  window.addEventListener('DSM_NARRATIVE_DRAWING_FAILED', ({ detail }) => {
    if (!trendNoteDrawing || detail?.key !== trendNoteDrawing.key) return;
    trendNoteDrawing.key = null;
    if (document.visibilityState === 'visible') updateTrendNote();
  });

  function updateTrendNote() {
    const route = location.pathname;
    const summary = settings.dsmEnabled && TOKEN_ROUTE_RE.test(route)
      ? String(settings.trendNote || '').trim().slice(0, 120) : '';
    if (trendNoteDrawing?.route !== route || trendNoteDrawing?.summary !== summary) {
      if (trendNoteDrawing?.key) {
        window.dispatchEvent(new CustomEvent('DSM_NARRATIVE_DRAWING', {
          detail: { kind: 'trend', key: trendNoteDrawing.key, remove: true }
        }));
      }
      trendNoteDrawing = null;
    }
    if (!summary || trendNoteDrawing?.key) return;
    const key = crypto.randomUUID();
    trendNoteDrawing = { route, summary, key };
    if (!sendChartDrawing({ kind: 'trend', route, summary, key })) trendNoteDrawing.key = null;
  }

  function startUrlWatcher() {
    if (routeWatcherId !== null) return;
    let lastPath = null;
    let tokenPage = false;
    routeWatcherId = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      const path = location.pathname;
      if (IS_GMGN && lastPath !== path) {
        lastPath = path;
        tokenPage = TOKEN_ROUTE_RE.test(path);
      }
      if (IS_GMGN && settings.dsmEnabled) {
        if (settings.trendNote && (trendNoteDrawing?.route !== path || !trendNoteDrawing.key) &&
            (tokenPage || trendNoteDrawing)) updateTrendNote();
        if (settings.aiNarrativeEnabled && (tokenPage || aiNarrativeVisit) &&
            (aiNarrativeVisit?.route !== path ||
             (aiNarrativeVisit?.summary && !aiNarrativeVisit.drawingKey))) updateAiNarrative();
        if (settings.xPostViewsEnabled && (tokenPage || xPost || xPostBadge?.isConnected)) updateXPostBadge();
      }
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

    const hasGmgnDetailFeature = IS_GMGN && settings.dsmEnabled && (settings.xPostViewsEnabled || settings.aiNarrativeEnabled || settings.trendNote);
    if (viewed.started || decision.started || hasGmgnDetailFeature) startUrlWatcher();
    else stopUrlWatcher();
  }

  // ============================================================
  // 设置更新与统一开关控制
  // ============================================================
  function applySettingsUpdate(next) {
    const prev = settings;
    settings = next;
    if (IS_GMGN) {
      updateTrendNote();
      updateAiNarrative();
      updateXPostBadge();
    }

    // 总开关变化：按最终开关状态统一启停
    if (prev.dsmEnabled !== next.dsmEnabled) {
      if (!next.dsmEnabled) {
        closeAxiomXPreview();
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

    if (prev.xPostViewsEnabled !== next.xPostViewsEnabled || prev.aiNarrativeEnabled !== next.aiNarrativeEnabled || prev.trendNote !== next.trendNote) refreshTicker();

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
      if (prev.decisionSeconds !== next.decisionSeconds) {
        // 设定秒数变化：补合成新区间片段，下一轮全程零延迟
        prefetchCountdownClips();
        if (decision.decisionRemaining > 0 && !decision.manualConfirmed) {
          startDecisionCycle();
        }
      }
      if (prev.countdownVoiceEnabled !== next.countdownVoiceEnabled) {
        if (next.countdownVoiceEnabled) startCountdownKeepAlive();
        else stopCountdownKeepAlive();
      }
      if ((prev.twitterVoiceName !== next.twitterVoiceName || prev.twitterVoiceRate !== next.twitterVoiceRate)
          && next.countdownVoiceEnabled) {
        // 换音色/语速后预合成新音色的片段，下一轮倒计时即命中缓存
        prefetchCountdownClips();
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

    if (IS_GMGN) {
      updateTrendNote();
      updateAiNarrative();
      updateXPostBadge();
    }
    if (settings.viewedCAEnabled) startViewed();
    if (settings.twitterVoiceEnabled || settings.selectionSearchEnabled) startSocialModule();
    if (settings.decisionEnabled) startDecisionModule();
    refreshTicker();
  }

  // ---------- 初始化 ----------
  // 高亮词必须比 GMGN 的 React 委托更早截获，因此不等待 DOMContentLoaded
  // 或 storage 读取；开关状态仍由 handler 内的 settings 实时判断。
  if (IS_GMGN) installEarlyKeywordInterceptors();

  window.navigation?.addEventListener('currententrychange', syncRoute);
  if (IS_GMGN) {
    window.addEventListener('pageshow', syncRoute);
    if (!window.navigation) window.addEventListener('popstate', syncRoute);
  }

  loadSettings();
})();
