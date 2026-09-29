# CodeX Environment Pack: Flutter
# Base image tag referenced by FlutterEnvironmentPack.ts: codex-flutter:3.24
FROM eclipse-temurin:17-jdk-jammy

RUN groupadd --gid 1000 codex && \
    useradd --uid 1000 --gid codex --shell /bin/bash --create-home codex && \
    apt-get update && apt-get install -y --no-install-recommends \
      curl git unzip xz-utils zip libglu1-mesa ca-certificates && \
    rm -rf /var/lib/apt/lists/*

ENV FLUTTER_HOME=/opt/flutter
ENV PATH=${PATH}:${FLUTTER_HOME}/bin

ENV ANDROID_HOME=/opt/android-sdk
ENV ANDROID_SDK_ROOT=${ANDROID_HOME}
ENV PATH=${PATH}:${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${FLUTTER_HOME}/bin
RUN mkdir -p ${ANDROID_HOME}/cmdline-tools && \
    curl -sSL https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -o /tmp/cmdline-tools.zip && \
    unzip -q /tmp/cmdline-tools.zip -d ${ANDROID_HOME}/cmdline-tools && \
    mv ${ANDROID_HOME}/cmdline-tools/cmdline-tools ${ANDROID_HOME}/cmdline-tools/latest && \
    rm /tmp/cmdline-tools.zip && \
    yes | sdkmanager --licenses >/dev/null 2>&1 && \
    sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"

RUN git clone --branch 3.24.3 --depth 1 https://github.com/flutter/flutter.git ${FLUTTER_HOME} && \
    chown -R codex:codex ${FLUTTER_HOME}

WORKDIR /workspace
RUN chown -R codex:codex /workspace

USER codex
RUN flutter precache && flutter config --no-analytics

CMD ["sleep", "infinity"]
