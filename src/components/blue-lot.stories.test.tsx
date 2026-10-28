import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BlueLot } from "./blue-lot";
import { appVersion } from "@/lib/app-version";
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
    expect(screen.getByText(`Version ${appVersion}`)).toBeTruthy();
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
