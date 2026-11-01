/**
 * Main-thread client for on-device PDF OCR (`tesseract.js`).
 *
 * Starts a self-contained Web Worker from the verified files in `<plugin>/ocr/`
 * (`OCR_MODEL`), with `TesseractCore` pre-defined in the worker Blob and a
 * local `fetch` shim serving `eng.traineddata.gz` from memory so the worker
 * makes zero external network or IndexedDB requests.
 *
 * Like `SpeechClient`, an idle worker is terminated after `IDLE_RELEASE_MS` so
 * its WebAssembly heap (~120 MB) is returned when no PDF pages are being read.
 */

import Tesseract, { type Block, type Worker } from "tesseract.js";
import type { OcrBlock, OcrLine, OcrWord } from "../canvas/pdf-ocr";
import type { AssetStore } from "../downloads/model-store";
import { OCR_CORE_FILE, OCR_TRAINEDDATA_FILE, OCR_WORKER_FILE } from "../recognition/ocr-model";

export const OCR_IDLE_RELEASE_MS = 2 * 60_000;
const OFFLINE_LANG_ORIGIN = "https://finenotes-ocr.invalid";
const OFFLINE_TRAINEDDATA_URL = `${OFFLINE_LANG_ORIGIN}/eng.traineddata.gz`;

export type CreateTesseractWorker = typeof Tesseract.createWorker;

export function toOcrBlocks(blocks: readonly Block[] | null | undefined): OcrBlock[] {
  if (!blocks) return [];
  const out: OcrBlock[] = [];
  for (const block of blocks) {
    const lines: OcrLine[] = [];
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        const words: OcrWord[] = [];
        for (const word of line.words ?? []) {
          words.push({
            text: word.text,
            bbox: {
              x0: word.bbox.x0,
              y0: word.bbox.y0,
              x1: word.bbox.x1,
              y1: word.bbox.y1,
            },
            confidence: word.confidence,
          });
        }
        if (words.length > 0) {
          lines.push({
            bbox: {
              x0: line.bbox.x0,
              y0: line.bbox.y0,
              x1: line.bbox.x1,
              y1: line.bbox.y1,
            },
            words,
          });
        }
      }
    }
    if (lines.length > 0) {
      out.push({
        bbox: {
          x0: block.bbox.x0,
          y0: block.bbox.y0,
          x1: block.bbox.x1,
          y1: block.bbox.y1,
        },
        lines,
      });
    }
  }
  return out;
}

function buildWorkerShim(langBlobUrl: string): string {
  return [
    "(() => {",
    "  const origFetch = self.fetch.bind(self);",
    `  const targetUrl = ${JSON.stringify(OFFLINE_TRAINEDDATA_URL)};`,
    `  const blobUrl = ${JSON.stringify(langBlobUrl)};`,
    "  self.fetch = (input) => {",
    '    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;',
    "    if (url === targetUrl) return origFetch(blobUrl);",
    '    return Promise.reject(new Error("FineNotes OCR worker blocked network fetch: " + url));',
    "  };",
    "})();",
  ].join("\n");
}

export class PdfOcrClient {
  private workerPromise: Promise<Worker> | null = null;
  private workerInstance: Worker | null = null;
  private queue: Promise<void> = Promise.resolve();
  private activeJobs = 0;
  private idleTimer = 0;
  private disposed = false;

  constructor(
    private readonly store: () => AssetStore,
    private readonly createWorkerFn: CreateTesseractWorker = Tesseract.createWorker,
    private readonly idleReleaseMs = OCR_IDLE_RELEASE_MS,
  ) {}

  /** Recognize structured text blocks in a PNG-encoded PDF page image. */
  recognize(pngBytes: Uint8Array): Promise<OcrBlock[]> {
    if (this.disposed) return Promise.resolve([]);
    this.clearIdleTimer();
    this.activeJobs++;
    const run = this.queue.then(
      () => this.recognizeOnce(pngBytes),
      () => this.recognizeOnce(pngBytes),
    );
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run.finally(() => {
      this.activeJobs = Math.max(0, this.activeJobs - 1);
      if (this.activeJobs === 0 && !this.disposed) this.armIdleTimer();
    });
  }

