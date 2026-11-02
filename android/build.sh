#!/bin/bash
# Build the Blue Lot APK and Play App Bundle without Gradle.
#
# Defaults match a checkout of this repo plus a normal Android SDK
# (ANDROID_SDK_ROOT or ANDROID_HOME, build-tools/36.1.0, platforms/android-36).
# The old single-machine layout still works when those directories exist:
#   ANDROID_SDK_ROOT=/tmp/android-sdk          (android-14/ and android-36/)
#   BLUELOT_CAR_LIBS=/tmp/car-libs             (classes.jar and cp/*.jar)
#   BLUELOT_FALLBACK_SNAPSHOT=/path/to/fallback-snapshot.json
#   BLUELOT_ARTIFACTS=/workspace/artifacts
#
# Dependency jars and bundletool are downloaded into android/.car-libs and
# android/.bundletool when they are not already there.
#
# The Car App Library reads car-app-api.level through the app ClassLoader
# during the host handshake (AppInfo / CarAppApiLevels.getLatest). d8 does
# not copy that file out of the jar, so the APK and the bundle root must
# contain it. Without it getAppInfo throws IllegalStateException before the
# host callback, and Android Auto reports "isn't responding".
#
# CI (GITHUB_ACTIONS=true) must set KEYSTORE_BASE64, KEYSTORE_PASSWORD,
# KEY_ALIAS, and KEY_PASSWORD. A missing secret fails the build. Local runs
# reuse android/bluelot.keystore, or create one, with alias bluelot.
#
# Optional overrides: VERSION_CODE, VERSION_NAME, ANDROID_BUILD_TOOLS,
# ANDROID_JAR, BUNDLETOOL_JAR, BLUELOT_ANDROID_ROOT, BLUELOT_REPO_ROOT.
set -euo pipefail

BUNDLETOOL_VERSION=1.18.3
GMAVEN=https://dl.google.com/dl/android/maven2
CENTRAL=https://repo1.maven.org/maven2
# Play Console application id. The Java sources stay in com.bluelot.app.
APP_ID=com.duxstad.bluelotchargers
JAVA_PACKAGE=com.bluelot.app

ensure_jar() {
  local dest="$1"
  local url="$2"
  if [ -s "$dest" ]; then
    return 0
  fi
  mkdir -p "$(dirname "$dest")"
  echo "fetch $(basename "$dest")"
  curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 20 -o "$dest.partial" "$url"
  python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).namelist()' "$dest.partial"
  mv "$dest.partial" "$dest"
}

ensure_aar_classes() {
  local dest="$1"
  local url="$2"
  local tmp
  if [ -s "$dest" ]; then
    return 0
  fi
  mkdir -p "$(dirname "$dest")"
  echo "fetch $(basename "$dest")"
  tmp=$(mktemp)
  curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 20 -o "$tmp" "$url"
  python3 -c 'import sys, zipfile; from pathlib import Path; src, dest = sys.argv[1:]; z = zipfile.ZipFile(src); Path(dest).write_bytes(z.read("classes.jar"))' \
    "$tmp" "$dest.partial"
  rm -f "$tmp"
  mv "$dest.partial" "$dest"
}

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "${BLUELOT_ANDROID_ROOT:-$SCRIPT_DIR}" && pwd)
REPO_ROOT=$(cd "${BLUELOT_REPO_ROOT:-$SCRIPT_DIR/..}" && pwd)
FALLBACK=${BLUELOT_FALLBACK_SNAPSHOT:-$REPO_ROOT/src/lib/fallback-snapshot.json}
ARTIFACTS=${BLUELOT_ARTIFACTS:-$REPO_ROOT/artifacts}
LIBS=${BLUELOT_CAR_LIBS:-$ROOT/.car-libs}
OUT=$ROOT/build

for cmd in java javac keytool jarsigner python3 curl base64; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "required command not found: $cmd" >&2
    exit 1
  fi
done

