# CodeX Environment Pack: Android
# Base image tag referenced by AndroidEnvironmentPack.ts: codex-android:sdk34
#
# NOTE (spec section 7): this image is used for compile/assemble/unit-test
# steps that DON'T require the emulator (assembleDebug, testDebugUnitTest,
# lint, etc). Emulator-dependent steps route through WSL2Provider or the
# host process directly via AndroidRuntimeProvider — see
# src/environments/android/AndroidRuntimeProvider.ts — since nested Docker
# cannot reliably provide the hardware virtualization the emulator needs.
FROM eclipse-temurin:17-jdk-jammy

RUN groupadd --gid 1000 codex && \
    useradd --uid 1000 --gid codex --shell /bin/bash --create-home codex && \
    apt-get update && apt-get install -y --no-install-recommends \
      unzip curl ca-certificates git && \
    rm -rf /var/lib/apt/lists/*

ENV ANDROID_HOME=/opt/android-sdk
ENV ANDROID_SDK_ROOT=${ANDROID_HOME}
ENV PATH=${PATH}:${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools
ARG GRADLE_VERSION=8.7
RUN curl -sSL https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip -o /tmp/gradle.zip && \
    unzip -q /tmp/gradle.zip -d /opt && \
    rm /tmp/gradle.zip
ENV PATH=${PATH}:/opt/gradle-${GRADLE_VERSION}/bin

RUN mkdir -p ${ANDROID_HOME}/cmdline-tools && \
    curl -sSL https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -o /tmp/cmdline-tools.zip && \
    unzip -q /tmp/cmdline-tools.zip -d ${ANDROID_HOME}/cmdline-tools && \
    mv ${ANDROID_HOME}/cmdline-tools/cmdline-tools ${ANDROID_HOME}/cmdline-tools/latest && \
    rm /tmp/cmdline-tools.zip

RUN yes | sdkmanager --licenses > /dev/null 2>&1 && \
    sdkmanager \
      "platform-tools" \
      "platforms;android-34" \
      "build-tools;34.0.0" \
      "cmdline-tools;latest"

WORKDIR /workspace
RUN chown -R codex:codex /workspace ${ANDROID_HOME}

USER codex

CMD ["sleep", "infinity"]
