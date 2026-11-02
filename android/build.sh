#!/bin/bash
# Blue Lot Android build: sideload APK plus a Play App Bundle.
#
# Needs JDK, python3, Pillow, curl, and Android SDK build-tools 35.0.0
# with platforms;android-35 (ANDROID_SDK_ROOT or ANDROID_HOME).
#
# CI (GITHUB_ACTIONS=true) must set KEYSTORE_BASE64, KEYSTORE_PASSWORD,
# KEY_ALIAS, and KEY_PASSWORD. A missing secret fails the build instead of
# minting a new key. Local runs without those vars reuse or create
# android/bluelot.keystore (store password bluelot-install, alias bluelot).
#
# Optional: VERSION_CODE, VERSION_NAME, ANDROID_BUILD_TOOLS, ANDROID_JAR,
# CAR_LIBS, BUNDLETOOL_JAR, FALLBACK_JSON, ARTIFACTS_DIR.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$ROOT/.." && pwd)
OUT="$ROOT/build"
SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
DEPS="${CAR_LIBS:-$ROOT/.deps}"
FALLBACK="${FALLBACK_JSON:-$REPO/src/lib/fallback-snapshot.json}"
ARTIFACTS="${ARTIFACTS_DIR:-$REPO/artifacts}"
BUNDLETOOL_VERSION=1.18.3
BUNDLETOOL="${BUNDLETOOL_JAR:-$ROOT/.deps/bundletool-all-${BUNDLETOOL_VERSION}.jar}"
GMAVEN=https://dl.google.com/dl/android/maven2
CENTRAL=https://repo1.maven.org/maven2
TMP_KS=""

die() {
  echo "ERROR: $*" >&2
  exit 1
}

cleanup() {
  if [ -n "${TMP_KS}" ]; then
    rm -f "${TMP_KS}"
  fi
}
trap cleanup EXIT

fetch() {
  local url="$1" dest="$2"
  if [ -f "$dest" ]; then
    return 0
  fi
  mkdir -p "$(dirname "$dest")"
  echo "fetch ${dest##*/}"
  curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 20 -o "$dest.partial" "$url"
  mv "$dest.partial" "$dest"
}

extract_aar_classes() {
  local aar="$1" dest="$2"
  if [ -f "$dest" ]; then
    return 0
  fi
  mkdir -p "$(dirname "$dest")"
  python3 -c 'import sys, zipfile; from pathlib import Path; Path(sys.argv[2]).write_bytes(zipfile.ZipFile(sys.argv[1]).read("classes.jar"))' "$aar" "$dest"
}

need_aar() {
  local url="$1" name="$2" dest="$3"
  if [ -f "$dest" ]; then
    return 0
  fi
  fetch "$url" "$DEPS/aar/$name"
  extract_aar_classes "$DEPS/aar/$name" "$dest"
}

need_jar() {
  local url="$1" dest="$2"
  fetch "$url" "$dest"
}

if [ -n "${ANDROID_BUILD_TOOLS:-}" ]; then
  BT="$ANDROID_BUILD_TOOLS"
else
  if [ -z "$SDK" ]; then
    die "Set ANDROID_SDK_ROOT or ANDROID_HOME to an SDK with build-tools/35.0.0 and platforms/android-35."
  fi
  BT="$SDK/build-tools/35.0.0"
fi
if [ -n "${ANDROID_JAR:-}" ]; then
  JAR="$ANDROID_JAR"
else
  if [ -z "$SDK" ]; then
    die "Set ANDROID_JAR or ANDROID_SDK_ROOT (platforms/android-35)."
  fi
  JAR="$SDK/platforms/android-35/android.jar"
fi

for tool in aapt2 d8 zipalign apksigner; do
  if [ ! -f "$BT/$tool" ]; then
    die "Missing $BT/$tool. Install Android SDK build-tools 35.0.0."
  fi
done
if [ ! -f "$JAR" ]; then
  die "Missing $JAR. Install Android SDK platform android-35."