if [ ! -f "$FALLBACK" ]; then
  echo "fallback snapshot not found: $FALLBACK" >&2
  exit 1
fi

use_secret_keystore=false
if [ "${GITHUB_ACTIONS:-}" = "true" ] || [ -n "${KEYSTORE_BASE64:-}${KEYSTORE_PASSWORD:-}${KEY_ALIAS:-}${KEY_PASSWORD:-}" ]; then
  missing=()
  [ -n "${KEYSTORE_BASE64:-}" ] || missing+=("KEYSTORE_BASE64")
  [ -n "${KEYSTORE_PASSWORD:-}" ] || missing+=("KEYSTORE_PASSWORD")
  [ -n "${KEY_ALIAS:-}" ] || missing+=("KEY_ALIAS")
  [ -n "${KEY_PASSWORD:-}" ] || missing+=("KEY_PASSWORD")
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "Refusing to generate a keystore." >&2
    echo "Missing signing secret(s): ${missing[*]}" >&2
    echo "Set GitHub Actions secrets KEYSTORE_BASE64, KEYSTORE_PASSWORD, KEY_ALIAS, and KEY_PASSWORD." >&2
    echo "Play rejects a release when the upload key changes between runs." >&2
    exit 1
  fi
  use_secret_keystore=true
fi

if [ -n "${ANDROID_SDK_ROOT:-}" ]; then
  SDK=$ANDROID_SDK_ROOT
elif [ -n "${ANDROID_HOME:-}" ]; then
  SDK=$ANDROID_HOME
elif [ -d /tmp/android-sdk ]; then
  SDK=/tmp/android-sdk
else
  echo "Android SDK not found. Set ANDROID_SDK_ROOT or ANDROID_HOME." >&2
  echo "Install platforms;android-36 and build-tools;36.1.0." >&2
  exit 1
fi

if [ -n "${ANDROID_BUILD_TOOLS:-}" ]; then
  BT=$ANDROID_BUILD_TOOLS
elif [ -x "$SDK/build-tools/36.1.0/aapt2" ]; then
  BT=$SDK/build-tools/36.1.0
elif [ -x "$SDK/android-14/aapt2" ]; then
  BT=$SDK/android-14
else
  echo "aapt2 not found. Install build-tools 36.1.0 under $SDK or set ANDROID_BUILD_TOOLS." >&2
  exit 1
fi

if [ -n "${ANDROID_JAR:-}" ]; then
  JAR=$ANDROID_JAR
elif [ -f "$SDK/platforms/android-36/android.jar" ]; then
  JAR=$SDK/platforms/android-36/android.jar
elif [ -f "$SDK/android-36/android.jar" ]; then
  JAR=$SDK/android-36/android.jar
else
  echo "android.jar not found. Install platforms;android-36 under $SDK or set ANDROID_JAR." >&2
  exit 1
fi

for tool in aapt aapt2 d8 zipalign apksigner; do
  if [ ! -x "$BT/$tool" ] && [ ! -f "$BT/$tool" ]; then
    echo "missing build-tools command: $BT/$tool" >&2
    exit 1
  fi
done

