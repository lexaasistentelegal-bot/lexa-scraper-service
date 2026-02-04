# =============================================================================
# LEXA Scraper Service v5.0.0
# Dockerfile para deployment en EasyPanel/Docker
# =============================================================================

FROM node:20-alpine

# Metadata
LABEL maintainer="LEXA Asistente Legal"
LABEL version="5.0.0"
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
RUN npm ci --only=production && \
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
EXPOSE 3050

# Variables de entorno por defecto
ENV NODE_ENV=production
ENV PORT=3050

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3050/health || exit 1

# Comando de inicio
CMD ["node", "index.js"]
