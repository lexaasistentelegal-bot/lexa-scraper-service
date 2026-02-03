/**
 * ============================================================
 * LEXA SCRAPER - CORE MODULE v4.9.0
 * ============================================================
 * 
 * ⚠️  NO MODIFICAR ESTE ARCHIVO - ES LA BASE ESTABLE
 * 
 * Contiene:
 *   - Configuración y constantes
 *   - Funciones utilitarias
 *   - Lectura segura de páginas
 *   - WhatsApp (Evolution API)
 *   - Manejo de popups
 *   - Manejo de sesión activa
 *   - Credenciales
 *   - CAPTCHA
 * 
 * Si necesitas modificar algo, hazlo en index.js
 * ============================================================
 */

const puppeteer = require('puppeteer-core');
const crypto = require('crypto');

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

// Timeouts (en milisegundos)
const TIMEOUT = {
  navegacion: 60000,           // 1 minuto para cargar páginas
  captcha: 300000,             // 5 minutos para que el abogado resuelva
  api: 30000,                  // 30 segundos para APIs externas
  popup: 10000,                // 10 segundos para cerrar popups
  elemento: 15000,             // 15 segundos para elementos DOM
  imagenCarga: 5000,           // 5 segundos para imágenes
  
  // Tiempos para el problema del frame
  esperaPostClick: 15000,      // 15 seg de espera FIJA después del clic
  esperaEntreReintentos: 3000, // 3 seg entre cada reintento de lectura
  maxReintentosLectura: 30,    // 30 intentos máximo
  
  // Navegación post-login
  esperaClicCasillas: 10000,   // 10 seg después de clic en Casillas
  esperaCargaTabla: 8000,      // 8 seg para cargar tabla
  
  // Tiempos para sesión activa
  esperaFinalizarSesion: 5000, // 5 seg después de clic en FINALIZAR
  esperaPostFinalizacion: 8000 // 8 seg para que recargue el login
};

// Errores que indican frame en transición (ignorar y reintentar)
const ERRORES_FRAME = [
  'Requesting main frame too early',
  'Execution context was destroyed',
  'frame was detached',
  'Target closed',
  'Session closed',
  'Protocol error',
  'Cannot find context',
  'Execution context is not available',
  'Node is detached from document',
  'Node is either not visible or not an HTMLElement',
  'JSHandles can be evaluated only in the context they were created'
];

// Configuración externa
const CONFIG = {
  browserless: {
    url: process.env.BROWSERLESS_URL || 'wss://browser.lexaasistentelegal.com',
    token: process.env.BROWSERLESS_TOKEN || null
  },
  evolution: {
    url: process.env.EVOLUTION_URL || 'https://evo.lexaasistentelegal.com',
    apiKey: process.env.EVOLUTION_API_KEY || null,
    instance: process.env.EVOLUTION_INSTANCE || 'lexa-bot'
  }
};

// Rate limiting
const RATE_LIMIT = {
  windowMs: 60000,
  maxRequestsPerIp: 30
};

// Configuración de CAPTCHA
const CAPTCHA_CONFIG = {
  maxIntentos: 5,
  minWidth: 40,
  maxWidth: 300,
  minHeight: 20,
  maxHeight: 100,
  esperaEntreCarga: 2000,
  esperaDespuesRefresh: 3000
};

// Viewport
const DEFAULT_VIEWPORT = {
  width: 1366,
  height: 768
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
  captchasFallidos: 0,
  sesionesFinalizadas: 0,
  erroresFrameIgnorados: 0,
  reintentosLectura: 0,
  consolidadosDescargados: 0,
  modalesAbiertos: 0,
  tiempoPromedioMs: 0,
  ultimoReinicio: new Date().toISOString()
};

// ============================================================
// ALMACENAMIENTO
// ============================================================

const sesionesActivas = new Map();
const rateLimitCache = new Map();
const webhooksRecientes = new Map();
let limpiezaInterval = null;

// ============================================================
// FUNCIONES UTILITARIAS
// ============================================================

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(level, context, message, data = null) {
  const timestamp = new Date().toISOString();
  const icons = {
    'info': 'ℹ️',
    'success': '✅',
    'warn': '⚠️',
    'error': '❌',
    'debug': '🔍'
  };
  const icon = icons[level] || 'ℹ️';
  
  // FIX v4.8.6: Manejar data null/undefined/no-objeto
  let dataStr = '';
  if (data !== null && data !== undefined) {
    if (typeof data === 'object') {
      try {
        const keys = Object.keys(data);
        if (keys.length > 0) {
          dataStr = ' ' + JSON.stringify(data);
        }
      } catch (e) {
        dataStr = ' [objeto no serializable]';
      }
    } else {
      dataStr = ' ' + String(data);
    }
  }
  
  console.log(`[${timestamp}] ${icon} [${context}] ${message}${dataStr}`);
}