# 1.7.0 speaks Car API level 8. 1.4.0 stops at 7 and rejects newer Android Auto hosts.
CAR_APP_JAR=$LIBS/car-app-1.7.0.jar
ensure_aar_classes "$CAR_APP_JAR" "$GMAVEN/androidx/car/app/app/1.7.0/app-1.7.0.aar"
ensure_jar "$LIBS/cp/kotlin-stdlib-1.8.22.jar" "$CENTRAL/org/jetbrains/kotlin/kotlin-stdlib/1.8.22/kotlin-stdlib-1.8.22.jar"
ensure_aar_classes "$LIBS/cp/core-1.7.0.jar" "$GMAVEN/androidx/core/core/1.7.0/core-1.7.0.aar"
ensure_aar_classes "$LIBS/cp/lifecycle-runtime-2.3.1.jar" "$GMAVEN/androidx/lifecycle/lifecycle-runtime/2.3.1/lifecycle-runtime-2.3.1.aar"
ensure_jar "$LIBS/cp/lifecycle-common-2.3.1.jar" "$GMAVEN/androidx/lifecycle/lifecycle-common/2.3.1/lifecycle-common-2.3.1.jar"
ensure_jar "$LIBS/cp/lifecycle-common-java8-2.2.0.jar" "$GMAVEN/androidx/lifecycle/lifecycle-common-java8/2.2.0/lifecycle-common-java8-2.2.0.jar"
ensure_aar_classes "$LIBS/cp/lifecycle-viewmodel-2.3.0.jar" "$GMAVEN/androidx/lifecycle/lifecycle-viewmodel/2.3.0/lifecycle-viewmodel-2.3.0.aar"
ensure_aar_classes "$LIBS/cp/savedstate-1.1.0.jar" "$GMAVEN/androidx/savedstate/savedstate/1.1.0/savedstate-1.1.0.aar"
ensure_aar_classes "$LIBS/cp/activity-1.2.0.jar" "$GMAVEN/androidx/activity/activity/1.2.0/activity-1.2.0.aar"
ensure_jar "$LIBS/cp/annotation-1.2.0.jar" "$GMAVEN/androidx/annotation/annotation/1.2.0/annotation-1.2.0.jar"
ensure_jar "$LIBS/cp/collection-1.0.0.jar" "$GMAVEN/androidx/collection/collection/1.0.0/collection-1.0.0.jar"
ensure_aar_classes "$LIBS/cp/versionedparcelable-1.1.1.jar" "$GMAVEN/androidx/versionedparcelable/versionedparcelable/1.1.1/versionedparcelable-1.1.1.aar"
ensure_aar_classes "$LIBS/cp/core-runtime-2.1.0.jar" "$GMAVEN/androidx/arch/core/core-runtime/2.1.0/core-runtime-2.1.0.aar"
ensure_jar "$LIBS/cp/core-common-2.1.0.jar" "$GMAVEN/androidx/arch/core/core-common/2.1.0/core-common-2.1.0.jar"
ensure_jar "$LIBS/cp/concurrent-futures-1.0.0.jar" "$GMAVEN/androidx/concurrent/concurrent-futures/1.0.0/concurrent-futures-1.0.0.jar"
ensure_jar "$LIBS/cp/guava-31.1-android.jar" "$CENTRAL/com/google/guava/guava/31.1-android/guava-31.1-android.jar"
ensure_jar "$LIBS/cp/failureaccess-1.0.1.jar" "$CENTRAL/com/google/guava/failureaccess/1.0.1/failureaccess-1.0.1.jar"

python3 - "$CAR_APP_JAR" <<'PY'
import sys
import zipfile
jar = zipfile.ZipFile(sys.argv[1])
names = jar.namelist()
if "androidx/car/app/CarAppService.class" not in names:
    raise SystemExit(f"car library jar is missing androidx.car.app.CarAppService: {sys.argv[1]}")
if "car-app-api.level" not in names:
    raise SystemExit(f"car library jar is missing car-app-api.level: {sys.argv[1]}")
level = jar.read("car-app-api.level").decode().strip()
if not level.isdigit() or int(level) < 8:
    raise SystemExit(f"car-app-api.level is {level!r}; Android Auto hosts newer than that are rejected")
print("car library", level)
PY

if [ -n "${BUNDLETOOL_JAR:-}" ]; then
  if [ ! -s "$BUNDLETOOL_JAR" ]; then
    echo "BUNDLETOOL_JAR not found: $BUNDLETOOL_JAR" >&2
    exit 1
  fi
