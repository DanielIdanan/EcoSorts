// ===================== LIVE CAMERA SCANNING =====================
// Turns on the device camera, lets the user frame waste items, captures a
// still frame, and feeds it into the hidden #imageInput, which the scan form
// then classifies on-device (see result.js) — there is no backend any more.
//
// LIVE MULTI-ITEM DETECTION
// Our own waste model (static/js/classifier.js, running in the browser) is an image CLASSIFIER — given one
// image, it says "this whole picture is X% hazardous, Y% recyclable, etc."
// It has no idea WHERE an item is in frame, and no way to tell two items
// apart in the same shot.
//
// To draw a separate box on each item (like a security-camera AI), we pair
// it with a YOLOv8n DETECTOR trained on waste photos (detector.js, runs in the
// browser too). It answers "here are N regions that look like waste items".
// For every region it finds, we crop that piece of the frame and send THAT
// crop to our waste-bin classifier, and draw its answer on that box.
// Detection (where) and classification (which bin) are two different models
// doing two different jobs.
(function () {
  const startBtn = document.getElementById("startCameraBtn");
  if (!startBtn) return; // not on the dashboard page

  const switchBtn = document.getElementById("switchCameraBtn");
  const stopBtn = document.getElementById("stopCameraBtn");
  const captureBtn = document.getElementById("captureBtn");
  const retakeBtn = document.getElementById("retakeBtn");

  const video = document.getElementById("cameraStream");
  const canvas = document.getElementById("captureCanvas");
  const capturedPreview = document.getElementById("capturedPreview");
  const overlay = document.getElementById("cameraOverlay");
  const overlayText = document.getElementById("cameraOverlayText");
  const overlayIcon = document.getElementById("cameraOverlayIcon");
  const retryBtn = document.getElementById("cameraRetryBtn");
  const imageInput = document.getElementById("imageInput");

  const cameraControls = document.getElementById("cameraControls");
  const captureControls = document.getElementById("captureControls");
  const confirmControls = document.getElementById("confirmControls");

  const useFileInsteadLink = document.getElementById("useFileInsteadLink");
  const fallbackUploadBox = document.getElementById("fallbackUploadBox");
  const backToCameraBtn = document.getElementById("backToCameraBtn");
  const cameraBox = document.getElementById("cameraBox");

  const liveScanLabel = document.getElementById("liveScanLabel");
  const liveScanText = document.getElementById("liveScanText");
  const liveScanConfidence = document.getElementById("liveScanConfidence");

  const scanBoxesLayer = document.getElementById("scanBoxesLayer");

  let currentStream = null;
  let facingMode = "environment"; // rear camera by default, better for scanning objects

  // ===================== OBJECT DETECTOR (localization only) =====================
  let detectorPromise = null;
  let detectorFailed = false;

  function getDetector() {
    if (detectorFailed) return Promise.reject(new Error("detector unavailable"));
    if (!detectorPromise) {
      if (!window.EcoSortDetector) {
        detectorFailed = true;
        return Promise.reject(new Error("detector failed to load"));
      }
      detectorPromise = window.EcoSortDetector.load().catch((err) => {
        detectorFailed = true;
        detectorPromise = null;
        throw err;
      });
    }
    return detectorPromise;
  }

  // ===================== LIVE SCANNING LOOP =====================
  // While the camera is on (before the user taps capture), run detection
  // every ~1.5s: find candidate item regions, classify each one against our
  // waste model, and draw a labeled box per item. This does NOT save
  // anything or navigate away — the user still taps capture to lock in a
  // photo and see full details.
  const LIVE_SCAN_INTERVAL_MS = 1500;
  const MAX_BOXES = 4;
  const DETECTION_SCORE_THRESHOLD = 0.4;
  const LOW_CONFIDENCE_THRESHOLD = 45; // percent, for the waste classifier
  const BOX_PADDING_RATIO = 0.15; // slight margin around each detected region before cropping

  let liveScanTimer = null;
  let liveScanInFlight = false;

  function startLiveScanning() {
    stopLiveScanning();
    consecutiveEmptyTicks = 0;
    liveScanLabel.hidden = false;
    liveScanText.textContent = "Loading detector…";
    liveScanConfidence.textContent = "";
    scanBoxesLayer.hidden = false;
    scanBoxesLayer.innerHTML = "";
    // Sweeping light-beam over the feed for continuous "actively scanning"
    // feedback in between detection boxes appearing (see .scanning-sweep
    // in style.css).
    cameraBox.classList.add("scanning-sweep");

    getDetector()
      .then(() => {
        liveScanText.textContent = "Scanning…";
      })
      .catch(() => {
        liveScanText.textContent = "Detection unavailable — check connection";
      });

    liveScanTimer = setInterval(scanFrame, LIVE_SCAN_INTERVAL_MS);
  }

  function stopLiveScanning() {
    if (liveScanTimer) {
      clearInterval(liveScanTimer);
      liveScanTimer = null;
    }
    liveScanLabel.hidden = true;
    liveScanLabel.classList.remove("hazard-live");
    scanBoxesLayer.hidden = true;
    scanBoxesLayer.innerHTML = "";
    cameraBox.classList.remove("scanning-sweep");
  }

  // Expands a detection box slightly so the crop we classify includes a bit
  // of context around the item's edges, clamped to the video's own bounds.
  //
  // IMPORTANT: this also SQUARES the box before padding. The classifier
  // (classifier.js) always center-crops whatever it receives down to a
  // square before resizing to 224x224. The detector's raw boxes are NOT
  // square — a bottle or can standing upright gets a tall, narrow box.
  // Sending that tall box straight in would let the center-crop slice off
  // the top and bottom of the item (keeping only a middle slab), a real
  // source of live-scan misclassifications. Squaring the box HERE, by
  // expanding the shorter side to match the longer one (not cropping),
  // makes the center-crop a no-op so the full item reaches the model.
  function padBox(x, y, w, h, maxW, maxH) {
    const padW = w * BOX_PADDING_RATIO;
    const padH = h * BOX_PADDING_RATIO;
    let nx = x - padW / 2;
    let ny = y - padH / 2;
    let nw = w + padW;
    let nh = h + padH;

    // Square up around the box's own center, using the larger dimension.
    const cx = nx + nw / 2;
    const cy = ny + nh / 2;
    const side = Math.max(nw, nh);
    nx = cx - side / 2;
    ny = cy - side / 2;
    nw = side;
    nh = side;

    // Clamp to frame bounds without losing the square-ness where possible.
    nx = Math.max(0, Math.min(nx, maxW - Math.min(nw, maxW)));
    ny = Math.max(0, Math.min(ny, maxH - Math.min(nh, maxH)));
    nw = Math.min(nw, maxW - nx);
    nh = Math.min(nh, maxH - ny);

    return [nx, ny, nw, nh];
  }

  // Maps a box in the video's native pixel space to the on-screen position
  // of the <video> element, accounting for object-fit: cover cropping and
  // the horizontal mirror applied to the front camera.
  function mapVideoBoxToDisplay(x, y, w, h) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const dw = video.clientWidth;
    const dh = video.clientHeight;
    if (!vw || !vh || !dw || !dh) return null;

    const scale = Math.max(dw / vw, dh / vh);
    const offsetX = (dw - vw * scale) / 2;
    const offsetY = (dh - vh * scale) / 2;

    let left = x * scale + offsetX;
    const top = y * scale + offsetY;
    const width = w * scale;
    const height = h * scale;

    if (video.classList.contains("mirrored")) {
      left = dw - left - width;
    }

    return { left, top, width, height };
  }

  // The model only looks at 224x224 anyway, so cap the crop at that size
  // before handing it to the classifier — no point copying more pixels.
  const CROP_MAX_DIM = 224;

  function cropToCanvas(x, y, w, h) {
    const outSide = Math.min(CROP_MAX_DIM, Math.max(1, Math.round(Math.max(w, h))));
    const cropCanvas = document.createElement("canvas");
    cropCanvas.width = outSide;
    cropCanvas.height = outSide;
    cropCanvas.getContext("2d").drawImage(video, x, y, w, h, 0, 0, outSide, outSide);
    return cropCanvas;
  }

  // Classifies every candidate crop from one tick in a single batched model
  // run, entirely on-device (the old version POSTed them to a Flask endpoint).
  async function classifyCropsBatch(boxes) {
    const crops = boxes.map(([x, y, w, h]) => cropToCanvas(x, y, w, h));
    try {
      const results = await window.EcoSortClassifier.classifyBatch(crops);
      return results.map((r) => (r ? { ...r, confidence: Math.round(r.confidence * 10) / 10 } : null));
    } catch (err) {
      console.warn("Live classification failed:", err);
      return crops.map(() => null);
    }
  }

  function renderBoxes(items) {
    scanBoxesLayer.innerHTML = "";
    items.forEach((item) => {
      const box = document.createElement("div");
      box.className = "live-scan-box scan-active";
      if (item.rawLabel) box.classList.add(`scan-${item.rawLabel}`);
      box.style.left = `${item.left}px`;
      box.style.top = `${item.top}px`;
      box.style.width = `${item.width}px`;
      box.style.height = `${item.height}px`;

      ["corner-tl", "corner-tr", "corner-bl", "corner-br"].forEach((c) => {
        const span = document.createElement("span");
        span.className = `live-scan-corner ${c}`;
        box.appendChild(span);
      });

      const label = document.createElement("span");
      label.className = "live-scan-box-label";
      label.textContent = item.label;
      box.appendChild(label);

      scanBoxesLayer.appendChild(box);
    });
  }

  // The detector can still miss an item (odd angle, tiny, unusual object).
  // Rather than show "No items detected" and give up, after a couple of
  // consecutive empty ticks fall back to classifying the whole frame as a
  // single box, so the user still gets a read instead of silence.
  //
  // When the bin classifier is unsure about a crop but the detector is
  // confident about the material (e.g. METAL, GLASS, CARDBOARD, PAPER,
  // BIODEGRADABLE), use the detector's material for the bin instead of
  // "Uncertain". PLASTIC is deliberately left out: plastics split between
  // recyclable and non-recyclable, so guessing would be wrong too often.
  const DETECTOR_BIN = {
    BIODEGRADABLE: { raw: "biodegradable", label: "Biodegradable" },
    CARDBOARD: { raw: "recyclable", label: "Recyclable" },
    GLASS: { raw: "recyclable", label: "Recyclable" },
    METAL: { raw: "recyclable", label: "Recyclable" },
    PAPER: { raw: "recyclable", label: "Recyclable" },
  };
  const EMPTY_TICKS_BEFORE_FALLBACK = 2;
  let consecutiveEmptyTicks = 0;

  async function scanFrame() {
    if (liveScanInFlight) return; // skip if the previous tick hasn't finished yet
    if (!video.videoWidth || !video.videoHeight) return;

    let detector;
    try {
      detector = await getDetector();
    } catch {
      return; // status text already reflects "unavailable"
    }

    liveScanInFlight = true;
    try {
      const predictions = await detector.detect(video);
      let dets = predictions
        .filter((p) => p.score >= DETECTION_SCORE_THRESHOLD)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_BOXES);
      let candidateBoxes = dets.map((c) => c.bbox);

      let usingWholeFrameFallback = false;

      if (candidateBoxes.length === 0) {
        consecutiveEmptyTicks++;
        if (consecutiveEmptyTicks < EMPTY_TICKS_BEFORE_FALLBACK) {
          liveScanText.textContent = "No items detected — move item into view";
          liveScanConfidence.textContent = "";
          liveScanLabel.classList.remove("hazard-live");
          renderBoxes([]);
          return;
        }
        // Give the whole-frame fallback its own square-ish box (matching
        // the video's shorter dimension) rather than the full wide/tall
        // frame, for the same reason padBox squares detection boxes.
        const side = Math.min(video.videoWidth, video.videoHeight);
        candidateBoxes = [[
          (video.videoWidth - side) / 2,
          (video.videoHeight - side) / 2,
          side,
          side,
        ]];
        dets = [null];
        usingWholeFrameFallback = true;
      } else {
        consecutiveEmptyTicks = 0;
      }

      const squaredBoxes = candidateBoxes.map(([rx, ry, rw, rh]) =>
        padBox(rx, ry, rw, rh, video.videoWidth, video.videoHeight)
      );
      const displays = squaredBoxes.map(([x, y, w, h]) => mapVideoBoxToDisplay(x, y, w, h));
      const classifications = await classifyCropsBatch(squaredBoxes);

      const items = squaredBoxes
        .map((_, i) => {
          const display = displays[i];
          const classification = classifications[i];
          if (!display || !classification) return null;

          const uncertain = classification.confidence < LOW_CONFIDENCE_THRESHOLD;
          const det = dets[i];
          const material = uncertain && det && det.score >= 0.5 ? DETECTOR_BIN[det.class] : null;
          if (material) {
            return {
              left: display.left,
              top: display.top,
              width: display.width,
              height: display.height,
              rawLabel: material.raw,
              label: `${material.label} · ${Math.round(det.score * 100)}%`,
              isHazard: false,
            };
          }
          return {
            left: display.left,
            top: display.top,
            width: display.width,
            height: display.height,
            rawLabel: uncertain ? null : classification.raw_label,
            label: uncertain
              ? "Uncertain"
              : `${classification.prediction} · ${classification.confidence}%`,
            isHazard: !uncertain && !!classification.is_hazard,
          };
        })
        .filter(Boolean);

      renderBoxes(items);

      const hazardCount = items.filter((i) => i.isHazard).length;
      liveScanLabel.classList.toggle("hazard-live", hazardCount > 0);
      if (usingWholeFrameFallback) {
        liveScanText.textContent = items.length
          ? "Scanning whole frame"
          : "No items detected — move item into view";
      } else {
        liveScanText.textContent = items.length === 1 ? "1 item detected" : `${items.length} items detected`;
      }
      liveScanConfidence.textContent = hazardCount > 0 ? `${hazardCount} hazardous` : "";
    } catch (err) {
      console.warn("Live scan frame failed:", err);
    } finally {
      liveScanInFlight = false;
    }
  }

  function cameraSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  // ===================== OVERLAY STATE (idle / loading / error) =====================
  // The overlay previously only ever showed one look (camera icon + static
  // text), so a permission-denied error and "please wait, requesting your
  // camera" read identically. This gives each state its own icon/tone so
  // it's obvious at a glance what's happening and what, if anything, the
  // person needs to do about it.
  function setOverlayState(state, message) {
    overlay.classList.remove("is-loading", "is-error");
    retryBtn.hidden = true;

    if (state === "loading") {
      overlay.classList.add("is-loading");
      overlayIcon.className = "fa-solid fa-circle-notch fa-spin";
    } else if (state === "error") {
      overlay.classList.add("is-error");
      overlayIcon.className = "fa-solid fa-triangle-exclamation";
      retryBtn.hidden = false;
    } else {
      overlayIcon.className = "fa-solid fa-camera";
    }

    overlayText.textContent = message;
    overlay.hidden = false;
  }

  // Swaps a button into/out of a disabled, spinning "busy" state without
  // losing its original label — restoring it later needs the exact markup
  // back, not just "not disabled" (which would leave the last spinner in
  // place).
  function setButtonBusy(btn, busy, busyLabel) {
    if (!btn) return;
    if (busy) {
      if (btn.dataset.restoreHtml === undefined) btn.dataset.restoreHtml = btn.innerHTML;
      btn.disabled = true;
      btn.classList.add("is-loading");
      btn.innerHTML = `<span class="btn-spinner"></span> ${busyLabel}`;
    } else {
      btn.disabled = false;
      btn.classList.remove("is-loading");
      if (btn.dataset.restoreHtml !== undefined) {
        btn.innerHTML = btn.dataset.restoreHtml;
        delete btn.dataset.restoreHtml;
      }
    }
  }

  async function startCamera(mode) {
    stopCamera();
    setOverlayState("loading", "Starting camera…");
    setButtonBusy(startBtn, true, "Starting…");
    setButtonBusy(switchBtn, true);

    if (!cameraSupported()) {
      showError("Camera not supported on this browser. Please upload a photo instead.");
      setButtonBusy(startBtn, false);
      return;
    }

    try {
      currentStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: mode } },
        audio: false
      });

      video.srcObject = currentStream;
      video.hidden = false;
      video.classList.toggle("mirrored", mode === "user");
      capturedPreview.hidden = true;
      overlay.hidden = true;

      switchBtn.hidden = false;
      stopBtn.hidden = false;
      setButtonBusy(startBtn, false);
      setButtonBusy(switchBtn, false);

      cameraControls.hidden = true;
      captureControls.hidden = false;
      confirmControls.hidden = true;

      startLiveScanning();
    } catch (err) {
      console.error("Camera error:", err);
      setButtonBusy(startBtn, false);
      setButtonBusy(switchBtn, false);
      // Different failure reasons deserve different guidance — a denied
      // permission needs a browser-settings fix, not a retry tap, while a
      // missing camera or a transient grab failure is worth retrying.
      if (err && err.name === "NotAllowedError") {
        showError("Camera permission denied. Allow camera access in your browser settings, or upload a photo instead.");
      } else if (err && err.name === "NotFoundError") {
        showError("No camera found on this device. Please upload a photo instead.");
      } else if (err && err.name === "NotReadableError") {
        showError("Camera is in use by another app. Close it and try again, or upload a photo instead.");
      } else {
        showError("Camera access denied or unavailable. Please upload a photo instead.");
      }
    }
  }

  function stopCamera() {
    stopLiveScanning();
    if (currentStream) {
      currentStream.getTracks().forEach((track) => track.stop());
      currentStream = null;
    }
  }

  // Explicit camera on/off toggle. Previously the only way to stop the
  // camera once it was on was to capture a photo, navigate away, or hide
  // the tab — there was no direct "turn it off" action. This returns the
  // UI to the same idle state as before the camera was ever started.
  function turnOffCamera() {
    stopCamera();
    setOverlayState("idle", "Turn on your camera to scan waste live");
    video.hidden = true;
    switchBtn.hidden = true;
    stopBtn.hidden = true;
    cameraControls.hidden = false;
    captureControls.hidden = true;
    confirmControls.hidden = true;
  }

  function showError(message) {
    setOverlayState("error", message);
    video.hidden = true;
    switchBtn.hidden = true;
    stopBtn.hidden = true;
    cameraControls.hidden = false;
    captureControls.hidden = true;
    fallbackUploadBox.hidden = false;
    stopLiveScanning();
  }

  function capturePhoto() {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return;

    captureBtn.disabled = true;
    // Shutter-flash: brief white flash over the frame confirms the photo
    // was actually taken, same as a physical camera shutter would.
    cameraBox.classList.add("flash");
    cameraBox.addEventListener("animationend", () => cameraBox.classList.remove("flash"), { once: true });

    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(video, 0, 0, w, h);

    canvas.toBlob(
      function (blob) {
        captureBtn.disabled = false;
        if (!blob) return;

        const file = new File([blob], `scan-${Date.now()}.jpg`, { type: "image/jpeg" });
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        imageInput.files = dataTransfer.files;

        capturedPreview.src = URL.createObjectURL(blob);
        capturedPreview.hidden = false;
        video.hidden = true;
        switchBtn.hidden = true;
        stopBtn.hidden = true;

        captureControls.hidden = true;
        confirmControls.hidden = false;

        stopLiveScanning();
        stopCamera();
      },
      "image/jpeg",
      0.92
    );
  }

  function retake() {
    confirmControls.hidden = true;
    capturedPreview.hidden = true;
    startCamera(facingMode);
  }

  startBtn.addEventListener("click", () => {
    startCamera(facingMode);
  });

  switchBtn.addEventListener("click", () => {
    facingMode = facingMode === "environment" ? "user" : "environment";
    startCamera(facingMode);
  });

  captureBtn.addEventListener("click", capturePhoto);
  retakeBtn.addEventListener("click", retake);
  stopBtn.addEventListener("click", turnOffCamera);
  retryBtn.addEventListener("click", () => startCamera(facingMode));

  // The scan form no longer POSTs anywhere: classification runs on-device, which
  // takes a moment (first run also waits for the model download), so show the
  // busy state immediately and restore the buttons when it's done.
  const scanForm = document.getElementById("scanForm");
  const scanSubmitBtn = document.getElementById("scanSubmitBtn");
  const uploadSubmitBtn = document.getElementById("uploadSubmitBtn");
  let scanning = false;
  if (scanForm) {
    scanForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (scanning) return;
      scanning = true;
      setButtonBusy(scanSubmitBtn, true, "Analyzing…");
      setButtonBusy(uploadSubmitBtn, true, "Analyzing…");
      try {
        await window.EcoSortApp.scanFile(imageInput.files[0]);
      } finally {
        setButtonBusy(scanSubmitBtn, false);
        setButtonBusy(uploadSubmitBtn, false);
        scanning = false;
      }
    });
  }

  // Back to a clean "camera off" scanner — used by "Scan again" on the result view.
  window.resetScanUI = function () {
    turnOffCamera();
    imageInput.value = "";
    capturedPreview.hidden = true;
    capturedPreview.removeAttribute("src");
    const previewBoxEl = document.getElementById("previewBox");
    const previewImageEl = document.getElementById("previewImage");
    if (previewBoxEl) previewBoxEl.style.display = "none";
    if (previewImageEl) previewImageEl.src = "";
    fallbackUploadBox.hidden = true;
    cameraBox.hidden = false;
  };

  if (useFileInsteadLink) {
    useFileInsteadLink.addEventListener("click", (e) => {
      e.preventDefault();
      stopCamera();
      cameraBox.hidden = true;
      cameraControls.hidden = true;
      captureControls.hidden = true;
      confirmControls.hidden = true;
      fallbackUploadBox.hidden = false;
    });
  }

  if (backToCameraBtn) {
    backToCameraBtn.addEventListener("click", () => {
      // Clear any file that was picked via the upload flow so it can't
      // accidentally get submitted later after switching back to live
      // capture. previewBox/previewImage live in app.js's scope, not
      // here, so they're looked up fresh rather than shared as variables.
      imageInput.value = "";
      const previewBoxEl = document.getElementById("previewBox");
      const previewImageEl = document.getElementById("previewImage");
      if (previewBoxEl) previewBoxEl.style.display = "none";
      if (previewImageEl) previewImageEl.src = "";

      fallbackUploadBox.hidden = true;
      cameraBox.hidden = false;
      // A click is a real user gesture, so re-requesting the camera here
      // (rather than just showing the idle "Turn on camera" button) is
      // allowed by the browser and gets the person straight back into live
      // scanning, matching "back to camera" rather than "back to idle".
      startCamera(facingMode);
    });
  }

  window.addEventListener("beforeunload", stopCamera);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopCamera();
  });
})();
