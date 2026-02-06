/**
 * ============================================================
 * LEXA SCRAPER SERVICE v5.1.0
 * ============================================================
 * 
 * Arquitectura modular:
 *   - core.js          → Configuración, utilidades, WhatsApp (NO TOCAR)
 *   - flujo-estable.js → Pasos 10-13 (NO TOCAR)
 *   - extraccion.js    → Pasos 14-15 (NO TOCAR)
 *   - index.js         → Orquestación + API REST (ESTE ARCHIVO)
 * 
 * Flujo completo:
 *   1-9.   Conexión, navegación, credenciales, CAPTCHA, WhatsApp
 *   10.    Escribir CAPTCHA en campo
 *   11.    Hacer clic en "Ingresar"
 *   12.    Verificar dashboard (5 reintentos)
 *   13.    Navegar a "Casillas Electrónicas"
 *   14.    Extraer notificaciones (extraccion.js)
 *   15.    Descargar consolidados (extraccion.js)
 * 
 * Changelog v5.1.0:
 *   - Fix: enviarWhatsAppImagen con prefijo data URI para Evolution API v2.x
 *   - Fix: validación de response.ok en envío de imagen
 *   - Fix: compatibilidad de parámetros n8n en endpoint /scraper
 *   - Fix: webhook WhatsApp delega mensajes cortos a n8n (menú)
 * ============================================================
 */

const express = require('express');
const puppeteer = require('puppeteer-core');
const crypto = require('crypto');

// ============================================================
// IMPORTAR MÓDULOS
// ============================================================

// Módulo base (configuración, utilidades, WhatsApp) - NO MODIFICAR
const core = require('./core');

// Módulo de flujo estable (pasos 10-13) - NO MODIFICAR
const flujoEstable = require('./flujo-estable');

// Módulo de extracción (pasos 14-15) - NO MODIFICAR
const extraccion = require('./extraccion');

// ============================================================
// EXTRAER FUNCIONES DE LOS MÓDULOS
// ============================================================

// De core.js — se importa TODO excepto enviarWhatsAppImagen,
// que se redefine más abajo con compatibilidad Evolution API v2.x
const {
  PORT,
  API_KEY,
  SINOE_URLS,
  TIMEOUT,
  CONFIG,
  RATE_LIMIT,
  DEFAULT_VIEWPORT,
  metricas,
  sesionesActivas,
  rateLimitCache,
  webhooksRecientes,
  delay,
  log,
  enmascarar,
  validarNumeroWhatsApp,
  validarCaptcha,
  iniciarLimpiezaAutomatica,
  leerUrlSegura,
  leerContenidoSeguro,
  evaluarSeguro,
  enviarWhatsAppTexto,
  // enviarWhatsAppImagen → NO se importa, se redefine abajo
  cerrarPopups,
  manejarSesionActiva,
  llenarCredenciales,
  asegurarCaptchaValido,
  capturarFormularioLogin
} = core;

// De flujo-estable.js (Pasos 10-13) - NO MODIFICAR
const {
  escribirCaptchaEnCampo,      // Paso 10
  hacerClicLoginPrimeFaces,    // Paso 11
  analizarResultadoLogin,      // Paso 12
  navegarACasillas,            // Paso 13
  verificarEstadoPagina
} = flujoEstable;

// De extraccion.js (Pasos 14-15) - NO MODIFICAR
const {
  esperarTablaCargada,
  extraerNotificaciones,
  diagnosticarPaginaCasillas,
  abrirModalAnexos,
  descargarConsolidado,
  cerrarModal,
  procesarNotificaciones,
  capturarPantallaCasillas
} = extraccion;

// ============================================================
// OVERRIDE: enviarWhatsAppImagen (Evolution API v2.x)
// ============================================================
// Puppeteer screenshot({ encoding: 'base64' }) devuelve base64 crudo.
// Evolution API v2.x requiere prefijo "data:image/png;base64," para
// reconocer el contenido como base64 en el campo media.
// core.js no se modifica — el override vive aquí en index.js.
// ============================================================

