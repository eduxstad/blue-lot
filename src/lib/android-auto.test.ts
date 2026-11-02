import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Android Auto charging app", () => {
  const manifest = readFileSync("android/AndroidManifest.xml", "utf8");
  const descriptor = readFileSync("android/res/xml/automotive_app_desc.xml", "utf8");
  const build = readFileSync("android/build.sh", "utf8");
  const workflow = readFileSync(".github/workflows/play-internal-release.yml", "utf8");

  it("registers a Play POI Car App at API level 1", () => {
    expect(manifest).toContain('android:versionCode="13"');
    expect(manifest).toContain('android:versionName="1.12.0"');
    expect(manifest).toContain("androidx.car.app.CarAppService");
    expect(manifest).toContain("androidx.car.app.category.POI");
    expect(manifest).not.toContain("androidx.car.app.category.CHARGING");
    expect(manifest).not.toContain("androidx.car.app.category.PARKING");
    expect(manifest).toContain(".ChargerCarService");
    expect(manifest).toMatch(
      /android:name="androidx\.car\.app\.minCarApiLevel"\s+android:value="1"/,
    );
    expect(manifest).not.toContain("ChargerMediaService");
    expect(manifest).not.toContain("MediaBrowserService");
    expect(manifest).not.toContain('android:appCategory="audio"');
  });

  it("describes a template app, not a media app", () => {
    expect(descriptor).toContain('<uses name="template" />');
    expect(descriptor).not.toContain("media");
  });

  it("drops the media workaround from the build", () => {
    expect(existsSync("android/java/com/bluelot/app/ChargerMediaService.java")).toBe(false);
    expect(existsSync("android/java/com/bluelot/app/ChargerCarService.java")).toBe(true);
    expect(build).toContain("ChargerCarService.java");
    expect(build).not.toContain("ChargerMediaService.java");
  });

  it("keeps the Play internal workflow on the signed AAB", () => {
    expect(workflow).toContain("bash android/build.sh");
    expect(workflow).toContain("packageName: com.duxstad.bluelotchargers");
    expect(workflow).toContain("releaseFiles: android/build/Blue-Lot.aab");
    expect(workflow).toContain("track: internal");
    expect(workflow).toContain("version_code=$((13 + ${GITHUB_RUN_NUMBER:?}))");
    expect(workflow).toContain("versionName=${INPUT_VERSION_NAME:-1.12.0}");
  });
});