else
  BUNDLETOOL_JAR=$ROOT/.bundletool/bundletool-all-$BUNDLETOOL_VERSION.jar
  if [ ! -s "$BUNDLETOOL_JAR" ]; then
    mkdir -p "$(dirname "$BUNDLETOOL_JAR")"
    echo "fetch bundletool $BUNDLETOOL_VERSION"
    curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 20 -o "$BUNDLETOOL_JAR.partial" \
      "https://github.com/google/bundletool/releases/download/${BUNDLETOOL_VERSION}/bundletool-all-${BUNDLETOOL_VERSION}.jar"
    mv "$BUNDLETOOL_JAR.partial" "$BUNDLETOOL_JAR"
  fi
fi

case "$OUT" in
  /*/build) ;;
  *)
    echo "refusing to remove unexpected build directory: $OUT" >&2
    exit 1
    ;;
esac
rm -rf "$OUT"
mkdir -p "$OUT/classes" "$OUT/dex" "$OUT/assets/www" "$OUT/res" "$OUT/gen"
cp -a "$ROOT/res/." "$OUT/res/"

if [ "$use_secret_keystore" = true ]; then
  KS=$OUT/upload.keystore
  if ! printf '%s' "$KEYSTORE_BASE64" | base64 -d > "$KS.partial"; then
    echo "KEYSTORE_BASE64 is not valid base64." >&2
    exit 1
  fi
  mv "$KS.partial" "$KS"
  chmod 600 "$KS"
  if [ ! -s "$KS" ]; then
    echo "KEYSTORE_BASE64 decoded to an empty file." >&2
    exit 1
  fi
  if ! keytool -list -keystore "$KS" -alias "$KEY_ALIAS" -storepass:env KEYSTORE_PASSWORD >/dev/null; then
    echo "Could not read alias '$KEY_ALIAS' from the keystore. Check KEYSTORE_BASE64, KEYSTORE_PASSWORD, and KEY_ALIAS." >&2
    exit 1
  fi
else
  KS=$ROOT/bluelot.keystore
  export KEY_ALIAS=bluelot
  export KEYSTORE_PASSWORD=bluelot-install
  export KEY_PASSWORD=bluelot-install
  if [ ! -f "$KS" ]; then
    keytool -genkeypair -keystore "$KS" -alias "$KEY_ALIAS" \
      -keyalg RSA -keysize 2048 -validity 10000 \
      -storepass:env KEYSTORE_PASSWORD \
      -keypass:env KEY_PASSWORD \
      -dname "CN=Blue Lot, OU=Blue Lot, O=Blue Lot, L=Hawthorne, ST=CA, C=US"
  fi
fi

MANIFEST=$ROOT/AndroidManifest.xml
if [ -n "${VERSION_CODE:-}" ] || [ -n "${VERSION_NAME:-}" ]; then
  MANIFEST=$OUT/AndroidManifest.xml
  cp "$ROOT/AndroidManifest.xml" "$MANIFEST"
  python3 - "$MANIFEST" "${VERSION_CODE:-}" "${VERSION_NAME:-}" <<'PY'
import re
import sys
from pathlib import Path

path, code, name = sys.argv[1:]
text = Path(path).read_text(encoding="utf-8")
if code:
    if not code.isdigit() or not 1 <= int(code) <= 2100000000:
        raise SystemExit(f"invalid VERSION_CODE: {code}")
    text, n = re.subn(r'android:versionCode="\d+"', f'android:versionCode="{code}"', text, count=1)
    if n != 1:
        raise SystemExit("android:versionCode not found in manifest")
if name:
    if not re.fullmatch(r"[0-9A-Za-z.+_-]+", name):
        raise SystemExit(f"invalid VERSION_NAME: {name}")
    text, n = re.subn(r'android:versionName="[^"]*"', f'android:versionName="{name}"', text, count=1)
    if n != 1:
        raise SystemExit("android:versionName not found in manifest")
Path(path).write_text(text, encoding="utf-8")
print("version", code or "(manifest)", name or "(manifest)")
PY
fi

export ROOT OUT FALLBACK
export RES_DIR=$OUT/res
python3 - <<'PY'
import json
import os
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError as err:
    raise SystemExit("Pillow is required. Install python3-pil or pip install pillow.") from err

root = Path(os.environ["ROOT"])
out = Path(os.environ["OUT"])
res = Path(os.environ["RES_DIR"])
fallback_path = Path(os.environ["FALLBACK"])
src = (root / "assets/www/index.html").read_text(encoding="utf-8")
data = json.loads(fallback_path.read_text(encoding="utf-8"))
blob = json.dumps(data, separators=(",", ":")).replace("<", "\\u003c")
html = src.replace("__FALLBACK_JSON__", blob)
if "__FALLBACK_JSON__" in html:
    raise SystemExit("fallback placeholder was not replaced")
html_out = out / "assets/www/index.html"
html_out.parent.mkdir(parents=True, exist_ok=True)
html_out.write_text(html, encoding="utf-8")
print("html bytes", html_out.stat().st_size)
(out / "assets/fallback-snapshot.json").write_bytes(fallback_path.read_bytes())

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
    folder = res / name
    folder.mkdir(parents=True, exist_ok=True)
    icon(size).save(folder / "ic_launcher.png")
print("icons ok")
PY

"$BT/aapt2" compile -o "$OUT/compiled.zip" --dir "$OUT/res"
"$BT/aapt2" link \
  -o "$OUT/linked.apk" \
  -I "$JAR" \
  --manifest "$MANIFEST" \
  --rename-manifest-package "$APP_ID" \
  --custom-package "$JAVA_PACKAGE" \
  --min-sdk-version 24 \
  --target-sdk-version 36 \
  --java "$OUT/gen" \
  -A "$OUT/assets" \
  "$OUT/compiled.zip"

"$BT/aapt2" dump resources "$OUT/linked.apk" > "$OUT/resources.txt"
export OUT
python3 - <<'PY'
import os
import re
from pathlib import Path

dump = Path(os.environ["OUT"], "resources.txt").read_text(encoding="utf-8", errors="replace")
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
        match = re.search(rf"resource (0x[0-9a-fA-F]+) (?:\S+:)?{kind}/{name}\b", dump)
        if not match:
            match = re.search(rf"(0x[0-9a-fA-F]+).*{kind}/{name}\b", dump)
        if not match:
            raise SystemExit(f"missing resource id for {kind}/{name}")
        found[kind][name] = match.group(1)
out = Path(os.environ["OUT"], "gen/androidx/car/app")
out.mkdir(parents=True, exist_ok=True)
parts = ["package androidx.car.app;", "public final class R {"]
for kind, names in wanted.items():
    parts.append(f"  public static final class {kind} {{")
    for name in names:
        parts.append(f"    public static final int {name} = {found[kind][name]};")
    parts.append("  }")
parts.append("}")
(out / "R.java").write_text("\n".join(parts) + "\n", encoding="utf-8")
print("car R", found["integer"]["content_limit_list"])
PY

CP_JARS=(
  "$JAR"
  "$CAR_APP_JAR"
  "$LIBS/cp/core-1.7.0.jar"
  "$LIBS/cp/lifecycle-runtime-2.3.1.jar"
  "$LIBS/cp/lifecycle-common-2.3.1.jar"
  "$LIBS/cp/lifecycle-common-java8-2.2.0.jar"
  "$LIBS/cp/lifecycle-viewmodel-2.3.0.jar"
  "$LIBS/cp/savedstate-1.1.0.jar"
  "$LIBS/cp/activity-1.2.0.jar"
  "$LIBS/cp/annotation-1.2.0.jar"
  "$LIBS/cp/collection-1.0.0.jar"
  "$LIBS/cp/versionedparcelable-1.1.1.jar"
  "$LIBS/cp/core-runtime-2.1.0.jar"
  "$LIBS/cp/core-common-2.1.0.jar"
  "$LIBS/cp/concurrent-futures-1.0.0.jar"
  "$LIBS/cp/guava-31.1-android.jar"
  "$LIBS/cp/failureaccess-1.0.1.jar"
)
CP=$(
  IFS=:
  printf '%s' "${CP_JARS[*]}"
)

javac --release 8 -encoding UTF-8 -classpath "$CP" -d "$OUT/classes" \
  "$ROOT/java/com/bluelot/app/MainActivity.java" \
  "$ROOT/java/com/bluelot/app/ChargerFeed.java" \
  "$ROOT/java/com/bluelot/app/ChargerCarService.java" \
  "$ROOT/java/com/bluelot/app/StallAlerts.java" \
  "$ROOT/java/com/bluelot/app/NotifyReceiver.java" \
  "$OUT/gen/androidx/car/app/R.java" \
  "$OUT/gen/com/bluelot/app/R.java"

find "$OUT/classes" -name '*.class' > "$OUT/classes.list"
DEX_JARS=(
  "$CAR_APP_JAR"
  "$LIBS/cp/kotlin-stdlib-1.8.22.jar"
  "$LIBS/cp/core-1.7.0.jar"
  "$LIBS/cp/lifecycle-runtime-2.3.1.jar"
  "$LIBS/cp/lifecycle-common-2.3.1.jar"
  "$LIBS/cp/lifecycle-common-java8-2.2.0.jar"
  "$LIBS/cp/lifecycle-viewmodel-2.3.0.jar"
  "$LIBS/cp/savedstate-1.1.0.jar"
  "$LIBS/cp/activity-1.2.0.jar"
  "$LIBS/cp/collection-1.0.0.jar"
  "$LIBS/cp/versionedparcelable-1.1.1.jar"
  "$LIBS/cp/core-runtime-2.1.0.jar"
  "$LIBS/cp/core-common-2.1.0.jar"
  "$LIBS/cp/concurrent-futures-1.0.0.jar"
  "$LIBS/cp/guava-31.1-android.jar"
  "$LIBS/cp/failureaccess-1.0.1.jar"
)
printf '%s\n' "${DEX_JARS[@]}" > "$OUT/dex-jars.list"
"$BT/d8" --release --min-api 24 --lib "$JAR" --output "$OUT/dex" \
  @"$OUT/classes.list" @"$OUT/dex-jars.list"

export OUT CAR_APP_JAR
python3 - <<'PY'
import os
import zipfile
from pathlib import Path

out = Path(os.environ["OUT"])
unsigned = out / "unsigned.apk"
src = out / "linked.apk"
level = zipfile.ZipFile(os.environ["CAR_APP_JAR"]).read("car-app-api.level")
if not level.decode().strip().isdigit():
    raise SystemExit("car-app-api.level is not an integer")
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
    level_info = zipfile.ZipInfo(filename="car-app-api.level")
    level_info.compress_type = zipfile.ZIP_STORED
    level_info.external_attr = 0
    zout.writestr(level_info, level)
print("unsigned", unsigned.stat().st_size, "car-app-api.level", level.decode().strip())
PY

"$BT/aapt2" link \
  --proto-format \
  -o "$OUT/base-proto.zip" \
  -I "$JAR" \
  --manifest "$MANIFEST" \
  --rename-manifest-package "$APP_ID" \
  --min-sdk-version 24 \
  --target-sdk-version 36 \
  -A "$OUT/assets" \
  "$OUT/compiled.zip"

export OUT CAR_APP_JAR
python3 - <<'PY'
import os
import zipfile
from pathlib import Path

out = Path(os.environ["OUT"])
proto = out / "base-proto.zip"
module = out / "base.zip"
dex_files = sorted((out / "dex").glob("classes*.dex"))
if not dex_files:
    raise SystemExit("no dex output")
level = zipfile.ZipFile(os.environ["CAR_APP_JAR"]).read("car-app-api.level")
with zipfile.ZipFile(proto) as zin, zipfile.ZipFile(module, "w") as zout:
    names = zin.namelist()
    if "AndroidManifest.xml" not in names or "resources.pb" not in names:
        raise SystemExit("proto link output is missing AndroidManifest.xml or resources.pb: " + ", ".join(names[:20]))

    def put(arc: str, data: bytes) -> None:
        info = zipfile.ZipInfo(filename=arc)
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0
        zout.writestr(info, data)

    put("manifest/AndroidManifest.xml", zin.read("AndroidManifest.xml"))
    put("resources.pb", zin.read("resources.pb"))
    for name in names:
        if name.endswith("/"):
            continue
        if name.startswith("res/") or name.startswith("assets/"):
            put(name, zin.read(name))
    for dex_path in dex_files:
        put(f"dex/{dex_path.name}", dex_path.read_bytes())
    # ClassLoader.getResourceAsStream("car-app-api.level") reads this from the APK root.
    put("root/car-app-api.level", level)
print("module entries", len(zipfile.ZipFile(module).namelist()))
PY

java -jar "$BUNDLETOOL_JAR" build-bundle \
  --modules="$OUT/base.zip" \
  --output="$OUT/Blue-Lot.unsigned.aab"

"$BT/zipalign" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"
"$BT/apksigner" sign \
  --ks "$KS" \
  --ks-key-alias "$KEY_ALIAS" \
  --ks-pass env:KEYSTORE_PASSWORD \
  --key-pass env:KEY_PASSWORD \
  --v1-signing-enabled true \
  --v2-signing-enabled true \
  --v3-signing-enabled true \
  --v4-signing-enabled false \
  --out "$OUT/Blue-Lot.apk" \
  "$OUT/aligned.apk"
"$BT/apksigner" verify "$OUT/Blue-Lot.apk"

jarsigner \
  -sigalg SHA256withRSA \
  -digestalg SHA-256 \
  -keystore "$KS" \
  -storepass:env KEYSTORE_PASSWORD \
  -keypass:env KEY_PASSWORD \
  -signedjar "$OUT/Blue-Lot.aab" \
  "$OUT/Blue-Lot.unsigned.aab" \
  "$KEY_ALIAS"
verify_out=$(jarsigner -verify "$OUT/Blue-Lot.aab" 2>&1)
printf '%s\n' "$verify_out"
case "$verify_out" in
  *"jar verified"*) ;;
  *)
    echo "AAB signature verification failed" >&2
    exit 1
    ;;
esac

java -jar "$BUNDLETOOL_JAR" validate --bundle="$OUT/Blue-Lot.aab"
java -jar "$BUNDLETOOL_JAR" dump manifest --bundle="$OUT/Blue-Lot.aab" > "$OUT/aab-manifest.xml"
python3 - "$OUT/aab-manifest.xml" "${VERSION_CODE:-}" "${VERSION_NAME:-}" "$APP_ID" <<'PY'
import re
import sys
from pathlib import Path

text = Path(sys.argv[1]).read_text(encoding="utf-8")
print("\n".join(text.splitlines()[:15]))
code, name, app_id = sys.argv[2], sys.argv[3], sys.argv[4]
if f'package="{app_id}"' not in text:
    raise SystemExit(f"AAB package is not {app_id}")
found_code = re.search(r'versionCode="(\d+)"', text)
found_name = re.search(r'versionName="([^"]*)"', text)
if found_code is None or found_name is None:
    raise SystemExit("AAB manifest is missing versionCode or versionName")
if code and found_code.group(1) != code:
    raise SystemExit(f"AAB versionCode is {found_code.group(1)}, expected {code}")
if name and found_name.group(1) != name:
    raise SystemExit(f"AAB versionName is {found_name.group(1)}, expected {name}")
flat = re.sub(r"\s+", " ", text)
for needle in (
    "androidx.car.app.CarAppService",
    "androidx.car.app.category.POI",
    "androidx.car.app.minCarApiLevel",
    "ChargerCarService",
):
    if needle not in flat:
        raise SystemExit(f"AAB manifest is missing {needle}")
for banned in (
    "androidx.car.app.category.CHARGING",
    "androidx.car.app.category.PARKING",
):
    if banned in flat:
        raise SystemExit(f"AAB manifest still declares {banned}")
if "ChargerMediaService" in flat or "MediaBrowserService" in flat:
    raise SystemExit("AAB manifest still registers the media workaround")
if re.search(r'appCategory="audio"', flat):
    raise SystemExit("AAB manifest still marks the app as an audio app")
if not re.search(
    r'minCarApiLevel" android:value="1"|android:value="1" android:name="androidx.car.app.minCarApiLevel"',
    flat,
):
    raise SystemExit("AAB manifest minCarApiLevel is not 1")
print("aab", found_code.group(1), found_name.group(1), "poi")
PY

badging=$("$BT/aapt" dump badging "$OUT/Blue-Lot.apk")
printf '%s\n' "$badging" | head -30 || true
case "$badging" in
  *"name='${APP_ID}'"*) ;;
  *)
    echo "APK package is not $APP_ID" >&2
    exit 1
    ;;
esac
if [ -n "${VERSION_CODE:-}" ]; then
  case "$badging" in
    *"versionCode='${VERSION_CODE}'"*) ;;
    *)
      echo "APK versionCode does not match VERSION_CODE=$VERSION_CODE" >&2
      exit 1
      ;;
  esac
fi
if [ -n "${VERSION_NAME:-}" ]; then
  case "$badging" in
    *"versionName='${VERSION_NAME}'"*) ;;
    *)
      echo "APK versionName does not match VERSION_NAME=$VERSION_NAME" >&2
      exit 1
      ;;
  esac
fi

auto_xml=$("$BT/aapt" dump xmltree "$OUT/Blue-Lot.apk" res/xml/automotive_app_desc.xml)
printf '%s\n' "$auto_xml"
case "$auto_xml" in
  *'="template"'*) ;;
  *)
    echo "automotive_app_desc does not declare the template car app" >&2
    exit 1
    ;;
esac
case "$auto_xml" in
  *'="media"'*)
    echo "automotive_app_desc still declares a media app" >&2
    exit 1
    ;;
esac

python3 - "$OUT/Blue-Lot.apk" "$OUT/Blue-Lot.aab" <<'PY'
import sys
import zipfile

apk_path, aab_path = sys.argv[1:]
apk = zipfile.ZipFile(apk_path)
if "car-app-api.level" not in apk.namelist():
    raise SystemExit("APK is missing car-app-api.level; the host handshake cannot read the library API level")
level = apk.read("car-app-api.level").decode().strip()
if not level.isdigit() or int(level) < 8:
    raise SystemExit(f"APK car-app-api.level is {level!r}")
dex = b"".join(apk.read(name) for name in apk.namelist() if name.startswith("classes") and name.endswith(".dex"))
for marker in (b"car-app-api.level", b"ChargerCarService", b"CarAppService"):
    if marker not in dex:
        raise SystemExit(f"dex is missing {marker.decode()}")
aab = zipfile.ZipFile(aab_path)
matches = [name for name in aab.namelist() if name.endswith("car-app-api.level")]
if not matches:
    raise SystemExit("AAB is missing car-app-api.level")
bundled = aab.read(matches[0]).decode().strip()
if bundled != level:
    raise SystemExit(f"AAB car-app-api.level is {bundled!r}, APK has {level!r}")
print("car-app-api.level", level, "in apk and", matches[0])
PY

mkdir -p "$ARTIFACTS"
cp "$OUT/Blue-Lot.apk" "$ARTIFACTS/Blue-Lot.apk"
cp "$OUT/Blue-Lot.aab" "$ARTIFACTS/Blue-Lot.aab"
ls -lh "$ARTIFACTS/Blue-Lot.apk" "$ARTIFACTS/Blue-Lot.aab"
echo BUILD_OK
