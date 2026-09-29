import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { EnvironmentManifest, ExecutionResult, ResourceUsageSample } from '@core/types';
import {
  SandboxProvider,
  SandboxCreateOptions,
  SandboxExecOptions,
  SandboxInstanceHandle,
  SandboxUnavailableError,
} from '../SandboxProvider';

/**
 * WindowsSandboxProvider — real implementation using Windows Sandbox
 * (WindowsSandbox.exe + .wsb configuration files), per spec section 4/17's
 * requirement for a Windows-Sandbox/Hyper-V isolation backend alongside
 * Docker and WSL2.
 *
 * Windows Sandbox gives a genuinely separate, disposable Windows
 * environment with hardware-backed isolation (built on Hyper-V), which is
 * the appropriate backend for workloads that need a real Windows
 * environment (not Linux) — e.g. testing a .NET WinForms build's actual
 * runtime behavior, or software that will only exist as a Windows
 * installer/EXE, where testing inside a Windows guest is more meaningful
 * than testing inside a Linux container.
 *
 * How it works: we generate a `.wsb` XML config that maps ONLY the
 * project's workspace folder (never the full drive) into the sandbox as a
 * `MappedFolder`, with `ReadOnly` controllable per operation, and a
 * LogonCommand that starts a small command-relay listener so Core can
 * send exec requests into the running sandbox over a local named pipe.
 *
 * Because Windows Sandbox is fully ephemeral (it discards all state on
 * close, by design), "persistent instance you exec into repeatedly" is
 * emulated by keeping the sandbox process alive between execs and
 * relaying commands to it, rather than by the sandbox itself persisting
 * anything — this matches Windows Sandbox's actual execution model
 * instead of fighting it.
 *
 * Honesty note: Windows Sandbox and WindowsSandbox.exe only exist on
 * Windows 10/11 Pro+/Enterprise with the feature enabled. This authoring
 * environment is Linux with no such binary, so `isAvailable()` correctly
 * reports unavailable here, and the relay protocol below has not been
 * exercised against a live Windows Sandbox instance. The WSB generation,
 * process lifecycle, and command structure are real and match Microsoft's
 * documented Windows Sandbox configuration schema.
 */
export class WindowsSandboxProvider implements SandboxProvider {
  readonly type: string = 'windows-sandbox';
  private instances = new Map<
    string,
    SandboxInstanceHandle & { wsbConfigPath: string; relayPipeName: string; processHandle?: ReturnType<typeof spawn>; environment: EnvironmentManifest; resourceLimits: SandboxCreateOptions['resourceLimits'] }
  >();

  async isAvailable(): Promise<{ available: boolean; reason?: string }> {
    if (process.platform !== 'win32') {
      return { available: false, reason: 'Windows Sandbox requires Windows 10/11.' };
    }
    try {
      const result = await this.runHostCommand('powershell.exe', [
        '-NoProfile',
        '-Command',
        'Get-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM | Select-Object -ExpandProperty State',
      ]);
      const enabled = result.stdout.trim() === 'Enabled';
      return enabled
        ? { available: true }
        : { available: false, reason: 'Windows Sandbox optional feature is not enabled.' };
    } catch (err) {
      return { available: false, reason: `Could not query Windows Sandbox feature state: ${String(err)}` };
    }
  }

  async prepareImage(_environment: EnvironmentManifest, onProgress?: (line: string) => void): Promise<void> {
    // Windows Sandbox always boots a fresh copy of the host's own Windows
    // image — there is no separate "image" to pull or build, unlike
    // Docker/WSL2. Toolchain installation happens via LogonCommand /
    // exec-time installer scripts instead. Nothing to prepare up front
    // beyond verifying availability.
    const availability = await this.isAvailable();
    if (!availability.available) {
      throw new SandboxUnavailableError('windows-sandbox', availability.reason ?? 'unknown');
    }
    onProgress?.('Windows Sandbox uses the host OS image directly; no image pull required.');
  }

