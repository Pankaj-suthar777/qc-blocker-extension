// qC Blocker Extension — Content Script v3

// ── Safe message sender — guards against invalidated extension context ──
function safeSend(msg, cb) {
  if (!chrome.runtime?.id) return;
  try {
    chrome.runtime.sendMessage(msg, function (res) {
      if (chrome.runtime.lastError) return;
      if (cb) cb(res);
    });
  } catch (e) {}
}

// ── Track first user gesture so AudioContext is allowed ──
var userGestureReceived = false;
document.addEventListener('click', function () { userGestureReceived = true; }, { once: true, capture: true });
document.addEventListener('keydown', function () { userGestureReceived = true; }, { once: true, capture: true });

const QUOTES = [
  "Is this helping your future self?",
  "Will this matter tomorrow?",
  "Are you building your life or escaping it?",
  "Is this intentional or just impulse?",
  "What would you rather have done with this hour?",
  "You are what you repeatedly do.",
  "The cost of distraction is paid in the future.",
  "Every scroll is a choice. Is this yours?",
  "Your attention is your most valuable asset.",
  "What are you avoiding right now?",
  "Discipline is choosing between what you want now and what you want most.",
  "Are you consuming or creating?",
  "How does this serve the person you want to become?",
  "Boredom is the gateway to creativity. Sit with it.",
  "The present moment is where your life actually happens.",
  "Distraction is the enemy of depth.",
  "What would your best self do right now?",
  "You can't get this hour back.",
  "Focus is a superpower. Guard it.",
  "The work is waiting. So is the version of you who did it.",
  "Small choices compound into who you become.",
  "Clarity comes from engagement, not avoidance.",
  "Your future self is watching.",
  "Deep work creates real value. Scrolling doesn't.",
  "One hour of focus beats three hours of distraction.",
  "The people who change the world aren't doomscrolling.",
  "What's one thing you could finish right now?",
  "Momentum is fragile. Protect it.",
  "You opened this tab. You can close it too.",
  "The algorithm is designed to keep you here. You don't have to comply.",
];

const HARD_BLOCK_QUOTES = [
  "The successful warrior is the average person with laser-like focus.",
  "It's not that I'm so smart, it's just that I stay with problems longer.",
  "The ability to focus is the ability to choose what matters.",
  "Where focus goes, energy flows.",
  "You will never reach your destination if you stop and throw stones at every dog that barks.",
  "Concentrate all your thoughts upon the work at hand.",
  "The secret of getting ahead is getting started.",
  "Do the hard work, especially when you don't feel like it.",
  "Starve your distractions. Feed your focus.",
  "The difference between who you are and who you want to be is what you do.",
];

function randomQuote() {
  return QUOTES[Math.floor(Math.random() * QUOTES.length)];
}

function randomHardQuote() {
  return HARD_BLOCK_QUOTES[
    Math.floor(Math.random() * HARD_BLOCK_QUOTES.length)
  ];
}

// ── Sound ──
function playAlert(type) {
  if (!userGestureReceived) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctx.resume().then(() => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      if (type === "warning") {
        osc.frequency.setValueAtTime(520, ctx.currentTime);
        osc.frequency.setValueAtTime(440, ctx.currentTime + 0.12);
        gain.gain.setValueAtTime(0.18, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.4);
      } else if (type === "final") {
        osc.frequency.setValueAtTime(300, ctx.currentTime);
        osc.frequency.setValueAtTime(220, ctx.currentTime + 0.15);
        gain.gain.setValueAtTime(0.22, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.6);
      } else if (type === "block") {
        osc.frequency.setValueAtTime(200, ctx.currentTime);
        gain.gain.setValueAtTime(0.25, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.8);
      }
    });
  } catch (e) {}
}

// ── Countdown badge (stage 1→2, 2→3) ──
let badgeInterval = null;

