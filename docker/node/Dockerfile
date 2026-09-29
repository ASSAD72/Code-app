# CodeX Environment Pack: Node.js / Web
# Base image tag referenced by NodeEnvironmentPack.ts: codex-node:20
FROM node:20-bookworm-slim

# Spec section 4: non-root user inside every sandbox container.
RUN groupadd --gid 1000 codex && \
    useradd --uid 1000 --gid codex --shell /bin/bash --create-home codex

# Common tooling used across Node/web projects.
RUN npm install -g pnpm@9 yarn@1 typescript@5.6.2 && \
    npm cache clean --force

WORKDIR /workspace
RUN chown -R codex:codex /workspace

USER codex

CMD ["sleep", "infinity"]
