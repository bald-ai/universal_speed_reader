# Reusable Android Phone Control Playbook

This playbook is for extended Android-phone workloads controlled through ADB. It is intentionally project-neutral: native Android apps, Capacitor apps, installable PWAs, browser-based mobile apps, cross-app comparisons, and phone-file workflows can all use it.

Project-specific instructions always win. Before using this playbook, read the target repository's `AGENTS.md`, project documentation, package-ID registry, build scripts, and validation requirements.

## When to use this playbook

Read and apply it for sustained phone work such as:

- multi-step UI automation;
- repeated build/install/test cycles;
- long-running imports, GPS checks, media processing, or background services;
- cross-app comparisons;
- repeated screenshot, UI hierarchy, log, database, or preferences capture;
- a full on-device regression or interaction matrix;
- work that must survive reconnects, lock-screen interruptions, or a safe pause.

Do not load it for a simple one-off action such as:

- installing or launching one app;
- checking whether ADB is connected;
- pulling one known file;
- taking one requested screenshot;
- running a basic launch smoke check.

For those tasks, follow the repository's short local instructions directly.

## Core operating model

Efficient phone control is a closed loop:

> Establish state -> perform one bounded action group -> verify through the strongest available channel -> continue or diagnose.

The biggest speed gains come from:

- resolving project variables before touching the phone;
- using one explicit device serial throughout the session;
- building and installing once per coherent revision;
- batching deterministic actions;
- inspecting UI only at meaningful state boundaries;
- using package data, app state, logs, or persistence instead of screenshots alone;
- preserving evidence before starting unrelated report or presentation work;
- restoring temporary phone settings automatically.

## 1. Resolve the project adapter first

This playbook must not guess a project's identity. Determine these values from the repository before running phone commands:

| Variable | Meaning | Typical source |
|---|---|---|
| `PROJECT_ROOT` | Repository root | Current workspace |
| `PACKAGE` | Installed Android application ID | `build.gradle`, manifest, Capacitor config, or project registry |
| `APK` | Exact APK to install | Gradle output or project build helper |
| `BUILD_COMMAND` | Supported build command | `AGENTS.md`, README, or package scripts |
| `INSTALL_COMMAND` | Project-approved install helper or `adb install` | `AGENTS.md` or scripts |
| `LAUNCH_COMPONENT` | Optional explicit activity component | Manifest or `cmd package resolve-activity` |
| `LOG_FILTER` | Package and useful app log tags | Source and project docs |
| `EVIDENCE_DIR` | Where screenshots, XML, logs, and recordings belong | Existing project convention |
| `TEST_MATRIX` | Exact states that must pass | User request and project requirements |

Write them down before acting. A project-specific value in an example below is illustrative only and must never be copied blindly.

Example adapter:

```bash
PROJECT_ROOT="/path/to/project"
PACKAGE="com.example.application"
APK="$PROJECT_ROOT/app/build/outputs/apk/debug/app-debug.apk"
EVIDENCE_DIR="$PROJECT_ROOT/validation_artifacts"
```

If the repository has a shared application-ID registry, verify against it before installation. Never use `adb uninstall` as an automatic repair for an install failure; a package collision or signing mismatch must be diagnosed first.

## 2. Establish ADB and select one device

Use the configured ADB binary. On this Mac the common SDK location is:

```bash
ADB="${ADB:-/Users/michalkrsik/Library/Android/sdk/platform-tools/adb}"
```

List devices before every extended session:

```bash
"$ADB" devices -l
```

Select the device explicitly. Never rely on ADB's default target when an emulator, stale Wi-Fi endpoint, or second phone may be present.

Reusable model-based selection:

```bash
DEVICE_MODEL="${DEVICE_MODEL:-A001}"
SERIAL="${ANDROID_SERIAL:-}"

if [ -z "$SERIAL" ]; then
  SERIAL=$("$ADB" devices -l | awk -v model="$DEVICE_MODEL" \
    '$2 == "device" && $0 ~ ("model:" model "([[:space:]]|$)") {print $1; exit}')
fi

if [ -z "$SERIAL" ]; then
  echo "No ready device matched model $DEVICE_MODEL"
  "$ADB" devices -l
  exit 1
fi

"$ADB" -s "$SERIAL" get-state
echo "Using $SERIAL"
```

`A001` is the local Nothing Phone example, not a universal requirement. Another project or device should set `DEVICE_MODEL` or `ANDROID_SERIAL` explicitly.

