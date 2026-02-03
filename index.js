/**
 * ============================================================
 * LEXA SCRAPER SERVICE v4.1.1 - Sistema Screenshot CAPTCHA
 * ============================================================
 * Versión: AAA (Producción)
 * Fecha: Febrero 2026
 * 
 * CORRECCIÓN v4.1.1:
 * - Formato de imagen corregido para Evolution API
 * - API Key actualizada
 * ============================================================
 */

const express = require('express');
const puppeteer = require('puppeteer-core');
const crypto = require('crypto');

const app = express();

// ============================================================
// CONFIGURACIÓN Y CONSTANTES
// ============================================================

const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY || crypto.randomUUID();

// URLs de SINOE
const SINOE_URLS = {
  login: 'https://casillas.pj.gob.pe/sinoe/sso-validar.xhtml',
  sessionActiva: 'sso-session-activa',
  dashboard: 'login.xhtml',
  bandeja: 'sso-menu-app.xhtml'
};

// Selectores CSS
const SELECTORES = {
  usuario: 'input[placeholder="Usuario"]',
  password: 'input[placeholder="Contraseña"]',
  captcha: 'input[placeholder="Ingrese Captcha"], #frmLogin\\:captcha',
  captchaImg: 'img[id*="captcha"], img[src*="captcha"]',
  btnIngresar: '#frmLogin\\:btnIngresar, button[type="submit"]',
  tablaNotificaciones: 'table tbody tr, .ui-datatable-data tr'
};

// Timeouts
const TIMEOUT = {
  navegacion: 60000,
  captcha: 300000,
  api: 30000,
  modal: 15000,
  descarga: 120000
};

// Configuración externa
const CONFIG = {
  browserless: {
    url: process.env.BROWSERLESS_URL || 'wss://browser.lexaasistentelegal.com',
    token: process.env.BROWSERLESS_TOKEN
  },
  evolution: {
    url: process.env.EVOLUTION_URL || 'https://evo.lexaasistentelegal.com',
    apiKey: process.env.EVOLUTION_API_KEY,
    instance: process.env.EVOLUTION_INSTANCE || 'lexa-bot'
  }
};

// Rate limiting
const RATE_LIMIT = {
  windowMs: 60000,
  maxRequestsPerIp: 30
};

// ============================================================
// MÉTRICAS
// ============================================================

const metricas = {
  requestsTotal: 0,
  scrapersIniciados: 0,
  scrapersExitosos: 0,
  scrapersFallidos: 0,
  captchasRecibidos: 0,
  tiempoPromedioMs: 0,
  ultimoReinicio: new Date().toISOString()
};

// ============================================================
// ALMACENAMIENTO EN MEMORIA
// ============================================================

const sesionesActivas = new Map();
const rateLimitCache = new Map();

// Limpieza automática cada minuto
setInterval(() => {
  const ahora = Date.now();
  
  for (const [numero, sesion] of sesionesActivas.entries()) {
    if (ahora - sesion.timestamp > 360000) {
      log('warn', 'LIMPIEZA', `Sesión expirada: ${enmascarar(numero)}`);
      if (sesion.reject) sesion.reject(new Error('Timeout: CAPTCHA no resuelto'));
      if (sesion.browser) sesion.browser.close().catch(() => {});
      sesionesActivas.delete(numero);
    }
  }
  
  for (const [ip, data] of rateLimitCache.entries()) {
    if (ahora - data.timestamp > RATE_LIMIT.windowMs) {
      rateLimitCache.delete(ip);
    }
  }
}, 60000);

// ============================================================
// UTILIDADES
// ============================================================

