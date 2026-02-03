# ============================================================
# LEXA SCRAPER SERVICE v4.9.0 - Dockerfile
# ============================================================

FROM node:20-alpine

WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./

# Instalar dependencias (npm install porque no hay package-lock.json)
RUN npm install --omit=dev

# Copiar código fuente
COPY core.js ./
COPY index.js ./

# Puerto por defecto
ENV PORT=3001

EXPOSE 3001

# Ejecutar
CMD ["node", "index.js"]
