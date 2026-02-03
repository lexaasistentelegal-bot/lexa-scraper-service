/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║                                                                           ║
 * ║   LEXA SCRAPER SERVICE v4.6.8 - Session Handler & Memory Fixes            ║
 * ║   Versión: AAA (Producción - Auditoría Completa)                          ║
 * ║   Fecha: Febrero 2026                                                     ║
 * ║                                                                           ║
 * ╠═══════════════════════════════════════════════════════════════════════════╣
 * ║                                                                           ║
 * ║   DESCRIPCIÓN:                                                            ║
 * ║   Servicio de scraping automatizado para el sistema SINOE del Poder       ║
 * ║   Judicial del Perú. Permite a abogados resolver el CAPTCHA vía           ║
 * ║   WhatsApp y extraer notificaciones judiciales automáticamente.           ║
 * ║                                                                           ║
 * ╠═══════════════════════════════════════════════════════════════════════════╣
 * ║                                                                           ║
 * ║   CHANGELOG v4.6.8 (Session Handler & Memory Fixes):                      ║
 * ║                                                                           ║
 * ║   [CRÍTICO] Nuevas correcciones:                                          ║
 * ║   - NUEVO: manejarSesionActiva() - clic automático en FINALIZAR SESIONES  ║
 * ║   - FIX: setTimeout de CAPTCHA ahora se CANCELA cuando se resuelve        ║
 * ║   - FIX: analizarResultadoLogin() ahora analiza contenido + URL           ║
 * ║   - FIX: Sesión activa se intenta cerrar automáticamente antes de fallar  ║
 * ║   - FIX: Timeout almacenado en sesión para poder cancelarlo               ║
 * ║                                                                           ║
 * ║   [HEREDADO] De v4.6.7:                                                   ║
 * ║   - waitForNavigation() eliminado en PASO 3                               ║
 * ║   - setDefaultNavigationTimeout → setDefaultTimeout                       ║
 * ║   - page.url() → obtenerUrlSegura() pre-login                             ║
 * ║   - Verificación explícita de analisis.exitoso                            ║
 * ║   - Race condition en webhook solucionado                                 ║
 * ║   - API Key enmascarada en logs                                           ║
 * ║                                                                           ║
 * ║   [HEREDADO] De v4.6.6:                                                   ║
 * ║   - evaluarSeguro() - wrapper seguro para page.evaluate()                 ║
 * ║   - esperarFrameConPolling() - polling agresivo (60s máx)                 ║
 * ║   - Si frame roto persistente → crear NUEVA página y navegar              ║
 * ║                                                                           ║
 * ╠═══════════════════════════════════════════════════════════════════════════╣
 * ║                                                                           ║
 * ║   ENDPOINTS:                                                              ║
 * ║   - GET  /health            Estado del servicio                           ║
 * ║   - POST /scraper           Iniciar scraping (requiere API Key)           ║
 * ║   - POST /webhook/whatsapp  Recibir CAPTCHA del abogado (público)         ║
 * ║   - GET  /sesiones          Listar sesiones activas                       ║
 * ║   - GET  /metricas          Métricas detalladas del servicio              ║
 * ║   - POST /test-whatsapp     Probar envío de WhatsApp                      ║
 * ║   - POST /test-conexion     Probar conexión a Browserless                 ║
 * ║   - POST /test-credenciales Probar llenado de credenciales                ║
 * ║   - POST /test-captcha      Diagnosticar detección de CAPTCHA             ║
 * ║                                                                           ║
 * ╠═══════════════════════════════════════════════════════════════════════════╣
 * ║                                                                           ║
 * ║   VARIABLES DE ENTORNO REQUERIDAS:                                        ║
 * ║   - API_KEY              Clave para autenticar requests                   ║
 * ║   - EVOLUTION_API_KEY    API Key de Evolution API                         ║
 * ║   - EVOLUTION_URL        URL de Evolution API                             ║
 * ║   - EVOLUTION_INSTANCE   Nombre de instancia (default: lexa-bot)          ║
 * ║   - BROWSERLESS_URL      URL WebSocket de Browserless                     ║
 * ║   - BROWSERLESS_TOKEN    Token de autenticación Browserless               ║
 * ║                                                                           ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */

const express = require('express');
const puppeteer = require('puppeteer-core');
const crypto = require('crypto');

const app = express();

// ============================================================================
// CONFIGURACIÓN Y CONSTANTES
// ============================================================================

const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY || crypto.randomUUID();

/**
 * URLs del sistema SINOE
 */
const SINOE_URLS = {
  login: 'https://casillas.pj.gob.pe/sinoe/sso-validar.xhtml',
  sessionActiva: 'sso-session-activa',
  dashboard: 'login.xhtml',
  bandeja: 'sso-menu-app.xhtml',
  menuApp: 'https://casillas.pj.gob.pe/sinoe/sso-menu-app.xhtml',
  casillas: 'https://casillas.pj.gob.pe/sinoe/'
};

/**
 * Timeouts para diferentes operaciones (en milisegundos)
 */
const TIMEOUT = {
  navegacion: 60000,      // 1 minuto para cargar páginas
  captcha: 300000,        // 5 minutos para que el abogado resuelva el CAPTCHA
  api: 30000,             // 30 segundos para llamadas a APIs externas
  popup: 10000,           // 10 segundos para cerrar popups
  elemento: 15000,        // 15 segundos para esperar elementos en el DOM
  imagenCarga: 5000,      // 5 segundos para que cargue una imagen
  frameListo: 15000,      // 15 segundos para que el frame esté listo
  postLogin: 60000        // 60 segundos total para fase post-login
};

/**
 * Configuración de servicios externos
 */
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

/**
 * Configuración de rate limiting
 */
const RATE_LIMIT = {
  windowMs: 60000,        // Ventana de 1 minuto
  maxRequestsPerIp: 30    // Máximo 30 requests por IP por minuto
};

/**
 * Configuración de validación y recarga de CAPTCHA
 */
const CAPTCHA_CONFIG = {
  maxIntentos: 5,           // Máximo intentos para obtener CAPTCHA válido
  minWidth: 80,             // Ancho mínimo esperado de imagen CAPTCHA
  maxWidth: 200,            // Ancho máximo esperado de imagen CAPTCHA
  minHeight: 25,            // Alto mínimo esperado de imagen CAPTCHA
  maxHeight: 60,            // Alto máximo esperado de imagen CAPTCHA
  esperaEntreCarga: 2000,   // Espera después de recargar CAPTCHA (ms)
  esperaDespuesRefresh: 3000 // Espera después de refresh de página (ms)
};

/**
 * v4.6.6: Configuración de recuperación de frame post-login
 * Esta es la parte crítica que soluciona "Requesting main frame too early!"
 */
const FRAME_RECOVERY = {
  maxIntentosPoll: 30,      // Máximo intentos de polling (30 * 2s = 60s)
  intervaloPoll: 2000,      // Intervalo entre intentos de polling (ms)
  esperaPostClic: 1000,     // Espera después del clic antes de empezar polling
  esperaEntreRecuperaciones: 2000, // Espera entre intentos de recuperación
  
  // URLs que indican login exitoso
  urlsExitoLogin: [
    'sso-menu-app',
    'menu-app',
    'bandeja',
    'casilla',
    'inicio'
  ],
  
  // URLs que indican error de login
  urlsErrorLogin: [
    'sso-session-activa',
    'session-activa',
    'error'
  ]
};

/**
 * Viewport por defecto para el navegador
 */
const DEFAULT_VIEWPORT = {
  width: 1366,
  height: 768
};

// ============================================================================
// VALIDACIÓN DE CONFIGURACIÓN
// ============================================================================

/**
 * Valida que las variables de entorno críticas estén configuradas
 * @returns {string[]} Lista de warnings si hay problemas de configuración
 */
function validarConfiguracion() {
  const warnings = [];
  
  if (!CONFIG.evolution.apiKey) {
    warnings.push('EVOLUTION_API_KEY no configurada - WhatsApp no funcionará');
  }
  
  if (!CONFIG.browserless.token) {
    warnings.push('BROWSERLESS_TOKEN no configurada - conexión puede fallar');
  }
  
  if (!process.env.API_KEY) {
    warnings.push('API_KEY no configurada - se generó una automáticamente');
  }
  
  return warnings;
}

// ============================================================================
// MÉTRICAS DEL SERVICIO
// ============================================================================

/**
 * Objeto global de métricas para monitoreo y debugging
 */
const metricas = {
  requestsTotal: 0,
  scrapersIniciados: 0,
  scrapersExitosos: 0,
  scrapersFallidos: 0,
  captchasRecibidos: 0,
  captchasRecargados: 0,
  captchasFallidos: 0,
  frameRetries: 0,          // v4.6.6: Reintentos de acceso al frame
  frameRecoveries: 0,       // v4.6.6: Recuperaciones exitosas del frame
  newPageCreations: 0,      // v4.6.6: Veces que se creó nueva página
  sesionesActivasCerradas: 0, // v4.6.8: Veces que se cerró sesión activa automáticamente
  tiempoPromedioMs: 0,
  ultimoReinicio: new Date().toISOString()
};

// ============================================================================
// ALMACENAMIENTO EN MEMORIA
// ============================================================================

/**
 * Map de sesiones activas: número WhatsApp → datos de sesión
 */
const sesionesActivas = new Map();

/**
 * Cache de rate limiting: IP → { count, timestamp }
 */
const rateLimitCache = new Map();

/**
 * Referencia al intervalo de limpieza automática
 */
let limpiezaInterval = null;

/**
 * Inicia el proceso de limpieza automática de sesiones expiradas
 * Se ejecuta cada 60 segundos
 */
function iniciarLimpiezaAutomatica() {
  limpiezaInterval = setInterval(() => {
    const ahora = Date.now();
    
    // Limpiar sesiones expiradas (más de 6 minutos)
    for (const [numero, sesion] of sesionesActivas.entries()) {
      if (ahora - sesion.timestamp > 360000) {
        log('warn', 'LIMPIEZA', `Sesión expirada: ${enmascarar(numero)}`);
        
        // v4.6.8-FIX: Cancelar timeout antes de rechazar
        if (sesion.timeoutId) {
          clearTimeout(sesion.timeoutId);
        }
        
        if (sesion.reject) {
          sesion.reject(new Error('Timeout: CAPTCHA no resuelto'));
        }
        if (sesion.browser) {
          sesion.browser.close().catch(() => {});
        }
        sesionesActivas.delete(numero);
      }
    }
    
    // Limpiar cache de rate limiting expirado
    for (const [ip, data] of rateLimitCache.entries()) {
      if (ahora - data.timestamp > RATE_LIMIT.windowMs) {
        rateLimitCache.delete(ip);
      }
    }
  }, 60000);
  
  // Permitir que el proceso termine aunque el intervalo esté activo
  limpiezaInterval.unref();
}

// ============================================================================
// UTILIDADES GENERALES
// ============================================================================

/**
 * Enmascara un texto sensible para logging seguro
 * @param {string} texto - Texto a enmascarar
 * @returns {string} Texto enmascarado (ej: "519***29")
 */
