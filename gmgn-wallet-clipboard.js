(() => {
  'use strict';

  // 监听 GMGN 官方钱包/追踪面板中新出现的购买信息，只处理新行，
  // 不扫描历史列表，避免刷新页面时覆盖用户剪贴板。
  const SETTING_KEY = 'dsmSetting_officialWalletCopyEnabled';
  const MASTER_KEY = 'dsmSetting_dsmEnabled';
  const RESULT_EVENT = 'dsm-gmgn-wallet-ca-copied';
  const CA_RE = /^(?:0x[a-fA-F0-9]{40,128}|[1-9A-HJ-NP-Za-km-z]{32,44}|[13][1-9A-HJ-NP-Za-km-z]{25,34}|[EU]Q[A-Za-z0-9_-]{46})$/;
  const GENERIC_ADDRESS_RE = /^(?=.*\d)[A-Za-z0-9_-]{24,128}$/;
  const TOKEN_ROUTE_RE = /\/(?:token|pump|meme|coin|pair|pool)(?:\/|$)|[?&#](?:token|mint|contract|ca)=/i;
  const TOKEN_LINK_SELECTOR = [
    'a[href*="/token/" i]', 'a[href*="/pump/" i]', 'a[href*="/meme/" i]',
    'a[href*="/coin/" i]', 'a[href*="/pair/" i]', 'a[href*="/pool/" i]',
    'a[href*="?token=" i]', 'a[href*="&token=" i]', 'a[href*="?mint=" i]',
    'a[href*="&mint=" i]', 'a[href*="?contract=" i]', 'a[href*="&contract=" i]',
    'a[href*="?ca=" i]', 'a[href*="&ca=" i]'
  ].join(',');
  const TOKEN_ATTRS = ['data-ca', 'data-mint', 'data-token-address', 'data-contract-address'];
  const WALLET_BOOTSTRAP_SELECTOR = [
    '[data-testid*="wallet" i]', '[data-testid*="follow" i]',
    '[class*="wallet" i]', '[class*="follow" i]',
    '[aria-label*="wallet" i]', '[aria-label*="钱包" i]'
  ].join(',');

  let enabled = true;
  let masterEnabled = true;
  let observer = null;
  let bootstrapObserver = null;
  let bootstrapScheduled = false;
  let flushScheduled = false;
  let bodyReadyListener = false;
  let scopeTimer = null;
  let walletMonitorActive = false;
  let walletScope = null;
  let observationRoot = null;
  // 以“行节点 -> 最近一次 CA”去重；GMGN 会复用同一行节点更新下一笔交易。
  const seenMessages = new WeakMap();
  const copyRetries = new WeakMap();
  const recentCopies = new Map();
  const pendingNodes = new Set();

  function cleanText(value) {
    return String(value || '').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  }

  function isGMGNPage() {
    return /(^|\.)gmgn\.ai$/i.test(location.hostname || '');
  }

  function mayContainWalletMonitor(node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    if (!element) return false;
    const hints = hintText(element);
    if (/wallet|follow|monitor|tracker/i.test(hints)) return true;
    try {
      if (element.querySelector?.(WALLET_BOOTSTRAP_SELECTOR)) return true;
    } catch (error) {}
    if (element.childElementCount > 80) return false;
    const text = cleanText(element.textContent).slice(0, 500);
    return /钱包|wallet/i.test(text) && /追踪|购买|买入|卖出|follow|buy|sell/i.test(text);
  }

  function watchForWalletMonitor() {
    if (bootstrapObserver || observer || !document.body || !enabled || !masterEnabled) return;
    bootstrapObserver = new MutationObserver((mutations) => {
      if (bootstrapScheduled) return;
      const likely = mutations.some((mutation) => Array.from(mutation.addedNodes || []).some(mayContainWalletMonitor));
      if (!likely) return;
      bootstrapScheduled = true;
      queueMicrotask(() => {
        bootstrapScheduled = false;
        if (!bootstrapObserver || observer || !enabled || !masterEnabled) return;
        refreshWalletScope();
        if (!walletMonitorActive) return;
        bootstrapObserver.disconnect();
        bootstrapObserver = null;
        start();
      });
    });
    bootstrapObserver.observe(document.body, { childList: true, subtree: true });
  }

  function normalizeCA(value, allowUnknown = false) {
    const ca = cleanText(value).replace(/[。；，,;\])}>'"`]+$/g, '');
    if (!CA_RE.test(ca) && !(allowUnknown && GENERIC_ADDRESS_RE.test(ca))) return '';
    return /^0x/i.test(ca) ? ca.toLowerCase() : ca;
  }

  function candidateParts(value) {
    const parts = String(value || '').split(/[/?#=&\s:()[\]{}<>"'`]+/);
    const typed = parts.map((part) => normalizeCA(part)).filter(Boolean);
    if (typed.length) return typed;
    return parts.map((part) => normalizeCA(part, true)).filter(Boolean);
  }

  function refreshWalletScope() {
    if (!document.body) return null;
    if (walletScope?.isConnected) {
      walletMonitorActive = true;
      return walletScope;
    }
    const tabs = Array.from(document.querySelectorAll(
      'button,[role="tab"],[role="button"],[data-testid*="wallet" i],[data-testid*="follow" i],[class*="wallet" i],[class*="follow" i]'
    ));
    const walletTabs = tabs.filter((element) => {
      const text = cleanText(element.textContent);
      return text.length <= 80 && (/^钱包(?:\s|\d|$)/.test(text) || /^wallet(?:\s|\d|$)/i.test(text));
    });
    let best = null;
    let bestLinkCount = Infinity;
    for (const walletTab of walletTabs) {
      let current = walletTab;
      for (let depth = 0; current && current !== document.body && depth < 7; depth += 1, current = current.parentElement) {
        const text = cleanText(current.textContent).slice(0, 3200);
        if (!/追踪|跟踪|购买|买入|卖出|tracking|follow|buy|sell/i.test(text)) continue;
        let tokenCount = 0;
        let linkCount = 0;
        try {
          tokenCount = current.querySelectorAll(TOKEN_LINK_SELECTOR).length;
          linkCount = current.querySelectorAll('a[href]').length;
        } catch (error) {}
        if (!tokenCount || !linkCount || linkCount >= bestLinkCount) continue;
        best = current;
        bestLinkCount = linkCount;
        break;
      }
    }
    walletScope = best;
    walletMonitorActive = !!walletScope;
    return walletScope;
  }

  function isInsideWalletScope(element) {
    return !!walletScope?.isConnected && (walletScope === element || walletScope.contains?.(element));
  }

  function extractCA(root) {
    if (!root) return '';
    if (root.matches?.('a[href]') && TOKEN_ROUTE_RE.test(root.getAttribute('href') || '')) {
      const direct = candidateParts(root.getAttribute('href'));
      if (direct.length) return direct[0];
    }
    const nodes = [];
    if (root.nodeType === 1) nodes.push(root);
    try { nodes.push(...root.querySelectorAll('[data-address],[data-ca],[data-mint],[data-token-address],[data-contract-address]')); } catch (error) {}

    // GMGN 每条购买信息通常同时包含“钱包地址链接”和“代币链接”。
    // data-address 优先指向钱包，只有明确位于代币节点/代币链接下时才允许使用。
    for (const node of nodes) {
      for (const attr of TOKEN_ATTRS) {
        const direct = normalizeCA(node.getAttribute?.(attr), true);
        if (direct) return direct;
      }
      const walletAddress = normalizeCA(node.getAttribute?.('data-address'), true);
      if (walletAddress) {
        const ownerLink = node.closest?.('a[href]');
        const nodeHints = `${hintText(node)} ${hintText(node.parentElement)}`;
        if (ownerLink && TOKEN_ROUTE_RE.test(ownerLink.getAttribute('href') || '')) return walletAddress;
        if (/token|mint|contract|coin|pair|pool/i.test(nodeHints)) return walletAddress;
      }
    }

    const links = [];
    if (root.matches?.('a[href]')) links.push(root);
    try { links.push(...root.querySelectorAll('a[href]')); } catch (error) {}
    const tokenLinks = links
      .filter((link) => TOKEN_ROUTE_RE.test(link.getAttribute('href') || ''))
      .sort((left, right) => {
        const leftHints = hintText(left);
        const rightHints = hintText(right);
        return Number(/token|mint|contract|coin|pair|pool/i.test(rightHints))
          - Number(/token|mint|contract|coin|pair|pool/i.test(leftHints));
      });
    for (const link of tokenLinks) {
      const candidates = candidateParts(link.getAttribute('href'));
      if (candidates.length) return candidates[0];
    }

    return '';
  }

  function hintText(element) {
    return [
      element?.id, element?.className, element?.getAttribute?.('role'),
      element?.getAttribute?.('aria-label'), element?.getAttribute?.('data-testid'),
      element?.getAttribute?.('data-sentry-component')
    ].filter((value) => typeof value === 'string').join(' ');
  }

  function isMonitorContext(element) {
    return walletMonitorActive && isInsideWalletScope(element);
  }

  function tokenLinksIn(root) {
    const links = [];
    if (root?.matches?.('a[href]') && TOKEN_ROUTE_RE.test(root.getAttribute('href') || '')) return [root];
    try {
      for (const link of root?.querySelectorAll?.(TOKEN_LINK_SELECTOR) || []) {
        if (TOKEN_ROUTE_RE.test(link.getAttribute('href') || '')) links.push(link);
        if (links.length > 2) break;
      }
    } catch (error) {}
    return links;
  }

  function findMessageRoot(node) {
    if (!walletScope?.isConnected) return null;
    let current = node?.nodeType === 1 ? node : node?.parentElement;
    for (let depth = 0; current && current !== document.body && depth < 8; depth += 1, current = current.parentElement) {
      const tokenLinks = tokenLinksIn(current);
      // 返回代币链接本身，避免把整个钱包面板当成一条消息。
      if (tokenLinks.length === 1 && isInsideWalletScope(tokenLinks[0])) return tokenLinks[0];
      if (current === walletScope) break;
    }
    return null;
  }

  function isOwnNode(node) {
    return !!node?.closest?.('[data-dsm-wallet-copy]') || node?.hasAttribute?.('data-dsm-wallet-copy');
  }

  function isPotentialNode(node) {
    if (!node || node.nodeType !== 1 || isOwnNode(node)) return false;
    if (!isInsideWalletScope(node)) return false;
    if (node.matches?.('a[href]') && TOKEN_ROUTE_RE.test(node.getAttribute('href') || '')
        && candidateParts(node.getAttribute('href')).length) return true;
    for (const attr of TOKEN_ATTRS) {
      if (normalizeCA(node.getAttribute?.(attr), true)) return true;
    }
    if (normalizeCA(node.getAttribute?.('data-address'), true)) {
      const ownerLink = node.closest?.('a[href]');
      if (ownerLink && TOKEN_ROUTE_RE.test(ownerLink.getAttribute('href') || '')) return true;
    }
    if (walletMonitorActive && (isInsideWalletScope(node) || !walletScope) && node.childElementCount <= 32) {
      try {
        const link = node.matches?.('a[href]') && TOKEN_ROUTE_RE.test(node.getAttribute('href') || '')
          ? node
          : node.querySelector(TOKEN_LINK_SELECTOR);
        if (link && candidateParts(link.getAttribute('href')).length) return true;
        const addressNode = node.querySelector('[data-address],[data-ca],[data-mint],[data-token-address],[data-contract-address]');
        if (addressNode && TOKEN_ATTRS
          .some((attr) => normalizeCA(addressNode.getAttribute(attr), true))) return true;
      } catch (error) {}
    }
    return false;
  }

  function enqueueNode(node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    if (!element || isOwnNode(element)) return;
    if (isPotentialNode(element)) {
      pendingNodes.add(element);
    }
    if (!pendingNodes.size || flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(() => {
      flushScheduled = false;
      const nodes = Array.from(pendingNodes);
      pendingNodes.clear();
      const roots = new Set();
      for (const candidate of nodes) {
        const root = findMessageRoot(candidate);
        if (root) roots.add(root);
      }
      for (const root of roots) processMessage(root).catch(() => {});
    });
  }

  async function copyToClipboard(value) {
    try {
      if (navigator.clipboard?.writeText) {
        const write = navigator.clipboard.writeText(value).then(() => true).catch(() => false);
        const finished = await Promise.race([
          write,
          // Clipboard API 在 GMGN 页面通常会立即完成；失败时尽快切到同步兜底，
          // 避免自动复制被无响应的权限请求拖慢。
          new Promise((resolve) => setTimeout(() => resolve(false), 180))
        ]);
        if (finished) return true;
      }
    } catch (error) {}

    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
    (document.body || document.documentElement).appendChild(area);
    area.focus?.();
    area.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch (error) {}
    area.remove();
    return copied;
  }

  async function processMessage(root) {
    if (!enabled || !masterEnabled || !root) return;
    const ca = extractCA(root);
    if (!ca || !isMonitorContext(root)) return;
    if (seenMessages.get(root) === ca) return;
    seenMessages.set(root, ca);
    const previous = recentCopies.get(ca) || 0;
    if (Date.now() - previous < 1500) return;
    recentCopies.set(ca, Date.now());
    for (const [key, at] of recentCopies) if (Date.now() - at > 15000) recentCopies.delete(key);
    const copied = await copyToClipboard(ca);
    if (!copied && !copyRetries.has(root)) {
      // 页面刚插入新行时权限上下文偶尔尚未就绪，只重试一次，避免形成循环。
      copyRetries.set(root, true);
      seenMessages.delete(root);
      recentCopies.delete(ca);
      setTimeout(() => processMessage(root).catch(() => {}), 180);
      return;
    }
    copyRetries.delete(root);
    try {
      window.dispatchEvent(new CustomEvent(RESULT_EVENT, { detail: { ca, copied } }));
    } catch (error) {}
  }

  function seedExistingMessages() {
    const scope = walletScope;
    if (!scope) return;
    try {
      for (const link of scope.querySelectorAll(TOKEN_LINK_SELECTOR)) {
        const ca = extractCA(link);
        if (ca) seenMessages.set(link, ca);
      }
    } catch (error) {}
  }

  function start() {
    if (observer || !enabled || !masterEnabled || !document.documentElement || !isGMGNPage()) return;
    if (!document.body) {
      if (!bodyReadyListener) {
        bodyReadyListener = true;
        document.addEventListener('DOMContentLoaded', () => {
          bodyReadyListener = false;
          start();
        }, { once: true });
      }
      return;
    }
    refreshWalletScope();
    if (!walletMonitorActive || !walletScope) {
      watchForWalletMonitor();
      if (scopeTimer === null) {
        scopeTimer = setInterval(() => {
          if (!enabled || !masterEnabled || observer) return;
          refreshWalletScope();
          if (walletMonitorActive) start();
        }, 3000);
      }
      return;
    }
    bootstrapObserver?.disconnect();
    bootstrapObserver = null;
    observationRoot = walletScope;
    seedExistingMessages();
    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes || []) {
          enqueueNode(node);
        }
        if (mutation.type === 'attributes') enqueueNode(mutation.target);
      }
    });
    observer.observe(observationRoot, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href', 'data-ca', 'data-mint', 'data-token-address', 'data-contract-address', 'data-address']
    });
    if (scopeTimer === null) {
      scopeTimer = setInterval(() => {
        if (!enabled || !masterEnabled) return;
        const previous = observationRoot;
        refreshWalletScope();
        const next = walletMonitorActive && walletScope?.isConnected ? walletScope : null;
        if (next && next !== previous) {
          observer?.disconnect();
          observer = null;
          observationRoot = next;
          start();
        } else if (!next && observer) {
          observer.disconnect();
          observer = null;
          observationRoot = null;
          pendingNodes.clear();
          watchForWalletMonitor();
        }
      }, 3000);
    }
  }

  function stop() {
    observer?.disconnect();
    observer = null;
    bootstrapObserver?.disconnect();
    bootstrapObserver = null;
    bootstrapScheduled = false;
    flushScheduled = false;
    pendingNodes.clear();
    if (scopeTimer !== null) {
      clearInterval(scopeTimer);
      scopeTimer = null;
    }
    observationRoot = null;
  }

  chrome.storage.local.get([MASTER_KEY, SETTING_KEY]).then((data) => {
    masterEnabled = data[MASTER_KEY] !== false;
    enabled = data[SETTING_KEY] !== false;
    start();
  }).catch(() => start());

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[MASTER_KEY]) masterEnabled = changes[MASTER_KEY].newValue !== false;
    if (changes[SETTING_KEY]) enabled = changes[SETTING_KEY].newValue !== false;
    if (enabled && masterEnabled) start();
    else stop();
  });
})();