function enmascarar(texto) {
  if (!texto || texto.length < 6) return '***';
  return texto.substring(0, 3) + '***' + texto.substring(texto.length - 2);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(nivel, contexto, mensaje, datos = {}) {
  const timestamp = new Date().toISOString();
  const iconos = { debug: '🔍', info: 'ℹ️', warn: '⚠️', error: '❌', success: '✅' };
  
  if (process.env.NODE_ENV === 'production') {
    console.log(JSON.stringify({ timestamp, nivel, contexto, mensaje, ...datos }));
  } else {
    console.log(`[${timestamp}] ${iconos[nivel] || '•'} [${contexto}] ${mensaje}`, 
      Object.keys(datos).length > 0 ? datos : '');
  }
}

function validarNumeroWhatsApp(numero) {
  if (!numero || typeof numero !== 'string') {
    return { valido: false, error: 'Número no proporcionado' };
  }
  
  const limpio = numero.replace(/[\s\-\+\(\)]/g, '');
  
  if (!/^51\d{9}$/.test(limpio)) {
    return { valido: false, error: 'Formato inválido. Use: 51XXXXXXXXX (11 dígitos)' };
  }
  
  return { valido: true, numero: limpio };
}

function validarCaptcha(texto) {
  if (!texto || typeof texto !== 'string') {
    return { valido: false, error: 'Texto vacío' };
  }
  
  const limpio = texto.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  
  if (limpio.length < 4 || limpio.length > 6) {
    return { 
      valido: false, 
      error: `El CAPTCHA debe tener 5 caracteres (recibido: ${limpio.length})`,
      sugerencia: 'Escriba solo las letras/números que ve en la imagen.'
    };
  }
  
  return { valido: true, captcha: limpio };
}

// ============================================================
// MIDDLEWARES
// ============================================================

app.use(express.json({ limit: '1mb' }));

// Rate limiting
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const ahora = Date.now();
  
  if (!rateLimitCache.has(ip)) {
    rateLimitCache.set(ip, { count: 1, timestamp: ahora });
    return next();
  }
  
  const data = rateLimitCache.get(ip);
  
  if (ahora - data.timestamp > RATE_LIMIT.windowMs) {
    rateLimitCache.set(ip, { count: 1, timestamp: ahora });
    return next();
  }
  
  data.count++;
  
  if (data.count > RATE_LIMIT.maxRequestsPerIp) {
    return res.status(429).json({
      success: false,
      error: 'Demasiadas solicitudes. Intente en 1 minuto.'
    });
  }
  
  next();
});

// Autenticación (excepto /health y /webhook/whatsapp)
app.use((req, res, next) => {
  const publicPaths = ['/health', '/webhook/whatsapp'];
  if (publicPaths.includes(req.path)) return next();
  
  const apiKey = req.headers['x-api-key'] || req.headers['apikey'];
  
  if (!apiKey || apiKey !== API_KEY) {
    return res.status(401).json({
      success: false,
      error: 'API Key inválida',
      hint: 'Incluya header X-API-KEY'
    });
  }
  
  next();
});

// Logging
app.use((req, res, next) => {
  metricas.requestsTotal++;
  next();
});

// ============================================================
// FUNCIONES WHATSAPP CON REINTENTOS
// ============================================================

async function enviarWhatsAppTexto(numero, mensaje, intentos = 3) {
  for (let i = 1; i <= intentos; i++) {
    try {
      const url = `${CONFIG.evolution.url}/message/sendText/${CONFIG.evolution.instance}`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': CONFIG.evolution.apiKey
        },
        body: JSON.stringify({ number: numero, text: mensaje }),
        signal: AbortSignal.timeout(TIMEOUT.api)
      });

      if (response.ok) {
        log('success', 'WHATSAPP', 'Texto enviado', { numero: enmascarar(numero) });
        return true;
      }
      
      const errorBody = await response.text();
      log('warn', 'WHATSAPP', `Intento ${i}/${intentos} fallido`, { status: response.status, error: errorBody });
      
    } catch (error) {
      log('warn', 'WHATSAPP', `Intento ${i}/${intentos} error: ${error.message}`);
    }
    
    if (i < intentos) await delay(1000 * i);
  }
  
  return false;
}

async function enviarWhatsAppImagen(numero, base64Image, caption, intentos = 3) {
  if (!base64Image || base64Image.length < 100) {
    log('error', 'WHATSAPP', 'Imagen inválida o muy pequeña');
    return false;
  }
  
  for (let i = 1; i <= intentos; i++) {
    try {
      const url = `${CONFIG.evolution.url}/message/sendMedia/${CONFIG.evolution.instance}`;
      
      // Evolution API v2.x requiere el base64 SIN el prefijo data:image
      // y necesita el campo fileName
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': CONFIG.evolution.apiKey
        },
        body: JSON.stringify({
          number: numero,
          mediatype: 'image',
          media: base64Image,
          caption: caption,
          fileName: 'captcha.png'
        }),
        signal: AbortSignal.timeout(TIMEOUT.api)
      });

      if (response.ok) {
        log('success', 'WHATSAPP', 'Imagen enviada', { numero: enmascarar(numero) });
        return true;
      }
      
      const errorBody = await response.text();
      log('warn', 'WHATSAPP', `Imagen intento ${i}/${intentos} fallido`, { status: response.status, error: errorBody });
      
    } catch (error) {
      log('warn', 'WHATSAPP', `Imagen intento ${i}/${intentos} error: ${error.message}`);
    }
    
    if (i < intentos) await delay(1000 * i);
  }
  
  return false;
}

