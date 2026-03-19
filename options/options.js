// AI Distraction Blocker — Options v4

const DEFAULTS = {
  focusWindows: [{ id: "1", enabled: true, start: "09:00", end: "17:00", label: "Work", days: [1,2,3,4,5], blockedDomains: [] }],
  interventionMode: "both",
  whitelist: ["github.com", "stackoverflow.com", "docs.google.com", "notion.so", "figma.com"],
  pathWhitelist: [],
  bingeRules: [],
  bingeUsage: {},
  strictBlocking: false,
  pendingBingeRules: {},
  pendingFocusWindowChanges: {},
  escalationBlocks: {},
  theme: 'default',
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
  const day = now.getDay();
  const days = w.days && w.days.length > 0 ? w.days : [0,1,2,3,4,5,6];
  if (!days.includes(day)) return false;
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = w.start.split(':').map(Number);
  const [eh, em] = w.end.split(':').map(Number);
  return nowMins >= sh * 60 + sm && nowMins < eh * 60 + em;
}

function isInAnyWindow(windows) {
  return (windows || []).some(isWindowActive);
}

function isDomainBlocked(domain, settings) {
  const rules = settings.bingeRules || [];
  const usage = settings.bingeUsage || {};
  const rule = rules.find(r => r.enabled && (domain === r.domain || domain.startsWith(r.domain)));
  if (!rule) return false;
  const limitSecs = rule.limitSecs || (rule.limitMins || 5) * 60;
  const cutoff = Date.now() - rule.windowHours * 3600 * 1000;
  const usedSecs = (usage[rule.domain] || [])
    .filter(e => e.ts > cutoff)
    .reduce((s, e) => s + (e.secs || (e.mins || 0) * 60), 0);
  return usedSecs >= limitSecs;
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
const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function renderWindows(windows, strict, pendingFW) {
  const container = document.getElementById('windows-list');
  container.innerHTML = '';
  if (!windows || windows.length === 0) {
    container.innerHTML = '<p class="empty-hint">No focus windows yet. Click "+ Add Window" to create one.</p>';
    return;
  }
  windows.forEach((w, idx) => {
    const active = isWindowActive(w);
    const locked = strict && active;
    const hasPending = pendingFW && pendingFW[w.id];
    const disabledAttr = locked ? ' disabled' : '';
    const days = w.days && w.days.length > 0 ? w.days : [0,1,2,3,4,5,6];
    const blockedDomains = (w.blockedDomains || []).join(', ');

    const row = document.createElement('div');
    row.className = 'window-row' + (locked ? ' strict-locked' : '');
    row.innerHTML =
      '<div class="window-row-top">' +
        '<label class="switch">' +
          '<input type="checkbox" class="w-enabled"' + disabledAttr + (w.enabled ? ' checked' : '') + '/>' +
          '<span class="slider"></span>' +
        '</label>' +
        '<input type="text" class="w-label input-inline"' + disabledAttr + ' value="' + (w.label || 'Focus') + '" placeholder="Label" maxlength="16" />' +
        '<input type="time" class="w-start input-inline"' + disabledAttr + ' value="' + w.start + '" />' +
        '<span class="time-sep">→</span>' +
        '<input type="time" class="w-end input-inline"' + disabledAttr + ' value="' + w.end + '" />' +
        (locked ? '' : '<button class="btn-save-row">Save</button>') +
        (locked ? '' : '<button class="btn-del-row" title="Remove">🗑</button>') +
        (locked ? '<button class="btn-save-row btn-queue-save">Queue Change</button>' : '') +
      '</div>' +
      '<div class="window-row-days">' +
        DAY_NAMES.map((d, i) =>
          '<label class="day-pill' + (days.includes(i) ? ' active' : '') + '">' +
            '<input type="checkbox" class="w-day" data-day="' + i + '"' + disabledAttr + (days.includes(i) ? ' checked' : '') + ' />' +
            d +
          '</label>'
        ).join('') +
      '</div>' +
      '<div class="window-row-domains">' +
        '<span class="window-domains-label">Block these sites (leave empty to block all distracting sites):</span>' +
        '<input type="text" class="w-blocked-domains input-inline"' + disabledAttr + ' value="' + blockedDomains + '" placeholder="e.g. reddit.com, twitter.com" style="width:100%;margin-top:6px" />' +
      '</div>' +
      (hasPending ? '<div class="strict-lock-msg">⏳ Change queued — applies when window ends</div>' : '') +
      (locked ? '<div class="strict-lock-msg">🔒 Strict mode — window is active, changes queued</div>' : '');

    container.appendChild(row);

    function collectWindowData() {
      const selectedDays = [...row.querySelectorAll('.w-day:checked')].map(el => parseInt(el.dataset.day));
      const rawDomains = row.querySelector('.w-blocked-domains').value;
      const domainList = rawDomains.split(',').map(d => d.trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase()).filter(Boolean);
      return {
        id: w.id,
        enabled: row.querySelector('.w-enabled').checked,
        label: row.querySelector('.w-label').value.trim() || 'Focus',
        start: row.querySelector('.w-start').value,
        end: row.querySelector('.w-end').value,
        days: selectedDays.length > 0 ? selectedDays : [0,1,2,3,4,5,6],
        blockedDomains: domainList
      };
    }

    const saveBtn = row.querySelector('.btn-save-row:not(.btn-queue-save)');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const s = await getSettings();
        const wins = s.focusWindows || [];
        wins[idx] = collectWindowData();
        await setSetting('focusWindows', wins);
        await setSetting('_userConfigured', true);
        updateLiveStatus(wins);
        showStatus('windows-status', 'Saved!');
        renderWindows(wins, s.strictBlocking, s.pendingFocusWindowChanges);
        renderDashboard(await getSettings());
      });
    }

    const queueBtn = row.querySelector('.btn-queue-save');
    if (queueBtn) {
      queueBtn.addEventListener('click', async () => {
        const s = await getSettings();
        const updated = collectWindowData();
        const p = s.pendingFocusWindowChanges || {};
        p[w.id] = { action: 'update', window: updated };
        await setSetting('pendingFocusWindowChanges', p);
        showStatus('windows-status', 'Strict mode: change queued — applies when window ends.');
        renderWindows(s.focusWindows, s.strictBlocking, p);
      });
    }

    const delBtn = row.querySelector('.btn-del-row');
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        const s = await getSettings();
        if (s.strictBlocking && isWindowActive(w)) {
          const p = s.pendingFocusWindowChanges || {};
          p[w.id] = { action: 'delete' };
          await setSetting('pendingFocusWindowChanges', p);
          showStatus('windows-status', 'Strict mode: deletion queued — applies when window ends.');
          renderWindows(s.focusWindows, s.strictBlocking, p);
        } else {
          const wins = (s.focusWindows || []).filter((_, i) => i !== idx);
          await setSetting('focusWindows', wins);
          await setSetting('_userConfigured', true);
          updateLiveStatus(wins);
          renderWindows(wins, s.strictBlocking, s.pendingFocusWindowChanges);
          renderDashboard(await getSettings());
        }
      });
    }

    // Day pill toggle (visual only — actual value read on save)
    row.querySelectorAll('.w-day').forEach(cb => {
      cb.addEventListener('change', () => {
        cb.closest('.day-pill').classList.toggle('active', cb.checked);
      });
    });
  });
}

