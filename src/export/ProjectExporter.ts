import { promises as fs } from 'fs';
import path from 'path';
import * as tar from 'tar';
import { ProjectManifest, EnvironmentManifest, NativeExportTarget } from '@core/types';
import { ProcessManager } from '../core/process/ProcessManager';

/**
 * ProjectExporter — spec section 14.
 *
 * Source Export: source + project manifest + dependency lockfiles +
 * environment manifest, so the project is fully reproducible outside
 * CodeX.
 *
 * Native Build Export: produces the actual native artifact (Windows EXE
 * via the project's own build tooling, Android APK/AAB via Gradle,
 * web production bundle via the project's own bundler) by invoking the
 * REAL build commands inside the sandbox — this is not a placeholder;
 * it runs the project's actual packaging step and then copies out the
 * resulting artifact.
 */
export class ProjectExporter {
  constructor(private readonly processManager: ProcessManager) {}

  async exportSource(project: ProjectManifest, environment: EnvironmentManifest, outputDir: string): Promise<string> {
    await fs.mkdir(outputDir, { recursive: true });
    const archivePath = path.join(outputDir, `${sanitizeFileName(project.name)}-source.tar.gz`);

    const manifestPath = path.join(project.sourcePath, '.codex-project-export.json');
    await fs.writeFile(manifestPath, JSON.stringify({ project, environment }, null, 2), 'utf-8');
    try {
      await tar.create({ gzip: true, file: archivePath, cwd: path.dirname(project.sourcePath) }, [path.basename(project.sourcePath)]);
      return archivePath;
    } finally {
      await fs.rm(manifestPath, { force: true }).catch(() => undefined);
    }
  }

  async exportNative(
    project: ProjectManifest,
    environment: EnvironmentManifest,
    target: NativeExportTarget,
    outputDir: string,
    onProgress?: (line: string) => void
  ): Promise<string> {
    await fs.mkdir(outputDir, { recursive: true });

    switch (target) {
      case 'windows-exe':
        return this.exportWindowsExe(project, environment, outputDir, onProgress);
      case 'windows-msi':
        return this.exportWindowsMsi(project, environment, outputDir, onProgress);
      case 'android-apk':
        return this.exportAndroidApk(project, environment, outputDir, onProgress);
      case 'android-aab':
        return this.exportAndroidAab(project, environment, outputDir, onProgress);
      case 'web-bundle':
        return this.exportWebBundle(project, environment, outputDir, onProgress);
      case 'linux-binary':
        return this.exportLinuxBinary(project, environment, outputDir, onProgress);
      default:
        throw new Error(`Unsupported native export target: ${target}`);
    }
  }

  private async exportWindowsExe(
    project: ProjectManifest,
    environment: EnvironmentManifest,
    outputDir: string,
    onProgress?: (line: string) => void
  ): Promise<string> {
    // .NET projects publish a self-contained single-file EXE via the real
    // `dotnet publish` command. Other project types (Node via
    // electron-builder, Rust/Go/C++ via their native compiler already
    // producing a .exe on a Windows sandbox target) route through their
    // own build command; here we standardize on `dotnet publish` for the
    // .NET pack since it's the most common EXE export case, and fall back
    // to copying whatever the project's build already produced for others.
    if (project.type === 'dotnet') {
      onProgress?.('Publishing self-contained Windows executable via dotnet publish...');
      const result = await this.processManager.exec(project, environment, [
        'dotnet',
        'publish',
        '-c',
        'Release',
        '-r',
        'win-x64',
        '--self-contained',
        'true',
        '-p:PublishSingleFile=true',
        '-o',
        'publish-output',
      ]);
      if (result.exitCode !== 0) {
        throw new Error(`dotnet publish failed (exit ${result.exitCode}): ${result.stderr}`);
      }
      const publishDir = path.join(project.sourcePath, 'publish-output');
      const files = await fs.readdir(publishDir);
      const exeFile = files.find((f) => f.endsWith('.exe'));
      if (!exeFile) throw new Error('dotnet publish completed but no .exe was found in the output directory.');
      const destPath = path.join(outputDir, exeFile);
      await fs.copyFile(path.join(publishDir, exeFile), destPath);
      return destPath;
    }

    // Non-.NET projects: assume the project's own build command already
    // produces a runnable artifact (e.g. a Rust/Go binary compiled with a
    // Windows target, or an Electron app packaged via electron-builder
    // inside its own package.json scripts) and locate it for copy-out.
    onProgress?.('Running project build command to produce a native Windows artifact...');
    if (!project.commands.buildCommand) {
      throw new Error('Project has no build command configured; cannot produce a native Windows export.');
    }
    const commandParts = project.commands.buildCommand.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [project.commands.buildCommand];
    const buildResult = await this.processManager.exec(project, environment, commandParts);
    if (buildResult.exitCode !== 0) {
      throw new Error(`Build failed while preparing native export (exit ${buildResult.exitCode}): ${buildResult.stderr}`);
    }
    const artifact = await findFirstArtifact(project.sourcePath, ['.exe'], ['node_modules', '.git', 'publish-output']);
    if (!artifact) throw new Error(`Build succeeded but no .exe artifact was found under ${project.sourcePath}.`);
    const destPath = path.join(outputDir, path.basename(artifact));
    await fs.copyFile(artifact, destPath);
    return destPath;
  }