fi
command -v java >/dev/null || die "java is required (JDK 17)."
command -v javac >/dev/null || die "javac is required (JDK 17)."
command -v jarsigner >/dev/null || die "jarsigner is required (JDK 17)."
command -v keytool >/dev/null || die "keytool is required (JDK 17)."
command -v python3 >/dev/null || die "python3 is required."
command -v curl >/dev/null || die "curl is required."
if [ ! -f "$FALLBACK" ]; then
  die "Fallback snapshot not found at $FALLBACK."
fi
if [ ! -f "$ROOT/assets/www/index.html" ]; then
  die "Missing $ROOT/assets/www/index.html."
fi

use_secret_keystore=0
if [ "${GITHUB_ACTIONS:-}" = "true" ] || [ -n "${KEYSTORE_BASE64:-}${KEYSTORE_PASSWORD:-}${KEY_ALIAS:-}${KEY_PASSWORD:-}" ]; then
  use_secret_keystore=1
fi

if [ "$use_secret_keystore" -eq 1 ]; then
  missing=()
  [ -n "${KEYSTORE_BASE64:-}" ] || missing+=(KEYSTORE_BASE64)
  [ -n "${KEYSTORE_PASSWORD:-}" ] || missing+=(KEYSTORE_PASSWORD)
  [ -n "${KEY_ALIAS:-}" ] || missing+=(KEY_ALIAS)
  [ -n "${KEY_PASSWORD:-}" ] || missing+=(KEY_PASSWORD)
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "ERROR: refusing to generate a signing key." >&2
    echo "Missing signing secret(s): ${missing[*]}" >&2
    echo "Add GitHub Actions secrets KEYSTORE_BASE64, KEYSTORE_PASSWORD, KEY_ALIAS, and KEY_PASSWORD." >&2
    echo "KEYSTORE_BASE64 is the upload keystore on one line: base64 -w 0 upload.keystore" >&2
    exit 1
  fi
  TMP_KS=$(mktemp)
  chmod 600 "$TMP_KS"
  decoded=0
  if printf '%s' "$KEYSTORE_BASE64" | tr -d '[:space:]' | base64 -d > "$TMP_KS" 2>/dev/null; then
    decoded=1
  elif printf '%s' "$KEYSTORE_BASE64" | tr -d '[:space:]' | base64 -D > "$TMP_KS" 2>/dev/null; then
    decoded=1
  fi
  if [ "$decoded" -ne 1 ] || [ ! -s "$TMP_KS" ]; then
    die "KEYSTORE_BASE64 is not valid base64, or it decoded to an empty file."
  fi
  KS="$TMP_KS"
  KS_ALIAS="$KEY_ALIAS"
  KS_STOREPASS="$KEYSTORE_PASSWORD"
  KS_KEYPASS="$KEY_PASSWORD"
  if ! keytool -list -keystore "$KS" -storepass "$KS_STOREPASS" -alias "$KS_ALIAS" >/dev/null; then
    die "Could not read alias '$KS_ALIAS' from the decoded keystore. Check KEYSTORE_BASE64, KEYSTORE_PASSWORD, and KEY_ALIAS."
  fi
  probe=$(mktemp -d)
  printf 'x' > "$probe/a.txt"
  jar cf "$probe/a.jar" -C "$probe" a.txt
  if ! jarsigner -sigalg SHA256withRSA -digestalg SHA-256 \
    -keystore "$KS" -storepass "$KS_STOREPASS" -keypass "$KS_KEYPASS" \
    "$probe/a.jar" "$KS_ALIAS"; then
    rm -rf "$probe"
    die "Could not sign with alias '$KS_ALIAS'. Check KEY_PASSWORD (and KEYSTORE_PASSWORD if the key password differs)."
  fi
  rm -rf "$probe"
else
  KS="$ROOT/bluelot.keystore"
  KS_ALIAS="bluelot"
  KS_STOREPASS="bluelot-install"
  KS_KEYPASS="bluelot-install"
fi

