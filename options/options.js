// AI Distraction Blocker — Options v4

const DEFAULTS = {
  apiKey: "",
  focusWindows: [{ id: "1", enabled: true, start: "09:00", end: "17:00", label: "Work" }],
  interventionMode: "both",
  whitelist: ["github.com", "stackoverflow.com", "docs.google.com", "notion.so", "figma.com"],
  bingeRules: [],
  bingeUsage: {},
  stats: {},
  pauseUntil: 0,
  _userConfigured: false
};

function getSettings() {
  return new Promise(resolve => chrome.storage.local.get(DEFAULTS, resolve));
}

function setSetting(key, value) {
  return new Promise(resolve => chrome.storage.local.set({ [key]: value }, resolve));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function isWindowActive(w) {
  if (!w.enabled) return false;
  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = w.start.split(':').map(Number);
  const [eh, em] = w.end.split(':').map(Number);
  return nowMins >= sh * 60 + sm && nowMins < eh * 60 + em;
}

function isInAnyWindow(windows) {
  return (windows || []).some(isWindowActive);
}

function secsToDisplay(secs) {
  return { m: Math.floor(secs / 60), s: secs % 60 };
}

function displayToSecs(m, s) {
  return (parseInt(m) || 0) * 60 + (parseInt(s) || 0);
}

function formatSecs(secs) {
  const m = Math.floor(secs / 60), s = secs % 60;
  if (m === 0) return s + 's';
  if (s === 0) return m + 'm';
  return m + 'm ' + s + 's';
}

function showStatus(id, msg, isError) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? '#f87171' : '#4ade80';
  el.style.opacity = '1';
  setTimeout(() => { el.style.opacity = '0'; }, 2500);
}

// ── Live status ──
function updateLiveStatus(windows) {
  const pill = document.getElementById('live-status');
  const text = document.getElementById('live-status-text');
  chrome.storage.local.get({ pauseUntil: 0 }, data => {
    const paused = data.pauseUntil > Date.now();
    if (paused) {
      const mins = Math.ceil((data.pauseUntil - Date.now()) / 60000);
      pill.className = 'live-pill paused';
      text.textContent = 'Paused · ' + mins + 'm';
    } else {
      const active = isInAnyWindow(windows);
      const anyEnabled = (windows || []).some(w => w.enabled);
      pill.className = active ? 'live-pill active' : 'live-pill';
      text.textContent = active ? 'Blocking' : (anyEnabled ? 'Standby' : 'Off');
    }
  });
}

// ── Sidebar navigation ──
function initNav() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', e => {
      e.preventDefault();
      const sec = item.dataset.section;
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      document.querySelectorAll('.page-section').forEach(s => s.classList.remove('active'));
      item.classList.add('active');
      document.getElementById('section-' + sec).classList.add('active');
    });
  });
}

// ── Dashboard ──
function renderWeeklyChart(stats) {
  const container = document.getElementById('weekly-chart');
  if (!container) return;
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  const DAY_LABELS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const todayStr = new Date().toISOString().slice(0, 10);
  const values = days.map(d => (stats[d] || {}).interventions || 0);
  const max = Math.max(...values, 1);

  const MAX_BAR_PX = 64;
  const tbody = document.getElementById('weekly-table-body');
  const todayStr2 = todayStr;

  container.innerHTML = days.map((d, i) => {
    const val = values[i];
    const heightPx = Math.round((val / max) * MAX_BAR_PX);
    const isToday = d === todayStr;
    const dayLabel = DAY_LABELS[new Date(d + 'T12:00:00').getDay()];
    return '<div class="weekly-bar-wrap">' +
      '<div class="weekly-bar-val">' + (val || '') + '</div>' +
      '<div class="weekly-bar' + (isToday ? ' today' : '') + '" style="height:' + Math.max(heightPx, 3) + 'px"></div>' +
      '<div class="weekly-bar-label">' + (isToday ? 'Today' : dayLabel) + '</div>' +
    '</div>';
  }).join('');

  if (tbody) {
    tbody.innerHTML = days.map((d, i) => {
      const day = stats[d] || {};
      const interventions = day.interventions || 0;
      const mins = day.distractingMinutes || 0;
      const exited = day.exited || 0;
      const isToday = d === todayStr2;
      const dayLabel = DAY_LABELS[new Date(d + 'T12:00:00').getDay()];
      let scoreHtml = '<span class="score-cell">—</span>';
      if (interventions > 0) {
        const score = Math.round((exited / interventions) * 100);
        const cls = score >= 70 ? 'green' : score >= 40 ? 'amber' : 'red';
        scoreHtml = '<span class="score-cell ' + cls + '">' + score + '%</span>';
      }
      return '<tr' + (isToday ? ' class="today"' : '') + '>' +
        '<td>' + (isToday ? 'Today' : dayLabel + ' ' + d.slice(5)) + '</td>' +
        '<td>' + (interventions || '—') + '</td>' +
        '<td>' + (mins || '—') + '</td>' +
        '<td>' + (exited || '—') + '</td>' +
        '<td>' + scoreHtml + '</td>' +
      '</tr>';
    }).join('');
  }
}

