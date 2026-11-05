/**
 * The Folders sidebar's tree, as plain data: which folders are listed, in
 * which order and how deep, what a filter keeps, where the arrow keys go, and
 * the folders opened last. No DOM and no Obsidian, so it can be tested.
 */

import { DEFAULT_FOLDER_COLOR, DEFAULT_FOLDER_ICON, type FolderStyles } from "./library-style";

/** A folder and the folders directly in it, in the order they are listed. */
export interface FolderNode {
  path: string;
  name: string;
  children: FolderNode[];
}

/** One line of the tree. */
export interface FolderRow {
  path: string;
  name: string;
  /** 0 for a folder at the top. */
  depth: number;
  /** It has folders in it (a chevron is drawn). */
  hasChildren: boolean;
  /** Its folders are listed below it. */
  expanded: boolean;
}

/** A name or a typed filter without capitals or accents, so "cafe" finds "Café". */
export function plainText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

/** Whether `name` contains the typed `filter` (an empty filter keeps everything). */
export function matchesFilter(name: string, filter: string): boolean {
  const wanted = plainText(filter.trim());
  return wanted === "" || plainText(name).includes(wanted);
}

/** Whether the folder or any folder below it matches `filter`. */
export function subtreeMatches(node: FolderNode, filter: string): boolean {
  return matchesFilter(node.name, filter) || node.children.some((c) => subtreeMatches(c, filter));
}

export interface FlattenOptions {
  /** Whether a folder's own folders are listed; ignored while a filter is typed. */
  isExpanded: (path: string) => boolean;
  /** What is typed in the filter box ("" for none). */
  filter?: string;
}

/**
 * The lines to draw. With no filter, a folder's folders follow it when it is
 * expanded. With one, only the folders that match, and the folders above
 * them, are listed, all open, so a match deep down is never hidden.
 */
export function flattenFolders(roots: readonly FolderNode[], options: FlattenOptions): FolderRow[] {
  const filter = (options.filter ?? "").trim();
  const rows: FolderRow[] = [];
  const visit = (node: FolderNode, depth: number): void => {
    if (filter !== "" && !subtreeMatches(node, filter)) return;
    const shown =
      filter === "" ? node.children : node.children.filter((c) => subtreeMatches(c, filter));
    const expanded = filter === "" ? options.isExpanded(node.path) : shown.length > 0;
    rows.push({
      path: node.path,
      name: node.name,
      depth,
      hasChildren: shown.length > 0,
      expanded: expanded && shown.length > 0,
    });
    if (expanded) for (const child of shown) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  return rows;
}

/** The folder a path is in; "" for a folder at the top. */
export function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

export type NavKey = "ArrowDown" | "ArrowUp" | "Home" | "End" | "ArrowRight" | "ArrowLeft";

/** What a key does in the tree. */
export type NavMove =
  | { kind: "focus"; path: string }
  | { kind: "expand"; path: string }
  | { kind: "collapse"; path: string }
  | { kind: "none" };

/**
 * What an arrow key, Home or End does with `current` focused. Right opens a
 * closed folder, or steps into an open one; Left closes an open folder, or
 * steps up to its parent. While a filter is typed every folder is already
 * open, so Left and Right only move.
 */
export function navigate(
  rows: readonly FolderRow[],
  current: string,
  key: NavKey,
  filtering = false,
): NavMove {
  const at = rows.findIndex((r) => r.path === current);
  if (at === -1) return rows.length > 0 ? { kind: "focus", path: rows[0].path } : { kind: "none" };
  const row = rows[at];
  const focus = (index: number): NavMove =>
    index >= 0 && index < rows.length
      ? { kind: "focus", path: rows[index].path }
      : { kind: "none" };
  switch (key) {
    case "ArrowDown":
      return focus(at + 1);
    case "ArrowUp":
      return focus(at - 1);
    case "Home":
      return focus(0);
    case "End":
      return focus(rows.length - 1);
    case "ArrowRight":
      if (row.hasChildren && !row.expanded && !filtering) return { kind: "expand", path: row.path };
      return row.expanded ? focus(at + 1) : { kind: "none" };
    case "ArrowLeft": {
      if (row.hasChildren && row.expanded && !filtering)
        return { kind: "collapse", path: row.path };
      const parent = rows.find((r) => r.path === parentOf(row.path) && r.depth < row.depth);
      return parent ? { kind: "focus", path: parent.path } : { kind: "none" };
    }
  }
}

/** How many opened folders are kept, and how many the sidebar lists. */
export const RECENT_KEPT = 10;
export const RECENT_SHOWN = 3;

/** The stored list, cleaned: strings only, no blanks, no repeats, at most {@link RECENT_KEPT}. */
export function recentOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item !== "" && !out.includes(item)) out.push(item);
    if (out.length === RECENT_KEPT) break;
  }
  return out;
}

/** `path` made the most recent. */
export function pushRecent(recent: readonly string[], path: string): string[] {
  if (path === "") return [...recent];
  return [path, ...recent.filter((p) => p !== path)].slice(0, RECENT_KEPT);
}

/**
 * The recent folders to list: newest first, only those that still exist and
 * are not listed elsewhere (starred), at most {@link RECENT_SHOWN}.
 */
export function recentToShow(
  recent: readonly string[],
  exists: (path: string) => boolean,
  skip: ReadonlySet<string> = new Set(),
): string[] {
  return recent.filter((p) => exists(p) && !skip.has(p)).slice(0, RECENT_SHOWN);
}

/** What a folder wears in the sidebar: the colour and icon the library gives it. */
export function folderLook(styles: FolderStyles, path: string): { color: string; icon: string } {
  const style = styles[path];
  return {
    color: style?.color ?? DEFAULT_FOLDER_COLOR,
    icon: style?.icon ?? DEFAULT_FOLDER_ICON,
  };
}

/**
 * Whether the folder at `from` may be moved into the folder at `to` ("" the
 * top of the vault): not into itself or something inside it, and not where it
 * already is.
 */
export function isValidFolderMove(from: string, to: string): boolean {
  if (from === "" || from === to) return false;
  if (to.startsWith(`${from}/`)) return false;
  return parentOf(from) !== to;
}
