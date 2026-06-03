# FeckBills agent image — the read-only cloud waste scanner.
#
# Build from the repo root:
#   docker build -t feckbills-agent .
#
# Run a scan (read-only ADC creds mounted in; findings printed):
#   docker run --rm -v $HOME/.config/gcloud:/root/.config/gcloud \
#     feckbills-agent scan --project YOUR_PROJECT
#
# Cloud Run / k8s override the args (e.g. scan --all-projects --push <url>).
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
# Install only the CLI + its workspace deps, build core + cli, then produce a
# standalone deployable (dist + prod node_modules) under /agent.
# `--legacy`: pnpm v10 refuses to deploy non-injected workspaces by default;
# legacy mode copies the workspace deps (incl. @feckbills/core) into /agent.
RUN pnpm install --frozen-lockfile --filter "@feckbills/cli..." \
 && pnpm --filter @feckbills/core build \
 && pnpm --filter @feckbills/cli build \
 && pnpm --filter @feckbills/cli deploy --prod --legacy /agent

FROM node:22-alpine
WORKDIR /agent
COPY --from=build /agent .
# Default to help; runtime overrides with the scan command + args.
ENTRYPOINT ["node", "dist/index.js"]
CMD ["--help"]