function calcStreak(stats) {
  let streak = 0;
  const today = new Date();
  for (let i = 0; i < 365; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const day = stats[key];
    if (!day || !day.interventions) break; // no data = streak ends
    const score = day.interventions > 0 ? (day.exited || 0) / day.interventions : 0;
    if (score >= 0.5) streak++;
    else break;
  }
  return streak;
}

async function renderDashboard(settings) {
  const today = new Date().toISOString().slice(0, 10);
  const stats = (settings.stats || {})[today] || { distractingMinutes: 0, interventions: 0, exited: 0 };

  document.getElementById('s-interventions').textContent = stats.interventions;
  document.getElementById('s-minutes').textContent = stats.distractingMinutes;
  document.getElementById('s-exited').textContent = stats.exited;

  // Focus score: % of interventions where user went back (exited) vs continued
  const scoreEl = document.getElementById('s-score');
  const scoreBar = document.getElementById('s-score-bar');
  const scoreSub = document.getElementById('s-score-sub');
  if (scoreEl) {
    const interventions = stats.interventions || 0;
    const exited = stats.exited || 0;
    if (interventions === 0) {
      scoreEl.textContent = '—';
      scoreBar.style.width = '0%';
      scoreSub.textContent = 'No interventions yet today';
    } else {
      const score = Math.round((exited / interventions) * 100);
      scoreEl.textContent = score + '%';
      scoreBar.style.width = score + '%';
      scoreSub.textContent = exited + ' of ' + interventions + ' times you chose to leave';
      scoreEl.style.color = score >= 70 ? '#4ade80' : score >= 40 ? '#fbbf24' : '#f87171';
      scoreBar.style.background = score >= 70
        ? 'linear-gradient(90deg,#4ade80,#86efac)'
        : score >= 40
          ? 'linear-gradient(90deg,#f59e0b,#fbbf24)'
          : 'linear-gradient(90deg,#ef4444,#f87171)';
    }
  }

  // Streak
  const streakEl = document.getElementById('s-streak');
  if (streakEl) streakEl.textContent = calcStreak(settings.stats || {});

  renderWeeklyChart(settings.stats || {});

  // Windows summary
  const winContainer = document.getElementById('dash-windows');
  const windows = settings.focusWindows || [];
  if (!windows.length) {
    winContainer.innerHTML = '<div class="dash-empty">No focus windows configured</div>';
  } else {
    winContainer.innerHTML = windows.map(w => {
      const active = isWindowActive(w);
      return '<div class="dash-window-row">' +
        '<span class="dash-window-dot ' + (active ? 'on' : 'off') + '"></span>' +
        '<span class="dash-window-label">' + (w.label || 'Focus') + '</span>' +
        '<span class="dash-window-time">' + w.start + ' – ' + w.end + '</span>' +
      '</div>';
    }).join('');
  }

  // Binge summary
  const bingeContainer = document.getElementById('dash-binge');
  const rules = (settings.bingeRules || []).filter(r => r.enabled);
  if (!rules.length) {
    bingeContainer.innerHTML = '<div class="dash-empty">No binge rules configured</div>';
  } else {
    const usage = settings.bingeUsage || {};
    bingeContainer.innerHTML = rules.map(r => {
      const limitSecs = r.limitSecs || (r.limitMins || 5) * 60;
      const domainUsage = (usage[r.domain] || []);
      const cutoff = Date.now() - r.windowHours * 3600 * 1000;
      const usedSecs = domainUsage.filter(e => e.ts > cutoff).reduce((s, e) => s + (e.secs || (e.mins || 0) * 60), 0);
      const pct = Math.min(usedSecs / limitSecs, 1);
      const cls = pct >= 0.9 ? 'red' : pct >= 0.75 ? 'amber' : '';
      return '<div class="dash-binge-row">' +
        '<span class="dash-binge-domain">' + r.domain + '</span>' +
        '<div class="dash-binge-bar-wrap"><div class="dash-binge-bar-fill ' + cls + '" style="width:' + Math.round(pct * 100) + '%"></div></div>' +
        '<span class="dash-binge-limit">' + formatSecs(usedSecs) + ' / ' + formatSecs(limitSecs) + '</span>' +
      '</div>';
    }).join('');
  }
}