if [ "${GITHUB_ACTIONS:-}" = "true" ] && [ -z "${VERSION_CODE:-}" ]; then
  die "VERSION_CODE is not set. CI must pass a versionCode Play has not seen (manifest versionCode + github.run_number)."
fi
if [ -n "${VERSION_CODE:-}" ] && ! [[ "$VERSION_CODE" =~ ^[0-9]+$ ]]; then
  die "VERSION_CODE must be an integer, got '$VERSION_CODE'."
fi

need_aar "$GMAVEN/androidx/car/app/app/1.4.0/app-1.4.0.aar" app-1.4.0.aar "$DEPS/classes.jar"
need_aar "$GMAVEN/androidx/core/core/1.7.0/core-1.7.0.aar" core-1.7.0.aar "$DEPS/cp/core-1.7.0.jar"
need_aar "$GMAVEN/androidx/lifecycle/lifecycle-runtime/2.3.1/lifecycle-runtime-2.3.1.aar" lifecycle-runtime-2.3.1.aar "$DEPS/cp/lifecycle-runtime-2.3.1.jar"
need_jar "$GMAVEN/androidx/lifecycle/lifecycle-common/2.3.1/lifecycle-common-2.3.1.jar" "$DEPS/cp/lifecycle-common-2.3.1.jar"
need_jar "$GMAVEN/androidx/lifecycle/lifecycle-common-java8/2.2.0/lifecycle-common-java8-2.2.0.jar" "$DEPS/cp/lifecycle-common-java8-2.2.0.jar"
need_aar "$GMAVEN/androidx/lifecycle/lifecycle-viewmodel/2.3.0/lifecycle-viewmodel-2.3.0.aar" lifecycle-viewmodel-2.3.0.aar "$DEPS/cp/lifecycle-viewmodel-2.3.0.jar"
need_aar "$GMAVEN/androidx/savedstate/savedstate/1.1.0/savedstate-1.1.0.aar" savedstate-1.1.0.aar "$DEPS/cp/savedstate-1.1.0.jar"
need_aar "$GMAVEN/androidx/activity/activity/1.2.0/activity-1.2.0.aar" activity-1.2.0.aar "$DEPS/cp/activity-1.2.0.jar"
need_jar "$GMAVEN/androidx/annotation/annotation/1.2.0/annotation-1.2.0.jar" "$DEPS/cp/annotation-1.2.0.jar"
need_jar "$GMAVEN/androidx/collection/collection/1.0.0/collection-1.0.0.jar" "$DEPS/cp/collection-1.0.0.jar"
need_aar "$GMAVEN/androidx/versionedparcelable/versionedparcelable/1.1.1/versionedparcelable-1.1.1.aar" versionedparcelable-1.1.1.aar "$DEPS/cp/versionedparcelable-1.1.1.jar"
need_aar "$GMAVEN/androidx/arch/core/core-runtime/2.1.0/core-runtime-2.1.0.aar" core-runtime-2.1.0.aar "$DEPS/cp/core-runtime-2.1.0.jar"
need_jar "$GMAVEN/androidx/arch/core/core-common/2.1.0/core-common-2.1.0.jar" "$DEPS/cp/core-common-2.1.0.jar"
need_jar "$GMAVEN/androidx/concurrent/concurrent-futures/1.0.0/concurrent-futures-1.0.0.jar" "$DEPS/cp/concurrent-futures-1.0.0.jar"
need_jar "$CENTRAL/com/google/guava/guava/31.1-android/guava-31.1-android.jar" "$DEPS/cp/guava-31.1-android.jar"
need_jar "$CENTRAL/com/google/guava/failureaccess/1.0.1/failureaccess-1.0.1.jar" "$DEPS/cp/failureaccess-1.0.1.jar"
fetch "https://github.com/google/bundletool/releases/download/${BUNDLETOOL_VERSION}/bundletool-all-${BUNDLETOOL_VERSION}.jar" "$BUNDLETOOL"
java -jar "$BUNDLETOOL" version