function enmascarar(texto) {
  if (!texto) return '';
  const str = String(texto);
  if (str.length <= 6) return '***';
  return str.substring(0, 3) + '***' + str.substring(str.length - 2);
}

function esErrorDeFrame(error) {
  if (!error || !error.message) return false;
  const mensaje = error.message.toLowerCase();
  return ERRORES_FRAME.some(patron => mensaje.includes(patron.toLowerCase()));
}

function validarNumeroWhatsApp(numero) {
  if (!numero) return { valido: false, error: 'Número vacío' };
  
  const limpio = numero.toString().replace(/\D/g, '');
  
  if (limpio.length < 8 || limpio.length > 15) {
    return { valido: false, error: `Número inválido (${limpio.length} dígitos)` };
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
      error: `El CAPTCHA debe tener entre 4-6 caracteres (recibido: ${limpio.length})`,
      sugerencia: 'Escriba solo las letras/números que ve en la imagen.'
    };
  }
  
  return { valido: true, captcha: limpio };
}

// Limpieza automática de sesiones expiradas
function iniciarLimpiezaAutomatica() {
  limpiezaInterval = setInterval(() => {
    const ahora = Date.now();
    
    for (const [numero, sesion] of sesionesActivas.entries()) {
      if (ahora - sesion.timestamp > 360000) { // 6 minutos
        log('warn', 'LIMPIEZA', `Sesión expirada: ${enmascarar(numero)}`);
        
        if (sesion.timeoutId) {
          clearTimeout(sesion.timeoutId);
        }
        
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
    
    for (const [key, timestamp] of webhooksRecientes.entries()) {
      if (ahora - timestamp > 300000) {
        webhooksRecientes.delete(key);
      }
    }
  }, 60000);
  
  limpiezaInterval.unref();
}

// ============================================================
// FUNCIONES DE LECTURA SEGURA
// ============================================================

async function leerUrlSegura(page) {
  try {
    return page.url();
  } catch (error) {
    if (esErrorDeFrame(error)) {
      metricas.erroresFrameIgnorados++;
      return null;
    }
    throw error;
  }
}

async function leerContenidoSeguro(page) {
  try {
    return await page.content();
  } catch (error) {
    if (esErrorDeFrame(error)) {
      metricas.erroresFrameIgnorados++;
      return null;
    }
    throw error;
  }
}

async function evaluarSeguro(page, fn, ...args) {
  try {
    return await page.evaluate(fn, ...args);
  } catch (error) {
    if (esErrorDeFrame(error)) {
      metricas.erroresFrameIgnorados++;
      return null;
    }
    throw error;
  }
}

/**
 * Espera a que el frame esté disponible y lee la página
 */
async function esperarYLeerPagina(page, requestId, urlAntes) {
  log('info', `LECTURA:${requestId}`, `Esperando ${TIMEOUT.esperaPostClick/1000}s sin tocar el page...`);
  await delay(TIMEOUT.esperaPostClick);
  
  for (let intento = 1; intento <= TIMEOUT.maxReintentosLectura; intento++) {
    metricas.reintentosLectura++;
    
    const url = await leerUrlSegura(page);
    
    if (url === null) {
      log('debug', `LECTURA:${requestId}`, `Intento ${intento}/${TIMEOUT.maxReintentosLectura}: URL no disponible`);
      await delay(TIMEOUT.esperaEntreReintentos);
      continue;
    }
    
    const contenido = await leerContenidoSeguro(page);
    
    if (contenido === null) {
      log('debug', `LECTURA:${requestId}`, `Intento ${intento}/${TIMEOUT.maxReintentosLectura}: Contenido no disponible`);
      await delay(TIMEOUT.esperaEntreReintentos);
      continue;
    }
    
    if (contenido.length < 500) {
      log('debug', `LECTURA:${requestId}`, `Intento ${intento}/${TIMEOUT.maxReintentosLectura}: Contenido muy corto`);
      await delay(TIMEOUT.esperaEntreReintentos);
      continue;
    }
    
    log('success', `LECTURA:${requestId}`, `Página leída en intento ${intento}`, {
      url: url.substring(0, 50),
      bytes: contenido.length
    });
    
    return { url, contenido, exito: true };
  }
  
  log('error', `LECTURA:${requestId}`, 'No se pudo leer la página');
  return { url: urlAntes, contenido: '', exito: false };
}

// ============================================================
// FUNCIONES DE WHATSAPP
// ============================================================

async function enviarWhatsAppTexto(numero, texto) {
  try {
    const response = await fetch(`${CONFIG.evolution.url}/message/sendText/${CONFIG.evolution.instance}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': CONFIG.evolution.apiKey
      },
      body: JSON.stringify({
        number: numero,
        text: texto
      })
    });
    
    log('success', 'WHATSAPP', 'Texto enviado', { numero: enmascarar(numero), longitud: texto.length });
    return true;
  } catch (error) {
    log('error', 'WHATSAPP', `Error enviando texto: ${error.message}`);
    return false;
  }
}

async function enviarWhatsAppImagen(numero, base64, caption) {
  try {
    const response = await fetch(`${CONFIG.evolution.url}/message/sendMedia/${CONFIG.evolution.instance}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': CONFIG.evolution.apiKey
      },
      body: JSON.stringify({
        number: numero,
        mediatype: 'image',
        mimetype: 'image/png',
        caption: caption,
        media: base64
      })
    });
    
    log('success', 'WHATSAPP', 'Imagen enviada', { numero: enmascarar(numero), size: base64.length });
    return true;
  } catch (error) {
    log('error', 'WHATSAPP', `Error enviando imagen: ${error.message}`);
    return false;
  }
}

