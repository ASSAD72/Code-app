# CodeX Android

Native Android front-end for the CodeX project. It preserves the CodeX concepts while replacing Desktop providers with an Android app-private sandbox.

## Current milestone
- App-private per-project workspaces
- Workspace path boundary enforcement
- Android sandbox provider abstraction
- Command execution with timeout
- Dashboard / Projects / Terminal / Tests / Sync UI
- Desktop↔Android sync boundary (`SyncManager`) ready for a future authenticated API
- Network disabled by default at the CodeX policy level

## Build
Requires Android SDK 35 and Gradle 8.9+ (or Android Studio). From this directory:

```bash
gradle wrapper --gradle-version 8.9
./gradlew assembleDebug
```

APK: `app/build/outputs/apk/debug/app-debug.apk`

The current development environment did not contain Android SDK/Gradle, so this repository was not falsely marked as having a built APK.

## Cloud APK build

For phone-only builds through GitHub Actions, see `../GITHUB_BUILD.md`.