COMPILE_JARS=(
  "$DEPS/classes.jar"
  "$DEPS/cp/core-1.7.0.jar"
  "$DEPS/cp/lifecycle-runtime-2.3.1.jar"
  "$DEPS/cp/lifecycle-common-2.3.1.jar"
  "$DEPS/cp/lifecycle-common-java8-2.2.0.jar"
  "$DEPS/cp/lifecycle-viewmodel-2.3.0.jar"
  "$DEPS/cp/savedstate-1.1.0.jar"
  "$DEPS/cp/activity-1.2.0.jar"
  "$DEPS/cp/annotation-1.2.0.jar"
  "$DEPS/cp/collection-1.0.0.jar"
  "$DEPS/cp/versionedparcelable-1.1.1.jar"
  "$DEPS/cp/core-runtime-2.1.0.jar"
  "$DEPS/cp/core-common-2.1.0.jar"
  "$DEPS/cp/concurrent-futures-1.0.0.jar"
  "$DEPS/cp/guava-31.1-android.jar"
  "$DEPS/cp/failureaccess-1.0.1.jar"
)
DEX_JARS=(
  "$DEPS/classes.jar"
  "$DEPS/cp/core-1.7.0.jar"
  "$DEPS/cp/lifecycle-runtime-2.3.1.jar"
  "$DEPS/cp/lifecycle-common-2.3.1.jar"
  "$DEPS/cp/lifecycle-common-java8-2.2.0.jar"
  "$DEPS/cp/lifecycle-viewmodel-2.3.0.jar"
  "$DEPS/cp/savedstate-1.1.0.jar"
  "$DEPS/cp/activity-1.2.0.jar"
  "$DEPS/cp/collection-1.0.0.jar"
  "$DEPS/cp/versionedparcelable-1.1.1.jar"
  "$DEPS/cp/core-runtime-2.1.0.jar"
  "$DEPS/cp/core-common-2.1.0.jar"
  "$DEPS/cp/concurrent-futures-1.0.0.jar"
  "$DEPS/cp/guava-31.1-android.jar"
  "$DEPS/cp/failureaccess-1.0.1.jar"
)
for j in "${COMPILE_JARS[@]}"; do
  if [ ! -s "$j" ]; then
    die "Missing dependency jar $j"
  fi
done

rm -rf "$OUT"
mkdir -p "$OUT/classes" "$OUT/dex" "$OUT/assets/www" "$OUT/res"
export BL_ROOT="$ROOT" BL_OUT="$OUT" BL_FALLBACK="$FALLBACK"

python3 - <<'PY'
import json
import os
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError as err:
    raise SystemExit("Pillow is required (apt install python3-pil, or pip install pillow)") from err

root = Path(os.environ["BL_ROOT"])
out = Path(os.environ["BL_OUT"])
src = (root / "assets/www/index.html").read_text()
data = json.loads(Path(os.environ["BL_FALLBACK"]).read_text())
blob = json.dumps(data, separators=(",", ":")).replace("<", "\\u003c")
html = src.replace("__FALLBACK_JSON__", blob)
if "__FALLBACK_JSON__" in html:
    raise SystemExit("fallback placeholder was not replaced")
html_out = out / "assets/www/index.html"
html_out.parent.mkdir(parents=True, exist_ok=True)
html_out.write_text(html)
print("html bytes", html_out.stat().st_size)
fallback = Path(os.environ["BL_FALLBACK"]).read_bytes()
(out / "assets/fallback-snapshot.json").write_bytes(fallback)

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

export BL_MANIFEST_SRC="$ROOT/AndroidManifest.xml" BL_MANIFEST_OUT="$OUT/AndroidManifest.xml"
python3 - <<'PY'
import os
import re
from pathlib import Path

text = Path(os.environ["BL_MANIFEST_SRC"]).read_text()
code = os.environ.get("VERSION_CODE", "")
name = os.environ.get("VERSION_NAME", "")
if code:
    new, n = re.subn(
        r'android:versionCode="[0-9]+"',
        f'android:versionCode="{code}"',
        text,
        count=1,
    )
    if n != 1:
        raise SystemExit("android:versionCode not found in AndroidManifest.xml")
    text = new
