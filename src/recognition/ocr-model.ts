/**
 * The on-device English OCR runtime and model (`tesseract.js` v7.0.0 worker,
 * SIMD LSTM WebAssembly core, and `tessdata_best` 4.0.0_best_int English
 * weights) downloaded on first use into `<plugin>/ocr/` via `ModelRegistry`.
 *
 * Kept outside `main.js` (~7.0 MB total) so `main.js` stays comfortably below
 * Obsidian Sync's 5 MB file limit. Every file is verified by byte count and
 * SHA-256 before use, whether downloaded or synced across devices.
 *
 * PURE: data only, no DOM, no Obsidian.
 */

import type { ModelAsset, ModelFile } from "../downloads/model-manifest";

export const OCR_MODEL_ID = "tesseract-eng";

export const OCR_TRAINEDDATA_FILE: ModelFile = {
  name: "eng.traineddata.gz",
  url: "https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int/eng.traineddata.gz",
  bytes: 2_952_873,
  sha256: "45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91",
};

export const OCR_CORE_FILE: ModelFile = {
  name: "tesseract-core-simd-lstm.wasm.js",
  url: "https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0/tesseract-core-simd-lstm.wasm.js",
  bytes: 3_899_472,
  sha256: "c58b46a4c796c0b8afccf77591d5b875b6896b45d402bbce8caa6f5362447b38",
};

export const OCR_WORKER_FILE: ModelFile = {
  name: "worker.min.js",
  url: "https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/worker.min.js",
  bytes: 111_307,
  sha256: "576b7df7e3393e137e51849357c9adb53fe7ac1bb69bfa06cf3d61520f182c6d",
};

export const OCR_MODEL: ModelAsset = {
  id: OCR_MODEL_ID,
  label: "Tesseract English (PDF text recognizer)",
  purpose:
    "Reads scanned and vector-outlined PDF pages on this device so the highlighter can snap to and copy their text.",
  version: "1.0",
  format: 1,
  folder: "ocr",
  files: [OCR_TRAINEDDATA_FILE, OCR_CORE_FILE, OCR_WORKER_FILE],
  // Request each asset in one <=4 MB slice so CDN edges serve exact uncompressed bytes.
  chunkBytes: 4 * 1024 * 1024,
};
