# LEXA Scraper Service v5.0.0

Servicio de scraping automatizado para el sistema SINOE (Sistema de Notificaciones Electrónicas) del Poder Judicial del Perú.

## 🎯 Descripción

LEXA Scraper automatiza la extracción de notificaciones judiciales:
1. Detecta notificaciones vía Gmail
2. Notifica al abogado por WhatsApp/Telegram
3. El abogado resuelve el CAPTCHA manualmente (30 seg)
4. Descarga automáticamente los PDFs
5. Analiza documentos con IA (Claude API)
6. Agenda audiencias en Google Calendar
7. Guarda documentos en Drive

## 📁 Arquitectura Modular

```
lexa-scraper-service/
├── core.js           # Configuración, utilidades, WhatsApp (NO TOCAR)
├── flujo-estable.js  # Pasos 10-13: CAPTCHA→Login→Dashboard→Casillas (NO TOCAR)
├── extraccion.js     # Pasos 14-15: Extraer tabla, descargar PDFs (MODIFICAR AQUÍ)
├── index.js          # Orquestador principal + API REST
├── package.json      # Dependencias
├── Dockerfile        # Containerización
└── README.md         # Esta documentación
```

### Módulos

| Módulo | Responsabilidad | ¿Modificar? |
|--------|----------------|-------------|
| `core.js` | Configuración, logging, WhatsApp, CAPTCHA | ❌ NO TOCAR |
| `flujo-estable.js` | Pasos 10-13 (login funciona ✅) | ❌ NO TOCAR |
| `extraccion.js` | Pasos 14-15 (extracción/descargas) | ✅ MODIFICAR |
| `index.js` | Orquestación + API REST | ⚠️ Con cuidado |

### Flujo de ejecución

```
Pasos 1-9:   core.js          → Conexión, navegación, credenciales, WhatsApp
Paso 10:     flujo-estable.js → Escribir CAPTCHA en campo ✅
Paso 11:     flujo-estable.js → Hacer clic en "Ingresar" ✅
Paso 12:     flujo-estable.js → Verificar dashboard (5 reintentos) ✅
Paso 13:     flujo-estable.js → Navegar a Casillas Electrónicas ✅
Paso 14:     extraccion.js    → Extraer notificaciones de tabla
Paso 15:     extraccion.js    → Descargar consolidados/anexos
```

## 🚀 Instalación

### Requisitos
- Node.js >= 18.0.0
- Browserless (Chrome remoto)
- Evolution API (WhatsApp)

### Actualizar repositorio existente

```bash
# 1. Ir a tu carpeta del proyecto
cd lexa-scraper-service

# 2. Eliminar archivos viejos (ya no se usan)
rm -f login.js casillas.js descargas.js

# 3. Descargar nuevos archivos (o copiarlos manualmente)
# Los archivos nuevos son:
#   - core.js (sin cambios)
#   - flujo-estable.js (NUEVO - pasos 10-13)
#   - extraccion.js (NUEVO - pasos 14-15)  
#   - index.js (ACTUALIZADO)

# 4. Commit y push
git add .
git commit -m "v5.0.0 - Arquitectura modular separada"
git push origin main
```

### Instalación desde cero

```bash
git clone https://github.com/lexaasistentelegal-bot/lexa-scraper-service.git
cd lexa-scraper-service
npm install
```

### Variables de entorno

Crear archivo `.env` o configurar en EasyPanel:

```env
# Servidor
PORT=3050
API_KEY=tu-api-key-secreta

# Browserless
BROWSERLESS_URL=wss://browser.tudominio.com
BROWSERLESS_TOKEN=tu-token-browserless

# Evolution API (WhatsApp)
EVOLUTION_API_URL=https://evo.tudominio.com
EVOLUTION_API_KEY=tu-api-key-evolution
EVOLUTION_INSTANCE=sinoe-bot

# SINOE (credenciales de prueba)
SINOE_USUARIO=106665
SINOE_PASSWORD=tu-password

# Telegram (opcional)
TELEGRAM_BOT_TOKEN=tu-bot-token
TELEGRAM_CHAT_ID=tu-chat-id

# Anthropic (para análisis IA)
ANTHROPIC_API_KEY=sk-ant-api03-...
```

### Ejecutar

```bash
# Producción
npm start

# Desarrollo (auto-reload)
npm run dev
```

## 🔌 API REST

### Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/health` | Estado del servicio |
| `GET` | `/metricas` | Estadísticas de uso |
| `GET` | `/sesiones` | Sesiones activas |
| `POST` | `/scraper` | Ejecutar scraping |
| `POST` | `/webhook/whatsapp` | Recibir CAPTCHA |
| `POST` | `/test-whatsapp` | Probar envío WhatsApp |
| `POST` | `/test-conexion` | Probar Browserless |
| `POST` | `/test-diagnostico-casillas` | Diagnosticar tabla |

### Ejemplo: Ejecutar scraper

