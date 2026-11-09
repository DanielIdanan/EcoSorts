// ===================== SCAN + RESULT VIEW (on-device) =====================
// Replaces the Flask POST / -> templates/result.html round trip. A photo (from
// the camera capture or the upload fallback) is classified in the browser and
// the result screen is filled in right here; nothing is uploaded anywhere.

(function () {
  const $ = (id) => document.getElementById(id);

  const MAX_BYTES = 10 * 1024 * 1024; // same 10MB cap app.py enforced
  const ALLOWED_EXT = [".jpg", ".jpeg", ".png", ".webp"];

  let currentImageUrl = null;

  // ---------- flash messages (replaces Flask's flash()) ----------
  function flash(message, category) {
    const stack = $("flashStack");
    if (!stack) return;
    const el = document.createElement("div");
    el.className = "flash-message " + (category || "error");
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(() => el.remove(), 6000);
  }

  // ---------- image decoding ----------
  async function decodeImage(file, url) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(file); } catch (e) { /* fall through to <img> */ }
    }
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("decode failed"));
      img.src = url;
    });
  }

  // ---------- main entry: classify a File and show the result ----------
  async function scanFile(file) {
    if (!file) {
      flash("Please capture or choose an image.", "error");
      return false;
    }

    const name = (file.name || "").toLowerCase();
    const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : ".jpg";
    if (!(file.type || "").startsWith("image/") || !ALLOWED_EXT.includes(ext)) {
      flash("Please upload a JPG, PNG, or WEBP image.", "error");
      return false;
    }
    if (file.size > MAX_BYTES) {
      flash("That image is too large (10MB max). Try a smaller photo.", "error");
      return false;
    }

    const url = URL.createObjectURL(file);
    let result;
    try {
      const bitmap = await decodeImage(file, url);
      result = await window.EcoSortClassifier.classify(bitmap);
      if (bitmap.close) bitmap.close();
    } catch (e) {
      console.error("[scan] failed:", e);
      URL.revokeObjectURL(url);
      const modelProblem = /onnxruntime|model|fetch|network|load/i.test(String(e && e.message));
      flash(modelProblem
        ? "The scanning model couldn't load. Check your connection and try again."
        : "That file couldn't be read as an image. Please try a different photo.", "error");
      return false;
    }

    showResult(url, result);
    return true;
  }

  // ---------- result screen ----------
  function showResult(imageUrl, result) {
    if (currentImageUrl) URL.revokeObjectURL(currentImageUrl);
    currentImageUrl = imageUrl;

    const confidenceText = result.confidence.toFixed(2) + "%";
    const hazard = result.is_hazard;

    $("resultImage").src = imageUrl;
    $("resultStamp").textContent = result.prediction;
    $("resultStamp").classList.toggle("stamp-badge-hazard", hazard);
    $("hazardBanner").hidden = !hazard;
    $("resultPrediction").textContent = result.prediction;
    $("resultPrediction").classList.toggle("result-value-hazard", hazard);
    $("resultPredictionRow").classList.toggle("result-row-hazard", hazard);
    $("resultConfidence").textContent = confidenceText;
    $("resultTip").textContent = result.tip;
    $("resultTipBox").classList.toggle("tip-box-hazard", hazard);
    $("resultTipIcon").className = "fa-solid " + (hazard ? "fa-skull-crossbones" : "fa-lightbulb");

    $("main-content").hidden = true;
    $("resultPage").hidden = false;
    window.scrollTo(0, 0);

    // Let the browser's Back button return to the scanner instead of leaving the site.
    try { history.pushState({ view: "result" }, "", "#result"); } catch (e) { /* e.g. sandboxed iframe */ }

    recordHistory(imageUrl, result, confidenceText);
  }

  function leaveResult() {
    $("resultPage").hidden = true;
    $("main-content").hidden = false;
    if (window.resetScanUI) window.resetScanUI();
    window.scrollTo(0, 0);
  }

  // Feeds the scan into the on-device history log (see SCAN HISTORY in app.js).
  function recordHistory(imageUrl, result, confidenceText) {
    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      prediction: result.prediction,
      rawLabel: result.raw_label,
      confidence: confidenceText,
      isHazard: result.is_hazard,
      timestamp: new Date().toISOString(),
      thumbnail: null,
    };
    buildHistoryThumbnail(imageUrl).then((thumbnail) => {
      entry.thumbnail = thumbnail;
      upsertScanHistoryEntry(entry);
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    const again = $("scanAgainBtn");
    if (again) {
      again.addEventListener("click", () => {
        if (history.state && history.state.view === "result") history.back(); // popstate -> leaveResult
        else leaveResult();
      });
    }
  });

  window.addEventListener("popstate", () => {
    const page = $("resultPage");
    if (page && !page.hidden) leaveResult();
  });

  window.EcoSortApp = { scanFile, flash };
})();
