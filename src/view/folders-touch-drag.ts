/**
 * Touch drag for the Folders sidebar on an iPad or phone: hold a folder about
 * 0.4 s to lift it, then lift the finger to open its menu, or drag it onto
 * another folder. A short hint says which. The rest of the sidebar is
 * scrolled by the hold being cancelled when the finger moves early.
 */

import { type MenuPoint } from "./folders-menu";
import { t } from "../i18n/translate";

const HOLD_MS = 400;
/** Movement before the hold fires that cancels it (the finger is scrolling), px. */
const HOLD_CANCEL_PX = 10;
/** Movement after the hold fired that turns it into a drag, px. */
const DRAG_START_PX = 8;
const SUPPRESS_CLICK_MS = 600;
const HOVER_EXPAND_MS = 700;
const AUTOSCROLL_EDGE_PX = 40;
const AUTOSCROLL_STEP_PX = 10;

export interface TouchDragOptions {
  /** The folder this row stands for. */
  path: string;
  /** The scrolling list, for autoscroll near its edges. */
  list: () => HTMLElement;
  /** The hold was released without moving. */
  onMenu: (point: MenuPoint) => void;
  /** A drop target may take the folder. */
  canDrop: (from: string, to: string) => boolean;
  /** The folder was dropped on `to` ("" the top of the vault). */
  onDrop: (from: string, to: string) => void;
  /** Open a closed folder that is hovered long enough. */
  onHoverExpand: (path: string) => void;
}

interface ActiveDrag {
  options: TouchDragOptions;
  ghost: HTMLElement;
  x: number;
  y: number;
  hover: HTMLElement | null;
  hoverPath: string | null;
  hoverTimer: number;
  raf: number;
}

/** The one drag in progress. */
let active: ActiveDrag | null = null;
let hintEl: HTMLElement | null = null;

function showHint(): void {
  hideHint();
  hintEl = document.body.createDiv({
    cls: "goodobsidian-folders-drag-hint",
    text: t("notebooks.folders.dragHint"),
    attr: { role: "status" },
  });
}

function hideHint(): void {
  hintEl?.remove();
  hintEl = null;
}

/** Wire `row` for hold, menu and drag. */
export function attachFolderTouchDrag(row: HTMLElement, options: TouchDragOptions): void {
  let timer = 0;
  let armed = false;
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let suppressUntil = 0;
  let detach = (): void => undefined;

  const reset = (): void => {
    window.clearTimeout(timer);
    timer = 0;
    armed = false;
    dragging = false;
    row.removeClass("is-lifted");
    hideHint();
  };

  const finish = (commit: boolean): void => {
    const wasArmed = armed;
    const wasDragging = dragging;
    reset();
    detach();
    if (wasDragging) endDrag(commit);
    else if (wasArmed && commit) options.onMenu({ x: startX, y: startY });
  };

  const onMove = (e: TouchEvent): void => {
    const touch = e.touches[0];
    if (!touch) return;
    if (dragging) {
      if (e.cancelable) e.preventDefault();
      moveDrag(touch.clientX, touch.clientY);
      return;
    }
    const distance = Math.hypot(touch.clientX - startX, touch.clientY - startY);
    if (armed) {
      if (e.cancelable) e.preventDefault();
      if (distance > DRAG_START_PX && !active) {
        dragging = true;
        row.removeClass("is-lifted");
        hideHint();
        beginDrag(options, row, touch.clientX, touch.clientY);
      }
      return;
    }
    if (timer !== 0 && distance > HOLD_CANCEL_PX) {
      window.clearTimeout(timer);
      timer = 0;
    }
  };

  const onEnd = (e: TouchEvent): void => {
    if (e.type === "touchend" && (armed || dragging)) {
      suppressUntil = Date.now() + SUPPRESS_CLICK_MS;
      if (e.cancelable) e.preventDefault();
    }
    finish(e.type === "touchend");
  };

  row.addEventListener(
    "touchstart",
    (e: TouchEvent) => {
      reset();
      const touch = e.touches[0];
      if (e.touches.length !== 1 || !touch || active) return;
      startX = touch.clientX;
      startY = touch.clientY;
      // The document hears the gesture too: iOS keeps sending it to a row that a redraw removed.
      detach();
      const move = (ev: TouchEvent): void => onMove(ev);
      const end = (ev: TouchEvent): void => onEnd(ev);
      document.addEventListener("touchmove", move, { passive: false });
      document.addEventListener("touchend", end);
      document.addEventListener("touchcancel", end);
      detach = (): void => {
        document.removeEventListener("touchmove", move);
        document.removeEventListener("touchend", end);
        document.removeEventListener("touchcancel", end);
        detach = (): void => undefined;
      };
      timer = window.setTimeout(() => {
        timer = 0;
        armed = true;
        row.addClass("is-lifted");
        showHint();
      }, HOLD_MS);
    },
    { passive: true },
  );
  // The click that follows a hold must not open the folder.
  row.addEventListener(
    "click",
    (e: MouseEvent) => {
      if (Date.now() < suppressUntil) {
        e.preventDefault();
        e.stopImmediatePropagation();
        suppressUntil = 0;
      }
    },
    true,
  );
}

