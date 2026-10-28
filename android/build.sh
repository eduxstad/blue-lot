#!/bin/bash
set -euo pipefail

ROOT=/tmp/bluelot-android
SDK=/tmp/android-sdk
BT="$SDK/android-14"
JAR="$SDK/android-35/android.jar"
OUT="$ROOT/build"
rm -rf "$OUT"
mkdir -p "$OUT/classes" "$OUT/dex" "$OUT/assets/www" "$OUT/res"

python3 - <<'PY'
import json
from pathlib import Path
from PIL import Image, ImageDraw

root = Path("/tmp/bluelot-android")
src = (root / "assets/www/index.html").read_text()
data = json.loads(Path("/workspace/src/lib/fallback-snapshot.json").read_text())
blob = json.dumps(data, separators=(",", ":")).replace("<", "\\u003c")
html = src.replace("__FALLBACK_JSON__", blob)
if "__FALLBACK_JSON__" in html:
    raise SystemExit("fallback placeholder was not replaced")
out = root / "build/assets/www/index.html"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(html)
print("html bytes", out.stat().st_size)
fallback = Path("/workspace/src/lib/fallback-snapshot.json").read_bytes()
(root / "build/assets/fallback-snapshot.json").write_bytes(fallback)

def icon(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (61, 220, 132, 255))
    draw = ImageDraw.Draw(img)
    ink = (6, 32, 20, 255)
    cx = cy = size / 2
    s = size * 0.46
    pts = [
        (cx + s * 0.05, cy - s * 0.50),
        (cx - s * 0.30, cy + s * 0.02),
        (cx - s * 0.02, cy + s * 0.02),
        (cx - s * 0.14, cy + s * 0.50),
        (cx + s * 0.34, cy - s * 0.08),
        (cx + s * 0.02, cy - s * 0.08),
    ]
    draw.polygon(pts, fill=ink)
    return img

for name, size in {
    "mipmap-mdpi": 48,
    "mipmap-hdpi": 72,
    "mipmap-xhdpi": 96,
    "mipmap-xxhdpi": 144,
    "mipmap-xxxhdpi": 192,
}.items():
    folder = root / "res" / name
    folder.mkdir(parents=True, exist_ok=True)
    icon(size).save(folder / "ic_launcher.png")
print("icons ok")
PY

"$BT/aapt2" compile -o "$OUT/compiled.zip" --dir "$ROOT/res"
"$BT/aapt2" link \
  -o "$OUT/linked.apk" \
  -I "$JAR" \
  --manifest "$ROOT/AndroidManifest.xml" \
  --min-sdk-version 24 \
  --target-sdk-version 34 \
  --java "$OUT/gen" \
  -A "$OUT/assets" \
  "$OUT/compiled.zip"

python3 - <<'PY'
import re
from pathlib import Path
text = Path("/tmp/android-sdk/android-14/aapt2").exists()
PY
# Resource ids for the car library live in this app's table. Write the R class it looks up.
"$BT/aapt2" dump resources "$OUT/linked.apk" > "$OUT/resources.txt"
python3 - <<'PY'
import re
from pathlib import Path
dump = Path("/tmp/bluelot-android/build/resources.txt").read_text(errors="replace")
wanted = {
    "string": ["car_app_library_version"],
    "integer": [
        "content_limit_grid",
        "content_limit_list",
        "content_limit_pane",
        "content_limit_place_list",
        "content_limit_route_list",
    ],
    "color": ["carColorBlue", "carColorGreen", "carColorRed", "carColorYellow"],
}
found = {kind: {} for kind in wanted}
for kind, names in wanted.items():
    for name in names:
        match = re.search(rf"resource (0x[0-9a-fA-F]+) {kind}/{name}\b", dump)
        if not match:
            match = re.search(rf"(0x[0-9a-fA-F]+).*{kind}/{name}\b", dump)
        if not match:
            raise SystemExit(f"missing resource id for {kind}/{name}")
        found[kind][name] = match.group(1)
out = Path("/tmp/bluelot-android/build/gen/androidx/car/app")
out.mkdir(parents=True, exist_ok=True)
parts = ["package androidx.car.app;", "public final class R {"]
for kind, names in wanted.items():
    parts.append(f"  public static final class {kind} {{")
    for name in names:
        parts.append(f"    public static final int {name} = {found[kind][name]};")
    parts.append("  }")
parts.append("}")
(out / "R.java").write_text("\n".join(parts) + "\n")
print("car R", found["integer"]["content_limit_list"])
PY

CP="$JAR:/tmp/car-libs/classes.jar"
for j in \
  /tmp/car-libs/cp/core-1.7.0.jar \
  /tmp/car-libs/cp/lifecycle-runtime-2.3.1.jar \
  /tmp/car-libs/cp/lifecycle-common-2.3.1.jar \
  /tmp/car-libs/cp/lifecycle-common-java8-2.2.0.jar \
  /tmp/car-libs/cp/lifecycle-viewmodel-2.3.0.jar \
  /tmp/car-libs/cp/savedstate-1.1.0.jar \
  /tmp/car-libs/cp/activity-1.2.0.jar \
  /tmp/car-libs/cp/annotation-1.2.0.jar \
  /tmp/car-libs/cp/collection-1.0.0.jar \
  /tmp/car-libs/cp/versionedparcelable-1.1.1.jar \
  /tmp/car-libs/cp/core-runtime-2.1.0.jar \
  /tmp/car-libs/cp/core-common-2.1.0.jar \
  /tmp/car-libs/cp/concurrent-futures-1.0.0.jar \
  /tmp/car-libs/cp/guava-31.1-android.jar \
  /tmp/car-libs/cp/failureaccess-1.0.1.jar
 do
  CP="$CP:$j"
