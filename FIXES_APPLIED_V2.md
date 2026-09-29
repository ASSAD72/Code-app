# CodeX Desktop — V2 repair pass

This pass addresses the second file-by-file audit.

## Fixed in code
- Project directory collisions now allocate unique workspace folders.
- Project creation rolls back scaffold files and its environment if creation fails.
- AI filesystem/artifact target paths are derived from tool input and constrained to the project workspace.
- AI repair patches reject path traversal, symlink targets, and symlinked parents.
- Docker builds local pack Dockerfiles when the requested image is absent.
- Docker no longer assumes every image has a `codex` user; public database images can use their configured default user.
- Docker environment exports include the actual image tar and an immutable image ID in the manifest checksum.
- Docker environment imports verify the imported image ID when one is recorded.
- Docker command timeout/abort kills the managed container rather than leaving an exec running indefinitely.
- WSL2 uses per-project users inside a shared distro so one project's teardown does not terminate another project's distro.
- WSL2 network isolation fails closed if iptables is unavailable and is scoped per project user.
- Windows Sandbox network recreation preserves the original environment and resource limits.
- Windows Sandbox relay now honors requested cwd/env while enforcing the workspace boundary.
- Plugin IDs and plugin entry points are path validated.
- Filesystem snapshot restore is staged and swapped instead of deleting the live project before extraction succeeds.
- Import projects use a unique destination instead of silently deleting an existing project.
- `environment.install` only permits known package managers, rejects shell operators, and requires the declared package name.
- Build commands containing `&&` execute as sequential argv commands rather than passing `&&` to `spawn()`.
- Job execution now honors the configured concurrency gate and build/test retry counts.
- ProcessProvider kills process trees on timeout/abort where the host supports it.
- Android Gradle invocation uses Linux `gradlew` inside the sandbox rather than the host OS choice.
- Android project scaffolding includes Gradle settings/build files, manifest, activity, resources, and a network-bootstrap Gradle launcher.
- Flutter images include Android command-line tools/platform/build-tools; Flutter build scaffolding can create Android platform files before APK build.
- React Native images include Android command-line tools/platform/build-tools and the scaffold includes a native Android project shell.
- Java projects use the Gradle installation provided by the Java environment image.
- Database Compose fragments declare their `codex-net` network.
- Missing Electron builder icon configuration was removed rather than pointing at a nonexistent file.

## Verification performed here
- TypeScript was transpiled to JavaScript despite missing installed dependencies.
- All emitted JavaScript files passed `node --check` syntax validation.
- The runtime-alias resolver was executed against the emitted output; no `@core/*`, `@tools/*`, etc. aliases remained.
- Static project/build manifest checks passed.
- Added a security-boundary integration test file.

## Requires a real host/toolchain to verify
- `npm install` / full Vitest suite (dependencies were not available in this offline environment).
- Live Docker daemon and Docker image builds.
- Windows WSL2 networking and Windows Sandbox.
- Android SDK/Gradle APK/AAB build.
- Flutter APK build.
- React Native Android build.
- Native Windows EXE/MSI packaging.
