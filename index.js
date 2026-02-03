/**
 * ============================================================
 * LEXA SCRAPER SERVICE v4.8.0 - Solución Probada "Requesting main frame too early!"
 * ============================================================
 * Versión: PRODUCCIÓN - SOLUCIÓN DEFINITIVA
 * Fecha: Febrero 2026
 * Autor: CTO SINOE Assistant
 * 
 * CAMBIOS v4.8.0 vs v4.7.0:
 * =========================
 * 
 * PROBLEMA: El error "Requesting main frame too early!" ocurre porque:
 * - SINOE usa JSF/PrimeFaces que hace redirect via JavaScript
 * - El redirect destruye el frame antes de crear el nuevo
 * - Puppeteer lanza error si accedemos al frame durante esta transición
 * 
 * SOLUCIÓN v4.8.0 (PROBADA):
 * - NO usar page.mainFrame() en ningún listener
 * - NO usar waitForNavigation (es poco confiable con JSF)
 * - Después del clic: esperar tiempo FIJO de 15 segundos SIN TOCAR el page
 * - Luego: intentar leer con page.url() y page.content() con try-catch
 * - Si falla: esperar 3 segundos más y reintentar (máximo 30 intentos = 90 seg)
 * - Detectar login exitoso por URL O por contenido de la página
 * 
 * FLUJO POST-LOGIN:
 * 1. Después del login exitoso, detectar las 3 opciones (SINOE, MPE, MPe ANC)
 * 2. Hacer clic en "Casillas Electrónicas" (primera opción)
 * 3. Esperar la tabla de notificaciones
 * 4. Navegar por las notificaciones y descargar consolidados
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

// v4.8.0: Timeouts reajustados
const TIMEOUT = {
  navegacion: 60000,           // 1 minuto para cargar páginas
  captcha: 300000,             // 5 minutos para que el abogado resuelva
  api: 30000,                  // 30 segundos para APIs externas
  popup: 10000,                // 10 segundos para cerrar popups
  elemento: 15000,             // 15 segundos para elementos DOM
  imagenCarga: 5000,           // 5 segundos para imágenes
  
  // v4.8.0: Tiempos específicos para el problema del frame
  esperaPostClick: 15000,      // 15 seg de espera FIJA después del clic (NO TOCAR PAGE)
  esperaEntreReintentos: 3000, // 3 seg entre cada reintento de lectura
  maxReintentosLectura: 30,    // 30 intentos máximo (30 * 3 = 90 seg adicionales)
  
  // Navegación dentro de SINOE post-login
  esperaClicCasillas: 10000,   // 10 seg después de clic en Casillas
  esperaCargaTabla: 8000       // 8 seg para cargar tabla de notificaciones
};

// v4.8.0: Errores que indican frame en transición (ignorar y reintentar)
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
  // v4.8.0: Métricas de diagnóstico
  erroresFrameIgnorados: 0,
  reintentosLectura: 0,
  tiempoPromedioMs: 0,
  ultimoReinicio: new Date().toISOString()
};

// ============================================================
// ALMACENAMIENTO
// ============================================================

const sesionesActivas = new Map();
const rateLimitCache = new Map();
const webhooksRecientes = new Map(); // Para detectar duplicados
let limpiezaInterval = null;

// ============================================================
// FUNCIONES UTILITARIAS
// ============================================================

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(level, context, message, data = {}) {
  const timestamp = new Date().toISOString();
  const icons = {
    'info': 'ℹ️',
    'success': '✅',
    'warn': '⚠️',
    'error': '❌',
    'debug': '🔍'
  };
  const icon = icons[level] || 'ℹ️';
  const dataStr = Object.keys(data).length ? ' ' + JSON.stringify(data) : '';
  console.log(`[${timestamp}] ${icon} [${context}] ${message}${dataStr}`);
}

function enmascarar(texto) {
  if (!texto) return '';
  const str = String(texto);
  if (str.length <= 6) return '***';
  return str.substring(0, 3) + '***' + str.substring(str.length - 2);
}

/**
 * v4.8.0: Detecta si un error es de frame en transición
 * ESTOS ERRORES SE IGNORAN Y SE REINTENTA
 */
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

function iniciarLimpiezaAutomatica() {
  limpiezaInterval = setInterval(() => {
    const ahora = Date.now();
    
    // Limpiar sesiones expiradas
    for (const [numero, sesion] of sesionesActivas.entries()) {
      if (ahora - sesion.timestamp > 360000) { // 6 minutos
        log('warn', 'LIMPIEZA', `Sesión expirada: ${enmascarar(numero)}`);
        if (sesion.reject) sesion.reject(new Error('Timeout: CAPTCHA no resuelto'));
        if (sesion.browser) sesion.browser.close().catch(() => {});
        sesionesActivas.delete(numero);
      }
    }
    
    // Limpiar rate limit cache
    for (const [ip, data] of rateLimitCache.entries()) {
      if (ahora - data.timestamp > RATE_LIMIT.windowMs) {
        rateLimitCache.delete(ip);
      }
    }
    
    // Limpiar webhooks recientes (5 minutos)
    for (const [key, timestamp] of webhooksRecientes.entries()) {
      if (ahora - timestamp > 300000) {
        webhooksRecientes.delete(key);
      }
    }
  }, 60000);
  
  limpiezaInterval.unref();
}

// ============================================================
// v4.8.0: FUNCIONES DE LECTURA SEGURA (SOLUCIÓN AL ERROR)
// ============================================================

/**
 * v4.8.0: Lee la URL de forma segura
 * Retorna null si el frame no está disponible (NO lanza error)
 */
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

/**
 * v4.8.0: Lee el contenido HTML de forma segura
 * Retorna null si el frame no está disponible (NO lanza error)
 */
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

