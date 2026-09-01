# Root Dockerfile — deploy the ENTIRE repo to a persistent host.
# Builds BOTH apps and runs the always-on relay that serves:
#   /         -> the web pasteboard app (web/dist)
#   /glasses/ -> the G2 glasses app (glasses/dist) — scan this in the Even App
#   /api/stream -> the live SSE/state stream (web/server/local-sse.mjs)

# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

# Web app (pasteboard UI + relay)
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci
COPY web/ ./web/
RUN cd web && npm run build

# Glasses app (Even Hub WebView). Built with base=/glasses/ so its asset paths
# resolve under the /glasses/ route the relay serves it from.
COPY glasses/package.json glasses/package-lock.json ./glasses/
RUN cd glasses && npm ci
COPY glasses/ ./glasses/
RUN cd glasses && npm run build:deploy

# ── Runtime stage ────────────────────────────────────────────────────────────
# The relay has ZERO runtime dependencies — only needs the built dists + server.
FROM node:20-alpine
WORKDIR /app
ENV PORT=8080
EXPOSE 8080

COPY --from=build /app/web/dist ./dist
COPY --from=build /app/web/server ./server
COPY --from=build /app/glasses/dist ./glasses-dist

CMD ["node", "server/local-sse.mjs"]
