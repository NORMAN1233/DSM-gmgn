'use strict';

const SETTINGS_KEY = 'dsmSettings'; // legacy aggregate, read-only after v2.0.2 migration
const SETTING_FIELD_PREFIX = 'dsmSetting_';
const VIEWED_KEY = 'gmgnViewedCAs';
const CLEAR_KEY = 'gmgnViewedCAsClearedAt';

const DEFAULT_SETTINGS = {
  dsmEnabled: true,
  viewedCAEnabled: true,
  twitterVoiceEnabled: true,
  twitterVoiceVolume: 100,
  twitterVoiceName: 'zh-CN-XiaoxiaoNeural',
  twitterVoiceRate: 115,
  twitterNaturalPriority: true,
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
const settingFieldKey = (name) => `${SETTING_FIELD_PREFIX}${name}`;
const SETTING_FIELD_KEYS = SETTING_FIELDS.map(settingFieldKey);

function settingsFromStorage(data) {
  const next = { ...DEFAULT_SETTINGS, ...(data[SETTINGS_KEY] || {}) };
  for (const field of SETTING_FIELDS) {
    const key = settingFieldKey(field);
    if (Object.prototype.hasOwnProperty.call(data, key)) next[field] = data[key];
  }
  return next;
}

async function loadStoredSettings() {
  const data = await chrome.storage.local.get([SETTINGS_KEY, ...SETTING_FIELD_KEYS]);
  const snapshot = settingsFromStorage(data);
  const seed = {};
  for (const field of SETTING_FIELDS) {
    const key = settingFieldKey(field);
    if (!Object.prototype.hasOwnProperty.call(data, key)) seed[key] = snapshot[field];
  }
  if (Object.keys(seed).length) await chrome.storage.local.set(seed);
  return snapshot;
}

const $ = (id) => document.getElementById(id);

const els = {
  masterEnabled: $('masterEnabled'),
  dsmEnabled: $('dsmEnabled'),
  viewedEnabled: $('viewedEnabled'),
  twitterVoiceEnabled: $('twitterVoiceEnabled'),
  twitterVoiceVolume: $('twitterVoiceVolume'),
  twitterVoiceVolumeValue: $('twitterVoiceVolumeValue'),
  twitterVoiceName: $('twitterVoiceName'),
  twitterVoiceRate: $('twitterVoiceRate'),
  twitterVoiceRateValue: $('twitterVoiceRateValue'),
  twitterVoicePreview: $('twitterVoicePreview'),
  twitterVoiceCount: $('twitterVoiceCount'),
  selectionSearchEnabled: $('selectionSearchEnabled'),
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
  socialMessage: $('socialMessage'),
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
    twitterVoiceEnabled: els.twitterVoiceEnabled.checked,
    twitterVoiceVolume: Math.min(100, Math.max(0, Number(els.twitterVoiceVolume.value) || 0)),
    twitterVoiceName: String(els.twitterVoiceName?.value || ''),
    twitterVoiceRate: [115, 150, 175].includes(Number(els.twitterVoiceRate?.value))
      ? Number(els.twitterVoiceRate.value) : 115,
    selectionSearchEnabled: els.selectionSearchEnabled.checked,
    decisionEnabled: els.decisionEnabled.checked,
    batteryEnabled: els.batteryEnabled.checked,
    decisionSeconds: Math.min(60, Math.max(1, Number(els.decisionSeconds.value) || 5)),
    circleSize: Math.min(400, Math.max(60, Number(els.circleSize.value) || 120)),
    batteryMinutes: Math.min(240, Math.max(10, Number(els.batteryMinutes.value) || 40)),
    restMinutes: Math.min(120, Math.max(5, Number(els.restMinutes.value) || 20))
  };
}

async function saveSettings(changed, messageEl) {
  // v2.0.2: field-level writes prevent a popup or stale GMGN tab from writing an
  // old decisionSeconds value back while saving another unrelated setting.
  const payload = {};
  for (const [field, value] of Object.entries(changed || {})) {
    if (SETTING_FIELDS.includes(field)) payload[settingFieldKey(field)] = value;
  }
  if (Object.keys(payload).length) await chrome.storage.local.set(payload);
  if (messageEl) showMessage(messageEl, '设置已保存');
}