done

javac --release 8 -encoding UTF-8 -classpath "$CP" -d "$OUT/classes" \
  "$ROOT/java/com/bluelot/app/MainActivity.java" \
  "$ROOT/java/com/bluelot/app/ChargerFeed.java" \
  "$ROOT/java/com/bluelot/app/ChargerCarService.java" \
  "$ROOT/java/com/bluelot/app/ChargerMediaService.java" \
  "$ROOT/java/com/bluelot/app/StallAlerts.java" \
  "$ROOT/java/com/bluelot/app/NotifyReceiver.java" \
  "$OUT/gen/androidx/car/app/R.java" \
  "$OUT/gen/com/bluelot/app/R.java"

find "$OUT/classes" -name '*.class' > "$OUT/classes.list"
DEX_IN="$OUT/classes.list"
# Library jars the car service needs at runtime. One version of each.
cat > "$OUT/dex-jars.list" <<'JARS'
/tmp/car-libs/classes.jar
/tmp/car-libs/cp/core-1.7.0.jar
/tmp/car-libs/cp/lifecycle-runtime-2.3.1.jar
/tmp/car-libs/cp/lifecycle-common-2.3.1.jar
/tmp/car-libs/cp/lifecycle-common-java8-2.2.0.jar
/tmp/car-libs/cp/lifecycle-viewmodel-2.3.0.jar
/tmp/car-libs/cp/savedstate-1.1.0.jar
/tmp/car-libs/cp/activity-1.2.0.jar
/tmp/car-libs/cp/collection-1.0.0.jar
/tmp/car-libs/cp/versionedparcelable-1.1.1.jar
/tmp/car-libs/cp/core-runtime-2.1.0.jar
/tmp/car-libs/cp/core-common-2.1.0.jar
/tmp/car-libs/cp/concurrent-futures-1.0.0.jar
/tmp/car-libs/cp/guava-31.1-android.jar
/tmp/car-libs/cp/failureaccess-1.0.1.jar
JARS
"$BT/d8" --release --min-api 24 --lib "$JAR" --output "$OUT/dex" \
  @"$OUT/classes.list" @"$OUT/dex-jars.list"

cp "$OUT/linked.apk" "$OUT/unsigned.apk"
python3 - <<'PY'
import zipfile
from pathlib import Path
out = Path("/tmp/bluelot-android/build")
unsigned = out / "unsigned.apk"
# Rewrite so classes.dex is a clean stored entry and the archive has no stray metadata.
src = out / "linked.apk"
with zipfile.ZipFile(src, "r") as zin, zipfile.ZipFile(unsigned, "w") as zout:
    for info in zin.infolist():
        data = zin.read(info.filename)
        new = zipfile.ZipInfo(filename=info.filename, date_time=info.date_time)
        new.compress_type = info.compress_type
        new.external_attr = 0
        zout.writestr(new, data)
    dex_files = sorted((out / "dex").glob("classes*.dex"))
    if not dex_files:
        raise SystemExit("no dex output")
    for dex_path in dex_files:
        dex_info = zipfile.ZipInfo(filename=dex_path.name)
        dex_info.compress_type = zipfile.ZIP_STORED
        dex_info.external_attr = 0
        zout.writestr(dex_info, dex_path.read_bytes())
        print("dex", dex_path.name, dex_path.stat().st_size)
print("unsigned", unsigned.stat().st_size)
PY

if [ ! -f "$ROOT/bluelot.keystore" ]; then
  keytool -genkeypair -keystore "$ROOT/bluelot.keystore" -alias bluelot \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass bluelot-install -keypass bluelot-install \
    -dname "CN=Blue Lot, OU=Blue Lot, O=Blue Lot, L=Hawthorne, ST=CA, C=US"
fi

"$BT/zipalign" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"
"$BT/apksigner" sign \
  --ks "$ROOT/bluelot.keystore" \
  --ks-key-alias bluelot \
  --ks-pass pass:bluelot-install \
  --key-pass pass:bluelot-install \
  --v1-signing-enabled true \
  --v2-signing-enabled true \
  --v3-signing-enabled true \
  --v4-signing-enabled false \
  --out "$OUT/Blue-Lot.apk" \
  "$OUT/aligned.apk"

"$BT/apksigner" verify --verbose "$OUT/Blue-Lot.apk"
"$BT/aapt" dump badging "$OUT/Blue-Lot.apk" | head -30
mkdir -p /workspace/artifacts
cp "$OUT/Blue-Lot.apk" /workspace/artifacts/Blue-Lot.apk
ls -lh /workspace/artifacts/Blue-Lot.apk
echo BUILD_OK
