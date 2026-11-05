import { describe, expect, it } from "vitest";
import {
  type FolderNode,
  RECENT_KEPT,
  RECENT_SHOWN,
  flattenFolders,
  folderLook,
  isValidFolderMove,
  matchesFilter,
  navigate,
  parentOf,
  pushRecent,
  recentOf,
  recentToShow,
} from "../../src/model/folder-tree";
import { DEFAULT_FOLDER_COLOR, DEFAULT_FOLDER_ICON } from "../../src/model/library-style";

const node = (path: string, children: FolderNode[] = []): FolderNode => ({
  path,
  name: path.slice(path.lastIndexOf("/") + 1),
  children,
});

const tree: FolderNode[] = [
  node("Maths", [node("Maths/Algebra"), node("Maths/Calculus", [node("Maths/Calculus/Limits")])]),
  node("Café"),
  node("Physics"),
];

describe("matchesFilter", () => {
  it("ignores capitals and accents, and keeps everything for an empty filter", () => {
    expect(matchesFilter("Café", "CAFE")).toBe(true);
    expect(matchesFilter("Physics", "")).toBe(true);
    expect(matchesFilter("Physics", "  ")).toBe(true);
    expect(matchesFilter("Physics", "math")).toBe(false);
  });
});

describe("flattenFolders", () => {
  it("lists only the open folders' folders", () => {
    const closed = flattenFolders(tree, { isExpanded: () => false });
    expect(closed.map((r) => r.path)).toEqual(["Maths", "Café", "Physics"]);
    expect(closed[0]).toMatchObject({ depth: 0, hasChildren: true, expanded: false });
    const open = flattenFolders(tree, { isExpanded: (p) => p === "Maths" });
    expect(open.map((r) => r.path)).toEqual([
      "Maths",
      "Maths/Algebra",
      "Maths/Calculus",
      "Café",
      "Physics",
    ]);
    expect(open[1].depth).toBe(1);
    expect(open[2]).toMatchObject({ hasChildren: true, expanded: false });
  });

  it("with a filter lists the matches and the folders above them, all open", () => {
    const rows = flattenFolders(tree, { isExpanded: () => false, filter: "limit" });
    expect(rows.map((r) => [r.path, r.depth, r.expanded])).toEqual([
      ["Maths", 0, true],
      ["Maths/Calculus", 1, true],
      ["Maths/Calculus/Limits", 2, false],
    ]);
  });

  it("with a filter that matches nothing lists nothing", () => {
    expect(flattenFolders(tree, { isExpanded: () => true, filter: "zzz" })).toEqual([]);
  });

  it("a folder that matches by its own name hides its non-matching folders", () => {
    const rows = flattenFolders(tree, { isExpanded: () => false, filter: "maths" });
    expect(rows.map((r) => r.path)).toEqual(["Maths"]);
    expect(rows[0].hasChildren).toBe(false);
  });
});

describe("parentOf", () => {
  it("gives the folder a path is in", () => {
    expect(parentOf("a/b/c")).toBe("a/b");
    expect(parentOf("a")).toBe("");
  });
});

describe("navigate", () => {
  const rows = flattenFolders(tree, { isExpanded: (p) => p === "Maths" });
  it("moves with the arrows, Home and End and stops at the ends", () => {
    expect(navigate(rows, "Maths", "ArrowDown")).toEqual({ kind: "focus", path: "Maths/Algebra" });
    expect(navigate(rows, "Maths", "ArrowUp")).toEqual({ kind: "none" });
    expect(navigate(rows, "Café", "Home")).toEqual({ kind: "focus", path: "Maths" });
    expect(navigate(rows, "Café", "End")).toEqual({ kind: "focus", path: "Physics" });
    expect(navigate(rows, "Physics", "ArrowDown")).toEqual({ kind: "none" });
  });

  it("right opens a closed folder or steps in; left closes or steps up", () => {
    expect(navigate(rows, "Maths/Calculus", "ArrowRight")).toEqual({
      kind: "expand",
      path: "Maths/Calculus",
    });
    expect(navigate(rows, "Maths", "ArrowRight")).toEqual({ kind: "focus", path: "Maths/Algebra" });
    expect(navigate(rows, "Maths", "ArrowLeft")).toEqual({ kind: "collapse", path: "Maths" });
    expect(navigate(rows, "Maths/Algebra", "ArrowLeft")).toEqual({ kind: "focus", path: "Maths" });
    expect(navigate(rows, "Café", "ArrowLeft")).toEqual({ kind: "none" });
    expect(navigate(rows, "Café", "ArrowRight")).toEqual({ kind: "none" });
  });

  it("while filtering, left and right only move", () => {
    const filtered = flattenFolders(tree, { isExpanded: () => false, filter: "limit" });
    expect(navigate(filtered, "Maths", "ArrowLeft", true)).toEqual({ kind: "none" });
    expect(navigate(filtered, "Maths", "ArrowRight", true)).toEqual({
      kind: "focus",
      path: "Maths/Calculus",
    });
  });

  it("starts at the first row when nothing is focused", () => {
    expect(navigate(rows, "gone", "ArrowDown")).toEqual({ kind: "focus", path: "Maths" });
    expect(navigate([], "x", "ArrowDown")).toEqual({ kind: "none" });
  });
});

describe("recent folders", () => {
  it("keeps the newest first, no repeats, a bounded number", () => {
    let recent: string[] = [];
    for (let i = 0; i < RECENT_KEPT + 3; i++) recent = pushRecent(recent, `f${i}`);
    expect(recent).toHaveLength(RECENT_KEPT);
    expect(recent[0]).toBe(`f${RECENT_KEPT + 2}`);
    expect(pushRecent(["a", "b"], "b")).toEqual(["b", "a"]);
    expect(pushRecent(["a"], "")).toEqual(["a"]);
  });

  it("cleans a stored list", () => {
    expect(recentOf(["a", "", "a", 3, "b"])).toEqual(["a", "b"]);
    expect(recentOf("x")).toEqual([]);
  });

  it("lists the few that exist and are not starred", () => {
    const shown = recentToShow(
      ["a", "gone", "b", "c", "d", "e"],
      (p) => p !== "gone",
      new Set(["b"]),
    );
    expect(shown).toEqual(["a", "c", "d"]);
    expect(shown).toHaveLength(RECENT_SHOWN);
  });
});

describe("folderLook", () => {
  it("is the library's look, or its defaults", () => {
    expect(folderLook({ a: { color: "#123456", icon: "code" } }, "a")).toEqual({
      color: "#123456",
      icon: "code",
    });
    expect(folderLook({}, "a")).toEqual({ color: DEFAULT_FOLDER_COLOR, icon: DEFAULT_FOLDER_ICON });
  });
});

describe("isValidFolderMove", () => {
  it("allows a move to another folder or to the top", () => {
    expect(isValidFolderMove("a/b", "c")).toBe(true);
    expect(isValidFolderMove("a/b", "")).toBe(true);
  });

  it("refuses a move into itself, into its own folder, or where it already is", () => {
    expect(isValidFolderMove("a", "a")).toBe(false);
    expect(isValidFolderMove("a", "a/b")).toBe(false);
    expect(isValidFolderMove("a/b", "a")).toBe(false);
    expect(isValidFolderMove("a", "")).toBe(false);
    expect(isValidFolderMove("", "a")).toBe(false);
  });

  it("does not mistake a longer name for a child", () => {
    expect(isValidFolderMove("a", "ab")).toBe(true);
  });
});
