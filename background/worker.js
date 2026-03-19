// qC Blocker Extension — Service Worker v3
// Features: multiple focus windows, binge guard, distracted-minute tracking

// ── Storage schema ──
const DEFAULTS = {
  focusWindows: [
    {
      id: "1",
      enabled: true,
      start: "09:00",
      end: "17:00",
      label: "Work",
      days: [1, 2, 3, 4, 5],
      blockedDomains: [],
    },
  ],
  interventionMode: "both",
  whitelist: [
    "github.com",
    "stackoverflow.com",
    "docs.google.com",
    "notion.so",
    "figma.com",
  ],
  pathWhitelist: [],
  bingeRules: [],
  bingeUsage: {},
  strictBlocking: false,
  pendingBingeRules: {},
  pendingFocusWindowChanges: {},
  // escalationBlocks: { domain: expiresAt } — persists stage-3 across refreshes until focus window ends
  escalationBlocks: {},
  theme: "default",
  stats: {},
  pauseUntil: 0,
  _userConfigured: false,
};

function getSettings() {
  return new Promise((resolve) => chrome.storage.local.get(DEFAULTS, resolve));
}

function setKey(key, value) {
  return new Promise((resolve) =>
    chrome.storage.local.set({ [key]: value }, resolve),
  );
}

async function incrementStat(field, amount = 1) {
  const data = await getSettings();
  const stats = data.stats || {};
  const today = new Date().toISOString().slice(0, 10);
  if (!stats[today])
    stats[today] = { distractingMinutes: 0, interventions: 0, exited: 0 };
  stats[today][field] = (stats[today][field] || 0) + amount;
  return new Promise((resolve) => chrome.storage.local.set({ stats }, resolve));
}

// ── Migrate old blockTime → focusWindows ──
async function ensureDefaults() {
  const raw = await new Promise((resolve) =>
    chrome.storage.local.get(null, resolve),
  );

  // Migrate legacy single blockTime
  if (raw.blockTime && !raw.focusWindows) {
    const fw = [
      {
        id: "1",
        enabled: raw.blockTime.enabled !== false,
        start: raw.blockTime.start || "09:00",
        end: raw.blockTime.end || "17:00",
        label: "Work",
      },
    ];
    await new Promise((resolve) =>
      chrome.storage.local.set({ focusWindows: fw }, resolve),
    );
  }

  if (!raw._userConfigured && !raw.focusWindows) {
    await new Promise((resolve) =>
      chrome.storage.local.set(
        {
          focusWindows: DEFAULTS.focusWindows,
        },
        resolve,
      ),
    );
  }
}

// ── Focus window helpers ──
// days: 0=Sun,1=Mon,...,6=Sat (matches JS Date.getDay())
function isWindowActiveNow(w) {
  if (!w.enabled) return false;
  const now = new Date();
  const day = now.getDay();
  const days = w.days && w.days.length > 0 ? w.days : [0, 1, 2, 3, 4, 5, 6];
  if (!days.includes(day)) return false;
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = w.start.split(":").map(Number);
  const [eh, em] = w.end.split(":").map(Number);
  return nowMins >= sh * 60 + sm && nowMins < eh * 60 + em;
}

function isInAnyFocusWindow(focusWindows) {
  if (!focusWindows || focusWindows.length === 0) return false;
  return focusWindows.some(isWindowActiveNow);
}

// Returns the active window that blocks this URL (checks per-window blockedDomains)
function getBlockingWindow(url, focusWindows) {
  if (!focusWindows || focusWindows.length === 0) return null;
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    return (
      focusWindows.find((w) => {
        if (!isWindowActiveNow(w)) return false;
        const blocked = w.blockedDomains || [];
        // If no per-window domains set, window blocks everything (old behaviour)
        if (blocked.length === 0) return true;
        return blocked.some(
          (d) => hostname === d || hostname.endsWith("." + d),
        );
      }) || null
    );
  } catch {
    return null;
  }
}

function isWhitelisted(url, whitelist) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    return (whitelist || []).some(
      (w) => hostname === w || hostname.endsWith("." + w),
    );
  } catch {
    return false;
  }
}

