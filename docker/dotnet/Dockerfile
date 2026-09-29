# CodeX Environment Pack: .NET / C#
# Base image tag referenced by DotNetEnvironmentPack.ts: codex-dotnet:8.0
FROM mcr.microsoft.com/dotnet/sdk:8.0

RUN groupadd --gid 1000 codex && \
    useradd --uid 1000 --gid codex --shell /bin/bash --create-home codex

WORKDIR /workspace
RUN chown -R codex:codex /workspace

USER codex

CMD ["sleep", "infinity"]