### Optional local Wi-Fi keeper

This Mac may run `com.michalkrsik.adb-wifi-keeper`. It maintains the local Nothing Phone's fixed Wi-Fi ADB endpoint on port `5555`, retries the last IP, and scans the current `en0` network when DHCP changes the phone address.

When that helper exists:

1. Run `adb devices -l`.
2. Allow up to 25 seconds for automatic recovery.
3. Confirm the helper before manually scanning or pairing:

   ```bash
   launchctl print "gui/$(id -u)/com.michalkrsik.adb-wifi-keeper" \
     | sed -n '1,100p'
   ```

4. Inspect its cached IP when necessary:

   ```bash
   sed -n '1p' /Users/michalkrsik/Library/Caches/adb-wifi-keeper/last-ip
   ```

This keeper is a local accelerator, not a requirement for the playbook. On another machine, use that environment's normal USB or wireless-debugging connection process.

## 3. Protect a long session from phone lifecycle interruptions

Before an extended interactive or background run:

1. Check focus and lock state.
2. Wake the device.
3. Use the repository-authorized unlock flow.
4. Verify the device is actually unlocked.
5. Save and temporarily adjust screen timeout or stay-awake settings if the workload needs it.
6. Restore the exact previous settings on exit, interruption, or safe pause.

Reusable timeout guard:

```bash
OLD_TIMEOUT=$("$ADB" -s "$SERIAL" shell settings get system screen_off_timeout | tr -d '\r')
OLD_STAY=$("$ADB" -s "$SERIAL" shell settings get global stay_on_while_plugged_in | tr -d '\r')

restore_phone_settings() {
  "$ADB" -s "$SERIAL" shell settings put system screen_off_timeout "$OLD_TIMEOUT"
  if [ "$OLD_STAY" = "null" ]; then
    "$ADB" -s "$SERIAL" shell settings delete global stay_on_while_plugged_in
  else
    "$ADB" -s "$SERIAL" shell settings put global stay_on_while_plugged_in "$OLD_STAY"
  fi
}

trap restore_phone_settings EXIT INT TERM

"$ADB" -s "$SERIAL" shell settings put system screen_off_timeout 1800000
"$ADB" -s "$SERIAL" shell svc power stayon true
"$ADB" -s "$SERIAL" shell input keyevent KEYCODE_WAKEUP
"$ADB" -s "$SERIAL" shell input keyevent KEYCODE_MENU
```

Do not embed an unlock assumption here. Use the project's documented, authorized device flow and confirm the expected lock-screen element before entering credentials.

Verify current focus afterward:

```bash
"$ADB" -s "$SERIAL" shell dumpsys window \
  | rg 'mDreamingLockscreen|mCurrentFocus|mKeyguardUnlocked|isKeyguardShowing'
```

## 4. Define the test matrix before installation

Turn the user request into explicit states. Example for a generic interactive feature:

```text
Build identity is correct
  -> app launches
  -> target screen opens
  -> primary action changes state
  -> state survives navigation or restart if required
  -> negative case behaves correctly
  -> no fatal logs
  -> final evidence saved
  -> temporary phone settings restored
```

For an extended workload, distinguish:

- automated assertions;
- UI states that can be proven from accessibility data;
- visual judgments requiring screenshots;
- internal state requiring preferences, database, or app-specific APIs;
- steps that Android may require the user to approve manually.

This avoids exploratory tapping and prevents the definition of “done” from changing mid-run.

## 5. Build once and prove the artifact

Use the repository's approved build path. Common examples follow.

### Native Gradle example

```bash
cd "$PROJECT_ROOT"
./gradlew assembleDebug
```

### Capacitor example

```bash
cd "$PROJECT_ROOT"
npm run build
npx cap sync android
(cd android && ./gradlew assembleDebug)
```

The real command may use `bun`, a project script, a different module, or a configured JDK. Repository instructions override these examples.

### Installable PWA example

A PWA may have no APK. Build and serve/deploy it using the project's supported command, then open its URL in the intended Android browser. Do not invent an APK install flow for a browser application.

### Verify APK identity

When an APK exists, inspect its embedded package before installation:

```bash
AAPT=$(find /Users/michalkrsik/Library/Android/sdk/build-tools \
  -type f -name aapt -perm -111 | sort -V | tail -1)
"$AAPT" dump badging "$APK" | rg 'package:|application-label:'
```

