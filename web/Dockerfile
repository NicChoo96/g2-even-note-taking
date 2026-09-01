# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ── Runtime stage ────────────────────────────────────────────────────────────
# The relay (server/local-sse.mjs) has ZERO runtime dependencies — it only needs
# the built web app (dist/) + the server file. Small and fast to boot.
FROM node:20-alpine
WORKDIR /app
ENV PORT=8080
EXPOSE 8080

COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server

CMD ["node", "server/local-sse.mjs"]
