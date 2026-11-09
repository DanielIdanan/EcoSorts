// ===================== ON-DEVICE WASTE CLASSIFIER =====================
// Replaces the Flask /api/live-scan(-batch) endpoints and app.py's
// classify_image(): the trained MobileNetV2 model (model/waste_model.onnx,
// converted from waste_model.keras with BatchNorm folded in) runs entirely in
// the browser through onnxruntime-web (WebAssembly). No server, no API keys.
//
// The model takes raw 0-255 RGB pixels (NHWC, 224x224) — the "/127.5 - 1"
// MobileNetV2 preprocessing is baked into the graph, same as the Keras model.
// Pre-/post-processing below mirrors app.py exactly:
//   center-crop to a square -> resize 224x224 -> predict -> hazard safety bias.

(function () {
  const CLASS_NAMES = ["biodegradable", "hazardous", "non_recyclable", "recyclable"];

  const LABEL_MAP = {
    biodegradable:  ["Biodegradable",  "Place this item in the biodegradable waste bin."],
    recyclable:     ["Recyclable",     "Place this item in the recyclable waste bin."],
    non_recyclable: ["Non-recyclable", "Place this item in the non-recyclable waste bin."],
    hazardous:      ["Hazardous",      "Do NOT place this item in a regular bin. Take it to a " +
                                       "hazardous waste drop-off point or your local barangay/LGU " +
                                       "collection center."],
  };

  // A missed hazardous item is worse than a false alarm, so bias toward
  // "hazardous" whenever its probability clears this bar (same value as app.py).
  const HAZARD_SAFETY_THRESHOLD = 0.35;

  const MODEL_URL = "model/waste_model.onnx";
  const SIZE = 224;

  // ---------- model loading ----------
  let sessionPromise = null;

  function loadSession() {
    if (!sessionPromise) {
      sessionPromise = (async () => {
        if (typeof ort === "undefined") throw new Error("onnxruntime-web failed to load (check your connection)");
        // Multi-threaded WASM needs special HTTP headers that GitHub Pages can't send,
        // so stay single-threaded — MobileNetV2 is small enough that this is fine.
        ort.env.wasm.numThreads = 1;
        return ort.InferenceSession.create(MODEL_URL, {
          executionProviders: ["wasm"],
          graphOptimizationLevel: "all",
        });
      })();
      // Let a later call retry if loading failed (e.g. flaky network).
      sessionPromise.catch(() => { sessionPromise = null; });
    }
    return sessionPromise;
  }

  // Start fetching the ~9.5MB model as soon as the page has loaded, so it's
  // usually ready by the time someone taps "Start Scanning".
  window.addEventListener("load", () => { loadSession().catch((e) => console.warn("Model preload failed:", e)); });

  // ---------- preprocessing ----------
  const work = document.createElement("canvas");
  work.width = SIZE;
  work.height = SIZE;
  const wctx = work.getContext("2d", { willReadFrequently: true });

  function sourceSize(src) {
    return [src.videoWidth || src.naturalWidth || src.width, src.videoHeight || src.naturalHeight || src.height];
  }

  // Center-crop to a square, resize to 224x224, write RGB floats (0-255) into out[offset...].
  function writePixels(src, out, offset) {
    const [sw, sh] = sourceSize(src);
    const side = Math.min(sw, sh);
    const sx = (sw - side) / 2;
    const sy = (sh - side) / 2;
    wctx.clearRect(0, 0, SIZE, SIZE);
    wctx.imageSmoothingEnabled = true;
    wctx.imageSmoothingQuality = "high";
    wctx.drawImage(src, sx, sy, side, side, 0, 0, SIZE, SIZE);
    const px = wctx.getImageData(0, 0, SIZE, SIZE).data; // RGBA bytes
    let j = offset;
    for (let i = 0; i < px.length; i += 4) {
      out[j++] = px[i];
      out[j++] = px[i + 1];
      out[j++] = px[i + 2];
    }
  }

  // ---------- postprocessing (port of classify_image's decision logic) ----------
  function interpret(p) {
    let idx = 0;
    for (let i = 1; i < p.length; i++) if (p[i] > p[idx]) idx = i;

    let rawLabel = CLASS_NAMES[idx];
    let confidence = p[idx] * 100;
    const hazardProb = p[CLASS_NAMES.indexOf("hazardous")];

    if (rawLabel !== "hazardous" && hazardProb >= HAZARD_SAFETY_THRESHOLD) {
      rawLabel = "hazardous";
      confidence = hazardProb * 100;
    }

    const [prediction, tip] = LABEL_MAP[rawLabel];
    const probs = {};
    CLASS_NAMES.forEach((name, i) => { probs[name] = Math.round(p[i] * 10000) / 100; });

    return {
      raw_label: rawLabel,
      prediction,
      confidence,
      tip,
      is_hazard: rawLabel === "hazardous",
      probs,
    };
  }

  // ---------- inference (serialized: one session.run at a time) ----------
  let queue = Promise.resolve();

  function classifyBatch(sources) {
    const job = queue.then(async () => {
      if (!sources.length) return [];
      const session = await loadSession();
      const n = sources.length;
      const data = new Float32Array(n * SIZE * SIZE * 3);
      sources.forEach((src, i) => writePixels(src, data, i * SIZE * SIZE * 3));
      const outputs = await session.run({ input: new ort.Tensor("float32", data, [n, SIZE, SIZE, 3]) });
      const probs = outputs.probs.data; // Float32Array, n * 4
      return sources.map((_, i) => interpret(probs.subarray(i * CLASS_NAMES.length, (i + 1) * CLASS_NAMES.length)));
    });
    queue = job.catch(() => {}); // a failed run must not block the next one
    return job;
  }

  window.EcoSortClassifier = {
    CLASS_NAMES,
    ready: loadSession,
    classifyBatch,
    classify: (src) => classifyBatch([src]).then((r) => r[0]),
  };
})();
