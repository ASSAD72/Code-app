import { Command } from 'commander';
import { CodexApplication } from '../../app/CodexApplication';
import { AndroidRuntimeProvider } from '../../environments/android/AndroidRuntimeProvider';

/**
 * `codex doctor` — spec section 15. Reports on the availability of every
 * sandbox backend and, if relevant, Android SDK prerequisites, local AI
 * providers, and Git. This is the single command a user runs to find out
 * exactly what's missing before attempting Docker/Android/AI-dependent
 * workflows, matching the honesty principle threaded through this whole
 * codebase: report what's real, don't pretend something works.
 */
export function registerDoctorCommand(program: Command, app: CodexApplication): void {
  program
    .command('doctor')
    .description('Check the host system for CodeX Desktop prerequisites (Docker, WSL2, Android SDK, local AI).')
    .action(async () => {
      console.log('CodeX Desktop — System Diagnostic\n');

      const sandboxAvailability = await app.sandboxRegistry.getAvailability();
      console.log('Sandbox Providers:');
      for (const [type, status] of Object.entries(sandboxAvailability)) {
        const icon = status.available ? '✔' : '✘';
        console.log(`  ${icon} ${type}${status.reason ? ` — ${status.reason}` : ''}`);
      }

      console.log('\nLocal AI:');
      const aiInfo = await app.localModelProvider.getInfo();
      const aiIcon = aiInfo.available ? '✔' : '✘';
      console.log(
        `  ${aiIcon} ${aiInfo.provider}${aiInfo.modelName ? ` (${aiInfo.modelName})` : ''}${
          aiInfo.available ? '' : ' — not reachable; CodeX will run in manual (no-AI) mode'
        }`
      );

      console.log('\nAndroid SDK:');
      const androidRuntime = new AndroidRuntimeProvider(app.sandboxRegistry.get('wsl2'));
      const androidCheck = await androidRuntime.checkPrerequisites();
      if (androidCheck.ok) {
        console.log('  ✔ Android SDK, platform-tools, emulator, and cmdline-tools all found.');
      } else {
        console.log('  ✘ Android SDK prerequisites missing:');
        for (const missing of androidCheck.missing) {
          console.log(`      - ${missing}`);
        }
      }

      console.log('\nSummary:');
      const dockerOk = sandboxAvailability.docker?.available;
      const wsl2Ok = sandboxAvailability.wsl2?.available;
      if (!dockerOk && !wsl2Ok) {
        console.log('  ⚠ Neither Docker nor WSL2 is available — CodeX will fall back to running commands');
        console.log('    directly on the host with minimal isolation (ProcessProvider). Install Docker Desktop');
        console.log('    or enable WSL2 for proper sandboxing.');
      } else {
        console.log('  ✔ At least one real sandbox isolation backend is available.');
      }
    });
}