// ── Focus Windows ──
function renderWindows(windows) {
  const container = document.getElementById('windows-list');
  container.innerHTML = '';
  if (!windows || windows.length === 0) {
    container.innerHTML = '<p class="empty-hint">No focus windows yet. Click "+ Add Window" to create one.</p>';
    return;
  }
  windows.forEach((w, idx) => {
    const row = document.createElement('div');
    row.className = 'window-row';
    row.innerHTML =
      '<label class="switch">' +
        '<input type="checkbox" class="w-enabled" ' + (w.enabled ? 'checked' : '') + '/>' +
        '<span class="slider"></span>' +
      '</label>' +
      '<input type="text" class="w-label input-inline" value="' + (w.label || 'Focus') + '" placeholder="Label" maxlength="16" />' +
      '<input type="time" class="w-start input-inline" value="' + w.start + '" />' +
      '<span class="time-sep">→</span>' +
      '<input type="time" class="w-end input-inline" value="' + w.end + '" />' +
      '<button class="btn-save-row">Save</button>' +
      '<button class="btn-del-row" title="Remove">🗑</button>';
    container.appendChild(row);

    row.querySelector('.btn-save-row').addEventListener('click', async () => {
      const s = await getSettings();
      const wins = s.focusWindows || [];
      wins[idx] = {
        id: w.id,
        enabled: row.querySelector('.w-enabled').checked,
        label: row.querySelector('.w-label').value.trim() || 'Focus',
        start: row.querySelector('.w-start').value,
        end: row.querySelector('.w-end').value
      };
      await setSetting('focusWindows', wins);
      await setSetting('_userConfigured', true);
      updateLiveStatus(wins);
      showStatus('windows-status', 'Saved!');
      renderDashboard(await getSettings());
    });

    row.querySelector('.btn-del-row').addEventListener('click', async () => {
      const s = await getSettings();
      const wins = (s.focusWindows || []).filter((_, i) => i !== idx);
      await setSetting('focusWindows', wins);
      await setSetting('_userConfigured', true);
      updateLiveStatus(wins);
      renderWindows(wins);
      renderDashboard(await getSettings());
    });
  });
}