// Path whitelist: each entry is a string like "reddit.com/r/MachineLearning"
// Matches if the URL's hostname+pathname starts with the pattern (case-insensitive)
function isPathWhitelisted(url, pathWhitelist) {
  if (!pathWhitelist || pathWhitelist.length === 0) return false;
  try {
    const u = new URL(url);
    const hostname = u.hostname.replace(/^www\./, "");
    const fullPath = (hostname + u.pathname).toLowerCase().replace(/\/$/, "");
    return pathWhitelist.some((entry) => {
      const pattern = (entry.pattern || entry)
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .replace(/\/$/, "");
      return fullPath === pattern || fullPath.startsWith(pattern + "/");
    });
  } catch {
    return false;
  }
}

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

// ── All blocking is user-configured only ──
// No hardcoded domain lists. Sites are blocked only when explicitly added
// to a focus window's "Block these sites" field or binge guard rules.

// ── Binge guard ──
// In-memory accumulator — flushes to storage every 5s to avoid write-per-second
const bingeAccumulator = {}; // { domain: { secs: N, dirty: bool } }
let flushTimer = null;

async function flushBingeAccumulator() {
  const domains = Object.keys(bingeAccumulator).filter(
    (d) => bingeAccumulator[d].dirty,
  );
  if (domains.length === 0) return;
  const settings = await getSettings();
  const usage = settings.bingeUsage || {};
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const domain of domains) {
    const acc = bingeAccumulator[domain];
    if (!usage[domain]) usage[domain] = [];
    usage[domain].push({ ts: Date.now(), secs: acc.secs });
    usage[domain] = usage[domain].filter((e) => e.ts > cutoff);
    acc.secs = 0;
    acc.dirty = false;
  }
  await setKey("bingeUsage", usage);
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    await flushBingeAccumulator();
  }, 5000);
}

async function getBingeStatus(domain) {
  const settings = await getSettings();
  const rule = (settings.bingeRules || []).find(
    (r) =>
      r.enabled && (domain === r.domain || domain.endsWith("." + r.domain)),
  );
  if (!rule) return null;

  const rawLimitSecs = rule.limitSecs || (rule.limitMins || 5) * 60;
  // Always reserve 10 min per window — max blockable = windowHours*60 - 10 min
  const maxAllowedSecs = rule.windowHours * 3600 - 600;
  const limitSecs = Math.min(rawLimitSecs, Math.max(maxAllowedSecs, 60)); // floor at 60s

  const usage = settings.bingeUsage || {};
  const domainUsage = usage[rule.domain] || [];
  const windowMs = rule.windowHours * 3600 * 1000;
  const cutoff = Date.now() - windowMs;

  const pendingSecs = (bingeAccumulator[rule.domain] || {}).secs || 0;
  const storedSecs = domainUsage
    .filter((e) => e.ts > cutoff)
    .reduce((s, e) => s + (e.secs || (e.mins || 0) * 60), 0);
  const usedSecs = storedSecs + pendingSecs;
  const blocked = usedSecs >= limitSecs;

  let unblockAt = null;
  if (blocked) {
    const sorted = [...domainUsage]
      .filter((e) => e.ts > cutoff)
      .sort((a, b) => a.ts - b.ts);
    let running = usedSecs;
    for (const entry of sorted) {
      running -= entry.secs || (entry.mins || 0) * 60;
      if (running < limitSecs) {
        unblockAt = entry.ts + windowMs;
        break;
      }
    }
    if (!unblockAt) unblockAt = Date.now() + windowMs;
  }

  return {
    domain: rule.domain,
    usedSecs,
    limitSecs,
    windowHours: rule.windowHours,
    blocked,
    unblockAt,
  };
}

async function recordBingeSeconds(domain, secs) {
  if (!bingeAccumulator[domain])
    bingeAccumulator[domain] = { secs: 0, dirty: false };
  bingeAccumulator[domain].secs += secs;
  bingeAccumulator[domain].dirty = true;
  scheduleFlush();
}

// ── Binge notification (fires once at 80% threshold) ──
const notifiedTabs = new Set(); // track which domains got the 80% notif this session

function maybeSendBingeNotification(domain, usedSecs, limitSecs) {
  const pct = usedSecs / limitSecs;
  const key = domain + ":80";
  if (pct >= 0.8 && !notifiedTabs.has(key)) {
    notifiedTabs.add(key);
    const remainSecs = Math.max(limitSecs - usedSecs, 0);
    const m = Math.floor(remainSecs / 60),
      s = remainSecs % 60;
    const timeLeft = m && s ? m + "m " + s + "s" : m ? m + "m" : s + "s";
    chrome.notifications.create("binge-warn-" + domain, {
      type: "basic",
      iconUrl: "../icons/icon48.png",
      title: "Binge Guard Warning",
      message: domain + " — only " + timeLeft + " left before it's blocked.",
    });
  }
  // Reset key when usage drops below 70% (e.g. after reset)
  if (pct < 0.7) notifiedTabs.delete(key);
}