if name:
    if any(c in name for c in "<>&\"'"):
        raise SystemExit("VERSION_NAME contains characters that cannot go in the manifest")
    new, n = re.subn(
        r'android:versionName="[^"]*"',
        f'android:versionName="{name}"',
        text,
        count=1,
    )
    if n != 1:
        raise SystemExit("android:versionName not found in AndroidManifest.xml")
    text = new
Path(os.environ["BL_MANIFEST_OUT"]).write_text(text)
print("manifest versionCode", code or "(manifest)", "versionName", name or "(manifest)")
PY
MANIFEST="$OUT/AndroidManifest.xml"

"$BT/aapt2" compile -o "$OUT/compiled.zip" --dir "$ROOT/res"
"$BT/aapt2" link \
  -o "$OUT/linked.apk" \
  -I "$JAR" \
  --manifest "$MANIFEST" \
  --min-sdk-version 24 \
  --target-sdk-version 34 \
  --java "$OUT/gen" \
  -A "$OUT/assets" \
  "$OUT/compiled.zip"
"$BT/aapt2" link \
  --proto-format \
  -o "$OUT/proto.zip" \
  -I "$JAR" \
  --manifest "$MANIFEST" \
  --min-sdk-version 24 \
  --target-sdk-version 34 \
  -A "$OUT/assets" \
  "$OUT/compiled.zip"

"$BT/aapt2" dump resources "$OUT/linked.apk" > "$OUT/resources.txt"
python3 - <<'PY'
import os
import re
from pathlib import Path

out = Path(os.environ["BL_OUT"])
dump = (out / "resources.txt").read_text(errors="replace")
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
gen = out / "gen/androidx/car/app"
gen.mkdir(parents=True, exist_ok=True)
parts = ["package androidx.car.app;", "public final class R {"]
for kind, names in wanted.items():
    parts.append(f"  public static final class {kind} {{")
    for name in names:
        parts.append(f"    public static final int {name} = {found[kind][name]};")
    parts.append("  }")
parts.append("}")
(gen / "R.java").write_text("\n".join(parts) + "\n")
print("car R", found["integer"]["content_limit_list"])
PY

CP="$JAR"
for j in "${COMPILE_JARS[@]}"; do
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
printf '%s\n' "${DEX_JARS[@]}" > "$OUT/dex-jars.list"
"$BT/d8" --release --min-api 24 --lib "$JAR" --output "$OUT/dex" \
  @"$OUT/classes.list" @"$OUT/dex-jars.list"

python3 - <<'PY'
import os
import zipfile
from pathlib import Path

out = Path(os.environ["BL_OUT"])
unsigned = out / "unsigned.apk"
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

python3 - <<'PY'
import os
import zipfile
from pathlib import Path

out = Path(os.environ["BL_OUT"])
with zipfile.ZipFile(out / "proto.zip") as zin, zipfile.ZipFile(out / "base.zip", "w") as zout:
    names = zin.namelist()
    if "AndroidManifest.xml" not in names or "resources.pb" not in names:
        raise SystemExit("proto link did not produce AndroidManifest.xml and resources.pb")
    for info in zin.infolist():
        if info.is_dir() or info.filename.endswith("/"):
            continue
        if info.filename == "AndroidManifest.xml":
            name = "manifest/AndroidManifest.xml"
        elif info.filename.startswith("META-INF/") or info.filename.startswith("classes"):
            continue
        else:
            name = info.filename
        new = zipfile.ZipInfo(filename=name)
        new.compress_type = zipfile.ZIP_DEFLATED
        new.external_attr = 0
        zout.writestr(new, zin.read(info.filename))
    dex_files = sorted((out / "dex").glob("classes*.dex"))
    if not dex_files:
        raise SystemExit("no dex output for bundle")
    for dex_path in dex_files:
        dex_info = zipfile.ZipInfo(filename=f"dex/{dex_path.name}")
        dex_info.compress_type = zipfile.ZIP_STORED
        dex_info.external_attr = 0
        zout.writestr(dex_info, dex_path.read_bytes())
