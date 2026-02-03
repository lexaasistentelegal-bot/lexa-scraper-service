/**
 * ============================================================
 * LEXA SCRAPER SERVICE v4.3.0 - Sistema Screenshot CAPTCHA
 * ============================================================
 * Versión: AAA (Producción)
 * Fecha: Febrero 2026
 * 
 * CORRECCIONES v4.3.0:
 * - FIX CRÍTICO: cerrarPopups() ahora usa page.evaluate() en vez de selectores inválidos
 * - FIX CRÍTICO: Espera a que el popup DESAPAREZCA del DOM antes de continuar
 * - FIX: capturarCaptcha() verifica que no hay overlays antes de capturar
 * - FIX: Múltiples intentos de cierre de popup con verificación
 * - NUEVO: Función verificarPopupCerrado() para confirmar cierre
 * - NUEVO: Captura de debug screenshot si el CAPTCHA falla
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

// Selectores CSS actualizados para SINOE V.2.2.2
const SELECTORES = {
  // Campos de login
  usuario: 'input[placeholder="Usuario"]',
  password: 'input[placeholder="Contraseña"]',
  
  // CAPTCHA - múltiples selectores para mayor robustez
  captchaInput: 'input[placeholder*="CAPTCHA"], input[placeholder*="Captcha"], input[placeholder*="captcha"], input[id*="captcha"]',
  captchaImg: 'img[id*="captcha"], img[src*="captcha"], img[src*="Captcha"]',
  
  // Botones
  btnIngresar: 'button[type="submit"], input[type="submit"], .ui-button',
  
  // Tabla de notificaciones
  tablaNotificaciones: 'table tbody tr, .ui-datatable-data tr'
};

// Timeouts
const TIMEOUT = {
  navegacion: 60000,
  captcha: 300000,
  api: 30000,
  popup: 10000,
  elemento: 15000
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
        log('success', 'WHATSAPP', 'Imagen enviada', { numero: enmascarar(numero), size: base64Image.length });
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
// FUNCIONES DE SCRAPING - CORREGIDAS v4.3.0
// ============================================================

/**
 * Verifica si hay un popup/modal visible en la página
 * Retorna true si hay popup visible, false si no hay
 */
async function hayPopupVisible(page) {
  return await page.evaluate(() => {
    // Buscar overlays/backdrops de PrimeFaces
    const overlays = document.querySelectorAll('.ui-widget-overlay, .ui-dialog-mask, .modal-backdrop');
    for (const overlay of overlays) {
      const style = window.getComputedStyle(overlay);
      if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
        return true;
      }
    }
    
    // Buscar diálogos visibles
    const dialogs = document.querySelectorAll('.ui-dialog, .modal, [role="dialog"]');
    for (const dialog of dialogs) {
      const style = window.getComputedStyle(dialog);
      if (style.display !== 'none' && style.visibility !== 'hidden') {
        return true;
      }
    }
    
    // Buscar por texto específico del popup de SINOE
    const bodyText = document.body.innerText || '';
    if (bodyText.includes('clic aqui') || bodyText.includes('clic aquí')) {
      // Verificar si hay un botón "Aceptar" visible
      const botones = document.querySelectorAll('button, .ui-button');
      for (const btn of botones) {
        const texto = (btn.textContent || '').toLowerCase().trim();
        if (texto === 'aceptar' || texto === 'acepto') {
          const rect = btn.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            return true;
          }
        }
      }
    }
    
    return false;
  });
}

/**
 * Cierra popups de SINOE (términos, avisos, etc.)
 * CORREGIDO v4.3.0: Usa page.evaluate() y espera confirmación de cierre
 */