// ── Binge Rules ──
function renderBingeRules(rules, usage) {
  const container = document.getElementById('binge-rules-list');
  container.innerHTML = '';
  if (!rules || rules.length === 0) {
    container.innerHTML = '<p class="empty-hint">No binge rules yet. Click "+ Add Rule" to create one.</p>';
    return;
  }
  rules.forEach((rule, idx) => {
    const limitSecs = rule.limitSecs || (rule.limitMins || 5) * 60;
    const { m: limitM, s: limitS } = secsToDisplay(limitSecs);
    const domainUsage = (usage || {})[rule.domain] || [];
    const cutoff = Date.now() - rule.windowHours * 3600 * 1000;
    const usedSecs = domainUsage.filter(e => e.ts > cutoff).reduce((s, e) => s + (e.secs || (e.mins || 0) * 60), 0);
    const pct = Math.min(usedSecs / limitSecs, 1);
    const blocked = usedSecs >= limitSecs;

    const row = document.createElement('div');
    row.className = 'binge-rule-row' + (blocked ? ' blocked' : '');
    row.innerHTML =
      '<div class="binge-rule-top">' +
        '<label class="switch"><input type="checkbox" class="br-enabled" ' + (rule.enabled ? 'checked' : '') + '/><span class="slider"></span></label>' +
        '<input type="text" class="br-domain input-inline" value="' + rule.domain + '" placeholder="instagram.com" style="width:150px" />' +
        '<div class="binge-rule-limits">' +
          '<span class="binge-limit-label">Block after</span>' +
          '<input type="number" class="br-limit-m input-num" value="' + limitM + '" min="0" max="480" />' +
          '<span class="binge-limit-label">m</span>' +
          '<input type="number" class="br-limit-s input-num" value="' + limitS + '" min="0" max="59" />' +
          '<span class="binge-limit-label">s in</span>' +
          '<input type="number" class="br-window input-num" value="' + rule.windowHours + '" min="1" max="24" />' +
          '<span class="binge-limit-label">hr</span>' +
        '</div>' +
        '<button class="btn-save-row">Save</button>' +
        '<button class="btn-del-row" title="Remove">🗑</button>' +
      '</div>' +
      '<div class="binge-usage-bar"><div class="binge-usage-fill ' + (blocked ? 'red' : pct >= 0.75 ? 'amber' : '') + '" style="width:' + Math.round(pct * 100) + '%"></div></div>' +
      '<div class="binge-usage-label">' +
        '<span>' + formatSecs(usedSecs) + ' / ' + formatSecs(limitSecs) + ' used this ' + rule.windowHours + 'h window</span>' +
        (blocked ? '<span class="binge-blocked-badge">BLOCKED</span>' : '') +
        '<button class="btn-reset-usage" data-domain="' + rule.domain + '">Reset usage</button>' +
      '</div>';

    container.appendChild(row);

    row.querySelector('.btn-save-row').addEventListener('click', async () => {
      const s = await getSettings();
      const rs = s.bingeRules || [];
      const ls = displayToSecs(row.querySelector('.br-limit-m').value, row.querySelector('.br-limit-s').value);
      if (ls <= 0) { showStatus('binge-status', 'Limit must be > 0', true); return; }
      rs[idx] = {
        id: rule.id,
        enabled: row.querySelector('.br-enabled').checked,
        domain: row.querySelector('.br-domain').value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase(),
        limitSecs: ls,
        windowHours: parseInt(row.querySelector('.br-window').value) || 1
      };
      await setSetting('bingeRules', rs);
      await setSetting('_userConfigured', true);
      showStatus('binge-status', 'Saved!');
      renderBingeRules(rs, s.bingeUsage);
      renderDashboard(await getSettings());
    });

    row.querySelector('.btn-del-row').addEventListener('click', async () => {
      const s = await getSettings();
      const rs = (s.bingeRules || []).filter((_, i) => i !== idx);
      await setSetting('bingeRules', rs);
      renderBingeRules(rs, s.bingeUsage);
      renderDashboard(await getSettings());
    });

    row.querySelector('.btn-reset-usage').addEventListener('click', async () => {
      const s = await getSettings();
      const u = s.bingeUsage || {};
      delete u[rule.domain];
      await setSetting('bingeUsage', u);
      showStatus('binge-status', 'Usage reset.');
      renderBingeRules(s.bingeRules, u);
      renderDashboard(await getSettings());
    });
  });
}

function renderWhitelist(list) {
  const ul = document.getElementById('whitelist-list');
  ul.innerHTML = '';
  list.forEach(domain => {
    const li = document.createElement('li');
    li.className = 'tag';
    li.innerHTML = '<span>' + domain + '</span><button class="tag-remove" data-domain="' + domain + '">&times;</button>';
    ul.appendChild(li);
  });
  ul.querySelectorAll('.tag-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { whitelist } = await getSettings();
      const updated = whitelist.filter(d => d !== btn.dataset.domain);
      await setSetting('whitelist', updated);
      renderWhitelist(updated);
    });
  });
}

async function updatePausedBanner() {
  const data = await new Promise(r => chrome.storage.local.get({ pauseUntil: 0 }, r));
  const banner = document.getElementById('paused-banner');
  const timeEl = document.getElementById('paused-banner-time');
  const remaining = data.pauseUntil - Date.now();
  if (remaining > 0) {
    const mins = Math.ceil(remaining / 60000);
    banner.style.display = 'flex';
    timeEl.textContent = mins + ' min remaining';
  } else {
    banner.style.display = 'none';
  }
}