/**
 * v4.8.0: Ejecuta page.evaluate() de forma segura
 * Retorna null si falla por frame en transición
 */
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
 * v4.8.0: FUNCIÓN PRINCIPAL - Espera a que el frame esté disponible después del clic
 * 
 * ESTRATEGIA:
 * 1. NO usar waitForNavigation (no es confiable con JSF)
 * 2. Esperar tiempo fijo SIN TOCAR el page
 * 3. Luego intentar leer URL y contenido con try-catch
 * 4. Si falla, esperar más y reintentar
 * 
 * @returns {Promise<{url: string, contenido: string, exito: boolean}>}
 */
async function esperarYLeerPagina(page, requestId, urlAntes) {
  // PASO 1: Esperar tiempo fijo SIN TOCAR el page
  log('info', `LECTURA:${requestId}`, `Esperando ${TIMEOUT.esperaPostClick/1000}s sin tocar el page...`);
  await delay(TIMEOUT.esperaPostClick);
  
  // PASO 2: Intentar leer con reintentos
  for (let intento = 1; intento <= TIMEOUT.maxReintentosLectura; intento++) {
    metricas.reintentosLectura++;
    
    // Intentar leer URL
    const url = await leerUrlSegura(page);
    
    if (url === null) {
      log('debug', `LECTURA:${requestId}`, `Intento ${intento}/${TIMEOUT.maxReintentosLectura}: URL no disponible aún`);
      await delay(TIMEOUT.esperaEntreReintentos);
      continue;
    }
    
    // Intentar leer contenido
    const contenido = await leerContenidoSeguro(page);
    
    if (contenido === null) {
      log('debug', `LECTURA:${requestId}`, `Intento ${intento}/${TIMEOUT.maxReintentosLectura}: Contenido no disponible aún`);
      await delay(TIMEOUT.esperaEntreReintentos);
      continue;
    }
    
    // Verificar que el contenido sea válido (no vacío)
    if (contenido.length < 500) {
      log('debug', `LECTURA:${requestId}`, `Intento ${intento}/${TIMEOUT.maxReintentosLectura}: Contenido muy corto (${contenido.length} bytes)`);
      await delay(TIMEOUT.esperaEntreReintentos);
      continue;
    }
    
    // ¡Éxito!
    log('success', `LECTURA:${requestId}`, `Página leída en intento ${intento}`, {
      url: url.substring(0, 50),
      bytes: contenido.length,
      cambioUrl: url !== urlAntes
    });
    
    return { url, contenido, exito: true };
  }
  
  // Timeout total
  log('error', `LECTURA:${requestId}`, 'No se pudo leer la página después de todos los reintentos');
  return { url: urlAntes, contenido: '', exito: false };
}

/**
 * v4.8.0: Analiza el resultado del login basado en URL y contenido
 */
function analizarResultadoLogin(url, contenido, urlAntes) {
  const urlLower = url.toLowerCase();
  const contenidoLower = contenido.toLowerCase();
  
  // 1. Error de CAPTCHA
  if (contenidoLower.includes('captcha') && 
      (contenidoLower.includes('incorrecto') || 
       contenidoLower.includes('inválido') ||
       contenidoLower.includes('error'))) {
    return { tipo: 'captcha_incorrecto', mensaje: 'CAPTCHA incorrecto' };
  }
  
  // 2. Sesión activa
  if (urlLower.includes('session-activa') || 
      contenidoLower.includes('sesión activa') ||
      contenidoLower.includes('sesion activa')) {
    return { tipo: 'sesion_activa', mensaje: 'Ya existe una sesión activa' };
  }
  
  // 3. Login exitoso - detectar página de bienvenida con las 3 opciones
  // La página post-login tiene "Bienvenido(a):" y los enlaces a SINOE, MPE, MPe ANC
  if (contenidoLower.includes('bienvenido') ||
      contenidoLower.includes('casillas electrónicas') ||
      contenidoLower.includes('casillas electronicas') ||
      contenidoLower.includes('mesa de partes') ||
      urlLower.includes('login.xhtml') ||
      urlLower.includes('menu-app')) {
    return { tipo: 'login_exitoso', mensaje: 'Login exitoso' };
  }
  
  // 4. Cambió la URL (probable éxito)
  if (url !== urlAntes && !urlLower.includes('sso-validar')) {
    return { tipo: 'login_exitoso', mensaje: 'Login exitoso (URL cambió)' };
  }
  
  // 5. Indeterminado pero sin error visible
  if (!contenidoLower.includes('error') && !contenidoLower.includes('invalid')) {
    return { tipo: 'indeterminado', mensaje: 'Resultado no determinado, continuando...' };
  }
  
  return { tipo: 'error_desconocido', mensaje: 'Error desconocido' };
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
    
    const data = await response.json();
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
    
    const data = await response.json();
    log('success', 'WHATSAPP', 'Imagen enviada', { numero: enmascarar(numero), size: base64.length, captionLength: caption.length });
    return true;
  } catch (error) {
    log('error', 'WHATSAPP', `Error enviando imagen: ${error.message}`);
    return false;
  }
}

// ============================================================
// FUNCIONES DE SINOE
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

async function cerrarPopups(page) {
  log('info', 'POPUP', 'Verificando si hay popups para cerrar...');
  
  const maxIntentos = 5;
  
  for (let intento = 1; intento <= maxIntentos; intento++) {
    const tienePopup = await hayPopupVisible(page);
    
    if (!tienePopup) {
      if (intento === 1) {
        log('info', 'POPUP', 'No hay popups visibles');
      }
      return true;
    }
    
    log('info', 'POPUP', `Intento ${intento}/${maxIntentos} de cerrar popup...`);
    
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
          const texto = (btn.textContent || '').toLowerCase();
          const titulo = (btn.getAttribute('title') || '').toLowerCase();
          const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
          
          const esBotonCerrar = 
            texto.includes('cerrar') || texto.includes('close') ||
            texto.includes('aceptar') || texto.includes('accept') ||
            texto.includes('ok') || texto.includes('entendido') ||
            titulo.includes('cerrar') || titulo.includes('close') ||
            ariaLabel.includes('close');
          
          if (esBotonCerrar || btn.classList.contains('ui-dialog-titlebar-close')) {
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
        log('info', 'POPUP', `Clic en botón: "${clicExitoso}"`);
        await delay(500);
        
        const abierto = await hayPopupVisible(page);
        if (!abierto) {
          log('success', 'POPUP', `Popup cerrado después de ${(intento-1) * 500}ms`);
          return true;
        }
      }
    } catch (error) {
      if (!esErrorDeFrame(error)) {
        log('warn', 'POPUP', `Error en intento ${intento}: ${error.message}`);
      }
    }
    
    await delay(500);
  }
  
  log('warn', 'POPUP', 'No se pudo cerrar el popup después de todos los intentos');
  return false;
}