async function cerrarPopups(page) {
  log('info', 'POPUP', 'Verificando si hay popups para cerrar...');
  
  const MAX_INTENTOS = 5;
  
  for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
    try {
      // Verificar si hay popup visible
      const tienePopup = await hayPopupVisible(page);
      
      if (!tienePopup) {
        log('success', 'POPUP', 'No hay popups visibles (o ya se cerraron)');
        return true;
      }
      
      log('info', 'POPUP', `Intento ${intento}/${MAX_INTENTOS} de cerrar popup...`);
      
      // Usar page.evaluate() para buscar y hacer clic en el botón "Aceptar"
      // ESTO ES LO QUE FALTABA - Puppeteer no soporta :has-text()
      const clicExitoso = await page.evaluate(() => {
        // Buscar todos los botones
        const botones = document.querySelectorAll('button, .ui-button, input[type="button"], a.ui-button');
        
        for (const boton of botones) {
          const texto = (boton.textContent || boton.value || '').toLowerCase().trim();
          const rect = boton.getBoundingClientRect();
          
          // Verificar que el botón es visible y tiene texto relevante
          if (rect.width > 0 && rect.height > 0 && rect.top >= 0) {
            if (texto === 'aceptar' || texto === 'acepto' || texto === 'ok' || texto === 'cerrar') {
              console.log(`[POPUP] Encontrado botón: "${texto}"`);
              boton.click();
              return { clicked: true, texto: texto };
            }
          }
        }
        
        // Si no encontramos botón específico, buscar en ui-dialog-buttonset (PrimeFaces)
        const dialogButtons = document.querySelectorAll('.ui-dialog-buttonset button, .ui-dialog-buttonpane button');
        if (dialogButtons.length > 0) {
          dialogButtons[0].click();
          return { clicked: true, texto: 'primer botón de diálogo' };
        }
        
        return { clicked: false };
      });
      
      if (clicExitoso.clicked) {
        log('info', 'POPUP', `Clic en botón: "${clicExitoso.texto}"`);
        
        // CRÍTICO: Esperar a que el popup desaparezca del DOM
        await delay(500); // Pequeña espera para que inicie la animación
        
        // Esperar hasta que el popup desaparezca (máximo 3 segundos)
        let esperaMs = 0;
        const maxEsperaMs = 3000;
        
        while (esperaMs < maxEsperaMs) {
          const sigueTeniendoPopup = await hayPopupVisible(page);
          if (!sigueTeniendoPopup) {
            log('success', 'POPUP', `Popup cerrado después de ${esperaMs}ms`);
            // Esperar un poco más para que la página se estabilice
            await delay(500);
            return true;
          }
          await delay(200);
          esperaMs += 200;
        }
        
        log('warn', 'POPUP', 'El popup no se cerró después del clic, reintentando...');
      } else {
        // Intentar con tecla Escape
        log('info', 'POPUP', 'No se encontró botón, intentando con Escape...');
        await page.keyboard.press('Escape');
        await delay(500);
        
        // Verificar si funcionó
        const cerrado = !(await hayPopupVisible(page));
        if (cerrado) {
          log('success', 'POPUP', 'Popup cerrado con Escape');
          return true;
        }
      }
      
      // Esperar antes del siguiente intento
      await delay(1000);
      
    } catch (error) {
      log('warn', 'POPUP', `Error en intento ${intento}: ${error.message}`);
    }
  }
  
  log('error', 'POPUP', 'No se pudo cerrar el popup después de todos los intentos');
  return false;
}

/**
 * Limpia y llena un campo de texto
 */
async function llenarCampo(page, selector, valor) {
  // Intentar múltiples selectores
  const selectores = selector.split(', ');
  let campo = null;
  
  for (const sel of selectores) {
    try {
      campo = await page.$(sel.trim());
      if (campo) break;
    } catch (e) {
      // Continuar con el siguiente selector
    }
  }
  
  if (!campo) {
    throw new Error(`Campo no encontrado con selectores: ${selector}`);
  }
  
  // Hacer scroll al elemento para asegurar que está visible
  await campo.evaluate(el => el.scrollIntoView({ block: 'center' }));
  await delay(200);
  
  // Limpiar y escribir
  await campo.click({ clickCount: 3 });
  await delay(100);
  await page.keyboard.press('Backspace');
  await delay(100);
  await campo.type(valor, { delay: 50 });
  
  return campo;
}

