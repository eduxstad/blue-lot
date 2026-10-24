import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatAgo,
  formatDuration,
  formatLocal,
  formatUtc,
  kwLabel,
  loadChargers,
  LONG_SESSION_SECONDS,
  statusLabel,
  type Stall,
} from "./chargers";

const stall = (overrides: Partial<Stall> = {}): Stall => ({
  name: "1054",
  floor: 1,
  bank: "A",
  gateway: "KT-SX-1A",
  availability: "open",
  pluggedIn: false,
  amps: 30,
  volts: 220,
  sessionSeconds: null,
  seenAt: null,
  portId: null,
  ...overrides,
});

describe("formatDuration", () => {
  it("shows seconds, minutes, and hours", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(125)).toBe("2m");
    expect(formatDuration(3 * 3600 + 4 * 60)).toBe("3h 4m");
  });

  it("shows days as well as hours", () => {
    expect(formatDuration(86400)).toBe("1d 0h");
    expect(formatDuration(86400 + 2 * 3600)).toBe("1d 2h");
    expect(formatDuration(2 * 86400 + 3 * 3600 + 5 * 60)).toBe("2d 3h 5m");
  });

  it("floors partial seconds and clamps negatives", () => {
    expect(formatDuration(119.9)).toBe("1m");
    expect(formatDuration(-40)).toBe("0s");
  });
});

describe("formatAgo", () => {
  const now = Date.parse("2026-10-23T08:00:00.000Z");

  it("picks the largest unit that has elapsed", () => {
    expect(formatAgo("2026-10-23T08:00:00.000Z", now)).toBe("just now");
    expect(formatAgo("2026-10-23T07:59:30.000Z", now)).toBe("30s ago");
    expect(formatAgo("2026-10-23T07:15:00.000Z", now)).toBe("45m ago");
    expect(formatAgo("2026-10-23T06:00:00.000Z", now)).toBe("2h ago");
    expect(formatAgo("2026-10-20T08:00:00.000Z", now)).toBe("3d ago");
  });

  it("does not go negative when the timestamp is in the future", () => {
    expect(formatAgo("2026-10-23T09:00:00.000Z", now)).toBe("just now");
  });

  it("rejects an unreadable timestamp", () => {
    expect(formatAgo("not-a-date", now)).toBe("unknown");
  });
});

describe("absolute times", () => {
  it("formats UTC with a zone label", () => {
    expect(formatUtc("2026-10-23T13:43:00.000Z")).toBe("Oct 23, 13:43 UTC");
    expect(formatUtc("nope")).toBe("unknown");
  });

  it("formats the same instant in the local time zone", () => {
    const previous = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      expect(formatLocal("2026-10-23T13:43:00.000Z")).toMatch(/Oct 23, 2026/);
      expect(formatLocal("2026-10-23T13:43:00.000Z")).toMatch(/6:43/);
      expect(formatLocal("2026-10-23T13:43:00.000Z")).toMatch(/PDT|PT/);
      expect(formatLocal("nope")).toBe("unknown");
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
});

describe("stall labels", () => {
  it("names each availability", () => {
    expect(statusLabel("open")).toBe("Open");
    expect(statusLabel("busy")).toBe("In use");
    expect(statusLabel("offline")).toBe("Offline");
  });

  it("prints kilowatts from volts and amps", () => {
    expect(kwLabel(stall())).toBe("6.6 kW");
    expect(kwLabel(stall({ volts: 0, amps: 0 }))).toBe("J1772");
  });

  it("treats 16 hours as the long-session line", () => {
    expect(LONG_SESSION_SECONDS).toBe(16 * 60 * 60);
  });
});

describe("loadChargers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps gateways, banks, and session time from a live site", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          name: "SpaceX",
          address: "12250 Crenshaw Blvd.",
          city: "Hawthorne",
          state: "California",
          zipcode: "90250",
          gateways: [
            { id: 1, name: "KT-SX-1A" },
            { id: 2, name: "KT-SX-6B" },
            { id: 8, name: "mystery" },
          ],
          stations: [
            {
              name: "2000",
              gatewayId: 2,
              portId: "p2",
              info: {
                status: "online",
                chargeStatus: "charging",
                connection: "connected",
                operating_voltage: 208,
                max_charge_current: 32,
                timestamp: 100,
                current_session_duration: 90000,
              },
            },
            {
              name: "1054",
              gatewayId: 1,
              portId: "p1",
              info: {
                status: "online",
                chargeStatus: "available",
                connection: "disconnected",
                operating_voltage: 220,
                max_charge_current: 30,
                timestamp: 200,
              },
            },
            { name: "1051", gatewayId: 1, info: { status: "offline" } },
            { name: "999", gatewayId: 8, info: { status: "online" } },
          ],
        }),
      })),
    );

    const result = await loadChargers();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.live).toBe(true);
    expect(result.snapshot.city).toBe("Hawthorne");
    expect(result.snapshot.stalls.map((item) => item.name)).toEqual(["999", "1051", "1054", "2000"]);

    const busy = result.snapshot.stalls.find((item) => item.name === "2000");
    expect(busy).toMatchObject({
      floor: 6,
      bank: "B",
      gateway: "KT-SX-6B",
      availability: "busy",
      pluggedIn: true,
      sessionSeconds: 90000,
      volts: 208,
      amps: 32,
    });

    const open = result.snapshot.stalls.find((item) => item.name === "1054");
    expect(open).toMatchObject({ floor: 1, bank: "A", availability: "open", sessionSeconds: null });

    const offline = result.snapshot.stalls.find((item) => item.name === "1051");
    expect(offline?.availability).toBe("offline");

    const fallback = result.snapshot.stalls.find((item) => item.name === "999");
    expect(fallback).toMatchObject({ floor: 1, bank: "", availability: "open" });
  });

  it("keeps the saved reading when the feed does not answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
    const denied = await loadChargers();
    expect(denied.ok).toBe(true);
    if (denied.ok) expect(denied.snapshot.live).toBe(false);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("timeout");
      }),
    );
    const failed = await loadChargers();
    expect(failed.ok).toBe(true);
    if (failed.ok) {
      expect(failed.snapshot.live).toBe(false);
      expect(failed.snapshot.stalls.length).toBeGreaterThan(0);
    }
  });
});