function enmascarar(texto) {
  if (!texto || texto.length < 6) return '***';
  return texto.substring(0, 3) + '***' + texto.substring(texto.length - 2);
}

/**
 * Crea una promesa que se resuelve después de los milisegundos especificados
 * @param {number} ms - Milisegundos a esperar
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Registra un mensaje en la consola con formato estructurado
 * @param {string} nivel - Nivel del log: debug, info, warn, error, success
 * @param {string} contexto - Contexto o módulo que genera el log
 * @param {string} mensaje - Mensaje a registrar
 * @param {object} datos - Datos adicionales para el log
 */
function log(nivel, contexto, mensaje, datos = {}) {
  const timestamp = new Date().toISOString();
  const iconos = { 
    debug: '🔍', 
    info: 'ℹ️', 
    warn: '⚠️', 
    error: '❌', 
    success: '✅' 
  };
  
  if (process.env.NODE_ENV === 'production') {
    // Formato JSON para producción (facilita parsing en logs)
    console.log(JSON.stringify({ 
      timestamp, 
      nivel, 
      contexto, 
      mensaje, 
      ...datos 
    }));
  } else {
    // Formato legible para desarrollo
    console.log(
      `[${timestamp}] ${iconos[nivel] || '•'} [${contexto}] ${mensaje}`, 
      Object.keys(datos).length > 0 ? datos : ''
    );
  }
}

/**
 * Valida que un número de WhatsApp tenga el formato correcto
 * @param {string} numero - Número a validar
 * @returns {{valido: boolean, numero?: string, error?: string}}
 */
function validarNumeroWhatsApp(numero) {
  if (!numero || typeof numero !== 'string') {
    return { valido: false, error: 'Número no proporcionado' };
  }
  
  // Limpiar caracteres no numéricos
  const limpio = numero.replace(/[\s\-\+\(\)]/g, '');
  
  // Validar formato peruano: 51 + 9 dígitos
  if (!/^51\d{9}$/.test(limpio)) {
    return { 
      valido: false, 
      error: 'Formato inválido. Use: 51XXXXXXXXX (11 dígitos)' 
    };
  }
  
  return { valido: true, numero: limpio };
}

/**
 * Valida que el texto del CAPTCHA tenga el formato correcto
 * @param {string} texto - Texto del CAPTCHA a validar
 * @returns {{valido: boolean, captcha?: string, error?: string, sugerencia?: string}}
 */
function validarCaptcha(texto) {
  if (!texto || typeof texto !== 'string') {
    return { valido: false, error: 'Texto vacío' };
  }
  
  // Limpiar y normalizar
  const limpio = texto.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  
  // CAPTCHA de SINOE típicamente tiene 5 caracteres
  if (limpio.length < 4 || limpio.length > 6) {
    return { 
      valido: false, 
      error: `El CAPTCHA debe tener 5 caracteres (recibido: ${limpio.length})`,
      sugerencia: 'Escriba solo las letras/números que ve en la imagen.'
    };
  }
  
  return { valido: true, captcha: limpio };
}

// ============================================================================
// v4.6.6: FUNCIONES DE RECUPERACIÓN DE FRAME
// ============================================================================

/**
 * v4.6.6: Ejecuta page.evaluate() de forma segura, capturando errores de frame
 * @param {Page} page - Instancia de Puppeteer Page
 * @param {Function} fn - Función a ejecutar en el contexto del navegador
 * @param {...any} args - Argumentos para la función
 * @returns {Promise<any|null>} Resultado de la evaluación o null si falla
 */
async function evaluarSeguro(page, fn, ...args) {
  try {
    return await page.evaluate(fn, ...args);
  } catch (error) {
    // Errores conocidos de frame no disponible
    const erroresFrame = [
      'frame',
      'detached', 
      'early',
      'context',
      'destroyed',
      'target closed'
    ];
    
    const esErrorFrame = erroresFrame.some(e => 
      error.message.toLowerCase().includes(e)
    );
    
    if (esErrorFrame) {
      return null;
    }
    
    // Si es otro tipo de error, propagarlo
    throw error;
  }
}

/**
 * v4.6.6: Obtiene la URL actual de la página de forma segura
 * @param {Page} page - Instancia de Puppeteer Page
 * @returns {Promise<string|null>} URL actual o null si no se puede obtener
 */
async function obtenerUrlSegura(page) {
  try {
    return page.url();
  } catch (error) {
    log('debug', 'FRAME', `No se pudo obtener URL: ${error.message}`);
    return null;
  }
}

/**
 * v4.6.6: Verifica el estado del frame usando polling
 * @param {Page} page - Instancia de Puppeteer Page
 * @param {string} requestId - ID de la request para logging
 * @param {number} maxIntentos - Máximo intentos de verificación
 * @returns {Promise<{success: boolean, data: object|null}>}
 */
async function esperarFrameConPolling(page, requestId, maxIntentos = 5) {
  for (let intento = 1; intento <= maxIntentos; intento++) {
    // Intentar evaluar algo simple en la página
    const resultado = await evaluarSeguro(page, () => {
      return {
        url: window.location.href,
        readyState: document.readyState,
        hasBody: !!document.body,
        bodyLength: document.body ? document.body.innerHTML.length : 0,
        title: document.title
      };
    });
    
    if (resultado !== null && resultado.hasBody && resultado.bodyLength > 0) {
      log('success', `SCRAPER:${requestId}`, `Frame listo en intento ${intento}/${maxIntentos}`, {
        url: resultado.url.substring(0, 60),
        readyState: resultado.readyState,
        bodyLength: resultado.bodyLength
      });
      
      metricas.frameRecoveries++;
      return { success: true, data: resultado };
    }
    
    log('debug', `SCRAPER:${requestId}`, `Polling intento ${intento}/${maxIntentos} - frame no listo`);
    metricas.frameRetries++;
    
    if (intento < maxIntentos) {
      await delay(FRAME_RECOVERY.intervaloPoll);
    }
  }
  
  return { success: false, data: null };
}

/**
 * v4.6.8: Analiza la URL Y contenido para determinar si el login fue exitoso
 * @param {string} url - URL a analizar
 * @param {string} contenido - Contenido HTML de la página (opcional)
 * @returns {{exitoso: boolean, razon: string, esSessionActiva?: boolean, requiereAccion?: string}}
 */
function analizarResultadoLogin(url, contenido = '') {
  if (!url) {
    return { exitoso: false, razon: 'URL no disponible' };
  }
  
  const urlLower = url.toLowerCase();
  const contenidoLower = (contenido || '').toLowerCase();
  
  // v4.6.8: Primero verificar contenido para detectar sesión activa con popup
  if (contenidoLower.includes('finalizar sesion') || 
      contenidoLower.includes('finalizar sesiones') ||
      contenidoLower.includes('cerrar sesiones') ||
      contenidoLower.includes('sesión activa') ||
      contenidoLower.includes('sesion activa')) {
    return { 
      exitoso: false, 
      razon: 'Sesión activa detectada en contenido', 
      esSessionActiva: true,
      requiereAccion: 'FINALIZAR_SESIONES'
    };
  }
  
  // v4.6.8: Detectar popup de COMUNICADO que puede ocultar el formulario
  if (contenidoLower.includes('comunicado') && 
      (contenidoLower.includes('aceptar') || contenidoLower.includes('cerrar'))) {
    return { 
      exitoso: false, 
      razon: 'Popup de comunicado detectado', 
      requiereAccion: 'CERRAR_POPUP'
    };
  }
  
  // Verificar URLs que indican error
  for (const patron of FRAME_RECOVERY.urlsErrorLogin) {
    if (urlLower.includes(patron)) {
      return { 
        exitoso: false, 
        razon: `URL indica error: ${patron}`, 
        esSessionActiva: patron.includes('session'),
        requiereAccion: patron.includes('session') ? 'FINALIZAR_SESIONES' : null
      };
    }
  }
  
  // Verificar URLs que indican éxito
  for (const patron of FRAME_RECOVERY.urlsExitoLogin) {
    if (urlLower.includes(patron)) {
      return { exitoso: true, razon: `URL indica éxito: ${patron}` };
    }
  }
  
  // Si cambió de la página de login, probablemente fue exitoso
  if (!urlLower.includes('sso-validar')) {
    return { exitoso: true, razon: 'URL cambió de página de login' };
  }
  
  return { exitoso: false, razon: 'Sigue en página de login' };
}

/**
 * v4.6.8: Intenta manejar una sesión activa haciendo clic en "FINALIZAR SESIONES"
 * @param {Page} page - Instancia de Puppeteer Page
 * @param {string} requestId - ID de la request para logging
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function manejarSesionActiva(page, requestId) {
  log('info', `SCRAPER:${requestId}`, 'Intentando cerrar sesión activa automáticamente...');
  
  try {
    // Buscar y hacer clic en botón "FINALIZAR SESIONES" o similar
    const clicExitoso = await evaluarSeguro(page, () => {
      // Selectores para el botón de finalizar sesiones en SINOE
      const selectoresFinalizar = [
        'button:contains("FINALIZAR")',
        'input[value*="FINALIZAR"]',
        'a:contains("FINALIZAR")',
        '.ui-button:contains("FINALIZAR")',
        'button[onclick*="finalizar"]',
        'a[onclick*="finalizar"]'
      ];
      
      // Buscar todos los botones y links
      const elementos = document.querySelectorAll('button, input[type="button"], input[type="submit"], a.ui-button, .ui-button');
      
      for (const el of elementos) {
        const texto = (el.textContent || el.value || '').toUpperCase();
        const onclick = (el.getAttribute('onclick') || '').toLowerCase();
        
        // Buscar variantes de "FINALIZAR SESIONES"
        if (texto.includes('FINALIZAR') || 
            texto.includes('CERRAR SESION') ||
            texto.includes('CERRAR SESIÓN') ||
            onclick.includes('finalizar') ||
            onclick.includes('cerrar')) {
          
          // Verificar que sea visible
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            el.click();
            return { 
              clicked: true, 
              texto: texto.substring(0, 30),
              metodo: 'texto o onclick'
            };
          }
        }
      }
      
      // Fallback: buscar por clase específica de PrimeFaces
      const btnPrimeFaces = document.querySelector('.ui-button[id*="finalizar"], .ui-button[id*="cerrar"]');
      if (btnPrimeFaces) {
        btnPrimeFaces.click();
        return { clicked: true, texto: 'PrimeFaces button', metodo: 'id' };
      }
      
      return { clicked: false };
    });
    
    if (clicExitoso?.clicked) {
      log('success', `SCRAPER:${requestId}`, `Clic en botón: "${clicExitoso.texto}" (${clicExitoso.metodo})`);
      metricas.sesionesActivasCerradas++;
      
      // Esperar a que se procese el cierre de sesión
      await delay(3000);
      
      // Verificar si funcionó esperando que el frame se estabilice
      const estadoFrame = await esperarFrameConPolling(page, requestId, 10);
      
      if (estadoFrame.success) {
        // Verificar si ahora podemos hacer login
        const contenidoNuevo = await evaluarSeguro(page, () => document.body.innerHTML) || '';
        
        // Si ya no hay mensaje de sesión activa, éxito
        if (!contenidoNuevo.toLowerCase().includes('sesion activa') &&
            !contenidoNuevo.toLowerCase().includes('sesión activa') &&
            !contenidoNuevo.toLowerCase().includes('finalizar sesion')) {
          log('success', `SCRAPER:${requestId}`, 'Sesión activa cerrada exitosamente');
          return { success: true };
        }
      }
      
      return { success: false, error: 'Clic realizado pero sesión sigue activa' };
    }
    
    log('warn', `SCRAPER:${requestId}`, 'No se encontró botón para finalizar sesiones');
    return { success: false, error: 'Botón FINALIZAR SESIONES no encontrado' };
    
  } catch (error) {
    log('error', `SCRAPER:${requestId}`, `Error manejando sesión activa: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * v4.6.6: Manejo completo de la fase post-login con recuperación agresiva
 * Esta es la función principal que soluciona "Requesting main frame too early!"
 * 
 * Estrategia:
 * 1. No usar waitForNavigation() - es muy frágil
 * 2. Polling agresivo con evaluarSeguro()
 * 3. Si el frame está persistentemente roto, crear nueva página
 * 
 * @param {Page} page - Instancia de Puppeteer Page
 * @param {Browser} browser - Instancia de Puppeteer Browser
 * @param {string} requestId - ID de la request para logging
 * @param {string} urlAntes - URL antes del clic en login
 * @returns {Promise<{success: boolean, url?: string, contenido?: string, error?: string, newPage?: Page}>}
 */
