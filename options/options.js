// qC Blocker Extension — Options v4

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
// ── Chart helpers ──
function getLast7Days(stats) {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const DAY_LABELS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    days.push({
      key,
      label: DAY_LABELS[d.getDay()],
      isToday: i === 0,
      interventions: (stats[key] || {}).interventions || 0,
      mins: (stats[key] || {}).distractingMinutes || 0,
      exited: (stats[key] || {}).exited || 0
    });
  }
  return days;
}

function getLast30Days(stats) {
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push((stats[key] || {}).interventions || 0);
  }
  return days;
}

// ── Interactive SVG weekly bar chart ──
function renderWeeklyChart(stats) {
  const container = document.getElementById('weekly-chart');
  if (!container) return;
  const days = getLast7Days(stats);
  const maxVal = Math.max(...days.map(d => d.interventions), 1);
  const W = 560, H = 140, PAD = 32, BAR_W = 36, GAP = (W - PAD * 2 - BAR_W * 7) / 6;

  let bars = '', labels = '', vals = '', tooltips = '';
  days.forEach((d, i) => {
    const x = PAD + i * (BAR_W + GAP);
    const barH = Math.max(Math.round((d.interventions / maxVal) * (H - 40)), 4);
    const y = H - 20 - barH;
    const score = d.interventions > 0 ? Math.round((d.exited / d.interventions) * 100) : null;
    const color = d.isToday ? 'var(--accent)' : 'rgba(245,158,11,0.35)';
    const hoverColor = d.isToday ? 'var(--accent)' : 'rgba(245,158,11,0.65)';

    bars += `<rect class="chart-bar" x="${x}" y="${y}" width="${BAR_W}" height="${barH}"
      rx="5" fill="${color}"
      data-hover="${hoverColor}"
      data-idx="${i}" />`;

    vals += d.interventions > 0
      ? `<text x="${x + BAR_W / 2}" y="${y - 5}" text-anchor="middle" class="chart-val">${d.interventions}</text>`
      : '';

    labels += `<text x="${x + BAR_W / 2}" y="${H - 4}" text-anchor="middle"
      class="chart-label${d.isToday ? ' today' : ''}">${d.isToday ? 'Today' : d.label}</text>`;

    // Tooltip box
    const tx = Math.min(x, W - 130);
    tooltips += `<g class="chart-tooltip" id="tip-${i}" style="display:none">
      <rect x="${tx}" y="${Math.max(y - 68, 2)}" width="120" height="62" rx="8"
        fill="var(--surface2)" stroke="var(--accent-border)" stroke-width="1"/>
      <text x="${tx + 10}" y="${Math.max(y - 68, 2) + 16}" class="tip-label">${d.isToday ? 'Today' : d.label + ' ' + d.key.slice(5)}</text>
      <text x="${tx + 10}" y="${Math.max(y - 68, 2) + 32}" class="tip-val">🛡 ${d.interventions} interventions</text>
      <text x="${tx + 10}" y="${Math.max(y - 68, 2) + 46}" class="tip-val">⏱ ${d.mins}m distracted</text>
      <text x="${tx + 10}" y="${Math.max(y - 68, 2) + 60}" class="tip-val">Score: ${score !== null ? score + '%' : '—'}</text>
    </g>`;
  });

  // Y-axis gridlines
  let grid = '';
  for (let i = 1; i <= 4; i++) {
    const y = H - 20 - Math.round((i / 4) * (H - 40));
    const v = Math.round((i / 4) * maxVal);
    grid += `<line x1="${PAD}" y1="${y}" x2="${W - PAD}" y2="${y}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>`;
    grid += `<text x="${PAD - 4}" y="${y + 4}" text-anchor="end" class="chart-axis">${v}</text>`;
  }

  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="chart-svg" id="weekly-svg">
    ${grid}${bars}${vals}${labels}${tooltips}
  </svg>`;

  // Hover interactions
  container.querySelectorAll('.chart-bar').forEach(bar => {
    const idx = bar.dataset.idx;
    const tip = container.querySelector('#tip-' + idx);
    bar.addEventListener('mouseenter', () => {
      bar.setAttribute('fill', bar.dataset.hover);
      if (tip) tip.style.display = '';
    });
    bar.addEventListener('mouseleave', () => {
      bar.setAttribute('fill', bar.dataset.idx == days.findIndex(d => d.isToday)
        ? 'var(--accent)' : 'rgba(245,158,11,0.35)');
      if (tip) tip.style.display = 'none';
    });
  });

  // Weekly table
  const tbody = document.getElementById('weekly-table-body');
  if (tbody) {
    tbody.innerHTML = days.map(d => {
      const score = d.interventions > 0 ? Math.round((d.exited / d.interventions) * 100) : null;
      const cls = score === null ? '' : score >= 70 ? 'green' : score >= 40 ? 'amber' : 'red';
      return `<tr${d.isToday ? ' class="today"' : ''}>
        <td>${d.isToday ? 'Today' : d.label + ' ' + d.key.slice(5)}</td>
        <td>${d.interventions || '—'}</td>
        <td>${d.mins || '—'}</td>
        <td>${d.exited || '—'}</td>
        <td><span class="score-cell ${cls}">${score !== null ? score + '%' : '—'}</span></td>
      </tr>`;
    }).join('');
  }
}

// ── 30-day sparkline ──
function renderSparkline(stats) {
  const container = document.getElementById('sparkline-chart');
  if (!container) return;
  const vals = getLast30Days(stats);
  const max = Math.max(...vals, 1);
  const W = 560, H = 60, PAD = 8;
  const step = (W - PAD * 2) / (vals.length - 1);

  const points = vals.map((v, i) => {
    const x = PAD + i * step;
    const y = H - PAD - Math.round((v / max) * (H - PAD * 2));
    return `${x},${y}`;
  }).join(' ');

  // Fill area under line
  const firstX = PAD, lastX = PAD + (vals.length - 1) * step;
  const fillPoints = `${firstX},${H - PAD} ${points} ${lastX},${H - PAD}`;

  // Dots for non-zero days
  const dots = vals.map((v, i) => {
    if (!v) return '';
    const x = PAD + i * step;
    const y = H - PAD - Math.round((v / max) * (H - PAD * 2));
    return `<circle cx="${x}" cy="${y}" r="3" fill="var(--accent)" class="spark-dot" data-val="${v}" data-idx="${i}"/>`;
  }).join('');

  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="chart-svg sparkline-svg">
    <defs>
      <linearGradient id="spark-grad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.25"/>
        <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <polygon points="${fillPoints}" fill="url(#spark-grad)"/>
    <polyline points="${points}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}
  </svg>`;

  // Dot tooltips
  container.querySelectorAll('.spark-dot').forEach(dot => {
    dot.addEventListener('mouseenter', e => {
      const tip = document.getElementById('spark-tip');
      if (tip) {
        const daysAgo = 29 - parseInt(dot.dataset.idx);
        tip.textContent = (daysAgo === 0 ? 'Today' : daysAgo + 'd ago') + ': ' + dot.dataset.val + ' interventions';
        tip.style.display = 'block';
      }
    });
    dot.addEventListener('mouseleave', () => {
      const tip = document.getElementById('spark-tip');
      if (tip) tip.style.display = 'none';
    });
  });
}