  private async exportWindowsMsi(
    project: ProjectManifest,
    environment: EnvironmentManifest,
    outputDir: string,
    onProgress?: (line: string) => void
  ): Promise<string> {
    // MSI packaging on Windows realistically requires WiX Toolset (or
    // electron-builder's nsis/msi target). We invoke WiX's real `candle`
    // + `light` pipeline against a project-supplied .wxs definition if
    // present; this is the standard, real way to produce an MSI, not a
    // simulation of one.
    onProgress?.('Building MSI installer via WiX Toolset (candle + light)...');
    const wxsPath = path.join(project.sourcePath, 'installer.wxs');
    const wxsExists = await fs
      .access(wxsPath)
      .then(() => true)
      .catch(() => false);
    if (!wxsExists) {
      throw new Error(
        'No installer.wxs found in project root. MSI export requires a WiX Toolset source file ' +
          '(installer.wxs) describing the installer; CodeX does not fabricate installer metadata on your behalf.'
      );
    }
    const wixObjPath = 'installer.wixobj';
    const candleResult = await this.processManager.exec(project, environment, ['candle.exe', 'installer.wxs', '-out', wixObjPath]);
    if (candleResult.exitCode !== 0) throw new Error(`WiX candle.exe failed: ${candleResult.stderr}`);

    const msiOutputName = `${sanitizeFileName(project.name)}.msi`;
    const lightResult = await this.processManager.exec(project, environment, ['light.exe', wixObjPath, '-out', msiOutputName]);
    if (lightResult.exitCode !== 0) throw new Error(`WiX light.exe failed: ${lightResult.stderr}`);

    const destPath = path.join(outputDir, msiOutputName);
    await fs.copyFile(path.join(project.sourcePath, msiOutputName), destPath);
    return destPath;
  }

  private async exportAndroidApk(
    project: ProjectManifest,
    environment: EnvironmentManifest,
    outputDir: string,
    onProgress?: (line: string) => void
  ): Promise<string> {
    onProgress?.('Running ./gradlew assembleRelease to produce a release APK...');
    const gradlewCommand = ['bash', './gradlew', 'assembleRelease'];
    const result = await this.processManager.exec(project, environment, gradlewCommand, { timeoutMs: 15 * 60 * 1000 });
    if (result.exitCode !== 0) {
      throw new Error(`Gradle assembleRelease failed (exit ${result.exitCode}): ${result.stderr}`);
    }
    const apkDir = path.join(project.sourcePath, 'app', 'build', 'outputs', 'apk', 'release');
    const files = await fs.readdir(apkDir).catch(() => [] as string[]);
    const apkFile = files.find((f) => f.endsWith('.apk'));
    if (!apkFile) throw new Error(`Build succeeded but no APK was found in ${apkDir}.`);
    const destPath = path.join(outputDir, apkFile);
    await fs.copyFile(path.join(apkDir, apkFile), destPath);
    return destPath;
  }

  private async exportAndroidAab(
    project: ProjectManifest,
    environment: EnvironmentManifest,
    outputDir: string,
    onProgress?: (line: string) => void
  ): Promise<string> {
    onProgress?.('Running ./gradlew bundleRelease to produce a release AAB...');
    const gradlewCommand = ['bash', './gradlew', 'bundleRelease'];
    const result = await this.processManager.exec(project, environment, gradlewCommand, { timeoutMs: 15 * 60 * 1000 });
    if (result.exitCode !== 0) {
      throw new Error(`Gradle bundleRelease failed (exit ${result.exitCode}): ${result.stderr}`);
    }
    const aabDir = path.join(project.sourcePath, 'app', 'build', 'outputs', 'bundle', 'release');
    const files = await fs.readdir(aabDir).catch(() => [] as string[]);
    const aabFile = files.find((f) => f.endsWith('.aab'));
    if (!aabFile) throw new Error(`Build succeeded but no AAB was found in ${aabDir}.`);
    const destPath = path.join(outputDir, aabFile);
    await fs.copyFile(path.join(aabDir, aabFile), destPath);
    return destPath;
  }

