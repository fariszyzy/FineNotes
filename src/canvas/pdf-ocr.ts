/**
 * OCR geometry, page-content heuristics, and hybrid text merging for PDF
 * backdrops whose words are raster scans or vector path outlines rather than
 * selectable PDF font glyphs.
 *
 * **Pure:** no DOM, no Obsidian, no Tesseract runtime.
 */

import { type Matrix, type PdfTextItem, multiply } from "./pdf-text";

export interface OcrBbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrWord {
  text: string;
  bbox: OcrBbox;
  /** Tesseract confidence in `[0, 100]`. */
  confidence: number;
}

export interface OcrLine {
  bbox: OcrBbox;
  words: readonly OcrWord[];
}

export interface OcrBlock {
  bbox: OcrBbox;
  lines: readonly OcrLine[];
}

export interface OperatorListLike {
  fnArray: readonly number[];
  argsArray?: ReadonlyArray<readonly unknown[] | null | undefined>;
}

export type PdfOpsLike = Readonly<Record<string, number | undefined>>;

export interface PageDrawStats {
  nativeChars: number;
  images: number;
  fills: number;
}

const DEFAULT_ASCENT = 0.8;
const DEFAULT_DESCENT = -0.2;
/** Below `pdf-text.ts`'s `SPACE_GAP` (0.12), plus a small margin for rounding. */
const TIGHT_WORD_GAP = 0.13;
const MAX_SAME_LINE_GAP = 4;
const MIN_WORD_CONFIDENCE = 20;
const MIN_SYMBOL_CONFIDENCE = 55;

const IMAGE_OP_NAMES = [
  "paintImageXObject",
  "paintInlineImageXObject",
  "paintImageMaskXObject",
  "paintImageXObjectRepeat",
  "paintImageMaskXObjectRepeat",
  "paintImageMaskXObjectGroup",
  "paintInlineImageXObjectGroup",
] as const;

const FILL_OP_NAMES = [
  "fill",
  "eoFill",
  "fillStroke",
  "eoFillStroke",
  "closeFillStroke",
  "closeEOFillStroke",
  "rawFillPath",
] as const;

/** Invert a 2D affine matrix `[a, b, c, d, e, f]`, or `null` when singular. */
export function invertMatrix(m: Matrix): Matrix | null {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/** Count non-whitespace characters present in pdf.js `getTextContent` items. */
export function countNativeChars(items: readonly PdfTextItem[]): number {
  let total = 0;
  for (const item of items) {
    if (item.vertical || !item.str) continue;
    for (let i = 0; i < item.str.length; i++) {
      if (item.str[i].trim() !== "") total++;
    }
  }
  return total;
}

/**
 * Count painted raster images and filled vector paths in a `pdf.js`
 * `getOperatorList()` result, resolving operator codes dynamically from `OPS`.
 */
export function countPageDrawOps(
  opList: OperatorListLike,
  ops: PdfOpsLike,
): { images: number; fills: number } {
  const imageOps = new Set<number>();
  for (const name of IMAGE_OP_NAMES) {
    const code = ops[name];
    if (typeof code === "number") imageOps.add(code);
  }
  const fillOps = new Set<number>();
  for (const name of FILL_OP_NAMES) {
    const code = ops[name];
    if (typeof code === "number") fillOps.add(code);
  }
  const constructPath = ops.constructPath;

  let images = 0;
  let fills = 0;
  const { fnArray, argsArray } = opList;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    if (imageOps.has(fn)) {
      images++;
    } else if (fillOps.has(fn)) {
      fills++;
    } else if (constructPath !== undefined && fn === constructPath) {
      const subOp = argsArray?.[i]?.[0];
      if (typeof subOp === "number" && fillOps.has(subOp)) fills++;
    }
  }
  return { images, fills };
}

/**
 * Decide whether a PDF page needs OCR to expose missing text:
 * - Pure scan or pure vector-outlined page (`nativeChars === 0` with images or >= 80 fills;
 *   skips blank/ruled paper templates).
 * - Scanned page with a small stamp, header, or page number (`images > 0 && nativeChars < 80`).
 * - Hybrid page where headings are real fonts but body copy is outlined vector paths
 *   (`fills >= 200 && nativeChars < fills * 0.6`).
 */