// ── Binge Rules ──
function renderBingeRules(rules, usage, strict, pending) {
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
    const hasPending = pending && pending[rule.domain];
    // In strict mode, inputs are locked while the domain is currently blocked
    const locked = strict && blocked;
    const disabledAttr = locked ? ' disabled' : '';

    const row = document.createElement('div');
    row.className = 'binge-rule-row' + (blocked ? ' blocked' : '') + (locked ? ' strict-locked' : '');
    row.innerHTML =
      '<div class="binge-rule-top">' +
        '<label class="switch"><input type="checkbox" class="br-enabled"' + disabledAttr + ' ' + (rule.enabled ? 'checked' : '') + '/><span class="slider"></span></label>' +
        '<input type="text" class="br-domain input-inline"' + disabledAttr + ' value="' + rule.domain + '" placeholder="instagram.com" style="width:150px" />' +
        '<div class="binge-rule-limits">' +
          '<span class="binge-limit-label">Block after</span>' +
          '<input type="number" class="br-limit-m input-num"' + disabledAttr + ' value="' + limitM + '" min="0" max="480" />' +
          '<span class="binge-limit-label">m</span>' +
          '<input type="number" class="br-limit-s input-num"' + disabledAttr + ' value="' + limitS + '" min="0" max="59" />' +
          '<span class="binge-limit-label">s in</span>' +
          '<input type="number" class="br-window input-num"' + disabledAttr + ' value="' + rule.windowHours + '" min="1" max="24" />' +
          '<span class="binge-limit-label">hr</span>' +
        '</div>' +
        '<button class="btn-save-row">Save</button>' +
        (locked ? '' : '<button class="btn-del-row" title="Remove">🗑</button>') +
      '</div>' +
      '<div class="binge-usage-bar"><div class="binge-usage-fill ' + (blocked ? 'red' : pct >= 0.75 ? 'amber' : '') + '" style="width:' + Math.round(pct * 100) + '%"></div></div>' +
      '<div class="binge-usage-label">' +
        '<span>' + formatSecs(usedSecs) + ' / ' + formatSecs(limitSecs) + ' used this ' + rule.windowHours + 'h window</span>' +
        (blocked ? '<span class="binge-blocked-badge">BLOCKED</span>' : '') +
        (hasPending ? '<span class="binge-pending-badge">Change pending after block</span>' : '') +
        (locked ? '' : '<button class="btn-reset-usage" data-domain="' + rule.domain + '">Reset usage</button>') +
      '</div>' +
      (locked ? '<div class="strict-lock-msg">🔒 Strict mode — changes apply after this block expires</div>' : '');

    container.appendChild(row);

    row.querySelector('.btn-save-row').addEventListener('click', async () => {
      const s = await getSettings();
      const rs = s.bingeRules || [];
      const ls = displayToSecs(row.querySelector('.br-limit-m').value, row.querySelector('.br-limit-s').value);
      if (ls <= 0) { showStatus('binge-status', 'Limit must be > 0', true); return; }
      const updated = {
        id: rule.id,
        enabled: row.querySelector('.br-enabled').checked,
        domain: row.querySelector('.br-domain').value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase(),
        limitSecs: ls,
        windowHours: parseInt(row.querySelector('.br-window').value) || 1
      };

      if (s.strictBlocking && blocked) {
        // Queue the change — apply after block expires
        const p = s.pendingBingeRules || {};
        p[rule.domain] = { action: 'update', rule: updated };
        await setSetting('pendingBingeRules', p);
        showStatus('binge-status', 'Strict mode: change queued — will apply when block expires.');
        renderBingeRules(rs, s.bingeUsage, s.strictBlocking, p);
      } else {
        rs[idx] = updated;
        await setSetting('bingeRules', rs);
        await setSetting('_userConfigured', true);
        showStatus('binge-status', 'Saved!');
        renderBingeRules(rs, s.bingeUsage, s.strictBlocking, s.pendingBingeRules);
        renderDashboard(await getSettings());
      }
    });

    const delBtn = row.querySelector('.btn-del-row');
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        const s = await getSettings();
        if (s.strictBlocking && blocked) {
          // Queue deletion
          const p = s.pendingBingeRules || {};
          p[rule.domain] = { action: 'delete' };
          await setSetting('pendingBingeRules', p);
          showStatus('binge-status', 'Strict mode: deletion queued — will apply when block expires.');
          renderBingeRules(s.bingeRules, s.bingeUsage, s.strictBlocking, p);
        } else {
          const rs = (s.bingeRules || []).filter((_, i) => i !== idx);
          await setSetting('bingeRules', rs);
          renderBingeRules(rs, s.bingeUsage, s.strictBlocking, s.pendingBingeRules);
          renderDashboard(await getSettings());
        }
      });
    }

    const resetBtn = row.querySelector('.btn-reset-usage');
    if (resetBtn) {
      resetBtn.addEventListener('click', async () => {
        const s = await getSettings();
        if (s.strictBlocking && blocked) {
          showStatus('binge-status', 'Strict mode: cannot reset usage while blocked.', true);
          return;
        }
        const u = s.bingeUsage || {};
        delete u[rule.domain];
        await setSetting('bingeUsage', u);
        showStatus('binge-status', 'Usage reset.');
        renderBingeRules(s.bingeRules, u, s.strictBlocking, s.pendingBingeRules);
        renderDashboard(await getSettings());
      });
    }
  });
}

