// ===================== ON-DEVICE ITEM DETECTOR (YOLOv8n) =====================
// Finds WHERE waste items are in the live camera frame. This is the trained
// waste-sort-yolo model (model/waste_yolo.onnx, converted from best.pt) and it
// replaces the generic COCO-SSD detector, which didn't know about trash.
//
// The model only localizes (its own 6 material labels are kept for reference):
// every box it finds is cropped and handed to the EcoSort bin classifier
// (classifier.js), which decides biodegradable / hazardous / recyclable /
// non-recyclable.
//
// Network output = three raw head maps (strides 8/16/32): per cell 64 DFL box
// logits (4 sides x 16 bins) + 6 class logits. Decoding + NMS happen below.

(function () {
  const MODEL_URL = "model/waste_yolo.onnx";
  const NAMES = ["BIODEGRADABLE", "CARDBOARD", "GLASS", "METAL", "PAPER", "PLASTIC"];
  const NC = NAMES.length;
  const REG_MAX = 16;

  // Trained at 640. The net is fully convolutional, so a smaller input is much
  // faster in WebAssembly at a small recall cost for tiny items. Raise to 640
  // for accuracy on desktops, lower (320) for slow phones.
  const INPUT_SIZE = 416;
  const CONF_THRESHOLD = 0.25;
  const IOU_THRESHOLD = 0.5;
  const MAX_DETECTIONS = 20;

  let sessionPromise = null;
  function load() {
    if (!sessionPromise) {
      sessionPromise = (async () => {
        if (typeof ort === "undefined") throw new Error("onnxruntime-web failed to load");
        ort.env.wasm.numThreads = 1;
        const session = await ort.InferenceSession.create(MODEL_URL, {
          executionProviders: ["wasm"],
          graphOptimizationLevel: "all",
        });
        return { detect: (src) => detect(session, src) };
      })();
      sessionPromise.catch(() => { sessionPromise = null; });
    }
    return sessionPromise;
  }

  const work = document.createElement("canvas");
  work.width = work.height = INPUT_SIZE;
  const wctx = work.getContext("2d", { willReadFrequently: true });

  const sigmoid = (v) => 1 / (1 + Math.exp(-v));

  function iou(a, b) {
    const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
    const x2 = Math.min(a[2], b[2]), y2 = Math.min(a[3], b[3]);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const areaA = (a[2] - a[0]) * (a[3] - a[1]), areaB = (b[2] - b[0]) * (b[3] - b[1]);
    return inter / (areaA + areaB - inter + 1e-9);
  }

  async function detect(session, src) {
    const sw = src.videoWidth || src.naturalWidth || src.width;
    const sh = src.videoHeight || src.naturalHeight || src.height;
    if (!sw || !sh) return [];

    // Letterbox: keep aspect ratio, pad with the same grey (114) Ultralytics uses.
    const ratio = Math.min(INPUT_SIZE / sw, INPUT_SIZE / sh);
    const nw = Math.round(sw * ratio), nh = Math.round(sh * ratio);
    const padX = Math.floor((INPUT_SIZE - nw) / 2), padY = Math.floor((INPUT_SIZE - nh) / 2);
    wctx.fillStyle = "rgb(114,114,114)";
    wctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
    wctx.imageSmoothingEnabled = true;
    wctx.imageSmoothingQuality = "medium";
    wctx.drawImage(src, 0, 0, sw, sh, padX, padY, nw, nh);

    const px = wctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data;
    const plane = INPUT_SIZE * INPUT_SIZE;
    const input = new Float32Array(3 * plane);
    for (let i = 0, p = 0; i < plane; i++, p += 4) {
      input[i] = px[p] / 255;
      input[plane + i] = px[p + 1] / 255;
      input[2 * plane + i] = px[p + 2] / 255;
    }

    const out = await session.run({ images: new ort.Tensor("float32", input, [1, 3, INPUT_SIZE, INPUT_SIZE]) });

    const cand = [];
    for (const name of ["p3", "p4", "p5"]) {
      const t = out[name];
      const H = t.dims[2], W = t.dims[3], d = t.data, hw = H * W;
      const stride = INPUT_SIZE / H;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const cell = y * W + x;
          let best = -1, bestLogit = -Infinity;
          for (let c = 0; c < NC; c++) {
            const l = d[(4 * REG_MAX + c) * hw + cell];
            if (l > bestLogit) { bestLogit = l; best = c; }
          }
          const score = sigmoid(bestLogit);
          if (score < CONF_THRESHOLD) continue;

          // DFL: each side's distance is the expected value of a softmax over 16 bins.
          const dist = [0, 0, 0, 0];
          for (let s = 0; s < 4; s++) {
            let max = -Infinity;
            for (let k = 0; k < REG_MAX; k++) max = Math.max(max, d[(s * REG_MAX + k) * hw + cell]);
            let sum = 0, acc = 0;
            for (let k = 0; k < REG_MAX; k++) {
              const e = Math.exp(d[(s * REG_MAX + k) * hw + cell] - max);
              sum += e; acc += e * k;
            }
            dist[s] = acc / sum;
          }
          const cx = x + 0.5, cy = y + 0.5;
          cand.push({
            box: [(cx - dist[0]) * stride, (cy - dist[1]) * stride, (cx + dist[2]) * stride, (cy + dist[3]) * stride],
            score, cls: best,
          });
        }
      }
    }

    // Class-agnostic NMS: one box per physical item.
    cand.sort((a, b) => b.score - a.score);
    const kept = [];
    for (const c of cand) {
      if (kept.length >= MAX_DETECTIONS) break;
      if (kept.every((k) => iou(k.box, c.box) <= IOU_THRESHOLD)) kept.push(c);
    }

    // Back to source-frame pixels; same shape the old COCO-SSD detector returned.
    return kept.map((k) => {
      const x1 = Math.max(0, Math.min(sw, (k.box[0] - padX) / ratio));
      const y1 = Math.max(0, Math.min(sh, (k.box[1] - padY) / ratio));
      const x2 = Math.max(0, Math.min(sw, (k.box[2] - padX) / ratio));
      const y2 = Math.max(0, Math.min(sh, (k.box[3] - padY) / ratio));
      return { bbox: [x1, y1, x2 - x1, y2 - y1], score: k.score, class: NAMES[k.cls] };
    }).filter((p) => p.bbox[2] > 2 && p.bbox[3] > 2);
  }

  window.EcoSortDetector = { load, NAMES };
})();
