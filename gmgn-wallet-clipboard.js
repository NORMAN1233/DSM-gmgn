(() => {
  'use strict';

  if (!/(^|\.)gmgn\.ai$/i.test(location.hostname)) return;
  const SETTING_KEY = 'dsmSetting_officialWalletCopyEnabled';
  const MASTER_KEY = 'dsmSetting_dsmEnabled';
  const ROW_SELECTOR = 'a[data-sentry-component="TrackerListItem"],a[data-sentry-source-file="TrackerListItem.tsx"]';
  const SYMBOL_SELECTOR = '[data-testid="follow-tracking-row-symbol"]';
  const CA_RE = /^(?:0x[a-fA-F0-9]{40,128}|[1-9A-HJ-NP-Za-km-z]{32,44}|[EU]Q[A-Za-z0-9_-]{46})$/;
  const streamId = 'wallet-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  let enabled = true, masterEnabled = true, settingsReady = false;
  let observer = null, head = null, href = location.href;
  let sequence = 0, pending = null;
  let browsingHistory = false;
  const known = new Map();

  function rowFromNode(node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    if (!element) return null;
    const row = element.closest?.(ROW_SELECTOR);
    if (row) return row;
    const anchor = element.closest?.('a[href]');
    return anchor?.querySelector(SYMBOL_SELECTOR) ? anchor : null;
  }

  function rowsIn(root) {
    const rows = new Set(root.querySelectorAll(ROW_SELECTOR));
    for (const symbol of root.querySelectorAll(SYMBOL_SELECTOR)) {
      const row = symbol.closest(ROW_SELECTOR) || symbol.closest('a[href]');
      if (row) rows.add(row);
    }
    return [...rows].filter((row) => row.isConnected && row.getClientRects().length && getComputedStyle(row).visibility !== 'hidden')
      .sort((a, b) => a === b ? 0 : (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  }

  function snapshot(row) {
    const link = row.getAttribute('href') || '';
    const route = link.match(/\/(?:token|pump|meme|coin|pair|pool)\/([^/?#]+)/i);
    let ca = '';
    try { ca = decodeURIComponent(route?.[1] || ''); } catch (error) {}
    if (!CA_RE.test(ca)) return null;
    if (/^0x/i.test(ca)) ca = ca.toLowerCase();
    const text = (name) => String(row.querySelector('[data-testid="follow-tracking-row-' + name + '"]')?.textContent || '').replace(/\s+/g, ' ').trim();
    const maker = row.querySelector('[data-testid="follow-tracking-row-maker"] a[href]')?.getAttribute('href') || text('maker');
    // Supplied transaction fields exclude live age/MC/price badges.
    const key = [link, maker, text('side'), text('amount')].join('|');
    const header = [...row.children].find((child) => child.tagName === 'DIV');
    const ageMatch = (header?.lastElementChild?.textContent || '').trim().match(/^(\d+(?:\.\d+)?)(s|m|h|d)$/i);
    const unit = ageMatch ? ({ s: 1, m: 60, h: 3600, d: 86400 })[ageMatch[2].toLowerCase()] : 1;
    return { node: row, key, ca, age: ageMatch ? Number(ageMatch[1]) * unit : null, unit, at: Date.now() };
  }

  function atTop(row) {
    for (let node = row.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY + ' ' + style.overflow)) return node.scrollTop <= 1;
    }
    return true;
  }

  function remember(items) {
    for (const item of items) if (item) {
      known.delete(item.key);
      known.set(item.key, item);
    }
    while (known.size > 1500) known.delete(known.keys().next().value);
  }

  function cancelPending() {
    if (!pending) return;
    pending = null;
    sequence++;
    try { chrome.runtime.sendMessage({ type: 'DSM_WALLET_COPY_CANCEL', streamId, sequence }).catch(() => {}); } catch (error) {}
  }

  async function copyLatest(target) {
    if (!settingsReady || !enabled || !masterEnabled || pending !== target) return;
    let result = { ok: false };
    for (let attempt = 0; attempt < 3 && pending === target; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 40));
      if (pending !== target || !enabled || !masterEnabled) return;
      let timer;
      try {
        result = await Promise.race([
          chrome.runtime.sendMessage({ type: 'DSM_WALLET_COPY_CA', ca: target.ca, streamId, sequence: target.sequence,
            requestId: streamId + '-' + target.sequence + '-' + attempt, deadline: Date.now() + 1500 }),
          new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, reason: 'clipboard-timeout' }), 2000); })
        ]);
      } catch (error) { result = { ok: false, reason: String(error?.message || error) }; }
      finally { clearTimeout(timer); }
      if (pending !== target) return;
      if (result?.ok || /timeout|superseded|disabled/.test(result?.reason || '')) break;
    }
    if (pending === target) {
      window.dispatchEvent(new CustomEvent('dsm-gmgn-wallet-ca-copied', { detail: { ca: target.ca, copied: result?.ok === true, reason: result?.reason || '' } }));
    }
  }

  function refresh(baseline = false) {
    const rows = rowsIn(document);
    const items = rows.map(snapshot);
    const current = items[0] || null; // Do not substitute the second row for an unfinished first row.
    const previous = head;
    const old = current && known.get(current.key);
    const stillSameFeed = !previous || items.some((item) => item && known.has(item.key)) || previous.node === current?.node;
    const resetAge = old && old.age !== null && current.age !== null && current.age + current.unit < old.age;
    const newPrepend = current && previous && current.node !== old?.node && rows.indexOf(previous.node) > 0;
    const changed = current && (!previous || current.ca !== previous.ca || (current.node !== previous.node && current.key !== previous.key) || resetAge || newPrepend);
    const accept = !baseline && href === location.href && document.readyState !== 'loading' && current && atTop(current.node) && stillSameFeed && changed && (!old || resetAge || newPrepend);
    href = location.href;
    head = current;
    remember(items);
    if (baseline || !current || !atTop(current.node) || (changed && !accept)) cancelPending();
    if (!accept) return;
    pending = { ...current, sequence: ++sequence };
    // A new visible head immediately replaces older pending work; no history FIFO.
    copyLatest(pending).catch(() => {});
  }

  function start() {
    if (!enabled || !masterEnabled || observer) return;
    refresh(true);
    observer = new MutationObserver((mutations) => {
      const relevant = mutations.some((mutation) => rowFromNode(mutation.target) ||
        [...mutation.addedNodes, ...mutation.removedNodes].some((node) => rowFromNode(node) || node.querySelector?.(ROW_SELECTOR + ',' + SYMBOL_SELECTOR)));
      if (relevant) refresh();
    });
    observer.observe(document, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['href', 'data-testid', 'data-sentry-component', 'data-sentry-source-file'] });
  }

  function stop() {
    observer?.disconnect();
    observer = null;
    cancelPending();
  }

  // Browsing older rows is not a new alert, including virtualized lists.
  document.addEventListener('scroll', (event) => {
    if (!observer || !head || !event.target?.contains?.(head.node)) return;
    const away = !atTop(head.node);
    if (away || browsingHistory) refresh(true);
    browsingHistory = away;
  }, true);
  window.addEventListener('popstate', () => { if (observer) refresh(true); });
  window.addEventListener('pagehide', stop);
  window.addEventListener('pageshow', (event) => { if (event.persisted) start(); });
  start();
  chrome.storage.local.get([MASTER_KEY, SETTING_KEY, 'dsmSettings']).then((data) => {
    masterEnabled = (data[MASTER_KEY] ?? data.dsmSettings?.dsmEnabled) !== false;
    enabled = (data[SETTING_KEY] ?? data.dsmSettings?.officialWalletCopyEnabled) !== false;
    settingsReady = true;
    if (enabled && masterEnabled) {
      start();
      chrome.runtime.sendMessage({ type: 'DSM_WALLET_COPY_PREPARE' }).catch(() => {});
      if (pending) copyLatest(pending).catch(() => {});
    } else stop();
  }).catch(() => { settingsReady = true; if (pending) copyLatest(pending).catch(() => {}); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || (!changes[MASTER_KEY] && !changes[SETTING_KEY])) return;
    if (changes[MASTER_KEY]) masterEnabled = changes[MASTER_KEY].newValue !== false;
    if (changes[SETTING_KEY]) enabled = changes[SETTING_KEY].newValue !== false;
    if (enabled && masterEnabled) start(); else stop();
  });
})();