function showCountdownBadge(seconds, onExpire) {
  removeCountdownBadge();
  const CIRC = 2 * Math.PI * 12;
  const badge = document.createElement("div");
  badge.id = "adb-countdown-badge";
  badge.innerHTML =
    '<svg class="adb-badge-ring" viewBox="0 0 28 28">' +
    '<circle class="bg" cx="14" cy="14" r="12"/>' +
    '<circle class="fg" cx="14" cy="14" r="12" stroke-dasharray="' +
    CIRC +
    '" stroke-dashoffset="0"/>' +
    "</svg>" +
    '<span class="adb-badge-text">Final warning in</span>' +
    '<span class="adb-badge-timer" id="adb-badge-timer">' +
    seconds +
    "s</span>";
  document.body.appendChild(badge);

  let remaining = seconds;
  const fg = badge.querySelector(".fg");
  badgeInterval = setInterval(function () {
    remaining--;
    var el = document.getElementById("adb-badge-timer");
    if (el) el.textContent = remaining + "s";
    if (fg) fg.style.strokeDashoffset = CIRC * (1 - remaining / seconds);
    if (remaining <= 0) {
      clearInterval(badgeInterval);
      removeCountdownBadge();
      if (onExpire) onExpire();
    }
  }, 1000);
}

function removeCountdownBadge() {
  clearInterval(badgeInterval);
  var el = document.getElementById("adb-countdown-badge");
  if (el) el.remove();
}

// ── Binge indicator (persistent bottom-left widget) ──
let lastBingePct = 0;

function playBingeWarning(level) {
  if (!userGestureReceived) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctx.resume().then(() => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      if (level === "danger") {
        osc.frequency.setValueAtTime(660, ctx.currentTime);
        gain.gain.setValueAtTime(0.12, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.15);
        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.frequency.setValueAtTime(660, ctx.currentTime + 0.22);
        gain2.gain.setValueAtTime(0.12, ctx.currentTime + 0.22);
        gain2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.37);
        osc2.start(ctx.currentTime + 0.22);
        osc2.stop(ctx.currentTime + 0.37);
      } else if (level === "critical") {
        [0, 0.2, 0.4].forEach((offset, i) => {
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.connect(g); g.connect(ctx.destination);
          o.frequency.setValueAtTime(700 - i * 80, ctx.currentTime + offset);
          g.gain.setValueAtTime(0.18, ctx.currentTime + offset);
          g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + 0.15);
          o.start(ctx.currentTime + offset);
          o.stop(ctx.currentTime + offset + 0.15);
        });
      }
    });
  } catch (e) {}
}

function showBingeIndicator(status) {
  if (!status) return;

  var usedSecs = status.usedSecs || (status.usedMins || 0) * 60;
  var limitSecs = status.limitSecs || (status.limitMins || 5) * 60;
  var pct = Math.min(usedSecs / limitSecs, 1);
  var remainSecs = Math.max(limitSecs - usedSecs, 0);
  var danger = pct >= 0.75;
  var critical = pct >= 0.9;

  // Fire sound alerts when crossing thresholds
  if (critical && lastBingePct < 0.9) playBingeWarning("critical");
  else if (danger && lastBingePct < 0.75) playBingeWarning("danger");
  lastBingePct = pct;

  function fmt(s) {
    var m = Math.floor(s / 60), sec = s % 60;
    if (m === 0) return sec + "s";
    if (sec === 0) return m + "m";
    return m + "m " + sec + "s";
  }

  var widget = document.getElementById("adb-binge-indicator");

  // Create widget once — subsequent calls just update values in-place
  if (!widget) {
    widget = document.createElement("div");
    widget.id = "adb-binge-indicator";
    if (currentTheme && currentTheme !== 'default') widget.classList.add('adb-theme-' + currentTheme);
    widget.innerHTML =
      '<div class="adb-binge-header">' +
        '<span class="adb-binge-icon"></span>' +
        '<span class="adb-binge-domain">' + status.domain + '</span>' +
        '<span class="adb-binge-close" id="adb-binge-close">\u00D7</span>' +
      '</div>' +
      '<div class="adb-binge-bar-wrap"><div class="adb-binge-bar-fill" id="adb-binge-fill"></div></div>' +
      '<div class="adb-binge-footer">' +
        '<span class="adb-binge-used" id="adb-binge-used"></span>' +
        '<span class="adb-binge-left" id="adb-binge-left"></span>' +
      '</div>';
    document.body.appendChild(widget);
    widget.addEventListener("click", function (e) {
      if (e.target.id === "adb-binge-close") removeBingeIndicator();
    });
  }

  // Update values in-place — no DOM removal/recreation
  widget.className = critical ? "critical" : danger ? "danger" : "";
  var iconEl = widget.querySelector(".adb-binge-icon");
  var fillEl = document.getElementById("adb-binge-fill");
  var usedEl = document.getElementById("adb-binge-used");
  var leftEl = document.getElementById("adb-binge-left");

  if (iconEl) iconEl.textContent = critical ? "\u26A0\uFE0F" : "\u23F1\uFE0F";
  if (fillEl) fillEl.style.width = Math.round(pct * 100) + "%";
  if (usedEl) usedEl.textContent = fmt(usedSecs) + " / " + fmt(limitSecs) + " used";
  if (leftEl) {
    leftEl.textContent = remainSecs > 0 ? fmt(remainSecs) + " left" : "Limit reached";
    leftEl.className = "adb-binge-left" + (critical ? " red" : "");
  }
}