// ── Today's donut chart ──
function renderDonut(interventions, exited, mins) {
  const container = document.getElementById('donut-chart');
  if (!container) return;
  const R = 52, CX = 70, CY = 70, STROKE = 14;
  const circ = 2 * Math.PI * R;

  function arc(pct, color, offset) {
    const dash = pct * circ;
    return `<circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="${color}"
      stroke-width="${STROKE}" stroke-dasharray="${dash} ${circ}"
      stroke-dashoffset="${-offset * circ}" stroke-linecap="round"
      transform="rotate(-90 ${CX} ${CY})"/>`;
  }

  const continued = Math.max(interventions - exited, 0);
  const total = interventions || 1;
  const exitedPct = exited / total;
  const continuedPct = continued / total;

  const score = interventions > 0 ? Math.round((exited / interventions) * 100) : null;
  const scoreColor = score === null ? 'var(--text-dim)' : score >= 70 ? '#4ade80' : score >= 40 ? '#fbbf24' : '#f87171';

  container.innerHTML = `<svg viewBox="0 0 140 140" class="donut-svg">
    <circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="${STROKE}"/>
    ${interventions > 0 ? arc(exitedPct, '#4ade80', 0) : ''}
    ${interventions > 0 ? arc(continuedPct, '#f87171', exitedPct) : ''}
    <text x="${CX}" y="${CY - 8}" text-anchor="middle" class="donut-center-val" fill="${scoreColor}">
      ${score !== null ? score + '%' : '—'}
    </text>
    <text x="${CX}" y="${CY + 10}" text-anchor="middle" class="donut-center-label">score</text>
  </svg>
  <div class="donut-legend">
    <div class="donut-legend-row"><span class="donut-dot green"></span><span>${exited} exited</span></div>
    <div class="donut-legend-row"><span class="donut-dot red"></span><span>${continued} continued</span></div>
    <div class="donut-legend-row"><span class="donut-dot amber"></span><span>${mins}m distracted</span></div>
  </div>`;
}