// ============================================================
// FUNCIONES DE SCRAPING
// ============================================================

async function llenarCampo(page, selector, valor) {
  const campo = await page.$(selector);
  if (!campo) throw new Error(`Campo no encontrado: ${selector}`);
  
  await campo.click({ clickCount: 3 });
  await delay(100);
  await page.keyboard.press('Backspace');
  await delay(100);
  await campo.type(valor, { delay: 50 });
}

async function capturarCaptcha(page) {
  await page.waitForSelector(SELECTORES.captchaImg, { timeout: 10000 })
    .catch(() => {});
  
  await delay(1000);
  
  const captchaImg = await page.$(SELECTORES.captchaImg);
  
  if (captchaImg) {
    const box = await captchaImg.boundingBox();
    
    if (box && box.width > 50 && box.height > 20) {
      const screenshot = await captchaImg.screenshot({ encoding: 'base64' });
      
      if (screenshot && screenshot.length > 500) {
        log('success', 'CAPTCHA', 'Screenshot capturado', { size: screenshot.length });
        return screenshot;
      }
    }
  }
  
  // Fallback: screenshot del área del formulario
  log('warn', 'CAPTCHA', 'Usando fallback - captura de área');
  
  const form = await page.$('form, .login-form, .ui-panel');
  if (form) {
    const formBox = await form.boundingBox();
    if (formBox) {
      return await page.screenshot({ 
        encoding: 'base64',
        clip: {
          x: formBox.x,
          y: formBox.y + formBox.height * 0.4,
          width: formBox.width,
          height: formBox.height * 0.4
        }
      });
    }
  }
  
  return await page.screenshot({ encoding: 'base64' });
}

async function buscarLinkCasillas(page) {
  const links = await page.$$('a');
  
  for (const link of links) {
    const texto = await link.evaluate(el => el.textContent?.toLowerCase() || '');
    const href = await link.evaluate(el => el.href?.toLowerCase() || '');
    
    if (texto.includes('olvidó') || texto.includes('recuperar')) continue;
    
    if (texto.includes('sinoe') || texto.includes('casilla') || 
        href.includes('sinoe') || href.includes('casilla')) {
      return link;
    }
  }
  
  return null;
}

async function extraerNotificaciones(page) {
  await page.waitForSelector('table, .ui-datatable', { timeout: TIMEOUT.navegacion })
    .catch(() => {});
  
  await delay(2000);
  
  return await page.evaluate(() => {
    const filas = document.querySelectorAll('table tbody tr, .ui-datatable-data tr');
    const datos = [];
    
    filas.forEach((fila, index) => {
      if (fila.cells?.length < 2) return;
      const celdas = fila.querySelectorAll('td');
      if (celdas.length === 0) return;
      
      const textos = Array.from(celdas).map(c => c.textContent?.trim() || '');
      
      datos.push({
        indice: index + 1,
        expediente: textos[0] || '',
        juzgado: textos[1] || '',
        fecha: textos[2] || '',
        sumilla: textos[3] || '',
        estado: textos[4] || '',
        raw: textos
      });
    });
    
    return datos;
  });
}

// ============================================================
// FUNCIÓN PRINCIPAL DEL SCRAPER
// ============================================================