function removeBingeIndicator() {
  var el = document.getElementById("adb-binge-indicator");
  if (el) el.remove();
}

// ── Overlay ──
function removeOverlay() {
  var el = document.getElementById("adb-overlay");
  if (el) el.remove();
}

function createOverlay(className) {
  var el = document.createElement("div");
  el.id = "adb-overlay";
  el.className = className;
  return el;
}

var currentTheme = 'default';
// Load theme once on page load
chrome.storage.local.get({ theme: 'default' }, function (data) {
  currentTheme = data.theme || 'default';
});

function goBack() {
  safeSend({ type: "STAGE_RESET" });
  removeOverlay();
  removeCountdownBadge();
  history.back();
}

function showStage(stage, bingeStatus) {
  removeOverlay();
  removeCountdownBadge();
  if (stage === 0) return;
  var themeClass = currentTheme && currentTheme !== 'default' ? 'adb-theme-' + currentTheme : '';

  if (stage === 1) {
    playAlert("warning");
    var overlay = createOverlay("adb-stage-1" + (themeClass ? ' ' + themeClass : ''));
    overlay.innerHTML =
      '<div class="adb-card">' +
      '<span class="adb-icon">\uD83E\uDDE0</span>' +
      '<div class="adb-stage-badge">Focus Check</div>' +
      "<h2>" + randomQuote() + "</h2>" +
      '<p class="adb-sub">This content was flagged as distracting during your focus hours.</p>' +
      '<div class="adb-btn-group">' +
      '<button class="adb-btn adb-btn-primary" id="adb-back">Go back to work</button>' +
      '<button class="adb-btn adb-btn-ghost" id="adb-continue">Continue anyway</button>' +
      "</div>" +
      "</div>";
    document.body.appendChild(overlay);
    document.getElementById("adb-back").addEventListener("click", goBack);
    document.getElementById("adb-continue").addEventListener("click", function () {
      removeOverlay();
      showCountdownBadge(20, function () {
        safeSend({ type: "STAGE_ADVANCE" }, function (res) {
          if (res && res.stage > 0) showStage(res.stage);
        });
      });
    });
  } else if (stage === 2) {
    playAlert("final");
    var overlay = createOverlay("adb-stage-2" + (themeClass ? ' ' + themeClass : ''));
    overlay.innerHTML =
      '<div class="adb-card">' +
      '<span class="adb-icon">\u26A0\uFE0F</span>' +
      '<div class="adb-stage-badge red">Last Warning</div>' +
      "<h2>" + randomQuote() + "</h2>" +
      '<p class="adb-sub">This is your final warning. Continuing will lock this page.</p>' +
      '<div class="adb-btn-group">' +
      '<button class="adb-btn adb-btn-primary" id="adb-back">Go back to work</button>' +
      '<button class="adb-btn adb-btn-ghost" id="adb-continue">I\'ll take the risk</button>' +
      "</div>" +
      "</div>";
    document.body.appendChild(overlay);
    document.getElementById("adb-back").addEventListener("click", goBack);
    document.getElementById("adb-continue").addEventListener("click", function () {
      removeOverlay();
      showCountdownBadge(20, function () {
        safeSend({ type: "STAGE_ADVANCE" }, function (res) {
          if (res && res.stage > 0) showStage(res.stage);
        });
      });
    });
  } else if (stage === 3) {
    playAlert("block");
    document.body.style.overflow = "hidden";
    var isBinge = bingeStatus && bingeStatus.blocked;
    var overlay = createOverlay("adb-stage-3" + (themeClass ? ' ' + themeClass : ''));

    function fmtSecs(s) {
      var m = Math.floor(s / 60),
        sec = s % 60;
      if (m === 0) return sec + "s";
      if (sec === 0) return m + "m";
      return m + "m " + sec + "s";
    }

    var usedSecs = bingeStatus
      ? bingeStatus.usedSecs || (bingeStatus.usedMins || 0) * 60
      : 0;
    var limitSecs = bingeStatus
      ? bingeStatus.limitSecs || (bingeStatus.limitMins || 5) * 60
      : 0;

    var subText = isBinge
      ? "You've used <strong>" +
        fmtSecs(usedSecs) +
        "</strong> of " +
        bingeStatus.domain +
        " in the last " +
        bingeStatus.windowHours +
        "h (limit: " +
        fmtSecs(limitSecs) +
        ")."
      : "You've reached your limit for this page during focus hours.";

    var unblockText = "";
    if (isBinge && bingeStatus.unblockAt) {
      var msLeft = bingeStatus.unblockAt - Date.now();
      var minsLeft = Math.ceil(msLeft / 60000);
      unblockText =
        '<p class="adb-unblock-time">Unblocks in ~' + minsLeft + " min</p>";
    }

    var domain = "";
    try {
      domain = new URL(window.location.href).hostname.replace(/^www\./, "");
    } catch (e) {}

    overlay.innerHTML =
      '<div class="adb-hard-block">' +
      (domain ? '<div class="adb-hard-domain">' + domain + "</div>" : "") +
      '<span class="adb-quote-mark">\u201C</span>' +
      '<p class="adb-quote-text">' +
      randomHardQuote() +
      "</p>" +
      '<p class="adb-quote-sub">' +
      subText +
      "</p>" +
      unblockText +
      '<button class="adb-btn-exit" id="adb-exit">Leave This Website</button>' +
      "</div>";
    document.body.appendChild(overlay);
    var exitBtn = document.getElementById("adb-exit");

    // Live countdown for binge unblock
    if (isBinge && bingeStatus.unblockAt) {
      var unblockInterval = setInterval(function () {
        var el = document.querySelector(".adb-unblock-time");
        if (!el) {
          clearInterval(unblockInterval);
          return;
        }
        var ms = bingeStatus.unblockAt - Date.now();
        if (ms <= 0) {
          clearInterval(unblockInterval);
          el.textContent = "You can now continue.";
          exitBtn.textContent = "Continue";
          exitBtn.style.background = "linear-gradient(135deg,#f59e0b,#d97706)";
          exitBtn.replaceWith(exitBtn.cloneNode(true)); // remove all old listeners
          document.getElementById("adb-exit").addEventListener("click", function () {
              document.body.style.overflow = "";
              removeOverlay();
              safeSend({ type: "STAGE_RESET" });
            });
        } else {
          var mins = Math.floor(ms / 60000);
          var secs = Math.floor((ms % 60000) / 1000);
          el.textContent = "Unblocks in " + mins + "m " + secs + "s";
        }
      }, 1000);
    }

    exitBtn.addEventListener("click", function () {
      var domain = "";
      try { domain = new URL(window.location.href).hostname.replace(/^www\./, ""); } catch (e) {}
      safeSend({ type: "CLEAR_ESCALATION_BLOCK", domain: domain });
      safeSend({ type: "STAT_INCREMENT", field: "exited" });
      document.body.style.overflow = "";
      history.back();
    });
  }
}

