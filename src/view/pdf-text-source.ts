/**
 * The text of PDF backdrop pages, read with pdf.js `getTextContent` (plus
 * on-device Tesseract OCR for scanned or vector-outlined pages) and kept per
 * page, for the highlighter that snaps to text and for Copy text.
 *
 * Like the raster cache (`pdf-backdrop.ts`) it is two-phase so that it never
 * stalls the pen: {@link PdfTextCache.peek} is a synchronous lookup, and when
 * it misses the caller goes on freehand and calls {@link PdfTextCache.request},
 * which reads in the background and fires {@link PdfTextCache.onReady}. While
 * held (the pen is writing, `write-hold.ts`) nothing is read; what was asked
 * for meanwhile is read once the pen has been up a moment.
 *
 * Native `getTextContent` items and PDF links land first without waiting on
 * OCR. When `needsPageOcr` sees a scanned or vector-outlined page (or the user
 * asks explicitly via {@link PdfTextCache.requestOcr}), the page is rendered
 * offscreen to PNG, recognized in `PdfOcrClient`'s worker, deduplicated against
 * native items, and stored over the page's text layout.
 */

import { type App, type TFile, loadPdfJs } from "obsidian";
import { type PdfAssets, pdfAssets } from "./pdf-worker";
import {
  type OcrBlock,
  type OperatorListLike,
  type PdfOpsLike,
  countNativeChars,
  countPageDrawOps,
  needsPageOcr,
  ocrBlocksToItems,
  ocrRenderPlan,
} from "../canvas/pdf-ocr";
import {
  type Matrix,
  type PdfTextItem,
  type TextLayout,
  layoutText,
  pdfToPage,
} from "../canvas/pdf-text";
import {
  type LinkAnnotationLike,
  type PageLink,
  type PdfLink,
  linksOnPage,
  readLinks,
} from "../canvas/pdf-links";
import type { PageGeometry, PdfBackdrop } from "../model/document";

// The slice of pdf.js used here (`loadPdfJs()` is typed `Promise<any>`).
interface TextContentLike {
  items: ReadonlyArray<{
    str?: unknown;
    transform?: unknown;
    width?: unknown;
    height?: unknown;
    fontName?: unknown;
  }>;
  styles?: Record<string, { ascent?: unknown; descent?: unknown; vertical?: unknown } | undefined>;
}

interface PdfViewportLike {
  width: number;
  height: number;
  transform: number[];
}

export interface PdfOcrPageLike {
  getViewport(params: { scale: number }): PdfViewportLike;
  render?: (params: {
    canvasContext: CanvasRenderingContext2D;
    viewport: PdfViewportLike;
    annotationMode?: number;
  }) => { promise: Promise<void> };
}

interface PdfPageLike extends PdfOcrPageLike {
  getTextContent(): Promise<TextContentLike>;
  getOperatorList?: () => Promise<OperatorListLike>;
  getAnnotations?: () => Promise<LinkAnnotationLike[]>;
  cleanup?: () => void;
}

interface PdfDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
  getDestination?: (name: string) => Promise<unknown>;
  getPageIndex?: (ref: unknown) => Promise<number>;
  destroy(): Promise<void>;
}

interface PdfJsLike {
  OPS?: PdfOpsLike;
  getDocument(src: { data: Uint8Array } & PdfAssets): { promise: Promise<PdfDocumentLike> };
}

export type PdfOcrStatus = "ready" | "offered" | "empty" | "unavailable";

export interface PdfTextOcrDeps {
  isModelReady(): Promise<boolean>;
  offerModel(how: "auto" | "ask"): void;
  onModelChange?(listener: () => void): () => void;
  recognize(pngBytes: Uint8Array): Promise<OcrBlock[]>;
  renderPagePng?: (
    page: PdfOcrPageLike,
    plan: { scale: number; width: number; height: number },
  ) => Promise<Uint8Array | null>;
}

/** A page's text as pdf.js (and optional OCR) gave it, before layout on a page size. */
interface PageText {
  items: PdfTextItem[];
  nativeItems: PdfTextItem[];
  /** Its links (a planner's tabs, web addresses), in PDF space. */
  links: PdfLink[];
  viewport: Matrix;
  source: { width: number; height: number };
}