async function ejecutarScraper({ sinoeUsuario, sinoePassword, whatsappNumero, nombreAbogado }) {
  let browser = null;
  let page = null;
  const inicioMs = Date.now();
  const requestId = crypto.randomUUID().substring(0, 8);
  
  try {
    metricas.scrapersIniciados++;
    
    // PASO 1: Conectar a Browserless
    log('info', `SCRAPER:${requestId}`, 'Conectando a Browserless...');
    
    const wsEndpoint = CONFIG.browserless.token 
      ? `${CONFIG.browserless.url}?token=${CONFIG.browserless.token}`
      : CONFIG.browserless.url;
    
    browser = await puppeteer.connect({
      browserWSEndpoint: wsEndpoint,
      defaultViewport: { width: 1280, height: 800 }
    });
    
    page = await browser.newPage();
    page.setDefaultNavigationTimeout(TIMEOUT.navegacion);
    
    // PASO 2: Navegar a SINOE
    log('info', `SCRAPER:${requestId}`, 'Navegando a SINOE...');
    
    await page.goto(SINOE_URLS.login, { waitUntil: 'networkidle2' });
    
    // Manejar página de parámetros no válidos
    const contenido = await page.content();
    if (contenido.includes('PARAMETROS DE SEGURIDAD NO VALIDOS')) {
      const buttons = await page.$$('button, a');
      for (const btn of buttons) {
        const texto = await btn.evaluate(el => el.textContent?.toUpperCase() || '');
        if (texto.includes('INICIO')) {
          await btn.click();
          await page.waitForNavigation({ waitUntil: 'networkidle2' });
          break;
        }
      }
    }
    
    // PASO 3: Esperar campos
    await page.waitForSelector(SELECTORES.usuario, { timeout: TIMEOUT.navegacion });
    
    // PASO 4: Llenar credenciales
    log('info', `SCRAPER:${requestId}`, 'Llenando credenciales...');
    await llenarCampo(page, SELECTORES.usuario, sinoeUsuario);
    await delay(300);
    await llenarCampo(page, SELECTORES.password, sinoePassword);
    
    // PASO 5: Capturar CAPTCHA
    log('info', `SCRAPER:${requestId}`, 'Capturando CAPTCHA...');
    await delay(1000);
    const captchaBase64 = await capturarCaptcha(page);
    
    if (!captchaBase64 || captchaBase64.length < 500) {
      throw new Error('No se pudo capturar el CAPTCHA');
    }
    
    // PASO 6: Enviar imagen
    log('info', `SCRAPER:${requestId}`, 'Enviando imagen por WhatsApp...');
    
    const caption = `📩 ${nombreAbogado}, escriba el código que ve en la imagen y envíelo como respuesta.\n\n⏱️ Tiene 5 minutos.\n🔒 Credenciales ya llenadas.`;
    
    if (!await enviarWhatsAppImagen(whatsappNumero, captchaBase64, caption)) {
      throw new Error('No se pudo enviar la imagen por WhatsApp');
    }
    
    // PASO 7: Esperar respuesta
    log('info', `SCRAPER:${requestId}`, 'Esperando respuesta del abogado...');
    
    const captchaTexto = await new Promise((resolve, reject) => {
      sesionesActivas.set(whatsappNumero, {
        page, browser, resolve, reject,
        timestamp: Date.now(),
        nombreAbogado, requestId
      });
      
      setTimeout(() => {
        if (sesionesActivas.has(whatsappNumero)) {
          const s = sesionesActivas.get(whatsappNumero);
          if (s.requestId === requestId) {
            sesionesActivas.delete(whatsappNumero);
            reject(new Error('Timeout: CAPTCHA no resuelto en 5 minutos'));
          }
        }
      }, TIMEOUT.captcha);
    });
    
    metricas.captchasRecibidos++;
    log('success', `SCRAPER:${requestId}`, `CAPTCHA recibido: ${captchaTexto}`);
    
    // PASO 8: Escribir CAPTCHA y login
    const campoCaptcha = await page.$(SELECTORES.captcha);
    if (!campoCaptcha) throw new Error('Campo CAPTCHA no encontrado');
    
    await campoCaptcha.click({ clickCount: 3 });
    await delay(100);
    await page.keyboard.press('Backspace');
    await delay(100);
    await campoCaptcha.type(captchaTexto.toUpperCase(), { delay: 30 });
    
    const urlAntes = page.url();
    
    const btn = await page.$(SELECTORES.btnIngresar);
    if (btn) await btn.click();
    else await page.keyboard.press('Enter');
    
    await page.waitForFunction(
      url => window.location.href !== url,
      { timeout: TIMEOUT.navegacion },
      urlAntes
    );
    
    await page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {});
    
    // PASO 9: Verificar login
    const urlActual = page.url();
    const contenidoActual = await page.content();
    
    if (contenidoActual.toLowerCase().includes('captcha') && 
        contenidoActual.toLowerCase().includes('incorrecto')) {
      await enviarWhatsAppTexto(whatsappNumero, `❌ CAPTCHA incorrecto. Intente de nuevo.`);
      throw new Error('CAPTCHA incorrecto');
    }
    
    if (urlActual.includes(SINOE_URLS.sessionActiva)) {
      await enviarWhatsAppTexto(whatsappNumero, `⚠️ Hay sesión activa. Ciérrela e intente de nuevo.`);
      throw new Error('Sesión activa');
    }
    
    // PASO 10: Navegar a Casillas
    const linkCasillas = await buscarLinkCasillas(page);
    if (linkCasillas) {
      await linkCasillas.click();
      await page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {});
    }
    
    // PASO 11: Extraer notificaciones
    log('info', `SCRAPER:${requestId}`, 'Extrayendo notificaciones...');
    const notificaciones = await extraerNotificaciones(page);
    
    // ÉXITO
    const duracionMs = Date.now() - inicioMs;
    metricas.scrapersExitosos++;
    
    const totalExitosos = metricas.scrapersExitosos;
    metricas.tiempoPromedioMs = Math.round(
      ((metricas.tiempoPromedioMs * (totalExitosos - 1)) + duracionMs) / totalExitosos
    );
    
    await enviarWhatsAppTexto(whatsappNumero,
      `✅ ${nombreAbogado}, acceso exitoso.\n\n📋 ${notificaciones.length} notificación(es) encontrada(s).\n\nProcesando...`
    );
    
    log('success', `SCRAPER:${requestId}`, 'Completado', { duracionMs, notificaciones: notificaciones.length });
    
    return {
      success: true,
      notificaciones,
      total: notificaciones.length,
      urlFinal: page.url(),
      duracionMs,
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    metricas.scrapersFallidos++;
    log('error', `SCRAPER:${requestId}`, error.message);
    
    if (!error.message.includes('CAPTCHA incorrecto') && !error.message.includes('Sesión activa')) {
      await enviarWhatsAppTexto(whatsappNumero, `❌ Error: ${error.message}`);
    }
    
    return {
      success: false,
      error: error.message,
      timeout: error.message.includes('Timeout'),
      duracionMs: Date.now() - inicioMs,
      timestamp: new Date().toISOString()
    };

  } finally {
    sesionesActivas.delete(whatsappNumero);
    if (browser) await browser.close().catch(() => {});
  }
}