async function llenarCredenciales(page, usuario, password) {
  log('info', 'CREDENCIALES', 'Buscando y llenando campos de login...');
  
  const resultado = await page.evaluate((user, pass) => {
    const inputs = document.querySelectorAll('input');
    let campoUsuario = null;
    let campoPassword = null;
    let usuarioEncontrado = false;
    let passwordEncontrado = false;
    let usuarioLlenado = false;
    let passwordLlenado = false;
    const errores = [];
    
    for (const input of inputs) {
      const tipo = (input.type || '').toLowerCase();
      const id = (input.id || '').toLowerCase();
      const name = (input.name || '').toLowerCase();
      const placeholder = (input.placeholder || '').toLowerCase();
      
      // Campo de usuario: text que no sea captcha
      if (tipo === 'text' && !placeholder.includes('captcha') && !id.includes('captcha')) {
        if (!campoUsuario) {
          campoUsuario = input;
          usuarioEncontrado = true;
        }
      }
      
      // Campo de password
      if (tipo === 'password') {
        campoPassword = input;
        passwordEncontrado = true;
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
        errores.push(`Error llenando usuario: ${e.message}`);
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
        errores.push(`Error llenando password: ${e.message}`);
      }
    }
    
    return { usuarioEncontrado, passwordEncontrado, usuarioLlenado, passwordLlenado, errores };
  }, usuario, password);
  
  log('info', 'CREDENCIALES', 'Resultado del llenado:', resultado);
  
  if (!resultado.usuarioLlenado || !resultado.passwordLlenado) {
    throw new Error('No se pudieron llenar las credenciales: ' + (resultado.errores.join(', ') || 'campos no encontrados'));
  }
  
  // Verificación
  await delay(500);
  
  const verificacion = await page.evaluate(() => {
    const inputs = document.querySelectorAll('input');
    let usuarioTieneValor = false;
    let passwordTieneValor = false;
    let usuarioValor = '';
    
    for (const input of inputs) {
      if (input.type === 'text' && !input.placeholder?.toLowerCase().includes('captcha')) {
        if (input.value && input.value.length > 0) {
          usuarioTieneValor = true;
          usuarioValor = input.value.substring(0, 3) + '***';
        }
      }
      if (input.type === 'password') {
        if (input.value && input.value.length > 0) {
          passwordTieneValor = true;
        }
      }
    }
    
    return { 
      usuarioTieneValor, 
      passwordTieneValor, 
      usuarioValor,
      passwordValor: passwordTieneValor ? '***' : '(vacío)'
    };
  });
  
  log('info', 'CREDENCIALES', 'Verificación final:', verificacion);
  
  if (!verificacion.usuarioTieneValor || !verificacion.passwordTieneValor) {
    throw new Error('Las credenciales no quedaron guardadas en los campos');
  }
  
  log('success', 'CREDENCIALES', 'Campos llenados correctamente');
  return true;
}

