# ============================================================
# LEXA SCRAPER SERVICE v4.1.0 (AAA) - Dockerfile
# ============================================================
# Imagen ligera de Node.js 20 Alpine
# Solo puppeteer-core (no descarga Chrome, usa Browserless)

FROM node:20-alpine

# Directorio de trabajo
WORKDIR /app

# Copiar package.json primero (para cachear dependencias)
COPY package*.json ./

# Instalar dependencias
RUN npm ci --only=production

# Copiar código fuente
COPY index.js ./

# Puerto expuesto
EXPOSE 3001

# Healthcheck para EasyPanel
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

# Comando de inicio
CMD ["node", "index.js"]
