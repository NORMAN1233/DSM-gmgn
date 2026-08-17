(() => {
  'use strict';

  // ============================================================
  // DSM-gmgn 合并版 Content Script
  // 原插件 1：GMGN 已看 CA 标记（jiankongtiao）
  // 原插件 2：GMGN 5秒极速辅助决策（GMGN-5s-Decision / C:\repo 圆形倒计时版）
  // 设计目标：功能可开关、设置持久化、UI 对齐 DataStorm、尽量不拖慢 GMGN 页面。
  // ============================================================

  const SETTINGS_KEY = 'dsmSettings';
  const DEFAULT_SETTINGS = {
    dsmEnabled: true,
    viewedCAEnabled: true,
    decisionEnabled: true,
    batteryEnabled: true,
    decisionSeconds: 5,
    circleSize: 120,
    batteryMinutes: 40,
    restMinutes: 20
  };

  let settings = { ...DEFAULT_SETTINGS };

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
      const data = await chrome.storage.local.get(SETTINGS_KEY);
      settings = { ...DEFAULT_SETTINGS, ...(data[SETTINGS_KEY] || {}) };
    } catch (error) {
      settings = { ...DEFAULT_SETTINGS };
    }
    applyAll();
  }

  function isMasterOn() {
    return !!settings.dsmEnabled;
  }

  // ============================================================
  // 模块一：已看 CA 标记（轻量化，无全页 MutationObserver）
  // ============================================================
  const viewed = {
    started: false,
    STORAGE_KEY: 'gmgnViewedCAs',
    CLEAR_KEY: 'gmgnViewedCAsClearedAt',
    LS_KEY: 'gmgn_viewed_cas',
    CARD_SELECTOR: 'a[data-sentry-component="TrackerListItem"]',
    VIEWED_CLASS: 'gmgn-viewed-ca-card-viewed',
    TOKEN_PATH_RE: /\/(?:sol|eth|base|bsc|ton)\/token\/([^/?#]+)/i,
    TOKEN_HREF_RE: /\/(?:sol|eth|base|bsc|ton)\/token\/([^/?#]+)/i,
    viewedMap: new Map(),
    lastUrl: location.href,
    scanQueued: false,
    intervalId: null,
    styleInjected: false,
    ac: null,
    processedCards: new WeakSet()
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

  function isWalletMonitorPage() {
    if (/\/(?:follow|wallet|monitor|tracker|watch)(?:\/|$)/i.test(location.pathname)) return true;
    return !!document.querySelector(viewed.CARD_SELECTOR);
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

  async function saveViewed() {
    await chrome.storage.local.set({ [viewed.STORAGE_KEY]: Object.fromEntries(viewed.viewedMap) });
  }

  async function loadViewed() {
    try {
      const data = await chrome.storage.local.get([viewed.STORAGE_KEY, viewed.CLEAR_KEY]);
      const storedMap = new Map(Object.entries(data[viewed.STORAGE_KEY] || {}));
      const localMap = readLocalViewed();
      viewed.viewedMap = new Map([...storedMap, ...localMap]);
      const clearedAt = Number(data[viewed.CLEAR_KEY] || 0);
      if (clearedAt) {
        for (const [ca, ts] of viewed.viewedMap) {
          if (Number(ts) < clearedAt) viewed.viewedMap.delete(ca);
        }
      }
      writeLocalViewed();
      saveViewed().catch(() => {});
      scheduleViewedScan();
    } catch (error) {
      console.warn('[DSM-gmgn] 读取已看 CA 失败：', error);
    }
  }

  function markViewed(ca) {
    ca = normalizeCA(ca);
    if (!ca || viewed.viewedMap.has(ca)) return;
    viewed.viewedMap.set(ca, Date.now());
    writeLocalViewed();
    scheduleViewedScan();
    saveViewed().catch((error) => {
      console.warn('[DSM-gmgn] 保存已看 CA 失败：', error);
    });
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
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function hideCardLeftBars(card) {
    const cardRect = card.getBoundingClientRect();
    const elements = card.querySelectorAll('*');
    for (const el of elements) {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.width > 8 || rect.height < 24) continue;
      if (rect.left - cardRect.left > 8) continue;
      if (el.dataset.gmgnPrevDisplay === undefined) {
        el.dataset.gmgnPrevDisplay = el.style.display || '';
      }
      el.style.setProperty('display', 'none', 'important');
    }
  }

  function restoreCardLeftBars(card) {
    const elements = card.querySelectorAll('*');
    for (const el of elements) {
      if (el.dataset && el.dataset.gmgnPrevDisplay !== undefined) {
        el.style.display = el.dataset.gmgnPrevDisplay;
        delete el.dataset.gmgnPrevDisplay;
      }
    }
  }

  function applyToCard(card) {
    const href = card.getAttribute && card.getAttribute('href');
    const ca = getCAFromHref(href);
    if (!ca) return;

    const isViewed = viewed.viewedMap.has(ca);
    card.classList.toggle(viewed.VIEWED_CLASS, isViewed);

    if (isViewed) {
      card.style.setProperty('border-left-color', 'transparent', 'important');
      card.style.setProperty('border-left-width', '0', 'important');
      if (!viewed.processedCards.has(card)) {
        hideCardLeftBars(card);
        viewed.processedCards.add(card);
      }
    } else {
      card.style.removeProperty('border-left-color');
      card.style.removeProperty('border-left-width');
      if (viewed.processedCards.has(card)) {
        restoreCardLeftBars(card);
        viewed.processedCards.delete(card);
      }
    }
  }

  function applyViewedToAll() {
    if (!viewed.started) return;
    document.querySelectorAll('.gmgn-viewed-ca-bar').forEach((el) => el.remove());
    if (!isWalletMonitorPage()) return;

    const cards = document.querySelectorAll(viewed.CARD_SELECTOR);
    for (const card of cards) {
      applyToCard(card);
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
      setTimeout(run, 250);
    }
  }

  viewed.scheduleScan = scheduleViewedScan;

  function handleViewedUrlChange() {
    if (!viewed.started) return;
    const ca = getCurrentTokenCA();
    if (ca) markViewed(ca);

    if (isWalletMonitorPage()) {
      scheduleViewedScan();
    }
  }

  function watchedViewedUrl() {
    if (location.href !== viewed.lastUrl) {
      viewed.lastUrl = location.href;
      handleViewedUrlChange();
    }
  }

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
    loadViewed();
    handleViewedUrlChange();
    watchedViewedUrl();
    patchHistory();

    viewed.ac = new AbortController();
    document.addEventListener('click', handleTokenClick, { capture: true, signal: viewed.ac.signal });
    document.addEventListener('auxclick', handleTokenClick, { capture: true, signal: viewed.ac.signal });
    window.addEventListener('popstate', watchedViewedUrl, { signal: viewed.ac.signal });
    window.addEventListener('hashchange', watchedViewedUrl, { signal: viewed.ac.signal });
    viewed.intervalId = setInterval(watchedViewedUrl, 2000);
  }

  function stopViewed() {
    if (!viewed.started) return;
    viewed.started = false;

    if (viewed.ac) {
      viewed.ac.abort();
      viewed.ac = null;
    }
    if (viewed.intervalId) {
      clearInterval(viewed.intervalId);
      viewed.intervalId = null;
    }
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

    if (changes[SETTINGS_KEY]) {
      applySettingsUpdate({ ...DEFAULT_SETTINGS, ...(changes[SETTINGS_KEY].newValue || {}) });
    }

    if (changes[viewed.STORAGE_KEY]) {
      const next = changes[viewed.STORAGE_KEY].newValue || {};
      viewed.viewedMap = new Map(Object.entries(next));
      if (Object.keys(next).length === 0) {
        clearLocalViewed();
      } else {
        writeLocalViewed();
      }
      if (viewed.started) {
        scheduleViewedScan();
      }
    }
  });

  // ============================================================
  // 模块二：圆形 5 秒决策 + 非阻塞休息提醒
  // ============================================================
  const decision = {
    started: false,
    circle: null,
    circleText: null,
    resizeDot: null,
    restToast: null,
    restToastTimer: null,
    restBtn: null,
    countdownTimer: null,
    restTimer: null,
    currentUrl: location.href,
    currentTokenKey: null,
    inKlinePage: false,
    decisionRemaining: 0,
    manualConfirmed: false,
    batteryEnd: 0,
    restEnd: 0,
    restShown: false,
    intervalId: null,
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

  function createEl(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
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
    settings = { ...settings, ...changed };
    chrome.storage.local.set({ [SETTINGS_KEY]: settings }).catch(() => {});
  }

  // ---------- 圆形倒计时 UI ----------
  function ensureCircle() {
    if (decision.circle) return;

    decision.circle = document.createElement('div');
    decision.circle.id = 'dsm-decision-circle';
    decision.circle.className = 'dsm-circle-red dsm-hidden';
    decision.circle.innerHTML = `
      <span id="dsm-circle-text">${getDecisionSeconds()}</span>
      <span id="dsm-resize-dot" title="拖动调整大小"></span>
    `;
    (document.documentElement || document.body).appendChild(decision.circle);

    decision.circleText = decision.circle.querySelector('#dsm-circle-text');
    decision.resizeDot = decision.circle.querySelector('#dsm-resize-dot');

    applyCircleSize();
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

  function setCircleState(state) {
    if (!decision.circle) return;
    decision.circle.classList.remove('dsm-circle-red', 'dsm-circle-green', 'dsm-circle-yellow');
    decision.circle.classList.add(`dsm-circle-${state}`);
  }

  function showCircle() {
    ensureCircle();
    decision.circle.classList.remove('dsm-hidden');
  }

  function hideCircle() {
    if (decision.circle) decision.circle.classList.add('dsm-hidden');
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
      const maxLeft = Math.max(0, window.innerWidth - decision.circle.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - decision.circle.offsetHeight);
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
    e.preventDefault();
    const delta = e.deltaY < 0 ? 1 : -1;
    const next = Math.min(60, Math.max(1, getDecisionSeconds() + delta));
    settings.decisionSeconds = next;
    if (decision.circleText) decision.circleText.textContent = String(next);
    persistSettings({ decisionSeconds: next });
    if (decision.decisionRemaining > 0 && !decision.manualConfirmed) startDecisionCycle();
  }

  function changeDecisionSeconds(delta) {
    const next = Math.min(60, Math.max(1, getDecisionSeconds() + delta));
    settings.decisionSeconds = next;
    if (decision.circleText) decision.circleText.textContent = String(next);
    persistSettings({ decisionSeconds: next });
    if (decision.decisionRemaining > 0 && !decision.manualConfirmed) startDecisionCycle();
  }

  // ---------- 决策扫描 ----------
  const positiveSignals = [];
  const dangerSignals = [];
  const warnSignals = [];

  function addUniqueSignal(list, text, type) {
    const key = text.toLowerCase().trim();
    if (!list.some((x) => x.key === key)) {
      list.push({ key, text, type });
    }
  }

  function getPageText() {
    try {
      const root = document.querySelector('main') || document.body;
      return (root.innerText || root.textContent || '').replace(/\u00a0/g, ' ').slice(0, 200000);
    } catch (error) {
      return '';
    }
  }

  function analyzePage() {
    const positives = [];
    const dangers = [];
    const warns = [];
    const text = getPageText();
    const lowerText = text.toLowerCase();

    const devSellCn = text.match(/dev[^。\n]{0,50}?(已卖出|卖出|抛售|砸盘|清仓|减持|转出|出售)[^。\n]{0,50}/i);
    if (devSellCn) {
      const pctMatch = devSellCn[0].match(/(\d{1,3}(?:\.\d+)?)%/);
      if (pctMatch) {
        const pct = parseFloat(pctMatch[1]);
        if (pct >= 50) dangers.push('🚨 Dev已卖出 ' + pct + '%');
        else if (pct > 0) warns.push('🔶 Dev卖出 ' + pct + '%');
        else positives.push('✅ Dev卖出 0%');
      } else {
        dangers.push('⚠️ Dev卖出: ' + devSellCn[0].slice(0, 60));
      }
    }

    const devSellEn = lowerText.match(/dev[^.\n]{0,50}?(sell|sold|dumped|dumping|sold all|rug)[^.\n]{0,40}/i);
    if (devSellEn) {
      const enPctMatch = devSellEn[0].match(/(\d{1,3}(?:\.\d+)?)%/);
      if (enPctMatch) {
        const pct = parseFloat(enPctMatch[1]);
        if (pct >= 50) dangers.push('🚨 Dev已卖出 ' + pct + '%');
        else if (pct > 0) warns.push('🔶 Dev卖出 ' + pct + '%');
        else positives.push('✅ Dev卖出 0%');
      } else {
        dangers.push('🚨 Dev抛售: ' + devSellEn[0].slice(0, 60));
      }
    }

    const devHold = text.match(/dev[^。\n]{0,40}?(控盘|持仓|hold|own)[^。\n]{0,40}/i);
    if (devHold) {
      const pct = devHold[0].match(/([5-9][0-9]|100)(\.\d+)?%/i);
      if (pct) dangers.push('🚨 Dev控盘 ' + pct[0]);
      else if (/(全部|heavy|大额|大量|most|all)/i.test(devHold[0])) dangers.push('🚨 Dev疑似重仓: ' + devHold[0].slice(0, 50));
    }

    if (/(honeypot|貔貅|貔|恶意|貔貅盘|不能卖|无法卖出)/i.test(text)) {
      dangers.push('🚨 检测到貔貅/恶意特征');
    }

    const topHolders = text.match(/(top ?10|top ?holders|前10|持有者集中|筹码集中)[^。\n]{0,40}/i);
    if (topHolders) {
      const pct = topHolders[0].match(/([5-9][0-9]|100)(\.\d+)?%/i);
      if (pct) dangers.push('🚨 筹码集中 ' + pct[0]);
    }

    const smartInflow = text.match(/(聪明钱|smart ?money|smartmoney|smart money)[^。\n]{0,40}?(流入|买入|增持|进场|加仓|inflow|buy|increase|accumulate|add position)/i);
    if (smartInflow) positives.push('✅ ' + smartInflow[0].slice(0, 60));

    const topInflow = text.match(/(top ?holders|top ?holder|大户|巨鲸|机构|主力)[^。\n]{0,40}?(增持|买入|加仓|流入|净流入|inflow|buy|increase|accumulate)/i);
    if (topInflow) positives.push('✅ ' + topInflow[0].slice(0, 60));

    const capitalInflow = text.match(/(资金流入|主力流入|净流入|大单买入|主动买入|拉升|突破)/i);
    if (capitalInflow) positives.push('✅ 资金/盘面亮点: ' + capitalInflow[0].slice(0, 60));

    const devSafe = text.match(/dev[^。\n]{0,40}?(未卖出|未抛售|未出售|无卖出|锁仓|不卖|not sold|no sell|holding|lp burned|销毁)/i);
    if (devSafe) positives.push('✅ Dev安全: ' + devSafe[0].slice(0, 60));

    const devPartialSell = text.match(/dev[^。\n]{0,40}?(少量卖出|部分卖出|减持|少量出售|少量抛售)/i);
    if (devPartialSell) {
      const partialPct = devPartialSell[0].match(/(\d{1,3}(?:\.\d+)?)%/);
      if (!partialPct || parseFloat(partialPct[1]) > 0) warns.push('🔶 Dev少量卖出: ' + devPartialSell[0].slice(0, 60));
    }

    const topMid = text.match(/(top ?10|top ?holders|前10|持有者集中|筹码集中)[^。\n]{0,30}?([3-5][0-9])(\.\d+)?%/i);
    if (topMid) warns.push('🔶 筹码集中度 ' + (topMid[0].match(/([3-5][0-9])(\.\d+)?%?/) || [''])[0]);

    return { positives, dangers, warns };
  }

  function scanPageSignals() {
    const result = analyzePage();
    result.positives.forEach((text) => addUniqueSignal(positiveSignals, text, 'positive'));
    result.dangers.forEach((text) => addUniqueSignal(dangerSignals, text, 'danger'));
    result.warns.forEach((text) => addUniqueSignal(warnSignals, text, 'warn'));
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

    positiveSignals.length = 0;
    dangerSignals.length = 0;
    warnSignals.length = 0;
    decision.manualConfirmed = false;

    decision.decisionRemaining = getDecisionSeconds();
    setCircleState('red');
    decision.circleText.textContent = String(decision.decisionRemaining);

    scanPageSignals();

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
    scanPageSignals();

    const hasDanger = dangerSignals.length > 0;
    const hasPositive = positiveSignals.length > 0;

    if (hasDanger || !hasPositive) {
      setCircleState('red');
      decision.circleText.textContent = '✕';
    } else {
      setCircleState('green');
      decision.circleText.textContent = '✓';
    }
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
      if (textEl) textEl.textContent = restRemaining > 0 ? `建议休息 ${formatDuration(restRemaining)}` : '休息时间已到，可继续操作';
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
    decision.intervalId = setInterval(watchUrl, 2000);
    decision.restTimer = setInterval(updateRestTimer, 2000);

    handleLocationChange();
    updateRestTimer();
  }

  function stopDecisionModule() {
    if (!decision.started) return;
    decision.started = false;

    stopDecisionCycle();
    if (decision.restTimer) {
      clearInterval(decision.restTimer);
      decision.restTimer = null;
    }
    if (decision.intervalId) {
      clearInterval(decision.intervalId);
      decision.intervalId = null;
    }
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
      setTimeout(watchUrl, 0);
      return result;
    };
    const wrappedReplace = function (...args) {
      const result = originalReplace.apply(this, args);
      setTimeout(watchUrl, 0);
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
  // 设置更新与统一开关控制
  // ============================================================
  function applySettingsUpdate(next) {
    const prev = settings;
    settings = next;

    // 总开关变化：按最终开关状态统一启停
    if (prev.dsmEnabled !== next.dsmEnabled) {
      if (!next.dsmEnabled) {
        stopViewed();
        stopDecisionModule();
      } else {
        if (next.viewedCAEnabled) startViewed();
        if (next.decisionEnabled) startDecisionModule();
      }
      return;
    }

    // 已看 CA 独立开关：不影响决策圆球
    if (prev.viewedCAEnabled !== next.viewedCAEnabled) {
      if (next.dsmEnabled && next.viewedCAEnabled) {
        startViewed();
      } else {
        stopViewed();
      }
    }

    // 决策模块独立开关：不影响已看 CA
    if (prev.decisionEnabled !== next.decisionEnabled) {
      if (next.dsmEnabled && next.decisionEnabled) {
        startDecisionModule();
      } else {
        stopDecisionModule();
      }
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
    stopDecisionModule();

    if (!isMasterOn()) return;

    if (settings.viewedCAEnabled) startViewed();
    if (settings.decisionEnabled) startDecisionModule();
  }

  // ---------- 初始化 ----------
  function init() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', loadSettings, { once: true });
      return;
    }
    loadSettings();
  }

  init();
})();





