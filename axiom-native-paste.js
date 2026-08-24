'use strict';

// Runs in Axiom's MAIN world so the native React onClick executes in the same
// JavaScript realm and retains the physical C key's transient user activation.
(() => {
  const REQUEST_EVENT = 'dsm-axiom-native-paste-ca';
  const RESULT_ATTR = 'data-dsm-axiom-native-paste-result';
  const CLICKABLE = 'button,[role="button"],a[href],[tabindex]';

  const visible = (element) => {
    if (!element?.isConnected) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width >= 8 && rect.height >= 8
      && style.display !== 'none' && style.visibility !== 'hidden'
      && Number(style.opacity || 1) !== 0;
  };

  const ownerOf = (element) => element?.matches?.(CLICKABLE)
    ? element
    : element?.closest?.(CLICKABLE);

  const enabled = (element) => !element?.matches?.(':disabled')
    && element?.getAttribute?.('aria-disabled') !== 'true';

  const label = (element) => [
    element?.getAttribute?.('aria-label'), element?.getAttribute?.('title'),
    element?.getAttribute?.('data-tooltip'), element?.textContent
  ].filter(Boolean).join(' ');

  const isPasteLabel = (element) => /paste\s*(?:contract\s*)?(?:address|ca)|粘贴.*(?:ca|合约|地址)/i
    .test(label(element));

  const hasCopyIcon = (element) => /ri-file-copy|file-copy|clipboard/i
    .test(element?.getAttribute?.('class') || '')
    || !!element?.querySelector?.('i.ri-file-copy-line,[class*="file-copy"],[class*="clipboard"]');

  const isLoading = (element) => /loading|ri-loader-4-line/i.test([
    label(element), element?.getAttribute?.('class'),
    element?.querySelector?.('i,svg,use')?.getAttribute?.('class')
  ].filter(Boolean).join(' '));

  const clickableTarget = (node) => {
    const owner = ownerOf(node);
    return owner && visible(owner) ? owner : node;
  };

  const findSearchNode = () => {
    for (const selector of [
      '[aria-label="Search"]', 'i.ri-search-2-line',
      'button:has(i.ri-search-2-line)',
      'input[placeholder*="Search" i]', 'input[placeholder*="CA" i]'
    ]) {
      try {
        const node = Array.from(document.querySelectorAll(selector)).find(visible);
        if (node) return node;
      } catch (error) {}
    }
    return null;
  };

  const relationToSearch = (element, searchNode) => {
    if (!element || element === searchNode || element.contains?.(searchNode)) return null;
    const searchRect = searchNode.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    const gap = searchRect.left - rect.right;
    const centerDelta = Math.abs((rect.top + rect.bottom - searchRect.top - searchRect.bottom) / 2);
    if (gap < -6 || gap > 112 || centerDelta > Math.max(16, searchRect.height * .6)) return null;
    if (rect.width > 180 || rect.height > 80) return null;
    return { element, gap, centerDelta };
  };

  const findPasteControl = () => {
    const exact = Array.from(document.querySelectorAll('[aria-label="Paste Contract Address"]')).find(visible);
    if (exact) {
      const target = clickableTarget(exact);
      return enabled(target) ? { target, method: 'aria' } : { busy: true };
    }

    const clickables = Array.from(document.querySelectorAll(CLICKABLE)).filter(visible);
    const labelled = clickables.find((element) => enabled(element) && isPasteLabel(element));
    if (labelled) return { target: labelled, method: 'label' };

    const searchNode = findSearchNode();
    if (!searchNode) return { reason: 'search-not-found' };

    const nearby = clickables.map((element) => relationToSearch(element, searchNode)).filter(Boolean)
      .sort((a, b) => Number(hasCopyIcon(b.element)) - Number(hasCopyIcon(a.element))
        || a.gap - b.gap || a.centerDelta - b.centerDelta);

    const busy = nearby.find(({ element }) => !enabled(element) && isLoading(element));
    if (busy) return { busy: true };

    const copyButton = nearby.find(({ element }) => enabled(element) && hasCopyIcon(element));
    if (copyButton) return { target: copyButton.element, method: 'copy-icon' };

    // Last resort for compact builds whose icon has no semantic attributes:
    // only accept an actual clickable owner in the narrow strip left of Search.
    const searchRect = searchNode.getBoundingClientRect();
    const centerY = (searchRect.top + searchRect.bottom) / 2;
    for (const offset of [8, 12, 18, 24, 32, 40, 48, 56]) {
      const node = document.elementFromPoint?.(searchRect.left - offset, centerY);
      if (!visible(node) || node === searchNode || node.contains?.(searchNode)) continue;
      const owner = ownerOf(node);
      if (owner && !owner.contains?.(searchNode) && visible(owner) && enabled(owner)) {
        return { target: owner, method: 'search-left' };
      }
      if (hasCopyIcon(node) && enabled(node)) return { target: node, method: 'icon-node' };
    }

    return { reason: 'paste-not-found' };
  };

  document.addEventListener(REQUEST_EVENT, () => {
    const root = document.documentElement;
    if (!root) return;
    let result = 'not-found';
    try {
      const control = findPasteControl();
      if (control.busy) {
        result = 'busy';
      } else if (control.target) {
        try { control.target.focus?.({ preventScroll: true }); } catch (error) {}
        if (typeof control.target.click === 'function') control.target.click();
        else control.target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
        result = `clicked:${control.method || 'unknown'}`;
      } else {
        result = control.reason || 'not-found';
      }
    } catch (error) {
      result = 'click-error';
    }
    root.setAttribute(RESULT_ATTR, result);
  }, true);
})();
