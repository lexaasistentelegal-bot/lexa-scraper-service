/**
 * ============================================================
 * LEXA SCRAPER SERVICE v4.5.0 - Sistema Screenshot CAPTCHA
 * ============================================================
 * Versión: AAA (Producción)
 * Fecha: Febrero 2026
 * 
 * CAMBIOS v4.5.0:
 * - FIX CRÍTICO: llenarCampo() ahora funciona con PrimeFaces
 * - FIX: Usa múltiples métodos para asegurar que el valor se guarde
 * - FIX: Dispara eventos input/change/blur para PrimeFaces
 * - FIX: Verifica que los campos se llenaron antes de continuar
 * - FIX: Selectores mejorados para campos de SINOE
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

// Timeouts
const TIMEOUT = {
  navegacion: 60000,
  captcha: 300000,
  api: 30000,
  popup: 10000,
  elemento: 15000,
  imagenCarga: 5000
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
  captchasRecargados: 0,
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

// Autenticación
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
// FUNCIONES WHATSAPP
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
// FUNCIONES DE SCRAPING - v4.5.0
// ============================================================

/**
 * Verifica si hay un popup/modal visible
 */
async function hayPopupVisible(page) {
  return await page.evaluate(() => {
    const overlays = document.querySelectorAll('.ui-widget-overlay, .ui-dialog-mask, .modal-backdrop');
    for (const overlay of overlays) {
      const style = window.getComputedStyle(overlay);
      if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
        return true;
      }
    }
    
    const dialogs = document.querySelectorAll('.ui-dialog, .modal, [role="dialog"]');
    for (const dialog of dialogs) {
      const style = window.getComputedStyle(dialog);
      if (style.display !== 'none' && style.visibility !== 'hidden') {
        return true;
      }
    }
    
    const bodyText = document.body.innerText || '';
    if (bodyText.includes('clic aqui') || bodyText.includes('clic aquí')) {
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
 * Cierra popups de SINOE
 */
async function cerrarPopups(page) {
  log('info', 'POPUP', 'Verificando popups...');
  
  const MAX_INTENTOS = 5;
  
  for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
    try {
      const tienePopup = await hayPopupVisible(page);
      
      if (!tienePopup) {
        log('success', 'POPUP', 'No hay popups visibles');
        return true;
      }
      
      log('info', 'POPUP', `Intento ${intento}/${MAX_INTENTOS} de cerrar popup...`);
      
      const clicExitoso = await page.evaluate(() => {
        const botones = document.querySelectorAll('button, .ui-button, input[type="button"], a.ui-button');
        
        for (const boton of botones) {
          const texto = (boton.textContent || boton.value || '').toLowerCase().trim();
          const rect = boton.getBoundingClientRect();
          
          if (rect.width > 0 && rect.height > 0 && rect.top >= 0) {
            if (texto === 'aceptar' || texto === 'acepto' || texto === 'ok' || texto === 'cerrar') {
              boton.click();
              return { clicked: true, texto: texto };
            }
          }
        }
        
        const dialogButtons = document.querySelectorAll('.ui-dialog-buttonset button');
        if (dialogButtons.length > 0) {
          dialogButtons[0].click();
          return { clicked: true, texto: 'botón de diálogo' };
        }
        
        return { clicked: false };
      });
      
      if (clicExitoso.clicked) {
        log('info', 'POPUP', `Clic en: "${clicExitoso.texto}"`);
        await delay(500);
        
        let esperaMs = 0;
        while (esperaMs < 3000) {
          if (!(await hayPopupVisible(page))) {
            log('success', 'POPUP', 'Popup cerrado');
            await delay(500);
            return true;
          }
          await delay(200);
          esperaMs += 200;
        }
      } else {
        await page.keyboard.press('Escape');
        await delay(500);
        if (!(await hayPopupVisible(page))) {
          log('success', 'POPUP', 'Popup cerrado con Escape');
          return true;
        }
      }
      
      await delay(1000);
      
    } catch (error) {
      log('warn', 'POPUP', `Error: ${error.message}`);
    }
  }
  
  return false;
}

/**
 * FUNCIÓN CRÍTICA v4.5.0: Llena un campo de forma robusta para PrimeFaces
 * Usa múltiples métodos para asegurar que el valor se guarde
 */
async function llenarCredenciales(page, usuario, password) {
  log('info', 'CREDENCIALES', 'Buscando y llenando campos de login...');
  
  // Usar page.evaluate para encontrar y llenar los campos directamente en el DOM
  // Esto es más confiable que usar selectores de Puppeteer con PrimeFaces
  const resultado = await page.evaluate((user, pass) => {
    const resultados = {
      usuarioEncontrado: false,
      passwordEncontrado: false,
      usuarioLlenado: false,
      passwordLlenado: false,
      errores: []
    };
    
    // Función auxiliar para llenar un campo y disparar eventos
    function llenarCampo(input, valor, nombre) {
      if (!input) {
        resultados.errores.push(`Campo ${nombre} no encontrado`);
        return false;
      }
      
      try {
        // Hacer focus en el campo
        input.focus();
        
        // Limpiar el campo
        input.value = '';
        
        // Establecer el valor
        input.value = valor;
        
        // Disparar eventos que PrimeFaces necesita para registrar el cambio
        // Esto es CRÍTICO para que PrimeFaces detecte el valor
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('blur', { bubbles: true }));
        
        // También disparar evento de teclado por si acaso
        input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
        
        // Verificar que el valor se guardó
        if (input.value === valor) {
          return true;
        } else {
          resultados.errores.push(`Campo ${nombre}: valor no se guardó`);
          return false;
        }
      } catch (e) {
        resultados.errores.push(`Campo ${nombre}: ${e.message}`);
        return false;
      }
    }
    
    // ESTRATEGIA 1: Buscar por tipo de input (más confiable)
    const allInputs = document.querySelectorAll('input');
    let campoUsuario = null;
    let campoPassword = null;
    
    for (const input of allInputs) {
      const type = input.type?.toLowerCase() || '';
      const placeholder = (input.placeholder || '').toLowerCase();
      const id = (input.id || '').toLowerCase();
      const name = (input.name || '').toLowerCase();
      
      // Identificar campo de usuario (tipo text, no es captcha)
      if (type === 'text' && !placeholder.includes('captcha') && !id.includes('captcha')) {
        if (!campoUsuario) {
          campoUsuario = input;
          resultados.usuarioEncontrado = true;
        }
      }
      
      // Identificar campo de contraseña
      if (type === 'password') {
        campoPassword = input;
        resultados.passwordEncontrado = true;
      }
    }
    
    // ESTRATEGIA 2: Si no encontramos, buscar por placeholder
    if (!campoUsuario) {
      campoUsuario = document.querySelector('input[placeholder*="Usuario"], input[placeholder*="usuario"]');
      if (campoUsuario) resultados.usuarioEncontrado = true;
    }
    
    if (!campoPassword) {
      campoPassword = document.querySelector('input[placeholder*="Contraseña"], input[placeholder*="contraseña"], input[placeholder*="Password"]');
      if (campoPassword) resultados.passwordEncontrado = true;
    }
    
    // Llenar los campos
    if (campoUsuario) {
      resultados.usuarioLlenado = llenarCampo(campoUsuario, user, 'usuario');
    }
    
    if (campoPassword) {
      resultados.passwordLlenado = llenarCampo(campoPassword, pass, 'password');
    }
    
    return resultados;
  }, usuario, password);
  
  log('info', 'CREDENCIALES', 'Resultado del llenado:', resultado);
  
  // Verificar que se llenaron correctamente
  if (!resultado.usuarioLlenado || !resultado.passwordLlenado) {
    // Intentar método alternativo con Puppeteer typing
    log('warn', 'CREDENCIALES', 'Método directo falló, intentando con typing...');
    
    try {
      // Buscar campos con Puppeteer
      const inputUsuario = await page.$('input[type="text"]:not([placeholder*="CAPTCHA"]):not([placeholder*="captcha"])');
      const inputPassword = await page.$('input[type="password"]');
      
      if (inputUsuario && !resultado.usuarioLlenado) {
        await inputUsuario.click({ clickCount: 3 }); // Seleccionar todo
        await delay(100);
        await inputUsuario.type(usuario, { delay: 30 });
        log('info', 'CREDENCIALES', 'Usuario llenado con typing');
      }
      
      if (inputPassword && !resultado.passwordLlenado) {
        await inputPassword.click({ clickCount: 3 });
        await delay(100);
        await inputPassword.type(password, { delay: 30 });
        log('info', 'CREDENCIALES', 'Password llenado con typing');
      }
    } catch (e) {
      log('error', 'CREDENCIALES', `Error en typing: ${e.message}`);
    }
  }
  
  // Esperar un momento para que PrimeFaces procese
  await delay(500);
  
  // Verificación final
  const verificacion = await page.evaluate(() => {
    const inputs = document.querySelectorAll('input');
    let usuario = '', password = '';
    
    for (const input of inputs) {
      if (input.type === 'text' && !input.placeholder?.toLowerCase().includes('captcha')) {
        usuario = input.value || '';
      }
      if (input.type === 'password') {
        password = input.value || '';
      }
    }
    
    return {
      usuarioTieneValor: usuario.length > 0,
      passwordTieneValor: password.length > 0,
      usuarioValor: usuario.substring(0, 3) + '***',
      passwordValor: password.length > 0 ? '***' : '(vacío)'
    };
  });
  
  log('info', 'CREDENCIALES', 'Verificación final:', verificacion);
  
  if (!verificacion.usuarioTieneValor || !verificacion.passwordTieneValor) {
    throw new Error('No se pudieron llenar las credenciales correctamente');
  }
  
  log('success', 'CREDENCIALES', 'Campos llenados correctamente');
  return true;
}

/**
 * Verifica si el CAPTCHA cargó correctamente
 */
async function verificarCaptchaValido(page) {
  return await page.evaluate(() => {
    const imagenes = document.querySelectorAll('img');
    
    for (const img of imagenes) {
      const src = (img.src || '').toLowerCase();
      const id = (img.id || '').toLowerCase();
      
      if (src.includes('captcha') || id.includes('captcha')) {
        if (!img.complete) {
          return { valido: false, razon: 'Imagen cargando' };
        }
        
        if (img.naturalWidth === 0 || img.naturalHeight === 0) {
          return { valido: false, razon: 'Imagen no cargó' };
        }
        
        if (img.naturalWidth < 50 || img.naturalWidth > 300) {
          return { valido: false, razon: `Dimensiones inválidas: ${img.naturalWidth}x${img.naturalHeight}` };
        }
        
        return { 
          valido: true, 
          razon: 'OK',
          width: img.naturalWidth,
          height: img.naturalHeight
        };
      }
    }
    
    return { valido: false, razon: 'No se encontró CAPTCHA' };
  });
}

/**
 * Recarga el CAPTCHA
 */
async function recargarCaptcha(page) {
  log('info', 'CAPTCHA', 'Recargando CAPTCHA...');
  
  const recargado = await page.evaluate(() => {
    const elementos = document.querySelectorAll('a, button, img, span, i');
    for (const el of elementos) {
      const onclick = el.getAttribute('onclick') || '';
      if (onclick.toLowerCase().includes('captcha') || onclick.toLowerCase().includes('refresh')) {
        el.click();
        return { clicked: true };
      }
    }
    
    const captchaImg = document.querySelector('img[src*="captcha"]');
    if (captchaImg) {
      const rect = captchaImg.getBoundingClientRect();
      const elementosCerca = document.elementsFromPoint(rect.right + 20, rect.top + rect.height / 2);
      for (const el of elementosCerca) {
        if (el.tagName === 'A' || el.tagName === 'BUTTON' || el.onclick) {
          el.click();
          return { clicked: true };
        }
      }
    }
    
    return { clicked: false };
  });
  
  if (recargado.clicked) {
    await delay(2000);
    metricas.captchasRecargados++;
    return true;
  }
  
  return false;
}

/**
 * Captura el formulario completo de login
 */
async function capturarFormularioLogin(page) {
  log('info', 'CAPTURA', 'Capturando formulario...');
  
  // Verificar popups
  if (await hayPopupVisible(page)) {
    await cerrarPopups(page);
    await delay(500);
  }
  
  // Verificar CAPTCHA
  const MAX_INTENTOS = 3;
  for (let i = 1; i <= MAX_INTENTOS; i++) {
    const estado = await verificarCaptchaValido(page);
    if (estado.valido) {
      log('success', 'CAPTURA', `CAPTCHA válido: ${estado.width}x${estado.height}`);
      break;
    }
    
    log('warn', 'CAPTURA', `Intento ${i}: ${estado.razon}`);
    if (i < MAX_INTENTOS) {
      await recargarCaptcha(page);
      await delay(2000);
    }
  }
  
  // Buscar el formulario
  const formularioInfo = await page.evaluate(() => {
    // Buscar panel de login
    const selectores = ['.ui-panel-content', '.ui-panel', 'form', '.login-container'];
    
    for (const selector of selectores) {
      const elementos = document.querySelectorAll(selector);
      
      for (const el of elementos) {
        const tieneUsuario = el.querySelector('input[type="text"]');
        const tienePassword = el.querySelector('input[type="password"]');
        
        if (tieneUsuario && tienePassword) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 200 && rect.height > 200) {
            return {
              found: true,
              x: Math.max(0, rect.x - 10),
              y: Math.max(0, rect.y - 10),
              width: Math.min(rect.width + 20, window.innerWidth),
              height: Math.min(rect.height + 20, window.innerHeight)
            };
          }
        }
      }
    }
    
    // Fallback: buscar desde el CAPTCHA
    const captcha = document.querySelector('img[src*="captcha"]');
    if (captcha) {
      let container = captcha.parentElement;
      let nivel = 0;
      
      while (container && nivel < 10) {
        const rect = container.getBoundingClientRect();
        if (rect.width > 300 && rect.height > 300) {
          return {
            found: true,
            x: Math.max(0, rect.x - 10),
            y: Math.max(0, rect.y - 10),
            width: Math.min(rect.width + 20, window.innerWidth),
            height: Math.min(rect.height + 20, window.innerHeight)
          };
        }
        container = container.parentElement;
        nivel++;
      }
    }
    
    return { found: false };
  });
  
  if (formularioInfo.found) {
    const screenshot = await page.screenshot({
      encoding: 'base64',
      clip: formularioInfo
    });
    
    if (screenshot && screenshot.length > 1000) {
      log('success', 'CAPTURA', 'Screenshot capturado', { bytes: screenshot.length });
      return screenshot;
    }
  }
  
  // Fallback: área central
  const viewport = await page.viewport();
  const screenshot = await page.screenshot({
    encoding: 'base64',
    clip: {
      x: Math.max(0, (viewport.width - 500) / 2),
      y: 100,
      width: 500,
      height: 550
    }
  });
  
  return screenshot;
}

