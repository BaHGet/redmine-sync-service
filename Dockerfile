# ---- Stage 1: Build ----
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig*.json nest-cli.json prisma.config.ts ./
COPY src ./src
COPY prisma ./prisma

RUN npx prisma generate && npm run build && ls -la dist

# Prune devDependencies in place so production stage can copy a clean node_modules
RUN npm prune --omit=dev

# ---- Stage 2: Production ----
FROM node:22-alpine AS production

WORKDIR /app

# Create non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy everything built & pruned from builder — no re-install, so generated Prisma client is preserved
COPY --from=builder --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:appgroup /app/dist ./dist
COPY --from=builder --chown=appuser:appgroup /app/prisma ./prisma
COPY --from=builder --chown=appuser:appgroup /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder --chown=appuser:appgroup /app/package.json ./package.json

# Export output directory
RUN mkdir -p /app/exports && chown appuser:appgroup /app/exports

USER appuser

EXPOSE 3000

CMD ["node", "dist/main.js"]
