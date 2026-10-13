(() => {
  'use strict';

  if (!/^(?:[a-z0-9-]+\.)*gmgn\.ai$/i.test(location.hostname)) return;

  const SETTINGS_KEY = 'dsmSettings';
  const MASTER_SETTING_KEY = 'dsmSetting_dsmEnabled';
  const DEV_SETTING_KEY = 'dsmSetting_devArkmEnabled';
  const settings = { dsmEnabled: true, devArkmEnabled: false };
  let settingsLoaded = false;
  let settingsLoadFailed = false;
  let pendingDevClick = null;

  const cleanText = (value) => String(value || '').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  const normalizeCA = (value) => {
    const ca = String(value || '').trim();
    return /^0x/i.test(ca) ? ca.toLowerCase() : ca;
  };
  const TOKEN_CA_SOURCE = '(?:0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})';
  function getCurrentTokenCA() {
    const route = `${location.pathname}${location.hash}`;
    const match = route.match(new RegExp(`/(?:token|pump|t|meme|trade)/(${TOKEN_CA_SOURCE})(?=/|$|[?#])`, 'i')) ||
      route.match(new RegExp(`/(?:sol|eth|base|bsc|ton|sui|btc|trx|tron)/(${TOKEN_CA_SOURCE})(?=/|$|[?#])`, 'i'));
    if (match) return normalizeCA(match[1]);
    for (const key of ['address', 'ca', 'mint', 'token']) {
      const candidate = String(new URL(location.href).searchParams.get(key) || '').trim();
      if (new RegExp(`^${TOKEN_CA_SOURCE}$`, 'i').test(candidate)) return normalizeCA(candidate);
    }
    return '';
  }
  const isMasterOn = () => !!settings.dsmEnabled;
  const isVisibleElement = (element) => {
    if (!element?.isConnected) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 20 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0;
  };
  function nodeElement(node) {
    if (!node) return null;
    return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  }
  function showSelectionRouteToast(text, ok = true, prominent = false) {
    let toast = document.getElementById('dsm-selection-route-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'dsm-selection-route-toast';
      Object.assign(toast.style, {
        position: 'fixed', zIndex: '2147483647', left: '50%', top: '12px', transform: 'translateX(-50%)',
        maxWidth: '88vw', padding: '7px 11px', borderRadius: '7px', fontSize: '12px', lineHeight: '16px',
        fontFamily: 'system-ui, sans-serif', color: '#fff', boxShadow: '0 4px 18px rgba(0,0,0,.28)',
        pointerEvents: 'none', transition: 'opacity .18s ease', opacity: '0'
      });
      document.documentElement.appendChild(toast);
    }
    toast.textContent = text;
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    Object.assign(toast.style, {
      top: prominent ? '24%' : '12px', padding: prominent ? '22px 32px' : '7px 11px',
      fontSize: prominent ? '22px' : '12px', lineHeight: prominent ? '32px' : '16px', fontWeight: prominent ? '700' : '400'
    });
    toast.style.background = ok ? 'rgba(35, 126, 74, .94)' : 'rgba(185, 52, 52, .94)';
    toast.style.opacity = '1';
    clearTimeout(toast._dsmHideTimer);
    toast._dsmHideTimer = setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => { if (toast.style.opacity === '0') toast.remove(); }, 220);
    }, 2500);
  }
  async function loadSettings() {
    try {
      const data = await chrome.storage.local.get([SETTINGS_KEY, MASTER_SETTING_KEY, DEV_SETTING_KEY]);
      settings.dsmEnabled = data[MASTER_SETTING_KEY] ?? data[SETTINGS_KEY]?.dsmEnabled ?? true;
      settings.devArkmEnabled = data[DEV_SETTING_KEY] ?? data[SETTINGS_KEY]?.devArkmEnabled ?? false;
    } catch (error) {
      settingsLoadFailed = true;
    }
    settingsLoaded = true;
    const pending = pendingDevClick;
    pendingDevClick = null;
    if (!pending || pending.href !== location.href) return;
    if (settingsLoadFailed) {
      showSelectionRouteToast('插件设置读取失败，请重新加载扩展和 GMGN 页面', false, true);
    } else if (!isMasterOn() || !settings.devArkmEnabled) {
      showSelectionRouteToast('Dev ARKM 查询开关当前处于关闭状态', false, true);
    } else if (pending.badge.isConnected) {
      lookupDevBadge(pending.badge);
    } else {
      showSelectionRouteToast('已识别 Dev 标记，但 GMGN 页面已更新，请再次点击', false, true);
    }
  }
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[MASTER_SETTING_KEY]) settings.dsmEnabled = changes[MASTER_SETTING_KEY].newValue;
      if (changes[DEV_SETTING_KEY]) settings.devArkmEnabled = changes[DEV_SETTING_KEY].newValue;
      if (changes[SETTINGS_KEY]?.newValue) {
        const legacy = changes[SETTINGS_KEY].newValue;
        if (!changes[MASTER_SETTING_KEY]) settings.dsmEnabled = legacy.dsmEnabled ?? settings.dsmEnabled;
        if (!changes[DEV_SETTING_KEY]) settings.devArkmEnabled = legacy.devArkmEnabled ?? settings.devArkmEnabled;
      }
    });
  } catch (error) {}
  const DEV_ICON_SELECTOR = '[data-icon="IconDev16pxRegular"], [data-sentry-element="IconDev16pxRegular"]';
  const DEV_ADDRESS_FIELD_SELECTOR = '[title], [aria-label], [data-address], [data-wallet-address], [data-copy], [data-copy-value], [data-clipboard], [data-clipboard-text], [data-value], a[href], input, textarea';
  const DEV_ADDRESS_RE = /0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}/g;
  const DEV_ADDRESS_DETECT_RE = /0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}/;
  const hasDevWalletLabel = (value) => {
    const text = cleanText(value).replace(/\s+/g, ' ').trim();
    if (!text || text.length > 100) return false;
    return /(?:^|[^a-z0-9])dev(?:$|[^a-z0-9])/i.test(text) || /dev钱包/i.test(text) || /^devwallet$/i.test(text);
  };
  let cancelDevAddressWait = null;
  let devLookupSequence = 0;
  let devQueryInFlightAddress = '';
  let queuedDevArkhamQuery = null;

  function addressElementsInDevRow(root) {
    const addresses = new Map();
    const visibilityCache = new WeakMap();
    const add = (value, element) => {
      const matches = [...String(value || '').matchAll(DEV_ADDRESS_RE)];
      if (!matches.length || !element) return;
      if (!visibilityCache.has(element)) visibilityCache.set(element, isVisibleElement(element));
      if (!visibilityCache.get(element)) return;
      for (const match of matches) {
        if (!addresses.has(match[0])) addresses.set(match[0], element);
      }
    };
    const textWalker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (textWalker.nextNode()) add(textWalker.currentNode.nodeValue, textWalker.currentNode.parentElement);
    const fields = root.matches?.(DEV_ADDRESS_FIELD_SELECTOR)
      ? [root, ...root.querySelectorAll(DEV_ADDRESS_FIELD_SELECTOR)]
      : [...root.querySelectorAll(DEV_ADDRESS_FIELD_SELECTOR)];
    for (const field of fields) {
      for (const attribute of field.attributes || []) {
        if (attribute.name === 'title' || attribute.name === 'aria-label' || attribute.name === 'href' ||
            attribute.name.startsWith('data-')) add(attribute.value, field);
      }
      if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) add(field.value, field);
    }
    return addresses;
  }

  function findDevPopupAddress(referenceElement, mode = 'popup', currentCA = getCurrentTokenCA()) {
    const isDevWalletLabel = (element) => hasDevWalletLabel(element.textContent);
    const isSidebarRoot = (element) => {
      if (element.matches?.('aside') || /sidebar|side.?panel|drawer/i.test(String(element.getAttribute?.('class') || ''))) return true;
      const rect = element.getBoundingClientRect();
      return rect.width >= 180 && rect.width < window.innerWidth * 0.72 &&
        rect.height > window.innerHeight * 0.35 && rect.left > window.innerWidth * 0.25 &&
        rect.right > window.innerWidth * 0.72;
    };
    const isInsideSidebar = (label) => {
      for (let element = label.parentElement, depth = 0; element && depth < 10; depth++, element = element.parentElement) {
        if (isSidebarRoot(element)) return true;
      }
      return false;
    };
    const labels = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (!String(walker.currentNode.nodeValue || '').toLowerCase().includes('dev')) continue;
      for (let element = walker.currentNode.parentElement, depth = 0; element && depth < 3; depth++, element = element.parentElement) {
        if (isDevWalletLabel(element)) {
          if (isVisibleElement(element)) labels.add(element);
          break;
        }
      }
    }
    const orderedLabels = [...labels]
      .sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height -
        b.getBoundingClientRect().width * b.getBoundingClientRect().height);
    const referenceRect = referenceElement?.getBoundingClientRect();
    const popupLabels = mode === 'popup'
      ? orderedLabels.map((label) => {
          if (!referenceRect || isInsideSidebar(label)) return null;
          const rect = label.getBoundingClientRect();
          const distance = Math.hypot(rect.x + rect.width / 2 - (referenceRect.x + referenceRect.width / 2),
            rect.y + rect.height / 2 - (referenceRect.y + referenceRect.height / 2));
          return distance <= 480 ? { label, distance } : null;
        }).filter(Boolean)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 10)
        .map(({ label }) => label)
      : orderedLabels;
    const addressDistances = new Map();
    const rowAddressCache = new WeakMap();
    const addressesForRow = (row) => {
      if (!rowAddressCache.has(row)) rowAddressCache.set(row, addressElementsInDevRow(row));
      return rowAddressCache.get(row);
    };
    for (const label of popupLabels) {
      let row = label;
      // The Dev metric and the wallet row are not always siblings: GMGN can
      // render a memo (for example "e/acc") in its own row while the popup's
      // Dev heading is several wrappers above it. Walk only this nearby Dev
      // popup, and accept the address only when the smallest scope has one
      // non-token wallet address. The memo text itself is not a requirement.
      for (let depth = 0; row && depth < 9; depth++, row = row.parentElement) {
        const rowRect = row.getBoundingClientRect();
        if (depth > 0 && (rowRect.width > window.innerWidth * 0.75 || rowRect.height > window.innerHeight * 0.75)) break;
        const addresses = addressesForRow(row);
        if (!addresses.size) continue;
        const usable = [...addresses.keys()].filter((address) => normalizeCA(address) !== currentCA);
        // Stop at the smallest row exposing any complete address. Climbing past a
        // token-only row could accidentally capture an unrelated wallet nearby.
        if (usable.length !== 1) break;
        const address = usable[0];
        const labelRect = label.getBoundingClientRect();
        const distance = referenceRect
          ? Math.hypot(labelRect.x + labelRect.width / 2 - (referenceRect.x + referenceRect.width / 2),
              labelRect.y + labelRect.height / 2 - (referenceRect.y + referenceRect.height / 2))
          : 0;
        addressDistances.set(address, Math.min(addressDistances.get(address) ?? Infinity, distance));
        break;
      }
    }
    if (!addressDistances.size && mode === 'sidebar') {
      for (const label of orderedLabels) {
        let sidebar = null;
        for (let element = label.parentElement, depth = 0; element && depth < 10; depth++, element = element.parentElement) {
          if (isSidebarRoot(element)) { sidebar = element; break; }
        }
        if (!sidebar) continue;

        const labelRect = label.getBoundingClientRect();
        const labelX = labelRect.left + labelRect.width / 2;
        const labelY = labelRect.top + labelRect.height / 2;
        const candidates = [...addressesForRow(sidebar)]
          .filter(([address]) => normalizeCA(address) !== currentCA)
          .map(([address, element]) => {
            const rect = element.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            return { address, dx: Math.abs(x - labelX), dy: Math.abs(y - labelY) };
          })
          .filter((candidate) => candidate.dy <= Math.max(32, labelRect.height * 2))
          .sort((a, b) => a.dx - b.dx);
        if (candidates.length === 1 ||
            (candidates.length > 1 && candidates[1].dx - candidates[0].dx >= 24)) {
          addressDistances.set(candidates[0].address, candidates[0].dx);
        }
      }
    }
    if (!addressDistances.size && mode === 'sidebar') {
      const addressElements = addressesForRow(document.body);
      const panelAddresses = [];
      for (const [address, element] of addressElements) {
        if (normalizeCA(address) === currentCA) continue;
        const addressRect = element.getBoundingClientRect();
        if (addressRect.left < window.innerWidth * 0.42) continue;
        for (let panel = element.parentElement, depth = 0; panel && depth < 12; depth++, panel = panel.parentElement) {
          const rect = panel.getBoundingClientRect();
          const isRightPanel = rect.width >= 220 && rect.width < window.innerWidth * 0.72 &&
            rect.height > window.innerHeight * 0.35 && rect.left > window.innerWidth * 0.25 &&
            rect.right > window.innerWidth * 0.72;
          if (!isRightPanel) continue;
          panelAddresses.push({ address, y: addressRect.top, panelTop: rect.top, panelHeight: rect.height });
          break;
        }
      }
      panelAddresses.sort((a, b) => (a.y - a.panelTop) / a.panelHeight - (b.y - b.panelTop) / b.panelHeight);
      if (panelAddresses.length) {
        const first = panelAddresses[0];
        addressDistances.set(first.address, Math.max(0, first.y - first.panelTop));
      }
    }
    const address = [...addressDistances].sort((a, b) => a[1] - b[1])[0]?.[0] || '';
    return {
      found: (mode === 'popup' ? popupLabels : orderedLabels).length > 0 || !!address,
      address
    };
  }

  function queryDevOnArkham(address, sequence, tokenCA = getCurrentTokenCA()) {
    if (devQueryInFlightAddress) {
      // A deliberate second click is a new request even when it targets the
      // same wallet. Keep the latest click queued while Arkham handles the
      // current request instead of silently dropping it.
      queuedDevArkhamQuery = { address, sequence, tokenCA };
      showSelectionRouteToast(`已读取 Dev：${address}，当前查询完成后再次查询…`);
      return;
    }
    devQueryInFlightAddress = address;
    showSelectionRouteToast(`识别到 Dev：${address}，正在查询 ARKM…`);
    let timeoutId;
    const responseTimeout = new Promise((resolve) => {
      timeoutId = setTimeout(() => resolve({
        ok: false, reason: 'ARKM 响应超时，未确认查询完成；请检查 Arkham 标签页后重试'
      }), 15000);
    });
    let request;
    try {
      request = chrome.runtime.sendMessage({
        type: 'DSM_DEV_ARKM_SEARCH', address, tokenCA
      });
    } catch (error) {
      // Reloading the extension invalidates content scripts already running in
      // open tabs. Do not let the synchronous runtime error escape a DOM event.
      clearTimeout(timeoutId);
      if (devQueryInFlightAddress === address) devQueryInFlightAddress = '';
      queuedDevArkhamQuery = null;
      if (sequence === devLookupSequence) {
        showSelectionRouteToast('扩展已重载，请刷新 GMGN 标签页后重试', false, true);
      }
      return;
    }
    Promise.race([
      request,
      responseTimeout
    ]).then((result) => {
      if (sequence !== devLookupSequence) return;
      showSelectionRouteToast(result?.ok ? `ARKM 已确认显示 Dev 地址：${address}` : (result?.reason || 'ARKM 查询失败'), !!result?.ok, !result?.ok);
    }).catch(() => {
      if (sequence === devLookupSequence) showSelectionRouteToast('ARKM 查询失败，请刷新插件和 GMGN 页面', false, true);
    }).finally(() => {
      clearTimeout(timeoutId);
      if (devQueryInFlightAddress !== address) return;
      devQueryInFlightAddress = '';
      const next = queuedDevArkhamQuery;
      queuedDevArkhamQuery = null;
      if (next?.sequence === devLookupSequence) queryDevOnArkham(next.address, next.sequence, next.tokenCA);
    });
  }

  function waitForDevPopup(referenceElement, tokenCA = getCurrentTokenCA()) {
    cancelDevAddressWait?.();
    const sequence = ++devLookupSequence;
    const href = location.href;
    const readAfter = Date.now() + 100;
    const sidebarAfter = readAfter + 300;
    let sawPopup = false;
    let observer, debounce, timeout, initialCheck, sidebarCheck;
    function stop() {
      observer?.disconnect();
      clearTimeout(debounce);
      clearTimeout(timeout);
      clearTimeout(initialCheck);
      clearTimeout(sidebarCheck);
      if (cancelDevAddressWait === stop) cancelDevAddressWait = null;
    }
    function check() {
      if (!isMasterOn() || !settings.devArkmEnabled || location.href !== href) { stop(); return; }
      // The click listener runs in capture phase. Give GMGN's own click handler
      // time to switch the wallet drawer before reading, or it may still contain
      // the previous wallet. Prefer the Dev popup first; use the drawer fallback
      // only after the transition has had time to settle.
      if (Date.now() < readAfter) return;
      const mode = Date.now() >= sidebarAfter ? 'sidebar' : 'popup';
      const popup = findDevPopupAddress(referenceElement, mode, tokenCA);
      sawPopup ||= popup.found;
      if (!popup.address) return;
      stop();
      queryDevOnArkham(popup.address, sequence, tokenCA);
    }
    cancelDevAddressWait = stop;
    // GMGN may mount the hover card or populate the copy value just after click.
    // Throttle its DOM updates so continuous price/chart mutations can't starve checks.
    const scheduleCheck = (records) => {
      const relevant = records.some((record) => {
        if (record.type === 'attributes') {
          const value = String(record.target.getAttribute(record.attributeName) || '').toLowerCase();
          if (record.attributeName === 'class' || record.attributeName === 'style') {
            const rect = record.target.getBoundingClientRect();
            if (rect.left < window.innerWidth * 0.4 || rect.right < window.innerWidth * 0.72 ||
                rect.width > window.innerWidth * 0.72) return false;
            const text = String(record.target.textContent || '').slice(0, 1200);
            return hasDevWalletLabel(text) || /钱包|持仓|买入|卖出/i.test(text) || DEV_ADDRESS_DETECT_RE.test(text);
          }
          return value.includes('dev') || value.includes('钱包') || DEV_ADDRESS_DETECT_RE.test(value);
        }
        const nodes = record.type === 'characterData' ? [record.target] : record.addedNodes;
        return Array.from(nodes).some((node) => {
          if (node.nodeType !== Node.TEXT_NODE && node.nodeType !== Node.ELEMENT_NODE) return false;
          if (node.nodeType === Node.ELEMENT_NODE && node.childElementCount > 24) return false;
          const text = String(node.nodeType === Node.TEXT_NODE ? node.nodeValue : node.textContent || '').slice(0, 600).toLowerCase();
          return text.includes('dev') || text.includes('钱包') || DEV_ADDRESS_DETECT_RE.test(text);
        });
      });
      if (!relevant) return;
      if (debounce) return;
      debounce = setTimeout(() => {
        debounce = null;
        check();
      }, 180);
    };
    observer = new MutationObserver(scheduleCheck);
    observer.observe(document.body, {
      childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ['title', 'aria-label', 'href', 'class', 'style', 'data-address', 'data-wallet-address', 'data-copy', 'data-copy-value', 'data-clipboard', 'data-clipboard-text', 'data-value']
    });
    // Let GMGN's click handler update the wallet detail drawer before using its
    // header as a fallback; this avoids reading a previously open wallet panel.
    initialCheck = setTimeout(() => {
      initialCheck = null;
      check();
    }, Math.max(0, readAfter - Date.now()));
    sidebarCheck = setTimeout(() => {
      sidebarCheck = null;
      check();
    }, Math.max(0, sidebarAfter - Date.now()));
    timeout = setTimeout(() => {
      stop();
      if (isMasterOn() && settings.devArkmEnabled && location.href === href) {
        showSelectionRouteToast(sawPopup
          ? '未读取到完整 Dev 钱包地址；已停止查询，避免误查代币 CA'
          : '未检测到 Dev 钱包信息，请再次点击 Dev 标记重试', false, true);
      }
    }, 2000);
    showSelectionRouteToast('正在读取 Dev 钱包弹窗…');
  }

  function findDevBadgeFromEvent(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    const elements = path.map(nodeElement).filter(Boolean);
    const target = elements[0] || nodeElement(event.target);
    const semanticMarker = elements.find((element) => {
      const label = `${element.getAttribute?.('aria-label') || ''} ${element.getAttribute?.('title') || ''}`;
      const iconName = `${element.getAttribute?.('data-icon') || ''} ${element.getAttribute?.('data-sentry-element') || ''}`;
      return hasDevWalletLabel(label) || /(?:^|\s)IconDev\w*/i.test(iconName) ||
        (!element.children.length && /^(?:dev|devwallet|dev钱包)$/i.test(cleanText(element.textContent)));
    });
    let icon = elements.find((element) => element.matches?.(DEV_ICON_SELECTOR)) || semanticMarker ||
      target?.closest(DEV_ICON_SELECTOR);
    const pointHitsIcon = (candidate) => {
      if (!candidate) return false;
      const rect = candidate.getBoundingClientRect();
      return event.clientX >= rect.left - 4 && event.clientX <= rect.right + 4 &&
        event.clientY >= rect.top - 4 && event.clientY <= rect.bottom + 4;
    };
    if (!icon) {
      // Accept only the icon itself, its immediate wrapper, or the exact point
      // over the icon inside its clickable control. Never search broad ancestors:
      // a card/header may contain the Dev icon alongside unrelated buttons.
      for (const element of elements) {
        const immediateIcon = element.querySelector?.(DEV_ICON_SELECTOR);
        if (immediateIcon?.parentElement === element && pointHitsIcon(immediateIcon)) {
          icon = immediateIcon;
          break;
        }
      }
      if (!icon) {
        const control = elements.find((element) => element.matches?.('button, [role="button"], a')) ||
          target?.closest?.('button, [role="button"], a');
        const controlIcon = control?.querySelector(DEV_ICON_SELECTOR);
        if (controlIcon && pointHitsIcon(controlIcon)) icon = controlIcon;
      }
    }
    if (!icon) return null;
    return { badge: icon.closest('button, [role="button"], a') || icon.parentElement || icon };
  }

  function lookupDevBadge(badge) {
    const tokenCA = getCurrentTokenCA();
    // The popup is the fast, marker-specific path. Only scan the broader wallet
    // sidebar if the popup still has no complete address after GMGN reacts.
    waitForDevPopup(badge, tokenCA);
  }

  window.addEventListener('click', (event) => {
    if (event.button !== 0 ||
        event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const match = findDevBadgeFromEvent(event);
    if (!match) return;
    // On a hard refresh the document_start listener is ready before async
    // storage settings. Keep an early Dev click so it is handled as soon as
    // the saved switch state arrives, instead of silently dropping it.
    if (!settingsLoaded) {
      pendingDevClick = { badge: match.badge, href: location.href };
      showSelectionRouteToast('已识别 Dev 标记，正在读取插件设置…');
      return;
    }
    if (settingsLoadFailed) {
      showSelectionRouteToast('插件设置读取失败，请重新加载扩展和 GMGN 页面', false, true);
      return;
    }
    if (!isMasterOn() || !settings.devArkmEnabled) {
      showSelectionRouteToast('Dev ARKM 查询开关当前处于关闭状态', false, true);
      return;
    }
    try {
      lookupDevBadge(match.badge); // Keep native click propagation so GMGN opens the wallet.
    } catch (error) {
      showSelectionRouteToast('Dev 点击已识别，但读取流程异常；请再次点击重试', false, true);
    }
  }, true);

  loadSettings();
})();