// ── Binge radial arcs ──
function renderBingeRadials(rules, usage) {
  const container = document.getElementById('binge-radials');
  if (!container) return;
  if (!rules || rules.length === 0) {
    container.innerHTML = '<div class="dash-empty">No binge rules configured</div>';
    return;
  }
  const R = 28, STROKE = 7, CX = 36, CY = 36, circ = 2 * Math.PI * R;
  container.innerHTML = rules.filter(r => r.enabled).map(r => {
    const limitSecs = r.limitSecs || (r.limitMins || 5) * 60;
    const cutoff = Date.now() - r.windowHours * 3600 * 1000;
    const usedSecs = ((usage || {})[r.domain] || [])
      .filter(e => e.ts > cutoff)
      .reduce((s, e) => s + (e.secs || (e.mins || 0) * 60), 0);
    const pct = Math.min(usedSecs / limitSecs, 1);
    const dash = pct * circ;
    const color = pct >= 0.9 ? '#f87171' : pct >= 0.75 ? '#fbbf24' : 'var(--accent)';
    const blocked = usedSecs >= limitSecs;
    return `<div class="binge-radial-wrap">
      <svg viewBox="0 0 72 72" class="binge-radial-svg">
        <circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="rgba(255,255,255,0.07)" stroke-width="${STROKE}"/>
        <circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="${color}"
          stroke-width="${STROKE}" stroke-dasharray="${dash} ${circ}"
          stroke-dashoffset="0" stroke-linecap="round"
          transform="rotate(-90 ${CX} ${CY})"/>
        <text x="${CX}" y="${CY + 5}" text-anchor="middle" class="radial-pct" fill="${color}">
          ${Math.round(pct * 100)}%
        </text>
      </svg>
      <div class="binge-radial-label">${r.domain}</div>
      <div class="binge-radial-sub">${formatSecs(usedSecs)} / ${formatSecs(limitSecs)}${blocked ? ' 🔒' : ''}</div>
    </div>`;
  }).join('');
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

  // Focus score
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

  // Charts
  renderWeeklyChart(settings.stats || {});
  renderSparkline(settings.stats || {});
  renderDonut(stats.interventions || 0, stats.exited || 0, stats.distractingMinutes || 0);
  renderBingeRadials(settings.bingeRules, settings.bingeUsage);

  // Windows summary
  const winContainer = document.getElementById('dash-windows');
  const windows = settings.focusWindows || [];
  if (!windows.length) {
    winContainer.innerHTML = '<div class="dash-empty">No focus windows configured</div>';
  } else {
    winContainer.innerHTML = windows.map(w => {
      const active = isWindowActive(w);
      const days = (w.days && w.days.length > 0 ? w.days : [0,1,2,3,4,5,6]);
      const DAY_NAMES = ['Su','Mo','Tu','We','Th','Fr','Sa'];
      const dayPills = DAY_NAMES.map((d, i) =>
        `<span class="dash-day-pill${days.includes(i) ? ' on' : ''}">${d}</span>`
      ).join('');
      return '<div class="dash-window-row">' +
        '<span class="dash-window-dot ' + (active ? 'on' : 'off') + '"></span>' +
        '<div class="dash-window-info">' +
          '<span class="dash-window-label">' + (w.label || 'Focus') + '</span>' +
          '<span class="dash-window-time">' + w.start + ' – ' + w.end + '</span>' +
          '<div class="dash-day-pills">' + dayPills + '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  }
}

// ── Chip input helper ──
function initChipInput(wrap, initialDomains, disabled) {
  wrap.innerHTML = '';
  wrap.className = 'chip-input-wrap' + (disabled ? ' disabled' : '');

  function cleanDomain(raw) {
    return raw.trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase();
  }

  function addChip(domain) {
    const d = cleanDomain(domain);
    if (!d) return;
    if ([...wrap.querySelectorAll('.chip')].some(c => c.dataset.domain === d)) return;
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.dataset.domain = d;
    chip.innerHTML = '<span class="chip-text">' + d + '</span>' +
      (disabled ? '' : '<button class="chip-remove" tabindex="-1">&times;</button>');
    if (!disabled) {
      chip.querySelector('.chip-remove').addEventListener('click', () => {
        chip.remove();
        if (wrap._onChipChange) wrap._onChipChange();
      });
    }
    wrap.insertBefore(chip, inp);
  }

  const inp = document.createElement('input');
  inp.type = 'text';
  inp.className = 'chip-text-input';
  inp.placeholder = disabled ? '' : 'Add domain…';
  inp.disabled = disabled;
  wrap.appendChild(inp);

  if (!disabled) {
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        inp.value.split(',').forEach(v => addChip(v));
        inp.value = '';
        if (wrap._onChipChange) wrap._onChipChange();
      } else if (e.key === 'Backspace' && inp.value === '') {
        const chips = wrap.querySelectorAll('.chip');
        if (chips.length) { chips[chips.length - 1].remove(); if (wrap._onChipChange) wrap._onChipChange(); }
      }
    });
    inp.addEventListener('blur', () => {
      if (inp.value.trim()) {
        inp.value.split(',').forEach(v => addChip(v));
        inp.value = '';
        if (wrap._onChipChange) wrap._onChipChange();
      }
    });
    inp.addEventListener('paste', e => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text');
      text.split(',').forEach(v => addChip(v));
      if (wrap._onChipChange) wrap._onChipChange();
    });
  }

  (initialDomains || []).forEach(d => addChip(d));
}

