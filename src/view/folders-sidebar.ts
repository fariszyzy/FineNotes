/**
 * The Folders sidebar, shown on the left while the simple look is on: the
 * vault's folders as a tree, with a filter, starred and recent folders, a
 * count of the notes in each, and one menu per folder. Opening a folder shows
 * it in the notebook library. Stars and folder colours are the library's own,
 * so both places agree.
 *
 *   .goodobsidian-folders
 *     .goodobsidian-folders-head   (title · collapse all · new folder · edit)
 *     .goodobsidian-folders-filter
 *     .goodobsidian-folders-list   (the one scroller)
 *       .goodobsidian-folders-label + rows: starred, recent, all folders
 *
 * The folders, their order and what a filter keeps are in model/folder-tree.ts.
 */

import {
  ItemView,
  Notice,
  Platform,
  TFile,
  TFolder,
  type WorkspaceLeaf,
  debounce,
  normalizePath,
  setIcon,
} from "obsidian";
import { VIEW_TYPE_FOLDERS } from "../constants";
import { t, tn } from "../i18n/translate";
import {
  type FolderNode,
  type FolderRow,
  type NavKey,
  flattenFolders,
  folderLook,
  isValidFolderMove,
  navigate,
  plainText,
  pushRecent,
  recentOf,
  recentToShow,
} from "../model/folder-tree";
import { toggleStar } from "../model/favorites";
import { type FolderStyles, cleanName, movedPath, withFolderStyle } from "../model/library-style";
import { errorMessage } from "../util/errors";
import { ConfirmModal } from "../ui/confirm-modal";
import { DialogKeyboard } from "./dialog-keyboard";
import { FolderColorModal, type MenuPoint, hideFolderMenu, showFolderMenu } from "./folders-menu";
import { attachFolderTouchDrag } from "./folders-touch-drag";
import { RenameModal } from "./rename-modal";

/** What the sidebar needs from the plugin. */
export interface FoldersHost {
  stars(): readonly string[];
  setStars(stars: string[]): void;
  folderStyles(): FolderStyles;
  setFolderStyles(styles: FolderStyles): void;
  /** The user's recent custom colours, and a new one to remember. */
  recentColors(): readonly string[];
  addRecentColor(color: string): void;
  /** Show the folder in the notebook library ("" the whole vault). */
  openFolder(path: string): void;
  /** Called when stars or folder looks change elsewhere; returns what stops it. */
  onChange(listener: () => void): () => void;
}

/** Per-device memory: which folders are open and which were opened last. */
const EXPANDED_KEY = "finenotes-folders-expanded";
const RECENT_KEY = "finenotes-folders-recent";

/** A folder in the order it is listed, with the notes in it counted. */
interface Tree {
  roots: FolderNode[];
  counts: Map<string, number>;
}

export class FoldersSidebarView extends ItemView {
  private pane!: HTMLElement;
  private listEl!: HTMLElement;
  private filterInput!: HTMLInputElement;
  private editToggle!: HTMLElement;
  private filter = "";
  private expanded = new Set<string>();
  private recent: string[] = [];
  private selected = "";
  private editMode = false;
  private creating: { parent: string } | null = null;
  /** An inline field is open: the list is not redrawn under it. */
  private typing = false;
  private rows: FolderRow[] = [];
  private dragPath: string | null = null;
  private pendingFocus: string | null = null;
  private readonly collapsedSections = new Set<string>();
  private keyboard!: DialogKeyboard;
  private readonly redraw = debounce(() => this.render(), 150, true);

  constructor(
    leaf: WorkspaceLeaf,
    private readonly host: FoldersHost,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_FOLDERS;
  }

  getDisplayText(): string {
    return t("notebooks.folders.title");
  }

  override getIcon(): string {
    return "folder";
  }

  override async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("goodobsidian-folders");
    this.pane = root;
    // The list rises above the iPad keyboard while a field in it has focus.
    this.keyboard = new DialogKeyboard(root, { pad: true });
    this.expanded = new Set(recentOf(this.read(EXPANDED_KEY)));
    this.recent = recentOf(this.read(RECENT_KEY));