/**
 * Captura screenshot SOLO de la imagen del CAPTCHA
 * CORREGIDO v4.3.0: Verifica que no hay overlays antes de capturar
 */
async function capturarCaptcha(page) {
  log('info', 'CAPTCHA', 'Iniciando captura del CAPTCHA...');
  
  // PASO 1: Verificar que no hay popups bloqueando
  const tienePopup = await hayPopupVisible(page);
  if (tienePopup) {
    log('warn', 'CAPTCHA', 'Hay un popup visible, intentando cerrarlo primero...');
    await cerrarPopups(page);
    await delay(1000);
  }
  
  // PASO 2: Esperar a que la imagen del CAPTCHA esté cargada
  await delay(1500);
  
  // PASO 3: Buscar la imagen del CAPTCHA usando page.evaluate() para mayor precisión
  const captchaInfo = await page.evaluate(() => {
    // Buscar todas las imágenes
    const imagenes = document.querySelectorAll('img');
    
    for (const img of imagenes) {
      const src = (img.src || '').toLowerCase();
      const id = (img.id || '').toLowerCase();
      const alt = (img.alt || '').toLowerCase();
      const className = (img.className || '').toLowerCase();
      
      // Verificar si es la imagen del CAPTCHA
      const esCaptcha = src.includes('captcha') || 
                        id.includes('captcha') || 
                        alt.includes('captcha') ||
                        className.includes('captcha');
      
      if (esCaptcha) {
        const rect = img.getBoundingClientRect();
        
        // El CAPTCHA de SINOE tiene dimensiones aproximadas de 100-150px x 30-50px
        if (rect.width >= 50 && rect.height >= 20 && rect.width < 300 && rect.height < 100) {
          return {
            found: true,
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            src: img.src,
            id: img.id,
            isLoaded: img.complete && img.naturalHeight > 0
          };
        }
      }
    }
    
    return { found: false };
  });
  
  log('info', 'CAPTCHA', 'Resultado búsqueda:', captchaInfo);
  
  if (captchaInfo.found) {
    // Verificar que la imagen está cargada
    if (!captchaInfo.isLoaded) {
      log('info', 'CAPTCHA', 'Imagen encontrada pero no cargada, esperando...');
      await delay(2000);
    }
    
    // Obtener el elemento y tomar screenshot directo del elemento
    const captchaElement = await page.$(`img[src="${captchaInfo.src}"]`) || 
                           await page.$(`img[id="${captchaInfo.id}"]`) ||
                           await page.$('img[src*="captcha"]');
    
    if (captchaElement) {
      try {
        const screenshot = await captchaElement.screenshot({ encoding: 'base64' });
        
        if (screenshot && screenshot.length > 500) {
          log('success', 'CAPTCHA', 'Screenshot del elemento capturado', { 
            bytes: screenshot.length,
            dimensiones: `${captchaInfo.width}x${captchaInfo.height}`
          });
          return screenshot;
        }
      } catch (e) {
        log('warn', 'CAPTCHA', `Error capturando elemento: ${e.message}`);
      }
    }
    
    // Fallback: capturar por coordenadas con un pequeño margen
    log('info', 'CAPTCHA', 'Capturando por coordenadas...');
    
    const screenshot = await page.screenshot({
      encoding: 'base64',
      clip: {
        x: Math.max(0, captchaInfo.x - 2),
        y: Math.max(0, captchaInfo.y - 2),
        width: captchaInfo.width + 4,
        height: captchaInfo.height + 4
      }
    });
    
    if (screenshot && screenshot.length > 500) {
      log('success', 'CAPTCHA', 'Screenshot por coordenadas capturado', { bytes: screenshot.length });
      return screenshot;
    }
  }
  
  // PASO 4: Fallback - buscar por patrón visual (área cerca del input de captcha)
  log('warn', 'CAPTCHA', 'Buscando CAPTCHA por contexto del formulario...');
  
  const formularioInfo = await page.evaluate(() => {
    // Buscar el campo de input del CAPTCHA
    const inputCaptcha = document.querySelector('input[placeholder*="CAPTCHA"], input[placeholder*="Captcha"], input[id*="captcha"]');
    
    if (inputCaptcha) {
      const inputRect = inputCaptcha.getBoundingClientRect();
      
      // Buscar la imagen más cercana al input (generalmente está arriba o a la izquierda)
      const imagenes = document.querySelectorAll('img');
      let mejorImg = null;
      let mejorDistancia = Infinity;
      
      for (const img of imagenes) {
        const imgRect = img.getBoundingClientRect();
        
        // Debe estar cerca del input (máximo 200px de distancia)
        // y tener dimensiones razonables para un CAPTCHA
        if (imgRect.width >= 50 && imgRect.height >= 20 && imgRect.width < 300 && imgRect.height < 100) {
          const distancia = Math.abs(imgRect.y - inputRect.y) + Math.abs(imgRect.x - inputRect.x);
          
          if (distancia < mejorDistancia && distancia < 200) {
            mejorDistancia = distancia;
            mejorImg = {
              x: Math.round(imgRect.x),
              y: Math.round(imgRect.y),
              width: Math.round(imgRect.width),
              height: Math.round(imgRect.height)
            };
          }
        }
      }
      
      if (mejorImg) {
        return { found: true, ...mejorImg };
      }
    }
    
    return { found: false };
  });
  
  if (formularioInfo.found) {
    log('info', 'CAPTCHA', 'Imagen encontrada por proximidad al input', formularioInfo);
    
    const screenshot = await page.screenshot({
      encoding: 'base64',
      clip: {
        x: Math.max(0, formularioInfo.x - 2),
        y: Math.max(0, formularioInfo.y - 2),
        width: formularioInfo.width + 4,
        height: formularioInfo.height + 4
      }
    });
    
    if (screenshot && screenshot.length > 500) {
      return screenshot;
    }
  }
  
  // PASO 5: Último recurso - capturar toda el área del CAPTCHA incluyendo su contenedor
  log('warn', 'CAPTCHA', 'Usando último fallback - área amplia del formulario');
  
  const areaAmplia = await page.evaluate(() => {
    // Buscar contenedor que tenga "CAPTCHA" en su texto
    const elementos = document.querySelectorAll('div, td, span, fieldset, .ui-panel-content');
    
    for (const el of elementos) {
      const texto = (el.textContent || '').toUpperCase();
      if (texto.includes('CAPTCHA') && texto.length < 200) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 100 && rect.height > 50 && rect.width < 500 && rect.height < 200) {
          return {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          };
        }
      }
    }
    
    return null;
  });
  
  if (areaAmplia) {
    const screenshot = await page.screenshot({
      encoding: 'base64',
      clip: areaAmplia
    });
    
    if (screenshot && screenshot.length > 500) {
      log('info', 'CAPTCHA', 'Screenshot de área amplia capturado', { bytes: screenshot.length });
      return screenshot;
    }
  }
  
  // Si todo falla, capturar screenshot completo para debug
  log('error', 'CAPTCHA', 'No se encontró el CAPTCHA, capturando pantalla completa para debug');
  return await page.screenshot({ encoding: 'base64' });
}