// ============================================================
// FUNCIONES DE SINOE - POPUPS
// ============================================================

async function hayPopupVisible(page) {
  try {
    return await page.evaluate(() => {
      const selectores = [
        '.ui-dialog:not([style*="display: none"])',
        '.ui-overlay-modal',
        '.modal.show',
        '[role="dialog"]:not([style*="display: none"])',
        '.ui-widget-overlay'
      ];
      
      for (const selector of selectores) {
        const el = document.querySelector(selector);
        if (el) {
          const style = window.getComputedStyle(el);
          if (style.display !== 'none' && style.visibility !== 'hidden') {
            return true;
          }
        }
      }
      return false;
    });
  } catch (error) {
    if (esErrorDeFrame(error)) return false;
    throw error;
  }
}

async function cerrarPopups(page, contexto = 'POPUP') {
  log('info', contexto, 'Verificando si hay popups para cerrar...');
  
  const maxIntentos = 5;
  
  for (let intento = 1; intento <= maxIntentos; intento++) {
    const tienePopup = await hayPopupVisible(page);
    
    if (!tienePopup) {
      if (intento === 1) {
        log('info', contexto, 'No hay popups visibles');
      }
      return true;
    }
    
    log('info', contexto, `Intento ${intento}/${maxIntentos} de cerrar popup...`);
    
    try {
      const clicExitoso = await page.evaluate(() => {
        const botones = [
          ...document.querySelectorAll('.ui-dialog-titlebar-close'),
          ...document.querySelectorAll('button[aria-label="Close"]'),
          ...document.querySelectorAll('.ui-button-icon-only'),
          ...document.querySelectorAll('button.close'),
          ...document.querySelectorAll('[data-dismiss="modal"]'),
          ...document.querySelectorAll('button')
        ];
        
        for (const btn of botones) {
          const texto = (btn.textContent || '').toLowerCase().trim();
          const titulo = (btn.getAttribute('title') || '').toLowerCase();
          const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
          
          const esBotonCerrar = 
            texto.includes('cerrar') || texto.includes('close') ||
            texto.includes('aceptar') || texto.includes('accept') ||
            texto.includes('ok') || texto.includes('entendido') ||
            titulo.includes('cerrar') || titulo.includes('close') ||
            ariaLabel.includes('close') ||
            btn.classList.contains('ui-dialog-titlebar-close');
          
          if (esBotonCerrar) {
            const style = window.getComputedStyle(btn);
            if (style.display !== 'none' && style.visibility !== 'hidden') {
              btn.click();
              return texto || titulo || 'botón de cierre';
            }
          }
        }
        
        const overlay = document.querySelector('.ui-widget-overlay');
        if (overlay) {
          overlay.click();
          return 'overlay';
        }
        
        return null;
      });
      
      if (clicExitoso) {
        log('info', contexto, `Clic en: "${clicExitoso}"`);
        await delay(500);
        
        const abierto = await hayPopupVisible(page);
        if (!abierto) {
          log('success', contexto, 'Popup cerrado');
          return true;
        }
      }
    } catch (error) {
      if (!esErrorDeFrame(error)) {
        log('warn', contexto, `Error: ${error.message}`);
      }
    }
    
    await delay(500);
  }
  
  log('warn', contexto, 'No se pudo cerrar el popup');
  return false;
}

