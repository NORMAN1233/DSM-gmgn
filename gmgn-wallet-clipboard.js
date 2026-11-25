(() => {
  'use strict';

  const SETTING_KEY = 'dsmSetting_officialWalletCopyEnabled';
  const MASTER_KEY = 'dsmSetting_dsmEnabled';

  // GMGN 官方钱包追踪行的真实 DOM 标记（TrackerListItem.tsx）。
  const TRACKER_ROW_SELECTOR = [
    'a[data-sentry-component="TrackerListItem"][href]',
    'a[data-sentry-source-file="TrackerListItem.tsx"][href]'
  ].join(',');
  const TRACKER_SYMBOL_SELECTOR = '[data-testid="follow-tracking-row-symbol"]';
  const TOKEN_ROUTE_RE = /\/(?:token|pump|meme|coin|pair|pool)\/([^/?#]+)/i;
  const CA_RE = /^(?:0x[a-fA-F0-9]{40,128}|[1-9A-HJ-NP-Za-km-z]{32,44}|[EU]Q[A-Za-z0-9_-]{46})$/;


  let enabled = true;
  let masterEnabled = true;
  let settingsReady = false;
  const changedSettings = new Set();

  function isGMGNPage() {
    return /(^|\.)gmgn\.ai$/i.test(location.hostname || '');
  }

  function normalizeCA(value) {
    const ca = String(value || '').trim().replace(/[。；，,;\])}>'"`]+$/g, '');
    if (!CA_RE.test(ca)) return '';
    return /^0x/i.test(ca) ? ca.toLowerCase() : ca;
  }

  function caFromRow(row) {
    return caFromHref(row?.getAttribute?.('href'));
  }

  function caFromHref(value) {
    const href = String(value || '');
    const match = href.match(TOKEN_ROUTE_RE);
    if (!match) return '';
    try { return normalizeCA(decodeURIComponent(match[1])); } catch (error) { return normalizeCA(match[1]); }
  }

  function rowFromNode(node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    if (!element) return null;
    const direct = element.matches?.(TRACKER_ROW_SELECTOR)
      ? element
      : element.closest?.(TRACKER_ROW_SELECTOR);
    if (direct && caFromRow(direct)) return direct;

    const symbol = element.closest?.(TRACKER_SYMBOL_SELECTOR);
    const fallback = symbol?.closest?.('a[href]') || element.closest?.('a[href]');
    if (!symbol && !fallback?.querySelector?.(TRACKER_SYMBOL_SELECTOR)) return null;
    return fallback && caFromRow(fallback) ? fallback : null;
  }

  function currentVisibleNotification() {
    const candidates = document.querySelectorAll(`${TRACKER_ROW_SELECTOR},${TRACKER_SYMBOL_SELECTOR}`);
    const seen = new Set();
    let best = null;
    for (const node of candidates) {
      const row = rowFromNode(node);
      if (!row || seen.has(row) || !row.isConnected) continue;
      seen.add(row);
      const rect = row.getBoundingClientRect();
      let top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
      let left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
      if (rect.width <= 0 || rect.height <= 0 || bottom <= top || right <= left) continue;
      // Ancestor clipping can only move the visible top edge down.
      if (best && top >= best.top) continue;
      const ca = caFromRow(row);
      let url;
      try { url = new URL(row.href); } catch { continue; }
      if (!ca || url.protocol !== 'https:' || !/(^|\.)gmgn\.ai$/i.test(url.hostname)) continue;
      if (row.checkVisibility && !row.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      let hidden = false;
      for (let parent = row; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (parent.hidden || parent.getAttribute('aria-hidden') === 'true'
            || style.display === 'none' || style.visibility === 'hidden'
            || style.visibility === 'collapse' || style.opacity === '0') { hidden = true; break; }
        if (parent === row) continue;
        const clipsY = /^(auto|scroll|hidden|clip)$/.test(style.overflowY);
        const clipsX = /^(auto|scroll|hidden|clip)$/.test(style.overflowX);
        if (clipsY || clipsX) {
          const bounds = parent.getBoundingClientRect();
          if (clipsY) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
          if (clipsX) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
        }
      }
      if (hidden || bottom <= top || right <= left) continue;
      if (top === 0) return { row, ca, top };
      if (!best || top < best.top) best = { row, ca, top };
    }
    return best;
  }

  function clickLatestNotification() {
    if (!isGMGNPage() || !settingsReady || !masterEnabled || !enabled) {
      return { ok: false, reason: '请先开启插件和钱包快捷跳转' };
    }
    // Resolve and click in the same key event, without waiting for observers or a worker.
    const target = currentVisibleNotification();
    if (!target) return { ok: false, reason: '当前没有可见的钱包通知，请展开钱包监控' };
    const { row, ca } = target;
    try {
      row.click();
      const notice = document.getElementById('dsm-wallet-click-status');
      if (notice) { clearTimeout(notice.hideTimer); notice.remove(); }
      return { ok: true, ca };
    } catch {
      return { ok: false, reason: '钱包通知点击失败，请重试' };
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'DSM_WALLET_CLICK_LATEST') sendResponse(clickLatestNotification());
  });

  function isEditing(element) {
    return !!(element?.isContentEditable || element?.closest?.(
      'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"]'
    ));
  }

  let opening = false;
  window.addEventListener('keydown', (event) => {
    if (!isGMGNPage() || !settingsReady || !enabled || !masterEnabled || opening
        || event.code !== 'KeyC' || event.repeat || event.isComposing || event.keyCode === 229
        || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
        || event.composedPath().some(isEditing) || isEditing(document.activeElement)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    opening = true;
    // Stay in the physical key event so GMGN's own click handler runs immediately.
    try {
      const result = clickLatestNotification();
      if (!result.ok) {
        let notice = document.getElementById('dsm-wallet-click-status');
        if (!notice) {
          notice = document.createElement('div');
          notice.id = 'dsm-wallet-click-status';
          notice.setAttribute('role', 'status');
          notice.style.cssText = 'position:fixed;top:24%;left:50%;transform:translateX(-50%);z-index:2147483647;padding:16px 24px;border-radius:10px;background:#b93434;color:white;font:16px system-ui;pointer-events:none';
          document.body.appendChild(notice);
        }
        notice.textContent = result.reason;
        clearTimeout(notice.hideTimer);
        notice.hideTimer = setTimeout(() => notice.remove(), 3000);
      }
    } finally { opening = false; }
  }, true);

  chrome.storage.local.get([MASTER_KEY, SETTING_KEY, 'dsmSettings']).then((data) => {
    if (!changedSettings.has(MASTER_KEY)) masterEnabled = (data[MASTER_KEY] ?? data.dsmSettings?.dsmEnabled) !== false;
    if (!changedSettings.has(SETTING_KEY)) enabled = (data[SETTING_KEY] ?? data.dsmSettings?.officialWalletCopyEnabled) !== false;
  }).catch(() => {}).finally(() => {
    settingsReady = true;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const key of [MASTER_KEY, SETTING_KEY]) if (changes[key]) changedSettings.add(key);
    if (changes[MASTER_KEY]) masterEnabled = changes[MASTER_KEY].newValue !== false;
    if (changes[SETTING_KEY]) enabled = changes[SETTING_KEY].newValue !== false;
    if (!enabled || !masterEnabled) {
      const notice = document.getElementById('dsm-wallet-click-status');
      if (notice) { clearTimeout(notice.hideTimer); notice.remove(); }
    }
  });
})();
