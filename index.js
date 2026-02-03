/**
 * ============================================================
 * LEXA SCRAPER SERVICE v4.8.5 - AUDITORÍA COMPLETA
 * ============================================================
 * Versión: PRODUCCIÓN
 * Fecha: Febrero 2026
 * Autor: CTO SINOE Assistant
 * 
 * CAMBIOS v4.8.5 (Auditoría Senior - Reescritura completa):
 * =========================================================
 * 
 * PROBLEMA IDENTIFICADO:
 *   En el HTML de SINOE, el <a> y el texto "Casillas Electrónicas"
 *   son elementos HERMANOS, no padre-hijo:
 *   
 *   <div class="col-xs-4">
 *     <a id="frmNuevo:j_idt38" class="ui-commandlink"></a>  ← Vacío
 *     <div class="bggradient btnservicios">                  ← Texto aquí
 *       Casillas Electrónicas
 *     </div>
 *   </div>
 * 
 * SOLUCIÓN:
 *   Reescrita función navegarACasillas con 5 estrategias:
 *   1. Buscar por ID exacto (#frmNuevo:j_idt38)
 *   2. Buscar por clase ui-commandlink + verificar contexto del padre
 *   3. Buscar por onclick*="submit" + verificar contexto
 *   4. Buscar div .btnservicios con texto y luego hermano <a>
 *   5. Usar primer enlace frmNuevo (último recurso)
 * 
 * MEJORAS DE LOGGING:
 *   - Diagnóstico completo antes de buscar
 *   - Logs descriptivos en cada paso
 *   - Información de debug cuando falla
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
  
  // v4.8.1: Tiempos para sesión activa
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
  // v4.8.1: Métricas de sesión
  sesionesFinalizadas: 0,
  erroresFrameIgnorados: 0,
  reintentosLectura: 0,
  // v4.8.2: Métricas de descarga
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

// v4.8.1: Limpieza mejorada - ahora cancela timeoutId
function iniciarLimpiezaAutomatica() {
  limpiezaInterval = setInterval(() => {
    const ahora = Date.now();
    
    for (const [numero, sesion] of sesionesActivas.entries()) {
      if (ahora - sesion.timestamp > 360000) { // 6 minutos
        log('warn', 'LIMPIEZA', `Sesión expirada: ${enmascarar(numero)}`);
        
        // v4.8.1: Cancelar timeout antes de eliminar
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

/**
 * v4.8.1: Analiza el resultado del login con detección mejorada de sesión activa
 */
