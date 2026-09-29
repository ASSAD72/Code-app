# CodeX Desktop — Architecture

## Request flow for an AI-assisted action

```
User goal (natural language)
        |
        v
   Planner.plan()              -- calls LocalModelProvider.generatePlan()
        |                         (Ollama / llama.cpp / none)
        v
   ExecutionPlan (steps, each with proposed ToolCallRequests)
        |
        v
   ToolExecutor.dispatch()     -- for EVERY tool call, AI-originated or not
        |
        v
   PolicyEngine.evaluate()     -- network permission, destructive-action
        |                         confirmation, workspace-boundary checks
        v
   ToolRegistry.execute()      -- runs the actual handler
        |
        v
   ProcessManager.exec()       -- resolves the project's active sandbox
        |                         instance (creating one if needed)
        v
   SandboxProvider.exec()      -- Docker / WSL2 / Windows Sandbox / Process
        |
        v
   Real command execution, isolated from the host
```

No code path lets an AI-proposed tool call skip PolicyEngine. `ToolExecutor` is the only place `ToolRegistry.execute()` is called from application code that handles AI-originated requests.

## Sandbox isolation model

Every `SandboxProvider` implementation upholds the same contract (`src/sandbox/SandboxProvider.ts`):

- No host filesystem access beyond the project's own workspace bind-mount.
- No Docker socket, SSH keys, browser profiles, or host credentials inside the sandbox.
- Non-root execution user inside the sandbox wherever the backend supports it (Docker: `USER codex` in every Dockerfile; WSL2: a dedicated `codex` user created on first use).
- Network disabled by default (`NetworkPolicy`); a project must be explicitly granted network access, and that grant is revocable and (for session-scoped grants) cleared on app restart.
- Resource limits (CPU/RAM/PIDs/timeout) enforced by the backend itself, not just requested -- Docker's `NanoCpus`/`Memory`/`PidsLimit`, WSL2's iptables egress-drop rule for network denial.

`DockerProvider` additionally refuses (`SandboxSecurityViolationError`) to bind-mount anything that looks like a host root or system directory, as defense in depth beyond ProjectManager's own path construction.

## Provider selection

`SandboxProviderRegistry.selectBest()` tries providers in a caller-specified preference order and returns the first one that reports itself available. `EnvironmentPack.supportedProviderTypes` declares which backends a given pack can run under -- e.g. the Android pack lists `['docker', 'wsl2', 'process']` because compile/unit-test steps can run in Docker, but anything touching the emulator needs WSL2's KVM passthrough or direct host process spawning (see `AndroidRuntimeProvider`), which is why the emulator itself is never routed through a `SandboxProvider` at all -- it's a hardware-accelerated VM in its own right.

## Data persistence

Everything durable lives in one local SQLite database (`~/.codex-desktop/codex.db` by default) -- projects, jobs (with full log history), environments, snapshots, and repair sessions. No cloud storage, no telemetry endpoint, anywhere in this codebase (spec: Offline First).

## The self-healing loop (RepairEngine)

```
BUILD  --success--> TEST --success--> done (session.status = 'success')
  | fail                | fail
  v                     v
ANALYZE ERROR      ANALYZE ERROR
  |                     |
  v                     v
PATCH (if AI available)  PATCH (if AI available)
  |                     |
  +----------+----------+
             v
    retry (attemptNumber++)
             |
      attemptNumber > maxRetries?
             |
            yes -> session.status = 'exhausted', stop
```

Before the loop starts, a snapshot is taken (`pre-repair-cycle`). Before every patch is applied, another snapshot is taken (`pre-patch`). Every attempt -- including its build/test output, error analysis, and patch (if any) -- is kept in `RepairSession.attempts`, persisted to SQLite via `RepairSessionRepository`. `maxRetries` is a hard ceiling; the loop cannot run forever even if the AI keeps proposing patches that don't fix anything (see `tests/core/RepairEngine.test.ts` for the test proving this).

If no local model is configured or reachable, `analyzeBuildError`/`generatePatch` return `null`, and the loop stops after the first failed attempt rather than retrying identically forever -- this is intentional, not a bug: retrying without any way to change the outcome would just waste time and resources.

## Plugin system

`PluginManager` loads any directory under `~/.codex-desktop/plugins/<plugin-id>/` containing a `codex-plugin.json` manifest and a compiled JS entry point exporting `register(context)`. A plugin can call `context.registerEnvironmentPack(pack)` and `context.registerTool(tool)` to add languages, runtimes, tools, or exporters -- Core never imports a specific plugin by name, so a broken or missing plugin cannot crash app startup (errors during plugin load are caught and reported per-plugin).
