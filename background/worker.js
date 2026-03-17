// AI Distraction Blocker — Service Worker v3
// Features: multiple focus windows, binge guard, distracted-minute tracking

// ── Storage schema ──
const DEFAULTS = {
  apiKey: "",
  focusWindows: [
    { id: "1", enabled: true, start: "09:00", end: "17:00", label: "Work" }
  ],
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

function setKey(key, value) {
  return new Promise(resolve => chrome.storage.local.set({ [key]: value }, resolve));
}

async function incrementStat(field, amount = 1) {
  const data = await getSettings();
  const stats = data.stats || {};
  const today = new Date().toISOString().slice(0, 10);
  if (!stats[today]) stats[today] = { distractingMinutes: 0, interventions: 0, exited: 0 };
  stats[today][field] = (stats[today][field] || 0) + amount;
  return new Promise(resolve => chrome.storage.local.set({ stats }, resolve));
}

// ── Migrate old blockTime → focusWindows ──
async function ensureDefaults() {
  const raw = await new Promise(resolve => chrome.storage.local.get(null, resolve));

  // Migrate legacy single blockTime
  if (raw.blockTime && !raw.focusWindows) {
    const fw = [{
      id: "1",
      enabled: raw.blockTime.enabled !== false,
      start: raw.blockTime.start || "09:00",
      end: raw.blockTime.end || "17:00",
      label: "Work"
    }];
    await new Promise(resolve => chrome.storage.local.set({ focusWindows: fw }, resolve));
  }

  if (!raw._userConfigured && !raw.focusWindows) {
    await new Promise(resolve => chrome.storage.local.set({
      focusWindows: DEFAULTS.focusWindows
    }, resolve));
  }
}

// ── Focus window helpers ──
function isInAnyFocusWindow(focusWindows) {
  if (!focusWindows || focusWindows.length === 0) return false;
  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  return focusWindows.some(w => {
    if (!w.enabled) return false;
    const [sh, sm] = w.start.split(':').map(Number);
    const [eh, em] = w.end.split(':').map(Number);
    return nowMins >= sh * 60 + sm && nowMins < eh * 60 + em;
  });
}

function isWhitelisted(url, whitelist) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return (whitelist || []).some(w => hostname === w || hostname.endsWith('.' + w));
  } catch { return false; }
}

function getDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

// ── Rule-based classifier ──
const DISTRACTING_DOMAINS = [
  'twitter.com','x.com','instagram.com','tiktok.com','facebook.com',
  'reddit.com','snapchat.com','pinterest.com','tumblr.com','twitch.tv',
  'netflix.com','primevideo.com','disneyplus.com',
  'buzzfeed.com','dailymail.co.uk','tmz.com','9gag.com','imgur.com'
];

function ruleBasedClassify(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^www\./, '');
    if (h === 'youtube.com' || h === 'youtu.be') {
      // Productive: watch page with a video ID (likely intentional)
      if (/^\/watch/.test(u.pathname) && u.searchParams.get('v')) return 'productive';
      // Distracting: homepage, shorts, feed, trending, explore
      if (
        u.pathname === '/' ||
        u.pathname === '' ||
        /^\/shorts\//.test(u.pathname) ||
        /^\/(feed|trending|explore|gaming|sports|fashion|beauty)/.test(u.pathname)
      ) return 'distracting';
      // Playlists, channels, search — let AI decide
      return null;
    }
    if (DISTRACTING_DOMAINS.some(d => h === d || h.endsWith('.' + d))) return 'distracting';
    return null;
  } catch { return null; }
}

// ── AI classifier ──
async function classifyWithAI(apiKey, { title, url, description, bodyText }) {
  const res = await fetch('https://api.unlimitedclaude.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'claude-sonnet-4.6',
      max_tokens: 100,
      system: `You are a content classifier for a focus/productivity Chrome extension.
Classify the page as "productive" or "distracting".
Productive: technical articles, docs, educational videos, coding, research, learning.
Distracting: social media feeds, memes, gossip, random entertainment, browser games, doomscrolling.
Respond ONLY with JSON: {"classification":"productive"|"distracting","reason":"one short sentence"}`,
      messages: [{ role: 'user', content: `URL: ${url}\nTitle: ${title}\nMeta: ${description || 'none'}\nExcerpt: ${(bodyText || '').slice(0, 800)}` }]
    })
  });
  if (!res.ok) return null;
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim() || '{}';
  return JSON.parse(text);
}