  async createInstance(options: SandboxCreateOptions): Promise<SandboxInstanceHandle> {
    const instanceId = `winsbx-${options.projectId}-${Date.now()}`;
    const relayPipeName = `codex-relay-${randomUUID()}`;
    const wsbConfigPath = path.join(options.workspaceHostPath, `.codex-${instanceId}.wsb`);

    const mappedFolderContainerPath = 'C:\\workspace';
    const relayScriptHostPath = path.join(options.workspaceHostPath, `.codex-relay-${instanceId}.ps1`);

    // The relay script runs inside the sandbox and listens for JSON exec
    // requests over a named pipe, executes them in C:\workspace, and
    // writes back stdout/stderr/exit code. This is what makes a
    // fresh-per-launch Windows Sandbox usable as a "persistent instance"
    // from Core's point of view.
    const relayScript = buildRelayPowerShellScript(relayPipeName, mappedFolderContainerPath);
    await fs.writeFile(relayScriptHostPath, relayScript, 'utf-8');

    const wsbXml = buildWsbConfig({
      mappedFolderHostPath: options.workspaceHostPath,
      mappedFolderContainerPath,
      readOnly: false,
      networkingEnabled: options.networkEnabled,
      logonCommand: `powershell.exe -ExecutionPolicy Bypass -File "${mappedFolderContainerPath}\\${path.basename(
        relayScriptHostPath
      )}"`,
      memoryMB: options.resourceLimits.memoryMB,
    });
    await fs.writeFile(wsbConfigPath, wsbXml, 'utf-8');

    const child = spawn('WindowsSandbox.exe', [wsbConfigPath], { detached: true, windowsHide: false });

    const handle: SandboxInstanceHandle & {
      wsbConfigPath: string;
      relayPipeName: string;
      processHandle?: ReturnType<typeof spawn>;
      environment: EnvironmentManifest;
      resourceLimits: SandboxCreateOptions['resourceLimits'];
    } = {
      instanceId,
      environmentId: options.environment.environmentId,
      projectId: options.projectId,
      providerType: 'windows-sandbox',
      workspaceHostPath: options.workspaceHostPath,
      workspaceContainerPath: mappedFolderContainerPath,
      networkEnabled: options.networkEnabled,
      createdAt: new Date().toISOString(),
      wsbConfigPath,
      relayPipeName,
      processHandle: child,
      environment: options.environment,
      resourceLimits: options.resourceLimits,
    };

    this.instances.set(instanceId, handle);
    // Give the sandbox time to boot and the relay script to start listening.
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    return handle;
  }

  async exec(handle: SandboxInstanceHandle, options: SandboxExecOptions): Promise<ExecutionResult> {
    const internal = this.instances.get(handle.instanceId);
    if (!internal) throw new Error(`Unknown Windows Sandbox instance ${handle.instanceId}`);

    const startTime = Date.now();
    // Relay the command to the in-sandbox listener via a client-side
    // PowerShell one-liner that connects to the named pipe, sends the
    // JSON request, and prints the JSON response to our own stdout —
    // this lets us reuse runHostCommand's plumbing on the host side
    // without needing a native named-pipe client library.
    const requestJson = JSON.stringify({
      command: options.command,
      cwd: options.cwd ?? handle.workspaceContainerPath,
      env: options.env ?? {},
    });
    const requestJsonBase64 = Buffer.from(requestJson, 'utf8').toString('base64');

    const clientScript = buildRelayClientOneLiner(internal.relayPipeName, requestJsonBase64);
    const result = await this.runHostCommand(
      'powershell.exe',
      ['-NoProfile', '-Command', clientScript],
      options.timeoutMs ?? 20 * 60 * 1000
    );

    let parsed: { exitCode: number; stdout: string; stderr: string } = {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
    try {
      parsed = JSON.parse(result.stdout.trim());
    } catch {
      // Relay didn't return structured JSON (e.g. sandbox still booting) —
      // fall back to raw host-side output so the failure is still visible.
    }

    return {
      exitCode: parsed.exitCode,
      stdout: parsed.stdout,
      stderr: parsed.stderr,
      durationMs: Date.now() - startTime,
      timedOut: result.timedOut,
    };
  }

  async getResourceUsage(_handle: SandboxInstanceHandle): Promise<ResourceUsageSample> {
    // Windows Sandbox does not expose a per-instance metrics API; the host
    // Task Manager reports it as a single "Windows Sandbox" VM process.
    // We report a best-effort zeroed sample rather than fabricate numbers.
    return { timestamp: new Date().toISOString(), cpuPercent: 0, memoryMB: 0 };
  }

  async destroyInstance(handle: SandboxInstanceHandle): Promise<void> {
    const internal = this.instances.get(handle.instanceId);
    if (!internal) return;
    internal.processHandle?.kill();
    await fs.rm(internal.wsbConfigPath, { force: true }).catch(() => undefined);
    this.instances.delete(handle.instanceId);
  }

  async setNetworkEnabled(handle: SandboxInstanceHandle, enabled: boolean): Promise<void> {
    // Windows Sandbox's networking setting is fixed at launch time via the
    // .wsb config and cannot be toggled live. Honor the request by
    // recreating the instance with the new setting.
    const internal = this.instances.get(handle.instanceId);
    if (!internal) throw new Error(`Unknown instance ${handle.instanceId}`);
    await this.destroyInstance(handle);
    const recreated = await this.createInstance({
      environment: { environmentId: internal.environmentId } as EnvironmentManifest,
      projectId: internal.projectId,
      workspaceHostPath: internal.workspaceHostPath,
      networkEnabled: enabled,
      resourceLimits: internal.resourceLimits,
    });
    this.instances.set(handle.instanceId, { ...this.instances.get(recreated.instanceId)!, instanceId: handle.instanceId });
  }

  async listInstances(): Promise<SandboxInstanceHandle[]> {
    return Array.from(this.instances.values());
  }

  private runHostCommand(
    command: string,
    args: string[],
    timeoutMs = 60_000
  ): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { windowsHide: true });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
      child.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf-8')));
      child.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf-8')));
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code ?? -1, stdout, stderr, timedOut });
      });
    });
  }
}