// ============================================================
// MANEJO DE SESIÓN ACTIVA
// ============================================================

/**
 * Maneja la página de sesión activa haciendo clic en FINALIZAR SESIONES
 */
async function manejarSesionActiva(page, requestId) {
  log('info', `SESION:${requestId}`, '🔄 Manejando sesión activa...');
  
  // Paso 1: Cerrar cualquier popup
  log('info', `SESION:${requestId}`, 'Cerrando popups previos...');
  await cerrarPopups(page, `SESION:${requestId}`);
  await delay(1000);
  
  // Paso 2: Buscar y hacer clic en "FINALIZAR SESIONES"
  log('info', `SESION:${requestId}`, 'Buscando botón FINALIZAR SESIONES...');
  
  const clickeado = await evaluarSeguro(page, () => {
    const elementos = document.querySelectorAll('button, a, input[type="submit"], input[type="button"], .ui-button');
    
    for (const el of elementos) {
      const texto = (el.textContent || '').toUpperCase().trim();
      const valor = (el.value || '').toUpperCase().trim();
      const onclick = (el.getAttribute('onclick') || '').toLowerCase();
      
      const esBotonFinalizar = 
        texto.includes('FINALIZAR') || 
        valor.includes('FINALIZAR') ||
        onclick.includes('finalizar');
      
      if (esBotonFinalizar) {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        
        if (rect.width > 0 && rect.height > 0 && 
            style.display !== 'none' && style.visibility !== 'hidden') {
          el.click();
          return { clickeado: true, texto: texto.substring(0, 30) || valor.substring(0, 30) };
        }
      }
    }
    
    return { clickeado: false };
  });
  
  if (!clickeado || !clickeado.clickeado) {
    log('warn', `SESION:${requestId}`, 'No se encontró botón FINALIZAR SESIONES');
    return false;
  }
  
  log('success', `SESION:${requestId}`, `✓ Clic en "${clickeado.texto}"`);
  metricas.sesionesFinalizadas++;
  
  // Paso 3: Esperar a que se procese el clic
  log('info', `SESION:${requestId}`, `Esperando ${TIMEOUT.esperaFinalizarSesion/1000}s...`);
  await delay(TIMEOUT.esperaFinalizarSesion);
  
  // Paso 4: Esperar más y verificar que estamos en el login
  await delay(TIMEOUT.esperaPostFinalizacion);
  
  const urlActual = await leerUrlSegura(page);
  
  if (urlActual && urlActual.includes('sso-validar')) {
    log('success', `SESION:${requestId}`, 'Redirigido al login exitosamente');
    return true;
  }
  
  // Si no estamos en el login, intentar navegar manualmente
  log('info', `SESION:${requestId}`, 'Navegando manualmente al login...');
  try {
    await page.goto(SINOE_URLS.login, { waitUntil: 'networkidle2', timeout: TIMEOUT.navegacion });
    await delay(3000);
    return true;
  } catch (error) {
    log('error', `SESION:${requestId}`, `Error navegando: ${error.message}`);
    return false;
  }
}

// ============================================================
// FUNCIONES DE CREDENCIALES
// ============================================================

