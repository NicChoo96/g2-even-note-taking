# Root Dockerfile — deploy the UNIFIED app to a persistent host.
# ONE app at the bare root URL: it renders the companion web UI in any browser
# AND draws to the G2 glasses via the Even Hub SDK when loaded in the Even App
# (exactly like the official evenhub-templates). The relay serves it at /
# plus the live SSE/state stream.

# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

COPY glasses/package.json glasses/package-lock.json ./glasses/
RUN cd glasses && npm ci
COPY glasses/ ./glasses/
RUN cd glasses && npm run build:deploy

# ── Runtime stage ────────────────────────────────────────────────────────────
# The relay has ZERO runtime dependencies — only needs the built dist + server.
FROM node:20-alpine
WORKDIR /app
ENV PORT=8080
EXPOSE 8080

COPY web/server ./server
COPY --from=build /app/glasses/dist ./glasses-dist

CMD ["node", "server/local-sse.mjs"]