print("base module", (out / "base.zip").stat().st_size)
PY

if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -alias "$KS_ALIAS" \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$KS_STOREPASS" -keypass "$KS_KEYPASS" \
    -dname "CN=Blue Lot, OU=Blue Lot, O=Blue Lot, L=Hawthorne, ST=CA, C=US"
fi

export BL_KS_PASS="$KS_STOREPASS" BL_KEY_PASS="$KS_KEYPASS"
"$BT/zipalign" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"
"$BT/apksigner" sign \
  --ks "$KS" \
  --ks-key-alias "$KS_ALIAS" \
  --ks-pass env:BL_KS_PASS \
  --key-pass env:BL_KEY_PASS \
  --v1-signing-enabled true \
  --v2-signing-enabled true \
  --v3-signing-enabled true \
  --v4-signing-enabled false \
  --out "$OUT/Blue-Lot.apk" \
  "$OUT/aligned.apk"
"$BT/apksigner" verify --verbose "$OUT/Blue-Lot.apk"

java -jar "$BUNDLETOOL" build-bundle \
  --modules="$OUT/base.zip" \
  --output="$OUT/unsigned.aab"
jarsigner \
  -sigalg SHA256withRSA \
  -digestalg SHA-256 \
  -keystore "$KS" \
  -storepass "$KS_STOREPASS" \
  -keypass "$KS_KEYPASS" \
  -signedjar "$OUT/Blue-Lot.aab" \
  "$OUT/unsigned.aab" \
  "$KS_ALIAS"
jarsigner -verify "$OUT/Blue-Lot.aab"
java -jar "$BUNDLETOOL" validate --bundle="$OUT/Blue-Lot.aab"

if [ -f "$BT/aapt" ]; then
  "$BT/aapt" dump badging "$OUT/Blue-Lot.apk" > "$OUT/badging.txt"
else
  "$BT/aapt2" dump badging "$OUT/Blue-Lot.apk" > "$OUT/badging.txt"
fi
java -jar "$BUNDLETOOL" dump manifest --bundle="$OUT/Blue-Lot.aab" > "$OUT/aab-manifest.txt"
if [ -n "${VERSION_CODE:-}" ] && ! grep -q "versionCode='${VERSION_CODE}'" "$OUT/badging.txt"; then
  die "APK versionCode does not match VERSION_CODE=${VERSION_CODE}"
fi
if [ -n "${VERSION_NAME:-}" ] && ! grep -q "versionName='${VERSION_NAME}'" "$OUT/badging.txt"; then
  die "APK versionName does not match VERSION_NAME=${VERSION_NAME}"
fi
if [ -n "${VERSION_CODE:-}" ] && ! grep -q "android:versionCode=\"${VERSION_CODE}\"" "$OUT/aab-manifest.txt"; then
  die "AAB versionCode does not match VERSION_CODE=${VERSION_CODE}"
fi
if [ -n "${VERSION_NAME:-}" ] && ! grep -q "android:versionName=\"${VERSION_NAME}\"" "$OUT/aab-manifest.txt"; then
  die "AAB versionName does not match VERSION_NAME=${VERSION_NAME}"
fi

echo "Signing certificate:"
keytool -list -v -keystore "$KS" -alias "$KS_ALIAS" -storepass "$KS_STOREPASS" > "$OUT/cert.txt"
grep -E 'Alias name:|SHA1:|SHA256:' "$OUT/cert.txt" || true
head -30 "$OUT/badging.txt"
head -20 "$OUT/aab-manifest.txt"

mkdir -p "$ARTIFACTS"
cp "$OUT/Blue-Lot.apk" "$ARTIFACTS/Blue-Lot.apk"
cp "$OUT/Blue-Lot.aab" "$ARTIFACTS/Blue-Lot.aab"
ls -lh "$ARTIFACTS/Blue-Lot.apk" "$ARTIFACTS/Blue-Lot.aab"
echo BUILD_OK
