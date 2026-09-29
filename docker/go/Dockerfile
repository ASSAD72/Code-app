# CodeX Environment Pack: Go
# Base image tag referenced by GoEnvironmentPack.ts: codex-go:1.23
FROM golang:1.23-bookworm

RUN groupadd --gid 1000 codex && \
    useradd --uid 1000 --gid codex --shell /bin/bash --create-home codex

WORKDIR /workspace
RUN chown -R codex:codex /workspace /go

USER codex
ENV GOPATH=/go
ENV PATH=$PATH:/go/bin

CMD ["sleep", "infinity"]
