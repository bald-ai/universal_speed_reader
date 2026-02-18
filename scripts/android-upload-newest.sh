#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ANDROID_DIR="$ROOT_DIR/android"
APK_OUTPUT_DIR="$ANDROID_DIR/app/build/outputs/apk"
PACKAGE_NAME="com.traycer.speedreader"
ADB_BIN="${ADB:-adb}"

usage() {
  cat <<'EOF'
Build and install the newest Android APK to a connected phone.

Usage:
  bun run android:upload-newest [-- --serial <device_id>] [--skip-build]

Options:
  --serial <device_id>  Use a specific adb device serial.
  --skip-build          Skip build steps and install newest already-built APK.
  -h, --help            Show this help message.
EOF
}

SERIAL=""
SKIP_BUILD=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --serial)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --serial" >&2
        exit 1
      fi
      SERIAL="$2"
      shift 2
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if ! command -v "$ADB_BIN" >/dev/null 2>&1; then
  echo "adb not found. Install Android platform-tools or set ADB=/path/to/adb." >&2
  exit 1
fi

ADB_CMD=("$ADB_BIN")
if [[ -n "$SERIAL" ]]; then
  ADB_CMD+=("-s" "$SERIAL")
fi

DEVICE_STATE="$("${ADB_CMD[@]}" get-state 2>/dev/null || true)"
if [[ "$DEVICE_STATE" != "device" ]]; then
  echo "No ready adb device found." >&2
  echo "Connected devices:" >&2
  "$ADB_BIN" devices -l >&2 || true
  exit 1
fi

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  echo "Building web assets and syncing Android project..."
  (cd "$ROOT_DIR" && bun run android:buildsync)

  echo "Building debug APK..."
  (cd "$ANDROID_DIR" && ./gradlew assembleDebug)
fi

APK_CANDIDATES=()
while IFS= read -r apk_path; do
  APK_CANDIDATES+=("$apk_path")
done < <(find "$APK_OUTPUT_DIR" -type f -name "*.apk" ! -name "*unaligned*")
if [[ "${#APK_CANDIDATES[@]}" -eq 0 ]]; then
  echo "No APK found under $APK_OUTPUT_DIR" >&2
  exit 1
fi

LATEST_APK="$(ls -t "${APK_CANDIDATES[@]}" | head -n 1)"

echo "Installing: $LATEST_APK"
"${ADB_CMD[@]}" install -r -d "$LATEST_APK"

echo "Launching app: $PACKAGE_NAME"
"${ADB_CMD[@]}" shell monkey -p "$PACKAGE_NAME" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true

echo "Done."