/**
 * Busca el link correcto a Casillas/SINOE
 */
async function buscarLinkCasillas(page) {
  return await page.evaluate(() => {
    const links = document.querySelectorAll('a');
    
    for (const link of links) {
      const texto = (link.textContent || '').toLowerCase();
      const href = (link.href || '').toLowerCase();
      
      // Ignorar links de recuperación de contraseña
      if (texto.includes('olvidó') || texto.includes('recuperar')) continue;
      
      if (texto.includes('sinoe') || texto.includes('casilla') || 
          href.includes('sinoe') || href.includes('casilla')) {
        return link.href;
      }
    }
    
    return null;
  });
}

/**
 * Extrae las notificaciones de la tabla de SINOE
 */
async function extraerNotificaciones(page) {
  try {
    await page.waitForSelector('table, .ui-datatable', { timeout: TIMEOUT.navegacion });
  } catch (e) {
    log('warn', 'NOTIFICACIONES', 'No se encontró tabla de notificaciones');
  }
  
  await delay(2000);
  
  return await page.evaluate(() => {
    const filas = document.querySelectorAll('table tbody tr, .ui-datatable-data tr');
    const datos = [];
    
    filas.forEach((fila, index) => {
      const celdas = fila.querySelectorAll('td');
      if (celdas.length < 2) return;
      
      const textos = Array.from(celdas).map(c => (c.textContent || '').trim());
      
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
    
    // ========================================
    // PASO 1: Conectar a Browserless
    // ========================================
    log('info', `SCRAPER:${requestId}`, 'Conectando a Browserless...');
    
    const wsEndpoint = CONFIG.browserless.token 
      ? `${CONFIG.browserless.url}?token=${CONFIG.browserless.token}`
      : CONFIG.browserless.url;
    
    browser = await puppeteer.connect({
      browserWSEndpoint: wsEndpoint,
      defaultViewport: { width: 1366, height: 768 }
    });
    
    page = await browser.newPage();
    page.setDefaultNavigationTimeout(TIMEOUT.navegacion);
    
    // ========================================
    // PASO 2: Navegar a SINOE
    // ========================================
    log('info', `SCRAPER:${requestId}`, 'Navegando a SINOE...');
    
    await page.goto(SINOE_URLS.login, { waitUntil: 'networkidle2' });
    
    // Esperar a que la página cargue completamente
    await delay(3000);
    
    // ========================================
    // PASO 3: Manejar página de parámetros no válidos (si aparece)
    // ========================================
    const contenidoInicial = await page.content();
    if (contenidoInicial.includes('PARAMETROS DE SEGURIDAD NO VALIDOS') || 
        contenidoInicial.includes('PARAMETROS NO VALIDOS')) {
      log('info', `SCRAPER:${requestId}`, 'Página de parámetros detectada, buscando botón de inicio...');
      
      const navegoInicio = await page.evaluate(() => {
        const botones = document.querySelectorAll('button, a');
        for (const btn of botones) {
          const texto = (btn.textContent || '').toUpperCase();
          if (texto.includes('INICIO') || texto.includes('IR')) {
            btn.click();
            return true;
          }
        }
        return false;
      });
      
      if (navegoInicio) {
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: TIMEOUT.navegacion }).catch(() => {});
        await delay(2000);
      }
    }
    
    // ========================================
    // PASO 4: Cerrar popups (Aceptar términos) - CRÍTICO
    // ========================================
    log('info', `SCRAPER:${requestId}`, 'Verificando y cerrando popups...');
    
    const popupCerrado = await cerrarPopups(page);
    if (!popupCerrado) {
      // Tomar screenshot de debug si el popup no se cerró
      const debugScreenshot = await page.screenshot({ encoding: 'base64' });
      log('error', `SCRAPER:${requestId}`, 'No se pudo cerrar el popup. Debug screenshot guardado.');
      // Podrías enviar este screenshot para análisis
    }
    
    // Esperar un momento adicional para asegurar que la página está lista
    await delay(1000);
    
    // ========================================
    // PASO 5: Esperar campos de login
    // ========================================
    log('info', `SCRAPER:${requestId}`, 'Esperando campos de login...');
    
    // Esperar que aparezca el campo de usuario
    await page.waitForSelector(SELECTORES.usuario, { timeout: TIMEOUT.elemento });
    
    // Verificar una vez más que no hay popups
    if (await hayPopupVisible(page)) {
      log('warn', `SCRAPER:${requestId}`, 'Popup detectado después de esperar campos, cerrando...');
      await cerrarPopups(page);
      await delay(500);
    }
    
    // ========================================
    // PASO 6: Llenar credenciales
    // ========================================
    log('info', `SCRAPER:${requestId}`, 'Llenando credenciales...');
    
    await llenarCampo(page, SELECTORES.usuario, sinoeUsuario);
    await delay(500);
    await llenarCampo(page, SELECTORES.password, sinoePassword);
    await delay(500);
    
    // ========================================
    // PASO 7: Capturar CAPTCHA
    // ========================================
    log('info', `SCRAPER:${requestId}`, 'Capturando CAPTCHA...');
    
    // Esperar a que el CAPTCHA cargue
    await delay(1500);
    
    // Verificar OTRA VEZ que no hay popups (pueden aparecer después de llenar campos)
    if (await hayPopupVisible(page)) {
      log('warn', `SCRAPER:${requestId}`, 'Popup detectado antes de capturar CAPTCHA, cerrando...');
      await cerrarPopups(page);
      await delay(500);
    }
    
    const captchaBase64 = await capturarCaptcha(page);
    
    if (!captchaBase64 || captchaBase64.length < 500) {
      throw new Error('No se pudo capturar el CAPTCHA');
    }
    
    log('success', `SCRAPER:${requestId}`, 'CAPTCHA capturado', { bytes: captchaBase64.length });
    
    // ========================================
    // PASO 8: Enviar imagen por WhatsApp
    // ========================================
    log('info', `SCRAPER:${requestId}`, 'Enviando imagen por WhatsApp...');
    
    const caption = `📩 ${nombreAbogado}, escriba el código que ve en la imagen y envíelo como respuesta.\n\n⏱️ Tiene 5 minutos.\n🔒 Credenciales ya llenadas.`;
    
    if (!await enviarWhatsAppImagen(whatsappNumero, captchaBase64, caption)) {
      throw new Error('No se pudo enviar la imagen por WhatsApp');
    }
    
    // ========================================
    // PASO 9: Esperar respuesta del abogado
    // ========================================
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
    
    // ========================================
    // PASO 10: Escribir CAPTCHA y hacer login
    // ========================================
    log('info', `SCRAPER:${requestId}`, 'Escribiendo CAPTCHA...');
    
    // Buscar campo del CAPTCHA
    const campoCaptcha = await page.$('input[placeholder*="CAPTCHA"], input[placeholder*="Captcha"], input[placeholder*="captcha"], input[id*="captcha"]');
    
    if (!campoCaptcha) {
      throw new Error('Campo de CAPTCHA no encontrado');
    }
    
    await campoCaptcha.click({ clickCount: 3 });
    await delay(100);
    await page.keyboard.press('Backspace');
    await delay(100);
    await campoCaptcha.type(captchaTexto.toUpperCase(), { delay: 50 });
    
    const urlAntes = page.url();
    
    // Buscar y hacer clic en el botón de ingresar
    const btnIngresar = await page.$('button[type="submit"], input[type="submit"], .ui-button');
    if (btnIngresar) {
      await btnIngresar.click();
    } else {
      await page.keyboard.press('Enter');
    }
    
    // Esperar navegación
    await page.waitForFunction(
      url => window.location.href !== url,
      { timeout: TIMEOUT.navegacion },
      urlAntes
    ).catch(() => {});
    
    await page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {});
    await delay(2000);
    
    // ========================================
    // PASO 11: Verificar resultado del login
    // ========================================
    log('info', `SCRAPER:${requestId}`, 'Verificando login...');
    
    const urlActual = page.url();
    const contenidoActual = await page.content();
    
    // Verificar errores
    if (contenidoActual.toLowerCase().includes('captcha') && 
        (contenidoActual.toLowerCase().includes('incorrecto') || contenidoActual.toLowerCase().includes('inválido'))) {
      await enviarWhatsAppTexto(whatsappNumero, `❌ CAPTCHA incorrecto. Intente de nuevo.`);
      throw new Error('CAPTCHA incorrecto');
    }
    
    if (urlActual.includes(SINOE_URLS.sessionActiva) || contenidoActual.includes('sesión activa')) {
      await enviarWhatsAppTexto(whatsappNumero, `⚠️ Hay sesión activa. Ciérrela e intente de nuevo.`);
      throw new Error('Sesión activa');
    }
    
    log('success', `SCRAPER:${requestId}`, 'Login exitoso');
    
    // ========================================
    // PASO 12: Navegar a Casillas
    // ========================================
    const hrefCasillas = await buscarLinkCasillas(page);
    if (hrefCasillas) {
      await page.goto(hrefCasillas, { waitUntil: 'networkidle2' });
    }
    
    // ========================================
    // PASO 13: Extraer notificaciones
    // ========================================
    log('info', `SCRAPER:${requestId}`, 'Extrayendo notificaciones...');
    const notificaciones = await extraerNotificaciones(page);
    
    // ========================================
    // ÉXITO
    // ========================================
    const duracionMs = Date.now() - inicioMs;
    metricas.scrapersExitosos++;
    
    const totalExitosos = metricas.scrapersExitosos;
    metricas.tiempoPromedioMs = Math.round(
      ((metricas.tiempoPromedioMs * (totalExitosos - 1)) + duracionMs) / totalExitosos
    );
    
    await enviarWhatsAppTexto(whatsappNumero,
      `✅ ${nombreAbogado}, acceso exitoso a SINOE.\n\n📋 ${notificaciones.length} notificación(es) encontrada(s).\n\nProcesando documentos...`
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
    version: '4.3.0',
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
  
  const resultado = await enviarWhatsAppTexto(validacion.numero, req.body.mensaje || '🧪 Test LEXA v4.3.0');
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

// Nuevo endpoint de debug para probar el cierre de popup
app.post('/test-popup', async (req, res) => {
  let browser = null;
  try {
    const ws = CONFIG.browserless.token 
      ? `${CONFIG.browserless.url}?token=${CONFIG.browserless.token}`
      : CONFIG.browserless.url;
    
    browser = await puppeteer.connect({ 
      browserWSEndpoint: ws,
      defaultViewport: { width: 1366, height: 768 }
    });
    
    const page = await browser.newPage();
    await page.goto(SINOE_URLS.login, { waitUntil: 'networkidle2' });
    await delay(3000);
    
    // Verificar popup
    const tienePopupAntes = await hayPopupVisible(page);
    const screenshotAntes = await page.screenshot({ encoding: 'base64' });
    
    // Intentar cerrar
    const cerrado = await cerrarPopups(page);
    
    // Verificar después
    const tienePopupDespues = await hayPopupVisible(page);
    const screenshotDespues = await page.screenshot({ encoding: 'base64' });
    
    res.json({
      success: true,
      tienePopupAntes,
      tienePopupDespues,
      popupCerrado: cerrado,
      screenshotAntes: screenshotAntes.substring(0, 100) + '...',
      screenshotDespues: screenshotDespues.substring(0, 100) + '...'
    });
    
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
║           LEXA SCRAPER SERVICE v4.3.0 (AAA)                      ║
╠══════════════════════════════════════════════════════════════════╣
║  Puerto: ${PORT}                                                     ║
║  Auth: ${process.env.API_KEY ? 'Configurada ✓' : 'Auto-generada ⚠️'}                                      ║
╠══════════════════════════════════════════════════════════════════╣
║  CORRECCIONES v4.3.0:                                            ║
║    ✓ FIX: cerrarPopups() usa page.evaluate()                     ║
║    ✓ FIX: Espera confirmación de cierre del popup                ║
║    ✓ FIX: hayPopupVisible() detecta overlays de PrimeFaces       ║
║    ✓ FIX: Múltiples verificaciones antes de capturar CAPTCHA     ║
║    ✓ NUEVO: Endpoint /test-popup para debug                      ║
╠══════════════════════════════════════════════════════════════════╣
║  ENDPOINTS:                                                      ║
║    GET  /health           POST /webhook/whatsapp                 ║
║    POST /scraper          GET  /sesiones                         ║
║    GET  /metricas         POST /test-whatsapp                    ║
║    POST /test-conexion    POST /test-popup                       ║
╚══════════════════════════════════════════════════════════════════╝
  `);
});