interface ReadResult {
  text: PageText;
  needsOcr: boolean;
  valid: boolean;
}

interface DeferredOcr {
  backdrop: PdfBackdrop;
  how: "auto" | "ask";
  resolve: (status: PdfOcrStatus) => void;
}

/** Pages whose text is kept. A lecture deck is a few dozen; text is small. */
const MAX_PAGES = 200;

const EMPTY: PageText = {
  items: [],
  nativeItems: [],
  links: [],
  viewport: [1, 0, 0, 1, 0, 0],
  source: { width: 1, height: 1 },
};

/** pdf.js's text items as {@link PdfTextItem}s, with their fonts' metrics. */
export function readTextItems(content: TextContentLike): PdfTextItem[] {
  const items: PdfTextItem[] = [];
  for (const raw of content.items) {
    const { str, transform, width, height } = raw;
    if (typeof str !== "string" || !Array.isArray(transform)) continue;
    if (typeof width !== "number" || typeof height !== "number") continue;
    const item: PdfTextItem = {
      str,
      transform: transform.map((n) => (typeof n === "number" ? n : Number.NaN)),
      width,
      height,
    };
    const style = typeof raw.fontName === "string" ? content.styles?.[raw.fontName] : undefined;
    if (typeof style?.ascent === "number") item.ascent = style.ascent;
    if (typeof style?.descent === "number") item.descent = style.descent;
    if (style?.vertical === true) item.vertical = true;
    items.push(item);
  }
  return items;
}

function pageKey(path: string, page: number): string {
  return `${path}:${page}`;
}

async function renderPdfPageToPng(
  page: PdfOcrPageLike,
  plan: { scale: number; width: number; height: number },
): Promise<Uint8Array | null> {
  if (!page.render || typeof createEl !== "function") return null;
  const canvas = createEl("canvas");
  canvas.width = plan.width;
  canvas.height = plan.height;
  try {
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, plan.width, plan.height);
    const viewport = page.getViewport({ scale: plan.scale });
    await page.render({ canvasContext: ctx, viewport, annotationMode: 0 }).promise;
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) return null;
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    canvas.width = canvas.height = 0;
  }
}

export class PdfTextCache {
  /** A page's text was read (or updated by OCR): whatever waits on it can look again. */
  onReady: ((path: string, page: number) => void) | null = null;

  private readonly pages = new Map<string, PageText>();
  /** Laid-out pages, by page and the geometry they were laid out on. */
  private readonly layouts = new Map<string, TextLayout>();
  private readonly inflight = new Set<string>();
  private readonly deferred = new Map<string, PdfBackdrop>();
  private readonly documents = new Map<string, Promise<PdfDocumentLike | null>>();
  private readonly ocrDone = new Set<string>();
  private readonly ocrInflight = new Map<string, Promise<PdfOcrStatus>>();
  private readonly ocrDeferred = new Map<string, DeferredOcr[]>();
  private readonly waitingForModel = new Map<string, PdfBackdrop>();
  private readonly pathEpoch = new Map<string, number>();
  private readonly unsubscribeModel: (() => void) | null;
  /** One page is read natively at a time, behind this. */
  private queue: Promise<void> = Promise.resolve();
  /** One page is rasterised and OCR'd at a time, behind this. */
  private ocrQueue: Promise<void> = Promise.resolve();
  private held = false;
  private lib: Promise<PdfJsLike> | null = null;
  private destroyed = false;

  constructor(
    private readonly app: App,
    private readonly ocr?: PdfTextOcrDeps,
  ) {
    this.unsubscribeModel =
      ocr?.onModelChange?.(() => {
        void this.flushModelWaiters();
      }) ?? null;
  }