// ============================================================
// ENDPOINTS
// ============================================================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'lexa-scraper-service',
    version: '4.1.1',
    uptime: process.uptime(),
    sesionesActivas: sesionesActivas.size,
    metricas: {
      exitosos: metricas.scrapersExitosos,
      fallidos: metricas.scrapersFallidos,
      tasaExito: metricas.scrapersIniciados > 0 
        ? Math.round((metricas.scrapersExitosos / metricas.scrapersIniciados) * 100) + '%' : 'N/A'
    }
  });
});

app.post('/scraper', async (req, res) => {
  const { sinoeUsuario, sinoePassword, whatsappNumero, nombreAbogado } = req.body;
  
  if (!sinoeUsuario || !sinoePassword) {
    return res.status(400).json({ success: false, error: 'Faltan credenciales SINOE' });
  }
  
  const validacion = validarNumeroWhatsApp(whatsappNumero);
  if (!validacion.valido) {
    return res.status(400).json({ success: false, error: validacion.error });
  }
  
  if (sesionesActivas.has(validacion.numero)) {
    return res.status(409).json({ success: false, error: 'Sesión activa para este número' });
  }
  
  const resultado = await ejecutarScraper({
    sinoeUsuario,
    sinoePassword,
    whatsappNumero: validacion.numero,
    nombreAbogado: nombreAbogado || 'Estimado usuario'
  });
  
  res.status(resultado.success ? 200 : (resultado.timeout ? 408 : 500)).json(resultado);
});