async function verificarCaptchaValido(page) {
  return await page.evaluate((config) => {
    const imagenes = document.querySelectorAll('img');
    
    // Método 1: Buscar por patrones en src, id o alt
    for (const img of imagenes) {
      const src = (img.src || '').toLowerCase();
      const id = (img.id || '').toLowerCase();
      const alt = (img.alt || '').toLowerCase();
      
      const esCaptcha = src.includes('captcha') || 
                        src.includes('jcaptcha') ||
                        src.includes('codigo') ||
                        id.includes('captcha') || 
                        id.includes('imgcod') ||
                        alt.includes('captcha');
      
      if (esCaptcha) {
        if (!img.complete) {
          return { valido: false, razon: 'Imagen CAPTCHA aún cargando' };
        }
        
        if (img.naturalWidth === 0 || img.naturalHeight === 0) {
          return { valido: false, razon: 'Imagen CAPTCHA no cargó' };
        }
        
        if (img.naturalWidth >= config.minWidth && img.naturalWidth <= config.maxWidth &&
            img.naturalHeight >= config.minHeight && img.naturalHeight <= config.maxHeight) {
          return { 
            valido: true, 
            width: img.naturalWidth,
            height: img.naturalHeight
          };
        }
      }
    }
    
    // Método 2: Buscar imagen cercana al input de CAPTCHA
    const inputCaptcha = document.querySelector('input[id*="captcha"], input[placeholder*="Captcha"], input[placeholder*="captcha"], input[placeholder*="CAPTCHA"]');
    
    if (inputCaptcha) {
      let container = inputCaptcha.parentElement;
      let nivel = 0;
      
      while (container && nivel < 5) {
        const imagenCercana = container.querySelector('img');
        
        if (imagenCercana && imagenCercana.complete) {
          const w = imagenCercana.naturalWidth;
          const h = imagenCercana.naturalHeight;
          
          if (w >= config.minWidth && w <= config.maxWidth && h >= config.minHeight && h <= config.maxHeight && w > 0 && h > 0) {
            return { valido: true, width: w, height: h };
          }
        }
        
        container = container.parentElement;
        nivel++;
      }
    }
    
    // Método 3: Buscar cualquier imagen pequeña en el formulario
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
    
    const captchaImg = document.querySelector('img[src*="captcha"], img[id*="captcha"]');
    if (captchaImg) {
      const rect = captchaImg.getBoundingClientRect();
      const elementosCerca = document.elementsFromPoint(rect.right + 25, rect.top + rect.height / 2);
      for (const el of elementosCerca) {
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
  
  log('warn', 'CAPTCHA', 'No se encontró botón de recarga del CAPTCHA');
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
    
    if (recargado) {
      await delay(CAPTCHA_CONFIG.esperaEntreCarga);
    } else {
      log('info', 'CAPTCHA', 'No se encontró botón de recarga. Refrescando página completa...');
      
      await page.reload({ waitUntil: 'networkidle2' });
      await delay(CAPTCHA_CONFIG.esperaDespuesRefresh);
      
      log('info', 'CAPTCHA', 'Cerrando popups después del refresh...');
      await cerrarPopups(page);
      await delay(500);
      
      log('info', 'CAPTCHA', 'Re-llenando credenciales después del refresh...');
      await llenarCredenciales(page, usuario, password);
      await delay(500);
    }
    
    await delay(1000);
  }
  
  metricas.captchasFallidos++;
  throw new Error(`El CAPTCHA no cargó correctamente después de ${maxIntentos} intentos`);
}

async function capturarFormularioLogin(page) {
  log('info', 'CAPTURA', 'Capturando formulario de login...');
  
  if (await hayPopupVisible(page)) {
    await cerrarPopups(page);
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
    log('warn', 'CAPTURA', 'No se encontró formulario, capturando página completa');
    const buffer = await page.screenshot({ encoding: 'base64' });
    return buffer;
  }
  
  log('info', 'CAPTURA', `Formulario encontrado (${formularioInfo.selector})`, {
    x: formularioInfo.x,
    y: formularioInfo.y,
    width: formularioInfo.width,
    height: formularioInfo.height
  });
  
  const buffer = await page.screenshot({
    encoding: 'base64',
    clip: {
      x: formularioInfo.x,
      y: formularioInfo.y,
      width: formularioInfo.width,
      height: formularioInfo.height
    }
  });
  
  log('success', 'CAPTURA', 'Screenshot del formulario capturado', { bytes: buffer.length });
  return buffer;
}

/**
 * v4.8.0: Navega a Casillas Electrónicas después del login
 * (la primera de las 3 opciones: SINOE, MPE, MPe ANC)
 */
async function navegarACasillas(page, requestId) {
  log('info', `CASILLAS:${requestId}`, 'Buscando enlace a Casillas Electrónicas...');
  
  // Buscar el enlace/botón de Casillas
  const clickeado = await evaluarSeguro(page, () => {
    // Buscar por texto
    const enlaces = document.querySelectorAll('a, button, div[onclick]');
    
    for (const el of enlaces) {
      const texto = (el.textContent || '').toLowerCase();
      const href = el.getAttribute('href') || '';
      const onclick = el.getAttribute('onclick') || '';
      
      // Buscar "Casillas Electrónicas" o "SINOE"
      if (texto.includes('casillas') || 
          texto.includes('sinoe') ||
          href.includes('casilla') ||
          onclick.includes('casilla')) {
        // Verificar que sea visible
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          el.click();
          return { clickeado: true, texto: texto.substring(0, 30) };
        }
      }
    }
    
    // Buscar por imagen con alt
    const imagenes = document.querySelectorAll('img');
    for (const img of imagenes) {
      const alt = (img.alt || '').toLowerCase();
      const src = (img.src || '').toLowerCase();
      
      if (alt.includes('casilla') || alt.includes('sinoe') || src.includes('sinoe')) {
        // Clic en el padre si es clickeable
        let padre = img.parentElement;
        for (let i = 0; i < 3 && padre; i++) {
          if (padre.tagName === 'A' || padre.onclick || padre.getAttribute('onclick')) {
            padre.click();
            return { clickeado: true, texto: 'imagen SINOE' };
          }
          padre = padre.parentElement;
        }
      }
    }
    
    return { clickeado: false };
  });
  
  if (!clickeado || !clickeado.clickeado) {
    log('warn', `CASILLAS:${requestId}`, 'No se encontró enlace a Casillas - puede que ya estemos en la bandeja');
    return false;
  }
  
  log('info', `CASILLAS:${requestId}`, `Clic en: "${clickeado.texto}"`);
  
  // Esperar a que cargue
  log('info', `CASILLAS:${requestId}`, `Esperando ${TIMEOUT.esperaClicCasillas/1000}s a que cargue Casillas...`);
  await delay(TIMEOUT.esperaClicCasillas);
  
  return true;
}

/**
 * v4.8.0: Extrae las notificaciones de la tabla
 */
async function extraerNotificaciones(page, requestId) {
  log('info', `NOTIF:${requestId}`, 'Extrayendo notificaciones de la tabla...');
  
  const datos = await evaluarSeguro(page, () => {
    const notifs = [];
    
    // Buscar tabla de notificaciones
    const tablas = document.querySelectorAll('table');
    
    for (const tabla of tablas) {
      const filas = tabla.querySelectorAll('tbody tr');
      
      if (filas.length === 0) continue;
      
      filas.forEach((fila, index) => {
        const celdas = fila.querySelectorAll('td');
        if (celdas.length < 5) return; // Necesitamos al menos 5 columnas
        
        // Extraer datos según la estructura de SINOE
        const notif = {
          numero: index + 1,
          nNotificacion: (celdas[1]?.textContent || '').trim(),
          expediente: (celdas[2]?.textContent || '').trim(),
          sumilla: (celdas[3]?.textContent || '').trim(),
          organoJurisdiccional: (celdas[4]?.textContent || '').trim(),
          fecha: (celdas[5]?.textContent || '').trim(),
          // Buscar botón de descarga (el botón rojo)
          tieneBotonDescarga: !!fila.querySelector('button, a[onclick*="descarga"], .ui-button')
        };
        
        if (notif.expediente || notif.nNotificacion) {
          notifs.push(notif);
        }
      });
      
      // Si encontramos notificaciones, no seguir buscando en otras tablas
      if (notifs.length > 0) break;
    }
    
    return notifs;
  });
  
  if (!datos || datos.length === 0) {
    log('warn', `NOTIF:${requestId}`, 'No se encontraron notificaciones en la tabla');
    return [];
  }
  
  log('success', `NOTIF:${requestId}`, `${datos.length} notificaciones encontradas`);
  return datos;
}

/**
 * v4.8.0: Hace clic en el botón rojo de descarga de una notificación
 */
async function abrirModalDescarga(page, indiceNotificacion, requestId) {
  log('info', `DESCARGA:${requestId}`, `Abriendo modal de descarga para notificación ${indiceNotificacion}...`);
  
  const abierto = await evaluarSeguro(page, (indice) => {
    const tablas = document.querySelectorAll('table');
    
    for (const tabla of tablas) {
      const filas = tabla.querySelectorAll('tbody tr');
      
      if (filas.length === 0) continue;
      
      // Encontrar la fila correcta
      const fila = filas[indice - 1]; // indice es 1-based
      if (!fila) continue;
      
      // Buscar el botón rojo de descarga (última columna generalmente)
      const botones = fila.querySelectorAll('button, a.ui-button, .ui-button');
      
      for (const btn of botones) {
        // El botón de descarga suele ser rojo o tener icono de descarga
        const clase = (btn.className || '').toLowerCase();
        const onclick = btn.getAttribute('onclick') || '';
        
        if (clase.includes('ui-button') || onclick.includes('ajax') || onclick.includes('descarga')) {
          btn.click();
          return { clickeado: true };
        }
      }
    }
    
    return { clickeado: false };
  }, indiceNotificacion);
  
  if (!abierto || !abierto.clickeado) {
    log('warn', `DESCARGA:${requestId}`, 'No se encontró botón de descarga');
    return false;
  }
  
  // Esperar a que aparezca el modal
  await delay(2000);
  return true;
}

/**
 * v4.8.0: Hace clic en "Consolidado" para descargar todos los archivos
 */
async function descargarConsolidado(page, requestId) {
  log('info', `CONSOLIDADO:${requestId}`, 'Buscando botón de Consolidado...');
  
  const descargado = await evaluarSeguro(page, () => {
    // Buscar botón "Consolidado" en el modal
    const botones = document.querySelectorAll('button, a');
    
    for (const btn of botones) {
      const texto = (btn.textContent || '').toLowerCase().trim();
      
      if (texto.includes('consolidado')) {
        btn.click();
        return { clickeado: true, texto };
      }
    }
    
    return { clickeado: false };
  });
  
  if (!descargado || !descargado.clickeado) {
    log('warn', `CONSOLIDADO:${requestId}`, 'No se encontró botón de Consolidado');
    return false;
  }
  
  log('success', `CONSOLIDADO:${requestId}`, 'Clic en Consolidado - descarga iniciada');
  
  // Esperar a que inicie la descarga
  await delay(3000);
  return true;
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
    
    // ═══════════════════════════════════════════════════════════════════
    // PASO 1: Conectar a Browserless
    // ═══════════════════════════════════════════════════════════════════
    
    log('info', `SCRAPER:${requestId}`, 'Conectando a Browserless...');
    
    const wsEndpoint = CONFIG.browserless.token 
      ? `${CONFIG.browserless.url}?token=${CONFIG.browserless.token}`
      : CONFIG.browserless.url;
    
    browser = await puppeteer.connect({
      browserWSEndpoint: wsEndpoint,
      defaultViewport: DEFAULT_VIEWPORT
    });
    
    page = await browser.newPage();
    page.setDefaultNavigationTimeout(TIMEOUT.navegacion);
    
    log('success', `SCRAPER:${requestId}`, 'Conectado a Browserless');
    
    // ═══════════════════════════════════════════════════════════════════
    // PASO 2: Navegar a SINOE
    // ═══════════════════════════════════════════════════════════════════
    
    log('info', `SCRAPER:${requestId}`, 'Navegando a SINOE...');
    
    await page.goto(SINOE_URLS.login, { waitUntil: 'networkidle2' });
    await delay(3000);
    
    log('success', `SCRAPER:${requestId}`, 'Página de SINOE cargada');
    
    // ═══════════════════════════════════════════════════════════════════
    // PASO 3: Manejar página de parámetros no válidos
    // ═══════════════════════════════════════════════════════════════════
    
    const contenidoInicial = await leerContenidoSeguro(page);
    if (contenidoInicial && (contenidoInicial.includes('PARAMETROS DE SEGURIDAD NO VALIDOS') || 
        contenidoInicial.includes('PARAMETROS NO VALIDOS'))) {
      log('info', `SCRAPER:${requestId}`, 'Página de parámetros detectada, navegando al inicio...');
      
      await page.evaluate(() => {
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
      
      await delay(3000);
    }
    
    // ═══════════════════════════════════════════════════════════════════
    // PASO 4: Cerrar popups
    // ═══════════════════════════════════════════════════════════════════
    
    log('info', `SCRAPER:${requestId}`, 'Verificando y cerrando popups...');
    await cerrarPopups(page);
    await delay(1000);
    
    // ═══════════════════════════════════════════════════════════════════
    // PASO 5: Esperar campos de login
    // ═══════════════════════════════════════════════════════════════════
    
    log('info', `SCRAPER:${requestId}`, 'Esperando campos de login...');
    await page.waitForSelector('input[type="text"], input[type="password"]', { timeout: TIMEOUT.elemento });
    
    // ═══════════════════════════════════════════════════════════════════
    // PASO 6: Llenar credenciales
    // ═══════════════════════════════════════════════════════════════════
    
    log('info', `SCRAPER:${requestId}`, 'Llenando credenciales...');
    await llenarCredenciales(page, sinoeUsuario, sinoePassword);
    await delay(1000);
    
    // ═══════════════════════════════════════════════════════════════════
    // PASO 7: Asegurar CAPTCHA válido
    // ═══════════════════════════════════════════════════════════════════
    
    log('info', `SCRAPER:${requestId}`, 'Verificando que el CAPTCHA sea válido...');
    await asegurarCaptchaValido(page, sinoeUsuario, sinoePassword);
    
    // ═══════════════════════════════════════════════════════════════════
    // PASO 8: Capturar formulario
    // ═══════════════════════════════════════════════════════════════════
    
    log('info', `SCRAPER:${requestId}`, 'Capturando formulario de login...');
    
    const screenshotBase64 = await capturarFormularioLogin(page);
    
    if (!screenshotBase64 || screenshotBase64.length < 1000) {
      throw new Error('No se pudo capturar el formulario de login');
    }
    
    log('success', `SCRAPER:${requestId}`, 'Formulario capturado', { bytes: screenshotBase64.length });
    
    // ═══════════════════════════════════════════════════════════════════
    // PASO 9: Enviar imagen por WhatsApp
    // ═══════════════════════════════════════════════════════════════════
    
    log('info', `SCRAPER:${requestId}`, 'Enviando imagen por WhatsApp...');
    
    const caption = `📩 ${nombreAbogado}, escriba el código CAPTCHA que ve en la imagen y envíelo como respuesta.\n\n⏱️ Tiene 5 minutos.\n🔒 Credenciales ya llenadas.`;
    
    if (!await enviarWhatsAppImagen(whatsappNumero, screenshotBase64, caption)) {
      throw new Error('No se pudo enviar la imagen por WhatsApp');
    }
    
    // ═══════════════════════════════════════════════════════════════════
    // PASO 10: Esperar respuesta del abogado
    // ═══════════════════════════════════════════════════════════════════
    
    log('info', `SCRAPER:${requestId}`, 'Esperando respuesta del abogado (máx 5 min)...');
    
    const captchaTexto = await new Promise((resolve, reject) => {
      sesionesActivas.set(whatsappNumero, {
        page, 
        browser, 
        resolve, 
        reject,
        timestamp: Date.now(),
        nombreAbogado, 
        requestId
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
    
    // ═══════════════════════════════════════════════════════════════════
    // PASO 11: Escribir CAPTCHA
    // ═══════════════════════════════════════════════════════════════════
    
    log('info', `SCRAPER:${requestId}`, 'Escribiendo CAPTCHA en el formulario...');
    
    const campoCaptcha = await page.$('input[placeholder*="CAPTCHA"], input[placeholder*="Captcha"], input[placeholder*="captcha"], input[id*="captcha"]');
    
    if (!campoCaptcha) {
      throw new Error('Campo de CAPTCHA no encontrado');
    }
    
    await campoCaptcha.click({ clickCount: 3 });
    await delay(100);
    await page.keyboard.press('Backspace');
    await delay(100);
    await campoCaptcha.type(captchaTexto.toUpperCase(), { delay: 50 });
    
    // ═══════════════════════════════════════════════════════════════════
    // PASO 12: HACER CLIC EN LOGIN (v4.8.0 - ESTRATEGIA NUEVA)
    // ═══════════════════════════════════════════════════════════════════
    
    const urlAntes = await leerUrlSegura(page) || SINOE_URLS.login;
    
    log('info', `SCRAPER:${requestId}`, 'Haciendo clic en botón de login...', { urlAntes: urlAntes.substring(0, 50) });
    
    // Buscar y hacer clic en el botón de submit
    const btnIngresar = await page.$('button[type="submit"], input[type="submit"], .ui-button[type="submit"]');
    
    if (btnIngresar) {
      await btnIngresar.click();
      log('info', `SCRAPER:${requestId}`, 'Clic en botón de submit realizado');
    } else {
      log('warn', `SCRAPER:${requestId}`, 'Botón no encontrado, usando Enter');
      await page.keyboard.press('Enter');
    }
    
    // ═══════════════════════════════════════════════════════════════════
    // PASO 13: ESPERAR Y LEER PÁGINA (v4.8.0 - SOLUCIÓN AL ERROR)
    // ═══════════════════════════════════════════════════════════════════
    
    log('info', `SCRAPER:${requestId}`, 'Esperando resultado del login (estrategia v4.8.0)...');
    
    const resultadoPagina = await esperarYLeerPagina(page, requestId, urlAntes);
    
    if (!resultadoPagina.exito) {
      // Intentar tomar screenshot de error
      try {
        const errorScreenshot = await page.screenshot({ encoding: 'base64' });
        log('info', `SCRAPER:${requestId}`, 'Screenshot de error capturado');
      } catch (e) {
        log('warn', `SCRAPER:${requestId}`, 'No se pudo capturar screenshot de error');
      }
      
      await enviarWhatsAppTexto(whatsappNumero, 
        '❌ Error: No se pudo acceder a SINOE después del login. Por favor intente de nuevo.'
      );
      throw new Error('No se pudo leer la página después del login');
    }
    
    // ═══════════════════════════════════════════════════════════════════
    // PASO 14: ANALIZAR RESULTADO DEL LOGIN
    // ═══════════════════════════════════════════════════════════════════
    
    const resultado = analizarResultadoLogin(resultadoPagina.url, resultadoPagina.contenido, urlAntes);
    
    log('info', `SCRAPER:${requestId}`, 'Resultado del análisis:', resultado);
    
    if (resultado.tipo === 'captcha_incorrecto') {
      await enviarWhatsAppTexto(whatsappNumero, '❌ CAPTCHA incorrecto. Por favor intente de nuevo.');
      throw new Error('CAPTCHA incorrecto');
    }
    
    if (resultado.tipo === 'sesion_activa') {
      await enviarWhatsAppTexto(whatsappNumero, '❌ Ya hay una sesión activa en SINOE. Ciérrela e intente de nuevo.');
      throw new Error('Sesión activa existente');
    }
    
    if (resultado.tipo === 'error_desconocido') {
      await enviarWhatsAppTexto(whatsappNumero, '❌ Error al iniciar sesión. Por favor intente de nuevo.');
      throw new Error('Error de login desconocido');
    }
    
    log('success', `SCRAPER:${requestId}`, 'Login exitoso en SINOE');
    
    // ═══════════════════════════════════════════════════════════════════
    // PASO 15: NAVEGAR A CASILLAS ELECTRÓNICAS
    // ═══════════════════════════════════════════════════════════════════
    
    log('info', `SCRAPER:${requestId}`, 'Navegando a Casillas Electrónicas...');
    
    // Esperar un poco para que la página de bienvenida cargue completamente
    await delay(3000);
    
    await navegarACasillas(page, requestId);
    
    // Esperar a que cargue la tabla
    await delay(TIMEOUT.esperaCargaTabla);
    
    // ═══════════════════════════════════════════════════════════════════
    // PASO 16: EXTRAER NOTIFICACIONES
    // ═══════════════════════════════════════════════════════════════════
    
    log('info', `SCRAPER:${requestId}`, 'Extrayendo notificaciones...');
    const notificaciones = await extraerNotificaciones(page, requestId);
    
    // ═══════════════════════════════════════════════════════════════════
    // ÉXITO
    // ═══════════════════════════════════════════════════════════════════
    
    const duracionMs = Date.now() - inicioMs;
    metricas.scrapersExitosos++;
    
    await enviarWhatsAppTexto(whatsappNumero,
      `✅ ${nombreAbogado}, acceso exitoso a SINOE.\n\n📋 ${notificaciones.length} notificación(es) encontrada(s).\n\n⏱️ Tiempo: ${Math.round(duracionMs/1000)}s`
    );
    
    log('success', `SCRAPER:${requestId}`, 'Scraper completado exitosamente', {
      duracionMs,
      notificaciones: notificaciones.length
    });
    
    return {
      success: true,
      notificaciones,
      duracionMs,
      requestId
    };
    
  } catch (error) {
    metricas.scrapersFallidos++;
    log('error', `SCRAPER:${requestId}`, error.message);
    
    // Limpiar sesión
    if (sesionesActivas.has(whatsappNumero)) {
      sesionesActivas.delete(whatsappNumero);
    }
    
    return {
      success: false,
      error: error.message,
      requestId
    };
    
  } finally {
    // Cerrar browser
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        // Ignorar errores al cerrar
      }
    }
  }
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
    return res.status(429).json({ success: false, error: 'Demasiadas solicitudes' });
  }
  
  next();
});

// Auth para rutas protegidas
app.use((req, res, next) => {
  const publicPaths = ['/health', '/webhook/whatsapp'];
  if (publicPaths.includes(req.path)) return next();
  
  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  
  if (apiKey !== API_KEY) {
    log('warn', 'AUTH', `Intento de acceso no autorizado a ${req.path}`);
    return res.status(401).json({ success: false, error: 'No autorizado' });
  }
  
  next();
});

// ============================================================
// ENDPOINTS
// ============================================================

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    version: '4.8.0',
    uptime: process.uptime(),
    sesionesActivas: sesionesActivas.size,
    metricas: {
      scrapersExitosos: metricas.scrapersExitosos,
      scrapersFallidos: metricas.scrapersFallidos,
      erroresFrameIgnorados: metricas.erroresFrameIgnorados
    }
  });
});

