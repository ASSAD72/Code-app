# CodeX Environment Pack: Python
# Base image tag referenced by PythonEnvironmentPack.ts: codex-python:3.12
FROM python:3.12-slim-bookworm

RUN groupadd --gid 1000 codex && \
    useradd --uid 1000 --gid codex --shell /bin/bash --create-home codex

RUN pip install --no-cache-dir --upgrade pip==24.2 pytest==8.3.3 virtualenv==20.26.6

WORKDIR /workspace
RUN chown -R codex:codex /workspace

USER codex

CMD ["sleep", "infinity"]