  /**
   * The page's text laid out on a page of `geometry`, or null when it has
   * not been read yet. Never waits; an empty layout means it has no text.
   */
  peek(backdrop: PdfBackdrop, geometry: PageGeometry): TextLayout | null {
    const key = pageKey(backdrop.path, backdrop.page);
    const text = this.pages.get(key);
    if (!text) return null;
    const layoutKey = `${key}:${geometry.width}x${geometry.height}`;
    let layout = this.layouts.get(layoutKey);
    if (!layout) {
      layout = layoutText(text.items, pdfToPage(text.viewport, text.source, geometry));
      this.layouts.set(layoutKey, layout);
    }
    return layout;
  }

  /**
   * The page's links placed on a page of `geometry`, or null when the page
   * is not read yet (ask with {@link request}). Never waits.
   */
  peekLinks(backdrop: PdfBackdrop, geometry: PageGeometry): PageLink[] | null {
    const text = this.pages.get(pageKey(backdrop.path, backdrop.page));
    if (!text) return null;
    return text.links.length === 0
      ? []
      : linksOnPage(text.links, text.viewport, text.source, geometry);
  }

  /** Read the page's text in the background, unless it is read or being read. */
  request(backdrop: PdfBackdrop): void {
    if (this.destroyed) return;
    const key = pageKey(backdrop.path, backdrop.page);
    if (this.pages.has(key) || this.inflight.has(key)) return;
    if (this.held) {
      this.deferred.set(key, backdrop);
      return;
    }
    const epoch = this.epochOf(backdrop.path);
    this.inflight.add(key);
    this.queue = this.queue.then(async () => {
      const result = await this.read(backdrop).catch((): ReadResult => ({
        text: EMPTY,
        needsOcr: false,
        valid: false,
      }));
      this.inflight.delete(key);
      if (this.destroyed || this.epochOf(backdrop.path) !== epoch) return;
      this.store(key, result.text);
      this.onReady?.(backdrop.path, backdrop.page);
      if (result.valid && result.needsOcr && this.ocr) {
        void this.requestOcr(backdrop, "auto");
      }
    });
  }

  /** Force or schedule on-device OCR for `backdrop` ("ask" always shows the download offer). */
  async requestOcr(backdrop: PdfBackdrop, how: "auto" | "ask" = "ask"): Promise<PdfOcrStatus> {
    if (this.destroyed || !this.ocr) return "unavailable";
    const key = pageKey(backdrop.path, backdrop.page);
    if (how === "auto" && this.ocrDone.has(key)) return "ready";

    const existing = this.ocrInflight.get(key);
    if (existing) return existing;

    const ready = await this.ocr.isModelReady().catch(() => false);
    if (this.destroyed) return "unavailable";
    if (!ready) {
      this.waitingForModel.set(key, backdrop);
      this.ocr.offerModel(how);
      return "offered";
    }
    this.waitingForModel.delete(key);

    if (this.held) {
      return new Promise<PdfOcrStatus>((resolve) => {
        const list = this.ocrDeferred.get(key) ?? [];
        list.push({ backdrop, how, resolve });
        this.ocrDeferred.set(key, list);
      });
    }

    const epoch = this.epochOf(backdrop.path);
    const job = new Promise<PdfOcrStatus>((resolve) => {
      this.ocrQueue = this.ocrQueue.then(async () => {
        const status = await this.runOcr(backdrop, key, epoch).catch(
          (): PdfOcrStatus => "unavailable",
        );
        this.ocrInflight.delete(key);
        resolve(status);
      });
    });
    this.ocrInflight.set(key, job);
    return job;
  }

  /** While the pen writes nothing is read; letting go reads what was asked for meanwhile. */
  setHeld(held: boolean): void {
    if (this.held === held) return;
    this.held = held;
    if (held) return;
    const waiting = [...this.deferred.values()];
    this.deferred.clear();
    for (const backdrop of waiting) this.request(backdrop);

    const waitingOcr = [...this.ocrDeferred.values()];
    this.ocrDeferred.clear();
    for (const group of waitingOcr) {
      const sample = group[0];
      if (!sample) continue;
      const how = group.some((g) => g.how === "ask") ? "ask" : "auto";
      void this.requestOcr(sample.backdrop, how).then((status) => {
        for (const item of group) item.resolve(status);
      });
    }
  }