```bash
curl -X POST http://localhost:3050/scraper \
  -H "Content-Type: application/json" \
  -H "x-api-key: tu-api-key" \
  -d '{
    "usuario": "106665",
    "password": "xxx",
    "whatsapp": "51977299329",
    "expediente": "00123-2024"
  }'
```

### Respuesta exitosa

```json
{
  "success": true,
  "mensaje": "Scraping iniciado",
  "sesionId": "abc123",
  "debuggerUrl": "https://browser.tudominio.com/debugger?token=..."
}
```

## 🔄 Flujo de Ejecución

```
1.  Conexión a Browserless
2.  Navegación a SINOE
3.  Detección de sesión activa
4.  Carga de página de login
5.  Llenado de credenciales
6.  Verificación de CAPTCHA
7.  Captura de formulario
8.  Envío de WhatsApp con link
9.  Espera de CAPTCHA (5 min máx)
10. Verificación de estado
11. Clic en botón login
12. Verificación de dashboard
13. Navegación a casillas
14. Extracción de notificaciones
15. Descarga de consolidados
16. Cierre de navegador
17. Respuesta final
```

## 🐳 Docker

### Build

```bash
docker build -t lexa-scraper-service:5.0.0 .
```

### Run

```bash
docker run -d \
  --name lexa-scraper \
  -p 3050:3050 \
  -e API_KEY=tu-api-key \
  -e BROWSERLESS_URL=wss://browser.tudominio.com \
  -e BROWSERLESS_TOKEN=xxx \
  -e EVOLUTION_API_URL=https://evo.tudominio.com \
  -e EVOLUTION_API_KEY=xxx \
  lexa-scraper-service:5.0.0
```

### EasyPanel

1. Crear nuevo servicio "App" en EasyPanel
2. Conectar repositorio GitHub
3. Configurar variables de entorno
4. Puerto: 3050
5. Dominio: scraper.tudominio.com
6. Activar HTTPS

## 🔧 Configuración Browserless

```env
MAX_CONCURRENT_SESSIONS=2
CONNECTION_TIMEOUT=600000
PREBOOT_CHROME=true
KEEP_ALIVE=true
DEFAULT_BLOCK_ADS=true
TOKEN=tu-token-seguro
```

### Conexión desde scraper

```javascript
// URL pública (recomendada)
wss://browser.tudominio.com?token=TU_TOKEN

// URL interna Docker (puede fallar Issue #740)
ws://sinoe-browserless:3000
```

## 📱 WhatsApp (Evolution API)

### Formato de número
```
51977299329  ✅ (sin +, sin espacios)
+51 977 299 329  ❌
```

### Envío de mensaje
```bash
curl -X POST https://evo.tudominio.com/message/sendText/sinoe-bot \
  -H "apikey: tu-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "number": "51977299329",
    "text": "📩 Nueva notificación SINOE detectada"
  }'
```

## 🔍 Debugging

### Diagnóstico de casillas
```bash
curl -X POST http://localhost:3050/test-diagnostico-casillas \
  -H "x-api-key: tu-api-key"
```

### Logs
```bash
# Docker
docker logs -f lexa-scraper

# EasyPanel
Ver pestaña "Logs" del servicio
```

### Debugger visual
Acceder a `https://browser.tudominio.com/debugger?token=...` para ver Chrome en tiempo real.

## ⚠️ Errores comunes

| Error | Causa | Solución |
|-------|-------|----------|
| `No se encontró tabla` | AJAX no cargó | Aumentar timeout, revisar selectores |
| `CAPTCHA incorrecto` | Usuario escribió mal | Reintentar flujo |
| `Sesión activa` | Login previo no cerrado | Sistema maneja automáticamente |
| `Connection refused` | Browserless caído | Verificar servicio |
| `Frame detached` | Navegación interrumpida | Reintentar, usar `leerContenidoSeguro()` |

## 📊 Métricas

El endpoint `/metricas` retorna:
- Total de ejecuciones
- Ejecuciones exitosas/fallidas
- Tiempo promedio de ejecución
- Última ejecución

## 🔐 Seguridad

- API Key requerida en header `x-api-key`
- Credenciales SINOE nunca se loguean
- Token de Browserless en URL
- Rate limiting: 10 requests/minuto por IP

## 📝 Changelog

### v5.0.0 (2026-02-04)
- Refactorización modular completa
- Nuevo módulo `login.js` con 7 estrategias de clic
- Nuevo módulo `casillas.js` con extracción multi-estrategia
- Nuevo módulo `descargas.js` para consolidados
- Diagnóstico mejorado de tablas
- Manejo de AJAX/PrimeFaces DataTable

### v4.9.9 (anterior)
- Versión monolítica funcional hasta paso 13

## 📄 Licencia

Propietario - LEXA Asistente Legal © 2026

## 🤝 Soporte

- GitHub Issues: https://github.com/lexaasistentelegal-bot/lexa-scraper-service/issues
- WhatsApp: +51 977 299 329