async function enviarWhatsAppImagen(numero, base64, caption) {
  try {
    // Agregar prefijo data URI si no lo tiene
    const mediaData = base64.startsWith('data:')
      ? base64
      : `data:image/png;base64,${base64}`;

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
        media: mediaData,
        fileName: 'captcha.png'
      })
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Sin detalle');
      log('error', 'WHATSAPP', `Evolution API respondió ${response.status} en sendMedia`, { errorBody });
      return false;
    }

    log('success', 'WHATSAPP', 'Imagen enviada', {
      numero: enmascarar(numero),
      status: response.status,
      size: base64.length
    });
    return true;
  } catch (error) {
    log('error', 'WHATSAPP', `Error enviando imagen: ${error.message}`);
    return false;
  }
}

// ============================================================
// CREAR APLICACIÓN EXPRESS
// ============================================================

const app = express();
app.use(express.json({ limit: '50mb' }));

// ============================================================
// MIDDLEWARE DE AUTENTICACIÓN
// ============================================================

const autenticar = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== API_KEY) {
    return res.status(401).json({ error: 'API key inválida' });
  }
  next();
};

// ============================================================
// MIDDLEWARE DE RATE LIMITING
// ============================================================

const rateLimiter = (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  const ahora = Date.now();
  
  if (!rateLimitCache.has(ip)) {
    rateLimitCache.set(ip, { count: 1, resetTime: ahora + RATE_LIMIT.windowMs });
    return next();
  }
  
  const datos = rateLimitCache.get(ip);
  
  if (ahora > datos.resetTime) {
    rateLimitCache.set(ip, { count: 1, resetTime: ahora + RATE_LIMIT.windowMs });
    return next();
  }
  
  if (datos.count >= RATE_LIMIT.maxRequestsPerIp) {
    return res.status(429).json({ 
      error: 'Demasiadas solicitudes',
      reintentar_en: Math.ceil((datos.resetTime - ahora) / 1000)
    });
  }
  
  datos.count++;
  next();
};

// ============================================================
// FUNCIÓN PRINCIPAL DEL SCRAPER
// ============================================================

/**
 * Ejecuta el flujo completo del scraper SINOE.
 */
