# =============================================================================
# LEXA Scraper Service v5.0.1
# Dockerfile para deployment en EasyPanel/Docker
# =============================================================================
FROM node:20-alpine

# Metadata
LABEL maintainer="LEXA Asistente Legal"
LABEL version="5.0.1"
LABEL description="SINOE Scraper - Automatización de notificaciones judiciales"

# Configurar timezone Lima
ENV TZ=America/Lima
RUN apk add --no-cache tzdata && \
    cp /usr/share/zoneinfo/America/Lima /etc/localtime && \
    echo "America/Lima" > /etc/timezone

# Crear directorio de trabajo
WORKDIR /app

# Copiar package.json primero (para cache de dependencias)
COPY package*.json ./

# Instalar dependencias de producción
# NOTA: Usamos 'npm install' en vez de 'npm ci' porque no tenemos package-lock.json
# --omit=dev reemplaza el deprecado --only=production
RUN npm install --omit=dev && \
    npm cache clean --force

# Copiar código fuente
COPY core.js ./
COPY flujo-estable.js ./
COPY extraccion.js ./
COPY index.js ./

# Crear usuario no-root por seguridad
RUN addgroup -g 1001 -S nodejs && \
    adduser -S lexa -u 1001 -G nodejs

# Cambiar ownership de archivos
RUN chown -R lexa:nodejs /app

# Cambiar a usuario no-root
USER lexa

# Exponer puerto
EXPOSE 3001

# Variables de entorno por defecto
ENV NODE_ENV=production
ENV PORT=3001

# Health check - puerto 3001, start-period 30s para dar tiempo al arranque
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=5 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

# Comando de inicio
CMD ["node", "index.js"]
