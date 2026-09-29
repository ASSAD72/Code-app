# CodeX Desktop — applied fixes

This archive contains a security/runtime hardening pass based on the requested issue list.

## Applied

1. TypeScript runtime aliases: build now rewrites `@core/*`, `@tools/*`, etc. in emitted JS after `tsc`.
2. DockerProvider: when a local Dockerfile is available, it builds the declared image before falling back to a pull.
3. Environment export/import: Docker-backed environments now export/import `docker-image.tar` alongside `environment.json`.
4. Android Gradle bootstrap: generated Android projects now include `gradlew`, `gradlew.bat`, and wrapper properties; the Android Docker image also installs Gradle 8.7. A binary `gradle-wrapper.jar` is not vendored because this repair environment has no package/network access; the generated scripts use the installed Gradle runtime.
5. AI repair patch paths: repair writes are constrained to the project workspace.
6. ToolExecutor: project/path context is derived from structured tool input and checked before execution; filesystem handlers also enforce the workspace boundary.
7. ProcessProvider: it is no longer selected automatically as an environment fallback. It requires explicit `allowProcessFallback: true`, and AI-originated sandbox execution is denied when the selected provider is `process`.
8. Planner -> ToolExecutor -> Policy -> Sandbox: Planner can execute plans only through ToolExecutor; ToolExecutor evaluates policy before creating a sandbox and then uses ProcessManager for sandbox-backed tools. Electron IPC exposes plan/execute-plan endpoints.
9. `environment.install`: now performs the requested install command for a specific project/environment instead of throwing a placeholder error.
10. Native export: Windows EXE and Linux binary exports now locate and copy produced artifacts instead of ending with a manual placeholder error.
11. electron-builder: removed the missing `build/icon.ico` dependency and corrected packaged resource paths to the actual `docker/` directory.
12. Removed `|| true` from the native/WSL/Docker dependency setup paths that previously hid failures.
13. Added security/integration-oriented tests for ToolExecutor path traversal and ProcessProvider blocking, plus provider fallback behavior.
14. Added static validation and syntax checks; live Windows/Docker/Android tests still require their real host environments.

## Verification limitations

- `npm install` could not complete in the repair environment because registry access was unavailable; offline npm cache was also incomplete.
- Therefore Vitest, Electron packaging, Docker daemon tests, Windows Sandbox tests, and Android SDK/emulator tests were not executed here.
- TypeScript source was transpile-checked for syntax with TypeScript 5.8.3. A full typecheck still requires the project's dependencies/types to be installed.