// ── Binge guard ──
// All time stored in SECONDS internally. limitSecs, usedSecs, windowHours.
// Legacy records with .mins are auto-converted.

async function getBingeStatus(domain) {
  const settings = await getSettings();
  const rule = (settings.bingeRules || []).find(r => r.enabled && (domain === r.domain || domain.endsWith('.' + r.domain)));
  if (!rule) return null;

  const limitSecs = rule.limitSecs || (rule.limitMins || 5) * 60; // back-compat
  const usage = settings.bingeUsage || {};
  const domainUsage = usage[rule.domain] || [];
  const windowMs = rule.windowHours * 3600 * 1000;
  const cutoff = Date.now() - windowMs;
  const usedSecs = domainUsage
    .filter(e => e.ts > cutoff)
    .reduce((s, e) => s + (e.secs || (e.mins || 0) * 60), 0); // back-compat
  const blocked = usedSecs >= limitSecs;

  let unblockAt = null;
  if (blocked) {
    const sorted = [...domainUsage].filter(e => e.ts > cutoff).sort((a, b) => a.ts - b.ts);
    let running = usedSecs;
    for (const entry of sorted) {
      running -= (entry.secs || (entry.mins || 0) * 60);
      if (running < limitSecs) { unblockAt = entry.ts + windowMs; break; }
    }
    if (!unblockAt) unblockAt = Date.now() + windowMs;
  }

  return { domain: rule.domain, usedSecs, limitSecs, windowHours: rule.windowHours, blocked, unblockAt };
}

async function recordBingeSeconds(domain, secs) {
  const settings = await getSettings();
  const usage = settings.bingeUsage || {};
  if (!usage[domain]) usage[domain] = [];
  usage[domain].push({ ts: Date.now(), secs });
  const cutoff = Date.now() - 24 * 3600 * 1000;
  usage[domain] = usage[domain].filter(e => e.ts > cutoff);
  await setKey('bingeUsage', usage);
}

// ── Binge notification (fires once at 80% threshold) ──
const notifiedTabs = new Set(); // track which domains got the 80% notif this session

function maybeSendBingeNotification(domain, usedSecs, limitSecs) {
  const pct = usedSecs / limitSecs;
  const key = domain + ':80';
  if (pct >= 0.8 && !notifiedTabs.has(key)) {
    notifiedTabs.add(key);
    const remainSecs = Math.max(limitSecs - usedSecs, 0);
    const m = Math.floor(remainSecs / 60), s = remainSecs % 60;
    const timeLeft = m && s ? m + 'm ' + s + 's' : m ? m + 'm' : s + 's';
    chrome.notifications.create('binge-warn-' + domain, {
      type: 'basic',
      iconUrl: '../icons/icon48.png',
      title: 'Binge Guard Warning',
      message: domain + ' — only ' + timeLeft + ' left before it\'s blocked.'
    });
  }
  // Reset key when usage drops below 70% (e.g. after reset)
  if (pct < 0.7) notifiedTabs.delete(key);
}

// ── Per-tab state ──
const tabStates = {};           // { tabId: { stage, mode } }
const distractingTabs = {};     // { tabId: domain }
const allowedOnceTabs = new Set(); // tabIds allowed for this session

// ── Alarms ──
chrome.alarms.create('adb-minute-tick', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== 'adb-minute-tick') return;
  // Count distracted tabs for stats (best-effort, in-memory)
  const count = Object.keys(distractingTabs).length;
  if (count > 0) incrementStat('distractingMinutes', count);
  // Note: binge usage recording is handled by BINGE_HEARTBEAT from content scripts
  // which is reliable across service worker restarts
});

// ── Worker ready ──
const workerReady = ensureDefaults();

