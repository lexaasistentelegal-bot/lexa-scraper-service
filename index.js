/**
 * LEXA SCRAPER SERVICE
 * Microservicio para scraping de SINOE con Puppeteer + Browserless
 * 
 * IMPORTANTE: El servidor DEBE escuchar en 0.0.0.0 para que EasyPanel
 * pueda hacer proxy correctamente desde el dominio externo.
 */

const express = require('express');
const puppeteer = require('puppeteer-core');

// ============================================================
// CONFIGURACIÓN
// ============================================================
const PORT = parseInt(process.env.PORT) || 3001;
const BROWSERLESS_URL = process.env.BROWSERLESS_URL || 'wss://browser.lexaasistentelegal.com';
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN || '';
const BROWSERLESS_DEBUGGER = process.env.BROWSERLESS_DEBUGGER || 'https://browser.lexaasistentelegal.com';

// Evolution API (WhatsApp)
const EVOLUTION_URL = process.env.EVOLUTION_URL || 'https://evo.lexaasistentelegal.com';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || '';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || 'lexa-bot';

// Timeouts estándar (en milisegundos)
const TIMEOUT_NAVEGACION = 60000;   // 1 min para cargar páginas
const TIMEOUT_CAPTCHA = 300000;     // 5 min para que el abogado resuelva
const TIMEOUT_DESCARGA = 120000;    // 2 min para descargar PDFs

// ============================================================
// SERVIDOR EXPRESS
// ============================================================
const app = express();
app.use(express.json({ limit: '50mb' }));

// CORS permisivo para desarrollo
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ============================================================
// ENDPOINT: Health Check
// ============================================================
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'lexa-scraper',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    config: {
      port: PORT,
      browserless: BROWSERLESS_URL ? 'configurado' : 'no configurado',
      evolution: EVOLUTION_URL ? 'configurado' : 'no configurado'
    }
  });
});

// ============================================================
// ENDPOINT: Info del servicio (más detallado)
// ============================================================
app.get('/', (req, res) => {
  res.json({
    name: 'LEXA Scraper Service',
    version: '1.0.0',
    description: 'Microservicio para scraping de SINOE con soporte de CAPTCHA manual',
    endpoints: {
      'GET /': 'Información del servicio',
      'GET /health': 'Estado del servicio',
      'POST /scraper': 'Iniciar sesión de scraping SINOE'
    },
    documentation: 'https://github.com/lexaasistentelegal-bot/lexa-scraper-service'
  });
});

// ============================================================
// ENDPOINT: Scraper SINOE
// ============================================================
app.post('/scraper', async (req, res) => {
  const { 
    usuario, 
    password, 
    expediente,
    whatsappNumber,
    clienteName 
  } = req.body;

  // Validación de parámetros
  if (!usuario || !password) {
    return res.status(400).json({
      success: false,
      error: 'Faltan credenciales de SINOE (usuario, password)'
    });
  }

  let browser = null;
  let sessionId = `session_${Date.now()}`;

  try {
    console.log(`[LEXA] Iniciando sesión ${sessionId}`);

    // Conectar a Browserless
    const wsEndpoint = BROWSERLESS_TOKEN 
      ? `${BROWSERLESS_URL}?token=${BROWSERLESS_TOKEN}`
      : BROWSERLESS_URL;

    console.log(`[LEXA] Conectando a Browserless...`);
    browser = await puppeteer.connect({
      browserWSEndpoint: wsEndpoint
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 768 });

    // Navegar a SINOE
    console.log(`[LEXA] Navegando a SINOE...`);
    await page.goto('https://cej.pj.gob.pe/cej/forms/busquedaform.html', {
      waitUntil: 'networkidle2',
      timeout: TIMEOUT_NAVEGACION
    });

    // Construir URL del debugger para el CAPTCHA
    const pages = await browser.pages();
    const targetId = pages.length > 0 ? page.target()._targetId : '';
    const debuggerUrl = `${BROWSERLESS_DEBUGGER}/devtools/inspector.html?ws=${BROWSERLESS_URL.replace('wss://', '').replace('ws://', '')}${BROWSERLESS_TOKEN ? `?token=${BROWSERLESS_TOKEN}` : ''}/devtools/page/${targetId}`;

    // Responder inmediatamente con la URL del debugger
    // El cliente (n8n) se encargará de enviar el WhatsApp y esperar
    res.json({
      success: true,
      sessionId: sessionId,
      message: 'Sesión iniciada. Esperando resolución de CAPTCHA.',
      debuggerUrl: debuggerUrl,
      instructions: 'Envía el debuggerUrl al abogado para que resuelva el CAPTCHA. Luego llama a /scraper/continue con el sessionId.'
    });

    // NOTA: En producción, aquí guardarías el browser/page en memoria
    // para que otro endpoint (/scraper/continue) pueda continuar.
    // Por simplicidad, este ejemplo cierra la conexión.

  } catch (error) {
    console.error(`[LEXA] Error en sesión ${sessionId}: ${error.message}`);
    
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }

    // Si ya se envió respuesta, no podemos enviar otra
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: error.message,
        sessionId: sessionId
      });
    }
  }
});

