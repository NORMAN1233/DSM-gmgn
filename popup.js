'use strict';

const SETTINGS_KEY = 'dsmSettings';
const VIEWED_KEY = 'gmgnViewedCAs';
const CLEAR_KEY = 'gmgnViewedCAsClearedAt';

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

const $ = (id) => document.getElementById(id);

const els = {
  masterEnabled: $('masterEnabled'),
  dsmEnabled: $('dsmEnabled'),
  viewedEnabled: $('viewedEnabled'),
  decisionEnabled: $('decisionEnabled'),
  batteryEnabled: $('batteryEnabled'),
  decisionSeconds: $('decisionSeconds'),
  circleSize: $('circleSize'),
  batteryMinutes: $('batteryMinutes'),
  restMinutes: $('restMinutes'),
  viewedCount: $('viewedCount'),
  viewedCountDetail: $('viewedCountDetail'),
  clearButton: $('clearButton'),
  homeClearButton: $('homeClearButton'),
  homeMessage: $('homeMessage'),
  viewedMessage: $('viewedMessage'),
  decisionMessage: $('decisionMessage'),
  settingsMessage: $('settingsMessage'),
  versionText: $('versionText')
};

function openScreen(id) {
  const next = document.getElementById(id);
  if (!next) return;
  document.querySelectorAll('.screen').forEach((screen) => screen.classList.remove('active'));
  next.classList.add('active');
  window.scrollTo(0, 0);
}

document.querySelectorAll('[data-open]').forEach((button) => {
  button.addEventListener('click', () => openScreen(button.dataset.open));
});

function showMessage(el, text) {
  if (!el) return;
  el.textContent = text;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.textContent = ''; }, 1800);
}

function getSettingsFromControls() {
  return {
    dsmEnabled: els.masterEnabled.checked,
    viewedCAEnabled: els.viewedEnabled.checked,
    decisionEnabled: els.decisionEnabled.checked,
    batteryEnabled: els.batteryEnabled.checked,
    decisionSeconds: Math.min(60, Math.max(1, Number(els.decisionSeconds.value) || 5)),
    circleSize: Math.min(400, Math.max(60, Number(els.circleSize.value) || 120)),
    batteryMinutes: Math.min(240, Math.max(10, Number(els.batteryMinutes.value) || 40)),
    restMinutes: Math.min(120, Math.max(5, Number(els.restMinutes.value) || 20))
  };
}

async function saveSettings(messageEl) {
  const settings = getSettingsFromControls();
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  if (messageEl) showMessage(messageEl, '设置已保存');
}

function applySettings(settings) {
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  els.masterEnabled.checked = !!s.dsmEnabled;
  els.dsmEnabled.checked = !!s.dsmEnabled;
  els.viewedEnabled.checked = !!s.viewedCAEnabled;
  els.decisionEnabled.checked = !!s.decisionEnabled;
  els.batteryEnabled.checked = !!s.batteryEnabled;
  els.decisionSeconds.value = String(s.decisionSeconds);
  els.circleSize.value = String(s.circleSize);
  els.batteryMinutes.value = String(s.batteryMinutes);
  els.restMinutes.value = String(s.restMinutes);

  const masterOn = !!s.dsmEnabled;
  els.viewedEnabled.disabled = !masterOn;
  els.decisionEnabled.disabled = !masterOn;
  els.batteryEnabled.disabled = !masterOn || !s.decisionEnabled;
}

async function refreshViewedCount() {
  try {
    const data = await chrome.storage.local.get(VIEWED_KEY);
    const viewed = data[VIEWED_KEY] || {};
    const count = Object.keys(viewed).length.toLocaleString();
    els.viewedCount.textContent = count;
    els.viewedCountDetail.textContent = count;
  } catch (error) {
    els.viewedCount.textContent = '0';
    els.viewedCountDetail.textContent = '0';
  }
}

async function clearViewed() {
  await chrome.storage.local.set({ [CLEAR_KEY]: Date.now() });
  await chrome.storage.local.remove(VIEWED_KEY);
  await refreshViewedCount();
}

async function init() {
  if (els.versionText) {
    els.versionText.textContent = `v${chrome.runtime.getManifest().version}`;
  }

  const data = await chrome.storage.local.get(SETTINGS_KEY);
  applySettings(data[SETTINGS_KEY] || DEFAULT_SETTINGS);

  els.masterEnabled.addEventListener('change', async () => {
    els.dsmEnabled.checked = els.masterEnabled.checked;
    await saveSettings(els.settingsMessage);
    applySettings(getSettingsFromControls());
  });

  els.dsmEnabled.addEventListener('change', async () => {
    els.masterEnabled.checked = els.dsmEnabled.checked;
    await saveSettings(els.settingsMessage);
    applySettings(getSettingsFromControls());
  });

  advancedSaveBindings();

  els.clearButton.addEventListener('click', () => {
    clearViewed().then(() => showMessage(els.viewedMessage, '已清空'));
  });
  els.homeClearButton.addEventListener('click', () => {
    clearViewed().then(() => showMessage(els.homeMessage, '已清空'));
  });

  refreshViewedCount();
}

function advancedSaveBindings() {
  const autoSaveControls = [
    els.viewedEnabled,
    els.decisionEnabled,
    els.batteryEnabled,
    els.decisionSeconds,
    els.circleSize,
    els.batteryMinutes,
    els.restMinutes
  ];

  for (const control of autoSaveControls) {
    control.addEventListener('change', async () => {
      if (els.masterEnabled.checked) {
        const messageEl = control === els.viewedEnabled
          ? els.viewedMessage
          : (control === els.decisionEnabled || control === els.batteryEnabled
            ? els.decisionMessage
            : els.settingsMessage);
        await saveSettings(messageEl);
      }
      applySettings(getSettingsFromControls());
    });
  }
}

init();
