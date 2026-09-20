function showWalletCopyStatus(message, active) {
  const id = 'dsm-shortcut-status-toast';
  let host = document.getElementById(id);
  if (!host?.shadowRoot) {
    host?.remove();
    host = document.createElement('div');
    host.id = id;
    host.attachShadow({ mode: 'open' });
    const panel = document.createElement('div');
    panel.setAttribute('role', 'status');
    panel.setAttribute('aria-live', 'assertive');
    host.shadowRoot.appendChild(panel);
    (document.fullscreenElement || document.documentElement).appendChild(host);
  }
  host.style.cssText = 'all:initial!important;position:fixed!important;inset:24% auto auto 50%!important;transform:translateX(-50%)!important;z-index:2147483647!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important;max-width:90vw!important;pointer-events:none!important;display:block!important;';
  const panel = host.shadowRoot.firstChild;
  panel.style.cssText = `padding:22px 32px;border-radius:12px;font:700 22px/32px system-ui,sans-serif;color:#fff;text-align:center;box-shadow:0 6px 28px #0006;background:${active ? '#237e4a' : '#b93434'};`;
  panel.textContent = message;
  // The top layer keeps the notice above wallet dialogs; older browsers use z-index.
  try { host.setAttribute('popover', 'manual'); host.showPopover(); } catch (error) {}
  clearTimeout(host._dsmHideTimer);
  host._dsmHideTimer = setTimeout(() => host.remove(), 4500);
  return { shown: true };
}

function walletShortcutFromEvent(event) {
  if (!/^(?:Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-2]))$/.test(event.code || '')) return null;
  if (!event.ctrlKey && !event.altKey && !event.metaKey && !/^F\d/.test(event.code)) return null;
  return { code: event.code, ctrlKey: !!event.ctrlKey, altKey: !!event.altKey, shiftKey: !!event.shiftKey, metaKey: !!event.metaKey };
}

function walletShortcutLabel(binding) {
  if (!binding) return '未设置';
  return [binding.ctrlKey && 'Ctrl', binding.altKey && 'Alt', binding.shiftKey && 'Shift', binding.metaKey && '⌘', binding.code.replace(/^(Key|Digit)/, '')].filter(Boolean).join(' + ');
}

(() => {
  if (typeof window === 'undefined' || !/(^|\.)(gmgn\.ai|axiom\.trade|arkm\.com)$/.test(location.hostname)) return;
  const key = 'dsmSetting_walletCopyShortcut';
  let binding = null;
  let ready = false;
  let state = {};
  let request = 0;
  chrome.storage.local.get([key, 'dsmSetting_officialWalletCopyEnabled', 'dsmSetting_dsmEnabled']).then((data) => {
    binding = data[key] || null;
    state = data;
    ready = true;
  }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[key]) binding = changes[key].newValue || null;
    for (const field of ['dsmSetting_officialWalletCopyEnabled', 'dsmSetting_dsmEnabled']) {
      if (changes[field]) state[field] = changes[field].newValue;
    }
    if (ready && changes.dsmSetting_officialWalletCopyEnabled) {
      const enabled = state.dsmSetting_officialWalletCopyEnabled !== false;
      const masterOn = state.dsmSetting_dsmEnabled !== false;
      showWalletCopyStatus(`自动复制新消息 CA 已${enabled ? '开启' : '关闭'}${enabled && !masterOn ? '（总开关已关闭，暂不生效）' : ''}`, enabled && masterOn);
    }
  });
  window.addEventListener('keydown', (event) => {
    if (!ready || !binding || event.repeat || event.isComposing || !event.isTrusted) return;
    if (event.target?.closest?.('input,textarea,select,[contenteditable="true"],[role="textbox"]')) return;
    const pressed = walletShortcutFromEvent(event);
    if (!pressed || Object.keys(pressed).some((field) => pressed[field] !== binding[field])) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const sequence = ++request;
    showWalletCopyStatus('正在切换自动复制…', false);
    const timer = setTimeout(() => {
      if (request === sequence) showWalletCopyStatus('扩展未响应，请重新加载扩展并刷新页面', false);
    }, 2500);
    try {
      chrome.runtime.sendMessage({ type: 'DSM_TOGGLE_WALLET_COPY' }).then((result) => {
        clearTimeout(timer);
        if (request === sequence) showWalletCopyStatus(result?.text || '切换失败，请重新加载扩展', !!result?.active);
      }).catch(() => {
        clearTimeout(timer);
        if (request === sequence) showWalletCopyStatus('扩展已更新，请刷新页面后再用快捷键', false);
      });
    } catch (error) {
      clearTimeout(timer);
      showWalletCopyStatus('扩展已更新，请刷新页面后再用快捷键', false);
    }
  }, true);
})();