async function manejarPostLogin(page, browser, requestId, urlAntes) {
  const tiempoInicio = Date.now();
  const tiempoLimite = TIMEOUT.postLogin;
  
  log('info', `SCRAPER:${requestId}`, 'Iniciando manejo post-login v4.6.8...');
  
  // Espera inicial corta después del clic
  await delay(FRAME_RECOVERY.esperaPostClic);
  
  let intentoGlobal = 0;
  let ultimaUrlDetectada = urlAntes;
  let intentosSesionActiva = 0;  // v4.6.8: Contador de intentos de cerrar sesión activa
  const MAX_INTENTOS_SESION_ACTIVA = 2;  // Máximo 2 intentos de cerrar sesión
  
  // FASE 1: Polling hasta que el frame esté disponible o se acabe el tiempo
  while (Date.now() - tiempoInicio < tiempoLimite) {
    intentoGlobal++;
    
    log('debug', `SCRAPER:${requestId}`, `Intento global ${intentoGlobal}...`);
    
    // Intentar obtener estado del frame (5 intentos rápidos)
    const estadoFrame = await esperarFrameConPolling(page, requestId, 5);
    
    if (estadoFrame.success) {
      // v4.6.8: Obtener contenido PRIMERO para análisis completo
      const contenido = await evaluarSeguro(page, () => document.body.innerHTML) || '';
      
      // v4.6.8: Pasar URL y contenido al análisis
      const analisis = analizarResultadoLogin(estadoFrame.data.url, contenido);
      
      log('info', `SCRAPER:${requestId}`, 'Análisis de resultado de login', {
        url: estadoFrame.data.url.substring(0, 60),
        exitoso: analisis.exitoso,
        razon: analisis.razon,
        requiereAccion: analisis.requiereAccion || 'ninguna'
      });
      
      // v4.6.8: Si hay sesión activa, intentar cerrarla automáticamente
      if (analisis.esSessionActiva && analisis.requiereAccion === 'FINALIZAR_SESIONES') {
        if (intentosSesionActiva < MAX_INTENTOS_SESION_ACTIVA) {
          intentosSesionActiva++;
          log('info', `SCRAPER:${requestId}`, `Intento ${intentosSesionActiva}/${MAX_INTENTOS_SESION_ACTIVA} de cerrar sesión activa...`);
          
          const resultadoCierre = await manejarSesionActiva(page, requestId);
          
          if (resultadoCierre.success) {
            log('success', `SCRAPER:${requestId}`, 'Sesión activa cerrada, continuando con login...');
            // Continuar el loop para re-verificar el estado
            await delay(2000);
            continue;
          } else {
            log('warn', `SCRAPER:${requestId}`, `No se pudo cerrar sesión: ${resultadoCierre.error}`);
          }
        } else {
          // Ya intentamos cerrar sesión activa sin éxito
          return {
            success: false,
            error: 'Sesión activa detectada - no se pudo cerrar automáticamente. Ciérrela manualmente en SINOE.',
            url: estadoFrame.data.url,
            contenido: contenido
          };
        }
      }
      
      // v4.6.8: Manejar popup de comunicado
      if (analisis.requiereAccion === 'CERRAR_POPUP') {
        log('info', `SCRAPER:${requestId}`, 'Popup de comunicado detectado, cerrando...');
        await cerrarPopups(page);
        await delay(1000);
        continue;  // Re-verificar después de cerrar popup
      }
      
      // Si no es exitoso por otra razón
      if (!analisis.exitoso && !analisis.esSessionActiva) {
        log('warn', `SCRAPER:${requestId}`, 'Login no exitoso según análisis', {
          razon: analisis.razon
        });
        return {
          success: false,
          error: analisis.razon || 'Login fallido - URL no indica éxito',
          url: estadoFrame.data.url,
          contenido: contenido
        };
      }
      
      // Verificar si el contenido indica CAPTCHA incorrecto
      const contenidoLower = contenido.toLowerCase();
      if (contenidoLower.includes('captcha') && 
          (contenidoLower.includes('incorrecto') || 
           contenidoLower.includes('inválido') ||
           contenidoLower.includes('invalido'))) {
        return {
          success: false,
          error: 'CAPTCHA incorrecto',
          url: estadoFrame.data.url,
          contenido: contenido
        };
      }
      
      // ¡Éxito!
      return {
        success: true,
        url: estadoFrame.data.url,
        contenido: contenido,
        tiempoMs: Date.now() - tiempoInicio
      };
    }
    
    // Si el frame sigue roto después de varios intentos, probar recuperación extrema
    if (intentoGlobal >= 3 && intentoGlobal % 3 === 0) {
      log('warn', `SCRAPER:${requestId}`, 'Frame persistentemente roto, intentando recuperación con nueva página...');
      
      // Verificar si la URL cambió (a veces podemos obtenerla aunque el frame esté roto)
      const urlActual = await obtenerUrlSegura(page);
      
      if (urlActual && urlActual !== urlAntes) {
        ultimaUrlDetectada = urlActual;
        
        log('info', `SCRAPER:${requestId}`, 'URL cambió, creando nueva página...', {
          urlDetectada: urlActual.substring(0, 60)
        });
        
        try {
          // Crear nueva página en el mismo browser
          const newPage = await browser.newPage();
          // v4.6.7-FIX: Usar setDefaultTimeout en lugar de setDefaultNavigationTimeout
          newPage.setDefaultTimeout(TIMEOUT.navegacion);
          
          // Configurar viewport
          await newPage.setViewport(DEFAULT_VIEWPORT);
          
          // Navegar a la URL detectada
          await newPage.goto(urlActual, { 
            waitUntil: 'networkidle2', 
            timeout: 30000 
          });
          
          // Verificar si la nueva página funciona
          const testEval = await evaluarSeguro(newPage, () => ({
            url: window.location.href,
            hasBody: !!document.body,
            bodyLength: document.body ? document.body.innerHTML.length : 0
          }));
          
          if (testEval && testEval.hasBody && testEval.bodyLength > 0) {
            log('success', `SCRAPER:${requestId}`, 'Nueva página creada exitosamente', {
              url: testEval.url.substring(0, 60)
            });
            
            metricas.newPageCreations++;
            
            // Cerrar la página vieja (que tiene el frame roto)
            await page.close().catch(err => {
              log('debug', `SCRAPER:${requestId}`, `Error cerrando página vieja: ${err.message}`);
            });
            
            // Obtener contenido de la nueva página
            const contenido = await evaluarSeguro(newPage, () => document.body.innerHTML);
            
            return {
              success: true,
              url: testEval.url,
              contenido: contenido || '',
              tiempoMs: Date.now() - tiempoInicio,
              newPage: newPage,  // Retornar la nueva página para continuar usándola
              usedRecovery: true
            };
          } else {
            // La nueva página tampoco funciona, cerrarla
            log('warn', `SCRAPER:${requestId}`, 'Nueva página no funcionó, cerrándola...');
            await newPage.close().catch(() => {});
          }
        } catch (recoveryError) {
          log('warn', `SCRAPER:${requestId}`, `Error en recuperación con nueva página: ${recoveryError.message}`);
        }
      }
    }
    
    // Esperar antes del siguiente ciclo global
    await delay(FRAME_RECOVERY.esperaEntreRecuperaciones);
  }
  
  // Timeout total alcanzado sin éxito
  log('error', `SCRAPER:${requestId}`, 'Timeout en fase post-login', {
    tiempoTranscurrido: Date.now() - tiempoInicio,
    intentosGlobales: intentoGlobal,
    ultimaUrlDetectada: ultimaUrlDetectada.substring(0, 60)
  });
  
  return {
    success: false,
    error: 'Timeout en fase post-login (60s)',
    tiempoMs: Date.now() - tiempoInicio
  };
}

// ============================================================================
// MIDDLEWARES
// ============================================================================

// Parser de JSON con límite de tamaño
app.use(express.json({ limit: '1mb' }));

/**
 * Middleware de rate limiting por IP
 */
app.use((req, res, next) => {
  // Excluir health check del rate limiting
  if (req.path === '/health') return next();
  
  // v4.6.7-FIX: req.connection está deprecated, usar req.socket
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const ahora = Date.now();
  
  if (!rateLimitCache.has(ip)) {
    rateLimitCache.set(ip, { count: 1, timestamp: ahora });
    return next();
  }
  
  const data = rateLimitCache.get(ip);
  
  // Resetear si pasó la ventana de tiempo
  if (ahora - data.timestamp > RATE_LIMIT.windowMs) {
    rateLimitCache.set(ip, { count: 1, timestamp: ahora });
    return next();
  }
  
  data.count++;
  
  if (data.count > RATE_LIMIT.maxRequestsPerIp) {
    log('warn', 'RATE_LIMIT', `IP bloqueada temporalmente: ${ip}`);
    return res.status(429).json({
      success: false,
      error: 'Demasiadas solicitudes. Intente en 1 minuto.'
    });
  }
  
  next();
});

/**
 * Middleware de autenticación con API Key
 */
app.use((req, res, next) => {
  // Rutas públicas que no requieren autenticación
  const publicPaths = ['/health', '/webhook/whatsapp'];
  if (publicPaths.includes(req.path)) return next();
  
  const apiKey = req.headers['x-api-key'] || req.headers['apikey'];
  
  if (!apiKey || apiKey !== API_KEY) {
    log('warn', 'AUTH', `Intento de acceso no autorizado a ${req.path}`);
    return res.status(401).json({
      success: false,
      error: 'API Key inválida',
      hint: 'Incluya header X-API-KEY'
    });
  }
  
  next();
});

