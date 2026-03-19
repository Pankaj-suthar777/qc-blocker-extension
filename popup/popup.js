const DEFAULTS = {
  focusWindows: [{ id: "1", enabled: true, start: "09:00", end: "17:00", label: "Work", days: [1,2,3,4,5], blockedDomains: [] }],
  interventionMode: "both",
  whitelist: ["github.com", "stackoverflow.com", "docs.google.com", "notion.so", "figma.com"],
  pathWhitelist: [],
  bingeRules: [],
  stats: {},
  pauseUntil: 0,
  theme: 'default',
  _userConfigured: false
};

function getSettings() {
  return new Promise(resolve => chrome.storage.local.get(DEFAULTS, resolve));
}

function isInAnyWindow(windows) {
  if (!windows || !windows.length) return false;
  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  return windows.some(w => {
    if (!w.enabled) return false;
    const [sh, sm] = w.start.split(':').map(Number);
    const [eh, em] = w.end.split(':').map(Number);
    return nowMins >= sh * 60 + sm && nowMins < eh * 60 + em;
  });
}

function isWindowActive(w) {
  if (!w.enabled) return false;
  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = w.start.split(':').map(Number);
  const [eh, em] = w.end.split(':').map(Number);
  return nowMins >= sh * 60 + sm && nowMins < eh * 60 + em;
}