function getChipDomains(wrap) {
  return [...wrap.querySelectorAll('.chip')].map(c => c.dataset.domain);
}
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
        (locked ? '<button class="btn-save-row btn-queue-save">Queue Change</button>' : '') +
        (locked ? '' : '<button class="btn-del-row" title="Remove">🗑</button>') +
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
        '<span class="window-domains-label">Block these sites</span>' +
        '<div class="chip-input-wrap" id="chip-wrap-' + idx + '"></div>' +
      '</div>' +
      (hasPending ? '<div class="strict-lock-msg">⏳ Change queued — applies when window ends</div>' : '') +
      (locked ? '<div class="strict-lock-msg">🔒 Strict mode — window is active, changes queued</div>' : '');

    container.appendChild(row);

    // Initialize chip input for blocked domains
    const chipWrap = row.querySelector('#chip-wrap-' + idx);
    initChipInput(chipWrap, w.blockedDomains || [], locked);

    function collectWindowData() {
      const selectedDays = [...row.querySelectorAll('.w-day:checked')].map(el => parseInt(el.dataset.day));
      return {
        id: w.id,
        enabled: row.querySelector('.w-enabled').checked,
        label: row.querySelector('.w-label').value.trim() || 'Focus',
        start: row.querySelector('.w-start').value,
        end: row.querySelector('.w-end').value,
        days: selectedDays.length > 0 ? selectedDays : [0,1,2,3,4,5,6],
        blockedDomains: getChipDomains(chipWrap)
      };
    }

    async function autoSaveWindow() {
      if (locked) return;
      const s = await getSettings();
      if (s.strictBlocking && isWindowActive(w)) return;
      const wins = s.focusWindows || [];
      wins[idx] = collectWindowData();
      await setSetting('focusWindows', wins);
      await setSetting('_userConfigured', true);
      updateLiveStatus(wins);
      renderDashboard(await getSettings());
    }

    // Auto-save on immediate inputs
    if (!locked) {
      row.querySelector('.w-enabled').addEventListener('change', autoSaveWindow);
      row.querySelector('.w-start').addEventListener('change', autoSaveWindow);
      row.querySelector('.w-end').addEventListener('change', autoSaveWindow);

      // Debounce label input
      let labelTimer;
      row.querySelector('.w-label').addEventListener('input', () => {
        clearTimeout(labelTimer);
        labelTimer = setTimeout(autoSaveWindow, 600);
      });

      // Day pills
      row.querySelectorAll('.w-day').forEach(cb => {
        cb.addEventListener('change', () => {
          cb.closest('.day-pill').classList.toggle('active', cb.checked);
          autoSaveWindow();
        });
      });

      // Chip add/remove triggers auto-save
      chipWrap._onChipChange = autoSaveWindow;
    } else {
      // Day pill visual toggle only when locked
      row.querySelectorAll('.w-day').forEach(cb => {
        cb.addEventListener('change', () => {
          cb.closest('.day-pill').classList.toggle('active', cb.checked);
        });
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
function makeSelect(cls, options, selectedVal, disabledAttr) {
  const val = parseInt(selectedVal) || 0;
  // Ensure current value is always present in the list
  const hasVal = options.some(o => o.value == val);
  const allOpts = hasVal ? options : [...options, { value: val, label: val + (cls.includes('window') ? ' hr' : cls.includes('limit-s') ? ' sec' : ' min') }].sort((a, b) => a.value - b.value);
  const opts = allOpts.map(o =>
    `<option value="${o.value}"${o.value == val ? ' selected' : ''}>${o.label}</option>`
  ).join('');
  return `<select class="${cls} input-select"${disabledAttr}>${opts}</select>`;
}

function minOptions(maxMins) {
  const all = [0,1,2,3,4,5,10,15,20,25,30,45,60,90,120,150,180,210,240,300,360,420,480];
  const limit = maxMins !== undefined ? maxMins : 480;
  return all.filter(v => v <= limit).map(v => ({ value: v, label: v + ' min' }));
}
function secOptions() {
  const vals = [0,5,10,15,20,25,30,45];
  return vals.map(v => ({ value: v, label: v + ' sec' }));
}
function hourOptions() {
  const vals = [1,2,3,4,6,8,12,24];
  return vals.map(v => ({ value: v, label: v + ' hr' }));
}

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
    const locked = strict && blocked;
    const disabledAttr = locked ? ' disabled' : '';

    const row = document.createElement('div');
    row.className = 'binge-rule-row' + (blocked ? ' blocked' : '') + (locked ? ' strict-locked' : '');
    row.innerHTML =
      '<div class="binge-rule-top">' +
        '<label class="switch"><input type="checkbox" class="br-enabled"' + disabledAttr + (rule.enabled ? ' checked' : '') + '/><span class="slider"></span></label>' +
        '<div class="br-domain-wrap">' +
          '<label class="br-field-label">Website</label>' +
          '<input type="text" class="br-domain input-inline"' + disabledAttr + ' value="' + rule.domain + '" placeholder="e.g. instagram.com" />' +
        '</div>' +
      '</div>' +
      '<div class="binge-rule-limits">' +
        '<div class="br-limit-group">' +
          '<label class="br-field-label">Block after</label>' +
          '<div class="br-selects">' +
            makeSelect('br-limit-m', minOptions((rule.windowHours || 1) * 60 - 10), limitM, disabledAttr) +
            makeSelect('br-limit-s', secOptions(), limitS, disabledAttr) +
          '</div>' +
        '</div>' +
        '<div class="br-limit-group">' +
          '<label class="br-field-label">Rolling window</label>' +
          makeSelect('br-window', hourOptions(), rule.windowHours || 1, disabledAttr) +
        '</div>' +
      '</div>' +
      '<div class="binge-rule-actions">' +
        (locked ? '' : '<button class="btn-del-row" title="Remove">🗑 Delete</button>') +
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

    // When window hours changes, rebuild minute options
    const windowSel = row.querySelector('.br-window');
    const minSel = row.querySelector('.br-limit-m');
    if (windowSel && minSel) {
      windowSel.addEventListener('change', () => {
        const hrs = parseInt(windowSel.value) || 1;
        const maxMins = hrs * 60 - 10;
        const currentVal = parseInt(minSel.value) || 0;
        const opts = minOptions(maxMins);
        minSel.innerHTML = opts.map(o =>
          `<option value="${o.value}"${o.value === Math.min(currentVal, maxMins) ? ' selected' : ''}>${o.label}</option>`
        ).join('');
      });
    }

    async function autoSaveBinge() {
      if (locked) return;
      const s = await getSettings();
      const rs = s.bingeRules || [];
      const lm = parseInt(row.querySelector('.br-limit-m').value) || 0;
      const ls_sec = parseInt(row.querySelector('.br-limit-s').value) || 0;
      const ls = lm * 60 + ls_sec;
      const hrs = parseInt(row.querySelector('.br-window').value) || 1;
      const maxSecs = hrs * 3600 - 600;
      if (ls <= 0 || ls > maxSecs) return; // silent — invalid state, don't save
      const updated = {
        id: rule.id,
        enabled: row.querySelector('.br-enabled').checked,
        domain: row.querySelector('.br-domain').value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase(),
        limitSecs: ls,
        windowHours: hrs
      };
      if (!updated.domain) return;

      if (s.strictBlocking && blocked) {
        const p = s.pendingBingeRules || {};
        p[rule.domain] = { action: 'update', rule: updated };
        await setSetting('pendingBingeRules', p);
        renderBingeRules(rs, s.bingeUsage, s.strictBlocking, p);
      } else {
        rs[idx] = updated;
        await setSetting('bingeRules', rs);
        await setSetting('_userConfigured', true);
        renderDashboard(await getSettings());
      }
    }

    if (!locked) {
      // Immediate save on selects and toggle
      row.querySelector('.br-enabled').addEventListener('change', autoSaveBinge);
      row.querySelector('.br-limit-m').addEventListener('change', autoSaveBinge);
      row.querySelector('.br-limit-s').addEventListener('change', autoSaveBinge);
      row.querySelector('.br-window').addEventListener('change', () => {
        // Rebuild mins first, then save
        setTimeout(autoSaveBinge, 0);
      });
      // Debounce domain input
      let domainTimer;
      row.querySelector('.br-domain').addEventListener('input', () => {
        clearTimeout(domainTimer);
        domainTimer = setTimeout(autoSaveBinge, 700);
      });
    }

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

  // Strict blocking toggle (Binge Guard section)
  const strictToggle = document.getElementById('strict-blocking-toggle');
  const strictDashToggle = document.getElementById('strict-blocking-toggle-dash');
  const strictHeroSub = document.getElementById('strict-hero-sub');

  function updateStrictUI(enabled) {
    if (strictToggle) strictToggle.checked = enabled;
    if (strictDashToggle) strictDashToggle.checked = enabled;
    if (strictHeroSub) strictHeroSub.textContent = enabled ? 'On — changes locked while blocked' : 'Off';
    const card = document.getElementById('strict-hero-card');
    if (card) card.classList.toggle('strict-card-on', enabled);
  }

  updateStrictUI(!!settings.strictBlocking);

  async function onStrictChange(enabled) {
    await setSetting('strictBlocking', enabled);
    await setSetting('_userConfigured', true);
    updateStrictUI(enabled);
    const s = await getSettings();
    renderBingeRules(s.bingeRules, s.bingeUsage, s.strictBlocking, s.pendingBingeRules);
  }

  if (strictToggle) strictToggle.addEventListener('change', () => onStrictChange(strictToggle.checked));
  if (strictDashToggle) strictDashToggle.addEventListener('change', () => onStrictChange(strictDashToggle.checked));

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

  // ── Donation UPI modal ──
  const UPI_ID = 'your@upi'; // Replace with your actual UPI ID
  const upiIdText = document.getElementById('upi-id-text');
  if (upiIdText) upiIdText.textContent = UPI_ID;

  document.getElementById('donate-upi-btn').addEventListener('click', () => {
    document.getElementById('upi-modal').style.display = 'flex';
  });
  document.getElementById('upi-modal-close').addEventListener('click', () => {
    document.getElementById('upi-modal').style.display = 'none';
  });
  document.getElementById('upi-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
  });
  document.getElementById('upi-copy-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(UPI_ID).then(() => {
      const btn = document.getElementById('upi-copy-btn');
      btn.textContent = '✓ Copied!';
      setTimeout(() => { btn.textContent = 'Copy UPI ID'; }, 2000);
    });
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
