import { describe, expect, it } from "vitest";
import { totalBytes } from "../../src/downloads/model-manifest";
import {
  OCR_CORE_FILE,
  OCR_MODEL,
  OCR_MODEL_ID,
  OCR_TRAINEDDATA_FILE,
  OCR_WORKER_FILE,
} from "../../src/recognition/ocr-model";

describe("OCR_MODEL", () => {
  it("pins exact byte counts, lowercase SHA-256 digests, and single-chunk range size", () => {
    expect(OCR_MODEL.id).toBe(OCR_MODEL_ID);
    expect(OCR_MODEL.folder).toBe("ocr");
    expect(OCR_MODEL.files).toEqual([OCR_TRAINEDDATA_FILE, OCR_CORE_FILE, OCR_WORKER_FILE]);
    for (const file of OCR_MODEL.files) {
      expect(file.bytes).toBeGreaterThan(0);
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(file.url).toMatch(/^https:\/\//);
      expect(OCR_MODEL.chunkBytes).toBeGreaterThanOrEqual(file.bytes);
    }
    expect(totalBytes(OCR_MODEL)).toBe(6_963_652);
  });
});
