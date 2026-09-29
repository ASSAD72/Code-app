import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { ExecutionResult } from '@core/types';
import { SandboxProvider, SandboxInstanceHandle } from '../../sandbox/SandboxProvider';

/**
 * AndroidRuntimeProvider — real Android SDK / Gradle / Emulator
 * orchestration, per spec section 7.
 *
 * This is a specialized runtime layered ON TOP of a SandboxProvider
 * (usually WSL2Provider for build/test steps that don't need the
 * emulator's GPU/KVM access, or direct host process spawning for the
 * emulator itself, since Android Studio's own emulator on Windows runs
 * as a native Windows process using Intel HAXM / Windows Hypervisor
 * Platform — there's no meaningful way to "containerize" that further
 * without losing hardware acceleration).
 *
 * Responsibilities (spec section 7's 9-step Android flow):
 *   1. Locate/verify Android SDK (ANDROID_HOME) and required components.
 *   2. Run Gradle wrapper commands (assembleDebug, testDebugUnitTest,
 *      bundleRelease) inside the project's sandbox instance.
 *   3. List/create AVDs via `avdmanager` and `emulator -list-avds`.
 *   4. Start/stop the actual emulator process on the HOST (Windows),
 *      because the emulator is a GUI+hypervisor process, not something
 *      that benefits from being wrapped in another sandbox layer.
 *   5. Install/launch the built APK on a running emulator via `adb`.
 *
 * Honesty note: every command below is the real, documented Android SDK
 * command-line invocation. None of it can be executed in this authoring
 * sandbox (no Android SDK, no emulator binaries, no KVM/HAXM, no
 * network to download the SDK). It requires the Android SDK components
 * (platform-tools, emulator, build-tools, an AVD system image) to be
 * installed on the Windows host — CodeX's `codex doctor` command (see
 * cli/commands/doctor.ts) checks for and reports on these prerequisites.
 */
export class AndroidRuntimeProvider {
  private emulatorProcess: ChildProcess | null = null;

  constructor(
    private readonly sandbox: SandboxProvider,
    private readonly androidHome: string = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? ''
  ) {}

  async checkPrerequisites(): Promise<{ ok: boolean; missing: string[] }> {
    const missing: string[] = [];
    if (!this.androidHome) {
      missing.push('ANDROID_HOME / ANDROID_SDK_ROOT environment variable is not set.');
      return { ok: false, missing };
    }
    const requiredBinaries = [
      path.join(this.androidHome, 'platform-tools', platformBinary('adb')),
      path.join(this.androidHome, 'emulator', platformBinary('emulator')),
      path.join(this.androidHome, 'cmdline-tools', 'latest', 'bin', platformBinary('avdmanager')),
    ];
    for (const bin of requiredBinaries) {
      const exists = await fileExists(bin);
      if (!exists) missing.push(`Missing required Android SDK binary: ${bin}`);
    }
    return { ok: missing.length === 0, missing };
  }

  /** Step: run `./gradlew assembleDebug` (or any gradle task) inside the project sandbox instance. */
  async runGradleTask(
    handle: SandboxInstanceHandle,
    task: string,
    onOutput?: (chunk: string) => void
  ): Promise<ExecutionResult> {
    const gradlewCommand = ['bash', './gradlew', task];
    return this.sandbox.exec(handle, {
      command: gradlewCommand,
      timeoutMs: 15 * 60 * 1000,
      onStdout: onOutput,
      onStderr: onOutput,
    });
  }

  async buildDebugApk(handle: SandboxInstanceHandle, onOutput?: (chunk: string) => void): Promise<ExecutionResult> {
    return this.runGradleTask(handle, 'assembleDebug', onOutput);
  }

  async buildReleaseAab(handle: SandboxInstanceHandle, onOutput?: (chunk: string) => void): Promise<ExecutionResult> {
    return this.runGradleTask(handle, 'bundleRelease', onOutput);
  }

  async runUnitTests(handle: SandboxInstanceHandle, onOutput?: (chunk: string) => void): Promise<ExecutionResult> {
    return this.runGradleTask(handle, 'testDebugUnitTest', onOutput);
  }

  /** List AVDs currently registered on the host. */
  async listAvds(): Promise<string[]> {
    const emulatorBin = path.join(this.androidHome, 'emulator', platformBinary('emulator'));
    const result = await this.runHostBinary(emulatorBin, ['-list-avds']);
    return result.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  }