  /** The file changed or went: read its text afresh next time. */
  forget(path: string): void {
    this.pathEpoch.set(path, this.epochOf(path) + 1);
    const prefix = `${path}:`;
    for (const key of [...this.pages.keys()]) if (key.startsWith(prefix)) this.pages.delete(key);
    for (const key of [...this.layouts.keys()])
      if (key.startsWith(prefix)) this.layouts.delete(key);
    for (const key of [...this.ocrDone]) if (key.startsWith(prefix)) this.ocrDone.delete(key);
    for (const key of [...this.waitingForModel.keys()]) {
      if (key.startsWith(prefix)) this.waitingForModel.delete(key);
    }
    for (const [key, group] of [...this.ocrDeferred.entries()]) {
      if (key.startsWith(prefix)) {
        this.ocrDeferred.delete(key);
        for (const item of group) item.resolve("unavailable");
      }
    }
    const doc = this.documents.get(path);
    this.documents.delete(path);
    void doc?.then((d) => d?.destroy()).catch(() => undefined);
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubscribeModel?.();
    this.deferred.clear();
    this.waitingForModel.clear();
    for (const group of this.ocrDeferred.values()) {
      for (const item of group) item.resolve("unavailable");
    }
    this.ocrDeferred.clear();
    this.ocrDone.clear();
    for (const doc of this.documents.values()) {
      void doc.then((d) => d?.destroy()).catch(() => undefined);
    }
    this.documents.clear();
    this.pages.clear();
    this.layouts.clear();
    this.onReady = null;
  }

  private epochOf(path: string): number {
    return this.pathEpoch.get(path) ?? 0;
  }

  private async flushModelWaiters(): Promise<void> {
    if (this.destroyed || !this.ocr || this.waitingForModel.size === 0) return;
    const ready = await this.ocr.isModelReady().catch(() => false);
    if (!ready || this.destroyed) return;
    const queued = [...this.waitingForModel.values()];
    this.waitingForModel.clear();
    for (const backdrop of queued) {
      void this.requestOcr(backdrop, "auto");
    }
  }

  private invalidateLayouts(key: string): void {
    const prefix = `${key}:`;
    for (const layoutKey of [...this.layouts.keys()]) {
      if (layoutKey.startsWith(prefix)) this.layouts.delete(layoutKey);
    }
  }

  private store(key: string, text: PageText): void {
    this.invalidateLayouts(key);
    this.pages.set(key, text);
    while (this.pages.size > MAX_PAGES) {
      const oldest = this.pages.keys().next().value;
      if (oldest === undefined) break;
      this.pages.delete(oldest);
      this.ocrDone.delete(oldest);
      this.invalidateLayouts(oldest);
    }
  }

  private async runOcr(backdrop: PdfBackdrop, key: string, epoch: number): Promise<PdfOcrStatus> {
    if (this.destroyed || !this.ocr || this.epochOf(backdrop.path) !== epoch) {
      return "unavailable";
    }

    let base = this.pages.get(key);
    if (!base) {
      const initial = await this.read(backdrop).catch((): ReadResult => ({
        text: EMPTY,
        needsOcr: false,
        valid: false,
      }));
      if (this.destroyed || this.epochOf(backdrop.path) !== epoch || !initial.valid) {
        return "unavailable";
      }
      base = initial.text;
      this.store(key, base);
      this.onReady?.(backdrop.path, backdrop.page);
    }

    const doc = await this.document(backdrop.path);
    const number = backdrop.page + 1;
    if (!doc || !Number.isInteger(number) || number < 1 || number > doc.numPages) {
      return "unavailable";
    }

    const plan = ocrRenderPlan(base.source);
    const renderPng = this.ocr.renderPagePng ?? renderPdfPageToPng;
    const page = await doc.getPage(number);
    let pngBytes: Uint8Array | null = null;
    try {
      pngBytes = await renderPng(page, plan);
    } finally {
      page.cleanup?.();
    }
    if (!pngBytes || this.destroyed || this.epochOf(backdrop.path) !== epoch) {
      return "unavailable";
    }

    const blocks = await this.ocr.recognize(pngBytes);
    if (this.destroyed || this.epochOf(backdrop.path) !== epoch) return "unavailable";

    const latest = this.pages.get(key) ?? base;
    const mergedItems = ocrBlocksToItems({
      blocks,
      canvasSize: { width: plan.width, height: plan.height },
      viewport: latest.viewport,
      source: latest.source,
      nativeItems: latest.nativeItems,
    });

    this.ocrDone.add(key);
    this.store(key, {
      ...latest,
      items: mergedItems,
    });
    this.onReady?.(backdrop.path, backdrop.page);
    return mergedItems.length > latest.nativeItems.length ? "ready" : "empty";
  }

