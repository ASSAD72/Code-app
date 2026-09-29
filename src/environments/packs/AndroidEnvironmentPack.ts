import { promises as fs } from 'fs';
import path from 'path';
import { BaseEnvironmentPack } from '../EnvironmentPack';
import { EnvironmentPackDefinition } from '@core/types';

/**
 * AndroidEnvironmentPack — spec sections 6 and 7.
 *
 * Per spec section 7, this pack is deliberately NOT assumed to run purely
 * inside a simple Docker container: the Android emulator needs hardware
 * virtualization acceleration (Intel HAXM / AMD Hypervisor / Windows
 * Hypervisor Platform) that nested Docker-on-Windows cannot reliably
 * provide. So this pack declares WSL2 and Windows-host-process as its
 * supported provider types for anything emulator-related, while still
 * allowing Docker for pure command-line builds (compiling, assembling
 * APKs, running unit tests) that don't need the emulator at all.
 *
 * The actual emulator/adb/gradle orchestration lives in
 * AndroidRuntimeProvider (see environments/android/AndroidRuntimeProvider.ts),
 * which this pack's manifest points BuildEngine/TestEngine at for
 * Android-specific jobs.
 */
export class AndroidEnvironmentPack extends BaseEnvironmentPack {
  readonly definition: EnvironmentPackDefinition = {
    packId: 'codex-pack-android',
    displayName: 'Android',
    description: 'Android SDK, build-tools, Gradle, Kotlin, emulator',
    category: 'mobile',
    version: '1.0.0',
    dockerfile: 'Dockerfile',
    baseImageTag: 'codex-android:sdk34',
    defaultRuntimes: [
      { name: 'jdk', version: '17.0.12' },
      { name: 'android-sdk', version: '34.0.0' },
      { name: 'kotlin', version: '2.0.20' },
    ],
    defaultPackageManagers: [{ name: 'gradle', version: '8.7' }],
    defaultCapabilities: ['filesystem', 'process', 'network', 'kvm'],
    buildCommand: './gradlew assembleDebug',
    testCommand: './gradlew testDebugUnitTest',
    runCommand: './gradlew installDebug',
    requiresHostVirtualization: true,
    // Builds (compile/assemble/unit-test) can run in Docker; anything
    // touching the emulator needs WSL2 (for KVM passthrough) or a direct
    // Windows host process running Google's emulator binary.
    supportedProviderTypes: ['docker', 'wsl2', 'process'],
  };