Install the verified artifact:

```bash
"$ADB" -s "$SERIAL" install -r -d "$APK"
```

If the project supplies an upload helper, prefer it. Build once, then use its install-only option only when the APK is known to match the current source.

### Avoid redundant installation

For a debuggable single/base APK, an installed/local hash comparison can prove that installation is unnecessary:

```bash
REMOTE_APK=$("$ADB" -s "$SERIAL" shell pm path "$PACKAGE" \
  | sed -n 's/^package://p' | head -n 1 | tr -d '\r')

shasum -a 256 "$APK"
"$ADB" -s "$SERIAL" exec-out cat "$REMOTE_APK" | shasum -a 256
"$ADB" -s "$SERIAL" shell dumpsys package "$PACKAGE" \
  | rg 'versionCode|versionName|lastUpdateTime|codePath'
```

Split APKs and app bundles may require a different provenance check. Do not interpret a base-APK-only mismatch without understanding that packaging model.

## 6. Launch directly

For an installed application:

```bash
"$ADB" -s "$SERIAL" shell monkey \
  -p "$PACKAGE" \
  -c android.intent.category.LAUNCHER 1 >/dev/null
```

Resolve or launch an explicit activity when required:

```bash
"$ADB" -s "$SERIAL" shell cmd package resolve-activity --brief "$PACKAGE"
"$ADB" -s "$SERIAL" shell am start -W -n "$LAUNCH_COMPONENT"
```

For a PWA or mobile web application:

```bash
APP_URL="https://example.test/mobile-flow"
"$ADB" -s "$SERIAL" shell am start -W \
  -a android.intent.action.VIEW \
  -d "$APP_URL" \
  -p com.android.chrome
```

For a known cross-app file handler:

```bash
FILE_URI="file:///storage/emulated/0/Download/example.pdf"
HANDLER_PACKAGE="com.example.viewer"

"$ADB" -s "$SERIAL" shell am start -W \
  -a android.intent.action.VIEW \
  -d "$FILE_URI" \
  -t 'application/pdf' \
  -p "$HANDLER_PACKAGE"
```

These are examples. Use the real MIME type, URI form, browser, activity, and handler defined by the target workflow.

## 7. Inspect at state boundaries, not after every tap

Capture the UI hierarchy before the first coordinate-dependent action, after an uncertain branch, and for final proof.

```bash
STATE="target-screen"
mkdir -p "$EVIDENCE_DIR"

"$ADB" -s "$SERIAL" shell uiautomator dump "/sdcard/$STATE.xml" >/dev/null
"$ADB" -s "$SERIAL" pull "/sdcard/$STATE.xml" "$EVIDENCE_DIR/$STATE.xml" >/dev/null
xmllint --format "$EVIDENCE_DIR/$STATE.xml" 2>/dev/null \
  | rg 'text=|content-desc=|resource-id=|bounds='
```

Prefer stable accessibility labels, text, resource IDs, and bounds. When a raw coordinate is unavoidable, derive it from the current hierarchy and current screen size:

```bash
"$ADB" -s "$SERIAL" shell wm size
"$ADB" -s "$SERIAL" shell wm density
```

Do not reuse coordinates from another device, orientation, density, screen state, or earlier build without verification.

### Batch only deterministic actions

Once the current state is known, group a short deterministic sequence:

```bash
"$ADB" -s "$SERIAL" shell input tap 540 900
sleep 0.6
"$ADB" -s "$SERIAL" shell input swipe 540 1800 540 700 250
sleep 1
```

Keep a verification boundary before:

- permission prompts;
- file pickers;
- lock-screen transitions;
- destructive actions;
- system settings;
- external app handoffs;
- any action with multiple plausible outcomes.

A retry without new evidence is usually wasted time.

## 8. Verify through the strongest channel

Choose evidence based on the question:

| Question | Strongest normal evidence |
|---|---|
| Is the intended app/window active? | `dumpsys window` or `dumpsys activity` |
| Is a control present and actionable? | UI hierarchy and accessibility bounds |
| Does the screen look right? | ADB screenshot or user-created screenshot |
| Did a setting persist? | `run-as`, SharedPreferences, DataStore, database, or app API |
| Did a background task finish? | App-specific state, logs, notification state, then UI |
| Did a service continue while locked? | Timestamped filtered logs and service state |
| Did the app crash? | Filtered `logcat` and process/window state |
| Is the installed build exact? | Package metadata and appropriate artifact provenance |
| Did a target app actually receive control? | Foreground activity plus target-specific state |