async function llenarCredenciales(page, usuario, password) {
  log('info', 'CREDENCIALES', 'Buscando y llenando campos de login...');
  
  const resultado = await page.evaluate((user, pass) => {
    const inputs = document.querySelectorAll('input');
    let campoUsuario = null;
    let campoPassword = null;
    let usuarioLlenado = false;
    let passwordLlenado = false;
    const errores = [];
    
    for (const input of inputs) {
      const tipo = (input.type || '').toLowerCase();
      const placeholder = (input.placeholder || '').toLowerCase();
      const id = (input.id || '').toLowerCase();
      
      // Campo de usuario: text que no sea captcha
      if (tipo === 'text' && !placeholder.includes('captcha') && !id.includes('captcha')) {
        if (!campoUsuario) campoUsuario = input;
      }
      
      // Campo de password
      if (tipo === 'password') {
        campoPassword = input;
      }
    }
    
    // Llenar usuario
    if (campoUsuario) {
      try {
        campoUsuario.value = '';
        campoUsuario.value = user;
        campoUsuario.dispatchEvent(new Event('input', { bubbles: true }));
        campoUsuario.dispatchEvent(new Event('change', { bubbles: true }));
        usuarioLlenado = true;
      } catch (e) {
        errores.push(`Error usuario: ${e.message}`);
      }
    }
    
    // Llenar password
    if (campoPassword) {
      try {
        campoPassword.value = '';
        campoPassword.value = pass;
        campoPassword.dispatchEvent(new Event('input', { bubbles: true }));
        campoPassword.dispatchEvent(new Event('change', { bubbles: true }));
        passwordLlenado = true;
      } catch (e) {
        errores.push(`Error password: ${e.message}`);
      }
    }
    
    return { usuarioLlenado, passwordLlenado, errores };
  }, usuario, password);
  
  log('info', 'CREDENCIALES', 'Resultado:', resultado);
  
  if (!resultado.usuarioLlenado || !resultado.passwordLlenado) {
    throw new Error('No se pudieron llenar las credenciales: ' + (resultado.errores.join(', ') || 'campos no encontrados'));
  }
  
  await delay(500);
  
  // Verificación
  const verificacion = await page.evaluate(() => {
    const inputs = document.querySelectorAll('input');
    let usuarioOk = false;
    let passwordOk = false;
    let usuarioValor = '';
    
    for (const input of inputs) {
      if (input.type === 'text' && !input.placeholder?.toLowerCase().includes('captcha')) {
        if (input.value && input.value.length > 0) {
          usuarioOk = true;
          usuarioValor = input.value.substring(0, 3) + '***';
        }
      }
      if (input.type === 'password' && input.value && input.value.length > 0) {
        passwordOk = true;
      }
    }
    
    return { usuarioOk, passwordOk, usuarioValor };
  });
  
  log('info', 'CREDENCIALES', 'Verificación:', verificacion);
  
  if (!verificacion.usuarioOk || !verificacion.passwordOk) {
    throw new Error('Verificación de credenciales fallida');
  }
  
  log('success', 'CREDENCIALES', 'Campos llenados correctamente');
}

// ============================================================
// FUNCIONES DE CAPTCHA
// ============================================================

async function verificarCaptchaValido(page) {
  return await evaluarSeguro(page, (config) => {
    // Método 1: Buscar imagen de CAPTCHA por src
    const imgCaptcha = document.querySelector('img[src*="captcha"], img[id*="captcha"]');
    if (imgCaptcha && imgCaptcha.complete && imgCaptcha.naturalWidth > 0) {
      const w = imgCaptcha.naturalWidth;
      const h = imgCaptcha.naturalHeight;
      
      if (w >= config.minWidth && w <= config.maxWidth && 
          h >= config.minHeight && h <= config.maxHeight) {
        return { valido: true, width: w, height: h };
      }
    }
    
    // Método 2: Buscar imagen cerca del campo de captcha
    const campoCaptcha = document.querySelector('input[placeholder*="CAPTCHA"], input[id*="captcha"]');
    if (campoCaptcha) {
      let container = campoCaptcha.parentElement;
      let nivel = 0;
      
      while (container && nivel < 5) {
        for (const img of container.querySelectorAll('img')) {
          if (img.complete && img.naturalWidth >= 40 && img.naturalWidth <= 200 &&
              img.naturalHeight >= 20 && img.naturalHeight <= 80) {
            return { valido: true, width: img.naturalWidth, height: img.naturalHeight };
          }
        }
        container = container.parentElement;
        nivel++;
      }
    }
    
    // Método 3: Cualquier imagen pequeña en form
    const form = document.querySelector('form');
    if (form) {
      for (const img of form.querySelectorAll('img')) {
        if (img.complete && img.naturalWidth >= 40 && img.naturalWidth <= 200 &&
            img.naturalHeight >= 20 && img.naturalHeight <= 80) {
          return { valido: true, width: img.naturalWidth, height: img.naturalHeight };
        }
      }
    }
    
    return { valido: false, razon: 'No se encontró imagen de CAPTCHA válida' };
  }, CAPTCHA_CONFIG);
}