async function ejecutarScraper({ sinoeUsuario, sinoePassword, whatsappNumero, nombreAbogado }) {
  let browser = null;
  let page = null;
  const inicioMs = Date.now();
  const requestId = crypto.randomUUID().substring(0, 8);
  let timeoutCaptchaId = null;
  
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
    // PASO 3: Manejar página de parámetros (si aparece)
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
    // ESPERAR RESPUESTA DEL ABOGADO (CAPTCHA)
    // ═══════════════════════════════════════════════════════════════════
    log('info', `SCRAPER:${requestId}`, 'Esperando respuesta del abogado (máx 5 min)...');
    
    const captchaTexto = await new Promise((resolve, reject) => {
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
        timeoutId: timeoutCaptchaId,
        timestamp: Date.now(),
        nombreAbogado, 
        requestId
      });
    });
    
    if (timeoutCaptchaId) {
      clearTimeout(timeoutCaptchaId);
      timeoutCaptchaId = null;
    }
    
    metricas.captchasRecibidos++;
    log('success', `SCRAPER:${requestId}`, `CAPTCHA recibido: ${captchaTexto}`);
    
    // ═══════════════════════════════════════════════════════════════════
    // PASO 10: Escribir CAPTCHA en campo (flujo-estable.js)
    // ═══════════════════════════════════════════════════════════════════
    const resultadoEscritura = await escribirCaptchaEnCampo(page, captchaTexto, requestId);
    
    if (!resultadoEscritura.exito) {
      await enviarWhatsAppTexto(whatsappNumero, '⚠️ La página de SINOE expiró. Por favor intente de nuevo.');
      throw new Error(resultadoEscritura.error);
    }
    
    // ═══════════════════════════════════════════════════════════════════
    // PASO 11: Hacer clic en LOGIN (flujo-estable.js)
    // ═══════════════════════════════════════════════════════════════════
    const urlAntes = await leerUrlSegura(page) || SINOE_URLS.login;
    
    log('info', `SCRAPER:${requestId}`, 'Ejecutando login...');
    
    const resultadoClic = await hacerClicLoginPrimeFaces(page, requestId);
    
    if (!resultadoClic.exito) {
      log('error', `SCRAPER:${requestId}`, 'Error crítico: No se pudo hacer clic en login', resultadoClic);
      await enviarWhatsAppTexto(whatsappNumero, '⚠️ Error técnico al procesar el login. Intente de nuevo.');
      throw new Error(`Clic en login falló: ${resultadoClic.error}`);
    }
    
    log('info', `SCRAPER:${requestId}`, `Clic en login exitoso (método: ${resultadoClic.metodo})`);
    
    // ═══════════════════════════════════════════════════════════════════
    // Esperar navegación después del login
    // ═══════════════════════════════════════════════════════════════════
    log('info', `SCRAPER:${requestId}`, 'Esperando que SINOE procese el login...');
    
    try {
      await Promise.race([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
        delay(20000)
      ]);
      log('info', `SCRAPER:${requestId}`, 'Navegación completada');
    } catch (navError) {
      log('info', `SCRAPER:${requestId}`, 'Timeout de navegación - continuando con verificación');
    }
    
    await delay(3000);
    await cerrarPopups(page, `SCRAPER:${requestId}`);
    await delay(1000);
    
    // ═══════════════════════════════════════════════════════════════════
    // PASO 12: Verificar resultado del login (flujo-estable.js)
    // ═══════════════════════════════════════════════════════════════════
    let resultado = null;
    const MAX_REINTENTOS_VERIFICACION = 5;
    const ESPERA_ENTRE_REINTENTOS = 3000;
    
    for (let intento = 1; intento <= MAX_REINTENTOS_VERIFICACION; intento++) {
      resultado = await analizarResultadoLogin(page, urlAntes, requestId);
      
      log('info', `SCRAPER:${requestId}`, `Verificación ${intento}/${MAX_REINTENTOS_VERIFICACION}:`, {
        tipo: resultado.tipo,
        tienePassword: resultado.detalles?.login?.tieneCampoPassword,
        tieneDashboard: resultado.detalles?.dashboard?.tieneFormDashboard
      });
      
      if (resultado.tipo === 'login_exitoso' || 
          resultado.tipo === 'captcha_incorrecto' ||
          resultado.tipo === 'credenciales_invalidas' ||
          resultado.tipo === 'sesion_activa') {
        break;
      }
      
      if (intento < MAX_REINTENTOS_VERIFICACION) {
        log('info', `SCRAPER:${requestId}`, `Esperando ${ESPERA_ENTRE_REINTENTOS/1000}s antes de reintentar...`);
        await delay(ESPERA_ENTRE_REINTENTOS);
        await cerrarPopups(page, `SCRAPER:${requestId}`);
      }
    }
    
    log('info', `SCRAPER:${requestId}`, 'Resultado del análisis:', { 
      tipo: resultado.tipo, 
      mensaje: resultado.mensaje 
    });
    
    // ═══════════════════════════════════════════════════════════════════
    // MANEJO DE SESIÓN ACTIVA
    // ═══════════════════════════════════════════════════════════════════
    if (resultado.tipo === 'sesion_activa') {
      log('warn', `SCRAPER:${requestId}`, '🔄 SESIÓN ACTIVA DETECTADA');
      
      await enviarWhatsAppTexto(whatsappNumero, '⏳ Sesión activa detectada. Cerrando sesión anterior...');
      
      await manejarSesionActiva(page, requestId);
      await delay(3000);
      
      let urlActual = await leerUrlSegura(page);
      if (!urlActual.includes('login')) {
        await page.goto(SINOE_URLS.login, { waitUntil: 'networkidle2', timeout: TIMEOUT.navegacion });
        await delay(2000);
      }
      
      await cerrarPopups(page, `SCRAPER:${requestId}`);
      await delay(1000);
      
      await page.waitForSelector('input[type="password"]', { timeout: TIMEOUT.elemento });
      
      await llenarCredenciales(page, sinoeUsuario, sinoePassword);
      await delay(1000);
      
      await asegurarCaptchaValido(page, sinoeUsuario, sinoePassword);
      
      const nuevoScreenshot = await capturarFormularioLogin(page);
      
      await enviarWhatsAppImagen(whatsappNumero, nuevoScreenshot, 
        `✅ Sesión anterior cerrada.\n\n📩 ${nombreAbogado}, escriba el NUEVO código CAPTCHA:\n\n⏱️ Tiene 5 minutos.`
      );
      
      let nuevoTimeoutId = null;
      const nuevoCaptcha = await new Promise((resolve, reject) => {
        nuevoTimeoutId = setTimeout(() => {
          if (sesionesActivas.has(whatsappNumero)) {
            sesionesActivas.delete(whatsappNumero);
            reject(new Error('Timeout: CAPTCHA no resuelto en segundo intento'));
          }
        }, TIMEOUT.captcha);
        
        sesionesActivas.set(whatsappNumero, {
          page, browser, resolve, reject, 
          timeoutId: nuevoTimeoutId,
          timestamp: Date.now(), 
          nombreAbogado, requestId
        });
      });
      
      if (nuevoTimeoutId) clearTimeout(nuevoTimeoutId);
      
      log('success', `SCRAPER:${requestId}`, `CAPTCHA recibido: ${nuevoCaptcha}`);
      
      await escribirCaptchaEnCampo(page, nuevoCaptcha, requestId);
      
      const urlAntes2 = await leerUrlSegura(page);
      const clic2 = await hacerClicLoginPrimeFaces(page, requestId);
      
      if (!clic2.exito) {
        await page.keyboard.press('Enter');
      }
      
      try {
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
      } catch (e) { }
      
      await delay(TIMEOUT.esperaPostClick);
      await cerrarPopups(page, `SCRAPER:${requestId}`);
      
      resultado = await analizarResultadoLogin(page, urlAntes2, requestId);
      
      if (resultado.tipo !== 'login_exitoso') {
        await enviarWhatsAppTexto(whatsappNumero, `❌ ${resultado.mensaje}. Por favor intente de nuevo.`);
        throw new Error(`Login falló después de cerrar sesión: ${resultado.mensaje}`);
      }
    }
    
    // Manejar otros resultados
    if (resultado.tipo === 'captcha_incorrecto') {
      await enviarWhatsAppTexto(whatsappNumero, '❌ CAPTCHA incorrecto. Intente de nuevo.');
      throw new Error('CAPTCHA incorrecto');
    }
    
    if (resultado.tipo === 'credenciales_invalidas') {
      await enviarWhatsAppTexto(whatsappNumero, '❌ Usuario o contraseña incorrectos.');
      throw new Error('Credenciales inválidas');
    }
    
    if (resultado.tipo === 'login_fallido') {
      await enviarWhatsAppTexto(whatsappNumero, `❌ ${resultado.mensaje}. Intente de nuevo.`);
      throw new Error(resultado.mensaje);
    }
    
    if (resultado.tipo === 'indeterminado') {
      await enviarWhatsAppTexto(whatsappNumero, '⚠️ No se pudo confirmar el login. Intente de nuevo.');
      throw new Error('Login indeterminado después de múltiples verificaciones');
    }
    
    if (resultado.tipo !== 'login_exitoso') {
      throw new Error(`Tipo de resultado inesperado: ${resultado.tipo}`);
    }
    
    log('success', `SCRAPER:${requestId}`, '✅ Login exitoso en SINOE');
    
    // ═══════════════════════════════════════════════════════════════════
    // PASO 13: Navegar a Casillas Electrónicas (flujo-estable.js)
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
    
    await delay(TIMEOUT.esperaCargaTabla);
    
    // ═══════════════════════════════════════════════════════════════════
    // PASO 14: Extraer notificaciones (extraccion.js)
    // ═══════════════════════════════════════════════════════════════════
    log('info', `SCRAPER:${requestId}`, 'Extrayendo lista de notificaciones...');
    const notificaciones = await extraerNotificaciones(page, requestId);
    
    if (notificaciones.length === 0) {
      await enviarWhatsAppTexto(whatsappNumero,
        `✅ ${nombreAbogado}, acceso exitoso a SINOE.\n\n📋 No hay notificaciones pendientes.`
      );
      
      metricas.scrapersExitosos++;
      const tiempoTotal = Math.round((Date.now() - inicioMs) / 1000);
      
      return {
        exito: true,
        mensaje: 'Sin notificaciones pendientes',
        notificaciones: [],
        tiempoSegundos: tiempoTotal
      };
    }
    
    log('success', `SCRAPER:${requestId}`, `${notificaciones.length} notificaciones encontradas`);
    
    // Notificar al abogado
    const listaExp = notificaciones.slice(0, 5).map(n => `• ${n.expediente || 'Sin exp.'}`).join('\n');
    await enviarWhatsAppTexto(whatsappNumero,
      `✅ ${nombreAbogado}, acceso exitoso a SINOE.\n\n📋 ${notificaciones.length} notificaciones encontradas:\n${listaExp}${notificaciones.length > 5 ? '\n...' : ''}\n\n⏳ Descargando documentos...`
    );
    
    // ═══════════════════════════════════════════════════════════════════
    // PASO 15: Descargar consolidados (extraccion.js)
    // ═══════════════════════════════════════════════════════════════════
    log('info', `SCRAPER:${requestId}`, 'Iniciando descarga de consolidados...');
    
    const resultadoDescargas = await procesarNotificaciones(page, notificaciones, requestId);
    
    log('info', `SCRAPER:${requestId}`, 
      `Descargas: ${resultadoDescargas.exitosas} exitosas, ${resultadoDescargas.fallidas} fallidas`
    );
    
    // ═══════════════════════════════════════════════════════════════════
    // FINALIZAR
    // ═══════════════════════════════════════════════════════════════════
    metricas.scrapersExitosos++;
    const tiempoTotal = Math.round((Date.now() - inicioMs) / 1000);
    
    // Mensaje final
    await enviarWhatsAppTexto(whatsappNumero,
      `✅ Proceso completado\n\n📊 Resumen:\n• ${notificaciones.length} notificaciones\n• ${resultadoDescargas.exitosas} documentos descargados\n• Tiempo: ${tiempoTotal}s`
    );
    
    return {
      exito: true,
      mensaje: 'Scraping completado',
      notificaciones,
      descargas: resultadoDescargas,
      tiempoSegundos: tiempoTotal
    };
    
  } catch (error) {
    metricas.scrapersFallidos++;
    log('error', `SCRAPER:${requestId}`, `Error: ${error.message}`);
    
    return {
      exito: false,
      error: error.message,
      tiempoSegundos: Math.round((Date.now() - inicioMs) / 1000)
    };
    
  } finally {
    // Limpiar timeout si quedó pendiente
    if (timeoutCaptchaId) {
      clearTimeout(timeoutCaptchaId);
    }
    
    // Cerrar browser
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        log('warn', `SCRAPER:${requestId}`, `Error cerrando browser: ${e.message}`);
      }
    }
    
    // Limpiar sesión
    if (sesionesActivas.has(whatsappNumero)) {
      sesionesActivas.delete(whatsappNumero);
    }
  }
}

