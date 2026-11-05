/**
 * The menu of a folder in the Folders sidebar, and its colour dialog. The
 * menu starts with FineNotes' own items; Obsidian and other plugins add theirs
 * through the `file-menu` event, as they do in the file explorer. Obsidian's
 * own Rename and Delete are taken out again: ours do the same on the sidebar.
 */

import { type App, Menu, Modal, type TFolder, type WorkspaceLeaf } from "obsidian";
import { t } from "../i18n/translate";
import { isDuplicateFolderItem } from "../model/folder-menu-filter";
import { FOLDER_COLORS } from "../model/library-style";
import { renderColorPicker } from "./color-picker";

/** Where a menu opens when it was not opened by a mouse. */
export interface MenuPoint {
  x: number;
  y: number;
}

/** What the menu's own items do. */
export interface FolderMenuActions {
  starred: boolean;
  rename: () => void;
  newSubfolder: () => void;
  toggleStar: () => void;
  chooseColor: () => void;
  remove: () => void;
}

/** The menu on screen: opening another closes it, so menus never pile up. */
let openMenu: Menu | null = null;

/** What a menu item looks like from here: its row and its title (Obsidian does not type them). */
interface MenuItemShape {
  dom?: HTMLElement;
  titleEl?: HTMLElement;
}

function menuItems(menu: Menu): MenuItemShape[] {
  const raw: unknown = Reflect.get(menu, "items");
  return Array.isArray(raw) ? (raw as MenuItemShape[]) : [];
}

/** Take Obsidian's own Rename and Delete out of `menu`, leaving `ours`. */
function dropNativeDuplicates(menu: Menu, ours: ReadonlySet<unknown>): void {
  const items = menuItems(menu);
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!item || ours.has(item)) continue;
    const title = item.titleEl?.textContent ?? item.dom?.textContent ?? "";
    if (!isDuplicateFolderItem(title)) continue;
    item.dom?.remove();
    items.splice(i, 1);
  }
}

/** Show the menu of `folder` at the mouse event or the point. */
export function showFolderMenu(
  app: App,
  leaf: WorkspaceLeaf,
  folder: TFolder,
  at: MouseEvent | MenuPoint,
  actions: FolderMenuActions,
): void {
  openMenu?.hide();
  const menu = new Menu();
  const ours = new Set<unknown>();
  const add = (title: string, icon: string, run: () => void, warning = false): void => {
    menu.addItem((item) => {
      item.setTitle(title).setIcon(icon).setSection("goodobsidian-folders").onClick(run);
      if (warning) item.setWarning(true);
      ours.add(item);
    });
  };
  add(t("common.rename"), "pencil", actions.rename);
  add(t("notebooks.folders.newSubfolder"), "folder-plus", actions.newSubfolder);
  add(
    actions.starred ? t("notebooks.folders.unstar") : t("notebooks.folders.star"),
    actions.starred ? "star-off" : "star",
    actions.toggleStar,
  );
  add(t("notebooks.folders.color"), "palette", actions.chooseColor);
  add(t("common.delete"), "trash-2", actions.remove, true);
  // Everything else Obsidian and other plugins offer for a folder.
  app.workspace.trigger("file-menu", menu, folder, "file-explorer-context-menu", leaf);
  dropNativeDuplicates(menu, ours);
  menu.onHide(() => {
    if (openMenu === menu) openMenu = null;
  });
  openMenu = menu;
  if (at instanceof MouseEvent) menu.showAtMouseEvent(at);
  else menu.showAtPosition(at);
}

/** Close the menu on screen, if there is one. */
export function hideFolderMenu(): void {
  openMenu?.hide();
  openMenu = null;
}

/** The colour of a folder, chosen with FineNotes' own colour picker: the presets, the user's recent colours, any colour. */
export class FolderColorModal extends Modal {
  constructor(
    app: App,
    private readonly name: string,
    private readonly current: string | null,
    private readonly recent: readonly string[],
    /** A swatch was chosen; `null` for the default look. */
    private readonly onPick: (color: string | null) => void,
    /** A colour made in the picker, to be remembered as recent. */
    private readonly onCustom: (color: string) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("goodobsidian-dialog");
    this.titleEl.setText(t("notebooks.folders.colorTitle", { name: this.name }));
    renderColorPicker(this.contentEl.createDiv(), {
      current: this.current,
      allowNone: true,
      extra: FOLDER_COLORS.map((c) => c.color),
      recent: this.recent,
      onPick: (color) => {
        this.onPick(color);
        this.close();
      },
      onCustom: (color) => {
        this.onCustom(color);
        this.onPick(color);
        this.close();
      },
    });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
