import { describe, expect, it } from "vitest";
import {
  type OcrBlock,
  countNativeChars,
  countPageDrawOps,
  invertMatrix,
  needsPageOcr,
  ocrBlocksToItems,
  ocrRenderPlan,
} from "../../src/canvas/pdf-ocr";
import { type Matrix, layoutText, multiply, pdfToPage, selectText } from "../../src/canvas/pdf-text";

describe("invertMatrix", () => {
  it("inverts upright and rotated PDF viewports and returns null when singular", () => {
    const viewports: Matrix[] = [
      [1, 0, 0, -1, 0, 792], // 0 deg Letter
      [0, 1, 1, 0, 0, 0], // 90 deg
      [-1, 0, 0, 1, 612, 0], // 180 deg
      [0, -1, -1, 0, 792, 612], // 270 deg
      [1.25, 0, 0, -1.25, -36, 954], // CropBox offset + scale
    ];
    for (const v of viewports) {
      const inv = invertMatrix(v);
      expect(inv).not.toBeNull();
      const id = multiply(v, inv!);
      expect(id[0]).toBeCloseTo(1, 6);
      expect(id[1]).toBeCloseTo(0, 6);
      expect(id[2]).toBeCloseTo(0, 6);
      expect(id[3]).toBeCloseTo(1, 6);
      expect(id[4]).toBeCloseTo(0, 6);
      expect(id[5]).toBeCloseTo(0, 6);
    }
    expect(invertMatrix([0, 0, 0, 0, 10, 20])).toBeNull();
  });
});

describe("needsPageOcr and countPageDrawOps", () => {
  const OPS = {
    fill: 22,
    eoFill: 23,
    paintImageXObject: 85,
    constructPath: 91,
    stroke: 20,
  };

  it("counts direct fills, constructPath fills, and image paint ops", () => {
    const counts = countPageDrawOps(
      {
        fnArray: [22, 91, 91, 85, 20],
        argsArray: [[], [23, [0, 0, 10, 10]], [20, [0, 0, 5, 5]], ["img1", 100, 100], []],
      },
      OPS,
    );
    expect(counts).toEqual({ images: 1, fills: 2 });
  });

  it("triggers OCR on scans and vector-outlined pages while skipping normal text and ruled paper", () => {
    // Normal text slide: 850 chars, 20 background boxes
    expect(needsPageOcr({ nativeChars: 850, images: 0, fills: 20 })).toBe(false);
    // Blank / ruled paper template: 0 chars, 0 images, 4 fills
    expect(needsPageOcr({ nativeChars: 0, images: 0, fills: 4 })).toBe(false);
    // Pure scanned page
    expect(needsPageOcr({ nativeChars: 0, images: 1, fills: 0 })).toBe(true);
    // Scanned page with tiny stamp / page number
    expect(needsPageOcr({ nativeChars: 14, images: 1, fills: 2 })).toBe(true);
    // Pure vector-outlined text page
    expect(needsPageOcr({ nativeChars: 0, images: 0, fills: 320 })).toBe(true);
    // Hybrid Quartz PDF page (56-amenorrhea 2.pdf Page 1: 188 chars, 1263 fills)
    expect(needsPageOcr({ nativeChars: 188, images: 1, fills: 1263 })).toBe(true);
    // Normal text slide with a complex vector illustration (1200 chars, 400 fills)
    expect(needsPageOcr({ nativeChars: 1200, images: 0, fills: 400 })).toBe(false);
  });

  it("counts only non-whitespace horizontal native characters", () => {
    expect(
      countNativeChars([
        { str: "Amenorrhea  ", transform: [20, 0, 0, 20, 40, 700], width: 110, height: 20 },
        { str: "   ", transform: [12, 0, 0, 12, 40, 680], width: 20, height: 12 },
        { str: "side", transform: [12, 0, 0, 12, 10, 500], width: 24, height: 12, vertical: true },
      ]),
    ).toBe(10);
  });

  it("caps OCR render dimensions to protect mobile canvas memory", () => {
    expect(ocrRenderPlan({ width: 612, height: 792 })).toEqual({
      scale: 2.5,
      width: 1530,
      height: 1980,
    });
    expect(ocrRenderPlan({ width: 1200, height: 1600 })).toEqual({
      scale: 1.25,
      width: 1500,
      height: 2000,
    });
  });
});

