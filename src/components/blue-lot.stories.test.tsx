import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BlueLot } from "./blue-lot";
import { classifyAxis, pageAfterSwipe, swipeDirection, swipeTargetBlocked } from "./page-swipe";
import { LONG_SESSION_SECONDS, type ChargerResult, type Stall } from "@/lib/chargers";

vi.mock("@tanstack/react-start", () => ({
  useServerFn: () => async () => {
    throw new Error("refresh stays off in story tests");
  },
  createServerFn: () => ({
    handler: () => async () => ({ ok: false, error: "unused" }),
  }),
  createIsomorphicFn: () => {
    const api = {
      server: () => api,
      client: () => api,
    };
    return api;
  },
}));

function stall(overrides: Partial<Stall> = {}): Stall {
  return {
    name: "1054",
    floor: 1,
    bank: "A",
    gateway: "KT-SX-1A",
    availability: "open",
    pluggedIn: false,
    amps: 30,
    volts: 220,
    sessionSeconds: null,
    seenAt: Math.floor(Date.now() / 1000) - 2 * 60 * 60,
    portId: "p1",
    ...overrides,
  };
}

function board(stalls: Stall[], live = true): ChargerResult {
  return {
    ok: true,
    snapshot: {
      site: "SpaceX",
      address: "12250 Crenshaw Blvd.",
      city: "Hawthorne",
      state: "California",
      zip: "90250",
      fetchedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      live,
      stalls,
    },
  };
}

const openStall = stall();
const shortBusy = stall({
  name: "1050",
  availability: "busy",
  pluggedIn: true,
  sessionSeconds: 3 * 60 * 60,
});
const longBusy = stall({
  name: "1113",
  floor: 6,
  bank: "B",
  gateway: "KT-SX-6B",
  availability: "busy",
  pluggedIn: true,
  sessionSeconds: 2 * 86400 + 3 * 3600 + 5 * 60,
});
const justOver = stall({
  name: "1129",
  floor: 6,
  bank: "B",
  gateway: "KT-SX-6B",
  availability: "busy",
  pluggedIn: true,
  sessionSeconds: LONG_SESSION_SECONDS + 60,
});
const exactly16 = stall({
  name: "1130",
  floor: 6,
  bank: "B",
  gateway: "KT-SX-6B",
  availability: "busy",
  pluggedIn: true,
  sessionSeconds: LONG_SESSION_SECONDS,
});
const offline = stall({
  name: "1051",
  availability: "offline",
  volts: 0,
  amps: 0,
});

const story = board([openStall, shortBusy, longBusy, justOver, exactly16, offline]);

async function showInUse() {
  const nav = screen.getByRole("navigation", { name: "Stall filters" });
  await userEvent.click(within(nav).getByRole("button", { name: /In use/ }));
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("story: opening the board", () => {
  it("lists open stalls and does not put a live badge in the header", () => {
    render(<BlueLot initial={story} />);
    const header = screen.getByRole("banner");
    expect(within(header).getByRole("heading", { name: "Open stalls" })).toBeTruthy();
    expect(within(header).queryByText(/Live/)).toBeNull();
    expect(within(header).queryByText(/Saved reading/)).toBeNull();
    expect(screen.getByRole("button", { name: /1054/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /1050/ })).toBeNull();
    expect(screen.getByRole("link", { name: "Feedback" }).getAttribute("href")).toBe(
      "mailto:bluelotfeedback@mail.grokbot.com?subject=Blue%20Lot%20feedback",
    );
    expect(screen.getByRole("switch", { name: "Notify when a stall opens" })).toBeTruthy();
  });

  it("says when the reading is a saved copy", () => {
    render(<BlueLot initial={board([openStall], false)} />);
    expect(screen.getByText(/Live feed didn't answer/)).toBeTruthy();
  });
});

describe("story: finding an in-use stall", () => {
  it("themes in-use stalls separately and badges only those past 16 hours", async () => {
    render(<BlueLot initial={story} />);
    await showInUse();

    const longCard = screen.getByRole("button", { name: /1113/ });
    expect(longCard.className).toContain("border-busy");
    expect(longCard.textContent).toContain("In use");
    expect(longCard.textContent).toContain("2d 3h");
    expect(longCard.textContent).not.toContain("2d 3h 5m");
    expect(longCard.querySelector(".lucide-clock")).toBeTruthy();

    const justCard = screen.getByRole("button", { name: /1129/ });
    expect(justCard.querySelector(".lucide-clock")).toBeTruthy();
    expect(justCard.textContent).toContain("16h 1m");

    const exactCard = screen.getByRole("button", { name: /1130/ });
    expect(exactCard.querySelector(".lucide-clock")).toBeNull();

    const shortCard = screen.getByRole("button", { name: /1050/ });
    expect(shortCard.className).toContain("border-busy");
    expect(shortCard.querySelector(".lucide-clock")).toBeNull();

    expect(screen.queryByRole("button", { name: /1054/ })).toBeNull();
    cleanup();
  });

  it("keeps open stalls on the open theme", () => {
    render(<BlueLot initial={story} />);
    const card = screen.getByRole("button", { name: /1054/ });
    expect(card.className).toContain("border-open");
    expect(card.className).not.toContain("border-busy");
  });

  it("shows how long an open stall has been free", async () => {
    const started = Date.now() - (2 * 3600 + 5 * 60) * 1000;
    localStorage.setItem("bluelot-open-since", JSON.stringify({ "1054": started }));
    render(<BlueLot initial={story} />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /1054/ }).textContent).toContain("2h 5m");
    });
  });
});

