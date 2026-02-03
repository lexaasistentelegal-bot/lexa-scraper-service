# ============================================================
# LEXA SCRAPER SERVICE v4.9.0 - Dockerfile
# ============================================================
# 
# ESTRUCTURA:
#   - core.js   → Funciones base (NO MODIFICAR)
#   - index.js  → Lógica de negocio (MODIFICABLE)
#
# ============================================================

FROM node:20-alpine

WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./

# Instalar dependencias
RUN npm ci --only=production

# Copiar código fuente (core.js + index.js)
COPY core.js ./
COPY index.js ./

# Puerto por defecto
ENV PORT=3001

EXPOSE 3001

# Ejecutar
CMD ["node", "index.js"]
