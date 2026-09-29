# CodeX Environment Pack: Rust
# Base image tag referenced by RustEnvironmentPack.ts: codex-rust:1.81
FROM rust:1.81-slim-bookworm

RUN groupadd --gid 1000 codex && \
    useradd --uid 1000 --gid codex --shell /bin/bash --create-home codex && \
    apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
RUN chown -R codex:codex /workspace /usr/local/cargo

USER codex

CMD ["sleep", "infinity"]
