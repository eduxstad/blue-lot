/** Horizontal paging for the mobile stall filters. Order is the caller's. */

export const SWIPE_AXIS_SLOP = 12;
export const SWIPE_MIN_DISTANCE = 64;
/** |dx| must exceed |dy| by this factor before a drag counts as a page change. */
export const SWIPE_DOMINANCE = 1.5;

export type SwipeAxis = "h" | "v";
export type SwipeDirection = "next" | "prev";

export function classifyAxis(dx: number, dy: number): SwipeAxis | null {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < SWIPE_AXIS_SLOP && ay < SWIPE_AXIS_SLOP) return null;
  if (ax >= SWIPE_AXIS_SLOP && ax > ay * SWIPE_DOMINANCE) return "h";
  return "v";
}

export function swipeDirection(
  dx: number,
  dy: number,
  axis: SwipeAxis | null,
): SwipeDirection | null {
  if (axis !== "h") return null;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < SWIPE_MIN_DISTANCE) return null;
  if (ax <= ay * SWIPE_DOMINANCE) return null;
  return dx < 0 ? "next" : "prev";
}

/**
 * Move one step along `pages`. A view that is not in the list (desktop "All")
 * enters at the first page when swiping forward, and stays put otherwise.
 */
export function pageAfterSwipe<T>(
  pages: readonly T[],
  current: T,
  direction: SwipeDirection,
): T | null {
  if (pages.length === 0) return null;
  const index = pages.indexOf(current);
  if (index < 0) return direction === "next" ? (pages[0] ?? null) : null;
  const next = index + (direction === "next" ? 1 : -1);
  if (next < 0 || next >= pages.length) return null;
  return pages[next] ?? null;
}

/** Damped follow so a drag hints at the next page without uncovering a blank gap. */
export function resistedDrag(dx: number, atStart: boolean, atEnd: boolean): number {
  const pastEdge = (atStart && dx > 0) || (atEnd && dx < 0);
  const scaled = pastEdge ? dx * 0.22 : dx * 0.34;
  const cap = pastEdge ? 36 : 72;
  return Math.max(-cap, Math.min(cap, scaled));
}

const BLOCKED = "input, textarea, select, a, [role='dialog'], [data-swipe-ignore]";

export function swipeTargetBlocked(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(BLOCKED));
}