### Visual evidence

```bash
"$ADB" -s "$SERIAL" exec-out screencap -p \
  > "$EVIDENCE_DIR/final-screen.png"
```

If the user says they took a screenshot, retrieve that existing screenshot rather than silently creating a replacement. On the local Nothing Phone, Essential Space commonly stores captures under:

```text
/storage/emulated/0/Pictures/EssentialSpace/
```

Other devices may use `/sdcard/Pictures/Screenshots/` or another OEM folder. List recent media or query Android's media index when the location is unclear.

### Runtime evidence

```bash
"$ADB" -s "$SERIAL" logcat -c

# Run the test flow, then:
"$ADB" -s "$SERIAL" logcat -d -v time \
  | rg -i "$PACKAGE|$LOG_FILTER" \
  > "$EVIDENCE_DIR/runtime.log"
```

### Internal-state evidence

`run-as` works only for a debuggable package and still requires project-specific paths.

Generic examples:

```bash
"$ADB" -s "$SERIAL" shell run-as "$PACKAGE" find . -maxdepth 3 -type f
"$ADB" -s "$SERIAL" exec-out run-as "$PACKAGE" \
  cat shared_prefs/example.xml > "$EVIDENCE_DIR/preferences.xml"
```

Optional database example:

```bash
APP_DB="databases/example.db"
"$ADB" -s "$SERIAL" exec-out run-as "$PACKAGE" \
  cat "$APP_DB" > "$EVIDENCE_DIR/app.db"
sqlite3 "$EVIDENCE_DIR/app.db" 'pragma integrity_check;'
```

Do not assume every project has SQLite, a particular database name, or a particular terminal-state table. Determine the real persistence model from the target repository.

For `run-as` write-back, prefer verified absolute app-storage paths under `/data/user/0/<package>/`. Quoting and relative working directories are fragile.

## 9. Monitor long-running work without staring at screenshots

For imports, GPS acquisition, media processing, background services, downloads, or queues:

1. Identify the machine-readable progress signal.
2. Start the operation once.
3. Poll at a reasonable interval through logs, app state, service state, database, or an API.
4. Avoid repeated UI dumps while no UI transition is expected.
5. Wait for stable terminal state.
6. Capture final internal and visual evidence.
7. Stop or force-stop only after writes have settled and only when a consistent snapshot requires it.

Examples of useful signals:

- a status field reaching `completed`, `failed`, or equivalent;
- a foreground service remaining active across lock/unlock;
- expected timestamped log events;
- a notification changing state;
- a persisted preference or DataStore value;
- a database integrity check;
- a GPS accuracy/distance result;
- a browser DOM or network state for a PWA.

The signal is project-specific; the monitoring pattern is universal.

## 10. Separate device work from reports

Phone capture and report generation are different phases:

1. Finish the phone interaction matrix.
2. Save named screenshots, UI XML, logs, recordings, and internal-state evidence.
3. Write a small evidence manifest describing each artifact and result.
4. Restore temporary phone settings.
5. Mark the device phase complete.
6. Generate HTML, Markdown, PDF, or other presentation output afterward.

If report rendering fails, completed phone evidence must remain usable and resumable.

## 11. Connection recovery order

Use the least disruptive recovery first:

1. `adb devices -l`.
2. Wait for any configured connection keeper.
3. Verify Wi-Fi/USB state and the expected device model.
4. Retry the known stable endpoint if the environment documents one.
5. Restart the local ADB server or keeper if appropriate.
6. Discover the current connection endpoint only when needed.
7. Pair again only when authorization or wireless-debugging pairing was actually lost.

Do not confuse the temporary pairing port, rotating TLS discovery port, and a configured fixed `:5555` endpoint. They can be different.

Public or client-isolated Wi-Fi may block mDNS or peer-to-peer traffic. In that environment, USB or a known reachable fixed endpoint may be the only workable path.

## 12. Common causes of slowness

### Lock screen, doze, or display timeout

Symptom: commands act on `NotificationShade`, UI dumps stall, a WebView queue pauses, or the foreground app disappears.

Correction: wake, verify the unlock surface, unlock through the authorized flow, verify focus, and use an automatically restored timeout guard.

### Excessive UI round trips

Symptom: every tap becomes a separate command containing a sleep, dump, pull, parse, and screenshot.