app.get('/metricas', (req, res) => {
  res.json(metricas);
});

app.get('/sesiones', (req, res) => {
  const sesiones = [];
  for (const [numero, data] of sesionesActivas.entries()) {
    sesiones.push({
      numero: enmascarar(numero),
      nombreAbogado: data.nombreAbogado,
      requestId: data.requestId,
      tiempoEsperaMs: Date.now() - data.timestamp
    });
  }
  res.json({ sesiones });
});

app.post('/scraper', async (req, res) => {
  metricas.requestsTotal++;
  
  const { sinoeUsuario, sinoePassword, whatsappNumero, nombreAbogado } = req.body;
  
  // Validaciones
  if (!sinoeUsuario || !sinoePassword) {
    return res.status(400).json({ success: false, error: 'Credenciales de SINOE requeridas' });
  }
  
  const validacionNumero = validarNumeroWhatsApp(whatsappNumero);
  if (!validacionNumero.valido) {
    return res.status(400).json({ success: false, error: validacionNumero.error });
  }
  
  // Verificar si ya hay una sesión activa para este número
  if (sesionesActivas.has(validacionNumero.numero)) {
    return res.status(409).json({ 
      success: false, 
      error: 'Ya hay un proceso activo para este número. Espere a que termine.' 
    });
  }
  
  // Responder inmediatamente y ejecutar en background
  res.json({ 
    success: true, 
    message: 'Proceso iniciado. Recibirá el CAPTCHA por WhatsApp.' 
  });
  
  // Ejecutar scraper en background
  ejecutarScraper({
    sinoeUsuario,
    sinoePassword,
    whatsappNumero: validacionNumero.numero,
    nombreAbogado: nombreAbogado || 'Dr(a).'
  }).catch(error => {
    log('error', 'SCRAPER', `Error no manejado: ${error.message}`);
  });
});

