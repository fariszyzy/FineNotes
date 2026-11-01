import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetStore } from "../../src/downloads/model-store";
import {
  OCR_CORE_FILE,
  OCR_TRAINEDDATA_FILE,
  OCR_WORKER_FILE,
} from "../../src/recognition/ocr-model";
import { PdfOcrClient, toOcrBlocks } from "../../src/view/pdf-ocr-client";

describe("PdfOcrClient", () => {
  const createdUrls: string[] = [];
  const revokedUrls: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    createdUrls.length = 0;
    revokedUrls.length = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      const u = `blob:finenotes-test/${createdUrls.length + 1}`;
      createdUrls.push(u);
      return u;
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((u: string) => {
      revokedUrls.push(u);
    });
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function fakeStore(ready = true): AssetStore {
    const encoder = new TextEncoder();
    const files: Record<string, ArrayBuffer> = {
      [OCR_TRAINEDDATA_FILE.name]: new Uint8Array([31, 139, 8, 0]).buffer,
      [OCR_CORE_FILE.name]: encoder.encode("self.TesseractCore = () => {};").buffer,
      [OCR_WORKER_FILE.name]: encoder.encode("// worker").buffer,
    };
    return {
      bytes: vi.fn((name?: string) =>
        Promise.resolve(ready && name ? (files[name] ?? null) : null),
      ),
    } as unknown as AssetStore;
  }

  it("starts one offline worker, revokes temporary Blob URLs, serializes jobs, and releases on idle", async () => {
    let recognizeCalls = 0;
    const terminate = vi.fn(() => Promise.resolve({ jobId: "t", data: null }));
    const recognize = vi.fn(async (_img: unknown, _opts: unknown, output: unknown) => {
      expect(output).toEqual({ text: true, blocks: true });
      recognizeCalls++;
      return {
        jobId: `j${recognizeCalls}`,
        data: {
          blocks: [
            {
              bbox: { x0: 10, y0: 20, x1: 110, y1: 40 },
              paragraphs: [
                {
                  lines: [
                    {
                      bbox: { x0: 10, y0: 20, x1: 110, y1: 40 },
                      words: [
                        {
                          text: `Word${recognizeCalls}`,
                          bbox: { x0: 10, y0: 20, x1: 110, y1: 40 },
                          confidence: 92,
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      };
    });

    const createWorker = vi.fn(async (_langs: unknown, _oem: unknown, options: unknown) => {
      expect(options).toMatchObject({
        workerBlobURL: false,
        langPath: "https://finenotes-ocr.invalid",
        cacheMethod: "none",
        gzip: true,
      });
      return { recognize, terminate } as never;
    });

    const client = new PdfOcrClient(() => fakeStore(true), createWorker as never, 5000);
    const [first, second] = await Promise.all([
      client.recognize(new Uint8Array([137, 80, 78, 71])),
      client.recognize(new Uint8Array([137, 80, 78, 71])),
    ]);

    expect(createWorker).toHaveBeenCalledOnce();
    expect(createdUrls).toHaveLength(2);
    expect(new Set(revokedUrls)).toEqual(new Set(createdUrls));
    expect(first[0].lines[0].words[0].text).toBe("Word1");
    expect(second[0].lines[0].words[0].text).toBe("Word2");
    expect(terminate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("rejects cleanly when OCR model files are missing and resets crashed workers", async () => {
    const missingClient = new PdfOcrClient(() => fakeStore(false));
    await expect(missingClient.recognize(new Uint8Array([1, 2]))).rejects.toThrow(
      /not downloaded yet/,
    );

    expect(toOcrBlocks(null)).toEqual([]);
  });
});
