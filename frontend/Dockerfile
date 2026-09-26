FROM node:22-alpine AS base

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# ── Development Stage ──────────────────────────────────────────────────────────
FROM base AS development
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
CMD ["npm", "run", "dev"]

# ── Builder Stage ──────────────────────────────────────────────────────────────
FROM base AS builder

ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_RPC_URL
ARG NEXT_PUBLIC_NETWORK_PASSPHRASE
ARG NEXT_PUBLIC_EXPLORER_URL
ARG NEXT_PUBLIC_LENDING_POOL_CONTRACT_ID
# Deprecated alias for NEXT_PUBLIC_LENDING_POOL_CONTRACT_ID, kept for
# backward compatibility with existing deploy configs.
ARG NEXT_PUBLIC_MANAGER_CONTRACT_ID
ARG NEXT_PUBLIC_POOL_CONTRACT_ID
ARG NEXT_PUBLIC_GOVERNANCE_CONTRACT_ID
ARG NEXT_PUBLIC_NFT_CONTRACT_ID

# Build-time metadata for OCI labels.
ARG GIT_SHA=""
ARG BUILD_TIME=""

ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_RPC_URL=$NEXT_PUBLIC_RPC_URL
ENV NEXT_PUBLIC_NETWORK_PASSPHRASE=$NEXT_PUBLIC_NETWORK_PASSPHRASE
ENV NEXT_PUBLIC_EXPLORER_URL=$NEXT_PUBLIC_EXPLORER_URL
ENV NEXT_PUBLIC_LENDING_POOL_CONTRACT_ID=$NEXT_PUBLIC_LENDING_POOL_CONTRACT_ID
ENV NEXT_PUBLIC_MANAGER_CONTRACT_ID=$NEXT_PUBLIC_MANAGER_CONTRACT_ID
ENV NEXT_PUBLIC_POOL_CONTRACT_ID=$NEXT_PUBLIC_POOL_CONTRACT_ID
ENV NEXT_PUBLIC_GOVERNANCE_CONTRACT_ID=$NEXT_PUBLIC_GOVERNANCE_CONTRACT_ID
ENV NEXT_PUBLIC_NFT_CONTRACT_ID=$NEXT_PUBLIC_NFT_CONTRACT_ID

RUN npm run build

# ── Production/Runner Stage ────────────────────────────────────────────────────
# Minimal runtime image: only the Next.js standalone output, no build tools.
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json

# Install production-only dependencies then remove the lockfile from the layer.
RUN npm ci --omit=dev && rm -f package-lock.json

# Non-root user for security.
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Ensure the working directory is owned by the non-root user so that
# read_only container mounts do not cause permission errors at startup.
RUN chown -R appuser:appgroup /app

USER appuser

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# OCI image labels for supply-chain traceability (SLSA L1 minimum).
ARG GIT_SHA=""
ARG BUILD_TIME=""
LABEL org.opencontainers.image.source="https://github.com/JhayJ22/remitlend" \
      org.opencontainers.image.description="RemitLend frontend" \
      org.opencontainers.image.licenses="ISC" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_TIME}"

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "start"]