// ── Escalation block helpers ──
// Persists stage-3 blocks by domain until the active focus window ends

function getFocusWindowEndMs(focusWindows) {
  const now = new Date();
  for (const w of focusWindows || []) {
    if (!isWindowActiveNow(w)) continue;
    const [eh, em] = w.end.split(":").map(Number);
    const end = new Date(now);
    end.setHours(eh, em, 0, 0);
    if (end > now) return end.getTime();
  }
  // Fallback: 1 hour from now
  return Date.now() + 3600 * 1000;
}

async function setEscalationBlock(domain, focusWindows) {
  const data = await new Promise((r) =>
    chrome.storage.local.get({ escalationBlocks: {} }, r),
  );
  const blocks = data.escalationBlocks;
  blocks[domain] = getFocusWindowEndMs(focusWindows);
  await setKey("escalationBlocks", blocks);
}

async function isEscalationBlocked(domain) {
  const data = await new Promise((r) =>
    chrome.storage.local.get({ escalationBlocks: {} }, r),
  );
  const exp = data.escalationBlocks[domain];
  if (!exp) return false;
  if (Date.now() >= exp) {
    // Expired — clean up
    delete data.escalationBlocks[domain];
    await setKey("escalationBlocks", data.escalationBlocks);
    return false;
  }
  return true;
}

async function clearEscalationBlock(domain) {
  const data = await new Promise((r) =>
    chrome.storage.local.get({ escalationBlocks: {} }, r),
  );
  delete data.escalationBlocks[domain];
  await setKey("escalationBlocks", data.escalationBlocks);
}

// ── Per-tab state ──
const tabStates = {}; // { tabId: { stage, mode } }
const distractingTabs = {}; // { tabId: domain }
const allowedOnceTabs = new Set(); // tabIds allowed for this session

// ── Alarms ──
chrome.alarms.create("adb-minute-tick", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "adb-minute-tick") return;
  const count = Object.keys(distractingTabs).length;
  if (count > 0) incrementStat("distractingMinutes", count);

  // ── Clean up expired escalation blocks ──
  const ebData = await new Promise((r) =>
    chrome.storage.local.get({ escalationBlocks: {} }, r),
  );
  const blocks = ebData.escalationBlocks;
  let ebChanged = false;
  for (const [domain, exp] of Object.entries(blocks)) {
    if (Date.now() >= exp) {
      delete blocks[domain];
      ebChanged = true;
    }
  }
  if (ebChanged) await setKey("escalationBlocks", blocks);

  // ── Apply pending binge rule changes once block expires ──
  const settings = await getSettings();
  if (!settings.strictBlocking) return;
  const pending = settings.pendingBingeRules || {};
  if (Object.keys(pending).length === 0) return;

  let rules = settings.bingeRules || [];
  let changed = false;

  for (const [domain, change] of Object.entries(pending)) {
    const status = await getBingeStatus(domain);
    if (status && status.blocked) continue; // still blocked — wait

    if (change.action === "delete") {
      rules = rules.filter((r) => r.domain !== domain);
    } else if (change.action === "update" && change.rule) {
      const idx = rules.findIndex((r) => r.domain === domain);
      if (idx !== -1) rules[idx] = change.rule;
      else rules.push(change.rule);
    }
    delete pending[domain];
    changed = true;
  }

  if (changed) {
    await setKey("bingeRules", rules);
    await setKey("pendingBingeRules", pending);
  }

  // ── Apply pending focus window changes once window ends ──
  const pendingFW = settings.pendingFocusWindowChanges || {};
  if (Object.keys(pendingFW).length > 0) {
    let wins = settings.focusWindows || [];
    let fwChanged = false;
    for (const [winId, change] of Object.entries(pendingFW)) {
      const win = wins.find((w) => w.id === winId);
      if (win && isWindowActiveNow(win)) continue; // still active — wait
      if (change.action === "delete") {
        wins = wins.filter((w) => w.id !== winId);
      } else if (change.action === "update" && change.window) {
        const idx = wins.findIndex((w) => w.id === winId);
        if (idx !== -1) wins[idx] = change.window;
        else wins.push(change.window);
      }
      delete pendingFW[winId];
      fwChanged = true;
    }
    if (fwChanged) {
      await setKey("focusWindows", wins);
      await setKey("pendingFocusWindowChanges", pendingFW);
    }
  }
});