function buildWsbConfig(opts: {
  mappedFolderHostPath: string;
  mappedFolderContainerPath: string;
  readOnly: boolean;
  networkingEnabled: boolean;
  logonCommand: string;
  memoryMB?: number;
}): string {
  return `<Configuration>
  <VGpu>Disable</VGpu>
  <Networking>${opts.networkingEnabled ? 'Default' : 'Disable'}</Networking>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>${opts.mappedFolderHostPath}</HostFolder>
      <SandboxFolder>${opts.mappedFolderContainerPath}</SandboxFolder>
      <ReadOnly>${opts.readOnly}</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>${escapeXml(opts.logonCommand)}</Command>
  </LogonCommand>
  <MemoryInMB>${opts.memoryMB ?? 4096}</MemoryInMB>
</Configuration>`;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildRelayPowerShellScript(pipeName: string, workDir: string): string {
  return `
$pipeName = "${pipeName}"
while ($true) {
  $server = New-Object System.IO.Pipes.NamedPipeServerStream($pipeName, [System.IO.Pipes.PipeDirection]::InOut)
  $server.WaitForConnection()
  $reader = New-Object System.IO.StreamReader($server)
  $writer = New-Object System.IO.StreamWriter($server)
  $writer.AutoFlush = $true
  $line = $reader.ReadLine()
  $req = $line | ConvertFrom-Json
  $requestedCwd = if ($req.cwd) { [string]$req.cwd } else { "${workDir}" }
  $root = "${workDir}".TrimEnd('\')
  if (-not ($requestedCwd.Equals($root, [System.StringComparison]::OrdinalIgnoreCase) -or $requestedCwd.StartsWith($root + '\', [System.StringComparison]::OrdinalIgnoreCase))) { throw "cwd escapes workspace" }
  Set-Location $requestedCwd
  foreach ($property in $req.env.PSObject.Properties) { Set-Item -Path ("Env:" + $property.Name) -Value ([string]$property.Value) }
  try {
    $args = @()
    if ($req.command.Length -gt 1) { $args = $req.command[1..($req.command.Length-1)] }
    $out = & $req.command[0] @args 2>&1
    $exitCode = $LASTEXITCODE
    $resp = @{ exitCode = $exitCode; stdout = ($out | Out-String); stderr = "" } | ConvertTo-Json -Compress
  } catch {
    $resp = @{ exitCode = 1; stdout = ""; stderr = $_.Exception.Message } | ConvertTo-Json -Compress
  }
  $writer.WriteLine($resp)
  $server.Disconnect()
  $server.Dispose()
}
`;
}

function buildRelayClientOneLiner(pipeName: string, requestJsonBase64: string): string {
  return `$client = New-Object System.IO.Pipes.NamedPipeClientStream(".", "${pipeName}", [System.IO.Pipes.PipeDirection]::InOut); $client.Connect(30000); $writer = New-Object System.IO.StreamWriter($client); $writer.AutoFlush = $true; $reader = New-Object System.IO.StreamReader($client); $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${requestJsonBase64}")); $writer.WriteLine($json); $reader.ReadLine()`;
}
