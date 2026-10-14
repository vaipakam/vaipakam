# Keeper machine runner image (docs/ops/KeeperMachine.md).
#
# Runtime-only. The image carries the ONE self-contained bundle that
# `pnpm --filter @vaipakam/keeper run build:machine` produces, and no
# workspace, no node_modules and no source. Build the bundle first, then build
# the image with apps/keeper as the context:
#
#   pnpm --filter @vaipakam/keeper run build:machine
#   docker build -f apps/keeper/machine/deploy/Dockerfile -t vaipakam-keeper apps/keeper
#
# Run, with the env file supplied at run time and never baked into the image:
#
#   docker run -d --name vaipakam-keeper --restart unless-stopped \
#     --env-file apps/keeper/machine/.env.machine --stop-timeout 300 vaipakam-keeper
#
# `--stop-timeout 300`: a stop sends SIGTERM. The runner finishes the tick in
# flight, which may be waiting on a transaction receipt, and only then exits.
# Docker's default 10 s would SIGKILL it mid-pass.
#
# Docker's --env-file reads `KEY=value` lines literally, with no quotes and no
# inline comments. The example file is written in that subset, so the same
# file works for docker and for `node --env-file`.
FROM node:22-bookworm-slim

WORKDIR /app
COPY dist/keeper-machine.mjs ./keeper-machine.mjs

# The image's built-in unprivileged user. The runner needs no filesystem
# writes: its state lives in D1, its logs go to stdout.
USER node
STOPSIGNAL SIGTERM
CMD ["node", "keeper-machine.mjs"]