async function init() {
  const settings = await getSettings();

  // Apply theme
  const theme = settings.theme || 'default';
  document.documentElement.className = document.documentElement.className
    .replace(/adb-theme-\S+/g, '').trim();
  if (theme !== 'default') document.documentElement.classList.add('adb-theme-' + theme);

  const today = new Date().toISOString().slice(0, 10);
  const stats = (settings.stats || {})[today] || { distractingMinutes: 0, interventions: 0, exited: 0 };

  // Stats
  document.getElementById('stat-interventions').textContent = stats.interventions;
  document.getElementById('stat-minutes').textContent = stats.distractingMinutes;
  document.getElementById('stat-exited').textContent = stats.exited;

  // Check if current tab is blocked and show indicator
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs[0];
    if (!tab || !tab.url || !tab.url.startsWith('http')) return;
    chrome.runtime.sendMessage({ type: 'GET_BINGE_STATUS', url: tab.url }, status => {
      if (chrome.runtime.lastError || !status || !status.blocked) return;
      const badge = document.getElementById('status-badge');
      badge.textContent = 'Site Blocked';
      badge.className = 'badge badge-blocked';
    });
  });

  // Status badge + pause button — single call
  const windows = settings.focusWindows || [];
  const badge = document.getElementById('status-badge');
  const active = isInAnyWindow(windows);
  const anyEnabled = windows.some(w => w.enabled);
  const pauseBtn = document.getElementById('pause-btn');
  const pauseLbl = document.getElementById('pause-btn-label');

  function updatePauseBtn(pauseUntil) {
    const remaining = pauseUntil - Date.now();
    if (remaining > 0) {
      const mins = Math.ceil(remaining / 60000);
      pauseLbl.textContent = 'Resume (paused ' + mins + 'm left)';
      pauseBtn.classList.add('active');
    } else {
      pauseLbl.textContent = 'Pause for 30 min';
      pauseBtn.classList.remove('active');
    }
  }

  chrome.runtime.sendMessage({ type: 'GET_PAUSE_STATUS' }, res => {
    const paused = res && res.paused;
    if (paused) {
      const mins = Math.ceil((res.pauseUntil - Date.now()) / 60000);
      badge.textContent = 'Paused · ' + mins + 'm left';
      badge.className = 'badge badge-paused';
    } else {
      badge.textContent = active ? 'Blocking Active' : (anyEnabled ? 'Outside Hours' : 'Disabled');
      badge.className = 'badge ' + (active ? 'badge-active' : 'badge-inactive');
    }
    updatePauseBtn(res ? res.pauseUntil || 0 : 0);
  });

  pauseBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'GET_PAUSE_STATUS' }, res => {
      if (res && res.paused) {
        chrome.runtime.sendMessage({ type: 'RESUME_BLOCKING' }, () => updatePauseBtn(0));
      } else {
        chrome.runtime.sendMessage({ type: 'PAUSE_BLOCKING', minutes: 30 }, r => {
          if (r) updatePauseBtn(r.until);
        });
      }
    });
  });

  // Focus windows list
  const container = document.getElementById('windows-display');
  if (!windows.length) {
    container.innerHTML = '<div class="empty-hint">No focus windows configured</div>';
  } else {
    container.innerHTML = windows.map(w => {
      const now = isWindowActive(w);
      return '<div class="window-pill' + (!w.enabled ? ' disabled' : now ? ' active-now' : '') + '">' +
        '<span class="dot ' + (now ? 'dot-active' : 'dot-inactive') + '"></span>' +
        '<span class="window-label">' + (w.label || 'Focus') + '</span>' +
        '<span class="window-time">' + w.start + ' – ' + w.end + '</span>' +
      '</div>';
    }).join('');
  }

  // Binge rules summary
  const bingeRules = (settings.bingeRules || []).filter(r => r.enabled);
  if (bingeRules.length > 0) {
    const sec = document.createElement('div');
    sec.className = 'section';
    sec.innerHTML =
      '<div class="section-label">Binge Guard</div>' +
      '<div class="binge-summary">' +
        bingeRules.map(r => {
          const secs = r.limitSecs || (r.limitMins || 5) * 60;
          const m = Math.floor(secs / 60), s = secs % 60;
          const label = m && s ? m + 'm ' + s + 's' : m ? m + 'm' : s + 's';
          return '<span class="binge-pill">' + r.domain + ' · ' + label + '/' + r.windowHours + 'h</span>';
        }).join('') +
      '</div>';
    document.querySelector('.footer').before(sec);
  }

  // Binge status for current tab
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs[0];
    if (!tab || !tab.url || !tab.url.startsWith('http')) return;
    chrome.runtime.sendMessage({ type: 'GET_BINGE_STATUS', url: tab.url }, status => {
      if (chrome.runtime.lastError || !status) return;
      const sec = document.getElementById('binge-tab-section');
      const fill = document.getElementById('binge-tab-bar-fill');
      const used = document.getElementById('binge-tab-used');
      const left = document.getElementById('binge-tab-left');
      const usedSecs = status.usedSecs || 0;
      const limitSecs = status.limitSecs || 1;
      const pct = Math.min(usedSecs / limitSecs, 1);
      const remainSecs = Math.max(limitSecs - usedSecs, 0);
      function fmt(s) {
        const m = Math.floor(s / 60), sec = s % 60;
        if (m === 0) return sec + 's';
        if (sec === 0) return m + 'm';
        return m + 'm ' + sec + 's';
      }
      sec.style.display = 'block';
      fill.style.width = Math.round(pct * 100) + '%';
      if (pct >= 0.9) fill.classList.add('red');
      used.textContent = fmt(usedSecs) + ' / ' + fmt(limitSecs) + ' used';
      left.textContent = status.blocked ? 'Blocked' : fmt(remainSecs) + ' left';
      if (status.blocked || pct >= 0.9) left.classList.add('red');

      document.getElementById('binge-tab-reset').addEventListener('click', async () => {
        const s = await getSettings();
        const u = s.bingeUsage || {};
        delete u[status.domain];
        await new Promise(r => chrome.storage.local.set({ bingeUsage: u }, r));
        fill.style.width = '0%';
        fill.classList.remove('red');
        used.textContent = '0s / ' + fmt(limitSecs) + ' used';
        left.textContent = fmt(limitSecs) + ' left';
        left.classList.remove('red');
      });
    });
  });

  // Buttons
  document.getElementById('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
  document.getElementById('open-options-link').addEventListener('click', () => chrome.runtime.openOptionsPage());
}

init();