/**
 * Middleware de métricas
 */
app.use((req, res, next) => {
  metricas.requestsTotal++;
  next();
});

// ============================================================================
// FUNCIONES DE WHATSAPP
// ============================================================================

/**
 * Envía un mensaje de texto por WhatsApp usando Evolution API
 * @param {string} numero - Número de WhatsApp destino (formato: 51XXXXXXXXX)
 * @param {string} mensaje - Texto del mensaje
 * @param {number} intentos - Número máximo de reintentos
 * @returns {Promise<boolean>} true si se envió correctamente
 */
async function enviarWhatsAppTexto(numero, mensaje, intentos = 3) {
  if (!CONFIG.evolution.apiKey) {
    log('error', 'WHATSAPP', 'EVOLUTION_API_KEY no configurada');
    return false;
  }
  
  for (let i = 1; i <= intentos; i++) {
    try {
      const url = `${CONFIG.evolution.url}/message/sendText/${CONFIG.evolution.instance}`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': CONFIG.evolution.apiKey
        },
        body: JSON.stringify({ 
          number: numero, 
          text: mensaje 
        }),
        signal: AbortSignal.timeout(TIMEOUT.api)
      });

      if (response.ok) {
        log('success', 'WHATSAPP', 'Texto enviado', { 
          numero: enmascarar(numero),
          longitud: mensaje.length 
        });
        return true;
      }
      
      const errorBody = await response.text();
      log('warn', 'WHATSAPP', `Intento ${i}/${intentos} fallido`, { 
        status: response.status, 
        error: errorBody.substring(0, 200) 
      });
      
    } catch (error) {
      log('warn', 'WHATSAPP', `Intento ${i}/${intentos} error: ${error.message}`);
    }
    
    if (i < intentos) await delay(1000 * i);
  }
  
  log('error', 'WHATSAPP', 'No se pudo enviar texto después de todos los intentos', {
    numero: enmascarar(numero)
  });
  return false;
}

/**
 * Envía una imagen por WhatsApp usando Evolution API
 * @param {string} numero - Número de WhatsApp destino
 * @param {string} base64Image - Imagen codificada en base64
 * @param {string} caption - Texto que acompaña la imagen
 * @param {number} intentos - Número máximo de reintentos
 * @returns {Promise<boolean>} true si se envió correctamente
 */
async function enviarWhatsAppImagen(numero, base64Image, caption, intentos = 3) {
  if (!CONFIG.evolution.apiKey) {
    log('error', 'WHATSAPP', 'EVOLUTION_API_KEY no configurada');
    return false;
  }
  
  if (!base64Image || base64Image.length < 100) {
    log('error', 'WHATSAPP', 'Imagen inválida o muy pequeña', {
      tamaño: base64Image?.length || 0
    });
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
        log('success', 'WHATSAPP', 'Imagen enviada', { 
          numero: enmascarar(numero), 
          size: base64Image.length,
          captionLength: caption.length
        });
        return true;
      }
      
      const errorBody = await response.text();
      log('warn', 'WHATSAPP', `Imagen intento ${i}/${intentos} fallido`, { 
        status: response.status, 
        error: errorBody.substring(0, 200) 
      });
      
    } catch (error) {
      log('warn', 'WHATSAPP', `Imagen intento ${i}/${intentos} error: ${error.message}`);
    }
    
    if (i < intentos) await delay(1000 * i);
  }
  
  log('error', 'WHATSAPP', 'No se pudo enviar imagen después de todos los intentos', {
    numero: enmascarar(numero)
  });
  return false;
}

// ============================================================================
// FUNCIONES DE SCRAPING - POPUPS
// ============================================================================

/**
 * Verifica si hay un popup visible en la página
 * @param {Page} page - Instancia de Puppeteer Page
 * @returns {Promise<boolean>} true si hay popup visible
 */
