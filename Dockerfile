# Root Dockerfile — deploy the ENTIRE repo to a persistent host.
# Builds the web app (inside web/) and runs the always-on relay that serves
# the web UI + the live SSE stream (web/server/local-sse.mjs).

# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

# Copy just web/ (the deployable app) for better layer caching.
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ── Runtime stage ────────────────────────────────────────────────────────────
# The relay has ZERO runtime dependencies — only needs the built dist + server.
FROM node:20-alpine
WORKDIR /app
ENV PORT=8080
EXPOSE 8080

COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server

CMD ["node", "server/local-sse.mjs"]