// ============================================================
// ENDPOINT: Test de conexión a Browserless
// ============================================================
app.get('/test-browserless', async (req, res) => {
  let browser = null;
  
  try {
    const wsEndpoint = BROWSERLESS_TOKEN 
      ? `${BROWSERLESS_URL}?token=${BROWSERLESS_TOKEN}`
      : BROWSERLESS_URL;

    console.log(`[LEXA] Probando conexión a: ${wsEndpoint.replace(BROWSERLESS_TOKEN, '***')}`);
    
    browser = await puppeteer.connect({
      browserWSEndpoint: wsEndpoint
    });

    const version = await browser.version();
    await browser.close();

    res.json({
      success: true,
      message: 'Conexión a Browserless exitosa',
      browserVersion: version
    });

  } catch (error) {
    console.error(`[LEXA] Error conectando a Browserless: ${error.message}`);
    
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }

    res.status(500).json({
      success: false,
      error: error.message,
      hint: 'Verifica BROWSERLESS_URL y BROWSERLESS_TOKEN en las variables de entorno'
    });
  }
});

// ============================================================
// ENDPOINT: Test de conexión a Evolution API
// ============================================================
app.get('/test-evolution', async (req, res) => {
  try {
    const response = await fetch(`${EVOLUTION_URL}/instance/fetchInstances`, {
      method: 'GET',
      headers: {
        'apikey': EVOLUTION_API_KEY
      }
    });

    if (!response.ok) {
      throw new Error(`Evolution API respondió con status ${response.status}`);
    }

    const data = await response.json();

    res.json({
      success: true,
      message: 'Conexión a Evolution API exitosa',
      instances: data
    });

  } catch (error) {
    console.error(`[LEXA] Error conectando a Evolution API: ${error.message}`);
    
    res.status(500).json({
      success: false,
      error: error.message,
      hint: 'Verifica EVOLUTION_URL y EVOLUTION_API_KEY en las variables de entorno'
    });
  }
});

// ============================================================
// MANEJO DE ERRORES GLOBAL
// ============================================================
app.use((err, req, res, next) => {
  console.error(`[LEXA] Error no manejado: ${err.message}`);
  res.status(500).json({
    success: false,
    error: 'Error interno del servidor',
    details: err.message
  });
});

// ============================================================
// INICIAR SERVIDOR
// ============================================================
// ⚠️ CRÍTICO: Escuchar en 0.0.0.0 para que EasyPanel pueda hacer proxy
app.listen(PORT, '0.0.0.0', () => {
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  LEXA SCRAPER SERVICE`);
  console.log(`  Escuchando en: http://0.0.0.0:${PORT}`);
  console.log(`  Health check:  http://0.0.0.0:${PORT}/health`);
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Browserless:   ${BROWSERLESS_URL || 'NO CONFIGURADO'}`);
  console.log(`  Evolution:     ${EVOLUTION_URL || 'NO CONFIGURADO'}`);
  console.log('═══════════════════════════════════════════════════════');
});

// Manejo de señales para cierre limpio
process.on('SIGTERM', () => {
  console.log('[LEXA] Recibido SIGTERM, cerrando servidor...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[LEXA] Recibido SIGINT, cerrando servidor...');
  process.exit(0);
});