  async scaffoldProject(targetDir: string, projectName: string): Promise<string[]> {
    const appId = `com.codex.${sanitizePackageSegment(projectName)}`;
    const created: string[] = [];

    await fs.mkdir(path.join(targetDir, 'app', 'src', 'main', 'java', ...appId.split('.')), { recursive: true });
    await fs.mkdir(path.join(targetDir, 'app', 'src', 'main', 'res', 'values'), { recursive: true });
    await fs.mkdir(path.join(targetDir, 'app', 'src', 'test', 'java', ...appId.split('.')), { recursive: true });
    await fs.mkdir(path.join(targetDir, 'gradle', 'wrapper'), { recursive: true });

    const settingsGradlePath = path.join(targetDir, 'settings.gradle.kts');
    await fs.writeFile(
      settingsGradlePath,
      `pluginManagement {\n    repositories {\n        google()\n        mavenCentral()\n        gradlePluginPortal()\n    }\n}\ndependencyResolutionManagement {\n    repositories {\n        google()\n        mavenCentral()\n    }\n}\nrootProject.name = "${sanitizeIdent(projectName)}"\ninclude(":app")\n`,
      'utf-8'
    );
    created.push(settingsGradlePath);

    const rootBuildGradlePath = path.join(targetDir, 'build.gradle.kts');
    await fs.writeFile(rootBuildGradlePath, `plugins {\n    id("com.android.application") version "8.5.2" apply false\n    id("org.jetbrains.kotlin.android") version "2.0.20" apply false\n}\n`, 'utf-8');
    created.push(rootBuildGradlePath);

    const appBuildGradlePath = path.join(targetDir, 'app', 'build.gradle.kts');
    await fs.writeFile(
      appBuildGradlePath,
      `plugins {\n    id("com.android.application")\n    id("org.jetbrains.kotlin.android")\n}\n\nandroid {\n    namespace = "${appId}"\n    compileSdk = 34\n\n    defaultConfig {\n        applicationId = "${appId}"\n        minSdk = 24\n        targetSdk = 34\n        versionCode = 1\n        versionName = "1.0"\n        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"\n    }\n\n    buildTypes {\n        release {\n            isMinifyEnabled = false\n        }\n    }\n    compileOptions {\n        sourceCompatibility = JavaVersion.VERSION_17\n        targetCompatibility = JavaVersion.VERSION_17\n    }\n    kotlinOptions {\n        jvmTarget = "17"\n    }\n}\n\ndependencies {\n    implementation("androidx.core:core-ktx:1.13.1")\n    implementation("androidx.appcompat:appcompat:1.7.0")\n    implementation("com.google.android.material:material:1.12.0")\n    testImplementation("junit:junit:4.13.2")\n    androidTestImplementation("androidx.test.ext:junit:1.2.1")\n}\n`,
      'utf-8'
    );
    created.push(appBuildGradlePath);
    const gradleWrapperDir = path.join(targetDir, 'gradle', 'wrapper');
    await fs.mkdir(gradleWrapperDir, { recursive: true });
    const gradlewPath = path.join(targetDir, 'gradlew');
    const gradlewBatPath = path.join(targetDir, 'gradlew.bat');
    const wrapperPropertiesPath = path.join(gradleWrapperDir, 'gradle-wrapper.properties');
    await fs.writeFile(wrapperPropertiesPath, 'distributionBase=GRADLE_USER_HOME\ndistributionPath=wrapper/dists\nzipStoreBase=GRADLE_USER_HOME\nzipStorePath=wrapper/dists\ndistributionUrl=https\://services.gradle.org/distributions/gradle-8.7-bin.zip\n', 'utf-8');
    await fs.writeFile(gradlewPath, `#!/bin/sh
set -eu
GRADLE_VERSION=8.7
if command -v gradle >/dev/null 2>&1; then exec gradle "$@"; fi
BASE="$HOME/.gradle/codex-wrapper/$GRADLE_VERSION"
if [ ! -x "$BASE/gradle-$GRADLE_VERSION/bin/gradle" ]; then
  mkdir -p "$BASE"
  curl -fsSL "https://services.gradle.org/distributions/gradle-$GRADLE_VERSION-bin.zip" -o "$BASE/gradle.zip"
  unzip -q -o "$BASE/gradle.zip" -d "$BASE"
  rm -f "$BASE/gradle.zip"
fi
exec "$BASE/gradle-$GRADLE_VERSION/bin/gradle" "$@"
`, 'utf-8');
    await fs.chmod(gradlewPath, 0o755);
    await fs.writeFile(gradlewBatPath, `@echo off
setlocal
where gradle >nul 2>nul
if %ERRORLEVEL% EQU 0 ( gradle %* & exit /b %ERRORLEVEL% )
set "VER=8.7"
set "BASE=%USERPROFILE%\.gradle\codex-wrapper\%VER%"
if not exist "%BASE%\gradle-%VER%\bin\gradle.bat" ( powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path '%BASE%' | Out-Null; Invoke-WebRequest -UseBasicParsing -Uri 'https://services.gradle.org/distributions/gradle-%VER%-bin.zip' -OutFile '%BASE%\gradle.zip'; Expand-Archive -Force '%BASE%\gradle.zip' '%BASE%'; Remove-Item '%BASE%\gradle.zip'" )
call "%BASE%\gradle-%VER%\bin\gradle.bat" %*
`, 'utf-8');
    created.push(gradlewPath, gradlewBatPath, wrapperPropertiesPath);


    const manifestPath = path.join(targetDir, 'app', 'src', 'main', 'AndroidManifest.xml');
    await fs.writeFile(
      manifestPath,
      `<?xml version="1.0" encoding="utf-8"?>\n<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n    <application\n        android:allowBackup="true"\n        android:label="${projectName}"\n        android:theme="@style/Theme.AppCompat">\n        <activity\n            android:name=".MainActivity"\n            android:exported="true">\n            <intent-filter>\n                <action android:name="android.intent.action.MAIN" />\n                <category android:name="android.intent.category.LAUNCHER" />\n            </intent-filter>\n        </activity>\n    </application>\n</manifest>\n`,
      'utf-8'
    );
    created.push(manifestPath);

    const mainActivityPath = path.join(
      targetDir,
      'app',
      'src',
      'main',
      'java',
      ...appId.split('.'),
      'MainActivity.kt'
    );
    await fs.writeFile(
      mainActivityPath,
      `package ${appId}\n\nimport android.os.Bundle\nimport android.widget.TextView\nimport androidx.appcompat.app.AppCompatActivity\n\nclass MainActivity : AppCompatActivity() {\n    override fun onCreate(savedInstanceState: Bundle?) {\n        super.onCreate(savedInstanceState)\n        val view = TextView(this)\n        view.text = "Hello from ${projectName}, generated by CodeX Desktop."\n        setContentView(view)\n    }\n}\n`,
      'utf-8'
    );
    created.push(mainActivityPath);

    const unitTestPath = path.join(targetDir, 'app', 'src', 'test', 'java', ...appId.split('.'), 'ExampleUnitTest.kt');
    await fs.writeFile(
      unitTestPath,
      `package ${appId}\n\nimport org.junit.Test\nimport org.junit.Assert.assertEquals\n\nclass ExampleUnitTest {\n    @Test\n    fun addition_isCorrect() {\n        assertEquals(4, 2 + 2)\n    }\n}\n`,
      'utf-8'
    );
    created.push(unitTestPath);

    const gradlePropsPath = path.join(targetDir, 'gradle.properties');
    await fs.writeFile(gradlePropsPath, `android.useAndroidX=true\nkotlin.code.style=official\n`, 'utf-8');
    created.push(gradlePropsPath);

    return created;
  }
}

function sanitizePackageSegment(name: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return cleaned.length > 0 ? cleaned : 'app';
}

function sanitizeIdent(name: string): string {
  return name.replace(/[^A-Za-z0-9-]/g, '-');
}