  dispose(): void {
    this.disposed = true;
    this.stopWorker();
  }

  private async recognizeOnce(pngBytes: Uint8Array): Promise<OcrBlock[]> {
    if (this.disposed) return [];
    const worker = await this.ensureWorker();
    if (this.disposed) return [];
    const copy = new Uint8Array(pngBytes.byteLength);
    copy.set(pngBytes);
    const imageBlob = new Blob([copy], { type: "image/png" });
    try {
      const result = await worker.recognize(imageBlob, {}, { text: true, blocks: true });
      return toOcrBlocks(result.data.blocks);
    } catch (error) {
      this.stopWorker();
      throw error;
    }
  }

  private ensureWorker(): Promise<Worker> {
    if (this.workerPromise) return this.workerPromise;
    const starting = this.startWorker()
      .then((worker) => {
        if (this.disposed) {
          void worker.terminate().catch(() => undefined);
          throw new Error("OCR client disposed");
        }
        this.workerInstance = worker;
        return worker;
      })
      .catch((error: unknown) => {
        if (this.workerPromise === starting) this.workerPromise = null;
        throw error;
      });
    this.workerPromise = starting;
    return starting;
  }

  private async startWorker(): Promise<Worker> {
    const assetStore = this.store();
    const [trainedData, coreBuf, workerBuf] = await Promise.all([
      assetStore.bytes(OCR_TRAINEDDATA_FILE.name),
      assetStore.bytes(OCR_CORE_FILE.name),
      assetStore.bytes(OCR_WORKER_FILE.name),
    ]);
    if (!trainedData || !coreBuf || !workerBuf) {
      throw new Error("OCR model files are not downloaded yet");
    }

    const decoder = new TextDecoder();
    const coreJs = decoder.decode(coreBuf);
    const workerJs = decoder.decode(workerBuf);

    const langBlobUrl = URL.createObjectURL(new Blob([trainedData], { type: "application/gzip" }));
    const workerBlobUrl = URL.createObjectURL(
      new Blob([coreJs, "\n;\n", buildWorkerShim(langBlobUrl), "\n;\n", workerJs], {
        type: "text/javascript",
      }),
    );

    try {
      let rejectError!: (reason: Error) => void;
      const onWorkerError = new Promise<never>((_resolve, reject) => {
        rejectError = reject;
      });
      const created = this.createWorkerFn("eng", Tesseract.OEM.LSTM_ONLY, {
        workerPath: workerBlobUrl,
        workerBlobURL: false,
        langPath: OFFLINE_LANG_ORIGIN,
        cacheMethod: "none",
        gzip: true,
        errorHandler: (err: unknown) => {
          rejectError(err instanceof Error ? err : new Error(String(err)));
        },
      });
      return await Promise.race([created, onWorkerError]);
    } finally {
      URL.revokeObjectURL(workerBlobUrl);
      URL.revokeObjectURL(langBlobUrl);
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer && typeof window !== "undefined") {
      window.clearTimeout(this.idleTimer);
    }
    this.idleTimer = 0;
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (typeof window === "undefined" || this.idleReleaseMs <= 0) return;
    this.idleTimer = window.setTimeout(() => {
      this.idleTimer = 0;
      if (this.activeJobs === 0) this.stopWorker();
    }, this.idleReleaseMs);
  }

  private stopWorker(): void {
    this.clearIdleTimer();
    const instance = this.workerInstance;
    const pending = this.workerPromise;
    this.workerInstance = null;
    this.workerPromise = null;
    if (instance) {
      void instance.terminate().catch(() => undefined);
    } else if (pending) {
      void pending.then((w) => w.terminate()).catch(() => undefined);
    }
  }
}