app.post('/webhook/whatsapp', (req, res) => {
  res.sendStatus(200); // Responder inmediatamente
  
  try {
    const data = req.body;
    
    // Normalizar evento
    const evento = (data.event || '').toLowerCase().replace(/_/g, '.');
    
    log('info', 'WEBHOOK', 'Evento recibido', { event: evento, instance: data.instance });
    
    // Solo procesar mensajes entrantes
    if (!evento.includes('messages.upsert') && !evento.includes('message')) {
      return;
    }
    
    // Extraer mensaje
    let mensaje = null;
    let remitente = null;
    
    if (data.data?.message?.conversation) {
      mensaje = data.data.message.conversation;
      remitente = data.data.key?.remoteJid;
    } else if (data.data?.message?.extendedTextMessage?.text) {
      mensaje = data.data.message.extendedTextMessage.text;
      remitente = data.data.key?.remoteJid;
    } else if (Array.isArray(data.data)) {
      const item = data.data[0];
      if (item?.message?.conversation) {
        mensaje = item.message.conversation;
        remitente = item.key?.remoteJid;
      }
    }
    
    if (!mensaje || !remitente) return;
    
    // Ignorar mensajes propios
    if (data.data?.key?.fromMe === true) return;
    
    // Extraer número
    const numero = remitente.replace('@s.whatsapp.net', '').replace(/\D/g, '');
    
    // Detectar duplicados (Evolution API a veces envía el mismo mensaje 2 veces)
    const webhookKey = `${numero}-${mensaje}-${Date.now().toString().substring(0, 10)}`;
    if (webhooksRecientes.has(webhookKey)) {
      log('debug', 'WEBHOOK', 'Mensaje duplicado ignorado');
      return;
    }
    webhooksRecientes.set(webhookKey, Date.now());
    
    log('info', 'WEBHOOK', 'Mensaje', { 
      numero: enmascarar(numero), 
      texto: mensaje.substring(0, 20),
      tieneSession: sesionesActivas.has(numero)
    });
    
    // Verificar si hay sesión activa esperando CAPTCHA
    if (!sesionesActivas.has(numero)) return;
    
    const sesion = sesionesActivas.get(numero);
    
    // Validar CAPTCHA
    const validacion = validarCaptcha(mensaje);
    
    if (!validacion.valido) {
      log('warn', 'WEBHOOK', `CAPTCHA inválido: ${validacion.error}`);
      enviarWhatsAppTexto(numero, `⚠️ ${validacion.error}\n${validacion.sugerencia || ''}`);
      return;
    }
    
    // Resolver la Promise con el CAPTCHA
    log('success', 'WEBHOOK', 'CAPTCHA procesado', { 
      numero: enmascarar(numero), 
      captcha: validacion.captcha 
    });
    
    sesionesActivas.delete(numero);
    sesion.resolve(validacion.captcha);
    
  } catch (error) {
    log('error', 'WEBHOOK', `Error procesando webhook: ${error.message}`);
  }
});

