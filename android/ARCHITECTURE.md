# CodeX Android architecture

CodeX Android is a platform provider, not an Electron wrapper.

## Shared concepts
- Project manifest
- Workspace boundary
- Policy decision before execution
- Build/Test/Run job semantics
- Snapshots and export/import boundaries
- AI planner/tool executor boundary
- Remote sync boundary

## Android provider
`AndroidSandbox` is the Android implementation of the sandbox provider concept. It stores projects below the app-private files directory and validates canonical paths before process execution.

The current milestone intentionally keeps network disabled by default. A future authenticated sync client can synchronize project manifests, source archives, snapshots and job history with CodeX Desktop without exposing the local Android sandbox directly.

## Desktop interoperability
The long-term protocol should synchronize immutable project revisions rather than live filesystem mounts:

1. Desktop creates a project revision.
2. Android pulls the revision into its own isolated workspace.
3. Android produces a new revision plus job/test results.
4. Desktop pulls the revision and continues in Docker/WSL2/Windows Sandbox.

This avoids trusting the phone as a privileged remote filesystem and keeps the two sandbox providers independent.