/**
 * Busca link a Casillas
 */
async function buscarLinkCasillas(page) {
  return await page.evaluate(() => {
    const links = document.querySelectorAll('a');
    for (const link of links) {
      const texto = (link.textContent || '').toLowerCase();
      const href = (link.href || '').toLowerCase();
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
 * Extrae notificaciones
 */
async function extraerNotificaciones(page) {
  try {
    await page.waitForSelector('table, .ui-datatable', { timeout: TIMEOUT.navegacion });
  } catch (e) {}
  
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
// FUNCIÓN PRINCIPAL
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
      defaultViewport: { width: 1366, height: 768 }
    });
    
    page = await browser.newPage();
    page.setDefaultNavigationTimeout(TIMEOUT.navegacion);
    
    // PASO 2: Navegar a SINOE
    log('info', `SCRAPER:${requestId}`, 'Navegando a SINOE...');
    await page.goto(SINOE_URLS.login, { waitUntil: 'networkidle2' });
    await delay(3000);
    
    // PASO 3: Manejar página de parámetros
    const contenido = await page.content();
    if (contenido.includes('PARAMETROS DE SEGURIDAD NO VALIDOS')) {
      log('info', `SCRAPER:${requestId}`, 'Página de parámetros detectada...');
      await page.evaluate(() => {
        const btns = document.querySelectorAll('button, a');
        for (const btn of btns) {
          if ((btn.textContent || '').toUpperCase().includes('INICIO')) {
            btn.click();
            return;
          }
        }
      });
      await page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {});
      await delay(2000);
    }
    
    // PASO 4: Cerrar popups
    log('info', `SCRAPER:${requestId}`, 'Cerrando popups...');
    await cerrarPopups(page);
    await delay(1000);
    
    // PASO 5: Esperar campos de login
    log('info', `SCRAPER:${requestId}`, 'Esperando campos...');
    await page.waitForSelector('input[type="text"], input[type="password"]', { timeout: TIMEOUT.elemento });
    
    if (await hayPopupVisible(page)) {
      await cerrarPopups(page);
      await delay(500);
    }
    
    // PASO 6: LLENAR CREDENCIALES (función mejorada v4.5.0)
    log('info', `SCRAPER:${requestId}`, 'Llenando credenciales...');
    await llenarCredenciales(page, sinoeUsuario, sinoePassword);
    await delay(1000);
    
    // PASO 7: Verificar popup de nuevo (pueden aparecer después de llenar)
    if (await hayPopupVisible(page)) {
      await cerrarPopups(page);
      await delay(500);
    }
    
    // PASO 8: Capturar formulario
    log('info', `SCRAPER:${requestId}`, 'Capturando formulario...');
    const screenshotBase64 = await capturarFormularioLogin(page);
    
    if (!screenshotBase64 || screenshotBase64.length < 1000) {
      throw new Error('No se pudo capturar el formulario');
    }
    
    log('success', `SCRAPER:${requestId}`, 'Formulario capturado', { bytes: screenshotBase64.length });
    
    // PASO 9: Enviar por WhatsApp
    log('info', `SCRAPER:${requestId}`, 'Enviando imagen...');
    
    const caption = `📩 ${nombreAbogado}, escriba el código CAPTCHA que ve en la imagen y envíelo como respuesta.\n\n⏱️ Tiene 5 minutos.\n🔒 Credenciales ya llenadas.`;
    
    if (!await enviarWhatsAppImagen(whatsappNumero, screenshotBase64, caption)) {
      throw new Error('No se pudo enviar imagen por WhatsApp');
    }
    
    // PASO 10: Esperar respuesta
    log('info', `SCRAPER:${requestId}`, 'Esperando CAPTCHA del abogado...');
    
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
    
    // PASO 11: Escribir CAPTCHA
    log('info', `SCRAPER:${requestId}`, 'Escribiendo CAPTCHA...');
    
    const campoCaptcha = await page.$('input[placeholder*="CAPTCHA"], input[placeholder*="Captcha"], input[placeholder*="captcha"]');
    
    if (!campoCaptcha) {
      throw new Error('Campo de CAPTCHA no encontrado');
    }
    
    await campoCaptcha.click({ clickCount: 3 });
    await delay(100);
    await campoCaptcha.type(captchaTexto.toUpperCase(), { delay: 50 });
    
    const urlAntes = page.url();
    
    // PASO 12: Click en Ingresar
    const btnIngresar = await page.$('button[type="submit"], input[type="submit"], .ui-button');
    if (btnIngresar) {
      await btnIngresar.click();
    } else {
      await page.keyboard.press('Enter');
    }
    
    await page.waitForFunction(
      url => window.location.href !== url,
      { timeout: TIMEOUT.navegacion },
      urlAntes
    ).catch(() => {});
    
    await page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {});
    await delay(2000);
    
    // PASO 13: Verificar login
    log('info', `SCRAPER:${requestId}`, 'Verificando login...');
    
    const urlActual = page.url();
    const contenidoActual = await page.content();
    
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
    
    // PASO 14: Navegar a Casillas
    const hrefCasillas = await buscarLinkCasillas(page);
    if (hrefCasillas) {
      await page.goto(hrefCasillas, { waitUntil: 'networkidle2' });
    }
    
    // PASO 15: Extraer notificaciones
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
    version: '4.5.0',
    uptime: process.uptime(),
    sesionesActivas: sesionesActivas.size,
    metricas: {
      exitosos: metricas.scrapersExitosos,
      fallidos: metricas.scrapersFallidos,
      captchasRecargados: metricas.captchasRecargados,
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
  
  const resultado = await enviarWhatsAppTexto(validacion.numero, req.body.mensaje || '🧪 Test LEXA v4.5.0');
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

// Endpoint de prueba para credenciales
app.post('/test-credenciales', async (req, res) => {
  let browser = null;
  try {
    const { usuario, password } = req.body;
    
    if (!usuario || !password) {
      return res.status(400).json({ success: false, error: 'Faltan usuario y password' });
    }
    
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
    
    await cerrarPopups(page);
    await delay(1000);
    
    // Llenar credenciales
    await llenarCredenciales(page, usuario, password);
    await delay(500);
    
    // Verificar valores
    const valores = await page.evaluate(() => {
      const inputs = document.querySelectorAll('input');
      let user = '', pass = '';
      
      for (const input of inputs) {
        if (input.type === 'text' && !input.placeholder?.toLowerCase().includes('captcha')) {
          user = input.value;
        }
        if (input.type === 'password') {
          pass = input.value;
        }
      }
      
      return { usuario: user, password: pass.length > 0 ? '***' : '(vacío)' };
    });
    
    // Capturar screenshot
    const screenshot = await capturarFormularioLogin(page);
    
    res.json({
      success: true,
      valores,
      screenshotBytes: screenshot.length
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
║           LEXA SCRAPER SERVICE v4.5.0 (AAA)                      ║
╠══════════════════════════════════════════════════════════════════╣
║  Puerto: ${PORT}                                                     ║
║  Auth: ${process.env.API_KEY ? 'Configurada ✓' : 'Auto-generada ⚠️'}                                      ║
╠══════════════════════════════════════════════════════════════════╣
║  CAMBIOS v4.5.0:                                                 ║
║    ✓ FIX: llenarCredenciales() funciona con PrimeFaces           ║
║    ✓ FIX: Dispara eventos input/change/blur                      ║
║    ✓ FIX: Verifica que los campos se llenaron                    ║
║    ✓ FIX: Método fallback con Puppeteer typing                   ║
║    ✓ NUEVO: Endpoint /test-credenciales para debug               ║
╠══════════════════════════════════════════════════════════════════╣
║  ENDPOINTS:                                                      ║
║    GET  /health             POST /webhook/whatsapp               ║
║    POST /scraper            GET  /sesiones                       ║
║    GET  /metricas           POST /test-whatsapp                  ║
║    POST /test-conexion      POST /test-credenciales              ║
╚══════════════════════════════════════════════════════════════════╝
  `);
});
