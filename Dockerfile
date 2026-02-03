# ============================================================
# LEXA SCRAPER SERVICE v4.1.0 (AAA) - Dockerfile
# ============================================================

FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

# Usar npm install en lugar de npm ci (no requiere package-lock.json)
RUN npm install --only=production

COPY index.js ./

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

CMD ["node", "index.js"]