describe("story: reading a stall", () => {
  it("shows days in the session and toggles last seen to local time", async () => {
    const user = userEvent.setup();
    render(<BlueLot initial={story} />);
    await showInUse();
    await user.click(screen.getByRole("button", { name: /1113/ }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Session").parentElement?.textContent).toContain("2d 3h 5m");
    expect(within(dialog).getByText(/Floor 6\s*·\s*Bank B/)).toBeTruthy();
    expect(within(dialog).getByText("30 A · 6.6 kW")).toBeTruthy();

    const lastSeen = within(dialog).getByRole("button", { name: /Last seen/ });
    expect(lastSeen.textContent).toContain("2h ago");
    await user.click(lastSeen);
    expect(lastSeen.textContent).not.toContain("ago");
    expect(lastSeen.textContent).toMatch(/2026|AM|PM|:/);
    await user.click(lastSeen);
    expect(lastSeen.textContent).toContain("2h ago");
  });
});

describe("story: search and saved stalls", () => {
  it("finds a stall by number across filters", async () => {
    const user = userEvent.setup();
    render(<BlueLot initial={story} />);
    await user.type(screen.getByRole("textbox", { name: "Search stall number" }), "1113");
    expect(screen.getByRole("button", { name: /1113/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /1054/ })).toBeNull();
    cleanup();
  });

  it("keeps a saved stall on the Saved filter", async () => {
    const user = userEvent.setup();
    render(<BlueLot initial={story} />);
    await user.click(screen.getByRole("button", { name: /1054/ }));
    await user.click(screen.getByRole("button", { name: "Save stall" }));
    await user.click(screen.getByRole("button", { name: "Close" }));

    const nav = screen.getByRole("navigation", { name: "Stall filters" });
    await user.click(within(nav).getByRole("button", { name: /Saved/ }));
    expect(screen.getByRole("button", { name: /1054/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /1050/ })).toBeNull();
    expect(localStorage.getItem("bluelot-pins")).toContain("1054");
  });
});

describe("story: a missing feed", () => {
  it("shows the error and a retry", () => {
    render(<BlueLot initial={{ ok: false, error: "Couldn't refresh the charger feed." }} />);
    expect(screen.getByRole("heading", { name: "Feed unavailable" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

const PAGES = ["open", "busy", "offline", "pinned"] as const;

function dockPressed(name: RegExp) {
  const nav = screen.getByRole("navigation", { name: "Stall filters" });
  return within(nav).getByRole("button", { name }).getAttribute("aria-pressed");
}

function touchSwipe(target: Element, dx: number, dy = 0, startX = 180) {
  const startY = 220;
  const point = {
    pointerId: 1,
    pointerType: "touch" as const,
    isPrimary: true,
  };
  fireEvent.pointerDown(target, { ...point, clientX: startX, clientY: startY });
  fireEvent.pointerMove(target, { ...point, clientX: startX + dx / 2, clientY: startY + dy / 2 });
  fireEvent.pointerMove(target, { ...point, clientX: startX + dx, clientY: startY + dy });
  fireEvent.pointerUp(target, { ...point, clientX: startX + dx, clientY: startY + dy });
}

describe("page swipe decisions", () => {
  it("treats a vertical drag as scrolling", () => {
    expect(classifyAxis(18, 140)).toBe("v");
    expect(swipeDirection(18, 140, "v")).toBeNull();
  });

  it("turns a left drag into the next page and does not wrap", () => {
    expect(classifyAxis(-90, 8)).toBe("h");
    expect(swipeDirection(-90, 8, "h")).toBe("next");
    expect(swipeDirection(40, 4, "h")).toBeNull();
    expect(pageAfterSwipe(PAGES, "open", "next")).toBe("busy");
    expect(pageAfterSwipe(PAGES, "pinned", "next")).toBeNull();
    expect(pageAfterSwipe(PAGES, "open", "prev")).toBeNull();
    expect(pageAfterSwipe(PAGES, "all", "next")).toBe("open");
    expect(pageAfterSwipe(PAGES, "all", "prev")).toBeNull();
  });

  it("ignores drags that start on a field or an open sheet", () => {
    const field = document.createElement("input");
    const sheet = document.createElement("div");
    sheet.setAttribute("role", "dialog");
    const inside = document.createElement("button");
    sheet.append(inside);
    expect(swipeTargetBlocked(field)).toBe(true);
    expect(swipeTargetBlocked(inside)).toBe(true);
    expect(swipeTargetBlocked(document.createElement("button"))).toBe(false);
  });
});

describe("story: swiping between pages", () => {
  it("follows the bottom nav and keeps the pressed tab in sync", () => {
    render(<BlueLot initial={story} />);
    const main = screen.getByRole("main");
    expect(dockPressed(/^Open/)).toBe("true");

    touchSwipe(main, -160, 6);
    expect(dockPressed(/^Open/)).toBe("false");
    expect(dockPressed(/In use/)).toBe("true");
    expect(screen.getByRole("button", { name: /1050/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /1054/ })).toBeNull();

    touchSwipe(main, -160, 4);
    expect(dockPressed(/Offline/)).toBe("true");
    expect(screen.getByRole("button", { name: /1051/ })).toBeTruthy();

    touchSwipe(main, -160, 4);
    expect(dockPressed(/Saved/)).toBe("true");
    expect(screen.getByText("Star a stall to keep it here.")).toBeTruthy();

    touchSwipe(main, -160, 4);
    expect(dockPressed(/Saved/)).toBe("true");
    expect(screen.getByText("Star a stall to keep it here.")).toBeTruthy();

    touchSwipe(main, 160, 4);
    expect(dockPressed(/Offline/)).toBe("true");
    expect(screen.getByRole("button", { name: /1051/ })).toBeTruthy();
  });

  it("leaves the page alone when the drag is vertical, short, from the edge, or a mouse drag", () => {
    render(<BlueLot initial={story} />);
    const main = screen.getByRole("main");

    touchSwipe(main, 24, 220);
    expect(dockPressed(/^Open/)).toBe("true");
    expect(screen.getByRole("button", { name: /1054/ })).toBeTruthy();

    touchSwipe(main, -36, 4);
    expect(dockPressed(/^Open/)).toBe("true");

    touchSwipe(main, -180, 4, 8);
    expect(dockPressed(/^Open/)).toBe("true");

    fireEvent.pointerDown(main, {
      pointerId: 1,
      pointerType: "mouse",
      clientX: 180,
      clientY: 220,
      isPrimary: true,
    });
    fireEvent.pointerMove(main, {
      pointerId: 1,
      pointerType: "mouse",
      clientX: 20,
      clientY: 224,
      isPrimary: true,
    });
    fireEvent.pointerUp(main, {
      pointerId: 1,
      pointerType: "mouse",
      clientX: 20,
      clientY: 224,
      isPrimary: true,
    });
    expect(dockPressed(/^Open/)).toBe("true");
    expect(screen.queryByRole("button", { name: /1050/ })).toBeNull();
  });

  it("does not page on a wide screen, while searching, or while a stall sheet is open", async () => {
    const user = userEvent.setup();
    const previous = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    try {
      render(<BlueLot initial={story} />);
      touchSwipe(screen.getByRole("main"), -180, 4);
      expect(dockPressed(/^Open/)).toBe("true");
    } finally {
      if (previous) window.matchMedia = previous;
      else Reflect.deleteProperty(window, "matchMedia");
    }

    cleanup();
    render(<BlueLot initial={story} />);
    await user.type(screen.getByRole("textbox", { name: "Search stall number" }), "1113");
    touchSwipe(screen.getByRole("main"), -180, 4);
    expect(dockPressed(/^Open/)).toBe("true");
    expect(screen.getByRole("button", { name: /1113/ })).toBeTruthy();

    cleanup();
    render(<BlueLot initial={story} />);
    await user.click(screen.getByRole("button", { name: /1054/ }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    touchSwipe(screen.getByRole("dialog"), -180, 4);
    expect(dockPressed(/^Open/)).toBe("true");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /1050/ })).toBeNull();
  });

  it("does not open a stall when the gesture was a swipe, and a later tap still does", async () => {
    const user = userEvent.setup();
    render(<BlueLot initial={story} />);
    const card = screen.getByRole("button", { name: /1054/ });
    touchSwipe(card, 48, 2);
    fireEvent.click(card);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(dockPressed(/^Open/)).toBe("true");

    touchSwipe(screen.getByRole("main"), -160, 4);
    expect(dockPressed(/In use/)).toBe("true");
    await user.click(screen.getByRole("button", { name: /1050/ }));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
