// ===================== SCROLL REVEAL =====================
// Fades/slides in any element with class="reveal" once it enters the
// viewport — same effect as the marketing site's <Reveal> component.
// Elements can set data-reveal-delay="120" (ms) for a staggered entrance.

function initRevealOnScroll() {
  const items = document.querySelectorAll(".reveal");
  if (!items.length) return;

  if (!("IntersectionObserver" in window)) {
    items.forEach((el) => el.classList.add("is-visible"));
    return;
  }

  const observer = new IntersectionObserver(
    (entries, obs) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          obs.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.15, rootMargin: "0px 0px -40px 0px" }
  );

  items.forEach((el) => {
    const delay = el.getAttribute("data-reveal-delay");
    if (delay) el.style.transitionDelay = `${delay}ms`;
    observer.observe(el);
  });
}

document.addEventListener("DOMContentLoaded", initRevealOnScroll);

// ===================== DARK MODE =====================
// The actual `data-theme` attribute is set as early as possible by a small
// inline script in each template's <head> (before the stylesheet paints),
// so switching themes never causes a flash of the wrong colors on load —
// see the top of templates/index.html / templates/result.html. Everything
// here just keeps toggle buttons in sync and handles clicking them.
const THEME_STORAGE_KEY = "ecosort_theme";

function syncThemeToggleButtons() {
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  document.querySelectorAll(".js-theme-icon").forEach((icon) => {
    icon.className = isDark ? "fa-solid fa-sun" : "fa-solid fa-moon";
  });
  document.querySelectorAll(".js-theme-label").forEach((label) => {
    label.textContent = isDark ? "Light" : "Dark";
  });
  document.querySelectorAll(".js-theme-toggle").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(isDark));
    btn.title = isDark ? "Switch to light mode" : "Switch to dark mode";
  });
}

function toggleDarkMode() {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch (e) {
    // Private browsing / storage disabled — theme still applies for this
    // page view, it just won't be remembered on the next visit.
  }
  syncThemeToggleButtons();
}
window.toggleDarkMode = toggleDarkMode;

document.addEventListener("DOMContentLoaded", syncThemeToggleButtons);

// ===================== SCAN HISTORY =====================
// A lightweight, on-device log of past scans (thumbnail + result), stored
// in localStorage rather than server-side — nothing here changes what the
// backend keeps, and it works the same whether the account is "just this
// browser" or nothing at all. Each result-page view records itself once
// (see the DOMContentLoaded handler near the bottom of this section);
// viewing/deleting happens through the modal opened via openHistoryModal().

const HISTORY_STORAGE_KEY = "ecosort_scan_history";
const HISTORY_MAX_ENTRIES = 24; // keep localStorage usage bounded
const HISTORY_THUMB_MAX_DIM = 180; // px, longest side of the stored thumbnail

const HISTORY_CATEGORY_COLORS = {
  biodegradable: "var(--sig-organic)",
  hazardous: "var(--sig-hazard)",
  non_recyclable: "var(--sig-general)",
  recyclable: "var(--sig-recycle)",
};

function loadScanHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function saveScanHistory(list) {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(list));
    return true;
  } catch (e) {
    // Most likely quota exceeded from accumulated thumbnails — drop the
    // older half and retry once instead of losing the newest scan outright.
    try {
      localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(list.slice(0, Math.ceil(list.length / 2))));
      return true;
    } catch (e2) {
      return false;
    }
  }
}

// Adds/updates one entry (matched by id) at the front of the list. Using
// the scan's own filename as the id means refreshing a result page updates
// its existing history row instead of duplicating it.
function upsertScanHistoryEntry(entry) {
  const list = loadScanHistory().filter((item) => item.id !== entry.id);
  list.unshift(entry);
  saveScanHistory(list.slice(0, HISTORY_MAX_ENTRIES));
}

function removeScanHistoryEntry(id) {
  saveScanHistory(loadScanHistory().filter((item) => item.id !== id));
}

function clearScanHistory() {
  saveScanHistory([]);
}

