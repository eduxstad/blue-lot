import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Android Auto charging app", () => {
  const manifest = readFileSync("android/AndroidManifest.xml", "utf8");
  const descriptor = readFileSync("android/res/xml/automotive_app_desc.xml", "utf8");
  const build = readFileSync("android/build.sh", "utf8");
  const workflow = readFileSync(".github/workflows/play-internal-release.yml", "utf8");

  it("registers a Play POI Car App at API level 1", () => {
    expect(manifest).toContain('android:versionCode="27"');
    expect(manifest).toContain('android:versionName="1.12.4"');
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
    expect(workflow).toContain("version_code=$((24 + ${GITHUB_RUN_NUMBER:?}))");
    expect(workflow).toContain("versionName=${INPUT_VERSION_NAME:-1.12.4}");
  });

  it("ships the car library API level on the app classpath", () => {
    const library = readFileSync("android/res/values/car_lib.xml", "utf8");
    expect(library).toContain(">1.7.0<");
    expect(build).toContain("androidx/car/app/app/1.7.0/app-1.7.0.aar");
    expect(build).toContain('filename="car-app-api.level"');
    expect(build).toContain('put("root/car-app-api.level"');
    expect(build).not.toContain("app/1.4.0/app-1.4.0.aar");
  });

  it("ships an adaptive launcher icon with a monochrome layer", () => {
    expect(manifest).toContain('android:icon="@mipmap/ic_launcher"');
    expect(manifest).toContain('android:roundIcon="@mipmap/ic_launcher_round"');
    expect(manifest).not.toContain('android:roundIcon="@mipmap/ic_launcher"');
    const serviceIcon = manifest.slice(manifest.indexOf("ChargerCarService"));
    expect(serviceIcon).toContain('android:icon="@mipmap/ic_launcher"');
    for (const name of ["ic_launcher.xml", "ic_launcher_round.xml"]) {
      const xml = readFileSync(`android/res/mipmap-anydpi-v26/${name}`, "utf8");
      expect(xml).toContain("@drawable/ic_launcher_background");
      expect(xml).toContain("@drawable/ic_launcher_foreground");
      expect(xml).toContain("<monochrome android:drawable=\"@drawable/ic_launcher_monochrome\" />");
    }
    expect(readFileSync("android/res/drawable/ic_launcher_background.xml", "utf8")).toContain("#0C1110");
    expect(readFileSync("android/res/drawable/ic_launcher_foreground.xml", "utf8")).toContain("#B7C2BF");
    expect(readFileSync("android/res/drawable/ic_launcher_foreground.xml", "utf8")).toContain("#4DA3FF");
    expect(readFileSync("android/res/drawable/ic_launcher_monochrome.xml", "utf8")).toContain("#FFFFFFFF");
    for (const density of ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"]) {
      expect(existsSync(`android/res/mipmap-${density}/ic_launcher.png`)).toBe(true);
      expect(existsSync(`android/res/mipmap-${density}/ic_launcher_round.png`)).toBe(true);
    }
    expect(build).not.toContain("def icon(");
    expect(build).not.toContain('print("icons ok")');
    expect(build).not.toContain("from PIL import");
    expect(build).toContain('"$BT/aapt2" compile -o "$OUT/compiled.zip" --dir "$OUT/res"');
    expect(build).toContain("AAB adaptive icon {name} is missing the monochrome layer");
    expect(readFileSync("public/favicon.svg", "utf8")).toContain("#4DA3FF");
    expect(existsSync("playstore-512.png")).toBe(false);
  });

  it("returns the first car template without calling the host or the feed", () => {
    const source = readFileSync("android/java/com/bluelot/app/ChargerCarService.java", "utf8");
    expect(source).not.toContain("getContentLimit");
    expect(source).not.toContain("constraints.ConstraintManager");
    expect(source).not.toContain("getCarService(ConstraintManager");
    expect(source).toContain("setLoading(true)");
    expect(source).toContain('static final String FEED_ERROR = "Couldn\'t reach the charger feed."');
    expect(source).toContain('static final String NO_OPEN = "No open chargers"');
    expect(source).toContain('return "Stall " + stall.name + " · " + floorLabel(stall)');
    expect(source).toContain('if ("open".equals(stall.availability)) stalls.add(stall)');
    const loads = source.split("ChargerFeed.load(").length - 1;
    expect(loads).toBe(1);
    const loadAt = source.indexOf("ChargerFeed.load(");
    const executeAt = source.lastIndexOf("executor.execute", loadAt);
    expect(executeAt).toBeGreaterThan(-1);
    expect(source.slice(0, executeAt)).not.toContain("ChargerFeed.load(");
  });
});