function applySettings(settings) {
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  els.masterEnabled.checked = !!s.dsmEnabled;
  els.dsmEnabled.checked = !!s.dsmEnabled;
  els.viewedEnabled.checked = !!s.viewedCAEnabled;
  els.twitterVoiceEnabled.checked = !!s.twitterVoiceEnabled;
  els.twitterVoiceVolume.value = String(Math.min(100, Math.max(0, Number(s.twitterVoiceVolume) || 0)));
  if (els.twitterVoiceVolumeValue) els.twitterVoiceVolumeValue.textContent = `${els.twitterVoiceVolume.value}%`;
  if (els.twitterVoiceName) els.twitterVoiceName.value = EDGE_TTS_VOICE_IDS.has(String(s.twitterVoiceName || '')) ? String(s.twitterVoiceName) : 'zh-CN-XiaoxiaoNeural';
  const rate = [115, 150, 175].includes(Number(s.twitterVoiceRate)) ? Number(s.twitterVoiceRate) : 115;
  if (els.twitterVoiceRate) els.twitterVoiceRate.value = String(rate);
  if (els.twitterVoiceRateValue) els.twitterVoiceRateValue.textContent = `+${rate - 100}%`;
  els.selectionSearchEnabled.checked = !!s.selectionSearchEnabled;
  els.decisionEnabled.checked = !!s.decisionEnabled;
  els.batteryEnabled.checked = !!s.batteryEnabled;
  els.decisionSeconds.value = String(s.decisionSeconds);
  els.circleSize.value = String(s.circleSize);
  els.batteryMinutes.value = String(s.batteryMinutes);
  els.restMinutes.value = String(s.restMinutes);

  const masterOn = !!s.dsmEnabled;
  els.viewedEnabled.disabled = !masterOn;
  els.twitterVoiceEnabled.disabled = !masterOn;
  els.twitterVoiceVolume.disabled = !masterOn || !s.twitterVoiceEnabled;
  if (els.twitterVoiceName) els.twitterVoiceName.disabled = !masterOn || !s.twitterVoiceEnabled;
  if (els.twitterVoiceRate) els.twitterVoiceRate.disabled = !masterOn || !s.twitterVoiceEnabled;
  if (els.twitterVoicePreview) els.twitterVoicePreview.disabled = !masterOn || !s.twitterVoiceEnabled;
  els.selectionSearchEnabled.disabled = !masterOn;
  els.decisionEnabled.disabled = !masterOn;
  els.batteryEnabled.disabled = !masterOn || !s.decisionEnabled;
}

const EDGE_TTS_VOICES = [
  ['zh-CN-XiaoxiaoNeural', '晓晓 · 甜美女声（推荐）'],
  ['zh-CN-YunjianNeural', '云健 · 阳光男声'],
  ['zh-CN-XiaoyiNeural', '晓伊 · 职业女声'],
  ['en-US-AvaMultilingualNeural', 'Ava · 多语种女声']
];
const EDGE_TTS_VOICE_IDS = new Set(EDGE_TTS_VOICES.map(([id]) => id));

async function populateVoiceOptions(preferredName = null) {
  if (!els.twitterVoiceName) return;
  const keepRaw = preferredName == null ? els.twitterVoiceName.value : String(preferredName || '');
  const keep = EDGE_TTS_VOICE_IDS.has(keepRaw) ? keepRaw : 'zh-CN-XiaoxiaoNeural';
  els.twitterVoiceName.textContent = '';
  for (const [id, label] of EDGE_TTS_VOICES) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = `${label} · ${id}`;
    els.twitterVoiceName.appendChild(option);
  }
  els.twitterVoiceName.value = keep;
  if (els.twitterVoiceCount) els.twitterVoiceCount.textContent = '4 种云端音色';
  if (preferredName != null && keep !== keepRaw) {
    await saveSettings({ twitterVoiceName: keep });
  }
}