function renderWhitelist(list, pathList) {
  const ul = document.getElementById('whitelist-list');
  ul.innerHTML = '';

  // Domain entries
  (list || []).forEach(domain => {
    const li = document.createElement('li');
    li.className = 'tag';
    li.innerHTML = '<span>' + domain + '</span><button class="tag-remove" data-domain="' + domain + '" data-type="domain">&times;</button>';
    ul.appendChild(li);
  });

  // Path entries
  (pathList || []).forEach((entry, idx) => {
    const pattern = entry.pattern || entry;
    const label = entry.label ? ' <em>(' + entry.label + ')</em>' : '';
    const li = document.createElement('li');
    li.className = 'tag tag-path';
    li.innerHTML = '<span class="tag-path-icon">⤷</span><span>' + pattern + label + '</span><button class="tag-remove" data-idx="' + idx + '" data-type="path">&times;</button>';
    ul.appendChild(li);
  });

  ul.querySelectorAll('.tag-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const s = await getSettings();
      if (btn.dataset.type === 'path') {
        const updated = (s.pathWhitelist || []).filter((_, i) => i !== parseInt(btn.dataset.idx));
        await setSetting('pathWhitelist', updated);
        renderWhitelist(s.whitelist, updated);
      } else {
        const updated = s.whitelist.filter(d => d !== btn.dataset.domain);
        await setSetting('whitelist', updated);
        renderWhitelist(updated, s.pathWhitelist);
      }
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
  renderWindows(settings.focusWindows, settings.strictBlocking, settings.pendingFocusWindowChanges);
  renderBingeRules(settings.bingeRules, settings.bingeUsage, settings.strictBlocking, settings.pendingBingeRules);
  renderWhitelist(settings.whitelist, settings.pathWhitelist);

  // Mode
  const modeRadio = document.querySelector('input[name="mode"][value="' + settings.interventionMode + '"]');
  if (modeRadio) modeRadio.checked = true;

  // Strict blocking toggle
  const strictToggle = document.getElementById('strict-blocking-toggle');
  if (strictToggle) {
    strictToggle.checked = !!settings.strictBlocking;
    strictToggle.addEventListener('change', async () => {
      await setSetting('strictBlocking', strictToggle.checked);
      await setSetting('_userConfigured', true);
      showStatus('binge-status', strictToggle.checked ? 'Strict blocking enabled.' : 'Strict blocking disabled.');
      const s = await getSettings();
      renderBingeRules(s.bingeRules, s.bingeUsage, s.strictBlocking, s.pendingBingeRules);
    });
  }

  // Theme picker
  const applyThemeClass = (theme) => {
    document.documentElement.className = document.documentElement.className
      .replace(/adb-theme-\S+/g, '').trim();
    if (theme && theme !== 'default') {
      document.documentElement.classList.add('adb-theme-' + theme);
    }
  };

  applyThemeClass(settings.theme || 'default');

  const themeRadio = document.querySelector('input[name="theme"][value="' + (settings.theme || 'default') + '"]');
  if (themeRadio) themeRadio.checked = true;

  // Live preview on radio change
  document.querySelectorAll('input[name="theme"]').forEach(radio => {
    radio.addEventListener('change', () => applyThemeClass(radio.value));
  });

  document.getElementById('save-theme').addEventListener('click', async () => {
    const selected = document.querySelector('input[name="theme"]:checked');
    if (!selected) return;
    await setSetting('theme', selected.value);
    await setSetting('_userConfigured', true);
    showStatus('theme-status', 'Theme saved!');
  });

  // ── Listeners ──

  document.getElementById('add-window').addEventListener('click', async () => {
    const s = await getSettings();
    const wins = s.focusWindows || [];
    wins.push({ id: uid(), enabled: true, start: '09:00', end: '17:00', label: 'Focus ' + (wins.length + 1), days: [1,2,3,4,5], blockedDomains: [] });
    await setSetting('focusWindows', wins);
    renderWindows(wins, s.strictBlocking, s.pendingFocusWindowChanges);
    updateLiveStatus(wins);
  });

  document.getElementById('add-binge-rule').addEventListener('click', async () => {
    const s = await getSettings();
    const rules = s.bingeRules || [];
    rules.push({ id: uid(), enabled: true, domain: '', limitSecs: 300, windowHours: 1 });
    await setSetting('bingeRules', rules);
    renderBingeRules(rules, s.bingeUsage, s.strictBlocking, s.pendingBingeRules);
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
    const raw = input.value.trim().replace(/^https?:\/\//, '').replace(/^www\./, '').toLowerCase();
    if (!raw) return;
    const s = await getSettings();

    // Extract the domain part to check if it's currently binge-blocked
    const domainPart = raw.split('/')[0];
    if (isDomainBlocked(domainPart, s)) {
      showStatus('whitelist-status', 'Cannot whitelist — site is currently blocked by Binge Guard.', true);
      return;
    }

    if (raw.includes('/')) {
      const pathList = s.pathWhitelist || [];
      const already = pathList.some(e => (e.pattern || e) === raw);
      if (!already) {
        pathList.push({ pattern: raw, label: '' });
        await setSetting('pathWhitelist', pathList);
        await setSetting('_userConfigured', true);
        renderWhitelist(s.whitelist, pathList);
      }
    } else {
      const { whitelist } = s;
      if (!whitelist.includes(raw)) {
        whitelist.push(raw);
        await setSetting('whitelist', whitelist);
        await setSetting('_userConfigured', true);
        renderWhitelist(whitelist, s.pathWhitelist);
      }
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
      const allowed = ['focusWindows', 'interventionMode', 'whitelist', 'pathWhitelist', 'bingeRules'];
      const patch = {};
      allowed.forEach(k => { if (data[k] !== undefined) patch[k] = data[k]; });
      patch._userConfigured = true;
      await new Promise(r => chrome.storage.local.set(patch, r));
      showStatus('reset-status', 'Imported!');
      const s = await getSettings();
      updateLiveStatus(s.focusWindows);
      renderDashboard(s);
      renderWindows(s.focusWindows, s.strictBlocking, s.pendingFocusWindowChanges);
      renderBingeRules(s.bingeRules, s.bingeUsage, s.strictBlocking, s.pendingBingeRules);
      renderWhitelist(s.whitelist, s.pathWhitelist);
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

  // Re-render affected sections whenever storage changes
  const WATCH_KEYS = ['focusWindows','bingeRules','bingeUsage','whitelist','pathWhitelist',
    'interventionMode','strictBlocking','pendingBingeRules','pendingFocusWindowChanges',
    'stats','pauseUntil','theme'];
  let updateTimer = null;
  chrome.storage.onChanged.addListener((changes) => {
    const relevant = Object.keys(changes).some(k => WATCH_KEYS.includes(k));
    if (!relevant) return;
    clearTimeout(updateTimer);
    updateTimer = setTimeout(async () => {
      const s = await getSettings();
      updateLiveStatus(s.focusWindows);
      updatePausedBanner();
      renderDashboard(s);
      const editingBinge = document.activeElement && document.activeElement.closest('.binge-rule-row');
      if (!editingBinge) renderBingeRules(s.bingeRules, s.bingeUsage, s.strictBlocking, s.pendingBingeRules);
      const editingWindow = document.activeElement && document.activeElement.closest('.window-row');
      if (!editingWindow) renderWindows(s.focusWindows, s.strictBlocking, s.pendingFocusWindowChanges);
      renderWhitelist(s.whitelist, s.pathWhitelist);
      const modeRadio = document.querySelector('input[name="mode"][value="' + s.interventionMode + '"]');
      if (modeRadio) modeRadio.checked = true;
      const strictToggle = document.getElementById('strict-blocking-toggle');
      if (strictToggle) strictToggle.checked = !!s.strictBlocking;
      applyThemeClass(s.theme || 'default');
      const themeRadio = document.querySelector('input[name="theme"][value="' + (s.theme || 'default') + '"]');
      if (themeRadio) themeRadio.checked = true;
    }, 150);
  });
}

init();