// ── Classify page ──
var isDistractingPage = false; // track if current page is distracting
var bingeHeartbeatInterval = null;

function stopBingeHeartbeat() {
  clearInterval(bingeHeartbeatInterval);
  bingeHeartbeatInterval = null;
  isDistractingPage = false;
  lastBingePct = 0;
}

function startBingeHeartbeat(url) {
  stopBingeHeartbeat();
  isDistractingPage = true;

  // Tick every 1s — records 1s of usage, updates indicator in real time,
  // and triggers block within 1s of limit being hit
  bingeHeartbeatInterval = setInterval(function () {
    if (!isDistractingPage) { stopBingeHeartbeat(); return; }
    safeSend({ type: "BINGE_HEARTBEAT", url: url, secs: 1 }, function (res) {
      if (!res || !res.status) return;
      var status = res.status;
      if (status.blocked) {
        stopBingeHeartbeat();
        showStage(3, status);
      } else if (!document.getElementById("adb-overlay")) {
        showBingeIndicator(status);
      }
    });
  }, 1000);
}

function classifyCurrentPage() {
  var url = window.location.href;
  if (!url.startsWith("http")) return;
  var title = document.title || "";
  var descEl = document.querySelector('meta[name="description"]') ||
    document.querySelector('meta[property="og:description"]');
  var description = descEl ? descEl.content : "";

  safeSend({ type: "CLASSIFY_PAGE", url: url, title: title, description: description }, function (res) {
    if (!res) return;
    if (res.stage > 0) {
      showStage(res.stage, res.bingeStatus);
    } else if (res.bingeStatus && !res.bingeStatus.blocked) {
      showBingeIndicator(res.bingeStatus);
    }
    if (res.stage > 0 || res.bingeStatus) {
      startBingeHeartbeat(url);
    }
  });
}

