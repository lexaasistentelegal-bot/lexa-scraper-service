/**
 * ============================================================
 * LEXA SCRAPER SERVICE v4.6.0 - Sistema Screenshot CAPTCHA
 * ============================================================
 * Versión: AAA (Producción)
 * Fecha: Febrero 2026
 * 
 * CAMBIOS v4.6.0:
 * - FIX CRÍTICO: No envía imagen si el CAPTCHA no cargó correctamente
 * - NUEVO: Función asegurarCaptchaValido() - validación estricta antes de enviar
 * - NUEVO: Recarga CAPTCHA automáticamente hasta que sea válido (max 5 intentos)
 * - NUEVO: Re-llena credenciales después de refresh de página
 * - NUEVO: Bloquea el proceso si el CAPTCHA no carga después de intentos
 * - MEJORA: Validación de dimensiones más estricta para detectar imágenes rotas
 * - MEJORA: Logging detallado del estado del CAPTCHA en cada intento
 * 
 * CAMBIOS v4.5.0 (mantenidos):
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

// Selectores CSS para SINOE V.2.2.2
const SELECTORES = {
  // Campos de login
  usuario: 'input[placeholder="Usuario"]',
  password: 'input[placeholder="Contraseña"]',
  
  // CAPTCHA
  captchaInput: 'input[placeholder*="CAPTCHA"], input[placeholder*="Captcha"], input[placeholder*="captcha"], input[id*="captcha"]',
  captchaImg: 'img[id*="captcha"], img[src*="captcha"], img[src*="Captcha"]',
  captchaRefresh: 'a[onclick*="captcha"], button[onclick*="captcha"], img[onclick*="captcha"], .ui-commandlink[onclick*="captcha"]',
  
  // Formulario de login (para captura completa)
  formularioLogin: '.ui-panel, .ui-panel-content, form, .login-form, .login-container',
  
  // Botones
  btnIngresar: 'button[type="submit"], input[type="submit"], .ui-button',
  
  // Tabla de notificaciones
  tablaNotificaciones: 'table tbody tr, .ui-datatable-data tr'
};

// Timeouts
const TIMEOUT = {
  navegacion: 60000,      // 1 minuto para cargar páginas
  captcha: 300000,        // 5 minutos para que el abogado resuelva el CAPTCHA
  api: 30000,             // 30 segundos para llamadas a APIs externas
  popup: 10000,           // 10 segundos para cerrar popups
  elemento: 15000,        // 15 segundos para esperar elementos en el DOM
  imagenCarga: 5000       // 5 segundos para que cargue una imagen
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
  windowMs: 60000,        // Ventana de 1 minuto
  maxRequestsPerIp: 30    // Máximo 30 requests por IP por minuto
};

// Configuración de validación de CAPTCHA v4.6.0
const CAPTCHA_CONFIG = {
  maxIntentos: 5,           // Máximo intentos de recarga antes de fallar
  minWidth: 80,             // Ancho mínimo en px para considerar CAPTCHA válido
  maxWidth: 200,            // Ancho máximo en px
  minHeight: 25,            // Alto mínimo en px
  maxHeight: 60,            // Alto máximo en px
  esperaEntreCarga: 2000,   // ms a esperar después de recargar CAPTCHA
  esperaDespuesRefresh: 3000 // ms a esperar después de refresh de página
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
  captchasFallidos: 0,      // v4.6.0: CAPTCHAs que no cargaron
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
  
  // Limpiar sesiones expiradas (más de 6 minutos)
  for (const [numero, sesion] of sesionesActivas.entries()) {
    if (ahora - sesion.timestamp > 360000) {
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
}, 60000);

// ============================================================
// UTILIDADES
// ============================================================

/**
 * Enmascara texto sensible para logging seguro
 * @param {string} texto - Texto a enmascarar
 * @returns {string} Texto enmascarado (ej: "519***50")
 */
function enmascarar(texto) {
  if (!texto || texto.length < 6) return '***';
  return texto.substring(0, 3) + '***' + texto.substring(texto.length - 2);
}