// ── Worker ready ──
const workerReady = ensureDefaults();

// ── Message handler ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  // Tab-independent messages (from popup or options)
  if (msg.type === "PAUSE_BLOCKING") {
    const until = Date.now() + (msg.minutes || 30) * 60 * 1000;
    chrome.storage.local.set({ pauseUntil: until }, () =>
      sendResponse({ until }),
    );
    return true;
  }

  if (msg.type === "GET_PAUSE_STATUS") {
    chrome.storage.local.get({ pauseUntil: 0 }, (data) => {
      sendResponse({
        pauseUntil: data.pauseUntil,
        paused: data.pauseUntil > Date.now(),
      });
    });
    return true;
  }

  if (msg.type === "RESUME_BLOCKING") {
    chrome.storage.local.set({ pauseUntil: 0 }, () =>
      sendResponse({ ok: true }),
    );
    return true;
  }

  if (msg.type === "SET_STRICT_BLOCKING") {
    chrome.storage.local.set({ strictBlocking: !!msg.enabled }, () =>
      sendResponse({ ok: true }),
    );
    return true;
  }

  if (msg.type === "GET_STRICT_STATUS") {
    chrome.storage.local.get(
      { strictBlocking: false, pendingBingeRules: {} },
      (data) => {
        sendResponse({
          strictBlocking: data.strictBlocking,
          pendingBingeRules: data.pendingBingeRules,
        });
      },
    );
    return true;
  }

  // Queue a binge rule change for when the block expires (strict mode)
  if (msg.type === "QUEUE_BINGE_CHANGE") {
    (async () => {
      const settings = await getSettings();
      const pending = settings.pendingBingeRules || {};
      pending[msg.domain] = { action: msg.action, rule: msg.rule || null };
      await setKey("pendingBingeRules", pending);
      sendResponse({ ok: true, queued: true });
    })();
    return true;
  }

  if (msg.type === "QUEUE_FOCUS_WINDOW_CHANGE") {
    (async () => {
      const settings = await getSettings();
      const pending = settings.pendingFocusWindowChanges || {};
      pending[msg.windowId] = {
        action: msg.action,
        window: msg.window || null,
      };
      await setKey("pendingFocusWindowChanges", pending);
      sendResponse({ ok: true, queued: true });
    })();
    return true;
  }

  // Tab-required messages
  if (!tabId) {
    sendResponse({ stage: 0 });
    return true;
  }

  if (msg.type === "CLASSIFY_PAGE") {
    handlePageClassify(tabId, msg).then((result) => sendResponse(result));
    return true;
  }

  if (msg.type === "BINGE_HEARTBEAT") {
    (async () => {
      const domain = getDomain(msg.url);
      if (domain) {
        // Skip binge tracking if URL is path-whitelisted
        const settings = await getSettings();
        if (isPathWhitelisted(msg.url, settings.pathWhitelist)) {
          sendResponse({ status: null });
          return;
        }
        await recordBingeSeconds(domain, msg.secs || 30);
        const status = await getBingeStatus(domain);
        if (status)
          maybeSendBingeNotification(domain, status.usedSecs, status.limitSecs);
        console.log(
          "[ADB] Heartbeat",
          domain,
          "| usedSecs:",
          status?.usedSecs,
          "| blocked:",
          status?.blocked,
        );
        sendResponse({ status });
      } else {
        sendResponse({ status: null });
      }
    })();
    return true;
  }

  if (msg.type === "GET_BINGE_STATUS") {
    const domain = getDomain(msg.url);
    if (!domain) {
      sendResponse(null);
      return true;
    }
    getBingeStatus(domain).then((status) => sendResponse(status));
    return true;
  }

  if (msg.type === "ALLOW_ONCE") {
    allowedOnceTabs.add(tabId);
    tabStates[tabId] = { stage: 0 };
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "STAGE_ADVANCE") {
    advanceStage(tabId).then((stage) => sendResponse({ stage }));
    return true;
  }

  if (msg.type === "STAGE_RESET") {
    tabStates[tabId] = { stage: 0 };
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "CLEAR_ESCALATION_BLOCK") {
    if (msg.domain) clearEscalationBlock(msg.domain);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "STAT_INCREMENT") {
    incrementStat(msg.field, msg.amount || 1).then(() =>
      sendResponse({ ok: true }),
    );
    return true;
  }

  sendResponse({ stage: 0 });
  return true;
});