    const head = root.createDiv({ cls: "goodobsidian-folders-head" });
    head.setAttribute("data-drop-path", "");
    head.createSpan({ cls: "goodobsidian-folders-title", text: t("notebooks.folders.title") });
    const tools = head.createDiv({ cls: "goodobsidian-folders-tools" });
    this.tool(tools, "chevrons-down-up", t("notebooks.folders.collapseAll"), () =>
      this.collapseAll(),
    );
    this.tool(tools, "folder-plus", t("notebooks.folders.newFolder"), () => this.startCreate(""));
    this.editToggle = this.tool(tools, "pencil", t("notebooks.folders.edit"), () =>
      this.setEditMode(!this.editMode),
    );

    const filterWrap = root.createDiv({ cls: "goodobsidian-folders-filter" });
    setIcon(filterWrap.createSpan({ cls: "goodobsidian-folders-filter-icon" }), "search");
    this.filterInput = filterWrap.createEl("input", {
      type: "text",
      cls: "goodobsidian-folders-filter-input",
      attr: {
        placeholder: t("notebooks.folders.filter"),
        "aria-label": t("notebooks.folders.filter"),
        enterkeyhint: "search",
      },
    });
    this.keyboard.watch(this.filterInput, filterWrap);
    this.filterInput.addEventListener("input", () => {
      this.filter = this.filterInput.value;
      this.render();
    });
    this.filterInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.filter !== "") {
        e.preventDefault();
        this.setFilter("");
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        this.listEl.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
      }
    });
    const clear = this.tool(filterWrap, "x", t("notebooks.folders.filterClear"), () => {
      this.setFilter("");
      this.filterInput.focus();
    });
    clear.addClass("goodobsidian-folders-filter-clear");

    this.listEl = root.createDiv({
      cls: "goodobsidian-folders-list",
      attr: { role: "tree", "aria-label": t("notebooks.folders.treeLabel") },
    });
    // Dropping on empty space moves a folder to the top of the vault.
    this.listEl.setAttribute("data-drop-path", "");
    this.registerDomEvent(this.listEl, "keydown", (e) => this.onKey(e));
    this.attachRootDrop(head);
    this.attachRootDrop(this.listEl);

    this.registerEvent(this.app.vault.on("create", () => this.redraw()));
    this.registerEvent(this.app.vault.on("delete", () => this.redraw()));
    this.registerEvent(
      this.app.vault.on("rename", (file, from) => {
        if (file instanceof TFolder) this.followRename(from, file.path);
        this.redraw();
      }),
    );
    this.register(this.host.onChange(() => this.redraw()));
    this.render();
  }

  override async onClose(): Promise<void> {
    this.keyboard.end();
    hideFolderMenu();
    this.contentEl.empty();
  }

  /** A folder was renamed or moved: the paths remembered here follow it. */
  private followRename(from: string, to: string): void {
    this.expanded = new Set([...this.expanded].map((p) => movedPath(p, from, to)));
    this.recent = this.recent.map((p) => movedPath(p, from, to));
    this.selected = movedPath(this.selected, from, to);
    this.save();
  }

  // --- Memory on this device ---------------------------------------------------

  private read(key: string): unknown {
    try {
      const raw: unknown = this.app.loadLocalStorage(key);
      return typeof raw === "string" ? (JSON.parse(raw) as unknown) : [];
    } catch {
      return [];
    }
  }

  private save(): void {
    this.app.saveLocalStorage(EXPANDED_KEY, JSON.stringify([...this.expanded]));
    this.app.saveLocalStorage(RECENT_KEY, JSON.stringify(this.recent));
  }

  // --- Drawing ------------------------------------------------------------------

  private tool(parent: HTMLElement, icon: string, label: string, run: () => void): HTMLElement {
    const button = parent.createEl("button", {
      cls: "clickable-icon goodobsidian-folders-tool",
      attr: { "aria-label": label },
    });
    setIcon(button, icon);
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      run();
    });
    return button;
  }

  private setFilter(text: string): void {
    this.filter = text;
    this.filterInput.value = text;
    this.render();
  }

  private setEditMode(on: boolean): void {
    this.editMode = on;
    this.pane.toggleClass("is-editing", on);
    this.editToggle.setAttribute("aria-pressed", String(on));
    this.editToggle.setAttribute("aria-label", on ? t("common.done") : t("notebooks.folders.edit"));
    setIcon(this.editToggle, on ? "check" : "pencil");
  }

  /** The vault's folders in listing order, and how many notes each holds. */
  private tree(): Tree {
    const counts = new Map<string, number>();
    const build = (folder: TFolder): FolderNode[] => {
      const subfolders = folder.children
        .filter((c): c is TFolder => c instanceof TFolder && !c.name.startsWith("."))
        .sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
        );
      return subfolders.map((f) => ({ path: f.path, name: f.name, children: build(f) }));
    };
    const count = (folder: TFolder): number => {
      let n = 0;
      for (const child of folder.children) {
        if (child.name.startsWith(".")) continue;
        if (child instanceof TFile) n += child.extension === "md" ? 1 : 0;
        else if (child instanceof TFolder) n += count(child);
      }
      counts.set(folder.path, n);
      return n;
    };
    count(this.app.vault.getRoot());
    return { roots: build(this.app.vault.getRoot()), counts };
  }

  private render(): void {
    if (this.typing || !this.listEl) return;
    const keep = this.listEl.scrollTop;
    this.listEl.empty();
    const { roots, counts } = this.tree();
    const filter = this.filter.trim();
    const styles = this.host.folderStyles();
    const stars = this.host.stars();
    const exists = (path: string): boolean =>
      this.app.vault.getAbstractFileByPath(path) instanceof TFolder;

    this.rows = flattenFolders(roots, { isExpanded: (p) => this.expanded.has(p), filter });
    if (filter === "") {
      const starred = stars.filter(exists);
      const recent = recentToShow(this.recent, exists, new Set(starred));
      for (const [key, label, paths] of [
        ["starred", t("notebooks.folders.sectionStarred"), starred],
        ["recent", t("notebooks.folders.sectionRecent"), recent],
      ] as const) {
        if (paths.length === 0) continue;
        this.label(label, key);
        if (this.collapsedSections.has(key)) continue;
        for (const path of paths) {
          const name = path.slice(path.lastIndexOf("/") + 1);
          this.drawRow(
            { path, name, depth: 0, hasChildren: false, expanded: false },
            counts,
            styles,
            true,
          );
        }
      }
      if (starred.length > 0 || recent.length > 0)
        this.label(t("notebooks.folders.sectionAll"), "all");
    }
    if (!this.collapsedSections.has("all") || filter !== "") {
      if (this.creating?.parent === "") this.drawCreateRow(0);
      for (const row of this.rows) {
        this.drawRow(row, counts, styles, false, filter);
        if (this.creating?.parent === row.path) this.drawCreateRow(row.depth + 1);
      }
    }
    if (!this.listEl.querySelector(".goodobsidian-folders-row")) {
      this.listEl.createDiv({
        cls: "goodobsidian-folders-empty",
        text: filter === "" ? t("notebooks.folders.empty") : t("notebooks.folders.noMatch"),
      });
    }
    this.listEl.scrollTop = keep;
    this.settleFocus();
  }

  /** One tab stop in the list, and the keyboard's focus put back after a redraw. */
  private settleFocus(): void {
    const rows = Array.from(
      this.listEl.querySelectorAll<HTMLElement>(".goodobsidian-folders-row[data-path]"),
    );
    const stop = rows.find((r) => r.hasClass("is-selected") && !r.hasClass("is-quick")) ?? rows[0];
    for (const r of rows) r.setAttribute("tabindex", r === stop ? "0" : "-1");
    if (this.pendingFocus === null) return;
    const want = this.pendingFocus;
    this.pendingFocus = null;
    rows.find((r) => r.getAttribute("data-path") === want && !r.hasClass("is-quick"))?.focus();
  }

  private label(text: string, key: string): void {
    const collapsed = this.collapsedSections.has(key);
    const label = this.listEl.createDiv({
      cls: ["goodobsidian-folders-label", collapsed ? "is-collapsed" : "is-open"],
      attr: { role: "button", tabindex: "0", "aria-expanded": String(!collapsed) },
    });
    setIcon(label.createSpan({ cls: "goodobsidian-folders-label-chevron" }), "chevron-down");
    label.createSpan({ text });
    const toggle = (): void => {
      if (!this.collapsedSections.delete(key)) this.collapsedSections.add(key);
      this.render();
    };
    label.addEventListener("click", toggle);
    label.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      toggle();
    });
  }

  private drawRow(
    row: FolderRow,
    counts: ReadonlyMap<string, number>,
    styles: FolderStyles,
    quick: boolean,
    filter = "",
  ): void {
    const el = this.listEl.createDiv({
      cls: ["goodobsidian-folders-row", quick ? "is-quick" : "is-tree"],
      attr: {
        role: "treeitem",
        "data-path": row.path,
        "data-drop-path": row.path,
        "aria-level": String(row.depth + 1),
        "aria-selected": String(this.selected === row.path),
        tabindex: "-1",
      },
    });
    if (row.hasChildren) el.setAttribute("aria-expanded", String(row.expanded));
    if (this.selected === row.path) el.addClass("is-selected");
    el.setCssProps({ "--goodobsidian-folders-depth": String(quick ? 0 : row.depth) });
    const look = folderLook(styles, row.path);
    el.setCssProps({ "--goodobsidian-folders-color": look.color });
    const content = el.createDiv({ cls: "goodobsidian-folders-row-content" });
    if (!quick) {
      const slot = content.createSpan({ cls: "goodobsidian-folders-chevron-slot" });
      if (row.hasChildren) {
        const chevron = slot.createSpan({
          cls: ["goodobsidian-folders-chevron", row.expanded ? "is-open" : "is-closed"],
        });
        setIcon(chevron, "chevron-right");
        if (filter === "") {
          chevron.addEventListener("click", (e) => {
            e.stopPropagation();
            this.toggleOpen(row.path);
          });
        }
      }
    }
    setIcon(content.createSpan({ cls: "goodobsidian-folders-glyph" }), look.icon);
    this.drawName(content, row.name, filter);
    const count = counts.get(row.path) ?? 0;
    if (count > 0) {
      content.createSpan({
        cls: "goodobsidian-folders-count",
        text: String(count),
        attr: { "aria-label": tn("notebooks.folders.noteCount", count) },
      });
    }
    const more = el.createEl("button", {
      cls: "clickable-icon goodobsidian-folders-more",
      attr: { "aria-label": t("notebooks.folders.options") },
    });
    setIcon(more, "more-horizontal");
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      const rect = more.getBoundingClientRect();
      this.menu(row.path, { x: rect.left, y: rect.bottom + 4 });
    });

    el.addEventListener("click", () => this.open(row.path));
    this.wireDrag(el, row.path);
  }

  /** The folder's name with the typed filter marked. */
  private drawName(parent: HTMLElement, name: string, filter: string): void {
    const title = parent.createSpan({ cls: "goodobsidian-folders-name" });
    const wanted = plainText(filter.trim());
    const at = wanted === "" ? -1 : plainText(name).indexOf(wanted);
    // Accents can change the text's length once removed, so a mark is drawn only when the lengths agree.
    if (at >= 0 && plainText(name).length === name.length) {
      title.appendText(name.slice(0, at));
      title.createEl("mark", { text: name.slice(at, at + wanted.length) });
      title.appendText(name.slice(at + wanted.length));
    } else {
      title.setText(name);
    }
  }

  private drawCreateRow(depth: number): void {
    const el = this.listEl.createDiv({ cls: ["goodobsidian-folders-row", "is-creating"] });
    el.setCssProps({ "--goodobsidian-folders-depth": String(depth) });
    const content = el.createDiv({ cls: "goodobsidian-folders-row-content" });
    content.createSpan({ cls: "goodobsidian-folders-chevron-slot" });
    setIcon(content.createSpan({ cls: "goodobsidian-folders-glyph" }), "folder");
    const input = content.createEl("input", {
      type: "text",
      cls: "goodobsidian-folders-create-input",
      attr: {
        placeholder: t("notebooks.folders.newFolder"),
        "aria-label": t("notebooks.folders.newFolderName"),
        enterkeyhint: "done",
      },
    });
    this.keyboard.watch(input, el);
    let done = false;
    const finish = (commit: boolean): void => {
      if (done) return;
      done = true;
      const parent = this.creating?.parent ?? "";
      this.creating = null;
      this.typing = false;
      this.keyboard.end();
      const name = cleanName(input.value);
      this.render();
      if (commit && name !== "") void this.createFolder(parent, name);
    };
    input.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
    this.typing = true;
    input.focus();
  }

  // --- Actions ------------------------------------------------------------------

  private collapseAll(): void {
    this.expanded.clear();
    this.save();
    this.render();
  }

  private toggleOpen(path: string): void {
    if (!this.expanded.delete(path)) this.expanded.add(path);
    this.save();
    this.render();
  }

  private open(path: string): void {
    this.selected = path;
    this.recent = pushRecent(this.recent, path);
    this.save();
    this.render();
    this.host.openFolder(path);
    // On a phone or tablet the sidebar is a drawer: put it away once a folder is chosen.
    if (Platform.isMobile) this.app.workspace.leftSplit.collapse();
  }

  private startCreate(parent: string): void {
    hideFolderMenu();
    if (this.filter !== "") this.setFilter("");
    this.collapsedSections.delete("all");
    if (parent !== "") this.expanded.add(parent);
    this.creating = { parent };
    this.typing = false;
    this.render();
  }

  private async createFolder(parent: string, name: string): Promise<void> {
    const path = normalizePath(parent === "" ? name : `${parent}/${name}`);
    try {
      await this.app.vault.createFolder(path);
      this.open(path);
    } catch (error) {
      new Notice(t("notebooks.folders.createFailed", { reason: errorMessage(error) }));
    }
  }

  private menu(path: string, at: MouseEvent | MenuPoint): void {
    const folder = this.app.vault.getAbstractFileByPath(path);
    if (!(folder instanceof TFolder)) return;
    showFolderMenu(this.app, this.leaf, folder, at, {
      starred: this.host.stars().includes(path),
      rename: () => this.renameFolder(folder),
      newSubfolder: () => this.startCreate(path),
      toggleStar: () => this.host.setStars(toggleStar(this.host.stars(), path)),
      chooseColor: () => this.chooseColor(folder),
      remove: () => void this.deleteFolder(folder),
    });
  }

  private renameFolder(folder: TFolder): void {
    new RenameModal(
      this.app,
      folder.name,
      (raw) => {
        const name = cleanName(raw);
        if (name === "" || name === folder.name) return;
        const parent = folder.parent && !folder.parent.isRoot() ? folder.parent.path : "";
        const target = normalizePath(parent === "" ? name : `${parent}/${name}`);
        this.app.fileManager.renameFile(folder, target).catch((error: unknown) => {
          new Notice(
            t("notebooks.folders.moveFailed", { name: folder.name, reason: errorMessage(error) }),
          );
        });
      },
      t("notebooks.folders.renameTitle"),
    ).open();
  }

  private async deleteFolder(folder: TFolder): Promise<void> {
    const yes = await ConfirmModal.confirm(this.app, {
      title: t("notebooks.folders.deleteTitle"),
      message: t("notebooks.folders.deleteBody", { name: folder.name }),
      cta: t("common.delete"),
      warning: true,
    });
    if (!yes) return;
    try {
      await this.app.fileManager.trashFile(folder);
    } catch (error) {
      new Notice(
        t("notebooks.folders.moveFailed", { name: folder.name, reason: errorMessage(error) }),
      );
    }
  }

  private chooseColor(folder: TFolder): void {
    const current = this.host.folderStyles()[folder.path]?.color ?? null;
    new FolderColorModal(
      this.app,
      folder.name,
      current,
      this.host.recentColors(),
      (color) =>
        this.host.setFolderStyles(
          withFolderStyle(this.host.folderStyles(), folder.path, { color: color ?? undefined }),
        ),
      (color) => this.host.addRecentColor(color),
    ).open();
  }

  /** Move a folder into another ("" the top of the vault). */
  private async moveFolder(from: string, to: string): Promise<void> {
    const item = this.app.vault.getAbstractFileByPath(from);
    if (!(item instanceof TFolder) || !isValidFolderMove(from, to)) return;
    const target = normalizePath(to === "" ? item.name : `${to}/${item.name}`);
    if (this.app.vault.getAbstractFileByPath(target)) {
      new Notice(t("notebooks.folders.exists", { name: item.name }));
      return;
    }
    try {
      await this.app.fileManager.renameFile(item, target);
      if (to !== "") this.expanded.add(to);
      this.save();
    } catch (error) {
      new Notice(
        t("notebooks.folders.moveFailed", { name: item.name, reason: errorMessage(error) }),
      );
    }
  }

  // --- Keyboard, mouse and touch -------------------------------------------------

  private onKey(e: KeyboardEvent): void {
    const target = e.target;
    if (!(target instanceof HTMLElement) || !target.hasClass("goodobsidian-folders-row")) return;
    const path = target.getAttribute("data-path") ?? "";
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      this.open(path);
      return;
    }
    if (e.key === "F2") {
      const folder = this.app.vault.getAbstractFileByPath(path);
      if (folder instanceof TFolder) {
        e.preventDefault();
        this.renameFolder(folder);
      }
      return;
    }
    const keys: readonly string[] = [
      "ArrowDown",
      "ArrowUp",
      "Home",
      "End",
      "ArrowRight",
      "ArrowLeft",
    ];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const move = navigate(this.rows, path, e.key as NavKey, this.filter.trim() !== "");
    if (move.kind === "focus") {
      this.pendingFocus = move.path;
      this.settleFocus();
    } else if (move.kind === "expand" || move.kind === "collapse") {
      this.pendingFocus = move.path;
      this.toggleOpen(move.path);
    }
  }

  /** Mouse: menu on right-click, drag and drop. Touch: hold, then menu or drag. */
  private wireDrag(el: HTMLElement, path: string): void {
    if (Platform.isMobile) {
      attachFolderTouchDrag(el, {
        path,
        list: () => this.listEl,
        onMenu: (point) => this.menu(path, point),
        canDrop: (from, to) => isValidFolderMove(from, to),
        onDrop: (from, to) => void this.moveFolder(from, to),
        onHoverExpand: (p) => {
          if (this.expanded.has(p)) return;
          this.expanded.add(p);
          this.save();
          this.render();
        },
      });
      return;
    }
    el.draggable = true;
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.menu(path, e);
    });
    el.addEventListener("dragstart", (e) => {
      this.dragPath = path;
      e.dataTransfer?.setData("text/plain", path);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    el.addEventListener("dragend", () => {
      this.dragPath = null;
      this.clearDropTargets();
    });
    el.addEventListener("dragover", (e) => {
      if (this.dragPath === null || !isValidFolderMove(this.dragPath, path)) return;
      e.preventDefault();
      e.stopPropagation();
      el.addClass("is-drop-target");
    });
    el.addEventListener("dragleave", () => el.removeClass("is-drop-target"));
    el.addEventListener("drop", (e) => {
      if (this.dragPath === null) return;
      e.preventDefault();
      e.stopPropagation();
      const from = this.dragPath;
      this.clearDropTargets();
      void this.moveFolder(from, path);
    });
  }

  /** The header and the empty part of the list take a dropped folder to the top of the vault. */
  private attachRootDrop(el: HTMLElement): void {
    this.registerDomEvent(el, "dragover", (e) => {
      if (this.dragPath === null || !isValidFolderMove(this.dragPath, "")) return;
      e.preventDefault();
      this.listEl.addClass("is-drop-target");
    });
    this.registerDomEvent(el, "dragleave", () => this.listEl.removeClass("is-drop-target"));
    this.registerDomEvent(el, "drop", (e) => {
      if (this.dragPath === null) return;
      e.preventDefault();
      const from = this.dragPath;
      this.clearDropTargets();
      void this.moveFolder(from, "");
    });
  }

  private clearDropTargets(): void {
    this.pane.querySelectorAll(".is-drop-target").forEach((el) => el.removeClass("is-drop-target"));
  }
}
