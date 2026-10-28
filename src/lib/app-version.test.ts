import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { appVersion, appVersionFromManifest } from "./app-version";

describe("app version", () => {
  it("reads android:versionName", () => {
    expect(
      appVersionFromManifest('<manifest android:versionCode="11" android:versionName="1.10.0">'),
    ).toBe("1.10.0");
  });

  it("rejects a manifest with no version name", () => {
    expect(() => appVersionFromManifest("<manifest></manifest>")).toThrow(/versionName/);
  });

  it("matches the manifest checked into the repo", () => {
    const xml = readFileSync("android/AndroidManifest.xml", "utf8");
    expect(appVersion).toBe(appVersionFromManifest(xml));
  });
});