// ============================================================
// ENDPOINTS DE LA API
// ============================================================

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '5.1.0',
    modulos: ['core.js', 'flujo-estable.js', 'extraccion.js'],
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Métricas
app.get('/metricas', autenticar, (req, res) => {
  res.json({
    ...metricas,
    sesionesActivas: sesionesActivas.size,
    uptime: process.uptime()
  });
});

// Sesiones activas
app.get('/sesiones', autenticar, (req, res) => {
  const sesiones = [];
  for (const [numero, datos] of sesionesActivas.entries()) {
    sesiones.push({
      numero: enmascarar(numero),
      nombreAbogado: datos.nombreAbogado,
      requestId: datos.requestId,
      tiempoActivo: Math.round((Date.now() - datos.timestamp) / 1000)
    });
  }
  res.json({ sesiones });
});

// Webhook de WhatsApp (recibe CAPTCHA)
app.post('/webhook/whatsapp', (req, res) => {
  try {
    const body = req.body;
    
    // Evitar duplicados
    const webhookId = JSON.stringify(body).substring(0, 100);
    if (webhooksRecientes.has(webhookId)) {
      return res.json({ status: 'duplicado' });
    }
    webhooksRecientes.set(webhookId, Date.now());
    
    // Extraer mensaje — soporta formato Evolution API y formato simplificado de n8n
    let mensaje = null;
    let numero = null;
    
    // Formato Evolution API v2.x
    if (body.data?.message?.conversation) {
      mensaje = body.data.message.conversation;
      numero = body.data.key?.remoteJid?.replace('@s.whatsapp.net', '');
    } else if (body.message?.conversation) {
      mensaje = body.message.conversation;
      numero = body.key?.remoteJid?.replace('@s.whatsapp.net', '');
    }
    
    if (!mensaje || !numero) {
      // Formato simplificado desde n8n: { numero, captcha } o { numero, mensaje }
      if (body.captcha && body.numero) {
        mensaje = body.captcha;
        numero = body.numero;
      } else if (body.mensaje && body.numero) {
        mensaje = body.mensaje;
        numero = body.numero;
      }
    }
    
    if (!mensaje || !numero) {
      return res.json({ status: 'ignorado', razon: 'sin mensaje o número' });
    }
    
    log('info', 'WEBHOOK', `Mensaje de ${enmascarar(numero)}: ${mensaje}`);
    
    // Verificar si hay sesión activa para este número
    if (sesionesActivas.has(numero)) {
      const sesion = sesionesActivas.get(numero);
      
      // Limpiar mensaje (solo alfanumérico)
      const captcha = mensaje.trim().replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
      
      // CAPTCHAs de SINOE tienen 4-8 caracteres alfanuméricos.
      // Mensajes cortos (1-3 chars como "1", "2", "2.1") son opciones de menú,
      // NO intentos de CAPTCHA. Delegar a n8n para que los procese como menú.
      if (captcha.length >= 4 && captcha.length <= 8) {
        log('success', 'WEBHOOK', `CAPTCHA válido recibido: ${captcha}`);
        sesion.resolve(captcha);
        return res.json({ status: 'captcha_recibido', captcha });
      } else {
        log('info', 'WEBHOOK', `Mensaje corto "${mensaje}" durante sesión activa - delegando a menú n8n`);
        return res.json({ status: 'sin_sesion_activa', razon: 'mensaje_no_es_captcha' });
      }
    }
    
    res.json({ status: 'sin_sesion_activa' });
    
  } catch (error) {
    log('error', 'WEBHOOK', `Error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint principal del scraper
// Acepta ambos formatos de parámetros:
//   - Original:  { usuario, password, whatsapp, nombre }
//   - Desde n8n: { sinoeUsuario, sinoePassword, whatsappNumero, nombreAbogado }
app.post('/scraper', autenticar, rateLimiter, async (req, res) => {
  try {
    const usuario = req.body.usuario || req.body.sinoeUsuario;
    const password = req.body.password || req.body.sinoePassword;
    const whatsapp = req.body.whatsapp || req.body.whatsappNumero;
    const nombre = req.body.nombre || req.body.nombreAbogado || 'Abogado';
    
    if (!usuario || !password || !whatsapp) {
      return res.status(400).json({ 
        error: 'Faltan campos requeridos: usuario/sinoeUsuario, password/sinoePassword, whatsapp/whatsappNumero' 
      });
    }
    
    if (!validarNumeroWhatsApp(whatsapp)) {
      return res.status(400).json({ error: 'Número de WhatsApp inválido' });
    }
    
    // Verificar que no haya sesión activa
    if (sesionesActivas.has(whatsapp)) {
      return res.status(409).json({ 
        error: 'Ya hay un proceso activo para este número' 
      });
    }
    
    log('info', 'API', `Iniciando scraper para ${enmascarar(whatsapp)}`);
    
    // Ejecutar scraper de forma asíncrona (respuesta inmediata al cliente)
    ejecutarScraper({
      sinoeUsuario: usuario,
      sinoePassword: password,
      whatsappNumero: whatsapp,
      nombreAbogado: nombre
    }).then(resultado => {
      log('info', 'API', `Scraper finalizado: ${resultado.exito ? 'ÉXITO' : 'ERROR'}`);
    }).catch(error => {
      log('error', 'API', `Scraper falló: ${error.message}`);
    });
    
    res.json({
      status: 'iniciado',
      mensaje: 'Proceso iniciado. Recibirá instrucciones por WhatsApp.',
      whatsapp: enmascarar(whatsapp)
    });
    
  } catch (error) {
    log('error', 'API', `Error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Test de WhatsApp
app.post('/test-whatsapp', autenticar, async (req, res) => {
  try {
    const { numero, mensaje } = req.body;
    
    if (!numero) {
      return res.status(400).json({ error: 'Falta número' });
    }
    
    const resultado = await enviarWhatsAppTexto(
      numero, 
      mensaje || '🤖 Test de LEXA Scraper Service v5.1.0'
    );
    
    res.json({ enviado: resultado });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Test de conexión a Browserless
app.post('/test-conexion', autenticar, async (req, res) => {
  let browser = null;
  
  try {
    const wsEndpoint = CONFIG.browserless.token 
      ? `${CONFIG.browserless.url}?token=${CONFIG.browserless.token}`
      : CONFIG.browserless.url;
    
    browser = await puppeteer.connect({
      browserWSEndpoint: wsEndpoint,
      defaultViewport: DEFAULT_VIEWPORT
    });
    
    const page = await browser.newPage();
    await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded' });
    const titulo = await page.title();
    
    await browser.close();
    
    res.json({ 
      conectado: true, 
      titulo,
      browserless: CONFIG.browserless.url
    });
    
  } catch (error) {
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
    res.status(500).json({ 
      conectado: false, 
      error: error.message 
    });
  }
});

// Test de diagnóstico de casillas
app.post('/test-diagnostico', autenticar, async (req, res) => {
  let browser = null;
  
  try {
    const wsEndpoint = CONFIG.browserless.token 
      ? `${CONFIG.browserless.url}?token=${CONFIG.browserless.token}`
      : CONFIG.browserless.url;
    
    browser = await puppeteer.connect({
      browserWSEndpoint: wsEndpoint,
      defaultViewport: DEFAULT_VIEWPORT
    });
    
    const page = await browser.newPage();
    
    // Navegar a SINOE (sin login, solo para ver estructura)
    await page.goto(SINOE_URLS.login, { waitUntil: 'networkidle2' });
    
    const diagnostico = await diagnosticarPaginaCasillas(page, 'TEST');
    
    await browser.close();
    
    res.json({ diagnostico });
    
  } catch (error) {
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// INICIAR SERVIDOR
// ============================================================

app.listen(PORT, '0.0.0.0', () => {
  log('success', 'SERVER', `LEXA Scraper Service v5.1.0 iniciado en puerto ${PORT}`);
  log('info', 'SERVER', `API Key: ${API_KEY.substring(0, 8)}...`);
  log('info', 'SERVER', `Browserless: ${CONFIG.browserless.url}`);
  log('info', 'SERVER', `Evolution: ${CONFIG.evolution.url}`);
  
  // Iniciar limpieza automática
  iniciarLimpiezaAutomatica();
});

// Manejo de señales
process.on('SIGTERM', () => {
  log('info', 'SERVER', 'SIGTERM recibido, cerrando...');
  process.exit(0);
});

process.on('SIGINT', () => {
  log('info', 'SERVER', 'SIGINT recibido, cerrando...');
  process.exit(0);
});

module.exports = { app, ejecutarScraper };
