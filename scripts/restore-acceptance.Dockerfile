# Build from this directory so no application source, .env, or credentials enter the image:
# docker build -f scripts/restore-acceptance.Dockerfile -t handrail-restore-acceptance:dev scripts
FROM node:22.14.0-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-15 git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV PG_BINDIR=/usr/lib/postgresql/15/bin
ENV TMPDIR=/tmp
# initdb must never run as root. Mount the current checkout read-only at /workspace.
USER node
WORKDIR /workspace
CMD ["node", "scripts/accept-restore.mjs"]