export function needsPageOcr(stats: PageDrawStats): boolean {
  const { nativeChars, images, fills } = stats;
  if (nativeChars <= 0) return images > 0 || fills >= 80;
  if (images > 0 && nativeChars < 80) return true;
  if (fills >= 200 && nativeChars < fills * 0.6) return true;
  return false;
}

/** Offscreen raster dimensions for OCR (~170-180 DPI on slides, capped for iPad canvas memory). */
export function ocrRenderPlan(
  source: { width: number; height: number },
  maxEdge = 2000,
  maxScale = 2.5,
): { scale: number; width: number; height: number } {
  const longest = Math.max(1, source.width, source.height);
  const scale = Math.max(1, Math.min(maxScale, maxEdge / longest));
  return {
    scale,
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  };
}

interface ViewportBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface PlacedNative {
  item: PdfTextItem;
  box: ViewportBox | null;
}

interface NativeLineGroup {
  items: PdfTextItem[];
  box: ViewportBox;
}

interface BlockGroup {
  box: ViewportBox;
  entries: Array<{ top: number; x0: number; items: PdfTextItem[] }>;
}

function projectNativeItem(item: PdfTextItem, viewport: Matrix): ViewportBox | null {
  if (item.vertical || item.str.length === 0) return null;
  const t = item.transform;
  if (t.length < 6 || !t.every(Number.isFinite) || !(item.width > 0)) return null;
  const scaleX = Math.hypot(t[0], t[1]);
  if (!(scaleX > 0)) return null;
  const m = multiply(viewport, [t[0], t[1], t[2], t[3], t[4], t[5]]);
  if (!(m[0] > 0) || !(m[3] < 0)) return null;
  const ascent = item.ascent !== undefined && item.ascent > 0 ? item.ascent : DEFAULT_ASCENT;
  const descent =
    item.descent !== undefined && item.descent !== 0 ? Math.abs(item.descent) : -DEFAULT_DESCENT;
  const width = (item.width / scaleX) * m[0];
  const x0 = m[4];
  const x1 = x0 + width;
  const y0 = m[5] + ascent * m[3];
  const y1 = m[5] - descent * m[3];
  if (![x0, x1, y0, y1].every(Number.isFinite) || !(x1 > x0) || !(y1 > y0)) return null;
  return { x0, y0, x1, y1 };
}

function overlapsNative(word: ViewportBox, natives: readonly ViewportBox[]): boolean {
  const ww = word.x1 - word.x0;
  const wh = word.y1 - word.y0;
  const wordArea = ww * wh;
  if (!(wordArea > 0)) return true;
  for (const n of natives) {
    const ovX = Math.min(word.x1, n.x1) - Math.max(word.x0, n.x0);
    if (ovX <= 0) continue;
    const ovY = Math.min(word.y1, n.y1) - Math.max(word.y0, n.y0);
    if (ovY <= 0) continue;
    if ((ovX * ovY) / wordArea >= 0.35) return true;
    const minH = Math.min(wh, n.y1 - n.y0);
    const minW = Math.min(ww, n.x1 - n.x0);
    if (ovY >= 0.5 * minH && ovX >= 0.4 * minW) return true;
  }
  return false;
}

