import { describe, expect, it } from "vitest";
import { isDuplicateFolderItem } from "../../src/model/folder-menu-filter";

describe("isDuplicateFolderItem", () => {
  it("catches Obsidian's own Rename and Delete", () => {
    for (const title of ["Rename", "rename…", "Rename...", " Delete ", "DELETE"]) {
      expect(isDuplicateFolderItem(title)).toBe(true);
    }
  });

  it("keeps other plugins' items", () => {
    for (const title of ["Delete pages…", "Move folder to…", "Bookmark…", "New notebook", ""]) {
      expect(isDuplicateFolderItem(title)).toBe(false);
    }
  });
});
