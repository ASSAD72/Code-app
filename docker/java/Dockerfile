# CodeX Environment Pack: Java / JVM
# Base image tag referenced by JavaEnvironmentPack.ts: codex-java:21
FROM eclipse-temurin:21-jdk-jammy

RUN groupadd --gid 1000 codex && \
    useradd --uid 1000 --gid codex --shell /bin/bash --create-home codex && \
    apt-get update && apt-get install -y --no-install-recommends unzip curl && \
    rm -rf /var/lib/apt/lists/*

ENV GRADLE_VERSION=8.10
RUN curl -sSL https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip -o /tmp/gradle.zip && \
    unzip -q /tmp/gradle.zip -d /opt && \
    ln -s /opt/gradle-${GRADLE_VERSION}/bin/gradle /usr/local/bin/gradle && \
    rm /tmp/gradle.zip

WORKDIR /workspace
RUN chown -R codex:codex /workspace

USER codex

CMD ["sleep", "infinity"]