// ── Message handler ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  // Tab-independent messages (from popup or options)
  if (msg.type === 'PAUSE_BLOCKING') {
    const until = Date.now() + (msg.minutes || 30) * 60 * 1000;
    chrome.storage.local.set({ pauseUntil: until }, () => sendResponse({ until }));
    return true;
  }

  if (msg.type === 'GET_PAUSE_STATUS') {
    chrome.storage.local.get({ pauseUntil: 0 }, data => {
      sendResponse({ pauseUntil: data.pauseUntil, paused: data.pauseUntil > Date.now() });
    });
    return true;
  }

  if (msg.type === 'RESUME_BLOCKING') {
    chrome.storage.local.set({ pauseUntil: 0 }, () => sendResponse({ ok: true }));
    return true;
  }

  // Tab-required messages
  if (!tabId) { sendResponse({ stage: 0 }); return true; }

  if (msg.type === 'CLASSIFY_PAGE') {
    handlePageClassify(tabId, msg).then(result => sendResponse(result));
    return true;
  }

  if (msg.type === 'BINGE_HEARTBEAT') {
    (async () => {
      const domain = getDomain(msg.url);
      if (domain) {
        await recordBingeSeconds(domain, msg.secs || 30);
        const status = await getBingeStatus(domain);
        if (status) maybeSendBingeNotification(domain, status.usedSecs, status.limitSecs);
        console.log('[ADB] Heartbeat', domain, '| usedSecs:', status?.usedSecs, '| blocked:', status?.blocked);
        sendResponse({ status });
      } else {
        sendResponse({ status: null });
      }
    })();
    return true;
  }

  if (msg.type === 'GET_BINGE_STATUS') {
    const domain = getDomain(msg.url);
    if (!domain) { sendResponse(null); return true; }
    getBingeStatus(domain).then(status => sendResponse(status));
    return true;
  }

  if (msg.type === 'ALLOW_ONCE') {
    allowedOnceTabs.add(tabId);
    tabStates[tabId] = { stage: 0 };
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'STAGE_ADVANCE') {
    advanceStage(tabId).then(stage => sendResponse({ stage }));
    return true;
  }

  if (msg.type === 'STAGE_RESET') {
    tabStates[tabId] = { stage: 0 };
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'STAT_INCREMENT') {
    incrementStat(msg.field, msg.amount || 1).then(() => sendResponse({ ok: true }));
    return true;
  }

  sendResponse({ stage: 0 });
  return true;
});

async function handlePageClassify(tabId, msg) {
  await workerReady;
  const settings = await getSettings();
  const domain = getDomain(msg.url);

  // ── Binge guard check (independent of focus window) ──
  let bingeStatus = null;
  if (domain) {
    bingeStatus = await getBingeStatus(domain);
    if (bingeStatus && bingeStatus.blocked) {
      return { stage: 3, bingeStatus };
    }
  }

  // ── Allow-once check ──
  if (allowedOnceTabs.has(tabId)) return { stage: 0, bingeStatus };

  // ── Pause check ──
  const pauseData = await new Promise(resolve => chrome.storage.local.get({ pauseUntil: 0 }, resolve));
  if (pauseData.pauseUntil > Date.now()) return { stage: 0, bingeStatus, paused: true };

  // ── Focus window check ──
  if (!isInAnyFocusWindow(settings.focusWindows)) return { stage: 0, bingeStatus };
  if (isWhitelisted(msg.url, settings.whitelist)) return { stage: 0, bingeStatus };

  const current = tabStates[tabId];
  if (current && current.stage > 0) return { stage: 0 };

  let classification = ruleBasedClassify(msg.url);
  if (!classification && settings.apiKey) {
    try {
      const ai = await classifyWithAI(settings.apiKey, msg);
      classification = ai?.classification || null;
    } catch (e) { /* AI classification failed, fall through */ }
  }

  if (classification !== 'distracting') return { stage: 0 };

  // Track as distracting tab
  if (domain) distractingTabs[tabId] = domain;

  const mode = settings.interventionMode || 'both';
  const startStage = mode === 'hard' ? 3 : 1;
  tabStates[tabId] = { stage: startStage, mode };
  await incrementStat('interventions');

  return { stage: startStage, bingeStatus };
}

async function advanceStage(tabId) {
  const state = tabStates[tabId];
  if (!state) return 0;
  if (state.mode === 'soft') { tabStates[tabId] = { stage: 0, mode: state.mode }; return 0; }
  const next = Math.min(state.stage + 1, 3);
  tabStates[tabId] = { stage: next, mode: state.mode };
  if (next === 3) await incrementStat('exited');
  return next;
}

chrome.tabs.onRemoved.addListener(tabId => {
  delete tabStates[tabId];
  delete distractingTabs[tabId];
  allowedOnceTabs.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    delete tabStates[tabId];
    delete distractingTabs[tabId];
    allowedOnceTabs.delete(tabId);
  }
});