function analizarResultadoLogin(url, contenido, urlAntes) {
  const urlLower = url.toLowerCase();
  const contenidoLower = contenido.toLowerCase();
  
  // 1. Error de CAPTCHA
  if (contenidoLower.includes('captcha') && 
      (contenidoLower.includes('incorrecto') || 
       contenidoLower.includes('inválido') ||
       contenidoLower.includes('invalido'))) {
    return { tipo: 'captcha_incorrecto', mensaje: 'CAPTCHA incorrecto' };
  }
  
  // 2. v4.8.1: Sesión activa - detección mejorada
  if (urlLower.includes('session-activa') || 
      urlLower.includes('sso-session-activa') ||
      contenidoLower.includes('sesión activa') ||
      contenidoLower.includes('sesion activa') ||
      contenidoLower.includes('finalizar sesion') ||
      contenidoLower.includes('finalizar sesión')) {
    return { tipo: 'sesion_activa', mensaje: 'Sesión activa detectada' };
  }
  
  // 3. Login exitoso - página de bienvenida con las 3 opciones
  if (contenidoLower.includes('bienvenido') ||
      contenidoLower.includes('casillas electrónicas') ||
      contenidoLower.includes('casillas electronicas') ||
      contenidoLower.includes('mesa de partes electr') ||
      urlLower.includes('login.xhtml') ||
      urlLower.includes('menu-app')) {
    return { tipo: 'login_exitoso', mensaje: 'Login exitoso' };
  }
  
  // 4. Cambió la URL (probable éxito)
  if (url !== urlAntes && !urlLower.includes('sso-validar')) {
    return { tipo: 'login_exitoso', mensaje: 'Login exitoso (URL cambió)' };
  }
  
  // 5. Indeterminado
  if (!contenidoLower.includes('error') && !contenidoLower.includes('invalid')) {
    return { tipo: 'indeterminado', mensaje: 'Resultado indeterminado' };
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
// v4.8.1: MANEJO DE SESIÓN ACTIVA - FUNCIÓN NUEVA
// ============================================================

/**
 * v4.8.1: Maneja la página de sesión activa haciendo clic en FINALIZAR SESIONES
 * 
 * @param {Page} page - Instancia de Puppeteer
 * @param {string} requestId - ID para logging
 * @returns {Promise<boolean>} true si se finalizó exitosamente
 */
async function manejarSesionActiva(page, requestId) {
  log('info', `SESION:${requestId}`, '🔄 Manejando sesión activa...');
  
  // Paso 1: Cerrar cualquier popup (COMUNICADO, etc)
  log('info', `SESION:${requestId}`, 'Cerrando popups previos...');
  await cerrarPopups(page, `SESION:${requestId}`);
  await delay(1000);
  
  // Paso 2: Buscar y hacer clic en "FINALIZAR SESIONES" o "FINALIZAR SESIÓN"
  log('info', `SESION:${requestId}`, 'Buscando botón FINALIZAR SESIONES...');
  
  const clickeado = await evaluarSeguro(page, () => {
    // Buscar por texto en botones y enlaces
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
// FUNCIONES DE SINOE - CREDENCIALES Y CAPTCHA
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
    throw new Error('Credenciales no quedaron en los campos');
  }
  
  log('success', 'CREDENCIALES', 'Campos llenados correctamente');
  return true;
}

async function verificarCaptchaValido(page) {
  return await page.evaluate((config) => {
    const imagenes = document.querySelectorAll('img');
    
    // Método 1: Por patrones en src, id o alt
    for (const img of imagenes) {
      const src = (img.src || '').toLowerCase();
      const id = (img.id || '').toLowerCase();
      const alt = (img.alt || '').toLowerCase();
      
      const esCaptcha = src.includes('captcha') || src.includes('jcaptcha') ||
                        id.includes('captcha') || alt.includes('captcha');
      
      if (esCaptcha) {
        if (!img.complete || img.naturalWidth === 0) {
          return { valido: false, razon: 'Imagen CAPTCHA no cargó' };
        }
        
        if (img.naturalWidth >= config.minWidth && img.naturalWidth <= config.maxWidth &&
            img.naturalHeight >= config.minHeight && img.naturalHeight <= config.maxHeight) {
          return { valido: true, width: img.naturalWidth, height: img.naturalHeight };
        }
      }
    }
    
    // Método 2: Cerca del input de CAPTCHA
    const inputCaptcha = document.querySelector('input[id*="captcha"], input[placeholder*="captcha"], input[placeholder*="CAPTCHA"]');
    
    if (inputCaptcha) {
      let container = inputCaptcha.parentElement;
      let nivel = 0;
      
      while (container && nivel < 5) {
        const img = container.querySelector('img');
        
        if (img && img.complete && img.naturalWidth > 0) {
          if (img.naturalWidth >= 40 && img.naturalWidth <= 200 &&
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
// FUNCIONES DE SINOE - POST-LOGIN
// ============================================================

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * NAVEGACIÓN A CASILLAS ELECTRÓNICAS - v4.8.5
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * ESTRUCTURA HTML DE SINOE (verificada en captura del 03/02/2026):
 * 
 *   <div class="col-xs-4 col-md-4 col-lg-4 form-group">    ← Contenedor
 *     <a id="frmNuevo:j_idt38"                              ← Enlace clickeable (VACÍO)
 *        class="ui-commandlink ui-widget"
 *        onclick="PF('dlgVarBlock').show();PrimeFaces.addSubmitParam(...).submit('frmNuevo');">
 *     </a>
 *     <div class="bggradient btnservicios">                 ← Div con texto (HERMANO)
 *       Casillas Electrónicas
 *     </div>
 *   </div>
 * 
 * IMPORTANTE: El <a> y el <div> con texto son HERMANOS, no padre-hijo.
 * El <a> está VACÍO (sin texto interior).
 * ═══════════════════════════════════════════════════════════════════════════
 */
async function navegarACasillas(page, requestId) {
  log('info', `CASILLAS:${requestId}`, 'Iniciando navegación a Casillas Electrónicas...');
  
  // ═══════════════════════════════════════════════════════════════════════
  // PASO 1: DIAGNÓSTICO - Ver qué hay en la página
  // ═══════════════════════════════════════════════════════════════════════
  
  const diagnostico = await evaluarSeguro(page, () => {
    return {
      url: window.location.href,
      titulo: document.title,
      
      // Contar elementos relevantes
      enlacesCommandlink: document.querySelectorAll('a.ui-commandlink').length,
      enlacesConOnclick: document.querySelectorAll('a[onclick]').length,
      enlacesFrmNuevo: document.querySelectorAll('a[id*="frmNuevo"]').length,
      divsBtnservicios: document.querySelectorAll('.btnservicios').length,
      
      // ¿Existe el texto "Casillas Electrónicas"?
      textoExiste: document.body.innerText.toLowerCase().includes('casillas electr'),
      
      // Primeros 200 caracteres del body (para debug)
      extractoBody: (document.body.innerText || '').substring(0, 200).replace(/\s+/g, ' ')
    };
  });
  
  log('info', `CASILLAS:${requestId}`, 'Diagnóstico:', diagnostico);
  
  // Verificar que estamos en la página correcta
  if (!diagnostico) {
    log('error', `CASILLAS:${requestId}`, 'Error: No se pudo leer la página (evaluarSeguro retornó null)');
    return false;
  }
  
  if (!diagnostico.textoExiste) {
    log('error', `CASILLAS:${requestId}`, 'Error: El texto "Casillas Electrónicas" no existe en la página');
    log('info', `CASILLAS:${requestId}`, 'Extracto de la página:', diagnostico.extractoBody);
    return false;
  }
  
  // ═══════════════════════════════════════════════════════════════════════
  // PASO 2: HACER CLIC EN EL ENLACE CORRECTO
  // ═══════════════════════════════════════════════════════════════════════
  
  const resultado = await evaluarSeguro(page, () => {
    // ─────────────────────────────────────────────────────────────────────
    // ESTRATEGIA 1: Buscar el enlace por ID exacto (frmNuevo:j_idt38)
    // Este es el ID que vimos en el DevTools
    // ─────────────────────────────────────────────────────────────────────
    const enlaceDirecto = document.querySelector('#frmNuevo\\:j_idt38');
    if (enlaceDirecto) {
      enlaceDirecto.click();
      return { exito: true, metodo: 'id_exacto', id: 'frmNuevo:j_idt38' };
    }
    
    // ─────────────────────────────────────────────────────────────────────
    // ESTRATEGIA 2: Buscar enlaces con clase ui-commandlink y verificar contexto
    // ─────────────────────────────────────────────────────────────────────
    const enlacesCommandlink = document.querySelectorAll('a.ui-commandlink');
    
    for (const enlace of enlacesCommandlink) {
      // Subir al contenedor padre
      const padre = enlace.parentElement;
      if (!padre) continue;
      
      // Obtener todo el texto del contenedor (incluye hijos)
      const textoPadre = (padre.innerText || '').toLowerCase();
      
      // Verificar que sea el de Casillas (no Mesa de Partes)
      if (textoPadre.includes('casillas') && 
          textoPadre.includes('electr') && 
          !textoPadre.includes('mesa de partes')) {
        enlace.click();
        return { exito: true, metodo: 'commandlink_contexto', id: enlace.id || 'sin_id' };
      }
    }
    
    // ─────────────────────────────────────────────────────────────────────
    // ESTRATEGIA 3: Buscar cualquier enlace con onclick que haga submit
    // ─────────────────────────────────────────────────────────────────────
    const enlacesSubmit = document.querySelectorAll('a[onclick*="submit"]');
    
    for (const enlace of enlacesSubmit) {
      const padre = enlace.parentElement;
      if (!padre) continue;
      
      const textoPadre = (padre.innerText || '').toLowerCase();
      
      if (textoPadre.includes('casillas')) {
        enlace.click();
        return { exito: true, metodo: 'submit_contexto', id: enlace.id || 'sin_id' };
      }
    }
    
    // ─────────────────────────────────────────────────────────────────────
    // ESTRATEGIA 4: Buscar el div con texto "Casillas" y luego su hermano <a>
    // ─────────────────────────────────────────────────────────────────────
    const divsBtnservicios = document.querySelectorAll('.btnservicios, .bggradient');
    
    for (const div of divsBtnservicios) {
      const textoDiv = (div.innerText || '').toLowerCase();
      
      if (textoDiv.includes('casillas') && textoDiv.includes('electr')) {
        // Buscar enlace hermano anterior
        const hermanoAnterior = div.previousElementSibling;
        if (hermanoAnterior && hermanoAnterior.tagName === 'A') {
          hermanoAnterior.click();
          return { exito: true, metodo: 'hermano_anterior', id: hermanoAnterior.id || 'sin_id' };
        }
        
        // Buscar enlace en el padre
        const padre = div.parentElement;
        if (padre) {
          const enlacePadre = padre.querySelector('a[onclick]');
          if (enlacePadre) {
            enlacePadre.click();
            return { exito: true, metodo: 'enlace_en_padre', id: enlacePadre.id || 'sin_id' };
          }
        }
      }
    }
    
    // ─────────────────────────────────────────────────────────────────────
    // ESTRATEGIA 5 (ÚLTIMO RECURSO): Primer enlace de frmNuevo
    // ─────────────────────────────────────────────────────────────────────
    const primerEnlace = document.querySelector('a[id*="frmNuevo"][onclick]');
    if (primerEnlace) {
      primerEnlace.click();
      return { exito: true, metodo: 'primer_frmnuevo', id: primerEnlace.id };
    }
    
    // No se encontró ningún enlace válido
    return { 
      exito: false, 
      metodo: 'ninguno',
      debug: {
        commandlink: document.querySelectorAll('a.ui-commandlink').length,
        submit: document.querySelectorAll('a[onclick*="submit"]').length,
        btnservicios: document.querySelectorAll('.btnservicios').length
      }
    };
  });
  
  // ═══════════════════════════════════════════════════════════════════════
  // PASO 3: VERIFICAR RESULTADO
  // ═══════════════════════════════════════════════════════════════════════
  
  if (!resultado) {
    log('error', `CASILLAS:${requestId}`, 'Error: evaluarSeguro retornó null (posible error de frame)');
    return false;
  }
  
  if (!resultado.exito) {
    log('error', `CASILLAS:${requestId}`, 'No se encontró el botón de Casillas Electrónicas', resultado.debug);
    return false;
  }
  
  log('success', `CASILLAS:${requestId}`, `✓ Clic realizado (método: ${resultado.metodo}, id: ${resultado.id})`);
  
  // Esperar a que la navegación se complete
  await delay(TIMEOUT.esperaClicCasillas);
  
  return true;
}

async function extraerNotificaciones(page, requestId) {
  log('info', `NOTIF:${requestId}`, 'Extrayendo notificaciones de la tabla...');
  
  // Esperar a que la tabla cargue
  await delay(3000);
  
  const datos = await evaluarSeguro(page, () => {
    const notifs = [];
    
    // Buscar la tabla de notificaciones
    const tabla = document.querySelector('table[role="grid"], .ui-datatable table, table.ui-widget-content');
    
    if (!tabla) {
      return { error: 'No se encontró tabla de notificaciones' };
    }
    
    const filas = tabla.querySelectorAll('tbody tr[role="row"], tbody tr[data-ri]');
    
    filas.forEach((fila, index) => {
      const celdas = fila.querySelectorAll('td');
      if (celdas.length < 5) return;
      
      // Buscar el botón rojo de descarga en la fila
      const botonDescarga = fila.querySelector('button.ui-button, a.ui-button, [class*="ui-button"]');
      
      const notif = {
        index: index,
        nNotificacion: (celdas[1]?.innerText || '').trim(),
        expediente: (celdas[2]?.innerText || '').trim(),
        sumilla: (celdas[3]?.innerText || '').trim(),
        organoJurisdiccional: (celdas[4]?.innerText || '').trim(),
        fecha: (celdas[5]?.innerText || '').trim() || (celdas[6]?.innerText || '').trim(),
        tieneBotonDescarga: !!botonDescarga,
        dataRi: fila.getAttribute('data-ri') || index.toString()
      };
      
      if (notif.expediente || notif.nNotificacion) {
        notifs.push(notif);
      }
    });
    
    return { notificaciones: notifs, total: notifs.length };
  });
  
  if (!datos || datos.error) {
    log('warn', `NOTIF:${requestId}`, datos?.error || 'Error extrayendo notificaciones');
    return [];
  }
  
  log('success', `NOTIF:${requestId}`, `${datos.total} notificaciones encontradas`);
  return datos.notificaciones;
}

/**
 * Hace clic en el botón rojo de una notificación para abrir el modal de anexos
 */
async function abrirModalAnexos(page, requestId, indexFila) {
  log('info', `MODAL:${requestId}`, `Abriendo modal de anexos para fila ${indexFila}...`);
  
  const resultado = await evaluarSeguro(page, (idx) => {
    // Buscar la fila por índice
    const filas = document.querySelectorAll('tbody tr[role="row"], tbody tr[data-ri]');
    
    if (idx >= filas.length) {
      return { exito: false, error: `Fila ${idx} no existe (total: ${filas.length})` };
    }
    
    const fila = filas[idx];
    
    // Buscar el botón de descarga/ver en la fila (el botón rojo)
    // Puede ser: button, a con clase ui-button, o elemento con icono de descarga
    const selectoresBoton = [
      'button.ui-button',
      'a.ui-button', 
      '[class*="ui-button"]',
      'button[onclick]',
      'a[onclick*="dlg"]',
      '.ui-row-toggler',
      'button[id*="btn"]'
    ];
    
    let boton = null;
    for (const selector of selectoresBoton) {
      boton = fila.querySelector(selector);
      if (boton) break;
    }
    
    // Si no encontró con selectores, buscar cualquier botón o enlace en las últimas celdas
    if (!boton) {
      const celdas = fila.querySelectorAll('td');
      for (let i = celdas.length - 1; i >= Math.max(0, celdas.length - 3); i--) {
        boton = celdas[i].querySelector('button, a[onclick], [onclick]');
        if (boton) break;
      }
    }
    
    if (!boton) {
      return { exito: false, error: 'No se encontró botón de descarga en la fila' };
    }
    
    boton.click();
    return { exito: true, texto: boton.innerText || 'botón encontrado' };
  }, indexFila);
  
  if (!resultado || !resultado.exito) {
    log('warn', `MODAL:${requestId}`, resultado?.error || 'Error abriendo modal');
    return false;
  }
  
  log('info', `MODAL:${requestId}`, 'Clic realizado, esperando modal...');
  
  // Esperar a que el modal se abra
  await delay(3000);
  
  // Verificar que el modal esté abierto
  const modalAbierto = await evaluarSeguro(page, () => {
    const modal = document.querySelector('.ui-dialog[aria-hidden="false"], .ui-dialog:not([style*="display: none"]), [role="dialog"]:not([aria-hidden="true"])');
    if (modal) {
      const texto = (modal.innerText || '').toLowerCase();
      return { 
        abierto: true, 
        tieneConsolidado: texto.includes('consolidado'),
        tieneAnexos: texto.includes('anexo') || texto.includes('lista')
      };
    }
    return { abierto: false };
  });
  
  if (!modalAbierto || !modalAbierto.abierto) {
    log('warn', `MODAL:${requestId}`, 'Modal no se abrió');
    return false;
  }
  
  log('success', `MODAL:${requestId}`, 'Modal abierto correctamente', modalAbierto);
  metricas.modalesAbiertos++;
  return true;
}

/**
 * Hace clic en el botón "Consolidado" dentro del modal para descargar el PDF
 */
async function descargarConsolidado(page, requestId) {
  log('info', `DESCARGA:${requestId}`, 'Buscando botón "Consolidado"...');
  
  const resultado = await evaluarSeguro(page, () => {
    // Buscar dentro del modal abierto
    const modal = document.querySelector('.ui-dialog[aria-hidden="false"], .ui-dialog:not([style*="display: none"])');
    
    if (!modal) {
      return { exito: false, error: 'Modal no encontrado' };
    }
    
    // Buscar el botón "Consolidado" - múltiples estrategias
    
    // Estrategia 1: Por ID exacto (visto en el HTML)
    let boton = modal.querySelector('#frmAnexos\\:btnDescargaTodo, [id*="btnDescarga"], [id*="Consolidado"]');
    
    // Estrategia 2: Por texto "Consolidado"
    if (!boton) {
      const botones = modal.querySelectorAll('button, a.ui-button');
      for (const btn of botones) {
        const texto = (btn.innerText || btn.textContent || '').toLowerCase();
        if (texto.includes('consolidado')) {
          boton = btn;
          break;
        }
      }
    }
    
    // Estrategia 3: Por span con texto "Consolidado" dentro de botón
    if (!boton) {
      const spans = modal.querySelectorAll('span.ui-button-text');
      for (const span of spans) {
        if ((span.innerText || '').toLowerCase().includes('consolidado')) {
          boton = span.closest('button') || span.parentElement;
          break;
        }
      }
    }
    
    if (!boton) {
      return { exito: false, error: 'Botón Consolidado no encontrado en el modal' };
    }
    
    boton.click();
    return { exito: true, texto: 'Consolidado' };
  });
  
  if (!resultado || !resultado.exito) {
    log('warn', `DESCARGA:${requestId}`, resultado?.error || 'Error al descargar');
    return false;
  }
  
  log('success', `DESCARGA:${requestId}`, '✓ Clic en "Consolidado" - descarga iniciada');
  
  // Incrementar métrica
  metricas.consolidadosDescargados++;
  
  // Esperar a que la descarga se procese
  await delay(5000);
  
  return true;
}

/**
 * Cierra el modal actual
 */
async function cerrarModal(page, requestId) {
  log('info', `MODAL:${requestId}`, 'Cerrando modal...');
  
  const cerrado = await evaluarSeguro(page, () => {
    // Buscar botón de cerrar en el modal
    const modal = document.querySelector('.ui-dialog[aria-hidden="false"], .ui-dialog:not([style*="display: none"])');
    
    if (!modal) return { exito: true, mensaje: 'No hay modal abierto' };
    
    // Buscar botón X o "Cerrar"
    const botonCerrar = modal.querySelector(
      '.ui-dialog-titlebar-close, ' +
      'button[aria-label="Close"], ' +
      'button.ui-dialog-titlebar-icon, ' +
      'a.ui-dialog-titlebar-icon'
    );
    
    if (botonCerrar) {
      botonCerrar.click();
      return { exito: true, mensaje: 'Clic en X' };
    }
    
    // Buscar botón "Cerrar" por texto
    const botones = modal.querySelectorAll('button');
    for (const btn of botones) {
      if ((btn.innerText || '').toLowerCase().includes('cerrar')) {
        btn.click();
        return { exito: true, mensaje: 'Clic en Cerrar' };
      }
    }
    
    return { exito: false, mensaje: 'No se encontró botón de cerrar' };
  });
  
  await delay(1000);
  
  return cerrado?.exito || false;
}

/**
 * Procesa las primeras N notificaciones descargando sus consolidados
 */
async function procesarNotificaciones(page, requestId, notificaciones, maxDescargas = 3) {
  const resultados = [];
  const total = Math.min(notificaciones.length, maxDescargas);
  
  log('info', `PROCESO:${requestId}`, `Procesando ${total} de ${notificaciones.length} notificaciones...`);
  
  for (let i = 0; i < total; i++) {
    const notif = notificaciones[i];
    log('info', `PROCESO:${requestId}`, `[${i+1}/${total}] Procesando: ${notif.expediente}`);
    
    // 1. Abrir el modal de anexos
    const modalAbierto = await abrirModalAnexos(page, requestId, i);
    
    if (!modalAbierto) {
      log('warn', `PROCESO:${requestId}`, `No se pudo abrir modal para ${notif.expediente}`);
      resultados.push({ expediente: notif.expediente, descargado: false, error: 'Modal no abrió' });
      continue;
    }
    
    // 2. Descargar el consolidado
    const descargado = await descargarConsolidado(page, requestId);
    
    resultados.push({
      expediente: notif.expediente,
      nNotificacion: notif.nNotificacion,
      descargado: descargado,
      fecha: notif.fecha
    });
    
    // 3. Cerrar el modal
    await cerrarModal(page, requestId);
    
    // 4. Esperar antes de la siguiente
    await delay(2000);
  }
  
  const exitosos = resultados.filter(r => r.descargado).length;
  log('success', `PROCESO:${requestId}`, `Procesadas ${exitosos}/${total} notificaciones`);
  
  return resultados;
}

// ============================================================
// FUNCIÓN PRINCIPAL DEL SCRAPER
// ============================================================

async function ejecutarScraper({ sinoeUsuario, sinoePassword, whatsappNumero, nombreAbogado }) {
  let browser = null;
  let page = null;
  const inicioMs = Date.now();
  const requestId = crypto.randomUUID().substring(0, 8);
  let timeoutCaptchaId = null; // v4.8.1: Para poder cancelar el timeout
  
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
    if (contenidoInicial && contenidoInicial.includes('PARAMETROS')) {
      log('info', `SCRAPER:${requestId}`, 'Página de parámetros detectada...');
      
      await page.evaluate(() => {
        const botones = document.querySelectorAll('button, a');
        for (const btn of botones) {
          const texto = (btn.textContent || '').toUpperCase();
          if (texto.includes('INICIO') || texto.includes('IR')) {
            btn.click();
            return;
          }
        }
      });
      
      await delay(3000);
    }
    
    // ═══════════════════════════════════════════════════════════════════
    // PASO 4: Cerrar popups
    // ═══════════════════════════════════════════════════════════════════
    
    await cerrarPopups(page, `SCRAPER:${requestId}`);
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
    
    log('info', `SCRAPER:${requestId}`, 'Verificando CAPTCHA...');
    await asegurarCaptchaValido(page, sinoeUsuario, sinoePassword);
    
    // ═══════════════════════════════════════════════════════════════════
    // PASO 8: Capturar formulario
    // ═══════════════════════════════════════════════════════════════════
    
    log('info', `SCRAPER:${requestId}`, 'Capturando formulario...');
    
    const screenshotBase64 = await capturarFormularioLogin(page);
    
    if (!screenshotBase64 || screenshotBase64.length < 1000) {
      throw new Error('No se pudo capturar el formulario');
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
    // PASO 10: Esperar respuesta del abogado (v4.8.1: con timeout cancelable)
    // ═══════════════════════════════════════════════════════════════════
    
    log('info', `SCRAPER:${requestId}`, 'Esperando respuesta del abogado (máx 5 min)...');
    
    const captchaTexto = await new Promise((resolve, reject) => {
      // v4.8.1: Guardar el timeout ID para poder cancelarlo después
      timeoutCaptchaId = setTimeout(() => {
        if (sesionesActivas.has(whatsappNumero)) {
          const s = sesionesActivas.get(whatsappNumero);
          if (s.requestId === requestId) {
            sesionesActivas.delete(whatsappNumero);
            reject(new Error('Timeout: CAPTCHA no resuelto en 5 minutos'));
          }
        }
      }, TIMEOUT.captcha);
      
      sesionesActivas.set(whatsappNumero, {
        page, 
        browser, 
        resolve, 
        reject,
        timeoutId: timeoutCaptchaId, // v4.8.1: Guardar referencia al timeout
        timestamp: Date.now(),
        nombreAbogado, 
        requestId
      });
    });
    
    // v4.8.1: Cancelar el timeout porque ya se resolvió
    if (timeoutCaptchaId) {
      clearTimeout(timeoutCaptchaId);
      timeoutCaptchaId = null;
    }
    
    metricas.captchasRecibidos++;
    log('success', `SCRAPER:${requestId}`, `CAPTCHA recibido: ${captchaTexto}`);
    
    // ═══════════════════════════════════════════════════════════════════
    // PASO 11: Verificar que el campo CAPTCHA aún existe (v4.8.1)
    // ═══════════════════════════════════════════════════════════════════
    
    log('info', `SCRAPER:${requestId}`, 'Escribiendo CAPTCHA...');
    
    const campoCaptcha = await page.$('input[placeholder*="CAPTCHA"], input[placeholder*="Captcha"], input[placeholder*="captcha"], input[id*="captcha"]');
    
    if (!campoCaptcha) {
      // v4.8.1: Mensaje descriptivo cuando la página expiró
      await enviarWhatsAppTexto(whatsappNumero, '⚠️ La página de SINOE expiró mientras esperaba. Por favor intente de nuevo.');
      throw new Error('Campo CAPTCHA no encontrado - la página pudo haber expirado');
    }
    
    await campoCaptcha.click({ clickCount: 3 });
    await delay(100);
    await page.keyboard.press('Backspace');
    await delay(100);
    await campoCaptcha.type(captchaTexto.toUpperCase(), { delay: 50 });
    
    // ═══════════════════════════════════════════════════════════════════
    // PASO 12: Hacer clic en LOGIN
    // ═══════════════════════════════════════════════════════════════════
    
    const urlAntes = await leerUrlSegura(page) || SINOE_URLS.login;
    
    log('info', `SCRAPER:${requestId}`, 'Haciendo clic en botón de login...');
    
    const btnIngresar = await page.$('button[type="submit"], input[type="submit"], .ui-button[type="submit"]');
    
    if (btnIngresar) {
      await btnIngresar.click();
    } else {
      await page.keyboard.press('Enter');
    }
    
    // ═══════════════════════════════════════════════════════════════════
    // PASO 13: Esperar y leer página
    // ═══════════════════════════════════════════════════════════════════
    
    log('info', `SCRAPER:${requestId}`, 'Esperando resultado...');
    
    const resultadoPagina = await esperarYLeerPagina(page, requestId, urlAntes);
    
    if (!resultadoPagina.exito) {
      await enviarWhatsAppTexto(whatsappNumero, '❌ Error: No se pudo acceder a SINOE. Intente de nuevo.');
      throw new Error('No se pudo leer la página después del login');
    }
    
    // ═══════════════════════════════════════════════════════════════════
    // PASO 14: Analizar resultado y manejar casos especiales
    // ═══════════════════════════════════════════════════════════════════
    
    // Cerrar popups primero (COMUNICADO, etc)
    await cerrarPopups(page, `SCRAPER:${requestId}`);
    await delay(500);
    
    // Volver a leer después de cerrar popups
    const urlActual = await leerUrlSegura(page) || resultadoPagina.url;
    const contenidoActual = await leerContenidoSeguro(page) || resultadoPagina.contenido;
    
    const resultado = analizarResultadoLogin(urlActual, contenidoActual, urlAntes);
    
    log('info', `SCRAPER:${requestId}`, 'Resultado:', resultado);
    
    // ═══════════════════════════════════════════════════════════════════
    // v4.8.1: MANEJO AUTOMÁTICO DE SESIÓN ACTIVA
    // ═══════════════════════════════════════════════════════════════════
    
    if (resultado.tipo === 'sesion_activa') {
      log('warn', `SCRAPER:${requestId}`, '🔄 Sesión activa detectada - finalizando automáticamente...');
      
      await enviarWhatsAppTexto(whatsappNumero, '⏳ Sesión activa detectada. Finalizando automáticamente...');
      
      const sesionFinalizada = await manejarSesionActiva(page, requestId);
      
      if (!sesionFinalizada) {
        await enviarWhatsAppTexto(whatsappNumero, '❌ No se pudo finalizar la sesión anterior. Ciérrela manualmente en SINOE e intente de nuevo.');
        throw new Error('No se pudo finalizar la sesión activa automáticamente');
      }
      
      // ═══════════════════════════════════════════════════════════════════
      // REINTENTAR LOGIN COMPLETO DESPUÉS DE FINALIZAR SESIÓN
      // ═══════════════════════════════════════════════════════════════════
      
      log('info', `SCRAPER:${requestId}`, '🔄 Reintentando login después de finalizar sesión...');
      
      await cerrarPopups(page, `SCRAPER:${requestId}`);
      await delay(1000);
      
      // Esperar campos de login
      await page.waitForSelector('input[type="text"], input[type="password"]', { timeout: TIMEOUT.elemento });
      
      // Llenar credenciales de nuevo
      await llenarCredenciales(page, sinoeUsuario, sinoePassword);
      await delay(1000);
      
      // Verificar CAPTCHA de nuevo
      await asegurarCaptchaValido(page, sinoeUsuario, sinoePassword);
      
      // Capturar y enviar nuevo CAPTCHA
      const nuevoScreenshot = await capturarFormularioLogin(page);
      await enviarWhatsAppImagen(whatsappNumero, nuevoScreenshot, 
        `📩 ${nombreAbogado}, la sesión anterior fue cerrada.\n\nEscriba el NUEVO código CAPTCHA:\n\n⏱️ Tiene 5 minutos.`
      );
      
      // Esperar nuevo CAPTCHA con timeout cancelable
      let nuevoTimeoutId = null;
      const nuevoCaptcha = await new Promise((resolve, reject) => {
        nuevoTimeoutId = setTimeout(() => {
          if (sesionesActivas.has(whatsappNumero)) {
            sesionesActivas.delete(whatsappNumero);
            reject(new Error('Timeout: CAPTCHA no resuelto'));
          }
        }, TIMEOUT.captcha);
        
        sesionesActivas.set(whatsappNumero, {
          page, browser, resolve, reject, 
          timeoutId: nuevoTimeoutId,
          timestamp: Date.now(), 
          nombreAbogado, requestId
        });
      });
      
      // Cancelar timeout
      if (nuevoTimeoutId) clearTimeout(nuevoTimeoutId);
      
      // Escribir nuevo CAPTCHA
      const nuevoCampoCaptcha = await page.$('input[placeholder*="CAPTCHA"], input[placeholder*="Captcha"], input[id*="captcha"]');
      if (nuevoCampoCaptcha) {
        await nuevoCampoCaptcha.click({ clickCount: 3 });
        await page.keyboard.press('Backspace');
        await nuevoCampoCaptcha.type(nuevoCaptcha.toUpperCase(), { delay: 50 });
      }
      
      // Hacer login de nuevo
      const nuevoUrlAntes = await leerUrlSegura(page);
      const nuevoBtn = await page.$('button[type="submit"], input[type="submit"]');
      if (nuevoBtn) await nuevoBtn.click();
      else await page.keyboard.press('Enter');
      
      // Esperar resultado del segundo intento
      const nuevoResultado = await esperarYLeerPagina(page, requestId, nuevoUrlAntes);
      
      if (!nuevoResultado.exito) {
        await enviarWhatsAppTexto(whatsappNumero, '❌ Error en el segundo intento. Por favor intente de nuevo.');
        throw new Error('Fallo en segundo intento después de finalizar sesión');
      }
      
      // Verificar que ahora sí sea login exitoso
      const nuevoAnalisis = analizarResultadoLogin(nuevoResultado.url, nuevoResultado.contenido, nuevoUrlAntes);
      
      if (nuevoAnalisis.tipo !== 'login_exitoso' && nuevoAnalisis.tipo !== 'indeterminado') {
        await enviarWhatsAppTexto(whatsappNumero, `❌ ${nuevoAnalisis.mensaje}. Intente de nuevo.`);
        throw new Error(`Error en segundo intento: ${nuevoAnalisis.mensaje}`);
      }
      
      log('success', `SCRAPER:${requestId}`, 'Login exitoso en segundo intento');
    }
    
    // ═══════════════════════════════════════════════════════════════════
    // MANEJAR OTROS TIPOS DE RESULTADO
    // ═══════════════════════════════════════════════════════════════════
    
    if (resultado.tipo === 'captcha_incorrecto') {
      await enviarWhatsAppTexto(whatsappNumero, '❌ CAPTCHA incorrecto. Intente de nuevo.');
      throw new Error('CAPTCHA incorrecto');
    }
    
    if (resultado.tipo === 'error_desconocido') {
      await enviarWhatsAppTexto(whatsappNumero, '❌ Error al iniciar sesión. Intente de nuevo.');
      throw new Error('Error de login desconocido');
    }
    
    log('success', `SCRAPER:${requestId}`, 'Login exitoso en SINOE');
    
    // ═══════════════════════════════════════════════════════════════════
    // PASO 15: Navegar a Casillas Electrónicas
    // ═══════════════════════════════════════════════════════════════════
    
    log('info', `SCRAPER:${requestId}`, 'Navegando a Casillas Electrónicas...');
    await delay(3000);
    
    const navegoACasillas = await navegarACasillas(page, requestId);
    
    if (!navegoACasillas) {
      await enviarWhatsAppTexto(whatsappNumero, 
        `⚠️ ${nombreAbogado}, login exitoso pero no se pudo acceder a Casillas Electrónicas.`
      );
      throw new Error('No se pudo navegar a Casillas Electrónicas');
    }
    
    // Esperar a que cargue la tabla de notificaciones
    await delay(TIMEOUT.esperaCargaTabla);
    
    // ═══════════════════════════════════════════════════════════════════
    // PASO 16: Extraer notificaciones
    // ═══════════════════════════════════════════════════════════════════
    
    log('info', `SCRAPER:${requestId}`, 'Extrayendo lista de notificaciones...');
    const notificaciones = await extraerNotificaciones(page, requestId);
    
    if (notificaciones.length === 0) {
      await enviarWhatsAppTexto(whatsappNumero,
        `✅ ${nombreAbogado}, acceso exitoso a SINOE.\n\n📋 No hay notificaciones pendientes.`
      );
      
      const duracionMs = Date.now() - inicioMs;
      metricas.scrapersExitosos++;
      
      return { success: true, notificaciones: [], duracionMs, requestId };
    }
    
    // Notificar al usuario que se encontraron notificaciones
    await enviarWhatsAppTexto(whatsappNumero,
      `📋 ${nombreAbogado}, se encontraron ${notificaciones.length} notificación(es).\n\n⏳ Descargando consolidados de las primeras 3...`
    );
    
    // ═══════════════════════════════════════════════════════════════════
    // PASO 17: Procesar notificaciones (descargar consolidados)
    // ═══════════════════════════════════════════════════════════════════
    
    log('info', `SCRAPER:${requestId}`, 'Procesando notificaciones...');
    const resultadosDescarga = await procesarNotificaciones(page, requestId, notificaciones, 3);
    
    const descargasExitosas = resultadosDescarga.filter(r => r.descargado).length;
    
    // ═══════════════════════════════════════════════════════════════════
    // ÉXITO
    // ═══════════════════════════════════════════════════════════════════
    
    const duracionMs = Date.now() - inicioMs;
    metricas.scrapersExitosos++;
    
    // Actualizar promedio
    const totalExitosos = metricas.scrapersExitosos;
    metricas.tiempoPromedioMs = Math.round(
      ((metricas.tiempoPromedioMs * (totalExitosos - 1)) + duracionMs) / totalExitosos
    );
    
    // Construir mensaje de resumen
    let resumen = `✅ ${nombreAbogado}, proceso completado.\n\n`;
    resumen += `📋 ${notificaciones.length} notificación(es) encontrada(s)\n`;
    resumen += `📥 ${descargasExitosas} consolidado(s) descargado(s)\n`;
    resumen += `⏱️ Tiempo: ${Math.round(duracionMs/1000)}s\n\n`;
    
    if (descargasExitosas > 0) {
      resumen += `📄 Expedientes procesados:\n`;
      resultadosDescarga.forEach((r, i) => {
        const estado = r.descargado ? '✓' : '✗';
        resumen += `${estado} ${r.expediente}\n`;
      });
    }
    
    await enviarWhatsAppTexto(whatsappNumero, resumen);
    
    log('success', `SCRAPER:${requestId}`, 'Scraper completado', { 
      duracionMs, 
      notificaciones: notificaciones.length,
      descargasExitosas 
    });
    
    return { 
      success: true, 
      notificaciones, 
      descargas: resultadosDescarga,
      duracionMs, 
      requestId 
    };
    
  } catch (error) {
    metricas.scrapersFallidos++;
    log('error', `SCRAPER:${requestId}`, error.message);
    
    // v4.8.1: Limpiar timeout si existe
    if (timeoutCaptchaId) {
      clearTimeout(timeoutCaptchaId);
    }
    
    // Limpiar sesión
    if (sesionesActivas.has(whatsappNumero)) {
      const s = sesionesActivas.get(whatsappNumero);
      if (s.timeoutId) clearTimeout(s.timeoutId);
      sesionesActivas.delete(whatsappNumero);
    }
    
    return { success: false, error: error.message, requestId };
    
  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) {}
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
    log('warn', 'AUTH', `Acceso no autorizado a ${req.path}`);
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
    version: '4.8.5',
    uptime: process.uptime(),
    sesionesActivas: sesionesActivas.size,
    metricas: {
      scrapersExitosos: metricas.scrapersExitosos,
      scrapersFallidos: metricas.scrapersFallidos,
      sesionesFinalizadas: metricas.sesionesFinalizadas,
      consolidadosDescargados: metricas.consolidadosDescargados,
      modalesAbiertos: metricas.modalesAbiertos,
      erroresFrameIgnorados: metricas.erroresFrameIgnorados,
      tiempoPromedioMs: metricas.tiempoPromedioMs
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
  
  if (!sinoeUsuario || !sinoePassword) {
    return res.status(400).json({ success: false, error: 'Credenciales requeridas' });
  }
  
  const validacion = validarNumeroWhatsApp(whatsappNumero);
  if (!validacion.valido) {
    return res.status(400).json({ success: false, error: validacion.error });
  }
  
  if (sesionesActivas.has(validacion.numero)) {
    return res.status(409).json({ success: false, error: 'Ya hay un proceso activo para este número' });
  }
  
  res.json({ success: true, message: 'Proceso iniciado' });
  
  ejecutarScraper({
    sinoeUsuario,
    sinoePassword,
    whatsappNumero: validacion.numero,
    nombreAbogado: nombreAbogado || 'Dr(a).'
  }).catch(error => {
    log('error', 'SCRAPER', `Error no manejado: ${error.message}`);
  });
});

app.post('/webhook/whatsapp', (req, res) => {
  res.sendStatus(200);
  
  try {
    const data = req.body;
    const evento = (data.event || '').toLowerCase().replace(/_/g, '.');
    
    log('info', 'WEBHOOK', 'Evento recibido', { event: evento, instance: data.instance });
    
    if (!evento.includes('messages.upsert') && !evento.includes('message')) return;
    
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
    if (data.data?.key?.fromMe === true) return;
    
    const numero = remitente.replace('@s.whatsapp.net', '').replace(/\D/g, '');
    
    // Detectar duplicados
    const webhookKey = `${numero}-${mensaje}-${Date.now().toString().substring(0, 10)}`;
    if (webhooksRecientes.has(webhookKey)) {
      log('debug', 'WEBHOOK', 'Mensaje duplicado ignorado');
      return;
    }
    webhooksRecientes.set(webhookKey, Date.now());
    
    log('info', 'WEBHOOK', 'Mensaje', { numero: enmascarar(numero), texto: mensaje.substring(0, 20) });
    
    if (!sesionesActivas.has(numero)) {
      log('debug', 'WEBHOOK', 'No hay sesión activa para este número');
      return;
    }
    
    const sesion = sesionesActivas.get(numero);
    const validacion = validarCaptcha(mensaje);
    
    if (!validacion.valido) {
      enviarWhatsAppTexto(numero, `⚠️ ${validacion.error}\n${validacion.sugerencia || ''}`);
      return;
    }
    
    log('success', 'WEBHOOK', 'CAPTCHA procesado', { numero: enmascarar(numero), captcha: validacion.captcha });
    
    // v4.8.1: Limpiar timeout antes de resolver
    if (sesion.timeoutId) {
      clearTimeout(sesion.timeoutId);
    }
    
    sesionesActivas.delete(numero);
    sesion.resolve(validacion.captcha);
    
  } catch (error) {
    log('error', 'WEBHOOK', `Error: ${error.message}`);
  }
});

// v4.8.1: Endpoints de debug restaurados
app.post('/test-whatsapp', async (req, res) => {
  const { numero, mensaje } = req.body;
  
  if (!numero) return res.status(400).json({ success: false, error: 'Número requerido' });
  
  const validacion = validarNumeroWhatsApp(numero);
  if (!validacion.valido) return res.status(400).json({ success: false, error: validacion.error });
  
  const enviado = await enviarWhatsAppTexto(validacion.numero, mensaje || '🧪 Test LEXA Scraper v4.8.1');
  res.json({ success: enviado });
});

app.post('/test-conexion', async (req, res) => {
  let browser = null;
  try {
    const ws = CONFIG.browserless.token 
      ? `${CONFIG.browserless.url}?token=${CONFIG.browserless.token}`
      : CONFIG.browserless.url;
    
    browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: DEFAULT_VIEWPORT });
    const page = await browser.newPage();
    await page.goto('https://www.google.com', { waitUntil: 'networkidle2', timeout: 30000 });
    const titulo = await page.title();
    
    res.json({ success: true, browserless: 'ok', titulo });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

// v4.8.1: Test de credenciales restaurado
app.post('/test-credenciales', async (req, res) => {
  const { usuario, password } = req.body;
  let browser = null;
  
  try {
    const ws = CONFIG.browserless.token 
      ? `${CONFIG.browserless.url}?token=${CONFIG.browserless.token}`
      : CONFIG.browserless.url;
    
    browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: DEFAULT_VIEWPORT });
    const page = await browser.newPage();
    
    await page.goto(SINOE_URLS.login, { waitUntil: 'networkidle2', timeout: TIMEOUT.navegacion });
    await delay(3000);
    await cerrarPopups(page, 'TEST');
    await delay(1000);
    
    await llenarCredenciales(page, usuario || 'TEST_USER', password || 'TEST_PASS');
    
    const verificacion = await page.evaluate(() => {
      const inputs = document.querySelectorAll('input');
      let user = '', pass = '';
      
      for (const input of inputs) {
        if (input.type === 'text' && !input.placeholder?.toLowerCase().includes('captcha')) {
          user = input.value;
        }
        if (input.type === 'password') {
          pass = input.value ? '***' : '(vacío)';
        }
      }
      
      return { usuario: user, password: pass };
    });
    
    const captcha = await verificarCaptchaValido(page);
    
    res.json({ 
      success: true, 
      credenciales: {
        usuario: verificacion.usuario.substring(0, 5) + '...',
        password: verificacion.password
      },
      captcha 
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

// v4.8.2: Test de CAPTCHA restaurado
app.post('/test-captcha', async (req, res) => {
  let browser = null;
  
  try {
    const ws = CONFIG.browserless.token 
      ? `${CONFIG.browserless.url}?token=${CONFIG.browserless.token}`
      : CONFIG.browserless.url;
    
    browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: DEFAULT_VIEWPORT });
    const page = await browser.newPage();
    
    await page.goto(SINOE_URLS.login, { waitUntil: 'networkidle2', timeout: TIMEOUT.navegacion });
    await delay(3000);
    await cerrarPopups(page, 'TEST-CAPTCHA');
    await delay(1000);
    
    const estadoCaptcha = await verificarCaptchaValido(page);
    
    let screenshot = null;
    if (estadoCaptcha.valido) {
      screenshot = await capturarFormularioLogin(page);
    }
    
    res.json({ 
      success: true, 
      captcha: estadoCaptcha,
      screenshotSize: screenshot ? screenshot.length : 0
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

// v4.8.2: DEBUG - Capturar página post-login para analizar estructura
app.post('/debug-post-login', async (req, res) => {
  const { usuario, password, captcha } = req.body;
  let browser = null;
  
  if (!usuario || !password || !captcha) {
    return res.status(400).json({ 
      success: false, 
      error: 'Requiere: usuario, password, captcha' 
    });
  }
  
  try {
    const ws = CONFIG.browserless.token 
      ? `${CONFIG.browserless.url}?token=${CONFIG.browserless.token}`
      : CONFIG.browserless.url;
    
    browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: DEFAULT_VIEWPORT });
    const page = await browser.newPage();
    
    // Navegar a SINOE
    await page.goto(SINOE_URLS.login, { waitUntil: 'networkidle2', timeout: TIMEOUT.navegacion });
    await delay(3000);
    await cerrarPopups(page, 'DEBUG');
    await delay(1000);
    
    // Llenar credenciales
    await llenarCredenciales(page, usuario, password);
    await delay(1000);
    
    // Escribir CAPTCHA proporcionado
    const campoCaptcha = await page.$('input[placeholder*="CAPTCHA"], input[placeholder*="Captcha"], input[id*="captcha"]');
    if (campoCaptcha) {
      await campoCaptcha.click({ clickCount: 3 });
      await page.keyboard.press('Backspace');
      await campoCaptcha.type(captcha.toUpperCase(), { delay: 50 });
    }
    
    // Hacer login
    const btnLogin = await page.$('button[type="submit"], input[type="submit"]');
    if (btnLogin) await btnLogin.click();
    else await page.keyboard.press('Enter');
    
    // Esperar
    await delay(15000);
    
    // Cerrar popups
    await cerrarPopups(page, 'DEBUG');
    await delay(1000);
    
    // Capturar información de la página
    const urlActual = page.url();
    const contenidoHTML = await page.content();
    const screenshot = await page.screenshot({ encoding: 'base64', fullPage: true });
    
    // Analizar estructura de la página
    const analisis = await page.evaluate(() => {
      const resultado = {
        enlaces: [],
        imagenes: [],
        paneles: [],
        botones: [],
        textoCompleto: document.body.innerText.substring(0, 2000)
      };
      
      // Todos los enlaces
      document.querySelectorAll('a').forEach(a => {
        resultado.enlaces.push({
          texto: (a.innerText || a.textContent || '').trim().substring(0, 100),
          href: a.getAttribute('href') || '',
          visible: a.offsetWidth > 0 && a.offsetHeight > 0
        });
      });
      
      // Todas las imágenes
      document.querySelectorAll('img').forEach(img => {
        resultado.imagenes.push({
          src: img.src.substring(img.src.lastIndexOf('/') + 1),
          alt: img.alt || '',
          width: img.naturalWidth,
          height: img.naturalHeight
        });
      });
      
      // Paneles/divs con clase panel
      document.querySelectorAll('[class*="panel"], [class*="card"], [class*="menu"]').forEach(p => {
        resultado.paneles.push({
          clase: p.className,
          texto: (p.innerText || '').substring(0, 100)
        });
      });
      
      // Botones
      document.querySelectorAll('button, input[type="button"], input[type="submit"]').forEach(b => {
        resultado.botones.push({
          texto: (b.innerText || b.value || '').trim(),
          tipo: b.type || b.tagName
        });
      });
      
      return resultado;
    });
    
    res.json({ 
      success: true,
      url: urlActual,
      analisis,
      htmlLength: contenidoHTML.length,
      screenshot: screenshot.substring(0, 1000) + '...(truncado)'
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
  
  if (limpiezaInterval) clearInterval(limpiezaInterval);
  
  // Limpiar todas las sesiones
  for (const [numero, sesion] of sesionesActivas.entries()) {
    if (sesion.timeoutId) clearTimeout(sesion.timeoutId);
    if (sesion.reject) sesion.reject(new Error('Servidor reiniciándose'));
    if (sesion.browser) await sesion.browser.close().catch(() => {});
  }
  
  sesionesActivas.clear();
  
  log('info', 'SHUTDOWN', 'Sesiones cerradas');
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
║              LEXA SCRAPER SERVICE v4.8.5 - AUDITORÍA COMPLETA                 ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║  Puerto: ${String(PORT).padEnd(70)}║
║  Auth: ${(process.env.API_KEY ? 'Configurada ✓' : 'Auto-generada ⚠️').padEnd(71)}║
║  WhatsApp: ${(CONFIG.evolution.apiKey ? 'Configurado ✓' : 'NO CONFIGURADO ❌').padEnd(67)}║
║  Browserless: ${(CONFIG.browserless.token ? 'Configurado ✓' : 'Sin token ⚠️').padEnd(64)}║
╠═══════════════════════════════════════════════════════════════════════════════╣
║  CAMBIOS v4.8.5 (Auditoría Senior):                                           ║
║                                                                               ║
║    ✓ Reescrita función navegarACasillas desde cero                            ║
║    ✓ 5 estrategias de búsqueda con fallbacks                                  ║
║    ✓ Diagnóstico detallado antes de buscar                                    ║
║    ✓ Logs descriptivos en cada paso                                           ║
║    ✓ Manejo robusto de errores                                                ║
║                                                                               ║
║  ESTRATEGIAS DE BÚSQUEDA (en orden):                                          ║
║    1. ID exacto: #frmNuevo:j_idt38                                            ║
║    2. Clase ui-commandlink + contexto padre                                   ║
║    3. Atributo onclick*="submit" + contexto                                   ║
║    4. Div .btnservicios + hermano <a> anterior                                ║
║    5. Primer enlace frmNuevo (último recurso)                                 ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║  ENDPOINTS:                                                                   ║
║    GET  /health    POST /scraper    GET  /metricas    GET /sesiones           ║
║    POST /webhook/whatsapp    POST /test-whatsapp    POST /test-conexion       ║
╚═══════════════════════════════════════════════════════════════════════════════╝
  `);
  
  // Log API key si fue auto-generada
  if (!process.env.API_KEY) {
    console.log(`\n⚠️  API_KEY auto-generada: ${API_KEY}`);
    console.log('   Configura API_KEY en variables de entorno para producción.\n');
  }
});