/**
 * Espera asíncrona
 * @param {number} ms - Milisegundos a esperar
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Logging estructurado con soporte para producción (JSON) y desarrollo (legible)
 * @param {string} nivel - Nivel del log: debug, info, warn, error, success
 * @param {string} contexto - Contexto/módulo del log
 * @param {string} mensaje - Mensaje del log
 * @param {object} datos - Datos adicionales opcionales
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
    // En producción: JSON estructurado para parsing
    console.log(JSON.stringify({ 
      timestamp, 
      nivel, 
      contexto, 
      mensaje, 
      ...datos 
    }));
  } else {
    // En desarrollo: formato legible con iconos
    console.log(
      `[${timestamp}] ${iconos[nivel] || '•'} [${contexto}] ${mensaje}`, 
      Object.keys(datos).length > 0 ? datos : ''
    );
  }
}

/**
 * Valida formato de número de WhatsApp peruano
 * @param {string} numero - Número a validar
 * @returns {{valido: boolean, error?: string, numero?: string}}
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
 * Valida texto de CAPTCHA
 * @param {string} texto - Texto del CAPTCHA
 * @returns {{valido: boolean, error?: string, sugerencia?: string, captcha?: string}}
 */
function validarCaptcha(texto) {
  if (!texto || typeof texto !== 'string') {
    return { valido: false, error: 'Texto vacío' };
  }
  
  // Limpiar y normalizar
  const limpio = texto.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  
  // El CAPTCHA de SINOE tiene 5 caracteres alfanuméricos
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

// Parser JSON con límite de tamaño
app.use(express.json({ limit: '1mb' }));

// Rate limiting por IP
app.use((req, res, next) => {
  // Excluir health check del rate limit
  if (req.path === '/health') return next();
  
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const ahora = Date.now();
  
  if (!rateLimitCache.has(ip)) {
    rateLimitCache.set(ip, { count: 1, timestamp: ahora });
    return next();
  }
  
  const data = rateLimitCache.get(ip);
  
  // Resetear ventana si expiró
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

// Autenticación por API Key (excepto endpoints públicos)
app.use((req, res, next) => {
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

// Contador de requests para métricas
app.use((req, res, next) => {
  metricas.requestsTotal++;
  next();
});

// ============================================================
// FUNCIONES WHATSAPP CON REINTENTOS
// ============================================================

/**
 * Envía mensaje de texto por WhatsApp con reintentos
 * @param {string} numero - Número de WhatsApp (formato: 51XXXXXXXXX)
 * @param {string} mensaje - Texto del mensaje
 * @param {number} intentos - Número máximo de intentos
 * @returns {Promise<boolean>} true si se envió correctamente
 */
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
    
    // Espera exponencial entre reintentos
    if (i < intentos) await delay(1000 * i);
  }
  
  log('error', 'WHATSAPP', 'No se pudo enviar texto después de todos los intentos', {
    numero: enmascarar(numero)
  });
  return false;
}

/**
 * Envía imagen por WhatsApp con reintentos
 * @param {string} numero - Número de WhatsApp
 * @param {string} base64Image - Imagen en base64 (sin prefijo data:)
 * @param {string} caption - Texto que acompaña la imagen
 * @param {number} intentos - Número máximo de intentos
 * @returns {Promise<boolean>} true si se envió correctamente
 */
async function enviarWhatsAppImagen(numero, base64Image, caption, intentos = 3) {
  // Validar que la imagen no esté vacía o corrupta
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

// ============================================================
// FUNCIONES DE SCRAPING - v4.6.0
// ============================================================

/**
 * Verifica si hay un popup/modal visible en la página (PrimeFaces)
 * @param {Page} page - Instancia de Puppeteer Page
 * @returns {Promise<boolean>} true si hay popup visible
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
    
    // Buscar por texto específico del popup de términos de SINOE
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
 * Cierra popups de SINOE (términos, avisos, etc.)
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
      const clicExitoso = await page.evaluate(() => {
        const botones = document.querySelectorAll('button, .ui-button, input[type="button"], a.ui-button');
        
        for (const boton of botones) {
          const texto = (boton.textContent || boton.value || '').toLowerCase().trim();
          const rect = boton.getBoundingClientRect();
          
          // Verificar que el botón es visible y clickeable
          if (rect.width > 0 && rect.height > 0 && rect.top >= 0) {
            if (texto === 'aceptar' || texto === 'acepto' || texto === 'ok' || texto === 'cerrar') {
              boton.click();
              return { clicked: true, texto: texto };
            }
          }
        }
        
        // Fallback: buscar botones en el dialog
        const dialogButtons = document.querySelectorAll('.ui-dialog-buttonset button, .ui-dialog-buttonpane button');
        if (dialogButtons.length > 0) {
          dialogButtons[0].click();
          return { clicked: true, texto: 'primer botón de diálogo' };
        }
        
        return { clicked: false };
      });
      
      if (clicExitoso.clicked) {
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
        // Si no encontramos botón, intentar con Escape
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

/**
 * FUNCIÓN CRÍTICA v4.5.0: Llena credenciales de forma robusta para PrimeFaces
 * Usa múltiples métodos para asegurar que el valor se guarde
 * @param {Page} page - Instancia de Puppeteer Page
 * @param {string} usuario - Usuario de SINOE
 * @param {string} password - Contraseña de SINOE
 * @returns {Promise<boolean>} true si se llenaron correctamente
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
 * Verifica si la imagen del CAPTCHA cargó correctamente
 * @param {Page} page - Instancia de Puppeteer Page
 * @returns {Promise<{valido: boolean, razon: string, width?: number, height?: number}>}
 */
async function verificarCaptchaValido(page) {
  return await page.evaluate((config) => {
    const imagenes = document.querySelectorAll('img');
    
    for (const img of imagenes) {
      const src = (img.src || '').toLowerCase();
      const id = (img.id || '').toLowerCase();
      
      // Buscar imagen que contenga "captcha" en src o id
      if (src.includes('captcha') || id.includes('captcha')) {
        // Verificar si la imagen está cargando todavía
        if (!img.complete) {
          return { valido: false, razon: 'Imagen aún cargando' };
        }
        
        // Verificar dimensiones naturales (imagen real cargada)
        if (img.naturalWidth === 0 || img.naturalHeight === 0) {
          return { valido: false, razon: 'Imagen no cargó (dimensiones 0)' };
        }
        
        // El CAPTCHA de SINOE tiene ~100-150px ancho x ~30-50px alto
        // Si las dimensiones son muy diferentes, es imagen rota/placeholder
        if (img.naturalWidth < config.minWidth || img.naturalWidth > config.maxWidth) {
          return { 
            valido: false, 
            razon: `Ancho inválido: ${img.naturalWidth}px (esperado: ${config.minWidth}-${config.maxWidth}px)` 
          };
        }
        
        if (img.naturalHeight < config.minHeight || img.naturalHeight > config.maxHeight) {
          return { 
            valido: false, 
            razon: `Alto inválido: ${img.naturalHeight}px (esperado: ${config.minHeight}-${config.maxHeight}px)` 
          };
        }
        
        // Verificar que el src tiene formato de imagen dinámica (no placeholder)
        if (src.includes('placeholder') || src.includes('error') || src.includes('default')) {
          return { valido: false, razon: 'Imagen es placeholder/error' };
        }
        
        return { 
          valido: true, 
          razon: 'OK',
          width: img.naturalWidth,
          height: img.naturalHeight
        };
      }
    }
    
    return { valido: false, razon: 'No se encontró imagen de CAPTCHA en el DOM' };
  }, CAPTCHA_CONFIG);
}

/**
 * Recarga el CAPTCHA haciendo clic en el botón de refresh
 * @param {Page} page - Instancia de Puppeteer Page
 * @returns {Promise<boolean>} true si se encontró y clickeó el botón de recarga
 */
async function recargarCaptcha(page) {
  log('info', 'CAPTCHA', 'Intentando recargar CAPTCHA...');
  
  const recargado = await page.evaluate(() => {
    // MÉTODO 1: Buscar por onclick que contenga "captcha"
    const elementos = document.querySelectorAll('a, button, img, span, i');
    for (const el of elementos) {
      const onclick = el.getAttribute('onclick') || '';
      if (onclick.toLowerCase().includes('captcha') || onclick.toLowerCase().includes('refresh')) {
        el.click();
        return { clicked: true, metodo: 'onclick con captcha/refresh' };
      }
    }
    
    // MÉTODO 2: Buscar ícono de refresh cerca del CAPTCHA
    const captchaImg = document.querySelector('img[src*="captcha"], img[id*="captcha"]');
    if (captchaImg) {
      const rect = captchaImg.getBoundingClientRect();
      
      // Buscar elementos clickeables a la derecha de la imagen (donde suele estar el refresh)
      const elementosCerca = document.elementsFromPoint(rect.right + 25, rect.top + rect.height / 2);
      for (const el of elementosCerca) {
        if (el.tagName === 'A' || el.tagName === 'BUTTON' || el.tagName === 'IMG' || 
            el.classList.contains('ui-commandlink') || el.onclick) {
          el.click();
          return { clicked: true, metodo: 'elemento cercano al CAPTCHA' };
        }
      }
    }
    
    // MÉTODO 3: Buscar por clase de PrimeFaces
    const refreshBtn = document.querySelector('.ui-commandlink[id*="captcha"], a[id*="refresh"], a[id*="Refresh"]');
    if (refreshBtn) {
      refreshBtn.click();
      return { clicked: true, metodo: 'ui-commandlink' };
    }
    
    return { clicked: false };
  });
  
  if (recargado.clicked) {
    log('info', 'CAPTCHA', `Botón de recarga clickeado (${recargado.metodo})`);
    metricas.captchasRecargados++;
    // Esperar a que cargue la nueva imagen
    await delay(CAPTCHA_CONFIG.esperaEntreCarga);
    return true;
  }
  
  log('warn', 'CAPTCHA', 'No se encontró botón de recarga del CAPTCHA');
  return false;
}

/**
 * v4.6.0 - FUNCIÓN CRÍTICA: Asegura que el CAPTCHA sea válido antes de continuar
 * Si no es válido, recarga el CAPTCHA y re-llena credenciales si es necesario.
 * Máximo CAPTCHA_CONFIG.maxIntentos intentos antes de fallar.
 * 
 * @param {Page} page - Instancia de Puppeteer Page
 * @param {string} usuario - Usuario de SINOE (para re-llenar si hay refresh)
 * @param {string} password - Contraseña de SINOE (para re-llenar si hay refresh)
 * @returns {Promise<boolean>} true si el CAPTCHA es válido
 * @throws {Error} si no se pudo cargar el CAPTCHA después de todos los intentos
 */
async function asegurarCaptchaValido(page, usuario, password) {
  const maxIntentos = CAPTCHA_CONFIG.maxIntentos;
  
  log('info', 'CAPTCHA', `Verificando CAPTCHA (máximo ${maxIntentos} intentos)...`);
  
  for (let intento = 1; intento <= maxIntentos; intento++) {
    // Verificar estado actual del CAPTCHA
    const estado = await verificarCaptchaValido(page);
    
    if (estado.valido) {
      log('success', 'CAPTCHA', `✓ CAPTCHA válido en intento ${intento}/${maxIntentos}`, {
        width: estado.width,
        height: estado.height
      });
      return true;
    }
    
    log('warn', 'CAPTCHA', `Intento ${intento}/${maxIntentos}: ${estado.razon}`);
    
    // Si es el último intento, no intentar recargar más
    if (intento === maxIntentos) {
      break;
    }
    
    // Intentar recargar el CAPTCHA con el botón de refresh
    const recargado = await recargarCaptcha(page);
    
    if (recargado) {
      // El botón de refresh funcionó, esperar a que cargue la nueva imagen
      log('info', 'CAPTCHA', 'Esperando a que cargue nueva imagen...');
      await delay(CAPTCHA_CONFIG.esperaEntreCarga);
    } else {
      // No encontró botón de recarga, hacer refresh de página completa
      log('info', 'CAPTCHA', 'No se encontró botón de recarga. Refrescando página completa...');
      
      await page.reload({ waitUntil: 'networkidle2' });
      await delay(CAPTCHA_CONFIG.esperaDespuesRefresh);
      
      // Cerrar popups que puedan aparecer después del refresh
      log('info', 'CAPTCHA', 'Cerrando popups después del refresh...');
      await cerrarPopups(page);
      await delay(500);
      
      // RE-LLENAR CREDENCIALES después del refresh (se perdieron)
      log('info', 'CAPTCHA', 'Re-llenando credenciales después del refresh...');
      try {
        await llenarCredenciales(page, usuario, password);
        await delay(500);
      } catch (e) {
        log('error', 'CAPTCHA', `Error al re-llenar credenciales: ${e.message}`);
      }
    }
    
    // Pequeña espera antes del siguiente intento de verificación
    await delay(1000);
  }
  
  // Si llegamos aquí, el CAPTCHA no cargó después de todos los intentos
  metricas.captchasFallidos++;
  
  const errorMsg = `El CAPTCHA no cargó correctamente después de ${maxIntentos} intentos. Por favor intente de nuevo.`;
  log('error', 'CAPTCHA', errorMsg);
  
  throw new Error(errorMsg);
}

/**
 * Captura screenshot del formulario completo de login
 * @param {Page} page - Instancia de Puppeteer Page
 * @returns {Promise<string>} Screenshot en base64
 */
async function capturarFormularioLogin(page) {
  log('info', 'CAPTURA', 'Capturando formulario de login...');
  
  // Verificar que no hay popups antes de capturar
  if (await hayPopupVisible(page)) {
    log('warn', 'CAPTURA', 'Hay popup visible, cerrándolo antes de capturar...');
    await cerrarPopups(page);
    await delay(500);
  }
  
  // Buscar el contenedor del formulario
  const formularioInfo = await page.evaluate(() => {
    // Selectores posibles para el panel de login
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
        // Verificar que contiene campos de login
        const tieneUsuario = el.querySelector('input[type="text"]');
        const tienePassword = el.querySelector('input[type="password"]');
        
        if (tieneUsuario && tienePassword) {
          const rect = el.getBoundingClientRect();
          
          // Verificar que tiene un tamaño razonable para un formulario
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
    
    // Fallback: buscar desde el CAPTCHA y subir en el DOM
    const captchaImg = document.querySelector('img[src*="captcha"], img[id*="captcha"]');
    if (captchaImg) {
      let container = captchaImg.parentElement;
      let nivel = 0;
      
      while (container && nivel < 10) {
        const rect = container.getBoundingClientRect();
        
        // Buscar un contenedor lo suficientemente grande
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
  
  if (formularioInfo.found) {
    log('info', 'CAPTURA', `Formulario encontrado (${formularioInfo.selector})`, {
      x: Math.round(formularioInfo.x),
      y: Math.round(formularioInfo.y),
      width: Math.round(formularioInfo.width),
      height: Math.round(formularioInfo.height)
    });
    
    // Capturar screenshot del área del formulario
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
  
  // FALLBACK: capturar área central de la pantalla
  log('warn', 'CAPTURA', 'Usando fallback - área central de pantalla');
  
  const viewport = await page.viewport();
  const centerX = (viewport.width - 500) / 2;
  const centerY = 100; // Empezar desde arriba para incluir logo
  
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
  log('error', 'CAPTURA', 'Capturando pantalla completa como último recurso');
  return await page.screenshot({ encoding: 'base64' });
}

/**
 * Busca el link correcto a Casillas/SINOE después del login
 * @param {Page} page - Instancia de Puppeteer Page
 * @returns {Promise<string|null>} URL del link o null si no se encuentra
 */
async function buscarLinkCasillas(page) {
  return await page.evaluate(() => {
    const links = document.querySelectorAll('a');
    
    for (const link of links) {
      const texto = (link.textContent || '').toLowerCase();
      const href = (link.href || '').toLowerCase();
      
      // Excluir links de recuperación de contraseña
      if (texto.includes('olvidó') || texto.includes('recuperar')) continue;
      
      // Buscar links que contengan "sinoe" o "casilla"
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
 * @param {Page} page - Instancia de Puppeteer Page
 * @returns {Promise<Array>} Array de notificaciones
 */
async function extraerNotificaciones(page) {
  // Esperar a que la tabla cargue
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
      if (celdas.length < 2) return; // Saltar filas vacías
      
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

/**
 * Ejecuta el flujo completo del scraper
 * @param {Object} params - Parámetros del scraper
 * @param {string} params.sinoeUsuario - Usuario de SINOE
 * @param {string} params.sinoePassword - Contraseña de SINOE
 * @param {string} params.whatsappNumero - Número de WhatsApp del abogado
 * @param {string} params.nombreAbogado - Nombre del abogado para personalizar mensajes
 * @returns {Promise<Object>} Resultado del scraping
 */
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
    
    log('success', `SCRAPER:${requestId}`, 'Conectado a Browserless');
    
    // ========================================
    // PASO 2: Navegar a SINOE
    // ========================================
    log('info', `SCRAPER:${requestId}`, 'Navegando a SINOE...');
    
    await page.goto(SINOE_URLS.login, { waitUntil: 'networkidle2' });
    await delay(3000);
    
    log('success', `SCRAPER:${requestId}`, 'Página de SINOE cargada');
    
    // ========================================
    // PASO 3: Manejar página de parámetros no válidos
    // ========================================
    const contenidoInicial = await page.content();
    if (contenidoInicial.includes('PARAMETROS DE SEGURIDAD NO VALIDOS') || 
        contenidoInicial.includes('PARAMETROS NO VALIDOS')) {
      log('info', `SCRAPER:${requestId}`, 'Página de parámetros detectada, navegando al inicio...');
      
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
    // PASO 4: Cerrar popups de términos/avisos
    // ========================================
    log('info', `SCRAPER:${requestId}`, 'Verificando y cerrando popups...');
    await cerrarPopups(page);
    await delay(1000);
    
    // ========================================
    // PASO 5: Esperar campos de login
    // ========================================
    log('info', `SCRAPER:${requestId}`, 'Esperando campos de login...');
    await page.waitForSelector('input[type="text"], input[type="password"]', { timeout: TIMEOUT.elemento });
    
    // Verificar si apareció popup después de esperar
    if (await hayPopupVisible(page)) {
      await cerrarPopups(page);
      await delay(500);
    }
    
    // ========================================
    // PASO 6: Llenar credenciales (v4.5.0)
    // ========================================
    log('info', `SCRAPER:${requestId}`, 'Llenando credenciales...');
    await llenarCredenciales(page, sinoeUsuario, sinoePassword);
    await delay(1000);
    
    // ========================================
    // PASO 7: Cerrar popup si apareció después de llenar
    // ========================================
    if (await hayPopupVisible(page)) {
      log('info', `SCRAPER:${requestId}`, 'Popup detectado después de llenar, cerrando...');
      await cerrarPopups(page);
      await delay(500);
    }
    
    // ========================================
    // PASO 8: ASEGURAR CAPTCHA VÁLIDO (v4.6.0)
    // CRÍTICO: No continúa si el CAPTCHA no cargó
    // ========================================
    log('info', `SCRAPER:${requestId}`, 'Verificando que el CAPTCHA sea válido...');
    await asegurarCaptchaValido(page, sinoeUsuario, sinoePassword);
    
    // ========================================
    // PASO 9: Capturar formulario completo
    // (Solo se ejecuta si el CAPTCHA es válido)
    // ========================================
    log('info', `SCRAPER:${requestId}`, 'Capturando formulario de login...');
    
    const screenshotBase64 = await capturarFormularioLogin(page);
    
    if (!screenshotBase64 || screenshotBase64.length < 1000) {
      throw new Error('No se pudo capturar el formulario de login');
    }
    
    log('success', `SCRAPER:${requestId}`, 'Formulario capturado', { 
      bytes: screenshotBase64.length 
    });
    
    // ========================================
    // PASO 10: Enviar imagen por WhatsApp
    // ========================================
    log('info', `SCRAPER:${requestId}`, 'Enviando imagen por WhatsApp...');
    
    const caption = `📩 ${nombreAbogado}, escriba el código CAPTCHA que ve en la imagen y envíelo como respuesta.\n\n⏱️ Tiene 5 minutos.\n🔒 Credenciales ya llenadas.`;
    
    if (!await enviarWhatsAppImagen(whatsappNumero, screenshotBase64, caption)) {
      throw new Error('No se pudo enviar la imagen por WhatsApp');
    }
    
    // ========================================
    // PASO 11: Esperar respuesta del abogado
    // ========================================
    log('info', `SCRAPER:${requestId}`, 'Esperando respuesta del abogado (máx 5 min)...');
    
    const captchaTexto = await new Promise((resolve, reject) => {
      // Registrar sesión activa
      sesionesActivas.set(whatsappNumero, {
        page, 
        browser, 
        resolve, 
        reject,
        timestamp: Date.now(),
        nombreAbogado, 
        requestId
      });
      
      // Timeout de 5 minutos
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
    // PASO 12: Escribir CAPTCHA y hacer login
    // ========================================
    log('info', `SCRAPER:${requestId}`, 'Escribiendo CAPTCHA en el formulario...');
    
    // Buscar campo de CAPTCHA
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
    
    const urlAntes = page.url();
    
    // Buscar y hacer clic en botón de ingreso
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
    // PASO 13: Verificar resultado del login
    // ========================================
    log('info', `SCRAPER:${requestId}`, 'Verificando resultado del login...');
    
    const urlActual = page.url();
    const contenidoActual = await page.content();
    
    // Verificar si el CAPTCHA fue incorrecto
    if (contenidoActual.toLowerCase().includes('captcha') && 
        (contenidoActual.toLowerCase().includes('incorrecto') || 
         contenidoActual.toLowerCase().includes('inválido') ||
         contenidoActual.toLowerCase().includes('invalido'))) {
      await enviarWhatsAppTexto(whatsappNumero, `❌ CAPTCHA incorrecto. Por favor intente de nuevo.`);
      throw new Error('CAPTCHA incorrecto');
    }
    
    // Verificar si hay sesión activa
    if (urlActual.includes(SINOE_URLS.sessionActiva) || contenidoActual.includes('sesión activa')) {
      await enviarWhatsAppTexto(whatsappNumero, `⚠️ Hay una sesión activa en SINOE. Por favor ciérrela e intente de nuevo.`);
      throw new Error('Sesión activa detectada');
    }
    
    log('success', `SCRAPER:${requestId}`, 'Login exitoso en SINOE');
    
    // ========================================
    // PASO 14: Navegar a Casillas
    // ========================================
    const hrefCasillas = await buscarLinkCasillas(page);
    if (hrefCasillas) {
      log('info', `SCRAPER:${requestId}`, 'Navegando a Casillas...');
      await page.goto(hrefCasillas, { waitUntil: 'networkidle2' });
    }
    
    // ========================================
    // PASO 15: Extraer notificaciones
    // ========================================
    log('info', `SCRAPER:${requestId}`, 'Extrayendo notificaciones...');
    const notificaciones = await extraerNotificaciones(page);
    
    // ========================================
    // ÉXITO - Enviar confirmación y retornar resultado
    // ========================================
    const duracionMs = Date.now() - inicioMs;
    metricas.scrapersExitosos++;
    
    // Actualizar tiempo promedio
    const totalExitosos = metricas.scrapersExitosos;
    metricas.tiempoPromedioMs = Math.round(
      ((metricas.tiempoPromedioMs * (totalExitosos - 1)) + duracionMs) / totalExitosos
    );
    
    // Enviar mensaje de éxito al abogado
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
    
    // Enviar error al usuario si no es error conocido (ya se envió mensaje específico)
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
    // Limpiar recursos
    sesionesActivas.delete(whatsappNumero);
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

// ============================================================
// ENDPOINTS
// ============================================================

/**
 * Health check - público
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'lexa-scraper-service',
    version: '4.6.0',
    uptime: process.uptime(),
    sesionesActivas: sesionesActivas.size,
    metricas: {
      exitosos: metricas.scrapersExitosos,
      fallidos: metricas.scrapersFallidos,
      captchasRecargados: metricas.captchasRecargados,
      captchasFallidos: metricas.captchasFallidos,
      tasaExito: metricas.scrapersIniciados > 0 
        ? Math.round((metricas.scrapersExitosos / metricas.scrapersIniciados) * 100) + '%' 
        : 'N/A'
    }
  });
});

/**
 * Endpoint principal del scraper
 */
app.post('/scraper', async (req, res) => {
  const { sinoeUsuario, sinoePassword, whatsappNumero, nombreAbogado } = req.body;
  
  // Validar parámetros requeridos
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
  
  // Verificar que no hay sesión activa para este número
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
  
  // Retornar resultado con código HTTP apropiado
  const statusCode = resultado.success ? 200 : (resultado.timeout ? 408 : 500);
  res.status(statusCode).json(resultado);
});

/**
 * Webhook para recibir mensajes de WhatsApp (Evolution API)
 */
app.post('/webhook/whatsapp', async (req, res) => {
  try {
    const data = req.body;
    
    // Verificar que es un evento de mensaje
    if (data.event !== 'messages.upsert') {
      return res.status(200).json({ ignored: true, reason: 'not messages.upsert' });
    }
    
    const message = data.data;
    
    // Validar estructura del mensaje
    if (!message?.key?.remoteJid || !message?.message || message.key.fromMe) {
      return res.status(200).json({ ignored: true, reason: 'invalid message structure' });
    }
    
    // Extraer número del remitente
    const numero = message.key.remoteJid
      .replace('@s.whatsapp.net', '')
      .replace('@c.us', '');
    
    // Extraer texto del mensaje
    let texto = message.message.conversation || 
                message.message.extendedTextMessage?.text || 
                message.message.imageMessage?.caption || '';
    
    if (!texto) {
      return res.status(200).json({ ignored: true, reason: 'no text content' });
    }
    
    // Verificar si hay sesión activa esperando CAPTCHA
    if (!sesionesActivas.has(numero)) {
      return res.status(200).json({ ignored: true, reason: 'no active session' });
    }
    
    // Validar formato del CAPTCHA
    const validacion = validarCaptcha(texto);
    
    if (!validacion.valido) {
      // Enviar mensaje de error al usuario
      await enviarWhatsAppTexto(numero, `⚠️ ${validacion.error}\n\n${validacion.sugerencia || ''}`);
      return res.status(200).json({ ignored: true, reason: 'invalid captcha format' });
    }
    
    // Resolver la promesa con el CAPTCHA válido
    const sesion = sesionesActivas.get(numero);
    sesion.resolve(validacion.captcha);
    
    log('success', 'WEBHOOK', 'CAPTCHA recibido y procesado', { 
      numero: enmascarar(numero),
      captchaLength: validacion.captcha.length
    });
    
    return res.status(200).json({ success: true });
    
  } catch (error) {
    log('error', 'WEBHOOK', error.message);
    // Siempre retornar 200 para que Evolution no reintente
    return res.status(200).json({ error: error.message });
  }
});

/**
 * Listar sesiones activas
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
 * Obtener métricas detalladas
 */
app.get('/metricas', (req, res) => {
  res.json({
    ...metricas,
    sesionesActivas: sesionesActivas.size,
    memoriaUsada: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB',
    uptime: Math.round(process.uptime()) + 's'
  });
});

/**
 * Test de envío de WhatsApp
 */
app.post('/test-whatsapp', async (req, res) => {
  const validacion = validarNumeroWhatsApp(req.body.numero);
  if (!validacion.valido) {
    return res.status(400).json({ success: false, error: validacion.error });
  }
  
  const resultado = await enviarWhatsAppTexto(
    validacion.numero, 
    req.body.mensaje || '🧪 Test LEXA Scraper v4.6.0'
  );
  res.json({ success: resultado });
});

/**
 * Test de conexión a Browserless
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
 * Test de llenado de credenciales (debug)
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
      defaultViewport: { width: 1366, height: 768 }
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
    
    // Verificar valores llenados
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
 * Test de validación de CAPTCHA (debug v4.6.0)
 */
app.post('/test-captcha', async (req, res) => {
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
    
    // Cerrar popups
    await cerrarPopups(page);
    await delay(1000);
    
    // Verificar estado del CAPTCHA
    const estado = await verificarCaptchaValido(page);
    
    // Intentar recargar si no es válido
    let recargado = false;
    if (!estado.valido) {
      recargado = await recargarCaptcha(page);
      await delay(2000);
    }
    
    // Verificar de nuevo
    const estadoDespues = await verificarCaptchaValido(page);
    
    res.json({
      success: true,
      captchaAntes: estado,
      seIntentóRecargar: !estado.valido,
      recargaExitosa: recargado,
      captchaDespues: estadoDespues
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

/**
 * Cierra todas las sesiones activas y libera recursos
 */
async function shutdown(signal) {
  log('warn', 'SHUTDOWN', `Señal ${signal} recibida, cerrando...`);
  
  // Rechazar todas las sesiones activas
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

// ============================================================
// INICIAR SERVIDOR
// ============================================================

app.listen(PORT, () => {
  if (!process.env.API_KEY) {
    log('warn', 'CONFIG', `API Key generada automáticamente: ${API_KEY}`);
  }
  
  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║           LEXA SCRAPER SERVICE v4.6.0 (AAA)                      ║
╠══════════════════════════════════════════════════════════════════╣
║  Puerto: ${PORT}                                                     ║
║  Auth: ${process.env.API_KEY ? 'Configurada ✓' : 'Auto-generada ⚠️'}                                      ║
╠══════════════════════════════════════════════════════════════════╣
║  CAMBIOS v4.6.0:                                                 ║
║    ✓ FIX: No envía imagen si CAPTCHA no cargó                    ║
║    ✓ NUEVO: asegurarCaptchaValido() - validación estricta        ║
║    ✓ NUEVO: Recarga CAPTCHA automáticamente (max 5 intentos)     ║
║    ✓ NUEVO: Re-llena credenciales después de refresh             ║
║    ✓ NUEVO: Endpoint /test-captcha para debug                    ║
║    ✓ MEJORA: Validación de dimensiones más estricta              ║
╠══════════════════════════════════════════════════════════════════╣
║  CAMBIOS v4.5.0 (mantenidos):                                    ║
║    ✓ FIX: llenarCredenciales() funciona con PrimeFaces           ║
║    ✓ FIX: Dispara eventos input/change/blur                      ║
║    ✓ FIX: Verifica que los campos se llenaron                    ║
║    ✓ NUEVO: Endpoint /test-credenciales para debug               ║
╠══════════════════════════════════════════════════════════════════╣
║  ENDPOINTS:                                                      ║
║    GET  /health             POST /webhook/whatsapp               ║
║    POST /scraper            GET  /sesiones                       ║
║    GET  /metricas           POST /test-whatsapp                  ║
║    POST /test-conexion      POST /test-credenciales              ║
║    POST /test-captcha                                            ║
╚══════════════════════════════════════════════════════════════════╝
  `);
});