function isReliableWord(word: OcrWord, sourceHeight: number, sy: number): boolean {
  const trimmed = word.text.trim();
  if (!trimmed) return false;
  if (!Number.isFinite(word.confidence) || word.confidence < MIN_WORD_CONFIDENCE) return false;
  const { x0, y0, x1, y1 } = word.bbox;
  if (![x0, y0, x1, y1].every(Number.isFinite) || !(x1 > x0) || !(y1 > y0)) return false;
  const w = x1 - x0;
  const h = y1 - y0;
  if (h * sy > sourceHeight * 0.25 && trimmed.length <= 2) return false;
  if (trimmed === "|" && (w < 0.35 * h || word.confidence < 88)) return false;
  if (trimmed.length === 1 && !/[0-9A-Za-z]/.test(trimmed)) {
    return word.confidence >= MIN_SYMBOL_CONFIDENCE;
  }
  return true;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function viewportWordToPdfItem(
  text: string,
  box: ViewportBox,
  invViewport: Matrix,
): PdfTextItem | null {
  const vw = box.x1 - box.x0;
  const vh = box.y1 - box.y0;
  if (!(vw > 0) || !(vh > 0)) return null;
  const baselineY = box.y0 + DEFAULT_ASCENT * vh;
  const vpMatrix: Matrix = [vh, 0, 0, -vh, box.x0, baselineY];
  const textMatrix = multiply(invViewport, vpMatrix);
  const scaleX = Math.hypot(textMatrix[0], textMatrix[1]);
  const height = Math.hypot(textMatrix[2], textMatrix[3]);
  if (!(scaleX > 0) || !(height > 0)) return null;
  return {
    str: text,
    transform: textMatrix,
    width: (vw / vh) * scaleX,
    height,
    ascent: DEFAULT_ASCENT,
    descent: DEFAULT_DESCENT,
  };
}

function groupNativeLines(placed: readonly PlacedNative[]): {
  groups: NativeLineGroup[];
  unplaced: PdfTextItem[];
} {
  const groups: NativeLineGroup[] = [];
  const unplaced: PdfTextItem[] = [];
  for (const { item, box } of placed) {
    if (!box) {
      if (item.str.trim() !== "") unplaced.push(item);
      continue;
    }
    const prev = groups[groups.length - 1];
    if (prev) {
      const minH = Math.min(prev.box.y1 - prev.box.y0, box.y1 - box.y0);
      const ovY = Math.min(prev.box.y1, box.y1) - Math.max(prev.box.y0, box.y0);
      const gapX = box.x0 - prev.box.x1;
      if (ovY >= 0.5 * minH && gapX >= -0.5 * minH && gapX <= MAX_SAME_LINE_GAP * minH) {
        prev.items.push(item);
        prev.box = {
          x0: Math.min(prev.box.x0, box.x0),
          y0: Math.min(prev.box.y0, box.y0),
          x1: Math.max(prev.box.x1, box.x1),
          y1: Math.max(prev.box.y1, box.y1),
        };
        continue;
      }
    }
    groups.push({ items: [item], box: { ...box } });
  }
  return { groups, unplaced };
}

export interface OcrMergeInput {
  blocks: readonly OcrBlock[];
  canvasSize: { width: number; height: number };
  viewport: Matrix;
  source: { width: number; height: number };
  nativeItems?: readonly PdfTextItem[];
}

/**
 * Convert Tesseract `OcrBlock[]` into `PdfTextItem[]` in PDF user space,
 * dropping OCR words that duplicate existing `nativeItems` and keeping
 * block/column reading order intact.
 */
export function ocrBlocksToItems(input: OcrMergeInput): PdfTextItem[] {
  const { blocks, canvasSize, viewport, source, nativeItems = [] } = input;
  if (
    !(canvasSize.width > 0) ||
    !(canvasSize.height > 0) ||
    !(source.width > 0) ||
    !(source.height > 0)
  ) {
    return [...nativeItems];
  }
  const invViewport = invertMatrix(viewport);
  if (!invViewport) return [...nativeItems];

  const sx = source.width / canvasSize.width;
  const sy = source.height / canvasSize.height;

  const placedNative: PlacedNative[] = nativeItems.map((item) => ({
    item,
    box: projectNativeItem(item, viewport),
  }));
  const nativeBoxes = placedNative
    .filter((p) => p.item.str.trim() !== "")
    .map((p) => p.box)
    .filter((box): box is ViewportBox => box !== null);

  const blockGroups: BlockGroup[] = [];

  for (const block of blocks) {
    const entries: Array<{ top: number; x0: number; items: PdfTextItem[] }> = [];
    let blockBox: ViewportBox | null = null;

    for (const line of block.lines) {
      const validWords = line.words
        .filter((w) => isReliableWord(w, source.height, sy))
        .sort((a, b) => a.bbox.x0 - b.bbox.x0);
      if (validWords.length === 0) continue;

      const alphaWords = validWords.filter((w) => /[0-9A-Za-z]/.test(w.text));
      const refWords = alphaWords.length > 0 ? alphaWords : validWords;
      const bandTop = median(refWords.map((w) => w.bbox.y0 * sy));
      const bandBottom = median(refWords.map((w) => w.bbox.y1 * sy));
      const bandHeight = Math.max(2, bandBottom - bandTop);

      const kept: Array<{ text: string; box: ViewportBox }> = [];
      for (const word of validWords) {
        const vx0 = word.bbox.x0 * sx;
        const vx1 = word.bbox.x1 * sx;
        const rawTop = word.bbox.y0 * sy;
        const rawBottom = word.bbox.y1 * sy;
        const vy0 = Math.max(bandTop - 0.25 * bandHeight, Math.min(rawTop, bandTop));
        const vy1 = Math.min(bandBottom + 0.25 * bandHeight, Math.max(rawBottom, bandBottom));
        const box: ViewportBox = { x0: vx0, y0: vy0, x1: vx1, y1: Math.max(vy0 + 1, vy1) };
        if (overlapsNative(box, nativeBoxes)) continue;
        kept.push({ text: word.text.trim(), box });
      }
      if (kept.length === 0) continue;

      const lineItems: PdfTextItem[] = [];
      for (let i = 0; i < kept.length; i++) {
        const cur = kept[i];
        const next = kept[i + 1];
        let text = cur.text;
        if (next) {
          const gap = next.box.x0 - cur.box.x1;
          const minH = Math.min(cur.box.y1 - cur.box.y0, next.box.y1 - next.box.y0);
          if (gap >= -0.5 * minH && gap <= TIGHT_WORD_GAP * minH) {
            text = `${text} `;
          }
        }
        const pdfItem = viewportWordToPdfItem(text, cur.box, invViewport);
        if (!pdfItem) continue;
        lineItems.push(pdfItem);
        blockBox = blockBox
          ? {
              x0: Math.min(blockBox.x0, cur.box.x0),
              y0: Math.min(blockBox.y0, cur.box.y0),
              x1: Math.max(blockBox.x1, cur.box.x1),
              y1: Math.max(blockBox.y1, cur.box.y1),
            }
          : { ...cur.box };
      }

      if (lineItems.length > 0) {
        entries.push({ top: kept[0].box.y0, x0: kept[0].box.x0, items: lineItems });
      }
    }

    if (entries.length > 0 && blockBox) {
      blockGroups.push({ box: blockBox, entries });
    }
  }

  const { groups: nativeGroups, unplaced } = groupNativeLines(placedNative);
  for (const ng of nativeGroups) {
    const nh = ng.box.y1 - ng.box.y0;
    let target: BlockGroup | null = null;
    for (const bg of blockGroups) {
      const ovX = Math.min(ng.box.x1, bg.box.x1) - Math.max(ng.box.x0, bg.box.x0);
      const nearY = ng.box.y1 >= bg.box.y0 - 1.5 * nh && ng.box.y0 <= bg.box.y1 + 1.5 * nh;
      if (ovX > 0 && nearY) {
        target = bg;
        break;
      }
    }
    if (target) {
      target.entries.push({ top: ng.box.y0, x0: ng.box.x0, items: ng.items });
      target.box = {
        x0: Math.min(target.box.x0, ng.box.x0),
        y0: Math.min(target.box.y0, ng.box.y0),
        x1: Math.max(target.box.x1, ng.box.x1),
        y1: Math.max(target.box.y1, ng.box.y1),
      };
    } else {
      blockGroups.push({
        box: ng.box,
        entries: [{ top: ng.box.y0, x0: ng.box.x0, items: ng.items }],
      });
    }
  }

  blockGroups.sort((a, b) => {
    const minH = Math.min(a.box.y1 - a.box.y0, b.box.y1 - b.box.y0);
    if (Math.abs(a.box.y0 - b.box.y0) <= 0.6 * Math.max(10, minH)) {
      return a.box.x0 - b.box.x0;
    }
    return a.box.y0 - b.box.y0;
  });

  const merged: PdfTextItem[] = [...unplaced];
  for (const bg of blockGroups) {
    bg.entries.sort((a, b) => (Math.abs(a.top - b.top) <= 2 ? a.x0 - b.x0 : a.top - b.top));
    for (const entry of bg.entries) {
      merged.push(...entry.items);
    }
  }
  return merged;
}
