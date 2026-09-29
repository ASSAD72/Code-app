#!/usr/bin/env bash
set -euo pipefail
if ! command -v gradle >/dev/null 2>&1 && [ ! -x ./gradlew ]; then
  echo "Gradle is required. Install Android Studio/Gradle, then run: gradle wrapper --gradle-version 8.9" >&2
  exit 1
fi
if [ ! -x ./gradlew ]; then gradle wrapper --gradle-version 8.9; fi
./gradlew :app:assembleDebug
printf '\nAPK: %s\n' "$PWD/app/build/outputs/apk/debug/app-debug.apk"