async function recargarCaptcha(page) {
  log('info', 'CAPTCHA', 'Intentando recargar CAPTCHA...');
  
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
      const cercanos = document.elementsFromPoint(rect.right + 25, rect.top + rect.height / 2);
      for (const el of cercanos) {
        if (el.tagName === 'A' || el.tagName === 'BUTTON' || el.onclick) {
          el.click();
          return { clicked: true };
        }
      }
    }
    
    const refreshBtn = document.querySelector('.ui-commandlink[id*="captcha"], a[id*="refresh"]');
    if (refreshBtn) {
      refreshBtn.click();
      return { clicked: true };
    }
    
    return { clicked: false };
  });
  
  if (recargado.clicked) {
    log('info', 'CAPTCHA', 'Botón de recarga clickeado');
    metricas.captchasRecargados++;
    await delay(CAPTCHA_CONFIG.esperaEntreCarga);
    return true;
  }
  
  log('warn', 'CAPTCHA', 'No se encontró botón de recarga');
  return false;
}

async function asegurarCaptchaValido(page, usuario, password) {
  const maxIntentos = CAPTCHA_CONFIG.maxIntentos;
  
  log('info', 'CAPTCHA', `Verificando CAPTCHA (máximo ${maxIntentos} intentos)...`);
  
  for (let intento = 1; intento <= maxIntentos; intento++) {
    const estado = await verificarCaptchaValido(page);
    
    if (estado.valido) {
      log('success', 'CAPTCHA', `✓ CAPTCHA válido en intento ${intento}/${maxIntentos}`, {
        width: estado.width,
        height: estado.height
      });
      return true;
    }
    
    log('warn', 'CAPTCHA', `Intento ${intento}/${maxIntentos}: ${estado.razon}`);
    
    if (intento === maxIntentos) break;
    
    const recargado = await recargarCaptcha(page);
    
    if (!recargado) {
      log('info', 'CAPTCHA', 'Refrescando página completa...');
      
      await page.reload({ waitUntil: 'networkidle2' });
      await delay(CAPTCHA_CONFIG.esperaDespuesRefresh);
      
      await cerrarPopups(page, 'CAPTCHA');
      await delay(500);
      
      await llenarCredenciales(page, usuario, password);
      await delay(500);
    }
    
    await delay(1000);
  }
  
  metricas.captchasFallidos++;
  throw new Error(`CAPTCHA no cargó después de ${maxIntentos} intentos`);
}

async function capturarFormularioLogin(page) {
  log('info', 'CAPTURA', 'Capturando formulario de login...');
  
  if (await hayPopupVisible(page)) {
    await cerrarPopups(page, 'CAPTURA');
    await delay(500);
  }
  
  const formularioInfo = await page.evaluate(() => {
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
              height: Math.min(rect.height + 20, window.innerHeight),
              selector
            };
          }
        }
      }
    }
    
    return { found: false };
  });
  
  if (!formularioInfo.found) {
    log('warn', 'CAPTURA', 'Formulario no encontrado, capturando página completa');
    return await page.screenshot({ encoding: 'base64' });
  }
  
  log('info', 'CAPTURA', `Formulario encontrado (${formularioInfo.selector})`);
  
  return await page.screenshot({
    encoding: 'base64',
    clip: {
      x: formularioInfo.x,
      y: formularioInfo.y,
      width: formularioInfo.width,
      height: formularioInfo.height
    }
  });
}

// ============================================================
// EXPORTAR TODO
// ============================================================

module.exports = {
  // Constantes
  PORT,
  API_KEY,
  SINOE_URLS,
  TIMEOUT,
  ERRORES_FRAME,
  CONFIG,
  RATE_LIMIT,
  CAPTCHA_CONFIG,
  DEFAULT_VIEWPORT,
  
  // Métricas y almacenamiento
  metricas,
  sesionesActivas,
  rateLimitCache,
  webhooksRecientes,
  
  // Funciones utilitarias
  delay,
  log,
  enmascarar,
  esErrorDeFrame,
  validarNumeroWhatsApp,
  validarCaptcha,
  iniciarLimpiezaAutomatica,
  
  // Lectura segura
  leerUrlSegura,
  leerContenidoSeguro,
  evaluarSeguro,
  esperarYLeerPagina,
  
  // WhatsApp
  enviarWhatsAppTexto,
  enviarWhatsAppImagen,
  
  // Popups
  hayPopupVisible,
  cerrarPopups,
  
  // Sesión
  manejarSesionActiva,
  
  // Credenciales
  llenarCredenciales,
  
  // CAPTCHA
  verificarCaptchaValido,
  recargarCaptcha,
  asegurarCaptchaValido,
  capturarFormularioLogin,
  
  // Para limpiezaInterval (necesario para shutdown)
  getLimpiezaInterval: () => limpiezaInterval,
  setLimpiezaInterval: (val) => { limpiezaInterval = val; }
};