Correction: inspect once, batch deterministic actions, and verify at state transitions.

### Stale coordinates

Symptom: repeated taps do nothing or hit different controls after a layout change.

Correction: use fresh accessibility bounds and current screen metrics. Prefer stable selectors over coordinates.

### Repeated build/install cycles

Symptom: each small visual decision triggers web build, native sync, Gradle, install, unlock, and navigation.

Correction: settle design choices before native implementation, combine an approved change set, build once, and run the whole interaction matrix against that artifact.

### Wrong local runtime

Symptom: a build works from the repository root but fails from a nested Android directory because a different Node, Java, SDK, or environment is selected.

Correction: use the repository-documented working directory and runtime. Diagnose environment selection before changing dependencies.

### Fragile shell quoting

Symptom: phone paths with spaces split, files land in the wrong directory, or cleanup targets a partial path.

Correction: store paths in variables, quote every expansion, avoid constructing remote shell commands unnecessarily, and verify final file lists or hashes.

### Legitimate device-discovered defects

Some runs are longer because the phone reveals a lifecycle race, permission issue, OEM behavior, parser defect, service failure, or rendering difference that local tests cannot reproduce.

That time is justified when the agent reports:

- the evidence that exposed the defect;
- the code or configuration change made;
- why another build/install was required;
- the final on-device regression result.

## 13. Execution modes

### Fast smoke pass — normally 3-5 minutes after a ready artifact

- Connect and select the device.
- Verify/install the artifact if needed.
- Launch the app or PWA.
- Exercise one primary flow.
- Capture final state and fatal logs.
- Restore phone settings.

Use for “does this build launch and does the change basically work?”

### Focused interaction pass — normally 8-15 minutes

- One coherent build/install.
- Written interaction matrix.
- UI inspection at branch points.
- All related gestures and state transitions.
- Final screenshot, hierarchy, state, and log evidence.

Use for navigation, permissions, toolbars, pickers, TTS, media, GPS, services, or another bounded feature.

### Full device audit — normally 20-35+ minutes

- Artifact provenance.
- Required storage/app-state preparation.
- Multiple representative cases or apps.
- Machine-readable progress monitoring.
- Negative cases and recovery behavior.
- Final integrity checks and cleanup.

Use when the task can expose persistence, lifecycle, parser, background-service, or cross-app defects.

These are expectations, not guarantees. Report device-control time separately from coding, building, research, and report generation.

## 14. Prompt template for future Codex tasks

```text
Use the repository's AGENTS.md and project documentation to resolve the Android package, artifact, build/install command, launch method, log tags, evidence directory, and required test matrix. Do not copy project values from examples.

This is an extended phone workload, so use ADB_PHONE_CONTROL_PLAYBOOK.md. Select the intended device explicitly and reuse one serial throughout. Use any configured connection keeper before asking me to pair again.

Before touching the phone, state the exact on-device test matrix. Build once, verify the artifact identity, install only when needed, and run the complete matrix against that revision. If the run is long, preserve and restore screen-timeout/stay-awake settings automatically.

Use a closed loop: inspect current state, perform a bounded deterministic action group, then verify through the strongest available channel. Prefer accessibility state, app persistence, package metadata, service state, or logcat over screenshots alone. Use screenshots for visual evidence. Retry only after collecting evidence explaining the previous result.

Separate the phone phase from report generation. Save named evidence and mark the phone phase complete before creating an HTML or other report. Report phone-control time separately from build, coding, or presentation time.

If I say I took a screenshot, retrieve the existing phone screenshot rather than taking a replacement.
```

Append one mode:

- `Use a fast smoke pass and stop when the primary flow is proven.`
- `Use a focused interaction pass and test every listed transition.`
- `Use a full device audit through negative cases and integrity checks.`

## 15. Reusable harness opportunity

When a project repeatedly performs extended phone work, a small repository-local or shared harness can provide:

- explicit serial/model resolution;
- optional keeper-aware connection waiting;
- timeout capture and restoration;
- authorized unlock-state verification;
- package and artifact verification;
- UI dump and selector-to-bounds helpers;
- named screenshot/XML/log/recording capture;
- direct app, activity, URL, and intent launch helpers;
- safe cleanup traps;
- an evidence manifest.

Keep the harness generic and pass project values as arguments. Do not bake one application's package, database, APK path, log tags, or UI coordinates into a supposedly shared phone-control tool.