// ── SPA navigation ──
var lastUrl = location.href;
(function () {
  var wrap = function (method) {
    var orig = history[method];
    history[method] = function () {
      orig.apply(this, arguments);
      window.dispatchEvent(new Event("adb-urlchange"));
    };
  };
  wrap("pushState");
  wrap("replaceState");
})();
window.addEventListener("popstate", function () {
  window.dispatchEvent(new Event("adb-urlchange"));
});
window.addEventListener("adb-urlchange", function () {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    removeOverlay();
    removeCountdownBadge();
    removeBingeIndicator();
    stopBingeHeartbeat();
    document.body.style.overflow = "";
    safeSend({ type: "STAGE_RESET" });
    setTimeout(classifyCurrentPage, 600);
  }
});

// ── Doomscroll ──
var lastScrollY = window.scrollY,
  lastScrollTime = Date.now(),
  rapidScrollCount = 0,
  lastDoomTs = 0;
window.addEventListener(
  "scroll",
  function () {
    var now = Date.now(),
      delta = Math.abs(window.scrollY - lastScrollY),
      elapsed = now - lastScrollTime;
    if (elapsed > 0 && delta / elapsed > 2) rapidScrollCount++;
    else rapidScrollCount = Math.max(0, rapidScrollCount - 1);
    lastScrollY = window.scrollY;
    lastScrollTime = now;
    if (
      rapidScrollCount >= 10 &&
      now - lastDoomTs > 10000 &&
      !document.getElementById("adb-overlay")
    ) {
      lastDoomTs = now;
      rapidScrollCount = 0;
      classifyCurrentPage();
    }
  },
  { passive: true },
);

// ── Keyboard shortcut: Escape dismisses stage 1/2 ──
document.addEventListener(
  "keydown",
  function (e) {
    if (e.key !== "Escape") return;
    var overlay = document.getElementById("adb-overlay");
    if (!overlay) return;
    if (overlay.classList.contains("adb-stage-3")) return;
    goBack();
  },
  true,
);

classifyCurrentPage();
