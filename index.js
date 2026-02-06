/**
 * ============================================================
 * LEXA SCRAPER SERVICE v5.1.0
 * ============================================================
 * 
 * CORRECCIONES v5.1.0:
 *   ✓ FIX BUG-001: Nombres de campos compatibles con documentación
 *     (acepta sinoeUsuario/usuario, sinoePassword/password, etc.)
 *   ✓ FIX BUG-002: Endpoint /scraper ahora es SÍNCRONO
 *     (n8n espera resultado con timeout 5 min, no fire-and-forget)
 *   ✓ FIX BUG-003: Formato de respuesta coincide con documentación
 *     (success/pdfs/totalNotificaciones en vez de exito/notificaciones)
 *   ✓ FIX BUG-004: req.socket en vez de req.connection (deprecated)
 *   ✓ FIX BUG-005: SIGTERM con cleanup de sesiones activas
 * 
 * Arquitectura modular:
 *   - core.js          → Configuración, utilidades, WhatsApp (NO TOCAR)
 *   - flujo-estable.js → Pasos 10-13 (NO TOCAR)
 *   - extraccion.js    → Pasos 14-15 (NO TOCAR)
 *   - index.js         → Orquestación + API REST (ESTE ARCHIVO)
 * ============================================================
 */

const express = require('express');
const puppeteer = require('puppeteer-core');
const crypto = require('crypto');

// ============================================================
// IMPORTAR MÓDULOS
// ============================================================

const core = require('./core');
const flujoEstable = require('./flujo-estable');
const extraccion = require('./extraccion');

// ============================================================
// EXTRAER FUNCIONES DE LOS MÓDULOS
// ============================================================

// De core.js
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
  enviarWhatsAppImagen,
  cerrarPopups,
  manejarSesionActiva,
  llenarCredenciales,
  asegurarCaptchaValido,
  capturarFormularioLogin
} = core;

// De flujo-estable.js (Pasos 10-13)
const {
  escribirCaptchaEnCampo,
  hacerClicLoginPrimeFaces,
  analizarResultadoLogin,
  navegarACasillas,
  verificarEstadoPagina
} = flujoEstable;

// De extraccion.js (Pasos 14-15)
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
// FIX BUG-004: req.socket en vez de req.connection (deprecated)
// ============================================================

