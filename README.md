# CodeX Desktop

A local-first, AI-optional software development environment: create projects, spin up sandboxed multi-language environments, build/test/run inside them, self-heal build failures automatically, snapshot and roll back, and export projects (source, native binaries, or full environments) — all without sending code to any cloud AI service.

## What this is

CodeX Desktop is a real Electron + TypeScript application, not a prototype. It has a CLI (`codex`), a desktop GUI, a real Docker/WSL2/Windows-Sandbox isolation layer, 15 language/database environment packs, a self-healing build-repair loop, and an optional local-AI layer (Ollama or llama.cpp — no cloud APIs anywhere in this codebase).

## Requirements

- **Windows 10/11 x64** (primary target; architecture supports Linux/macOS later)
- **Node.js 20+** and npm
- **Docker Desktop with WSL2 backend** (recommended — for sandboxed builds)
- Optional: **WSL2** enabled (used by the Android runtime and as a lighter-weight sandbox backend)
- Optional: **Android SDK** (`ANDROID_HOME` set) if you'll build Android/Flutter/React Native projects
- Optional: **Ollama** (https://ollama.ai) or **llama.cpp** server mode, if you want the self-healing repair loop to auto-diagnose and patch errors. Without either, CodeX still runs fully — you just drive the build/fix/retry cycle yourself.

## Install

```bash
npm install
npm run build
```

## Run the GUI

```bash
npm start
```

## Use the CLI

```bash
npm run cli -- doctor              # check what's available on this machine
npm run cli -- create my-app --env node
npm run cli -- build my-app
npm run cli -- test my-app
npm run cli -- run my-app
npm run cli -- repair my-app --max-retries 8
npm run cli -- snapshot my-app --label "before refactor"
npm run cli -- export my-app --out ./dist --native windows-exe
```

Run `npm run cli -- doctor` first on any new machine — it reports exactly which sandbox backends (Docker/WSL2/Windows Sandbox), the local AI provider, and Android SDK components are actually available, so you know what will and won't work before you try it.

## Enabling local AI (optional)

CodeX never calls a cloud AI API. To enable the self-healing repair loop's automatic error diagnosis and patching:

```bash
# Ollama (default port 11434)
set CODEX_AI_PROVIDER=ollama
set CODEX_OLLAMA_MODEL=codellama
npm start

# llama.cpp server mode (default port 8080)
set CODEX_AI_PROVIDER=llamacpp
npm start
```

Without either set (`CODEX_AI_PROVIDER=none`, the default), `codex repair` still runs the full build → test → analyze cycle and keeps a complete attempt history — it just can't auto-generate patches, and says so plainly rather than pretending to.

## Architecture

```
src/
├── app/            CodexApplication — the single composition root
├── core/           ProjectManager, JobManager, BuildEngine, TestEngine,
│                   ProcessManager, RepairEngine, SnapshotManager
├── sandbox/        SandboxProvider abstraction + Docker/WSL2/
│                   WindowsSandbox/Process providers, ResourceManager,
│                   NetworkPolicy
├── environments/   EnvironmentPack interface + 15 packs, EnvironmentManager,
│                   Android runtime (real adb/gradle/emulator orchestration)
├── intelligence/   LocalModelProvider interface + Ollama/llama.cpp
│                   implementations, Planner
├── tools/          ToolRegistry, ToolExecutor (the AI->Policy->Sandbox
│                   enforcement boundary), tool definitions
├── policy/         PolicyEngine
├── export/         ProjectExporter (source/native), Importer
├── storage/        SQLite schema + repositories
├── plugins/        PluginManager (third-party pack/tool loading)
├── cli/            `codex` command-line entry point
└── gui/            Electron main process, preload bridge, renderer UI
```

See `docs/ARCHITECTURE.md` for the full data flow and security boundary explanation, and `docs/HONEST_LIMITATIONS.md` for a plain account of what has and hasn't been exercised against real infrastructure.

## Testing

```bash
npm test
```

Real unit tests cover PolicyEngine, ToolRegistry/ToolExecutor, JobManager, RepairEngine's control flow, EnvironmentPackRegistry, and ProcessProvider (exercised against the real host shell — no mocking, since it has no external daemon dependency). See `docs/HONEST_LIMITATIONS.md` for what could and couldn't be verified in the environment this codebase was authored in, and what to verify first on your own machine.

## License

Proprietary — built for internal use.
