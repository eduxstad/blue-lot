import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as {
  JSDOM: new (
    html: string,
    options?: { runScripts?: "dangerously"; url?: string },
  ) => { window: Window & { close(): void } };
};

const html = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../android/assets/www/index.html"),
  "utf8",
);

type FeedWindow = Window & {
  onSitePayload: (raw: string | null) => void;
  BlueLotNative?: { refresh: () => void };
};

const windows: FeedWindow[] = [];

afterEach(() => {
  while (windows.length > 0) windows.pop()?.close();
});

function boot(fallback: unknown) {
  const page = html.replace("__FALLBACK_JSON__", JSON.stringify(fallback).replace(/</g, "\\u003c"));
  const dom = new JSDOM(page, {
    runScripts: "dangerously",
    url: "http://localhost/index.html",
  });
  const view = dom.window as unknown as FeedWindow;
  windows.push(view);
  return view;
}

const stall = {
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
};

const saved = {
  site: "SpaceX",
  address: "12250 Crenshaw Blvd.",
  city: "Hawthorne",
  state: "California",
  zip: "90250",
  fetchedAt: "2026-10-23T06:44:20.000Z",
  live: false,
  stalls: [stall],
};

function livePayload() {
  return JSON.stringify({
    name: "SpaceX",
    address: "12250 Crenshaw Blvd.",
    city: "Hawthorne",
    state: "California",
    zipcode: "90250",
    gateways: [{ id: 1, name: "KT-SX-1A" }],
    stations: [
      {
        name: "1054",
        gatewayId: 1,
        info: {
          status: "online",
          chargeStatus: "available",
          connection: "disconnected",
          operating_voltage: 220,
          max_charge_current: 30,
        },
      },
    ],
  });
}

describe("android webview feed errors", () => {
  it("shows an error over the saved reading when nothing is connected", () => {
    const view = boot(saved);
    const doc = view.document;
    const alert = doc.querySelector("[role=alert]");
    expect(alert?.textContent).toContain("Couldn't load stall data");
    expect(alert?.textContent).toContain("This list may be out of date.");
    expect(doc.querySelector("[data-stall='1054']")).toBeTruthy();
    expect(doc.getElementById("note")?.hidden).toBe(false);
    expect(doc.getElementById("note")?.textContent).toContain("last full reading");
    expect(doc.getElementById("retry")).toBeTruthy();
  });

  it("clears the error after a live payload and brings it back if the next fetch fails", () => {
    const view = boot(saved);
    const doc = view.document;
    let refreshes = 0;
    view.BlueLotNative = {
      refresh() {
        refreshes += 1;
      },
    };

    view.onSitePayload(livePayload());
    expect(doc.querySelector("[role=alert]")).toBeNull();
    expect(doc.getElementById("note")?.hidden).toBe(true);
    expect(doc.querySelector("[data-stall='1054']")).toBeTruthy();
    expect(doc.getElementById("when")?.textContent).toContain("Updated");

    view.onSitePayload(null);
    const alert = doc.querySelector("[role=alert]");
    expect(alert?.textContent).toContain("Couldn't refresh the chargers");
    expect(alert?.textContent).toContain("out of date");
    expect(doc.querySelector("[data-stall='1054']")).toBeTruthy();
    expect(doc.getElementById("note")?.textContent).toContain("may be out of date");

    (doc.getElementById("retry") as HTMLButtonElement).click();
    expect(refreshes).toBe(1);

    view.onSitePayload("{");
    expect(doc.querySelector("[role=alert]")).toBeTruthy();
    expect(doc.querySelector("[data-stall='1054']")).toBeTruthy();
  });

  it("shows only the error when there is no saved reading", () => {
    const view = boot({ ...saved, stalls: [] });
    const doc = view.document;
    expect(doc.querySelector("[role=alert]")?.textContent).toContain(
      "Check your connection and try again.",
    );
    expect(doc.querySelector("[role=alert]")?.textContent).not.toContain("out of date");
    expect(doc.querySelector("[data-stall]")).toBeNull();
    expect(doc.getElementById("count")?.textContent).toBe("–");
    expect(doc.getElementById("meta")?.textContent).toBe("Couldn't load stall data");
  });
});