function beginDrag(options: TouchDragOptions, source: HTMLElement, x: number, y: number): void {
  const rect = source.getBoundingClientRect();
  const ghost = source.cloneNode(true) as HTMLElement;
  ghost.removeClass("is-lifted");
  ghost.addClass("goodobsidian-folders-ghost");
  ghost.setCssProps({ "--goodobsidian-ghost-width": `${rect.width}px` });
  document.body.appendChild(ghost);
  const drag: ActiveDrag = {
    options,
    ghost,
    x,
    y,
    hover: null,
    hoverPath: null,
    hoverTimer: 0,
    raf: 0,
  };
  active = drag;
  placeGhost(drag);
  const tick = (): void => {
    if (active !== drag) return;
    autoScroll(drag);
    // The list may have scrolled or redrawn under a still finger.
    updateHover(drag);
    drag.raf = window.requestAnimationFrame(tick);
  };
  drag.raf = window.requestAnimationFrame(tick);
  updateHover(drag);
}

function moveDrag(x: number, y: number): void {
  if (!active) return;
  active.x = x;
  active.y = y;
  placeGhost(active);
  updateHover(active);
}

function placeGhost(drag: ActiveDrag): void {
  drag.ghost.setCssProps({
    "--goodobsidian-ghost-x": `${drag.x}px`,
    "--goodobsidian-ghost-y": `${drag.y}px`,
  });
}

function updateHover(drag: ActiveDrag): void {
  const hit = document.elementFromPoint(drag.x, drag.y);
  const zone = hit instanceof Element ? hit.closest<HTMLElement>("[data-drop-path]") : null;
  let path: string | null = null;
  let highlight: HTMLElement | null = null;
  if (zone) {
    const to = zone.getAttribute("data-drop-path") ?? "";
    if (drag.options.canDrop(drag.options.path, to)) {
      path = to;
      highlight = zone;
    }
  }
  if (highlight !== drag.hover) {
    drag.hover?.removeClass("is-drop-target");
    highlight?.addClass("is-drop-target");
    drag.hover = highlight;
  }
  if (path !== drag.hoverPath) {
    drag.hoverPath = path;
    window.clearTimeout(drag.hoverTimer);
    drag.hoverTimer = 0;
    if (path !== null && path !== "") {
      const target = path;
      drag.hoverTimer = window.setTimeout(() => {
        drag.hoverTimer = 0;
        if (active === drag && drag.hoverPath === target) {
          drag.options.onHoverExpand(target);
          drag.hover = null;
        }
      }, HOVER_EXPAND_MS);
    }
  }
}

function autoScroll(drag: ActiveDrag): void {
  const list = drag.options.list();
  const rect = list.getBoundingClientRect();
  if (drag.x < rect.left || drag.x > rect.right) return;
  if (drag.y < rect.top + AUTOSCROLL_EDGE_PX && drag.y >= rect.top - AUTOSCROLL_EDGE_PX) {
    list.scrollTop -= AUTOSCROLL_STEP_PX;
  } else if (
    drag.y > rect.bottom - AUTOSCROLL_EDGE_PX &&
    drag.y <= rect.bottom + AUTOSCROLL_EDGE_PX
  ) {
    list.scrollTop += AUTOSCROLL_STEP_PX;
  }
}

function endDrag(commit: boolean): void {
  const drag = active;
  if (!drag) return;
  active = null;
  window.cancelAnimationFrame(drag.raf);
  window.clearTimeout(drag.hoverTimer);
  drag.ghost.remove();
  document.querySelectorAll(".is-drop-target").forEach((el) => el.removeClass("is-drop-target"));
  const to = commit ? drag.hoverPath : null;
  if (to !== null) drag.options.onDrop(drag.options.path, to);
}