app.post('/webhook/whatsapp', async (req, res) => {
  try {
    const data = req.body;
    
    if (data.event !== 'messages.upsert') {
      return res.status(200).json({ ignored: true });
    }
    
    const message = data.data;
    if (!message?.key?.remoteJid || !message?.message || message.key.fromMe) {
      return res.status(200).json({ ignored: true });
    }
    
    const numero = message.key.remoteJid.replace('@s.whatsapp.net', '').replace('@c.us', '');
    
    let texto = message.message.conversation || 
                message.message.extendedTextMessage?.text || 
                message.message.imageMessage?.caption || '';
    
    if (!texto) {
      return res.status(200).json({ ignored: true, reason: 'no text' });
    }
    
    if (!sesionesActivas.has(numero)) {
      return res.status(200).json({ ignored: true, reason: 'no session' });
    }
    
    const validacion = validarCaptcha(texto);
    
    if (!validacion.valido) {
      await enviarWhatsAppTexto(numero, `⚠️ ${validacion.error}\n\n${validacion.sugerencia || ''}`);
      return res.status(200).json({ ignored: true, reason: 'invalid captcha' });
    }
    
    const sesion = sesionesActivas.get(numero);
    sesion.resolve(validacion.captcha);
    
    log('success', 'WEBHOOK', 'CAPTCHA recibido', { numero: enmascarar(numero) });
    
    return res.status(200).json({ success: true });
    
  } catch (error) {
    log('error', 'WEBHOOK', error.message);
    return res.status(200).json({ error: error.message });
  }
});

app.get('/sesiones', (req, res) => {
  const sesiones = [];
  for (const [numero, sesion] of sesionesActivas.entries()) {
    sesiones.push({
      numero: enmascarar(numero),
      nombreAbogado: sesion.nombreAbogado,
      esperandoDesde: Math.round((Date.now() - sesion.timestamp) / 1000) + 's'
    });
  }
  res.json({ total: sesionesActivas.size, sesiones });
});

app.get('/metricas', (req, res) => {
  res.json({
    ...metricas,
    sesionesActivas: sesionesActivas.size,
    memoriaUsada: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB',
    uptime: Math.round(process.uptime()) + 's'
  });
});

app.post('/test-whatsapp', async (req, res) => {
  const validacion = validarNumeroWhatsApp(req.body.numero);
  if (!validacion.valido) return res.status(400).json({ success: false, error: validacion.error });
  
  const resultado = await enviarWhatsAppTexto(validacion.numero, req.body.mensaje || '🧪 Test LEXA v4.1.1');
  res.json({ success: resultado });
});

app.post('/test-conexion', async (req, res) => {
  let browser = null;
  try {
    const ws = CONFIG.browserless.token 
      ? `${CONFIG.browserless.url}?token=${CONFIG.browserless.token}`
      : CONFIG.browserless.url;
    
    browser = await puppeteer.connect({ browserWSEndpoint: ws });
    const page = await browser.newPage();
    await page.goto('https://www.google.com', { timeout: 30000 });
    
    res.json({ success: true, message: 'Conexión OK' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

async function shutdown(signal) {
  log('warn', 'SHUTDOWN', `Señal ${signal} recibida`);
  
  for (const [, sesion] of sesionesActivas.entries()) {
    if (sesion.reject) sesion.reject(new Error('Servidor reiniciándose'));
    if (sesion.browser) await sesion.browser.close().catch(() => {});
  }
  
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ============================================================
// INICIAR SERVIDOR
// ============================================================

app.listen(PORT, () => {
  if (!process.env.API_KEY) {
    log('warn', 'CONFIG', `API Key generada: ${API_KEY}`);
  }
  
  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║           LEXA SCRAPER SERVICE v4.1.1 (AAA)                      ║
╠══════════════════════════════════════════════════════════════════╣
║  Puerto: ${PORT}                                                     ║
║  Auth: ${process.env.API_KEY ? 'Configurada ✓' : 'Auto-generada ⚠️'}                                      ║
║  Evolution: ${CONFIG.evolution.url}                ║
╠══════════════════════════════════════════════════════════════════╣
║  ENDPOINTS:                                                      ║
║    GET  /health           POST /webhook/whatsapp                 ║
║    POST /scraper          GET  /sesiones                         ║
║    GET  /metricas         POST /test-whatsapp                    ║
║    POST /test-conexion                                           ║
╚══════════════════════════════════════════════════════════════════╝
  `);
});
