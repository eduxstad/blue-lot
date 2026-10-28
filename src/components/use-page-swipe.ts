import { useEffect, useRef, type RefObject } from "react";
import {
  classifyAxis,
  pageAfterSwipe,
  resistedDrag,
  SWIPE_AXIS_SLOP,
  swipeDirection,
  swipeTargetBlocked,
  type SwipeDirection,
} from "./page-swipe";

/** Same cutoff as the `md` dock: the bottom nav is the page list below 768px. */
const MOBILE_PAGE_QUERY = "(max-width: 767px)";

function touchPagesActive(): boolean {
  if (typeof window.matchMedia !== "function") return true;
  return window.matchMedia(MOBILE_PAGE_QUERY).matches;
}

function reducedMotion(): boolean {
  if (typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function fromScreenEdge(clientX: number): boolean {
  const width = window.innerWidth;
  if (width < 120) return false;
  const edge = 28;
  return clientX <= edge || clientX >= width - edge;
}

/**
 * Touch swipe between `pages` on the mobile layout.
 * Vertical drags are left to the browser. Mouse clicks are ignored.
 */
export function usePageSwipe<T>({
  pages,
  page,
  enabled,
  onPage,
}: {
  pages: readonly T[];
  page: T;
  enabled: boolean;
  onPage: (next: T, direction: SwipeDirection) => void;
}): {
  shellRef: RefObject<HTMLDivElement | null>;
  boardRef: RefObject<HTMLDivElement | null>;
} {
  const shellRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef(page);
  const pagesRef = useRef(pages);
  const enabledRef = useRef(enabled);
  const onPageRef = useRef(onPage);
  pageRef.current = page;
  pagesRef.current = pages;
  enabledRef.current = enabled;
  onPageRef.current = onPage;

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;

    type Gesture = {
      id: number;
      x: number;
      y: number;
      dx: number;
      dy: number;
      axis: "h" | "v" | null;
    };

    let gesture: Gesture | null = null;
    let suppressClick = false;

    function paint(dx: number) {
      const board = boardRef.current;
      if (!board || reducedMotion()) return;
      const index = pagesRef.current.indexOf(pageRef.current);
      const px = resistedDrag(dx, index <= 0, index === pagesRef.current.length - 1);
      board.style.transition = "none";
      board.style.transform = `translate3d(${px}px,0,0)`;
    }

    function releaseDrag(animateBack: boolean) {
      const board = boardRef.current;
      if (!board) return;
      if (animateBack && !reducedMotion()) {
        board.style.transition = "transform 180ms ease-out";
        board.style.transform = "translate3d(0,0,0)";
        return;
      }
      board.style.transition = "";
      board.style.transform = "";
    }

    function onPointerDown(event: PointerEvent) {
      if (event.isPrimary === false) return;
      if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
      if (!enabledRef.current || !touchPagesActive()) return;
      if (swipeTargetBlocked(event.target)) return;
      if (fromScreenEdge(event.clientX)) return;
      gesture = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        dx: 0,
        dy: 0,
        axis: null,
      };
    }

    function onPointerMove(event: PointerEvent) {
      if (!gesture || event.pointerId !== gesture.id) return;
      gesture.dx = event.clientX - gesture.x;
      gesture.dy = event.clientY - gesture.y;
      if (!gesture.axis) {
        const axis = classifyAxis(gesture.dx, gesture.dy);
        if (!axis) return;
        gesture.axis = axis;
        if (axis === "h") {
          try {
            shellRef.current?.setPointerCapture(event.pointerId);
          } catch {
            /* detached nodes and jsdom */
          }
        }
      }
      if (gesture.axis === "h") paint(gesture.dx);
    }

    function finish(event: PointerEvent, cancelled: boolean) {
      if (!gesture || event.pointerId !== gesture.id) return;
      const finished = gesture;
      gesture = null;
      if (!cancelled) {
        finished.dx = event.clientX - finished.x;
        finished.dy = event.clientY - finished.y;
        if (!finished.axis) finished.axis = classifyAxis(finished.dx, finished.dy);
      }
      if (finished.axis !== "h") return;
      if (Math.abs(finished.dx) >= SWIPE_AXIS_SLOP) {
        suppressClick = true;
        // The gesture's click is dispatched after pointerup, before microtasks.
        queueMicrotask(() => {
          suppressClick = false;
        });
      }
      if (cancelled) {
        releaseDrag(true);
        return;
      }
      const direction = swipeDirection(finished.dx, finished.dy, finished.axis);
      const next = direction ? pageAfterSwipe(pagesRef.current, pageRef.current, direction) : null;
      if (!direction || next == null) {
        releaseDrag(true);
        return;
      }
      releaseDrag(false);
      onPageRef.current(next, direction);
    }

    function onTouchMove(event: TouchEvent) {
      if (gesture?.axis === "h" && event.cancelable) event.preventDefault();
    }

    function onClick(event: MouseEvent) {
      if (!suppressClick) return;
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
    }

    function onPointerUp(event: PointerEvent) {
      finish(event, false);
    }

    function onPointerCancel(event: PointerEvent) {
      finish(event, true);
    }

    shell.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    shell.addEventListener("touchmove", onTouchMove, { passive: false });
    shell.addEventListener("click", onClick, true);

    return () => {
      shell.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      shell.removeEventListener("touchmove", onTouchMove);
      shell.removeEventListener("click", onClick, true);
    };
  }, []);

  return { shellRef, boardRef };
}