const rateLimiter = (req, res, next) => {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
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
// FIX BUG-003: Retorna formato compatible con documentación
//   { success, pdfs, totalNotificaciones, mensaje, timestamp }
// ============================================================

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
    page.setDefaultTimeout(TIMEOUT.navegacion);
    
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
    
    // FIX: Limpiar prefijo data: si existe (Evolution API requiere base64 crudo)
    let base64Limpio = screenshotBase64;
    if (base64Limpio.startsWith('data:')) {
      base64Limpio = base64Limpio.split(',')[1] || base64Limpio;
      log('info', `SCRAPER:${requestId}`, 'Prefijo data: eliminado del base64');
    }
    
    // Log de diagnóstico del base64
    log('info', `SCRAPER:${requestId}`, `Base64 preview: ${base64Limpio.substring(0, 50)}...`);
    log('info', `SCRAPER:${requestId}`, `Base64 tamaño: ${base64Limpio.length} chars`);
    
    const caption = `📩 ${nombreAbogado}, escriba el código CAPTCHA que ve en la imagen y envíelo como respuesta.\n\n⏱️ Tiene 5 minutos.\n🔒 Credenciales ya llenadas.`;
    
    if (!await enviarWhatsAppImagen(whatsappNumero, base64Limpio, caption)) {
      // Fallback: intentar enviar solo texto si la imagen falla
      log('warn', `SCRAPER:${requestId}`, 'Imagen falló, intentando enviar texto de aviso...');
      await enviarWhatsAppTexto(whatsappNumero, 
        `📩 ${nombreAbogado}, no se pudo enviar la imagen del CAPTCHA.\n\n⚠️ Abra SINOE manualmente o intente de nuevo.`
      );
      throw new Error('No se pudo enviar la imagen del CAPTCHA por WhatsApp');
    }
    
    log('success', `SCRAPER:${requestId}`, 'Imagen del CAPTCHA enviada por WhatsApp');
    
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
      
      // SINOE redirige automáticamente al login después de finalizar sesión
      // Esperar a que la redirección termine
      log('info', `SCRAPER:${requestId}`, 'Esperando redirección al login...');
      try {
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
      } catch (e) {
        log('info', `SCRAPER:${requestId}`, 'Timeout de redirección, navegando manualmente al login...');
      }
      
      await delay(3000);
      
      // Verificar si llegamos al login, si no, navegar manualmente
      let urlActual = '';
      try {
        urlActual = (await leerUrlSegura(page)) || '';
      } catch (e) {
        urlActual = '';
      }
      
      if (!urlActual.includes('validar') && !urlActual.includes('login')) {
        log('info', `SCRAPER:${requestId}`, `URL actual: ${urlActual}, navegando al login...`);
        await page.goto(SINOE_URLS.login, { waitUntil: 'networkidle2', timeout: TIMEOUT.navegacion });
        await delay(3000);
      }
      
      await cerrarPopups(page, `SCRAPER:${requestId}`);
      await delay(1000);
      
      await page.waitForSelector('input[type="password"]', { timeout: TIMEOUT.elemento });
      
      await llenarCredenciales(page, sinoeUsuario, sinoePassword);
      await delay(1000);
      
      await asegurarCaptchaValido(page, sinoeUsuario, sinoePassword);
      
      const nuevoScreenshot = await capturarFormularioLogin(page);
      
      // FIX: Limpiar prefijo data: del segundo screenshot también
      let nuevoBase64 = nuevoScreenshot;
      if (nuevoBase64 && nuevoBase64.startsWith('data:')) {
        nuevoBase64 = nuevoBase64.split(',')[1] || nuevoBase64;
      }
      
      if (!await enviarWhatsAppImagen(whatsappNumero, nuevoBase64, 
        `✅ Sesión anterior cerrada.\n\n📩 ${nombreAbogado}, escriba el NUEVO código CAPTCHA:\n\n⏱️ Tiene 5 minutos.`
      )) {
        await enviarWhatsAppTexto(whatsappNumero, 
          `⚠️ ${nombreAbogado}, no se pudo enviar la imagen del nuevo CAPTCHA. Intente de nuevo.`
        );
        throw new Error('No se pudo enviar imagen del segundo CAPTCHA');
      }
      
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
      
      const resultadoEscritura2 = await escribirCaptchaEnCampo(page, nuevoCaptcha, requestId);
      
      if (!resultadoEscritura2.exito) {
        await enviarWhatsAppTexto(whatsappNumero, '⚠️ La página de SINOE expiró durante el segundo intento. Intente de nuevo.');
        throw new Error(`Escritura de CAPTCHA falló en segundo intento: ${resultadoEscritura2.error}`);
      }
      
      const urlAntes2 = await leerUrlSegura(page) || SINOE_URLS.login;
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
      
      // FIX BUG-003: Formato de respuesta compatible con documentación
      return {
        success: true,
        pdfs: [],
        totalNotificaciones: 0,
        mensaje: 'Sin notificaciones pendientes',
        timestamp: new Date().toISOString(),
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
    
    // FIX BUG-003: Formato de respuesta compatible con documentación
    // Mapear notificaciones al formato "pdfs" que espera n8n
    const pdfs = notificaciones.map(n => ({
      expediente: n.expediente || '',
      juzgado: n.juzgado || '',
      fecha: n.fecha || '',
      archivo: n.pdf || n.archivo || '',
      nombre: n.nombreArchivo || `${(n.expediente || 'doc').replace(/\//g, '_')}.pdf`
    }));
    
    return {
      success: true,
      pdfs,
      totalNotificaciones: notificaciones.length,
      descargasExitosas: resultadoDescargas.exitosas,
      descargasFallidas: resultadoDescargas.fallidas,
      mensaje: `${notificaciones.length} notificaciones procesadas`,
      timestamp: new Date().toISOString(),
      tiempoSegundos: tiempoTotal
    };
    
  } catch (error) {
    metricas.scrapersFallidos++;
    log('error', `SCRAPER:${requestId}`, `Error: ${error.message}`);
    
    // FIX BUG-003: Formato de error compatible con documentación
    // Detectar fase del error para que n8n pueda tomar decisiones
    let fase = 'desconocido';
    const msg = error.message.toLowerCase();
    if (msg.includes('captcha') && msg.includes('timeout')) fase = 'captcha';
    else if (msg.includes('captcha')) fase = 'captcha';
    else if (msg.includes('credencial') || msg.includes('password')) fase = 'credenciales';
    else if (msg.includes('browserless') || msg.includes('connect')) fase = 'conexion';
    else if (msg.includes('sesion') || msg.includes('sesión')) fase = 'sesion_activa';
    else if (msg.includes('casilla') || msg.includes('navegar')) fase = 'navegacion';
    else if (msg.includes('login')) fase = 'login';
    
    return {
      success: false,
      error: error.message,
      fase,
      timestamp: new Date().toISOString(),
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
    
    // Extraer mensaje — soportar múltiples formatos de Evolution API
    let mensaje = null;
    let numero = null;
    
    if (body.data?.message?.conversation) {
      mensaje = body.data.message.conversation;
      numero = body.data.key?.remoteJid?.replace('@s.whatsapp.net', '');
    } else if (body.data?.message?.extendedTextMessage?.text) {
      mensaje = body.data.message.extendedTextMessage.text;
      numero = body.data.key?.remoteJid?.replace('@s.whatsapp.net', '');
    } else if (body.message?.conversation) {
      mensaje = body.message.conversation;
      numero = body.key?.remoteJid?.replace('@s.whatsapp.net', '');
    }
    
    if (!mensaje || !numero) {
      return res.json({ status: 'ignorado', razon: 'sin mensaje o número' });
    }
    
    // Ignorar mensajes propios (fromMe)
    if (body.data?.key?.fromMe || body.key?.fromMe) {
      return res.json({ status: 'ignorado', razon: 'mensaje propio' });
    }
    
    log('info', 'WEBHOOK', `Mensaje de ${enmascarar(numero)}: ${mensaje}`);
    
    // Verificar si hay sesión activa para este número
    if (sesionesActivas.has(numero)) {
      const sesion = sesionesActivas.get(numero);
      
      // Verificar que la sesión no expiró
      if (Date.now() - sesion.timestamp > TIMEOUT.captcha) {
        log('warn', 'WEBHOOK', 'Sesión expirada, ignorando mensaje');
        sesionesActivas.delete(numero);
        return res.json({ status: 'sesion_expirada' });
      }
      
      // Limpiar mensaje (solo alfanumérico)
      const captcha = mensaje.trim().replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
      
      if (captcha.length >= 4 && captcha.length <= 8) {
        log('success', 'WEBHOOK', `CAPTCHA válido recibido: ${captcha}`);
        sesion.resolve(captcha);
        return res.json({ status: 'captcha_recibido', captcha });
      } else {
        log('warn', 'WEBHOOK', `CAPTCHA inválido: "${captcha}" (${captcha.length} chars)`);
        enviarWhatsAppTexto(numero, '⚠️ El código debe tener entre 4 y 8 caracteres alfanuméricos. Intente de nuevo.');
        return res.json({ status: 'captcha_invalido' });
      }
    }
    
    res.json({ status: 'sin_sesion_activa' });
    
  } catch (error) {
    log('error', 'WEBHOOK', `Error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// ENDPOINT PRINCIPAL DEL SCRAPER
// FIX BUG-001: Acepta ambos formatos de campos
// FIX BUG-002: Ahora es SÍNCRONO (await ejecutarScraper)
// ============================================================

app.post('/scraper', autenticar, rateLimiter, async (req, res) => {
  try {
    // FIX BUG-001: Aceptar AMBOS formatos de nombres de campos
    // Documentación usa: sinoeUsuario, sinoePassword, whatsappNumero, nombreAbogado
    // Legacy/curl usa:   usuario, password, whatsapp, nombre
    const sinoeUsuario = req.body.sinoeUsuario || req.body.usuario;
    const sinoePassword = req.body.sinoePassword || req.body.password;
    const whatsappNumero = req.body.whatsappNumero || req.body.whatsapp;
    const nombreAbogado = req.body.nombreAbogado || req.body.nombre || 'Abogado';
    
    if (!sinoeUsuario || !sinoePassword || !whatsappNumero) {
      return res.status(400).json({ 
        success: false,
        error: 'Faltan campos requeridos: sinoeUsuario/usuario, sinoePassword/password, whatsappNumero/whatsapp',
        camposRecibidos: Object.keys(req.body)
      });
    }
    
    if (!validarNumeroWhatsApp(whatsappNumero)) {
      return res.status(400).json({ success: false, error: 'Número de WhatsApp inválido' });
    }
    
    // Verificar que no haya sesión activa
    if (sesionesActivas.has(whatsappNumero)) {
      return res.status(409).json({ 
        success: false,
        error: 'Ya hay un proceso activo para este número' 
      });
    }
    
    log('info', 'API', `Iniciando scraper para ${enmascarar(whatsappNumero)}`);
    
    // FIX BUG-002: SÍNCRONO — await para que n8n reciba el resultado real
    // n8n configura timeout de 5 min (300000ms), suficiente para el CAPTCHA
    const resultado = await ejecutarScraper({
      sinoeUsuario,
      sinoePassword,
      whatsappNumero,
      nombreAbogado
    });
    
    log('info', 'API', `Scraper finalizado: ${resultado.success ? 'ÉXITO' : 'ERROR'}`);
    
    // Devolver resultado directamente — n8n procesa con IF (success === true)
    if (resultado.success) {
      res.json(resultado);
    } else {
      // Error del scraper pero HTTP 200 para que n8n no entre en error handler
      // n8n usa $json.success para decidir la rama
      res.json(resultado);
    }
    
  } catch (error) {
    log('error', 'API', `Error inesperado: ${error.message}`);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      fase: 'servidor',
      timestamp: new Date().toISOString()
    });
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

// Test de envío de imagen (para diagnosticar problema de CAPTCHA)
app.post('/test-imagen', autenticar, async (req, res) => {
  try {
    const { numero } = req.body;
    
    if (!numero) {
      return res.status(400).json({ error: 'Falta número' });
    }
    
    // Imagen mínima PNG de 1x1 pixel (base64 crudo, sin prefijo)
    const imagenTest = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    
    const resultado = await enviarWhatsAppImagen(
      numero,
      imagenTest,
      '🧪 Test de envío de imagen - LEXA v5.1.0'
    );
    
    res.json({ 
      enviado: resultado,
      metodo: 'sendMedia',
      base64Preview: imagenTest.substring(0, 30) + '...',
      base64Length: imagenTest.length
    });
    
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

// ============================================================
// INICIAR SERVIDOR
// ============================================================

let server = null;

server = app.listen(PORT, '0.0.0.0', () => {
  log('success', 'SERVER', `LEXA Scraper Service v5.1.0 iniciado en puerto ${PORT}`);
  log('info', 'SERVER', `API Key: ${API_KEY.substring(0, 8)}...`);
  log('info', 'SERVER', `Browserless: ${CONFIG.browserless.url}`);
  log('info', 'SERVER', `Evolution: ${CONFIG.evolution.url}`);
  log('info', 'SERVER', 'FIX v5.1.0: Campos compatibles + Endpoint síncrono + Formato response');
  
  // Iniciar limpieza automática
  iniciarLimpiezaAutomatica();
});

// FIX BUG-005: SIGTERM con cleanup de sesiones activas y cierre graceful
const cerrarGracefully = (signal) => {
  log('info', 'SERVER', `${signal} recibido, cerrando gracefully...`);
  
  // Cerrar sesiones activas y sus timeouts
  for (const [numero, sesion] of sesionesActivas.entries()) {
    if (sesion.timeoutId) clearTimeout(sesion.timeoutId);
    if (sesion.reject) {
      try { sesion.reject(new Error('Servidor cerrándose')); } catch (e) {}
    }
  }
  sesionesActivas.clear();
  log('info', 'SERVER', 'Sesiones activas cerradas');
  
  // Cerrar servidor Express
  if (server) {
    server.close(() => {
      log('info', 'SERVER', 'Servidor Express cerrado');
      process.exit(0);
    });
    // Forzar cierre después de 5 segundos si no se cierra solo
    setTimeout(() => {
      log('warn', 'SERVER', 'Forzando cierre después de 5s');
      process.exit(1);
    }, 5000);
  } else {
    process.exit(0);
  }
};

process.on('SIGTERM', () => cerrarGracefully('SIGTERM'));
process.on('SIGINT', () => cerrarGracefully('SIGINT'));

module.exports = { app, ejecutarScraper };