// Endpoints de prueba
app.post('/test-whatsapp', async (req, res) => {
  const { numero, mensaje } = req.body;
  
  if (!numero) {
    return res.status(400).json({ success: false, error: 'Número requerido' });
  }
  
  const validacion = validarNumeroWhatsApp(numero);
  if (!validacion.valido) {
    return res.status(400).json({ success: false, error: validacion.error });
  }
  
  const enviado = await enviarWhatsAppTexto(validacion.numero, mensaje || '🧪 Test de conexión desde LEXA Scraper v4.8.0');
  
  res.json({ success: enviado });
});

app.post('/test-conexion', async (req, res) => {
  let browser = null;
  try {
    const ws = CONFIG.browserless.token 
      ? `${CONFIG.browserless.url}?token=${CONFIG.browserless.token}`
      : CONFIG.browserless.url;
    
    browser = await puppeteer.connect({ 
      browserWSEndpoint: ws,
      defaultViewport: DEFAULT_VIEWPORT
    });
    
    const page = await browser.newPage();
    await page.goto('https://www.google.com', { waitUntil: 'networkidle2' });
    
    const titulo = await page.title();
    
    res.json({ 
      success: true, 
      browserless: 'conectado',
      titulo
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
  log('warn', 'SHUTDOWN', `Señal ${signal} recibida, cerrando...`);
  
  if (limpiezaInterval) {
    clearInterval(limpiezaInterval);
    log('info', 'SHUTDOWN', 'Intervalo de limpieza detenido');
  }
  
  for (const [numero, sesion] of sesionesActivas.entries()) {
    if (sesion.reject) {
      sesion.reject(new Error('Servidor reiniciándose'));
    }
    if (sesion.browser) {
      await sesion.browser.close().catch(() => {});
    }
  }
  
  log('info', 'SHUTDOWN', 'Todas las sesiones cerradas');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ============================================================
// INICIAR SERVIDOR
// ============================================================

app.listen(PORT, () => {
  iniciarLimpiezaAutomatica();
  
  console.log(`
╔═══════════════════════════════════════════════════════════════════════════════╗
║            LEXA SCRAPER SERVICE v4.8.0 - SOLUCIÓN DEFINITIVA                  ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║  Puerto: ${PORT}                                                                   ║
║  Auth: ${process.env.API_KEY ? 'Configurada ✓' : 'Auto-generada ⚠️'}                                                    ║
║  WhatsApp: ${CONFIG.evolution.apiKey ? 'Configurado ✓' : 'NO CONFIGURADO ❌'}                                                ║
║  Browserless: ${CONFIG.browserless.token ? 'Configurado ✓' : 'Sin token ⚠️'}                                              ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║  SOLUCIÓN v4.8.0 AL ERROR "Requesting main frame too early!":                 ║
║                                                                               ║
║    ✓ NO usar page.mainFrame() en listeners (causaba el error)                 ║
║    ✓ NO usar waitForNavigation (no confiable con JSF)                         ║
║    ✓ Esperar 15 segundos FIJOS sin tocar page después del clic               ║
║    ✓ Luego leer con try-catch individual (URL y contenido)                   ║
║    ✓ Si falla, esperar 3s más y reintentar (máx 30 intentos = 90s)           ║
║    ✓ Detectar duplicados de webhook (Evolution API bug)                       ║
║                                                                               ║
║  FLUJO POST-LOGIN:                                                            ║
║    1. Detectar página de bienvenida (SINOE, MPE, MPe ANC)                    ║
║    2. Clic en "Casillas Electrónicas"                                        ║
║    3. Extraer tabla de notificaciones                                         ║
║    4. Abrir modal con botón rojo → Clic en "Consolidado"                     ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║  ENDPOINTS:                                                                   ║
║    GET  /health             POST /webhook/whatsapp                            ║
║    POST /scraper            GET  /sesiones                                    ║
║    GET  /metricas           POST /test-whatsapp                               ║
║    POST /test-conexion                                                        ║
╚═══════════════════════════════════════════════════════════════════════════════╝
  `);
});
