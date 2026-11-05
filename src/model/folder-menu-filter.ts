/**
 * The folder menu starts with FineNotes' own items (Rename, Delete, ...) and
 * then lets Obsidian and other plugins add theirs. Obsidian's own Rename and
 * Delete would only repeat ours, so they are left out; anything else, such as
 * another plugin's "Delete pages…", stays.
 */

/** Whether a menu item's title is Obsidian's plain Rename or Delete (English; other languages keep both). */
export function isDuplicateFolderItem(title: string): boolean {
  return /^(rename|delete)(…|\.\.\.)?$/i.test(title.trim());
}