describe("ocrBlocksToItems", () => {
  it("maps OCR words accurately onto upright and 90-degree rotated PDF pages", () => {
    const blocks: OcrBlock[] = [
      {
        bbox: { x0: 100, y0: 200, x1: 420, y1: 240 },
        lines: [
          {
            bbox: { x0: 100, y0: 200, x1: 420, y1: 240 },
            words: [
              { text: "Primary", bbox: { x0: 100, y0: 200, x1: 240, y1: 240 }, confidence: 95 },
              { text: "—", bbox: { x0: 242, y0: 218, x1: 262, y1: 222 }, confidence: 88 },
              { text: "ovarian", bbox: { x0: 264, y0: 204, x1: 420, y1: 240 }, confidence: 94 },
              { text: "|", bbox: { x0: 500, y0: 190, x1: 504, y1: 250 }, confidence: 30 },
            ],
          },
        ],
      },
    ];

    // 90-degree rotated PDF viewport: source 600x800, rendered at 2x (1200x1600)
    const viewport: Matrix = [0, 1, 1, 0, 0, 0];
    const source = { width: 600, height: 800 };
    const geometry = { width: 600, height: 800 };

    const items = ocrBlocksToItems({
      blocks,
      canvasSize: { width: 1200, height: 1600 },
      viewport,
      source,
    });

    const layout = layoutText(items, pdfToPage(viewport, source, geometry));
    expect(layout.lines).toHaveLength(1);
    // Canvas (100..420, 200..240) at 2x -> page (50..210, 100..120)
    expect(layout.lines[0].x0).toBeCloseTo(50, 1);
    expect(layout.lines[0].x1).toBeCloseTo(210, 1);
    expect(layout.lines[0].top).toBeCloseTo(100, 1);
    expect(layout.lines[0].bottom).toBeCloseTo(120, 1);

    const sel = selectText(layout, { x: 60, y: 110 }, { x: 200, y: 110 });
    expect(sel?.text).toBe("Primary — ovarian");
  });

  it("deduplicates native PDF headings while preserving 2-column OCR card reading order", () => {
    const viewport: Matrix = [1, 0, 0, -1, 0, 800];
    const source = { width: 600, height: 800 };
    const geometry = { width: 600, height: 800 };

    // Native heading "Amenorrhea" at viewport x=40..180, top=44, bottom=64 (baseline y=60 -> pdf y=740)
    const nativeItems = [
      {
        str: "Amenorrhea",
        transform: [20, 0, 0, 20, 40, 740],
        width: 140,
        height: 20,
        ascent: 0.8,
        descent: -0.2,
      },
    ];

    const blocks: OcrBlock[] = [
      // OCR also saw "Amenorrhea" at the top
      {
        bbox: { x0: 40, y0: 44, x1: 180, y1: 64 },
        lines: [
          {
            bbox: { x0: 40, y0: 44, x1: 180, y1: 64 },
            words: [
              { text: "Amenorrhea", bbox: { x0: 42, y0: 45, x1: 178, y1: 63 }, confidence: 96 },
            ],
          },
        ],
      },
      // Left column card (y=200..250, x=40..260)
      {
        bbox: { x0: 40, y0: 200, x1: 260, y1: 250 },
        lines: [
          {
            bbox: { x0: 40, y0: 200, x1: 220, y1: 218 },
            words: [
              { text: "Outflow", bbox: { x0: 40, y0: 200, x1: 120, y1: 218 }, confidence: 95 },
              { text: "tract", bbox: { x0: 128, y0: 200, x1: 180, y1: 218 }, confidence: 95 },
            ],
          },
          {
            bbox: { x0: 40, y0: 228, x1: 220, y1: 246 },
            words: [
              { text: "Asherman", bbox: { x0: 40, y0: 228, x1: 140, y1: 246 }, confidence: 93 },
            ],
          },
        ],
      },
      // Right column card (y=200..250, x=320..540)
      {
        bbox: { x0: 320, y0: 200, x1: 540, y1: 250 },
        lines: [
          {
            bbox: { x0: 320, y0: 200, x1: 500, y1: 218 },
            words: [
              { text: "Ovary", bbox: { x0: 320, y0: 200, x1: 380, y1: 218 }, confidence: 95 },
              { text: "failure", bbox: { x0: 388, y0: 200, x1: 455, y1: 218 }, confidence: 95 },
            ],
          },
          {
            bbox: { x0: 320, y0: 228, x1: 500, y1: 246 },
            words: [
              { text: "Turner", bbox: { x0: 320, y0: 228, x1: 390, y1: 246 }, confidence: 94 },
            ],
          },
        ],
      },
    ];

    const merged = ocrBlocksToItems({
      blocks,
      canvasSize: { width: 600, height: 800 },
      viewport,
      source,
      nativeItems,
    });

    const layout = layoutText(merged, pdfToPage(viewport, source, geometry));
    const lineTexts = layout.lines.map((line) =>
      layout.chars
        .slice(line.start, line.end)
        .map((c) => c.ch)
        .join(""),
    );
    expect(lineTexts).toEqual([
      "Amenorrhea",
      "Outflow tract",
      "Asherman",
      "Ovary failure",
      "Turner",
    ]);
  });
});