async function init() {
  const settings = await getSettings();

  initNav();
  updateLiveStatus(settings.focusWindows);
  updatePausedBanner();
  renderDashboard(settings);
  renderWindows(settings.focusWindows);
  renderBingeRules(settings.bingeRules, settings.bingeUsage);
  renderWhitelist(settings.whitelist);

  // Mode
  const modeRadio = document.querySelector('input[name="mode"][value="' + settings.interventionMode + '"]');
  if (modeRadio) modeRadio.checked = true;

  // API key
  document.getElementById('api-key').value = settings.apiKey || '';

  // ── Listeners ──
  document.getElementById('toggle-key').addEventListener('click', () => {
    const inp = document.getElementById('api-key');
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });

  document.getElementById('save-api-key').addEventListener('click', async () => {
    const key = document.getElementById('api-key').value.trim();
    if (!key) { showStatus('api-key-status', 'Enter a key first.', true); return; }
    await setSetting('apiKey', key);
    await setSetting('_userConfigured', true);
    showStatus('api-key-status', 'Saved!');
  });

  document.getElementById('add-window').addEventListener('click', async () => {
    const s = await getSettings();
    const wins = s.focusWindows || [];
    wins.push({ id: uid(), enabled: true, start: '09:00', end: '17:00', label: 'Focus ' + (wins.length + 1) });
    await setSetting('focusWindows', wins);
    renderWindows(wins);
    updateLiveStatus(wins);
  });

  document.getElementById('add-binge-rule').addEventListener('click', async () => {
    const s = await getSettings();
    const rules = s.bingeRules || [];
    rules.push({ id: uid(), enabled: true, domain: '', limitSecs: 300, windowHours: 1 });
    await setSetting('bingeRules', rules);
    renderBingeRules(rules, s.bingeUsage);
    setTimeout(() => {
      const inputs = document.querySelectorAll('.br-domain');
      if (inputs.length) inputs[inputs.length - 1].focus();
    }, 50);
  });

  document.getElementById('save-mode').addEventListener('click', async () => {
    const mode = document.querySelector('input[name="mode"]:checked')?.value || 'both';
    await setSetting('interventionMode', mode);
    await setSetting('_userConfigured', true);
    showStatus('mode-status', 'Saved!');
  });

  document.getElementById('add-whitelist').addEventListener('click', async () => {
    const input = document.getElementById('whitelist-input');
    const domain = input.value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
    if (!domain) return;
    const { whitelist } = await getSettings();
    if (!whitelist.includes(domain)) {
      whitelist.push(domain);
      await setSetting('whitelist', whitelist);
      renderWhitelist(whitelist);
    }
    input.value = '';
  });

  document.getElementById('whitelist-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('add-whitelist').click();
  });

  document.getElementById('export-btn').addEventListener('click', async () => {
    const s = await getSettings();
    const exportData = {
      focusWindows: s.focusWindows,
      interventionMode: s.interventionMode,
      whitelist: s.whitelist,
      bingeRules: s.bingeRules
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'adb-settings.json';
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById('import-input').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const allowed = ['focusWindows', 'interventionMode', 'whitelist', 'bingeRules'];
      const patch = {};
      allowed.forEach(k => { if (data[k] !== undefined) patch[k] = data[k]; });
      patch._userConfigured = true;
      await new Promise(r => chrome.storage.local.set(patch, r));
      showStatus('reset-status', 'Imported!');
      const s = await getSettings();
      updateLiveStatus(s.focusWindows);
      renderDashboard(s);
      renderWindows(s.focusWindows);
      renderBingeRules(s.bingeRules, s.bingeUsage);
      renderWhitelist(s.whitelist);
    } catch {
      showStatus('reset-status', 'Invalid file.', true);
    }
    e.target.value = '';
  });

  document.getElementById('copy-debug-btn').addEventListener('click', async () => {
    const s = await getSettings();
    const debug = {
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      focusWindows: s.focusWindows,
      interventionMode: s.interventionMode,
      bingeRules: (s.bingeRules || []).map(r => ({ ...r })),
      whitelist: s.whitelist,
      pauseUntil: s.pauseUntil,
      statsKeys: Object.keys(s.stats || {}),
      bingeUsageDomains: Object.keys(s.bingeUsage || {}),
      hasApiKey: !!s.apiKey
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(debug, null, 2));
      showStatus('reset-status', 'Debug info copied!');
    } catch {
      showStatus('reset-status', 'Copy failed.', true);
    }
  });

  document.getElementById('reset-stats-btn').addEventListener('click', async () => {
    if (!confirm('Clear all stats? This cannot be undone.')) return;
    await setSetting('stats', {});
    renderDashboard(await getSettings());
    showStatus('reset-status', 'Stats cleared.');
  });

  document.getElementById('paused-banner-resume').addEventListener('click', async () => {
    await new Promise(r => chrome.storage.local.set({ pauseUntil: 0 }, r));
    updatePausedBanner();
    updateLiveStatus(settings.focusWindows);
  });

  // Refresh every 30s — skip binge re-render if user is actively editing
  setInterval(async () => {
    const s = await getSettings();
    updateLiveStatus(s.focusWindows);
    updatePausedBanner();
    renderDashboard(s);
    const editing = document.activeElement && document.activeElement.closest('.binge-rule-row');
    if (!editing) renderBingeRules(s.bingeRules, s.bingeUsage);
  }, 30000);
}

init();