  private async read(backdrop: PdfBackdrop): Promise<ReadResult> {
    const doc = await this.document(backdrop.path);
    const number = backdrop.page + 1;
    if (!doc || !Number.isInteger(number) || number < 1 || number > doc.numPages) {
      return { text: EMPTY, needsOcr: false, valid: false };
    }
    const page = await doc.getPage(number);
    try {
      const viewport = page.getViewport({ scale: 1 });
      const t = viewport.transform;
      if (t.length < 6 || !(viewport.width > 0) || !(viewport.height > 0)) {
        return { text: EMPTY, needsOcr: false, valid: false };
      }
      const content = await page.getTextContent();
      const nativeItems = readTextItems(content);
      const links = await this.readPageLinks(doc, page).catch(() => [] as PdfLink[]);
      const needsOcr = await this.detectPageNeedsOcr(page, nativeItems);
      return {
        text: {
          items: nativeItems,
          nativeItems,
          links,
          viewport: [t[0], t[1], t[2], t[3], t[4], t[5]],
          source: { width: viewport.width, height: viewport.height },
        },
        needsOcr,
        valid: true,
      };
    } finally {
      page.cleanup?.();
    }
  }

  private async detectPageNeedsOcr(
    page: PdfPageLike,
    nativeItems: readonly PdfTextItem[],
  ): Promise<boolean> {
    if (!this.ocr) return false;
    const nativeChars = countNativeChars(nativeItems);
    if (!page.getOperatorList) return nativeChars === 0;
    const lib = await this.pdfJs().catch(() => null);
    if (!lib?.OPS) return nativeChars === 0;
    try {
      const opList = await page.getOperatorList();
      const { images, fills } = countPageDrawOps(opList, lib.OPS);
      return needsPageOcr({ nativeChars, images, fills });
    } catch {
      return nativeChars === 0;
    }
  }

  /** A page's links, each destination resolved to a page of the same PDF. */
  private async readPageLinks(doc: PdfDocumentLike, page: PdfPageLike): Promise<PdfLink[]> {
    if (!page.getAnnotations) return [];
    const annotations = await page.getAnnotations();
    return readLinks(annotations, async (dest) => {
      let explicit: unknown = dest;
      if (typeof dest === "string") explicit = await doc.getDestination?.(dest);
      if (!Array.isArray(explicit) || explicit.length === 0) return null;
      const ref: unknown = explicit[0];
      // A destination names its page by reference, or (rarely) by index.
      if (typeof ref === "number") return ref;
      if (!doc.getPageIndex || typeof ref !== "object" || ref === null) return null;
      return doc.getPageIndex(ref);
    });
  }

  private document(path: string): Promise<PdfDocumentLike | null> {
    let doc = this.documents.get(path);
    if (!doc) {
      doc = this.open(path).catch(() => null);
      this.documents.set(path, doc);
    }
    return doc;
  }

  private pdfJs(): Promise<PdfJsLike> {
    this.lib ??= loadPdfJs().then((value: unknown) => value as PdfJsLike);
    return this.lib;
  }

  private async open(path: string): Promise<PdfDocumentLike | null> {
    const file: TFile | null = this.app.vault.getFileByPath(path);
    if (!file) return null;
    // Read-only, as everywhere: the source PDF is never written.
    const bytes = await this.app.vault.readBinary(file);
    const lib = await this.pdfJs();
    // pdf.js may detach the buffer it is handed: a private copy (CLAUDE.md).
    return await lib.getDocument({ data: new Uint8Array(bytes.slice(0)), ...pdfAssets() }).promise;
  }
}