async function handlePageClassify(tabId, msg) {
  await workerReady;
  const settings = await getSettings();
  const domain = getDomain(msg.url);

  // ── Path whitelist check (highest priority — exempt from everything) ──
  if (isPathWhitelisted(msg.url, settings.pathWhitelist))
    return { stage: 0, pathWhitelisted: true };

  // ── Domain whitelist check ──
  if (isWhitelisted(msg.url, settings.whitelist)) return { stage: 0 };

  // ── Binge guard check (independent of focus window) ──
  let bingeStatus = null;
  if (domain) {
    bingeStatus = await getBingeStatus(domain);
    if (bingeStatus && bingeStatus.blocked) {
      return { stage: 3, bingeStatus };
    }
  }

  // ── Escalation block check (persisted stage-3 across refreshes) ──
  if (domain && (await isEscalationBlocked(domain))) {
    return { stage: 3, escalationBlocked: true };
  }

  // ── Allow-once check ──
  if (allowedOnceTabs.has(tabId)) return { stage: 0, bingeStatus };

  // ── Pause check ──
  const pauseData = await new Promise((resolve) =>
    chrome.storage.local.get({ pauseUntil: 0 }, resolve),
  );
  if (pauseData.pauseUntil > Date.now())
    return { stage: 0, bingeStatus, paused: true };

  // ── Focus window + per-window blocked domains check ──
  const blockingWindow = getBlockingWindow(msg.url, settings.focusWindows);

  // Check if domain is explicitly listed in a focus window's blockedDomains
  let inWindowBlockList = false;
  if (
    blockingWindow &&
    blockingWindow.blockedDomains &&
    blockingWindow.blockedDomains.length > 0
  ) {
    try {
      const hostname = new URL(msg.url).hostname.replace(/^www\./, "");
      inWindowBlockList = blockingWindow.blockedDomains.some(
        (d) => hostname === d || hostname.endsWith("." + d),
      );
    } catch {}
  }

  const hasBingeRule = bingeStatus !== null;

  // ── Binge-only site (not explicitly listed in any focus window) ──
  // Skip overlay — binge heartbeat handles the hard block silently
  if (hasBingeRule && !inWindowBlockList) {
    const windowHasExplicitList =
      blockingWindow &&
      blockingWindow.blockedDomains &&
      blockingWindow.blockedDomains.length > 0;
    if (!blockingWindow || windowHasExplicitList) {
      return { stage: 0, bingeStatus };
    }
  }

  // No active focus window → nothing to escalate
  if (!blockingWindow) return { stage: 0, bingeStatus };

  // Only block if the domain is explicitly listed in the focus window's blockedDomains.
  // If blockedDomains is empty the window does NOT auto-block anything — user must add domains.
  if (!inWindowBlockList) return { stage: 0, bingeStatus };

  const current = tabStates[tabId];
  if (current && current.stage > 0) return { stage: 0 };

  // Track as distracting tab
  if (domain) distractingTabs[tabId] = domain;

  const mode = settings.interventionMode || "both";
  const startStage = mode === "hard" ? 3 : 1;
  tabStates[tabId] = { stage: startStage, mode };
  await incrementStat("interventions");

  return { stage: startStage, bingeStatus };
}

async function advanceStage(tabId) {
  const state = tabStates[tabId];
  if (!state) return 0;
  const next = Math.min(state.stage + 1, 3);
  tabStates[tabId] = { stage: next, mode: state.mode };
  if (next === 3) {
    await incrementStat("exited");
    // Persist the block so refreshes still show stage 3
    const domain = distractingTabs[tabId];
    if (domain) {
      const settings = await getSettings();
      await setEscalationBlock(domain, settings.focusWindows);
    }
  }
  return next;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabStates[tabId];
  delete distractingTabs[tabId];
  allowedOnceTabs.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    delete tabStates[tabId];
    delete distractingTabs[tabId];
    allowedOnceTabs.delete(tabId);
  }
});