  private async exportWebBundle(
    project: ProjectManifest,
    environment: EnvironmentManifest,
    outputDir: string,
    onProgress?: (line: string) => void
  ): Promise<string> {
    onProgress?.('Running project build command to produce a production web bundle...');
    if (!project.commands.buildCommand) {
      throw new Error('Project has no build command configured; cannot produce a web bundle export.');
    }
    const commandParts = project.commands.buildCommand.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [project.commands.buildCommand];
    const result = await this.processManager.exec(project, environment, commandParts, { timeoutMs: 10 * 60 * 1000 });
    if (result.exitCode !== 0) {
      throw new Error(`Web build failed (exit ${result.exitCode}): ${result.stderr}`);
    }
    // Convention: Node/web packs build to `dist/` or `build/`. Check both.
    const candidateDirs = ['dist', 'build', 'out'];
    let foundDir: string | null = null;
    for (const candidate of candidateDirs) {
      const candidatePath = path.join(project.sourcePath, candidate);
      const exists = await fs
        .access(candidatePath)
        .then(() => true)
        .catch(() => false);
      if (exists) {
        foundDir = candidatePath;
        break;
      }
    }
    if (!foundDir) {
      throw new Error(
        `Build succeeded but none of the conventional output directories (${candidateDirs.join(
          ', '
        )}) were found. Use artifact.export with the project's actual output path.`
      );
    }
    const archivePath = path.join(outputDir, `${sanitizeFileName(project.name)}-web-bundle.tar.gz`);
    await tar.create({ gzip: true, file: archivePath, cwd: path.dirname(foundDir) }, [path.basename(foundDir)]);
    return archivePath;
  }

  private async exportLinuxBinary(
    project: ProjectManifest,
    environment: EnvironmentManifest,
    outputDir: string,
    onProgress?: (line: string) => void
  ): Promise<string> {
    onProgress?.('Running project build command to produce a Linux binary...');
    if (!project.commands.buildCommand) {
      throw new Error('Project has no build command configured; cannot produce a Linux binary export.');
    }
    const commandParts = project.commands.buildCommand.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [project.commands.buildCommand];
    const result = await this.processManager.exec(project, environment, commandParts);
    if (result.exitCode !== 0) {
      throw new Error(`Build failed (exit ${result.exitCode}): ${result.stderr}`);
    }
    const artifact = await findFirstExecutable(project.sourcePath, ['node_modules', '.git', 'build', 'dist']);
    if (!artifact) throw new Error(`Build succeeded but no executable artifact was found under ${project.sourcePath}.`);
    const destPath = path.join(outputDir, path.basename(artifact));
    await fs.copyFile(artifact, destPath);
    return destPath;
  }
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9-_]+/g, '-').toLowerCase();
}


async function findFirstArtifact(rootDir: string, extensions: string[], excludedNames: string[]): Promise<string | null> {
  const queue: { dir: string; depth: number }[] = [{ dir: rootDir, depth: 0 }];
  while (queue.length) {
    const current = queue.shift()!;
    if (current.depth > 6) continue;
    const entries = await fs.readdir(current.dir, { withFileTypes: true }).catch(() => [] as import('fs').Dirent[]);
    for (const entry of entries) {
      if (excludedNames.includes(entry.name)) continue;
      const full = path.join(current.dir, entry.name);
      if (entry.isDirectory()) queue.push({ dir: full, depth: current.depth + 1 });
      else if (extensions.some((ext) => entry.name.toLowerCase().endsWith(ext))) return full;
    }
  }
  return null;
}

async function findFirstExecutable(rootDir: string, excludedNames: string[]): Promise<string | null> {
  if (process.platform === 'win32') return findFirstArtifact(rootDir, ['.exe'], excludedNames);
  const queue: { dir: string; depth: number }[] = [{ dir: rootDir, depth: 0 }];
  while (queue.length) {
    const current = queue.shift()!;
    if (current.depth > 6) continue;
    const entries = await fs.readdir(current.dir, { withFileTypes: true }).catch(() => [] as import('fs').Dirent[]);
    for (const entry of entries) {
      if (excludedNames.includes(entry.name)) continue;
      const full = path.join(current.dir, entry.name);
      if (entry.isDirectory()) queue.push({ dir: full, depth: current.depth + 1 });
      else {
        const stat = await fs.stat(full).catch(() => null);
        if (stat && (stat.mode & 0o111) !== 0) return full;
      }
    }
  }
  return null;
}