// Downscales a same-origin scan photo into a small JPEG data URL so history
// entries stay cheap in localStorage instead of storing full-resolution
// photos (which would blow through the quota after a handful of scans).
function buildHistoryThumbnail(imageUrl) {
  return new Promise((resolve) => {
    if (!imageUrl) {
      resolve(null);
      return;
    }
    const img = new Image();
    img.onload = () => {
      try {
        const longest = Math.max(img.naturalWidth, img.naturalHeight) || 1;
        const scale = Math.min(1, HISTORY_THUMB_MAX_DIM / longest);
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.7));
      } catch (e) {
        resolve(null); // e.g. a tainted canvas — the entry just renders without a thumbnail
      }
    };
    img.onerror = () => resolve(null);
    img.src = imageUrl;
  });
}

function formatHistoryTimestamp(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `Today, ${time}`;
  const dateOpts = d.getFullYear() === now.getFullYear()
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" };
  return `${d.toLocaleDateString(undefined, dateOpts)}, ${time}`;
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function renderScanHistoryList() {
  const listEl = document.getElementById("historyList");
  const clearBtn = document.getElementById("historyClearBtn");
  if (!listEl) return;

  const items = loadScanHistory();
  if (clearBtn) clearBtn.disabled = items.length === 0;

  if (!items.length) {
    listEl.innerHTML = `
      <div class="history-empty">
        <i class="fa-solid fa-clock-rotate-left"></i>
        No scans yet — your history will show up here after your first scan.
      </div>`;
    return;
  }

  listEl.innerHTML = items.map((item) => `
    <div class="history-item">
      ${item.thumbnail
        ? `<img class="history-thumb" src="${item.thumbnail}" alt="">`
        : `<div class="history-thumb"><i class="fa-solid fa-image"></i></div>`}
      <div class="history-meta">
        <div class="history-label-row">
          <span class="history-dot" style="background:${HISTORY_CATEGORY_COLORS[item.rawLabel] || "var(--sig-general)"};"></span>
          <span class="history-label">${escapeHtml(item.prediction)}</span>
        </div>
        <span class="history-sub">${escapeHtml(item.confidence)} confidence &middot; ${formatHistoryTimestamp(item.timestamp)}</span>
      </div>
      <button type="button" class="history-delete-btn" title="Delete this scan" aria-label="Delete this scan" data-history-delete="${escapeHtml(item.id)}">
        <i class="fa-solid fa-trash-can"></i>
      </button>
    </div>
  `).join("");
}

// The modal markup is injected once, on first open, rather than duplicated
// inside both index.html and result.html — it needs to work identically on
// either page, and this keeps that in one place.
function ensureHistoryModal() {
  if (document.getElementById("historyModal")) return;

  const modal = document.createElement("div");
  modal.id = "historyModal";
  modal.className = "modal";
  modal.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <h3><i class="fa-solid fa-clock-rotate-left"></i> Scan History</h3>
        <button type="button" class="close-btn" id="historyCloseBtn" title="Close" aria-label="Close">&times;</button>
      </div>
      <div class="history-toolbar">
        <button type="button" class="history-clear-btn" id="historyClearBtn">
          <i class="fa-solid fa-trash-can"></i> Clear all
        </button>
      </div>
      <div class="history-list" id="historyList"></div>
    </div>
  `;
  document.body.appendChild(modal);

  document.getElementById("historyCloseBtn").addEventListener("click", closeHistoryModal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeHistoryModal();
  });
  document.getElementById("historyClearBtn").addEventListener("click", () => {
    if (!confirm("Delete all scan history? This can't be undone.")) return;
    clearScanHistory();
    renderScanHistoryList();
  });
  document.getElementById("historyList").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-history-delete]");
    if (!btn) return;
    removeScanHistoryEntry(btn.getAttribute("data-history-delete"));
    renderScanHistoryList();
  });
}

function openHistoryModal() {
  ensureHistoryModal();
  renderScanHistoryList();
  document.getElementById("historyModal").style.display = "block";
  document.body.style.overflow = "hidden";
}

function closeHistoryModal() {
  const modal = document.getElementById("historyModal");
  if (modal) modal.style.display = "none";
  document.body.style.overflow = "auto";
}
window.openHistoryModal = openHistoryModal;
window.closeHistoryModal = closeHistoryModal;

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeHistoryModal();
});

// Records the scan currently shown on the result page into history. Reads
// from the hidden #resultHistoryData element (see templates/result.html),
// which carries the values already rendered on the page as data attributes
// rather than re-deriving them here.
document.addEventListener("DOMContentLoaded", () => {
  const dataEl = document.getElementById("resultHistoryData");
  if (!dataEl) return;

  const entry = {
    id: dataEl.dataset.id,
    prediction: dataEl.dataset.prediction,
    rawLabel: dataEl.dataset.rawLabel,
    confidence: dataEl.dataset.confidence,
    isHazard: dataEl.dataset.isHazard === "true",
    timestamp: new Date().toISOString(),
    thumbnail: null,
  };

  buildHistoryThumbnail(dataEl.dataset.image).then((thumbnail) => {
    entry.thumbnail = thumbnail;
    upsertScanHistoryEntry(entry);
  });
});

// ===================== SPLASH SCREEN =====================
// Flow is now: splash (loading) -> welcome/info screen -> scan console.
// Previously the splash went straight into the live scanner; now it stops
// at an info screen first, and the person explicitly taps "Start Scanning"
// to proceed (rather than the camera grabbing focus/permissions before
// they've even seen what the app does).

window.addEventListener("load", () => {
  const splash = document.getElementById("splash-screen");
  const welcome = document.getElementById("welcome-screen");

  staggerWordmark(document.querySelector(".splash-title"));

  if (splash && welcome) {
    setTimeout(() => {
      splash.classList.add("hide");
      welcome.classList.remove("hidden");
      staggerWordmark(document.querySelector(".welcome-title"));
    }, 2500);
  }
});

// ===================== WORDMARK LETTER-STAGGER REVEAL =====================
// Splits the "Eco"/"Sort" spans inside a title element into one <span
// class="letter-pop"> per character, each with an increasing animation
// delay, so the wordmark reveals letter-by-letter instead of popping in
// as a solid block. Runs once per element (guarded by data-staggered) so
// re-showing the welcome screen later via showWelcomeScreen() doesn't
// re-split already-split spans.

function staggerWordmark(titleEl) {
  if (!titleEl || titleEl.dataset.staggered === "true") return;

  const prefersReducedMotion =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const wordSpans = titleEl.querySelectorAll(".brand-word-eco, .brand-word-sort");
  if (!wordSpans.length) return;

  if (prefersReducedMotion) {
    titleEl.dataset.staggered = "true";
    return;
  }

  let index = 0;
  wordSpans.forEach((word) => {
    const letters = word.textContent.split("");
    word.textContent = "";
    letters.forEach((ch) => {
      const span = document.createElement("span");
      span.className = "letter-pop";
      span.style.animationDelay = `${index * 45}ms`;
      span.textContent = ch === " " ? "\u00A0" : ch;
      word.appendChild(span);
      index++;
    });
  });

  titleEl.dataset.staggered = "true";
}

document.addEventListener("DOMContentLoaded", () => {
  const welcomeStartBtn = document.getElementById("welcomeStartBtn");
  const welcome = document.getElementById("welcome-screen");
  const main = document.getElementById("main-content");

  if (welcomeStartBtn && welcome && main) {
    welcomeStartBtn.addEventListener("click", () => {
      startScanTransition(welcomeStartBtn, welcome, main);
    });
  }
});

// ===================== SCAN START TRANSITION (IRIS WIPE) =====================
// Growing-circle "reveal" used when leaving the welcome screen: a themed
// green circle expands out from wherever the "Start Scanning" button
// actually is on screen until it covers the full viewport, the welcome
// screen and scan console are swapped while completely hidden behind it,
// then the circle shrinks back to nothing from the same point, uncovering
// the console. Distances are computed from the button's live
// getBoundingClientRect() + the current window size, so it's correct at
// any viewport — phone, tablet, or desktop — and re-computes fresh on
// every click rather than assuming a fixed layout.

const SCAN_TRANSITION_EXPAND_MS = 650;
const SCAN_TRANSITION_HOLD_MS = 160;
const SCAN_TRANSITION_CONTRACT_MS = 550;

function startScanTransition(triggerBtn, welcome, main) {
  const panel = document.getElementById("scanTransitionPanel");

  // If anything's missing, or the browser has "reduce motion" turned on,
  // fall back to the plain instant swap rather than skip navigation.
  const prefersReducedMotion =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (!panel || !triggerBtn || prefersReducedMotion) {
    welcome.classList.add("hide");
    main.classList.remove("hidden");
    setTimeout(() => welcome.classList.add("hidden"), 400);
    return;
  }

  const rect = triggerBtn.getBoundingClientRect();
  const ox = Math.round(rect.left + rect.width / 2);
  const oy = Math.round(rect.top + rect.height / 2);
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Radius that guarantees the circle covers the farthest corner of the
  // viewport from the origin point, plus a small safety margin.
  const radius = Math.round(
    Math.hypot(Math.max(ox, vw - ox), Math.max(oy, vh - oy)) + 32
  );

  const clipAt = (r) => `circle(${r}px at ${ox}px ${oy}px)`;

  // Start fully collapsed at the button's own position, then force a
  // reflow so that starting state is actually committed before the
  // transition to the expanded state begins on the next frame.
  panel.style.transition = "none";
  panel.style.clipPath = clipAt(0);
  panel.style.webkitClipPath = clipAt(0);
  panel.classList.remove("revealing");
  panel.classList.add("active");
  panel.setAttribute("aria-hidden", "false");
  void panel.offsetWidth;

  requestAnimationFrame(() => {
    panel.style.transition = `clip-path ${SCAN_TRANSITION_EXPAND_MS}ms cubic-bezier(0.65,0,0.35,1)`;
    panel.classList.add("expanding");
    panel.style.clipPath = clipAt(radius);
    panel.style.webkitClipPath = clipAt(radius);
  });

  setTimeout(() => {
    // Fully covered now — swap screens behind the panel where it can't
    // be seen, exactly like the old instant swap used to do on its own.
    welcome.classList.add("hide", "hidden");
    main.classList.remove("hidden");
    panel.classList.remove("expanding");
    panel.classList.add("revealing");

    // Brief hold on full coverage so the swap never reads as a flicker,
    // then contract the same circle back down to nothing to reveal the
    // console underneath.
    setTimeout(() => {
      panel.style.transition = `clip-path ${SCAN_TRANSITION_CONTRACT_MS}ms cubic-bezier(0.65,0,0.35,1)`;
      panel.style.clipPath = clipAt(0);
      panel.style.webkitClipPath = clipAt(0);

      setTimeout(() => {
        panel.classList.remove("active", "revealing");
        panel.setAttribute("aria-hidden", "true");
      }, SCAN_TRANSITION_CONTRACT_MS + 50);
    }, SCAN_TRANSITION_HOLD_MS);
  }, SCAN_TRANSITION_EXPAND_MS);
}

/**
 * Re-open the welcome/home info screen from the "About" rail button,
 * reusing the same screen shown right after the splash rather than a
 * separate modal.
 */
function showWelcomeScreen() {
  const welcome = document.getElementById("welcome-screen");
  const main = document.getElementById("main-content");
  if (!welcome || !main) return;

  welcome.classList.remove("hide", "hidden");
  main.classList.add("hidden");
}

// ===================== LOGO TRANSITION =====================
// Tapping the header logo flies a clone of it to the center of the
// screen while spinning, fades the console out behind it, and lands on
// a copy of the splash screen. Tapping that logo again reverses it back
// to the welcome/home screen — same flight mechanics, opposite endpoints.

const LOGO_FLIGHT_MS = 800;        // must match the CSS transition duration

// Previously the destination screen waited LOGO_REVEAL_DELAY_MS (250ms)
// after the flight started before it even began its own (shorter, 500ms)
// fade-in — so for the first quarter-second nothing but the clone moved,
// then the new screen abruptly started appearing and finished fading in
// slightly before the flight/outgoing fade did. That mismatch is what
// read as "a small pause, then the design changes" instead of one
// continuous motion. Both fades now start at the same instant as the
// flight and share its exact duration/easing (see .app-shell.leaving and
// .logo-transition-screen in style.css), so the old screen fading out,
// the new screen fading in, and the logo flying are all perfectly
// in sync as a single crossfade.

/**
 * Animate the shared clone from sourceEl's position/size to targetEl's,
 * hiding sourceEl's own icon for the duration so there's never a
 * duplicate on screen. Calls onComplete once the flight finishes.
 */
function flyLogoClone(sourceEl, targetEl, onComplete) {
  const clone = document.getElementById("logoFlyClone");
  if (!clone || !sourceEl || !targetEl) return;

  const startRect = sourceEl.getBoundingClientRect();
  const endRect = targetEl.getBoundingClientRect();

  // Snap the clone onto the source's exact position/size with no
  // transition, so the jump to the start point is itself never animated.
  clone.style.transition = "none";
  clone.style.left = startRect.left + "px";
  clone.style.top = startRect.top + "px";
  clone.style.width = startRect.width + "px";
  clone.style.height = startRect.height + "px";
  clone.style.transform = "translate(0, 0) scale(1)";
  clone.classList.remove("hidden");
  sourceEl.classList.add("flying");

  const dx = endRect.left - startRect.left;
  const dy = endRect.top - startRect.top;
  const scale = endRect.width / startRect.width;

  // Two rAFs: the first lets the browser paint the clone at its start
  // position, the second re-enables the transition and sets the end
  // state, so it always has a real starting frame to animate from.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      clone.style.transition = "";
      clone.classList.add("spinning");
      clone.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
    });
  });

  setTimeout(() => {
    clone.classList.add("hidden");
    clone.classList.remove("spinning");
    sourceEl.classList.remove("flying");
    if (onComplete) onComplete();
  }, LOGO_FLIGHT_MS);
}

function startLogoTransition(event) {
  const brandIcon = document.getElementById("brandIcon");
  const appShell = document.querySelector(".app-shell");
  const main = document.getElementById("main-content");
  const transitionScreen = document.getElementById("logo-transition-screen");
  const transitionLogoCircle = document.getElementById("transitionLogoCircle");
  if (!brandIcon || !appShell || !main || !transitionScreen || !transitionLogoCircle) return;

  // Fade the console out and fade the dark screen in as one simultaneous
  // crossfade, perfectly in step with the clone's flight.
  appShell.classList.add("leaving");
  transitionScreen.classList.remove("hidden");

  flyLogoClone(brandIcon, transitionLogoCircle, () => {
    main.classList.add("hidden");
    appShell.classList.remove("leaving");
  });
}

function returnFromLogoTransition() {
  const transitionScreen = document.getElementById("logo-transition-screen");
  const transitionLogoCircle = document.getElementById("transitionLogoCircle");
  const brandIcon = document.getElementById("brandIcon");
  const main = document.getElementById("main-content");
  if (!transitionScreen || !transitionLogoCircle || !brandIcon || !main) return;

  // BUGFIX: this used to land on the welcome/info screen (via
  // showWelcomeScreen()) instead of back on the scan console the person
  // actually came from — startLogoTransition() is only ever triggered from
  // the header logo INSIDE main-content, so "tap the logo to go back"
  // should return there, not to an unrelated screen. Mirror the forward
  // crossfade but with main-content/brandIcon as the destination, both
  // fades starting at the same instant as the flight (see startLogoTransition).
  transitionScreen.classList.add("hidden");
  main.classList.remove("hidden");

  flyLogoClone(transitionLogoCircle, brandIcon);
}

// ===================== DASHBOARD PAGE =====================

/**
 * Initialize image upload preview functionality
 */
function initializeImageUpload() {
  const imageInput = document.getElementById("imageInput");
  const previewBox = document.getElementById("previewBox");
  const previewImage = document.getElementById("previewImage");

  if (!imageInput) return;

  imageInput.addEventListener("change", function () {
    const file = this.files[0];
    if (file) {
      const objectUrl = URL.createObjectURL(file);
      previewImage.src = objectUrl;
      previewBox.style.display = "block";
      previewImage.onload = function () {
        URL.revokeObjectURL(objectUrl);
      };
    }
  });
}

document.addEventListener("DOMContentLoaded", initializeImageUpload);
