# Integration test matrix

| Area | Static tests | Host runtime needed |
|---|---:|---|
| TypeScript build | yes | no |
| Tool path policy | yes | no |
| Repair path policy | yes | no |
| Docker build/exec/export | partial | Docker daemon |
| WSL2 network/isolation | partial | Windows + WSL2 |
| Windows Sandbox | partial | Windows Pro/Enterprise + feature |
| Android APK | structural | Android SDK/Gradle |
| Flutter APK | structural | Flutter + Android SDK |
| React Native Android | structural | Android SDK/Gradle |
| Native Windows export | structural | Windows toolchain |