async function hayPopupVisible(page) {
  const resultado = await evaluarSeguro(page, () => {
    // Buscar overlays típicos de PrimeFaces/jQuery UI
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
    
    // Buscar texto que indica popup de términos
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
  
  return resultado === true;
}

/**
 * Intenta cerrar popups visibles en la página
 * @param {Page} page - Instancia de Puppeteer Page
 * @returns {Promise<boolean>} true si se cerró exitosamente o no había popup
 */
async function cerrarPopups(page) {
  log('info', 'POPUP', 'Verificando si hay popups para cerrar...');
  
  const MAX_INTENTOS = 5;
  
  for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
    try {
      const tienePopup = await hayPopupVisible(page);
      
      if (!tienePopup) {
        log('success', 'POPUP', 'No hay popups visibles');
        return true;
      }
      
      log('info', 'POPUP', `Intento ${intento}/${MAX_INTENTOS} de cerrar popup...`);
      
      // Intentar hacer clic en botón de aceptar/cerrar
      const clicExitoso = await evaluarSeguro(page, () => {
        const botones = document.querySelectorAll('button, .ui-button, input[type="button"], a.ui-button');
        
        for (const boton of botones) {
          const texto = (boton.textContent || boton.value || '').toLowerCase().trim();
          const rect = boton.getBoundingClientRect();
          
          // Verificar que el botón sea visible y clicable
          if (rect.width > 0 && rect.height > 0 && rect.top >= 0) {
            if (texto === 'aceptar' || texto === 'acepto' || texto === 'ok' || texto === 'cerrar') {
              boton.click();
              return { clicked: true, texto: texto };
            }
          }
        }
        
        // Fallback: buscar cualquier botón en área de diálogo
        const dialogButtons = document.querySelectorAll('.ui-dialog-buttonset button, .ui-dialog-buttonpane button');
        if (dialogButtons.length > 0) {
          dialogButtons[0].click();
          return { clicked: true, texto: 'primer botón de diálogo' };
        }
        
        return { clicked: false };
      });
      
      if (clicExitoso?.clicked) {
        log('info', 'POPUP', `Clic en botón: "${clicExitoso.texto}"`);
        await delay(500);
        
        // Esperar a que el popup desaparezca
        let esperaMs = 0;
        const maxEsperaMs = 3000;
        
        while (esperaMs < maxEsperaMs) {
          const sigueTeniendoPopup = await hayPopupVisible(page);
          if (!sigueTeniendoPopup) {
            log('success', 'POPUP', `Popup cerrado después de ${esperaMs}ms`);
            await delay(500);
            return true;
          }
          await delay(200);
          esperaMs += 200;
        }
        
        log('warn', 'POPUP', 'El popup no se cerró después del clic, reintentando...');
      } else {
        // Si no encontró botón, intentar con tecla Escape
        log('info', 'POPUP', 'No se encontró botón, intentando con Escape...');
        await page.keyboard.press('Escape');
        await delay(500);
        
        const cerrado = !(await hayPopupVisible(page));
        if (cerrado) {
          log('success', 'POPUP', 'Popup cerrado con Escape');
          return true;
        }
      }
      
      await delay(1000);
      
    } catch (error) {
      log('warn', 'POPUP', `Error en intento ${intento}: ${error.message}`);
    }
  }
  
  log('error', 'POPUP', 'No se pudo cerrar el popup después de todos los intentos');
  return false;
}

// ============================================================================
// FUNCIONES DE SCRAPING - CREDENCIALES
// ============================================================================

/**
 * Llena los campos de usuario y contraseña en el formulario de login
 * @param {Page} page - Instancia de Puppeteer Page
 * @param {string} usuario - Nombre de usuario SINOE
 * @param {string} password - Contraseña SINOE
 * @returns {Promise<boolean>} true si se llenaron correctamente
 */
async function llenarCredenciales(page, usuario, password) {
  log('info', 'CREDENCIALES', 'Buscando y llenando campos de login...');
  
  // Primer intento: llenar usando JavaScript directo
  const resultado = await evaluarSeguro(page, (user, pass) => {
    const resultados = {
      usuarioEncontrado: false,
      passwordEncontrado: false,
      usuarioLlenado: false,
      passwordLlenado: false,
      errores: []
    };
    
    /**
     * Helper para llenar un campo de forma robusta
     */
    function llenarCampo(input, valor, nombre) {
      if (!input) {
        resultados.errores.push(`Campo ${nombre} no encontrado`);
        return false;
      }
      
      try {
        // Secuencia de eventos para simular escritura real
        input.focus();
        input.value = '';
        input.value = valor;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('blur', { bubbles: true }));
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
    
    // Buscar campos de login
    const allInputs = document.querySelectorAll('input');
    let campoUsuario = null;
    let campoPassword = null;
    
    for (const input of allInputs) {
      const type = input.type?.toLowerCase() || '';
      const placeholder = (input.placeholder || '').toLowerCase();
      const id = (input.id || '').toLowerCase();
      
      // Campo de usuario: text que NO es CAPTCHA
      if (type === 'text' && !placeholder.includes('captcha') && !id.includes('captcha')) {
        if (!campoUsuario) {
          campoUsuario = input;
          resultados.usuarioEncontrado = true;
        }
      }
      
      // Campo de password
      if (type === 'password') {
        campoPassword = input;
        resultados.passwordEncontrado = true;
      }
    }
    
    // Fallback: buscar por placeholder específico
    if (!campoUsuario) {
      campoUsuario = document.querySelector('input[placeholder*="Usuario"], input[placeholder*="usuario"]');
      if (campoUsuario) resultados.usuarioEncontrado = true;
    }
    
    if (!campoPassword) {
      campoPassword = document.querySelector('input[placeholder*="Contraseña"], input[placeholder*="contraseña"]');
      if (campoPassword) resultados.passwordEncontrado = true;
    }
    
    // Llenar los campos encontrados
    if (campoUsuario) {
      resultados.usuarioLlenado = llenarCampo(campoUsuario, user, 'usuario');
    }
    
    if (campoPassword) {
      resultados.passwordLlenado = llenarCampo(campoPassword, pass, 'password');
    }
    
    return resultados;
  }, usuario, password);
  
  log('info', 'CREDENCIALES', 'Resultado del llenado:', resultado || { error: 'evaluación falló' });
  
  // Si el método directo falló, intentar con typing
  if (!resultado?.usuarioLlenado || !resultado?.passwordLlenado) {
    log('warn', 'CREDENCIALES', 'Método directo falló, intentando con typing...');
    
    try {
      const inputUsuario = await page.$('input[type="text"]:not([placeholder*="CAPTCHA"]):not([placeholder*="captcha"])');
      const inputPassword = await page.$('input[type="password"]');
      
      if (inputUsuario && (!resultado || !resultado.usuarioLlenado)) {
        await inputUsuario.click({ clickCount: 3 });
        await delay(100);
        await inputUsuario.type(usuario, { delay: 30 });
        log('info', 'CREDENCIALES', 'Usuario llenado con typing');
      }
      
      if (inputPassword && (!resultado || !resultado.passwordLlenado)) {
        await inputPassword.click({ clickCount: 3 });
        await delay(100);
        await inputPassword.type(password, { delay: 30 });
        log('info', 'CREDENCIALES', 'Password llenado con typing');
      }
    } catch (e) {
      log('error', 'CREDENCIALES', `Error en typing: ${e.message}`);
    }
  }
  
  await delay(500);
  
  // Verificar que los campos quedaron llenos
  const verificacion = await evaluarSeguro(page, () => {
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
  
  log('info', 'CREDENCIALES', 'Verificación final:', verificacion || { error: 'verificación falló' });
  
  if (!verificacion?.usuarioTieneValor || !verificacion?.passwordTieneValor) {
    throw new Error('No se pudieron llenar las credenciales correctamente');
  }
  
  log('success', 'CREDENCIALES', 'Campos llenados correctamente');
  return true;
}

// ============================================================================
// FUNCIONES DE SCRAPING - CAPTCHA
// ============================================================================

/**
 * Verifica si la imagen CAPTCHA está cargada y es válida
 * @param {Page} page - Instancia de Puppeteer Page
 * @returns {Promise<{valido: boolean, razon: string, width?: number, height?: number}>}
 */
async function verificarCaptchaValido(page) {
  const resultado = await evaluarSeguro(page, (config) => {
    const imagenes = document.querySelectorAll('img');
    
    // MÉTODO 1: Buscar por patrón en src/id/alt
    for (const img of imagenes) {
      const src = (img.src || '').toLowerCase();
      const id = (img.id || '').toLowerCase();
      const alt = (img.alt || '').toLowerCase();
      
      const esCaptcha = src.includes('captcha') || 
                        src.includes('jcaptcha') ||
                        src.includes('codigo') ||
                        src.includes('code') ||
                        id.includes('captcha') || 
                        id.includes('imgcod') ||
                        alt.includes('captcha') ||
                        alt.includes('codigo');
      
      if (esCaptcha) {
        if (!img.complete) {
          return { valido: false, razon: 'Imagen CAPTCHA aún cargando', metodo: 'patron-directo' };
        }
        
        if (img.naturalWidth === 0 || img.naturalHeight === 0) {
          return { valido: false, razon: 'Imagen CAPTCHA no cargó (dimensiones 0)', metodo: 'patron-directo' };
        }
        
        // Verificar dimensiones típicas de CAPTCHA
        if (img.naturalWidth >= 50 && img.naturalWidth <= 300 &&
            img.naturalHeight >= 20 && img.naturalHeight <= 100) {
          return { 
            valido: true, 
            razon: 'OK',
            width: img.naturalWidth,
            height: img.naturalHeight,
            metodo: 'patron-directo',
            src: src.substring(0, 50)
          };
        }
      }
    }
    
    // MÉTODO 2: Buscar imagen cerca del input de CAPTCHA
    const inputCaptcha = document.querySelector('input[id*="captcha"], input[placeholder*="Captcha"], input[placeholder*="captcha"]');
    
    if (inputCaptcha) {
      let container = inputCaptcha.parentElement;
      let nivel = 0;
      
      while (container && nivel < 5) {
        const imagenCercana = container.querySelector('img');
        
        if (imagenCercana && imagenCercana.complete) {
          const w = imagenCercana.naturalWidth;
          const h = imagenCercana.naturalHeight;
          
          // v4.6.7-FIX: Verificar dimensiones válidas (eliminado código muerto)
          if (w >= 50 && w <= 300 && h >= 20 && h <= 100) {
            return { 
              valido: true, 
              razon: 'OK (imagen cercana al input)',
              width: w,
              height: h,
              metodo: 'cercania-input'
            };
          }
        }
        
        container = container.parentElement;
        nivel++;
      }
      
      // Buscar en elementos hermanos
      const padre = inputCaptcha.parentElement;
      if (padre) {
        const hermanos = padre.parentElement?.querySelectorAll('img');
        if (hermanos) {
          for (const img of hermanos) {
            if (img.complete && img.naturalWidth >= 50 && img.naturalWidth <= 300 &&
                img.naturalHeight >= 20 && img.naturalHeight <= 100) {
              return { 
                valido: true, 
                razon: 'OK (imagen hermana)',
                width: img.naturalWidth,
                height: img.naturalHeight,
                metodo: 'hermana-input'
              };
            }
          }
        }
      }
    }
    
    // MÉTODO 3: Buscar en formulario por dimensiones típicas
    const form = document.querySelector('form[id*="Login"], form[id*="login"], form');
    if (form) {
      const imagenesForm = form.querySelectorAll('img');
      for (const img of imagenesForm) {
        if (img.complete) {
          const w = img.naturalWidth;
          const h = img.naturalHeight;
          
          // Dimensiones típicas de CAPTCHA de SINOE
          if (w >= 80 && w <= 200 && h >= 25 && h <= 60) {
            return { 
              valido: true, 
              razon: 'OK (imagen en formulario con dimensiones CAPTCHA)',
              width: w,
              height: h,
              metodo: 'dimension-form'
            };
          }
        }
      }
    }
    
    // No se encontró CAPTCHA válido - recopilar info de debug
    const debugInfo = [];
    for (const img of imagenes) {
      if (img.naturalWidth > 0) {
        debugInfo.push({
          src: (img.src || '').substring(0, 60),
          id: img.id || 'sin-id',
          size: `${img.naturalWidth}x${img.naturalHeight}`
        });
      }
    }
    
    return { 
      valido: false, 
      razon: 'No se encontró imagen de CAPTCHA válida',
      imagenes: debugInfo.slice(0, 5)
    };
  }, CAPTCHA_CONFIG);
  
  return resultado || { valido: false, razon: 'Error evaluando página' };
}

/**
 * Intenta recargar la imagen del CAPTCHA
 * @param {Page} page - Instancia de Puppeteer Page
 * @returns {Promise<boolean>} true si se recargó exitosamente
 */
async function recargarCaptcha(page) {
  log('info', 'CAPTCHA', 'Intentando recargar CAPTCHA...');
  
  const recargado = await evaluarSeguro(page, () => {
    // Buscar botón/link de recarga por onclick
    const elementos = document.querySelectorAll('a, button, img, span, i');
    for (const el of elementos) {
      const onclick = el.getAttribute('onclick') || '';
      if (onclick.toLowerCase().includes('captcha') || onclick.toLowerCase().includes('refresh')) {
        el.click();
        return { clicked: true, metodo: 'onclick con captcha/refresh' };
      }
    }
    
    // Buscar elemento cercano a la imagen del CAPTCHA
    const captchaImg = document.querySelector('img[src*="captcha"], img[id*="captcha"]');
    if (captchaImg) {
      const rect = captchaImg.getBoundingClientRect();
      // Buscar elemento clickeable a la derecha del CAPTCHA
      const elementosCerca = document.elementsFromPoint(rect.right + 25, rect.top + rect.height / 2);
      for (const el of elementosCerca) {
        if (el.tagName === 'A' || el.tagName === 'BUTTON' || el.tagName === 'IMG' || 
            el.classList.contains('ui-commandlink') || el.onclick) {
          el.click();
          return { clicked: true, metodo: 'elemento cercano al CAPTCHA' };
        }
      }
    }
    
    // Buscar por ID típicos
    const refreshBtn = document.querySelector('.ui-commandlink[id*="captcha"], a[id*="refresh"], a[id*="Refresh"]');
    if (refreshBtn) {
      refreshBtn.click();
      return { clicked: true, metodo: 'ui-commandlink' };
    }
    
    return { clicked: false };
  });
  
  if (recargado?.clicked) {
    log('info', 'CAPTCHA', `Botón de recarga clickeado (${recargado.metodo})`);
    metricas.captchasRecargados++;
    await delay(CAPTCHA_CONFIG.esperaEntreCarga);
    return true;
  }
  
  log('warn', 'CAPTCHA', 'No se encontró botón de recarga del CAPTCHA');
  return false;
}

/**
 * Asegura que haya un CAPTCHA válido visible, recargando si es necesario
 * @param {Page} page - Instancia de Puppeteer Page
 * @param {string} usuario - Usuario para re-llenar si se recarga página
 * @param {string} password - Password para re-llenar si se recarga página
 * @returns {Promise<boolean>} true si hay CAPTCHA válido
 */
async function asegurarCaptchaValido(page, usuario, password) {
  const maxIntentos = CAPTCHA_CONFIG.maxIntentos;
  
  log('info', 'CAPTCHA', `Verificando CAPTCHA (máximo ${maxIntentos} intentos)...`);
  
  for (let intento = 1; intento <= maxIntentos; intento++) {
    const estado = await verificarCaptchaValido(page);
    
    if (estado.valido) {
      log('success', 'CAPTCHA', `✓ CAPTCHA válido en intento ${intento}/${maxIntentos}`, {
        width: estado.width,
        height: estado.height,
        metodo: estado.metodo
      });
      return true;
    }
    
    log('warn', 'CAPTCHA', `Intento ${intento}/${maxIntentos}: ${estado.razon}`);
    
    if (intento === maxIntentos) {
      break;
    }
    
    // Intentar recargar el CAPTCHA
    const recargado = await recargarCaptcha(page);
    
    if (recargado) {
      log('info', 'CAPTCHA', 'Esperando a que cargue nueva imagen...');
      await delay(CAPTCHA_CONFIG.esperaEntreCarga);
    } else {
      // Si no hay botón de recarga, refrescar página completa
      log('info', 'CAPTCHA', 'No se encontró botón de recarga. Refrescando página completa...');
      
      await page.reload({ waitUntil: 'networkidle2' });
      await delay(CAPTCHA_CONFIG.esperaDespuesRefresh);
      
      // Re-cerrar popups y re-llenar credenciales
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
  
  const errorMsg = `El CAPTCHA no cargó correctamente después de ${maxIntentos} intentos. Por favor intente de nuevo.`;
  log('error', 'CAPTCHA', errorMsg);
  
  throw new Error(errorMsg);
}

// ============================================================================
// FUNCIONES DE SCRAPING - CAPTURA
// ============================================================================

/**
 * Captura una imagen del formulario de login con el CAPTCHA visible
 * @param {Page} page - Instancia de Puppeteer Page
 * @returns {Promise<string>} Screenshot en base64
 */
async function capturarFormularioLogin(page) {
  log('info', 'CAPTURA', 'Capturando formulario de login...');
  
  // Asegurar que no hay popup tapando
  if (await hayPopupVisible(page)) {
    log('warn', 'CAPTURA', 'Hay popup visible, cerrándolo antes de capturar...');
    await cerrarPopups(page);
    await delay(500);
  }
  
  // Buscar el formulario de login
  const formularioInfo = await evaluarSeguro(page, () => {
    const selectores = [
      '.ui-panel-content',
      '.ui-panel',
      'form',
      '.login-container',
      '.login-form',
      '[class*="login"]'
    ];
    
    for (const selector of selectores) {
      const elementos = document.querySelectorAll(selector);
      
      for (const el of elementos) {
        const tieneUsuario = el.querySelector('input[type="text"]');
        const tienePassword = el.querySelector('input[type="password"]');
        
        if (tieneUsuario && tienePassword) {
          const rect = el.getBoundingClientRect();
          
          // Verificar que tenga tamaño razonable
          if (rect.width > 200 && rect.height > 200) {
            return {
              found: true,
              x: Math.max(0, rect.x - 10),
              y: Math.max(0, rect.y - 10),
              width: Math.min(rect.width + 20, window.innerWidth),
              height: Math.min(rect.height + 20, window.innerHeight),
              selector: selector
            };
          }
        }
      }
    }
    
    // Fallback: buscar contenedor del CAPTCHA
    const captchaImg = document.querySelector('img[src*="captcha"], img[id*="captcha"]');
    if (captchaImg) {
      let container = captchaImg.parentElement;
      let nivel = 0;
      
      while (container && nivel < 10) {
        const rect = container.getBoundingClientRect();
        
        if (rect.width > 300 && rect.height > 300) {
          return {
            found: true,
            x: Math.max(0, rect.x - 10),
            y: Math.max(0, rect.y - 10),
            width: Math.min(rect.width + 20, window.innerWidth),
            height: Math.min(rect.height + 20, window.innerHeight),
            selector: 'parent del captcha (nivel ' + nivel + ')'
          };
        }
        
        container = container.parentElement;
        nivel++;
      }
    }
    
    return { found: false };
  });
  
  if (formularioInfo?.found) {
    log('info', 'CAPTURA', `Formulario encontrado (${formularioInfo.selector})`, {
      x: Math.round(formularioInfo.x),
      y: Math.round(formularioInfo.y),
      width: Math.round(formularioInfo.width),
      height: Math.round(formularioInfo.height)
    });
    
    const screenshot = await page.screenshot({
      encoding: 'base64',
      clip: {
        x: formularioInfo.x,
        y: formularioInfo.y,
        width: formularioInfo.width,
        height: formularioInfo.height
      }
    });
    
    if (screenshot && screenshot.length > 1000) {
      log('success', 'CAPTURA', 'Screenshot del formulario capturado', { 
        bytes: screenshot.length 
      });
      return screenshot;
    }
  }
  
  // Fallback: capturar área central
  log('warn', 'CAPTURA', 'Usando fallback - área central de pantalla');
  
  const viewport = page.viewport() || DEFAULT_VIEWPORT;
  const centerX = (viewport.width - 500) / 2;
  const centerY = 100;
  
  const screenshot = await page.screenshot({
    encoding: 'base64',
    clip: {
      x: Math.max(0, centerX),
      y: centerY,
      width: 500,
      height: 550
    }
  });
  
  if (screenshot && screenshot.length > 1000) {
    log('success', 'CAPTURA', 'Screenshot fallback capturado', { 
      bytes: screenshot.length 
    });
    return screenshot;
  }
  
  // Último recurso: pantalla completa
  log('warn', 'CAPTURA', 'Capturando pantalla completa como último recurso');
  return await page.screenshot({ encoding: 'base64' });
}

// ============================================================================
// FUNCIONES DE SCRAPING - EXTRACCIÓN
// ============================================================================

/**
 * Busca el link para navegar a Casillas SINOE
 * @param {Page} page - Instancia de Puppeteer Page
 * @returns {Promise<string|null>} URL del link o null si no se encuentra
 */
async function buscarLinkCasillas(page) {
  return await evaluarSeguro(page, () => {
    const links = document.querySelectorAll('a');
    
    for (const link of links) {
      const texto = (link.textContent || '').toLowerCase();
      const href = (link.href || '').toLowerCase();
      
      // Excluir links de recuperar contraseña
      if (texto.includes('olvidó') || texto.includes('recuperar')) continue;
      
      // Buscar links relacionados con SINOE/casillas
      if (texto.includes('sinoe') || texto.includes('casilla') || 
          href.includes('sinoe') || href.includes('casilla')) {
        return link.href;
      }
    }
    
    return null;
  });
}

/**
 * Extrae las notificaciones de la bandeja de SINOE
 * @param {Page} page - Instancia de Puppeteer Page
 * @returns {Promise<Array>} Array de notificaciones
 */
async function extraerNotificaciones(page) {
  log('info', 'NOTIFICACIONES', 'Extrayendo notificaciones...');
  
  // Esperar a que cargue la tabla
  try {
    await page.waitForSelector('table, .ui-datatable', { timeout: TIMEOUT.navegacion });
  } catch (e) {
    log('warn', 'NOTIFICACIONES', 'No se encontró tabla de notificaciones');
  }
  
  await delay(2000);
  
  const notificaciones = await evaluarSeguro(page, () => {
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
  
  log('info', 'NOTIFICACIONES', `Se encontraron ${notificaciones?.length || 0} notificaciones`);
  
  return notificaciones || [];
}

// ============================================================================
// FUNCIÓN PRINCIPAL DEL SCRAPER
// ============================================================================

/**
 * Ejecuta el proceso completo de scraping de SINOE
 * @param {object} params - Parámetros del scraping
 * @param {string} params.sinoeUsuario - Usuario de SINOE
 * @param {string} params.sinoePassword - Contraseña de SINOE
 * @param {string} params.whatsappNumero - Número de WhatsApp del abogado
 * @param {string} params.nombreAbogado - Nombre del abogado para mensajes
 * @returns {Promise<object>} Resultado del scraping
 */
async function ejecutarScraper({ sinoeUsuario, sinoePassword, whatsappNumero, nombreAbogado }) {
  let browser = null;
  let page = null;
  const inicioMs = Date.now();
  const requestId = crypto.randomUUID().substring(0, 8);
  
  try {
    metricas.scrapersIniciados++;
    
    // ========================================================================
    // PASO 1: Conectar a Browserless
    // ========================================================================
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
    
    // ========================================================================
    // PASO 2: Navegar a SINOE
    // ========================================================================
    log('info', `SCRAPER:${requestId}`, 'Navegando a SINOE...');
    
    await page.goto(SINOE_URLS.login, { waitUntil: 'networkidle2' });
    await delay(3000);
    
    log('success', `SCRAPER:${requestId}`, 'Página de SINOE cargada');
    
    // ========================================================================
    // PASO 3: Manejar página de parámetros no válidos
    // ========================================================================
    const contenidoInicial = await evaluarSeguro(page, () => document.body.innerText) || '';
    
    if (contenidoInicial.includes('PARAMETROS') && contenidoInicial.includes('NO VALIDOS')) {
      log('info', `SCRAPER:${requestId}`, 'Página de parámetros detectada, navegando al inicio...');
      
      const navegoInicio = await evaluarSeguro(page, () => {
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
        // v4.6.7-FIX: NO usar waitForNavigation (inconsistente con filosofía v4.6.6)
        // En su lugar, usar delay + polling
        await delay(3000);
        await esperarFrameConPolling(page, requestId, 10);
      }
    }
    
    // ========================================================================
    // PASO 4: Cerrar popups
    // ========================================================================
    log('info', `SCRAPER:${requestId}`, 'Verificando y cerrando popups...');
    await cerrarPopups(page);
    await delay(1000);
    
    // ========================================================================
    // PASO 5: Esperar campos de login
    // ========================================================================
    log('info', `SCRAPER:${requestId}`, 'Esperando campos de login...');
    await page.waitForSelector('input[type="text"], input[type="password"]', { timeout: TIMEOUT.elemento });
    
    if (await hayPopupVisible(page)) {
      await cerrarPopups(page);
      await delay(500);
    }
    
    // ========================================================================
    // PASO 6: Llenar credenciales
    // ========================================================================
    log('info', `SCRAPER:${requestId}`, 'Llenando credenciales...');
    await llenarCredenciales(page, sinoeUsuario, sinoePassword);
    await delay(1000);
    
    // ========================================================================
    // PASO 7: Cerrar popup si apareció después de llenar
    // ========================================================================
    if (await hayPopupVisible(page)) {
      log('info', `SCRAPER:${requestId}`, 'Popup detectado después de llenar, cerrando...');
      await cerrarPopups(page);
      await delay(500);
    }
    
    // ========================================================================
    // PASO 8: Asegurar CAPTCHA válido
    // ========================================================================
    log('info', `SCRAPER:${requestId}`, 'Verificando que el CAPTCHA sea válido...');
    await asegurarCaptchaValido(page, sinoeUsuario, sinoePassword);
    
    // ========================================================================
    // PASO 9: Capturar formulario completo
    // ========================================================================
    log('info', `SCRAPER:${requestId}`, 'Capturando formulario de login...');
    
    const screenshotBase64 = await capturarFormularioLogin(page);
    
    if (!screenshotBase64 || screenshotBase64.length < 1000) {
      throw new Error('No se pudo capturar el formulario de login');
    }
    
    log('success', `SCRAPER:${requestId}`, 'Formulario capturado', { 
      bytes: screenshotBase64.length 
    });
    
    // ========================================================================
    // PASO 10: Enviar imagen por WhatsApp
    // ========================================================================
    log('info', `SCRAPER:${requestId}`, 'Enviando imagen por WhatsApp...');
    
    const caption = `📩 ${nombreAbogado}, escriba el código CAPTCHA que ve en la imagen y envíelo como respuesta.\n\n⏱️ Tiene 5 minutos.\n🔒 Credenciales ya llenadas.`;
    
    if (!await enviarWhatsAppImagen(whatsappNumero, screenshotBase64, caption)) {
      throw new Error('No se pudo enviar la imagen por WhatsApp');
    }
    
    // ========================================================================
    // PASO 11: Esperar respuesta del abogado
    // ========================================================================
    log('info', `SCRAPER:${requestId}`, 'Esperando respuesta del abogado (máx 5 min)...');
    
    const captchaTexto = await new Promise((resolve, reject) => {
      // v4.6.8-FIX: Crear timeout y guardar su ID para poder cancelarlo
      const timeoutId = setTimeout(() => {
        if (sesionesActivas.has(whatsappNumero)) {
          const s = sesionesActivas.get(whatsappNumero);
          if (s.requestId === requestId) {
            sesionesActivas.delete(whatsappNumero);
            reject(new Error('Timeout: CAPTCHA no resuelto en 5 minutos'));
          }
        }
      }, TIMEOUT.captcha);
      
      // v4.6.8-FIX: Guardar timeoutId en la sesión para poder cancelarlo después
      sesionesActivas.set(whatsappNumero, {
        page, 
        browser, 
        resolve, 
        reject,
        timeoutId,  // v4.6.8: Guardar referencia al timeout
        timestamp: Date.now(),
        nombreAbogado, 
        requestId
      });
    });
    
    metricas.captchasRecibidos++;
    log('success', `SCRAPER:${requestId}`, `CAPTCHA recibido: ${captchaTexto}`);
    
    // ========================================================================
    // PASO 12: Escribir CAPTCHA y hacer clic en login
    // ========================================================================
    log('info', `SCRAPER:${requestId}`, 'Escribiendo CAPTCHA en el formulario...');
    
    const campoCaptcha = await page.$('input[placeholder*="CAPTCHA"], input[placeholder*="Captcha"], input[placeholder*="captcha"], input[id*="captcha"]');
    
    if (!campoCaptcha) {
      throw new Error('Campo de CAPTCHA no encontrado en la página');
    }
    
    // Limpiar y escribir CAPTCHA
    await campoCaptcha.click({ clickCount: 3 });
    await delay(100);
    await page.keyboard.press('Backspace');
    await delay(100);
    await campoCaptcha.type(captchaTexto.toUpperCase(), { delay: 50 });
    
    // v4.6.7-FIX: Usar obtenerUrlSegura en lugar de page.url() directo
    const urlAntes = await obtenerUrlSegura(page) || SINOE_URLS.login;
    log('info', `SCRAPER:${requestId}`, 'Haciendo clic en botón de login...', { urlAntes });
    
    // Buscar y hacer clic en botón de login
    const btnIngresar = await page.$('button[type="submit"], input[type="submit"], .ui-button');
    if (btnIngresar) {
      await btnIngresar.click();
    } else {
      await page.keyboard.press('Enter');
    }
    
    // ========================================================================
    // PASO 13: v4.6.6 - MANEJO POST-LOGIN CON RECUPERACIÓN AGRESIVA
    // ========================================================================
    
    const resultadoPostLogin = await manejarPostLogin(page, browser, requestId, urlAntes);
    
    // Si se usó recuperación con nueva página, actualizar referencia
    if (resultadoPostLogin.newPage) {
      log('info', `SCRAPER:${requestId}`, 'Usando nueva página recuperada');
      page = resultadoPostLogin.newPage;
    }
    
    if (!resultadoPostLogin.success) {
      // Enviar mensaje de error específico al abogado
      if (resultadoPostLogin.error === 'CAPTCHA incorrecto') {
        await enviarWhatsAppTexto(whatsappNumero, `❌ CAPTCHA incorrecto. Por favor intente de nuevo.`);
      } else if (resultadoPostLogin.error === 'Sesión activa detectada') {
        await enviarWhatsAppTexto(whatsappNumero, `⚠️ Hay una sesión activa en SINOE. Por favor ciérrela e intente de nuevo.`);
      }
      throw new Error(resultadoPostLogin.error);
    }
    
    log('success', `SCRAPER:${requestId}`, 'Login exitoso en SINOE', {
      url: resultadoPostLogin.url?.substring(0, 60),
      tiempoPostLogin: resultadoPostLogin.tiempoMs,
      usedRecovery: resultadoPostLogin.usedRecovery || false
    });
    
    // ========================================================================
    // PASO 14: Navegar a Casillas
    // ========================================================================
    const hrefCasillas = await buscarLinkCasillas(page);
    if (hrefCasillas) {
      log('info', `SCRAPER:${requestId}`, 'Navegando a Casillas...', { href: hrefCasillas.substring(0, 60) });
      await page.goto(hrefCasillas, { waitUntil: 'networkidle2' });
      
      // Esperar a que el frame esté listo después de navegación
      await esperarFrameConPolling(page, requestId, 10);
    }
    
    // ========================================================================
    // PASO 15: Extraer notificaciones
    // ========================================================================
    const notificaciones = await extraerNotificaciones(page);
    
    // ========================================================================
    // ÉXITO
    // ========================================================================
    const duracionMs = Date.now() - inicioMs;
    metricas.scrapersExitosos++;
    
    // Actualizar tiempo promedio
    const totalExitosos = metricas.scrapersExitosos;
    metricas.tiempoPromedioMs = Math.round(
      ((metricas.tiempoPromedioMs * (totalExitosos - 1)) + duracionMs) / totalExitosos
    );
    
    // Notificar al abogado
    await enviarWhatsAppTexto(whatsappNumero,
      `✅ ${nombreAbogado}, acceso exitoso a SINOE.\n\n📋 ${notificaciones.length} notificación(es) encontrada(s).\n\nProcesando documentos...`
    );
    
    log('success', `SCRAPER:${requestId}`, 'Scraper completado exitosamente', { 
      duracionMs, 
      notificaciones: notificaciones.length 
    });
    
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
    
    // No enviar mensaje si ya se envió uno específico
    if (!error.message.includes('CAPTCHA incorrecto') && 
        !error.message.includes('Sesión activa') &&
        !error.message.includes('CAPTCHA no cargó')) {
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
    // v4.6.8-FIX: Cancelar timeout antes de eliminar sesión
    const sesionFinal = sesionesActivas.get(whatsappNumero);
    if (sesionFinal?.timeoutId) {
      clearTimeout(sesionFinal.timeoutId);
      log('debug', `SCRAPER:${requestId}`, 'Timeout de CAPTCHA cancelado en cleanup');
    }
    
    // Limpieza
    sesionesActivas.delete(whatsappNumero);
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

// ============================================================================
// ENDPOINTS - PRINCIPAL
// ============================================================================

/**
 * GET /health - Estado del servicio
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'lexa-scraper-service',
    version: '4.6.8',
    uptime: process.uptime(),
    sesionesActivas: sesionesActivas.size,
    metricas: {
      exitosos: metricas.scrapersExitosos,
      fallidos: metricas.scrapersFallidos,
      frameRecoveries: metricas.frameRecoveries,
      newPageCreations: metricas.newPageCreations,
      sesionesActivasCerradas: metricas.sesionesActivasCerradas,
      tasaExito: metricas.scrapersIniciados > 0 
        ? Math.round((metricas.scrapersExitosos / metricas.scrapersIniciados) * 100) + '%' 
        : 'N/A'
    }
  });
});

/**
 * POST /scraper - Iniciar proceso de scraping
 */
app.post('/scraper', async (req, res) => {
  const { sinoeUsuario, sinoePassword, whatsappNumero, nombreAbogado } = req.body;
  
  // Validaciones
  if (!sinoeUsuario || !sinoePassword) {
    return res.status(400).json({ 
      success: false, 
      error: 'Faltan credenciales SINOE (sinoeUsuario, sinoePassword)' 
    });
  }
  
  const validacion = validarNumeroWhatsApp(whatsappNumero);
  if (!validacion.valido) {
    return res.status(400).json({ 
      success: false, 
      error: validacion.error 
    });
  }
  
  // Verificar que no haya sesión activa para este número
  if (sesionesActivas.has(validacion.numero)) {
    return res.status(409).json({ 
      success: false, 
      error: 'Ya hay una sesión activa para este número de WhatsApp' 
    });
  }
  
  // Ejecutar scraper
  const resultado = await ejecutarScraper({
    sinoeUsuario,
    sinoePassword,
    whatsappNumero: validacion.numero,
    nombreAbogado: nombreAbogado || 'Estimado usuario'
  });
  
  const statusCode = resultado.success ? 200 : (resultado.timeout ? 408 : 500);
  res.status(statusCode).json(resultado);
});

/**
 * POST /webhook/whatsapp - Recibir CAPTCHA del abogado
 */
app.post('/webhook/whatsapp', async (req, res) => {
  try {
    const data = req.body;
    
    log('info', 'WEBHOOK', 'Evento recibido', { 
      event: data.event,
      instance: data.instance
    });
    
    // Solo procesar mensajes entrantes
    const eventLower = (data.event || '').toLowerCase().replace('_', '.');
    if (eventLower !== 'messages.upsert') {
      return res.status(200).json({ ignored: true, reason: `event: ${data.event}` });
    }
    
    const message = data.data;
    
    // Validar estructura del mensaje
    if (!message?.key?.remoteJid || message.key.fromMe) {
      return res.status(200).json({ ignored: true, reason: 'invalid structure or fromMe' });
    }
    
    // Extraer número
    const numero = message.key.remoteJid
      .replace('@s.whatsapp.net', '')
      .replace('@c.us', '');
    
    // Extraer texto del mensaje
    let texto = message.message?.conversation || 
                message.message?.extendedTextMessage?.text || 
                message.message?.imageMessage?.caption || '';
    
    log('info', 'WEBHOOK', 'Mensaje', {
      numero: enmascarar(numero),
      texto: texto.substring(0, 20),
      tieneSession: sesionesActivas.has(numero)
    });
    
    // Ignorar si no hay texto
    if (!texto) {
      return res.status(200).json({ ignored: true, reason: 'no text' });
    }
    
    // Ignorar si no hay sesión activa para este número
    if (!sesionesActivas.has(numero)) {
      return res.status(200).json({ ignored: true, reason: 'no session' });
    }
    
    // Validar formato del CAPTCHA
    const validacion = validarCaptcha(texto);
    
    if (!validacion.valido) {
      await enviarWhatsAppTexto(numero, `⚠️ ${validacion.error}\n\n${validacion.sugerencia || ''}`);
      return res.status(200).json({ ignored: true, reason: 'invalid captcha' });
    }
    
    // Resolver la promesa con el CAPTCHA
    // v4.6.7-FIX: Verificar que la sesión aún existe y tiene resolve válido
    const sesion = sesionesActivas.get(numero);
    if (!sesion || typeof sesion.resolve !== 'function') {
      log('warn', 'WEBHOOK', 'Sesión expiró durante procesamiento', {
        numero: enmascarar(numero)
      });
      return res.status(200).json({ ignored: true, reason: 'session expired during processing' });
    }
    
    // v4.6.8-FIX: Cancelar el timeout ANTES de resolver la promesa
    if (sesion.timeoutId) {
      clearTimeout(sesion.timeoutId);
      log('debug', 'WEBHOOK', 'Timeout de CAPTCHA cancelado');
    }
    
    try {
      sesion.resolve(validacion.captcha);
    } catch (resolveError) {
      log('warn', 'WEBHOOK', `Error resolviendo promesa: ${resolveError.message}`);
      return res.status(200).json({ ignored: true, reason: 'resolve failed' });
    }
    
    log('success', 'WEBHOOK', 'CAPTCHA procesado', { 
      numero: enmascarar(numero),
      captcha: validacion.captcha
    });
    
    return res.status(200).json({ success: true });
    
  } catch (error) {
    log('error', 'WEBHOOK', error.message);
    return res.status(200).json({ error: error.message });
  }
});

// ============================================================================
// ENDPOINTS - MONITOREO
// ============================================================================

/**
 * GET /sesiones - Listar sesiones activas
 */
app.get('/sesiones', (req, res) => {
  const sesiones = [];
  for (const [numero, sesion] of sesionesActivas.entries()) {
    sesiones.push({
      numero: enmascarar(numero),
      nombreAbogado: sesion.nombreAbogado,
      requestId: sesion.requestId,
      esperandoDesde: Math.round((Date.now() - sesion.timestamp) / 1000) + 's'
    });
  }
  res.json({ 
    total: sesionesActivas.size, 
    sesiones 
  });
});

/**
 * GET /metricas - Métricas detalladas del servicio
 */
app.get('/metricas', (req, res) => {
  res.json({
    ...metricas,
    sesionesActivas: sesionesActivas.size,
    memoriaUsada: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB',
    uptime: Math.round(process.uptime()) + 's'
  });
});

// ============================================================================
// ENDPOINTS - DIAGNÓSTICO
// ============================================================================

/**
 * POST /test-whatsapp - Probar envío de WhatsApp
 */
app.post('/test-whatsapp', async (req, res) => {
  const validacion = validarNumeroWhatsApp(req.body.numero);
  if (!validacion.valido) {
    return res.status(400).json({ success: false, error: validacion.error });
  }
  
  const resultado = await enviarWhatsAppTexto(
    validacion.numero, 
    req.body.mensaje || '🧪 Test LEXA Scraper v4.6.8'
  );
  res.json({ success: resultado });
});

/**
 * POST /test-conexion - Probar conexión a Browserless
 */
app.post('/test-conexion', async (req, res) => {
  let browser = null;
  try {
    const ws = CONFIG.browserless.token 
      ? `${CONFIG.browserless.url}?token=${CONFIG.browserless.token}`
      : CONFIG.browserless.url;
    
    browser = await puppeteer.connect({ browserWSEndpoint: ws });
    const page = await browser.newPage();
    await page.goto('https://www.google.com', { timeout: 30000 });
    const title = await page.title();
    
    res.json({ 
      success: true, 
      message: 'Conexión a Browserless OK',
      testPage: title
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

/**
 * POST /test-credenciales - Probar llenado de credenciales sin hacer login
 */
app.post('/test-credenciales', async (req, res) => {
  let browser = null;
  try {
    const { usuario, password } = req.body;
    
    if (!usuario || !password) {
      return res.status(400).json({ 
        success: false, 
        error: 'Faltan usuario y password en el body' 
      });
    }
    
    const ws = CONFIG.browserless.token 
      ? `${CONFIG.browserless.url}?token=${CONFIG.browserless.token}`
      : CONFIG.browserless.url;
    
    browser = await puppeteer.connect({ 
      browserWSEndpoint: ws,
      defaultViewport: DEFAULT_VIEWPORT
    });
    
    const page = await browser.newPage();
    await page.goto(SINOE_URLS.login, { waitUntil: 'networkidle2' });
    await delay(3000);
    
    // Cerrar popups
    await cerrarPopups(page);
    await delay(1000);
    
    // Llenar credenciales
    await llenarCredenciales(page, usuario, password);
    await delay(500);
    
    // Verificar valores
    const valores = await evaluarSeguro(page, () => {
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
      
      return { 
        usuario: user, 
        password: pass.length > 0 ? '***' : '(vacío)',
        usuarioLength: user.length,
        passwordLength: pass.length
      };
    });
    
    // Verificar CAPTCHA
    const estadoCaptcha = await verificarCaptchaValido(page);
    
    // Capturar screenshot
    const screenshot = await capturarFormularioLogin(page);
    
    res.json({
      success: true,
      valores,
      captcha: estadoCaptcha,
      screenshotBytes: screenshot.length
    });
    
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

/**
 * POST /test-captcha - Diagnosticar detección de CAPTCHA
 */
app.post('/test-captcha', async (req, res) => {
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
    await page.goto(SINOE_URLS.login, { waitUntil: 'networkidle2' });
    await delay(3000);
    
    // Cerrar popups
    await cerrarPopups(page);
    await delay(1000);
    
    // Diagnóstico detallado
    const diagnostico = await evaluarSeguro(page, () => {
      const resultado = {
        imagenes: [],
        canvas: [],
        elementosConBackground: [],
        inputCaptcha: null,
        divsCercaCaptcha: []
      };
      
      // Listar todas las imágenes
      document.querySelectorAll('img').forEach(img => {
        resultado.imagenes.push({
          src: (img.src || '').substring(0, 80),
          id: img.id || 'sin-id',
          clase: img.className || 'sin-clase',
          size: `${img.naturalWidth}x${img.naturalHeight}`,
          complete: img.complete
        });
      });
      
      // Listar canvas (algunos CAPTCHAs usan canvas)
      document.querySelectorAll('canvas').forEach(canvas => {
        resultado.canvas.push({
          id: canvas.id || 'sin-id',
          clase: canvas.className || 'sin-clase',
          size: `${canvas.width}x${canvas.height}`
        });
      });
      
      // Buscar elementos con background-image
      const todosElementos = document.querySelectorAll('div, span, td, a');
      todosElementos.forEach(el => {
        const bg = window.getComputedStyle(el).backgroundImage;
        if (bg && bg !== 'none' && !bg.includes('gradient')) {
          resultado.elementosConBackground.push({
            tag: el.tagName,
            id: el.id || 'sin-id',
            clase: (el.className || '').substring(0, 50),
            background: bg.substring(0, 100)
          });
        }
      });
      
      // Info del input de CAPTCHA
      const inputCaptcha = document.querySelector('input[id*="captcha"], input[placeholder*="Captcha"]');
      if (inputCaptcha) {
        resultado.inputCaptcha = {
          id: inputCaptcha.id,
          placeholder: inputCaptcha.placeholder,
          name: inputCaptcha.name,
          padreHTML: inputCaptcha.parentElement?.innerHTML?.substring(0, 500)
        };
        
        // Buscar elementos cercanos al input
        let padre = inputCaptcha.parentElement;
        for (let i = 0; i < 3 && padre; i++) {
          const hijos = padre.children;
          for (const hijo of hijos) {
            if (hijo !== inputCaptcha && hijo.tagName !== 'INPUT') {
              resultado.divsCercaCaptcha.push({
                tag: hijo.tagName,
                id: hijo.id || 'sin-id',
                clase: (hijo.className || '').substring(0, 30),
                innerHTML: hijo.innerHTML?.substring(0, 200)
              });
            }
          }
          padre = padre.parentElement;
        }
      }
      
      return resultado;
    });
    
    // Estado del CAPTCHA
    const estado = await verificarCaptchaValido(page);
    
    // Screenshot para inspección visual
    const screenshot = await page.screenshot({ encoding: 'base64' });
    
    res.json({
      success: true,
      captchaEstado: estado,
      diagnostico: {
        totalImagenes: diagnostico?.imagenes?.length || 0,
        imagenes: diagnostico?.imagenes || [],
        totalCanvas: diagnostico?.canvas?.length || 0,
        canvas: diagnostico?.canvas || [],
        elementosConBackground: diagnostico?.elementosConBackground?.slice(0, 10) || [],
        inputCaptcha: diagnostico?.inputCaptcha,
        divsCercaCaptcha: diagnostico?.divsCercaCaptcha?.slice(0, 5) || []
      },
      screenshotBase64Length: screenshot.length
    });
    
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

/**
 * Maneja el cierre limpio del servicio
 * @param {string} signal - Señal recibida (SIGTERM, SIGINT)
 */
async function shutdown(signal) {
  log('warn', 'SHUTDOWN', `Señal ${signal} recibida, cerrando...`);
  
  // Detener intervalo de limpieza
  if (limpiezaInterval) {
    clearInterval(limpiezaInterval);
    log('info', 'SHUTDOWN', 'Intervalo de limpieza detenido');
  }
  
  // Cerrar todas las sesiones activas
  for (const [numero, sesion] of sesionesActivas.entries()) {
    if (sesion.reject) {
      sesion.reject(new Error('Servidor reiniciándose'));
    }
    if (sesion.browser) {
      await sesion.browser.close().catch(() => {});
    }
    log('info', 'SHUTDOWN', `Sesión cerrada: ${enmascarar(numero)}`);
  }
  
  log('info', 'SHUTDOWN', 'Todas las sesiones cerradas');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ============================================================================
// INICIAR SERVIDOR
// ============================================================================

app.listen(PORT, () => {
  iniciarLimpiezaAutomatica();
  
  const warnings = validarConfiguracion();
  
  if (!process.env.API_KEY) {
    // v4.6.7-FIX: No loguear API Key completa por seguridad
    log('warn', 'CONFIG', `API Key generada automáticamente: ${API_KEY.substring(0, 8)}...${API_KEY.substring(API_KEY.length - 4)}`);
  }
  
  warnings.forEach(w => log('warn', 'CONFIG', w));
  
  console.log(`
╔═══════════════════════════════════════════════════════════════════════════╗
║                                                                           ║
║     LEXA SCRAPER SERVICE v4.6.8 - Session Handler & Memory Fixes          ║
║     Versión AAA (Producción - Auditoría Completa)                         ║
║                                                                           ║
╠═══════════════════════════════════════════════════════════════════════════╣
║                                                                           ║
║  Configuración:                                                           ║
║    Puerto:      ${String(PORT).padEnd(56)}║
║    Auth:        ${(process.env.API_KEY ? 'Configurada ✓' : 'Auto-generada ⚠️').padEnd(56)}║
║    WhatsApp:    ${(CONFIG.evolution.apiKey ? 'Configurado ✓' : 'NO CONFIGURADO ❌').padEnd(56)}║
║    Browserless: ${(CONFIG.browserless.token ? 'Configurado ✓' : 'Sin token ⚠️').padEnd(56)}║
║                                                                           ║
╠═══════════════════════════════════════════════════════════════════════════╣
║                                                                           ║
║  CORRECCIONES v4.6.8 (Session Handler & Memory):                          ║
║    ✓ NUEVO: manejarSesionActiva() - clic auto en FINALIZAR SESIONES       ║
║    ✓ FIX: setTimeout de CAPTCHA ahora se CANCELA cuando se resuelve       ║
║    ✓ FIX: analizarResultadoLogin() analiza contenido + URL                ║
║    ✓ FIX: Sesión activa se intenta cerrar automáticamente                 ║
║    ✓ FIX: Memory leaks de timeouts eliminados                             ║
║                                                                           ║
║  HEREDADO de v4.6.7:                                                      ║
║    ✓ waitForNavigation() eliminado (usa polling)                          ║
║    ✓ obtenerUrlSegura() en lugar de page.url()                            ║
║    ✓ Race condition en webhook solucionado                                ║
║                                                                           ║
║  HEREDADO de v4.6.6:                                                      ║
║    ✓ "Requesting main frame too early!" SOLUCIONADO                       ║
║    ✓ Si frame roto → crea NUEVA página y navega                           ║
║                                                                           ║
╠═══════════════════════════════════════════════════════════════════════════╣
║                                                                           ║
║  ENDPOINTS:                                                               ║
║                                                                           ║
║    Principal:                                                             ║
║      GET  /health              Estado del servicio                        ║
║      POST /scraper             Iniciar scraping (requiere API Key)        ║
║      POST /webhook/whatsapp    Recibir CAPTCHA del abogado (público)      ║
║                                                                           ║
║    Monitoreo:                                                             ║
║      GET  /sesiones            Listar sesiones activas                    ║
║      GET  /metricas            Métricas detalladas                        ║
║                                                                           ║
║    Diagnóstico:                                                           ║
║      POST /test-whatsapp       Probar envío de WhatsApp                   ║
║      POST /test-conexion       Probar conexión a Browserless              ║
║      POST /test-credenciales   Probar llenado de credenciales             ║
║      POST /test-captcha        Diagnosticar detección de CAPTCHA          ║
║                                                                           ║
╚═══════════════════════════════════════════════════════════════════════════╝
  `);
});