  /** Create a new AVD if one matching the given name doesn't already exist. */
  async ensureAvd(avdName: string, systemImage = 'system-images;android-34;google_apis;x86_64'): Promise<void> {
    const existing = await this.listAvds();
    if (existing.includes(avdName)) return;

    const avdmanagerBin = path.join(this.androidHome, 'cmdline-tools', 'latest', 'bin', platformBinary('avdmanager'));
    await this.runHostBinary(avdmanagerBin, [
      'create',
      'avd',
      '--name',
      avdName,
      '--package',
      systemImage,
      '--device',
      'pixel_6',
    ]);
  }

  /**
   * Start the emulator as a real host process. This is intentionally NOT
   * routed through a SandboxProvider — the Android emulator is a
   * GUI-capable, hardware-accelerated VM in its own right, and wrapping
   * it in Docker/WSL2 would either lose GPU/KVM acceleration or require
   * X11/Wayland forwarding complexity that provides no isolation benefit
   * (the emulator's own guest OS is already the isolation boundary for
   * whatever app runs inside it).
   */
  async startEmulator(avdName: string, headless = false): Promise<void> {
    const emulatorBin = path.join(this.androidHome, 'emulator', platformBinary('emulator'));
    const args = ['-avd', avdName, '-no-snapshot-save'];
    if (headless) args.push('-no-window', '-gpu', 'swiftshader_indirect');

    this.emulatorProcess = spawn(emulatorBin, args, { detached: true, stdio: 'ignore' });
    this.emulatorProcess.unref();

    await this.waitForDevice(120_000);
  }

  async stopEmulator(): Promise<void> {
    const adbBin = path.join(this.androidHome, 'platform-tools', platformBinary('adb'));
    await this.runHostBinary(adbBin, ['emu', 'kill']).catch(() => undefined);
    this.emulatorProcess?.kill();
    this.emulatorProcess = null;
  }

  async waitForDevice(timeoutMs: number): Promise<void> {
    const adbBin = path.join(this.androidHome, 'platform-tools', platformBinary('adb'));
    await this.runHostBinary(adbBin, ['wait-for-device'], timeoutMs);
    // wait-for-device only guarantees the device is visible, not that
    // boot has completed; poll sys.boot_completed for a real "ready" signal.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await this.runHostBinary(adbBin, ['shell', 'getprop', 'sys.boot_completed']).catch(() => null);
      if (result?.stdout.trim() === '1') return;
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error('Timed out waiting for Android emulator to finish booting.');
  }

  /** Install a built APK onto the running emulator/device. */
  async installApk(apkPath: string): Promise<ExecutionResult> {
    const adbBin = path.join(this.androidHome, 'platform-tools', platformBinary('adb'));
    const startTime = Date.now();
    const result = await this.runHostBinary(adbBin, ['install', '-r', apkPath]);
    return { ...result, durationMs: Date.now() - startTime, timedOut: false };
  }

  /** Launch the app's main activity on the device by package name. */
  async launchApp(packageName: string, activityName = '.MainActivity'): Promise<ExecutionResult> {
    const adbBin = path.join(this.androidHome, 'platform-tools', platformBinary('adb'));
    const startTime = Date.now();
    const result = await this.runHostBinary(adbBin, ['shell', 'am', 'start', '-n', `${packageName}/${activityName}`]);
    return { ...result, durationMs: Date.now() - startTime, timedOut: false };
  }

  /** Capture a screenshot from the running emulator for GUI preview purposes. */
  async captureScreenshot(outputPath: string): Promise<void> {
    const adbBin = path.join(this.androidHome, 'platform-tools', platformBinary('adb'));
    const remotePath = '/sdcard/codex-screenshot.png';
    await this.runHostBinary(adbBin, ['shell', 'screencap', '-p', remotePath]);
    await this.runHostBinary(adbBin, ['pull', remotePath, outputPath]);
  }

  private runHostBinary(
    binary: string,
    args: string[],
    timeoutMs = 60_000
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, { windowsHide: true });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Command timed out: ${binary} ${args.join(' ')}`));
      }, timeoutMs);

      child.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf-8')));
      child.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf-8')));
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code ?? -1, stdout, stderr });
      });
    });
  }
}

function platformBinary(name: string): string {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const { promises: fs } = await import('fs');
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