async function previewSelectedVoice() {
  const settings = getSettingsFromControls();
  const button = els.twitterVoicePreview;
  if (button) button.disabled = true;
  showMessage(els.socialMessage, '正在生成 Edge-TTS 试听音频…');
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'DSM_PREVIEW_TTS',
      text: '币安 Binance 华语 发推啦',
      volume: settings.twitterVoiceVolume / 100,
      voiceName: settings.twitterVoiceName || 'zh-CN-XiaoxiaoNeural',
      rate: settings.twitterVoiceRate,
      enqueue: false
    });
    if (response?.ok) {
      showMessage(els.socialMessage, `试听成功：${settings.twitterVoiceName || 'zh-CN-XiaoxiaoNeural'}`);
    } else {
      throw new Error(response?.reason || '音频未播放');
    }
  } catch (error) {
    showMessage(els.socialMessage, `试听失败：${error?.message || error}`);
  } finally {
    if (button) button.disabled = false;
  }
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

  const storedSettings = await loadStoredSettings();
  applySettings(storedSettings);
  populateVoiceOptions(storedSettings.twitterVoiceName).catch(() => {});

  els.masterEnabled.addEventListener('change', async () => {
    els.dsmEnabled.checked = els.masterEnabled.checked;
    await saveSettings({ dsmEnabled: els.masterEnabled.checked }, els.settingsMessage);
    applySettings(getSettingsFromControls());
  });

  els.dsmEnabled.addEventListener('change', async () => {
    els.masterEnabled.checked = els.dsmEnabled.checked;
    await saveSettings({ dsmEnabled: els.dsmEnabled.checked }, els.settingsMessage);
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
  els.twitterVoiceVolume.addEventListener('input', () => {
    if (els.twitterVoiceVolumeValue) els.twitterVoiceVolumeValue.textContent = `${els.twitterVoiceVolume.value}%`;
  });

  if (els.twitterVoiceRate) els.twitterVoiceRate.addEventListener('input', () => {
    if (els.twitterVoiceRateValue) els.twitterVoiceRateValue.textContent = `+${Number(els.twitterVoiceRate.value) - 100}%`;
  });

  if (els.twitterVoicePreview) els.twitterVoicePreview.addEventListener('click', previewSelectedVoice);

  const autoSaveControls = [
    [els.viewedEnabled, 'viewedCAEnabled'],
    [els.twitterVoiceEnabled, 'twitterVoiceEnabled'],
    [els.twitterVoiceVolume, 'twitterVoiceVolume'],
    [els.twitterVoiceName, 'twitterVoiceName'],
    [els.twitterVoiceRate, 'twitterVoiceRate'],
    [els.selectionSearchEnabled, 'selectionSearchEnabled'],
    [els.decisionEnabled, 'decisionEnabled'],
    [els.batteryEnabled, 'batteryEnabled'],
    [els.decisionSeconds, 'decisionSeconds'],
    [els.circleSize, 'circleSize'],
    [els.batteryMinutes, 'batteryMinutes'],
    [els.restMinutes, 'restMinutes']
  ];

  for (const [control, field] of autoSaveControls) {
    if (!control) continue;
    control.addEventListener('change', async () => {
      const formSettings = getSettingsFromControls();
      if (els.masterEnabled.checked) {
        const messageEl = control === els.viewedEnabled
          ? els.viewedMessage
          : (control === els.twitterVoiceEnabled || control === els.twitterVoiceVolume || control === els.twitterVoiceName || control === els.twitterVoiceRate || control === els.selectionSearchEnabled
            ? els.socialMessage
            : (control === els.decisionEnabled || control === els.batteryEnabled
              ? els.decisionMessage
              : els.settingsMessage));
        await saveSettings({ [field]: formSettings[field] }, messageEl);
      }
      applySettings(formSettings);
    });
  }
}

// Keep an already-open popup in sync with wheel changes or edits made in another tab.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const controlByField = {
    dsmEnabled: [els.masterEnabled, els.dsmEnabled],
    viewedCAEnabled: [els.viewedEnabled],
    twitterVoiceEnabled: [els.twitterVoiceEnabled],
    twitterVoiceVolume: [els.twitterVoiceVolume],
    twitterVoiceName: [els.twitterVoiceName],
    twitterVoiceRate: [els.twitterVoiceRate],
    selectionSearchEnabled: [els.selectionSearchEnabled],
    decisionEnabled: [els.decisionEnabled],
    batteryEnabled: [els.batteryEnabled],
    decisionSeconds: [els.decisionSeconds],
    circleSize: [els.circleSize],
    batteryMinutes: [els.batteryMinutes],
    restMinutes: [els.restMinutes]
  };

  let touched = false;
  for (const [field, controls] of Object.entries(controlByField)) {
    const change = changes[settingFieldKey(field)];
    if (!change) continue;
    touched = true;
    for (const control of controls) {
      if (!control || document.activeElement === control) continue;
      if (control.type === 'checkbox') control.checked = !!change.newValue;
      else control.value = String(change.newValue);
    }
  }

  if (touched) applySettings(getSettingsFromControls());
});

init();
