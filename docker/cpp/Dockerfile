# CodeX Environment Pack: C / C++
# Base image tag referenced by CppEnvironmentPack.ts: codex-cpp:gcc14
FROM debian:bookworm-slim

RUN groupadd --gid 1000 codex && \
    useradd --uid 1000 --gid codex --shell /bin/bash --create-home codex && \
    apt-get update && apt-get install -y --no-install-recommends \
      build-essential gcc-14 g++-14 clang-18 cmake ninja-build gdb make \
      ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
RUN chown -R codex:codex /workspace

USER codex

CMD ["sleep", "infinity"]
