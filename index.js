/**
 * ============================================================
 * LEXA SCRAPER SERVICE v4.9.9 - FIX SESIÓN ACTIVA COMPLETO
 * ============================================================
 * 
 * CAMBIOS v4.9.9:
 *   ✓ FIX CRÍTICO: Manejo correcto de "Sesión Activa" (~10% de casos)
 *   ✓ Después de FINALIZAR SESIONES, SINOE siempre redirige a login
 *   ✓ Se rellenan credenciales automáticamente
 *   ✓ Se envía NUEVO CAPTCHA al usuario por WhatsApp
 *   ✓ Usuario responde → Login exitoso en segundo intento
 *   ✓ Código unificado y profesional (sin if/else redundante)
 *
 * FLUJO SESIÓN ACTIVA:
 *   1. Detecta sesión activa
 *   2. Clic en "FINALIZAR SESIONES"
 *   3. SINOE redirige a login (comportamiento normal)
 *   4. Rellena credenciales automáticamente
 *   5. Captura y envía NUEVO CAPTCHA
 *   6. Usuario responde
 *   7. Login exitoso
 *
 * CAMBIOS v4.9.7-v4.9.8:
 *   ✓ Detección de errores sin falsos positivos
 *   ✓ Verificación de CAPTCHA escrito
 *   ✓ jQuery .trigger('click') para PrimeFaces
 * ============================================================
 */

const express = require('express');
const puppeteer = require('puppeteer-core');
const crypto = require('crypto');

// ============================================================
// IMPORTAR MÓDULO BASE (NO TOCAR core.js)
// ============================================================

const core = require('./core');

// Extraer todo lo necesario de core
const {
  PORT,
  API_KEY,
  SINOE_URLS,
  TIMEOUT,
  CONFIG,
  RATE_LIMIT,
  CAPTCHA_CONFIG,
  DEFAULT_VIEWPORT,
  metricas,
  sesionesActivas,
  rateLimitCache,
  webhooksRecientes,
  delay,
  log,
  enmascarar,
  esErrorDeFrame,
  validarNumeroWhatsApp,
  validarCaptcha,
  iniciarLimpiezaAutomatica,
  leerUrlSegura,
  leerContenidoSeguro,
  evaluarSeguro,
  esperarYLeerPagina,
  enviarWhatsAppTexto,
  enviarWhatsAppImagen,
  hayPopupVisible,
  cerrarPopups,
  manejarSesionActiva,
  llenarCredenciales,
  verificarCaptchaValido,
  recargarCaptcha,
  asegurarCaptchaValido,
  capturarFormularioLogin
} = core;

const app = express();

// ============================================================
// FUNCIÓN AUXILIAR: VERIFICAR ESTADO DE LA PÁGINA
// ============================================================

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * NUEVA v4.9.3: Verifica el estado de la página usando elementos DOM
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * Esta función examina el DOM para determinar si estamos en:
 *   - Página de login (pre-autenticación)
 *   - Dashboard (post-autenticación exitosa)
 *   - Página de sesión activa
 *   - Página de error
 * 
 * NO usa page.content() porque incluye HTML de menús/nav que causa
 * falsos positivos.
 * 
 * @param {Page} page - Instancia de Puppeteer page
 * @returns {Object} Estado detallado de la página
 * ═══════════════════════════════════════════════════════════════════════════
 */
async function verificarEstadoPagina(page) {
  return await evaluarSeguro(page, () => {
    // ═══════════════════════════════════════════════════════════════════
    // INDICADORES DE PÁGINA DE LOGIN (pre-autenticación)
    // ═══════════════════════════════════════════════════════════════════
    
    // Campo de contraseña visible = estamos en formulario de login
    const campoPassword = document.querySelector('input[type="password"]');
    const tieneCampoPassword = campoPassword !== null && 
                               campoPassword.offsetParent !== null; // visible
    
    // Campo de CAPTCHA visible = estamos en formulario de login
    const campoCaptcha = document.querySelector(
      'input[placeholder*="CAPTCHA"], input[placeholder*="captcha"], input[id*="captcha"]'
    );
    const tieneCampoCaptcha = campoCaptcha !== null;
    
    // Imagen de CAPTCHA visible
    const imagenCaptcha = document.querySelector('img[src*="captcha"]');
    const tieneImagenCaptcha = imagenCaptcha !== null && imagenCaptcha.complete;
    
    // ═══════════════════════════════════════════════════════════════════
    // INDICADORES DE DASHBOARD (post-autenticación exitosa)
    // ═══════════════════════════════════════════════════════════════════
    
    // Formulario del dashboard (form#frmNuevo)
    const formDashboard = document.querySelector('form#frmNuevo, form[name="frmNuevo"]');
    const tieneFormDashboard = formDashboard !== null;
    
    // Barra de bienvenida con nombre de usuario
    // Ejemplo: "Bienvenido(a): ERWIN RAFAEL CAPUÑAY CARLOS"
    const bodyText = document.body.innerText || '';
    const tieneBienvenida = bodyText.includes('Bienvenido(a):') || 
                            bodyText.includes('Bienvenido:');
    
    // Extraer nombre del usuario si está presente
    let nombreUsuario = null;
    const matchBienvenida = bodyText.match(/Bienvenido\(?a?\)?:\s*([^\n\r]+)/i);
    if (matchBienvenida) {
      nombreUsuario = matchBienvenida[1].trim().substring(0, 50);
    }
    
    // Enlaces de servicio (Casillas, Mesa de Partes, etc.)
    // Estos solo existen en el dashboard post-login
    const enlacesFrmNuevo = document.querySelectorAll('a[id*="frmNuevo"]');
    const tieneEnlacesServicio = enlacesFrmNuevo.length > 0;
    
    // Botones de servicio con clase específica
    const spansTxtredbtn = document.querySelectorAll('span.txtredbtn');
    const divsBtnservicios = document.querySelectorAll('.btnservicios, .bggradient');
    const tieneBotonesServicio = spansTxtredbtn.length > 0 || divsBtnservicios.length > 0;
    
    // Texto "SERVICIOS ELECTRÓNICOS" (nota: con acento) - solo en dashboard
    const tieneTextoServiciosElectronicos = bodyText.includes('SERVICIOS ELECTRÓNICOS') ||
                                             bodyText.includes('SERVICIOS ELECTRONICOS');
    
    // Enlaces de usuario autenticado (MIS DATOS, CAMBIO DE CLAVE, CERRAR SESIÓN)
    const tieneCerrarSesion = bodyText.includes('CERRAR SESIÓN') || 
                              bodyText.includes('CERRAR SESION');
    
    // ═══════════════════════════════════════════════════════════════════
    // INDICADORES DE SESIÓN ACTIVA
    // ═══════════════════════════════════════════════════════════════════
    
    const tieneSesionActiva = bodyText.toLowerCase().includes('sesión activa') ||
                              bodyText.toLowerCase().includes('sesion activa') ||
                              bodyText.toLowerCase().includes('finalizar sesion') ||
                              bodyText.toLowerCase().includes('finalizar sesión');
    
    // ═══════════════════════════════════════════════════════════════════
    // INDICADORES DE ERROR - FIX v4.9.7: Detección más específica
    // ═══════════════════════════════════════════════════════════════════
    
    const bodyLower = bodyText.toLowerCase();
    
    // Buscar mensajes de error de PrimeFaces (más específicos)
    const mensajesError = document.querySelectorAll(
      '.ui-messages-error, .ui-message-error, .ui-growl-item-error, ' +
      '[class*="error-message"], [class*="mensaje-error"], ' +
      '.alert-danger, .error'
    );
    
    let textoMensajesError = '';
    mensajesError.forEach(msg => {
      textoMensajesError += ' ' + (msg.innerText || '').toLowerCase();
    });
    
    // CAPTCHA incorrecto: buscar en mensajes de error específicos O frases exactas
    // NO solo buscar palabras sueltas en todo el body
    const frasesErrorCaptcha = [
      'captcha incorrecto',
      'captcha inválido',
      'captcha invalido',
      'código captcha incorrecto',
      'codigo captcha incorrecto',
      'captcha erróneo',
      'captcha erroneo',
      'el captcha no es correcto',
      'captcha no coincide',
      'verifique el captcha'
    ];
    
    let tieneMensajeCaptchaIncorrecto = false;
    
    // Primero buscar en mensajes de error de PrimeFaces
    for (const frase of frasesErrorCaptcha) {
      if (textoMensajesError.includes(frase)) {
        tieneMensajeCaptchaIncorrecto = true;
        break;
      }
    }
    
    // Si no encontró en mensajes de error, buscar frases exactas en el body
    // (NO buscar palabras sueltas que causan falsos positivos)
    if (!tieneMensajeCaptchaIncorrecto) {
      for (const frase of frasesErrorCaptcha) {
        if (bodyLower.includes(frase)) {
          tieneMensajeCaptchaIncorrecto = true;
          break;
        }
      }
    }
    
    // Credenciales inválidas: también buscar frases específicas
    const frasesErrorCredenciales = [
      'usuario o contraseña incorrecto',
      'credenciales inválidas',
      'credenciales invalidas',
      'datos de acceso incorrectos',
      'usuario no encontrado',
      'contraseña incorrecta'
    ];
    
    let tieneMensajeCredencialesInvalidas = false;
    for (const frase of frasesErrorCredenciales) {
      if (textoMensajesError.includes(frase) || bodyLower.includes(frase)) {
        tieneMensajeCredencialesInvalidas = true;
        break;
      }
    }
    
    // ═══════════════════════════════════════════════════════════════════
    // RESULTADO CONSOLIDADO
    // ═══════════════════════════════════════════════════════════════════
    
    return {
      // URL actual
      url: window.location.href,
      
      // Indicadores de login (pre-auth)
      login: {
        tieneCampoPassword,
        tieneCampoCaptcha,
        tieneImagenCaptcha
      },
      
      // Indicadores de dashboard (post-auth)
      dashboard: {
        tieneFormDashboard,
        tieneBienvenida,
        nombreUsuario,
        tieneEnlacesServicio,
        tieneBotonesServicio,
        tieneTextoServiciosElectronicos,
        tieneCerrarSesion,
        // Contadores para debug
        enlacesFrmNuevoCount: enlacesFrmNuevo.length,
        spansTxtredbtnCount: spansTxtredbtn.length,
        divsBtnserviciosCount: divsBtnservicios.length
      },
      
      // Indicadores de sesión activa
      sesionActiva: {
        detectada: tieneSesionActiva
      },
      
      // Indicadores de error
      errores: {
        captchaIncorrecto: tieneMensajeCaptchaIncorrecto,
        credencialesInvalidas: tieneMensajeCredencialesInvalidas,
        // Debug: mostrar texto de mensajes de error encontrados
        textoMensajesError: textoMensajesError.substring(0, 200).trim()
      },
      
      // Extracto del body para debug (primeros 300 chars)
      extractoBody: bodyText.substring(0, 300).replace(/\s+/g, ' ').trim()
    };
  });
}

// ============================================================
// ANÁLISIS DE RESULTADO LOGIN - FIX v4.9.3 (REESCRITO)
// ============================================================

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FIX v4.9.3: Detección robusta de login exitoso usando DOM
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * PROBLEMA ANTERIOR (v4.9.0-v4.9.2):
 *   - Usaba page.content() que retorna TODO el HTML incluyendo menús/nav
 *   - Buscaba texto "casillas electrónicas" en el HTML completo
 *   - El menú de navegación de la página de LOGIN contiene ese texto
 *   - Esto causaba FALSOS POSITIVOS: creía que logueó cuando no lo hizo
 * 
 * SOLUCIÓN (v4.9.3):
 *   - Usa verificarEstadoPagina() que examina elementos DOM específicos
 *   - Verifica PRESENCIA de elementos del dashboard (form#frmNuevo, barra Bienvenido)
 *   - Verifica AUSENCIA de elementos de login (campo password, CAPTCHA)
 *   - Es CONSISTENTE con navegarACasillas() (ambos usan evaluarSeguro)
 * 
 * @param {Page} page - Instancia de Puppeteer page
 * @param {string} urlAntes - URL antes del intento de login
 * @param {string} requestId - ID de la solicitud para logging
 * @returns {Object} Resultado del análisis {tipo, mensaje, detalles}
 * ═══════════════════════════════════════════════════════════════════════════
 */
async function analizarResultadoLogin(page, urlAntes, requestId) {
  // Obtener estado completo de la página
  const estado = await verificarEstadoPagina(page);
  
  if (!estado) {
    log('warn', `LOGIN:${requestId}`, 'No se pudo verificar estado de página (frame en transición)');
    return { 
      tipo: 'indeterminado', 
      mensaje: 'No se pudo leer la página - reintentando',
      detalles: null
    };
  }
  
  const url = estado.url || '';
  const urlLower = url.toLowerCase();
  
  // Log detallado para diagnóstico
  log('info', `LOGIN:${requestId}`, 'Estado de página:', {
    url: url.substring(0, 60),
    login: estado.login,
    dashboard: {
      tieneFormDashboard: estado.dashboard.tieneFormDashboard,
      tieneBienvenida: estado.dashboard.tieneBienvenida,
      tieneEnlacesServicio: estado.dashboard.tieneEnlacesServicio,
      tieneBotonesServicio: estado.dashboard.tieneBotonesServicio
    },
    sesionActiva: estado.sesionActiva.detectada,
    errores: estado.errores
  });
  
  // ═══════════════════════════════════════════════════════════════════
  // CASO 1: Error de CAPTCHA (prioridad alta)
  // ═══════════════════════════════════════════════════════════════════
  if (estado.errores.captchaIncorrecto) {
    log('warn', `LOGIN:${requestId}`, 'CAPTCHA incorrecto detectado');
    return { 
      tipo: 'captcha_incorrecto', 
      mensaje: 'CAPTCHA incorrecto',
      detalles: estado
    };
  }
  
  // ═══════════════════════════════════════════════════════════════════
  // CASO 2: Credenciales inválidas
  // ═══════════════════════════════════════════════════════════════════
  if (estado.errores.credencialesInvalidas) {
    log('warn', `LOGIN:${requestId}`, 'Credenciales inválidas detectadas');
    return { 
      tipo: 'credenciales_invalidas', 
      mensaje: 'Usuario o contraseña incorrectos',
      detalles: estado
    };
  }
  
  // ═══════════════════════════════════════════════════════════════════
  // CASO 3: Sesión activa detectada
  // ═══════════════════════════════════════════════════════════════════
  if (estado.sesionActiva.detectada || urlLower.includes('sso-session-activa')) {
    log('info', `LOGIN:${requestId}`, 'Sesión activa detectada');
    return { 
      tipo: 'sesion_activa', 
      mensaje: 'Sesión activa detectada - requiere finalización',
      detalles: estado
    };
  }
  
  // ═══════════════════════════════════════════════════════════════════
  // CASO 4: Dashboard confirmado (LOGIN EXITOSO)
  // Requiere AL MENOS 2 indicadores positivos del dashboard
  // Y NINGÚN indicador de página de login
  // ═══════════════════════════════════════════════════════════════════
  
  const indicadoresDashboard = [
    estado.dashboard.tieneFormDashboard,
    estado.dashboard.tieneBienvenida,
    estado.dashboard.tieneEnlacesServicio,
    estado.dashboard.tieneBotonesServicio,
    estado.dashboard.tieneCerrarSesion
  ];
  const countDashboard = indicadoresDashboard.filter(Boolean).length;
  
  const indicadoresLogin = [
    estado.login.tieneCampoPassword,
    estado.login.tieneCampoCaptcha
  ];
  const countLogin = indicadoresLogin.filter(Boolean).length;
  
  // Login exitoso: múltiples indicadores de dashboard Y ninguno de login
  if (countDashboard >= 2 && countLogin === 0) {
    log('success', `LOGIN:${requestId}`, 'LOGIN EXITOSO confirmado', {
      indicadoresDashboard: countDashboard,
      indicadoresLogin: countLogin,
      usuario: estado.dashboard.nombreUsuario
    });
    return { 
      tipo: 'login_exitoso', 
      mensaje: `Login exitoso - Usuario: ${estado.dashboard.nombreUsuario || 'detectado'}`,
      detalles: estado
    };
  }
  
  // ═══════════════════════════════════════════════════════════════════
  // CASO 5: Estamos en sso-menu-app.xhtml (bandeja) - éxito seguro
  // ═══════════════════════════════════════════════════════════════════
  if (urlLower.includes('sso-menu-app')) {
    log('success', `LOGIN:${requestId}`, 'Login exitoso - en bandeja de notificaciones');
    return { 
      tipo: 'login_exitoso', 
      mensaje: 'Login exitoso (menú principal / bandeja)',
      detalles: estado
    };
  }
  
  // ═══════════════════════════════════════════════════════════════════
  // CASO 6: Seguimos en página de login (LOGIN FALLIDO)
  // Hay campos de login visibles = no hemos autenticado
  // ═══════════════════════════════════════════════════════════════════
  if (countLogin > 0 && countDashboard < 2) {
    log('warn', `LOGIN:${requestId}`, 'LOGIN FALLIDO - campos de login aún visibles', {
      tieneCampoPassword: estado.login.tieneCampoPassword,
      tieneCampoCaptcha: estado.login.tieneCampoCaptcha,
      indicadoresDashboard: countDashboard
    });
    return { 
      tipo: 'login_fallido', 
      mensaje: 'Login fallido - verifique CAPTCHA y credenciales',
      detalles: estado
    };
  }
  
  // ═══════════════════════════════════════════════════════════════════
  // CASO 7: URL cambió a algo inesperado
  // ═══════════════════════════════════════════════════════════════════
  if (url !== urlAntes && !urlLower.includes('login') && !urlLower.includes('sso-validar')) {
    log('info', `LOGIN:${requestId}`, 'URL cambió a página diferente', { url });
    
    // Si tiene indicadores de dashboard, es éxito
    if (countDashboard >= 1) {
      return { 
        tipo: 'login_exitoso', 
        mensaje: 'Login exitoso (URL cambió + indicadores de dashboard)',
        detalles: estado
      };
    }
  }
  
  // ═══════════════════════════════════════════════════════════════════
  // CASO 8: Indeterminado - requiere verificación adicional
  // ═══════════════════════════════════════════════════════════════════
  log('warn', `LOGIN:${requestId}`, 'Resultado indeterminado', {
    indicadoresDashboard: countDashboard,
    indicadoresLogin: countLogin,
    url: url.substring(0, 60)
  });
  
  return { 
    tipo: 'indeterminado', 
    mensaje: 'Resultado indeterminado - verificando...',
    detalles: estado
  };
}

// ============================================================
// FIX v4.9.5: FUNCIÓN PARA HACER CLIC EN LOGIN (PRIMEFACES)
// ============================================================

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FIX v4.9.7: Hace clic en el botón "Ingresar" de SINOE
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * PROBLEMA v4.9.5/v4.9.6:
 *   - PrimeFaces.ab() falla desde page.evaluate() con error interno
 *   - El onclick del botón necesita contexto de evento "real"
 *   - form.submit() no funciona porque PrimeFaces usa AJAX
 * 
 * SOLUCIÓN v4.9.7:
 *   - SINOE usa jQuery (requerido por PrimeFaces)
 *   - jQuery.click() o .trigger('click') simula un clic "real"
 *   - También probar con event handlers nativos más completos
 * 
 * @param {Page} page - Instancia de Puppeteer page
 * @param {string} requestId - ID para logging
 * @returns {Object} {exito: boolean, metodo: string, error?: string}
 * ═══════════════════════════════════════════════════════════════════════════
 */
async function hacerClicLoginPrimeFaces(page, requestId) {
  log('info', `LOGIN:${requestId}`, 'Ejecutando clic en botón login (v4.9.7 - jQuery)...');
  
  // ═══════════════════════════════════════════════════════════════════
  // DIAGNÓSTICO INICIAL
  // ═══════════════════════════════════════════════════════════════════
  
  const diagnostico = await page.evaluate(() => {
    const boton = document.getElementById('frmLogin:btnIngresar');
    return {
      botonExiste: !!boton,
      botonId: boton?.id || null,
      botonOnclick: boton?.getAttribute('onclick') || null,
      jQueryExiste: typeof jQuery !== 'undefined' || typeof $ !== 'undefined',
      jQueryVersion: typeof jQuery !== 'undefined' ? jQuery.fn.jquery : null,
      primeFacesExiste: typeof PrimeFaces !== 'undefined',
      formExiste: !!document.getElementById('frmLogin')
    };
  });
  
  log('info', `LOGIN:${requestId}`, 'Diagnóstico:', diagnostico);
  
  // ═══════════════════════════════════════════════════════════════════
  // ESTRATEGIA 1: jQuery .trigger('click') - más probable que funcione
  // jQuery simula un evento de clic completo que PrimeFaces puede manejar
  // ═══════════════════════════════════════════════════════════════════
  
  if (diagnostico.jQueryExiste) {
    try {
      const resultado1 = await page.evaluate(() => {
        try {
          const jq = typeof jQuery !== 'undefined' ? jQuery : $;
          const boton = jq('#frmLogin\\:btnIngresar');
          
          if (boton.length === 0) {
            return { exito: false, error: 'Botón no encontrado con jQuery' };
          }
          
          // Trigger completo del evento click
          boton.trigger('click');
          
          return { exito: true, metodo: 'jquery_trigger_click' };
        } catch (e) {
          return { exito: false, error: e.message };
        }
      });
      
      if (resultado1.exito) {
        log('success', `LOGIN:${requestId}`, `✓ Login ejecutado: ${resultado1.metodo}`);
        return resultado1;
      }
      log('warn', `LOGIN:${requestId}`, `Estrategia 1 (jQuery trigger) falló: ${resultado1.error}`);
    } catch (e) {
      log('warn', `LOGIN:${requestId}`, `Estrategia 1 excepción: ${e.message}`);
    }
  }
  
  // ═══════════════════════════════════════════════════════════════════
  // ESTRATEGIA 2: jQuery .click() directo
  // ═══════════════════════════════════════════════════════════════════
  
  if (diagnostico.jQueryExiste) {
    try {
      const resultado2 = await page.evaluate(() => {
        try {
          const jq = typeof jQuery !== 'undefined' ? jQuery : $;
          const boton = jq('#frmLogin\\:btnIngresar');
          
          if (boton.length === 0) {
            return { exito: false, error: 'Botón no encontrado' };
          }
          
          boton.click();
          
          return { exito: true, metodo: 'jquery_click' };
        } catch (e) {
          return { exito: false, error: e.message };
        }
      });
      
      if (resultado2.exito) {
        log('success', `LOGIN:${requestId}`, `✓ Login ejecutado: ${resultado2.metodo}`);
        return resultado2;
      }
      log('warn', `LOGIN:${requestId}`, `Estrategia 2 (jQuery click) falló: ${resultado2.error}`);
    } catch (e) {
      log('warn', `LOGIN:${requestId}`, `Estrategia 2 excepción: ${e.message}`);
    }
  }
  
  // ═══════════════════════════════════════════════════════════════════
  // ESTRATEGIA 3: Llamar al onclick del botón directamente con call()
  // Esto ejecuta la función onclick en el contexto del botón
  // ═══════════════════════════════════════════════════════════════════
  
  try {
    const resultado3 = await page.evaluate(() => {
      try {
        const boton = document.getElementById('frmLogin:btnIngresar');
        if (!boton) {
          return { exito: false, error: 'Botón no encontrado' };
        }
        
        // Si tiene onclick como función, ejecutarla en contexto del botón
        if (typeof boton.onclick === 'function') {
          // Crear un evento fake para pasarle
          const fakeEvent = { preventDefault: () => {}, stopPropagation: () => {} };
          boton.onclick.call(boton, fakeEvent);
          return { exito: true, metodo: 'onclick_call' };
        }
        
        return { exito: false, error: 'onclick no es función' };
      } catch (e) {
        return { exito: false, error: e.message };
      }
    });
    
    if (resultado3.exito) {
      log('success', `LOGIN:${requestId}`, `✓ Login ejecutado: ${resultado3.metodo}`);
      return resultado3;
    }
    log('warn', `LOGIN:${requestId}`, `Estrategia 3 (onclick.call) falló: ${resultado3.error}`);
  } catch (e) {
    log('warn', `LOGIN:${requestId}`, `Estrategia 3 excepción: ${e.message}`);
  }
  
  // ═══════════════════════════════════════════════════════════════════
  // ESTRATEGIA 4: HTMLElement.click() nativo
  // ═══════════════════════════════════════════════════════════════════
  
  try {
    const resultado4 = await page.evaluate(() => {
      try {
        const boton = document.getElementById('frmLogin:btnIngresar');
        if (!boton) {
          return { exito: false, error: 'Botón no encontrado' };
        }
        
        boton.click();
        
        return { exito: true, metodo: 'native_click' };
      } catch (e) {
        return { exito: false, error: e.message };
      }
    });
    
    if (resultado4.exito) {
      log('success', `LOGIN:${requestId}`, `✓ Login ejecutado: ${resultado4.metodo}`);
      return resultado4;
    }
    log('warn', `LOGIN:${requestId}`, `Estrategia 4 (native click) falló: ${resultado4.error}`);
  } catch (e) {
    log('warn', `LOGIN:${requestId}`, `Estrategia 4 excepción: ${e.message}`);
  }
  
  // ═══════════════════════════════════════════════════════════════════
  // ESTRATEGIA 5: MouseEvent con todas las propiedades
  // ═══════════════════════════════════════════════════════════════════
  
  try {
    const resultado5 = await page.evaluate(() => {
      try {
        const boton = document.getElementById('frmLogin:btnIngresar');
        if (!boton) {
          return { exito: false, error: 'Botón no encontrado' };
        }
        
        const rect = boton.getBoundingClientRect();
        const evento = new MouseEvent('click', {
          view: window,
          bubbles: true,
          cancelable: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          button: 0,
          buttons: 1,
          relatedTarget: null
        });
        
        boton.dispatchEvent(evento);
        
        return { exito: true, metodo: 'mouse_event_full' };
      } catch (e) {
        return { exito: false, error: e.message };
      }
    });
    
    if (resultado5.exito) {
      log('success', `LOGIN:${requestId}`, `✓ Login ejecutado: ${resultado5.metodo}`);
      return resultado5;
    }
    log('warn', `LOGIN:${requestId}`, `Estrategia 5 (MouseEvent) falló: ${resultado5.error}`);
  } catch (e) {
    log('warn', `LOGIN:${requestId}`, `Estrategia 5 excepción: ${e.message}`);
  }
  
  // ═══════════════════════════════════════════════════════════════════
  // ESTRATEGIA 6: Puppeteer page.click() con coordenadas
  // ═══════════════════════════════════════════════════════════════════
  
  try {
    const boton = await page.$('#frmLogin\\:btnIngresar');
    if (boton) {
      // Obtener posición del botón
      const box = await boton.boundingBox();
      if (box) {
        // Clic en el centro del botón
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        log('success', `LOGIN:${requestId}`, '✓ Login ejecutado: puppeteer_mouse_click');
        return { exito: true, metodo: 'puppeteer_mouse_click' };
      }
      
      // Si no hay boundingBox, intentar click normal
      await boton.click();
      log('success', `LOGIN:${requestId}`, '✓ Login ejecutado: puppeteer_element_click');
      return { exito: true, metodo: 'puppeteer_element_click' };
    }
    log('warn', `LOGIN:${requestId}`, 'Estrategia 6: Botón no encontrado con Puppeteer');
  } catch (e) {
    log('warn', `LOGIN:${requestId}`, `Estrategia 6 excepción: ${e.message}`);
  }
  
  // ═══════════════════════════════════════════════════════════════════
  // ESTRATEGIA 7: Focus en campo CAPTCHA + Enter
  // ═══════════════════════════════════════════════════════════════════
  
  try {
    await page.evaluate(() => {
      const campoCaptcha = document.querySelector('input[placeholder*="CAPTCHA"], input[id*="captcha"]');
      if (campoCaptcha) {
        campoCaptcha.focus();
      }
    });
    
    await delay(100);
    await page.keyboard.press('Enter');
    
    log('success', `LOGIN:${requestId}`, '✓ Login ejecutado: focus_captcha_enter');
    return { exito: true, metodo: 'focus_captcha_enter' };
  } catch (e) {
    log('error', `LOGIN:${requestId}`, `Estrategia 7 excepción: ${e.message}`);
  }
  
  return { exito: false, metodo: 'ninguno', error: 'Todas las estrategias fallaron' };
}

// ============================================================
// FUNCIONES DE SINOE - POST-LOGIN
// ============================================================

/**
 * Navega a Casillas Electrónicas usando múltiples estrategias
 */
async function navegarACasillas(page, requestId) {
  log('info', `CASILLAS:${requestId}`, 'Iniciando navegación a Casillas Electrónicas...');
  
  // FIX v4.9.2: Esperar a que la página se estabilice después del login
  log('info', `CASILLAS:${requestId}`, 'Esperando 3s para que la página se estabilice...');
  await delay(3000);
  
  // PASO 1: DIAGNÓSTICO con reintentos
  let diagnostico = null;
  
  for (let intento = 1; intento <= 3; intento++) {
    try {
      diagnostico = await evaluarSeguro(page, () => {
        return {
          url: window.location.href,
          titulo: document.title,
          enlacesCommandlink: document.querySelectorAll('a.ui-commandlink').length,
          enlacesConOnclick: document.querySelectorAll('a[onclick]').length,
          enlacesFrmNuevo: document.querySelectorAll('a[id*="frmNuevo"]').length,
          divsBtnservicios: document.querySelectorAll('.btnservicios, .bggradient').length,
          spansTxtredbtn: document.querySelectorAll('span.txtredbtn').length,
          textoExiste: document.body.innerText.toLowerCase().includes('casillas electr'),
          extractoBody: (document.body.innerText || '').substring(0, 200).replace(/\s+/g, ' ')
        };
      });
      
      if (diagnostico) {
        log('info', `CASILLAS:${requestId}`, 'Diagnóstico:', diagnostico);
        break;
      }
    } catch (error) {
      log('warn', `CASILLAS:${requestId}`, `Intento ${intento}/3 diagnóstico falló: ${error.message}`);
    }
    
    if (intento < 3) {
      log('info', `CASILLAS:${requestId}`, `Reintentando diagnóstico en 2s...`);
      await delay(2000);
    }
  }
  
  // Si no hay diagnóstico, continuar de todas formas
  if (!diagnostico) {
    log('warn', `CASILLAS:${requestId}`, 'No se pudo obtener diagnóstico, intentando clic directo...');
  }
  
  // PASO 2: HACER CLIC EN EL ENLACE CORRECTO (6 estrategias) - con reintentos
  let resultado = null;
  
  for (let intento = 1; intento <= 3; intento++) {
    resultado = await evaluarSeguro(page, () => {
      // ESTRATEGIA 1: ID exacto (el más confiable)
      const enlaceDirecto = document.querySelector('#frmNuevo\\:j_idt38');
      if (enlaceDirecto) {
        enlaceDirecto.click();
        return { exito: true, metodo: 'id_exacto', id: 'frmNuevo:j_idt38' };
      }
      
      // ESTRATEGIA 2: Buscar span.txtredbtn con texto "Casillas" y subir al enlace padre
      const spansTxtredbtn = document.querySelectorAll('span.txtredbtn');
      for (const span of spansTxtredbtn) {
        const textoSpan = (span.innerText || '').toLowerCase();
        if (textoSpan.includes('casillas')) {
          // Subir hasta encontrar el enlace <a>
          let elemento = span.parentElement;
          let niveles = 0;
          while (elemento && niveles < 5) {
            if (elemento.tagName === 'A') {
              elemento.click();
              return { exito: true, metodo: 'span_txtredbtn', id: elemento.id || 'sin_id' };
            }
            elemento = elemento.parentElement;
            niveles++;
          }
        }
      }
      
      // ESTRATEGIA 3: Enlaces commandlink con contexto
      const enlacesCommandlink = document.querySelectorAll('a.ui-commandlink');
      for (const enlace of enlacesCommandlink) {
        const textoEnlace = (enlace.innerText || '').toLowerCase();
        if (textoEnlace.includes('casillas') && !textoEnlace.includes('mesa de partes')) {
          enlace.click();
          return { exito: true, metodo: 'commandlink_texto', id: enlace.id || 'sin_id' };
        }
      }
      
      // ESTRATEGIA 4: Enlaces con onclick submit
      const enlacesSubmit = document.querySelectorAll('a[onclick*="submit"]');
      for (const enlace of enlacesSubmit) {
        const textoEnlace = (enlace.innerText || '').toLowerCase();
        if (textoEnlace.includes('casillas')) {
          enlace.click();
          return { exito: true, metodo: 'submit_texto', id: enlace.id || 'sin_id' };
        }
      }
      
      // ESTRATEGIA 5: Div btnservicios/bggradient que contenga "casillas"
      const divsBtnservicios = document.querySelectorAll('.btnservicios, .bggradient');
      for (const div of divsBtnservicios) {
        const textoDiv = (div.innerText || '').toLowerCase();
        if (textoDiv.includes('casillas')) {
          // El div está DENTRO del enlace, buscar el enlace padre
          let elemento = div.parentElement;
          let niveles = 0;
          while (elemento && niveles < 3) {
            if (elemento.tagName === 'A') {
              elemento.click();
              return { exito: true, metodo: 'div_btnservicios', id: elemento.id || 'sin_id' };
            }
            elemento = elemento.parentElement;
            niveles++;
          }
        }
      }
      
      // ESTRATEGIA 6: Primer enlace frmNuevo con onclick (último recurso)
      const primerEnlace = document.querySelector('a[id*="frmNuevo"][onclick]');
      if (primerEnlace) {
        primerEnlace.click();
        return { exito: true, metodo: 'primer_frmnuevo', id: primerEnlace.id };
      }
      
      return { 
        exito: false, 
        metodo: 'ninguno',
        debug: {
          commandlink: document.querySelectorAll('a.ui-commandlink').length,
          submit: document.querySelectorAll('a[onclick*="submit"]').length,
          btnservicios: document.querySelectorAll('.btnservicios, .bggradient').length,
          txtredbtn: document.querySelectorAll('span.txtredbtn').length,
          frmNuevo: document.querySelectorAll('a[id*="frmNuevo"]').length
        }
      };
    });
    
    if (resultado) {
      break; // Salir del loop si obtuvimos resultado
    }
    
    if (intento < 3) {
      log('warn', `CASILLAS:${requestId}`, `Intento ${intento}/3: evaluarSeguro retornó null, reintentando en 2s...`);
      await delay(2000);
    }
  }
  
  if (!resultado) {
    log('error', `CASILLAS:${requestId}`, 'Error: No se pudo evaluar la página después de 3 intentos');
    return false;
  }
  
  if (!resultado.exito) {
    log('error', `CASILLAS:${requestId}`, 'No se encontró el botón de Casillas', resultado.debug);
    return false;
  }
  
  log('success', `CASILLAS:${requestId}`, `✓ Clic realizado (método: ${resultado.metodo}, id: ${resultado.id})`);
  
  await delay(TIMEOUT.esperaClicCasillas);
  
  return true;
}

/**
 * Extrae las notificaciones de la tabla
 */
async function extraerNotificaciones(page, requestId) {
  log('info', `NOTIF:${requestId}`, 'Extrayendo notificaciones de la tabla...');
  
  await delay(3000);
  
  const datos = await evaluarSeguro(page, () => {
    const notifs = [];
    const tabla = document.querySelector('table[role="grid"], .ui-datatable table, table.ui-widget-content');
    
    if (!tabla) {
      return { error: 'No se encontró tabla de notificaciones' };
    }
    
    const filas = tabla.querySelectorAll('tbody tr[role="row"], tbody tr[data-ri]');
    
    filas.forEach((fila, index) => {
      const celdas = fila.querySelectorAll('td');
      if (celdas.length < 5) return;
      
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
 * Abre el modal de anexos para una notificación
 */
async function abrirModalAnexos(page, requestId, indexFila) {
  log('info', `MODAL:${requestId}`, `Abriendo modal de anexos para fila ${indexFila}...`);
  
  const resultado = await evaluarSeguro(page, (idx) => {
    const filas = document.querySelectorAll('tbody tr[role="row"], tbody tr[data-ri]');
    
    if (idx >= filas.length) {
      return { exito: false, error: `Fila ${idx} no existe (total: ${filas.length})` };
    }
    
    const fila = filas[idx];
    
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
  
  await delay(3000);
  
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
 * Descarga el consolidado del modal
 */
async function descargarConsolidado(page, requestId) {
  log('info', `DESCARGA:${requestId}`, 'Buscando botón "Consolidado"...');
  
  const resultado = await evaluarSeguro(page, () => {
    const modal = document.querySelector('.ui-dialog[aria-hidden="false"], .ui-dialog:not([style*="display: none"])');
    
    if (!modal) {
      return { exito: false, error: 'Modal no encontrado' };
    }
    
    // Por ID exacto
    let boton = modal.querySelector('#frmAnexos\\:btnDescargaTodo, [id*="btnDescarga"], [id*="Consolidado"]');
    
    // Por texto
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
    
    // Por span
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
      return { exito: false, error: 'Botón Consolidado no encontrado' };
    }
    
    boton.click();
    return { exito: true, texto: 'Consolidado' };
  });
  
  if (!resultado || !resultado.exito) {
    log('warn', `DESCARGA:${requestId}`, resultado?.error || 'Error al descargar');
    return false;
  }
  
  log('success', `DESCARGA:${requestId}`, '✓ Clic en "Consolidado" - descarga iniciada');
  metricas.consolidadosDescargados++;
  
  await delay(5000);
  
  return true;
}

/**
 * Cierra el modal actual
 */
async function cerrarModal(page, requestId) {
  log('info', `MODAL:${requestId}`, 'Cerrando modal...');
  
  const cerrado = await evaluarSeguro(page, () => {
    const modal = document.querySelector('.ui-dialog[aria-hidden="false"], .ui-dialog:not([style*="display: none"])');
    
    if (!modal) return { exito: true, mensaje: 'No hay modal abierto' };
    
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
 * Procesa las primeras N notificaciones
 */
async function procesarNotificaciones(page, requestId, notificaciones, maxDescargas = 3) {
  const resultados = [];
  const total = Math.min(notificaciones.length, maxDescargas);
  
  log('info', `PROCESO:${requestId}`, `Procesando ${total} de ${notificaciones.length} notificaciones...`);
  
  for (let i = 0; i < total; i++) {
    const notif = notificaciones[i];
    log('info', `PROCESO:${requestId}`, `[${i+1}/${total}] Procesando: ${notif.expediente}`);
    
    const modalAbierto = await abrirModalAnexos(page, requestId, i);
    
    if (!modalAbierto) {
      log('warn', `PROCESO:${requestId}`, `No se pudo abrir modal para ${notif.expediente}`);
      resultados.push({ expediente: notif.expediente, descargado: false, error: 'Modal no abrió' });
      continue;
    }
    
    const descargado = await descargarConsolidado(page, requestId);
    
    resultados.push({
      expediente: notif.expediente,
      nNotificacion: notif.nNotificacion,
      descargado: descargado,
      fecha: notif.fecha
    });
    
    await cerrarModal(page, requestId);
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
  let timeoutCaptchaId = null;
  
  try {
    metricas.scrapersIniciados++;
    
    // PASO 1: Conectar a Browserless
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
    
    // PASO 2: Navegar a SINOE
    log('info', `SCRAPER:${requestId}`, 'Navegando a SINOE...');
    
    await page.goto(SINOE_URLS.login, { waitUntil: 'networkidle2' });
    await delay(3000);
    
    log('success', `SCRAPER:${requestId}`, 'Página de SINOE cargada');
    
    // PASO 3: Manejar página de parámetros
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
    
    // PASO 4: Cerrar popups
    await cerrarPopups(page, `SCRAPER:${requestId}`);
    await delay(1000);
    
    // PASO 5: Esperar campos de login
    log('info', `SCRAPER:${requestId}`, 'Esperando campos de login...');
    await page.waitForSelector('input[type="text"], input[type="password"]', { timeout: TIMEOUT.elemento });
    
    // PASO 6: Llenar credenciales
    log('info', `SCRAPER:${requestId}`, 'Llenando credenciales...');
    await llenarCredenciales(page, sinoeUsuario, sinoePassword);
    await delay(1000);
    
    // PASO 7: Asegurar CAPTCHA válido
    log('info', `SCRAPER:${requestId}`, 'Verificando CAPTCHA...');
    await asegurarCaptchaValido(page, sinoeUsuario, sinoePassword);
    
    // PASO 8: Capturar formulario
    log('info', `SCRAPER:${requestId}`, 'Capturando formulario...');
    
    const screenshotBase64 = await capturarFormularioLogin(page);
    
    if (!screenshotBase64 || screenshotBase64.length < 1000) {
      throw new Error('No se pudo capturar el formulario');
    }
    
    log('success', `SCRAPER:${requestId}`, 'Formulario capturado', { bytes: screenshotBase64.length });
    
    // PASO 9: Enviar imagen por WhatsApp
    log('info', `SCRAPER:${requestId}`, 'Enviando imagen por WhatsApp...');
    
    const caption = `📩 ${nombreAbogado}, escriba el código CAPTCHA que ve en la imagen y envíelo como respuesta.\n\n⏱️ Tiene 5 minutos.\n🔒 Credenciales ya llenadas.`;
    
    if (!await enviarWhatsAppImagen(whatsappNumero, screenshotBase64, caption)) {
      throw new Error('No se pudo enviar la imagen por WhatsApp');
    }
    
    // PASO 10: Esperar respuesta del abogado
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
    
    // PASO 11: Escribir CAPTCHA
    log('info', `SCRAPER:${requestId}`, 'Escribiendo CAPTCHA...');
    
    const campoCaptcha = await page.$('input[placeholder*="CAPTCHA"], input[placeholder*="Captcha"], input[placeholder*="captcha"], input[id*="captcha"]');
    
    if (!campoCaptcha) {
      await enviarWhatsAppTexto(whatsappNumero, '⚠️ La página de SINOE expiró. Por favor intente de nuevo.');
      throw new Error('Campo CAPTCHA no encontrado - la página pudo haber expirado');
    }
    
    // Limpiar el campo completamente antes de escribir
    await campoCaptcha.click({ clickCount: 3 });
    await delay(100);
    await page.keyboard.press('Backspace');
    await delay(100);
    
    // Escribir el CAPTCHA
    const captchaAEscribir = captchaTexto.toUpperCase();
    await campoCaptcha.type(captchaAEscribir, { delay: 50 });
    
    // ═══════════════════════════════════════════════════════════════════
    // FIX v4.9.7: VERIFICAR que el CAPTCHA se escribió correctamente
    // ═══════════════════════════════════════════════════════════════════
    await delay(200);
    
    const verificacionCaptcha = await page.evaluate(() => {
      const campo = document.querySelector(
        'input[placeholder*="CAPTCHA"], input[placeholder*="Captcha"], ' +
        'input[placeholder*="captcha"], input[id*="captcha"]'
      );
      if (!campo) return { encontrado: false };
      return {
        encontrado: true,
        valor: campo.value,
        longitud: campo.value.length
      };
    });
    
    log('info', `SCRAPER:${requestId}`, 'Verificación CAPTCHA escrito:', {
      esperado: captchaAEscribir,
      escrito: verificacionCaptcha.valor,
      coincide: verificacionCaptcha.valor === captchaAEscribir
    });
    
    if (!verificacionCaptcha.encontrado || verificacionCaptcha.valor !== captchaAEscribir) {
      log('warn', `SCRAPER:${requestId}`, 'CAPTCHA no se escribió correctamente, reintentando...');
      
      // Reintentar escribir el CAPTCHA
      await campoCaptcha.click({ clickCount: 3 });
      await delay(100);
      for (let i = 0; i < 10; i++) {
        await page.keyboard.press('Backspace');
      }
      await delay(100);
      await campoCaptcha.type(captchaAEscribir, { delay: 80 });
      await delay(200);
      
      // Verificar de nuevo
      const verificacion2 = await page.evaluate(() => {
        const campo = document.querySelector(
          'input[placeholder*="CAPTCHA"], input[placeholder*="Captcha"], ' +
          'input[placeholder*="captcha"], input[id*="captcha"]'
        );
        return campo ? campo.value : null;
      });
      
      log('info', `SCRAPER:${requestId}`, 'Segunda verificación CAPTCHA:', {
        esperado: captchaAEscribir,
        escrito: verificacion2
      });
    }
    
    // ═══════════════════════════════════════════════════════════════════
    // PASO 12: FIX v4.9.5 - Hacer clic en LOGIN usando PrimeFaces
    // ═══════════════════════════════════════════════════════════════════
    const urlAntes = await leerUrlSegura(page) || SINOE_URLS.login;
    
    log('info', `SCRAPER:${requestId}`, 'Ejecutando login (FIX v4.9.7 - jQuery trigger)...');
    
    const resultadoClic = await hacerClicLoginPrimeFaces(page, requestId);
    
    if (!resultadoClic.exito) {
      log('error', `SCRAPER:${requestId}`, 'Error crítico: No se pudo hacer clic en login', resultadoClic);
      await enviarWhatsAppTexto(whatsappNumero, '⚠️ Error técnico al procesar el login. Intente de nuevo.');
      throw new Error(`Clic en login falló: ${resultadoClic.error}`);
    }
    
    log('info', `SCRAPER:${requestId}`, `Clic en login exitoso (método: ${resultadoClic.metodo})`);
    
    // PASO 13: Esperar navegación después del login
    log('info', `SCRAPER:${requestId}`, 'Esperando que SINOE procese el login...');
    
    // ═══════════════════════════════════════════════════════════════════
    // FIX v4.9.4: Esperar navegación correctamente
    // ═══════════════════════════════════════════════════════════════════
    
    // Estrategia 1: Intentar esperar navegación (puede fallar si no hay navegación)
    try {
      await Promise.race([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
        delay(20000) // Timeout de seguridad
      ]);
      log('info', `SCRAPER:${requestId}`, 'Navegación completada');
    } catch (navError) {
      log('info', `SCRAPER:${requestId}`, 'Timeout de navegación - continuando con verificación');
    }
    
    // Esperar un poco más para que JS termine de renderizar
    await delay(3000);
    
    // Cerrar popups que puedan aparecer
    await cerrarPopups(page, `SCRAPER:${requestId}`);
    await delay(1000);
    
    // ═══════════════════════════════════════════════════════════════════
    // Verificar resultado con REINTENTOS
    // ═══════════════════════════════════════════════════════════════════
    
    let resultado = null;
    const MAX_REINTENTOS_VERIFICACION = 5;
    const ESPERA_ENTRE_REINTENTOS = 3000; // 3 segundos
    
    for (let intento = 1; intento <= MAX_REINTENTOS_VERIFICACION; intento++) {
      resultado = await analizarResultadoLogin(page, urlAntes, requestId);
      
      log('info', `SCRAPER:${requestId}`, `Verificación ${intento}/${MAX_REINTENTOS_VERIFICACION}:`, {
        tipo: resultado.tipo,
        tienePassword: resultado.detalles?.login?.tieneCampoPassword,
        tieneDashboard: resultado.detalles?.dashboard?.tieneFormDashboard
      });
      
      // Si es éxito o error definitivo, salir del loop
      if (resultado.tipo === 'login_exitoso' || 
          resultado.tipo === 'captcha_incorrecto' ||
          resultado.tipo === 'credenciales_invalidas' ||
          resultado.tipo === 'sesion_activa') {
        break;
      }
      
      // Si es login_fallido o indeterminado, podría ser que la página aún no cargó
      // Dar más tiempo solo si aún hay intentos
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
    
    // ═══════════════════════════════════════════════════════════════════════════
    // MANEJO DE SESIÓN ACTIVA - FIX v4.9.9
    // ═══════════════════════════════════════════════════════════════════════════
    // 
    // FLUJO REAL DE SINOE (ocurre ~10% de las veces):
    //   1. Se detecta sesión activa en la página
    //   2. Se hace clic en "FINALIZAR SESIONES"
    //   3. SINOE SIEMPRE redirige a la pantalla de login (comportamiento normal)
    //   4. Hay que rellenar credenciales nuevamente
    //   5. Hay que enviar NUEVO CAPTCHA al usuario
    //   6. Usuario responde con el nuevo CAPTCHA
    //   7. Se hace login y esta vez SÍ ingresa correctamente
    //
    // IMPORTANTE: Después de FINALIZAR SESIONES, SIEMPRE hay que reiniciar
    // el proceso completo. No hay diferencia si "funcionó" o no el clic.
    // ═══════════════════════════════════════════════════════════════════════════
    
    if (resultado.tipo === 'sesion_activa') {
      log('warn', `SCRAPER:${requestId}`, '🔄 SESIÓN ACTIVA DETECTADA (caso normal ~10%)');
      
      await enviarWhatsAppTexto(whatsappNumero, '⏳ Sesión activa detectada. Cerrando sesión anterior...');
      
      // PASO 1: Intentar hacer clic en FINALIZAR SESIONES
      log('info', `SCRAPER:${requestId}`, 'Intentando cerrar sesión activa...');
      await manejarSesionActiva(page, requestId);
      
      // PASO 2: Esperar redirección (SINOE siempre redirige al login después de finalizar)
      log('info', `SCRAPER:${requestId}`, 'Esperando redirección al login...');
      await delay(3000);
      
      // PASO 3: Verificar estado de la página
      let urlActual = await leerUrlSegura(page);
      log('info', `SCRAPER:${requestId}`, `URL después de finalizar: ${urlActual}`);
      
      // Si no estamos en login, navegar manualmente
      const estaEnLogin = urlActual.includes('login');
      if (!estaEnLogin) {
        log('info', `SCRAPER:${requestId}`, 'Navegando a página de login...');
        try {
          await page.goto(SINOE_URLS.login, { waitUntil: 'networkidle2', timeout: TIMEOUT.navegacion });
        } catch (e) {
          await page.goto(SINOE_URLS.params, { waitUntil: 'networkidle2', timeout: TIMEOUT.navegacion });
        }
        await delay(2000);
      }
      
      // PASO 4: Cerrar popups y preparar página
      await cerrarPopups(page, `SCRAPER:${requestId}`);
      await delay(1000);
      
      // PASO 5: Esperar campos de login
      log('info', `SCRAPER:${requestId}`, 'Esperando campos de login...');
      try {
        await page.waitForSelector('input[type="password"]', { timeout: TIMEOUT.elemento });
      } catch (e) {
        log('warn', `SCRAPER:${requestId}`, 'Campos no visibles, refrescando...');
        await page.reload({ waitUntil: 'networkidle2' });
        await delay(2000);
        await cerrarPopups(page, `SCRAPER:${requestId}`);
        await page.waitForSelector('input[type="password"]', { timeout: TIMEOUT.elemento });
      }
      
      // PASO 6: Rellenar credenciales
      log('info', `SCRAPER:${requestId}`, 'Rellenando credenciales...');
      await llenarCredenciales(page, sinoeUsuario, sinoePassword);
      await delay(1000);
      
      // PASO 7: Asegurar CAPTCHA válido
      log('info', `SCRAPER:${requestId}`, 'Verificando CAPTCHA...');
      await asegurarCaptchaValido(page, sinoeUsuario, sinoePassword);
      
      // PASO 8: Capturar formulario con nuevo CAPTCHA
      log('info', `SCRAPER:${requestId}`, 'Capturando nuevo CAPTCHA...');
      const nuevoScreenshot = await capturarFormularioLogin(page);
      
      // PASO 9: Enviar NUEVO CAPTCHA por WhatsApp
      await enviarWhatsAppImagen(whatsappNumero, nuevoScreenshot, 
        `✅ Sesión anterior cerrada.\n\n📩 ${nombreAbogado}, escriba el NUEVO código CAPTCHA:\n\n⏱️ Tiene 5 minutos.\n🔒 Credenciales ya llenadas.`
      );
      
      // PASO 10: Esperar respuesta del usuario con nuevo CAPTCHA
      log('info', `SCRAPER:${requestId}`, 'Esperando NUEVO CAPTCHA del usuario...');
      
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
      
      // PASO 11: Escribir nuevo CAPTCHA
      log('info', `SCRAPER:${requestId}`, 'Escribiendo CAPTCHA...');
      const campoCaptcha2 = await page.$('input[placeholder*="CAPTCHA"], input[placeholder*="Captcha"], input[id*="captcha"]');
      
      if (!campoCaptcha2) {
        throw new Error('Campo CAPTCHA no encontrado en segundo intento');
      }
      
      await campoCaptcha2.click({ clickCount: 3 });
      await delay(100);
      await page.keyboard.press('Backspace');
      await delay(100);
      
      const captcha2 = nuevoCaptcha.toUpperCase();
      await campoCaptcha2.type(captcha2, { delay: 50 });
      
      // Verificar escritura
      await delay(200);
      const valorEscrito = await page.evaluate(() => {
        const c = document.querySelector('input[placeholder*="CAPTCHA"], input[id*="captcha"]');
        return c ? c.value : null;
      });
      log('info', `SCRAPER:${requestId}`, `Verificación: esperado=${captcha2}, escrito=${valorEscrito}`);
      
      // PASO 12: Ejecutar login
      log('info', `SCRAPER:${requestId}`, 'Ejecutando login (segundo intento)...');
      const urlAntes2 = await leerUrlSegura(page);
      const clic2 = await hacerClicLoginPrimeFaces(page, requestId);
      
      if (!clic2.exito) {
        log('warn', `SCRAPER:${requestId}`, 'Clic falló, usando Enter...');
        await page.keyboard.press('Enter');
      }
      
      // PASO 13: Esperar navegación
      log('info', `SCRAPER:${requestId}`, 'Esperando respuesta de SINOE...');
      try {
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
      } catch (e) {
        // Timeout es normal si la página usa AJAX
      }
      
      await delay(TIMEOUT.esperaPostClick);
      await cerrarPopups(page, `SCRAPER:${requestId}`);
      
      // PASO 14: Verificar resultado
      log('info', `SCRAPER:${requestId}`, 'Verificando resultado del login...');
      resultado = await analizarResultadoLogin(page, urlAntes2, requestId);
      
      if (resultado.tipo === 'login_exitoso') {
        log('success', `SCRAPER:${requestId}`, '✅ LOGIN EXITOSO (después de cerrar sesión anterior)');
      } else {
        log('error', `SCRAPER:${requestId}`, `Login falló: ${resultado.mensaje}`);
        await enviarWhatsAppTexto(whatsappNumero, `❌ ${resultado.mensaje}. Por favor intente de nuevo.`);
        throw new Error(`Login falló después de cerrar sesión: ${resultado.mensaje}`);
      }
    }
    
    // MANEJAR OTROS TIPOS DE RESULTADO
    if (resultado.tipo === 'captcha_incorrecto') {
      await enviarWhatsAppTexto(whatsappNumero, '❌ CAPTCHA incorrecto. Intente de nuevo.');
      throw new Error('CAPTCHA incorrecto');
    }
    
    if (resultado.tipo === 'credenciales_invalidas') {
      await enviarWhatsAppTexto(whatsappNumero, '❌ Usuario o contraseña incorrectos. Verifique sus credenciales.');
      throw new Error('Credenciales inválidas');
    }
    
    // FIX v4.9.3: Manejar login fallido explícitamente
    if (resultado.tipo === 'login_fallido') {
      await enviarWhatsAppTexto(whatsappNumero, `❌ ${resultado.mensaje}. Verifique el CAPTCHA e intente de nuevo.`);
      throw new Error(resultado.mensaje);
    }
    
    // Si sigue indeterminado después de reintentos, fallar
    if (resultado.tipo === 'indeterminado') {
      await enviarWhatsAppTexto(whatsappNumero, '⚠️ No se pudo confirmar el login. Intente de nuevo.');
      throw new Error('Login indeterminado después de múltiples verificaciones');
    }
    
    // Si llegamos aquí, el login fue exitoso
    if (resultado.tipo !== 'login_exitoso') {
      throw new Error(`Tipo de resultado inesperado: ${resultado.tipo}`);
    }
    
    log('success', `SCRAPER:${requestId}`, 'Login exitoso en SINOE');
    
    // PASO 15: Navegar a Casillas Electrónicas
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
    
    // PASO 16: Extraer notificaciones
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
    
    await enviarWhatsAppTexto(whatsappNumero,
      `📋 ${nombreAbogado}, se encontraron ${notificaciones.length} notificación(es).\n\n⏳ Descargando consolidados de las primeras 3...`
    );
    
    // PASO 17: Procesar notificaciones
    log('info', `SCRAPER:${requestId}`, 'Procesando notificaciones...');
    const resultadosDescarga = await procesarNotificaciones(page, requestId, notificaciones, 3);
    
    const descargasExitosas = resultadosDescarga.filter(r => r.descargado).length;
    
    // ÉXITO
    const duracionMs = Date.now() - inicioMs;
    metricas.scrapersExitosos++;
    
    const totalExitosos = metricas.scrapersExitosos;
    metricas.tiempoPromedioMs = Math.round(
      ((metricas.tiempoPromedioMs * (totalExitosos - 1)) + duracionMs) / totalExitosos
    );
    
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
    
    if (timeoutCaptchaId) {
      clearTimeout(timeoutCaptchaId);
    }
    
    return { 
      success: false, 
      error: error.message,
      duracionMs: Date.now() - inicioMs,
      requestId
    };
    
  } finally {
    // Limpiar sesión
    for (const [numero, sesion] of sesionesActivas.entries()) {
      if (sesion.requestId === requestId) {
        if (sesion.timeoutId) clearTimeout(sesion.timeoutId);
        sesionesActivas.delete(numero);
        break;
      }
    }
    
    // Cerrar browser
    if (browser) {
      try {
        await browser.close();
        log('info', `SCRAPER:${requestId}`, 'Browser cerrado');
      } catch (e) {
        log('warn', `SCRAPER:${requestId}`, `Error cerrando browser: ${e.message}`);
      }
    }
  }
}

// ============================================================
// MIDDLEWARES
// ============================================================

app.use(express.json({ limit: '1mb' }));

// Rate limiting por IP
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

// Autenticación - acepta X-API-KEY o Authorization: Bearer
app.use((req, res, next) => {
  const publicPaths = ['/health', '/webhook/whatsapp'];
  if (publicPaths.includes(req.path)) return next();
  
  // Acepta ambos formatos: X-API-KEY o Authorization: Bearer
  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  
  if (apiKey !== API_KEY) {
    log('warn', 'AUTH', `Acceso no autorizado a ${req.path}`);
    return res.status(401).json({ success: false, error: 'Token de autenticación requerido' });
  }
  
  next();
});

// ============================================================
// ENDPOINTS
// ============================================================

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    version: '4.9.9',
    fix: 'Sesión activa → reinicio completo → nuevo CAPTCHA',
    uptime: Math.floor(process.uptime()),
    sesionesActivas: sesionesActivas.size
  });
});

// Métricas
app.get('/metricas', (req, res) => {
  res.json({
    ...metricas,
    sesionesActivas: sesionesActivas.size,
    uptimeSegundos: Math.floor(process.uptime())
  });
});

// Lista de sesiones activas
app.get('/sesiones', (req, res) => {
  const sesiones = [];
  for (const [numero, sesion] of sesionesActivas.entries()) {
    sesiones.push({
      numero: enmascarar(numero),
      nombreAbogado: sesion.nombreAbogado,
      requestId: sesion.requestId,
      tiempoEspera: Math.floor((Date.now() - sesion.timestamp) / 1000)
    });
  }
  res.json({ total: sesiones.length, sesiones });
});

// Webhook de WhatsApp
app.post('/webhook/whatsapp', async (req, res) => {
  try {
    const { data } = req.body;
    
    if (!data?.message?.conversation && !data?.message?.extendedTextMessage?.text) {
      return res.status(200).json({ status: 'ignored', reason: 'no_text' });
    }
    
    const mensaje = data.message.conversation || data.message.extendedTextMessage?.text || '';
    const remoteJid = data.key?.remoteJid || '';
    const numero = remoteJid.replace('@s.whatsapp.net', '');
    const messageId = data.key?.id || '';
    
    // Evitar duplicados
    if (webhooksRecientes.has(messageId)) {
      return res.status(200).json({ status: 'duplicate' });
    }
    webhooksRecientes.set(messageId, Date.now());
    
    // Ignorar mensajes propios
    if (data.key?.fromMe) {
      return res.status(200).json({ status: 'ignored', reason: 'own_message' });
    }
    
    log('info', 'WEBHOOK', `Mensaje de ${enmascarar(numero)}: "${mensaje.substring(0, 30)}..."`);
    
    // Buscar sesión activa
    const sesion = sesionesActivas.get(numero);
    
    if (!sesion) {
      log('info', 'WEBHOOK', `No hay sesión activa para ${enmascarar(numero)}`);
      return res.status(200).json({ status: 'no_session' });
    }
    
    // Validar CAPTCHA
    const captchaLimpio = mensaje.trim().toUpperCase();
    const validacion = validarCaptcha(captchaLimpio);
    
    if (!validacion.valido) {
      log('warn', 'WEBHOOK', `CAPTCHA inválido: "${captchaLimpio}" - ${validacion.error}`);
      await enviarWhatsAppTexto(numero, `⚠️ ${validacion.error}\n\nEnvíe solo el código CAPTCHA (5 caracteres).`);
      return res.status(200).json({ status: 'invalid_captcha', error: validacion.error });
    }
    
    log('success', 'WEBHOOK', `CAPTCHA válido recibido: ${captchaLimpio}`);
    
    // Resolver promesa
    if (sesion.resolve) {
      sesion.resolve(captchaLimpio);
    }
    
    res.status(200).json({ status: 'captcha_received', captcha: captchaLimpio });
    
  } catch (error) {
    log('error', 'WEBHOOK', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint principal del scraper
app.post('/scraper', async (req, res) => {
  metricas.requestsTotal++;
  
  const { sinoeUsuario, sinoePassword, whatsappNumero, nombreAbogado } = req.body;
  
  // Validaciones
  if (!sinoeUsuario || !sinoePassword) {
    return res.status(400).json({ success: false, error: 'Credenciales requeridas' });
  }
  
  const numeroValidacion = validarNumeroWhatsApp(whatsappNumero);
  if (!numeroValidacion.valido) {
    return res.status(400).json({ success: false, error: numeroValidacion.error });
  }
  
  // Verificar sesión existente
  if (sesionesActivas.has(numeroValidacion.numero)) {
    return res.status(409).json({ success: false, error: 'Ya hay un proceso activo para este número' });
  }
  
  // Responder inmediatamente
  res.json({ success: true, message: 'Proceso iniciado' });
  
  // Ejecutar scraper en background
  ejecutarScraper({
    sinoeUsuario,
    sinoePassword,
    whatsappNumero: numeroValidacion.numero,
    nombreAbogado: nombreAbogado || 'Dr(a).'
  }).catch(error => {
    log('error', 'SCRAPER', `Error no manejado: ${error.message}`);
  });
});

// ============================================================
// ENDPOINTS DE PRUEBA
// ============================================================

app.post('/test-whatsapp', async (req, res) => {
  try {
    const { numero, mensaje } = req.body;
    
    if (!numero) {
      return res.status(400).json({ error: 'Número requerido' });
    }
    
    const validacion = validarNumeroWhatsApp(numero);
    if (!validacion.valido) {
      return res.status(400).json({ error: validacion.error });
    }
    
    const resultado = await enviarWhatsAppTexto(
      validacion.numero, 
      mensaje || '🤖 Mensaje de prueba de LEXA Scraper v4.9.7'
    );
    
    res.json({ success: resultado, numero: enmascarar(validacion.numero) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/test-conexion', async (req, res) => {
  let browser = null;
  
  try {
    const ws = CONFIG.browserless.token 
      ? `${CONFIG.browserless.url}?token=${CONFIG.browserless.token}`
      : CONFIG.browserless.url;
    
    browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: DEFAULT_VIEWPORT });
    const page = await browser.newPage();
    
    await page.goto(SINOE_URLS.login, { waitUntil: 'networkidle2', timeout: TIMEOUT.navegacion });
    
    const titulo = await page.title();
    const url = await page.url();
    
    res.json({ 
      success: true, 
      browserless: 'conectado',
      sinoe: { titulo, url }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

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

// ============================================================
// NUEVO ENDPOINT: Test de verificación de estado de página
// ============================================================

app.post('/test-verificar-estado', async (req, res) => {
  let browser = null;
  
  try {
    const ws = CONFIG.browserless.token 
      ? `${CONFIG.browserless.url}?token=${CONFIG.browserless.token}`
      : CONFIG.browserless.url;
    
    browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: DEFAULT_VIEWPORT });
    const page = await browser.newPage();
    
    await page.goto(SINOE_URLS.login, { waitUntil: 'networkidle2', timeout: TIMEOUT.navegacion });
    await delay(3000);
    await cerrarPopups(page, 'TEST-ESTADO');
    await delay(1000);
    
    const estado = await verificarEstadoPagina(page);
    
    res.json({ 
      success: true, 
      estado,
      interpretacion: {
        esPaginaLogin: estado.login.tieneCampoPassword || estado.login.tieneCampoCaptcha,
        esDashboard: estado.dashboard.tieneFormDashboard && estado.dashboard.tieneBienvenida,
        esSesionActiva: estado.sesionActiva.detectada
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

// ============================================================
// NUEVO ENDPOINT v4.9.5: Test del clic en login
// ============================================================

app.post('/test-clic-login', async (req, res) => {
  let browser = null;
  
  try {
    const ws = CONFIG.browserless.token 
      ? `${CONFIG.browserless.url}?token=${CONFIG.browserless.token}`
      : CONFIG.browserless.url;
    
    browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: DEFAULT_VIEWPORT });
    const page = await browser.newPage();
    
    await page.goto(SINOE_URLS.login, { waitUntil: 'networkidle2', timeout: TIMEOUT.navegacion });
    await delay(3000);
    await cerrarPopups(page, 'TEST-CLIC');
    await delay(1000);
    
    // Verificar estructura del botón
    const infoBoton = await page.evaluate(() => {
      const boton = document.getElementById('frmLogin:btnIngresar');
      if (!boton) return { existe: false };
      
      return {
        existe: true,
        id: boton.id,
        type: boton.type,
        className: boton.className,
        onclick: boton.getAttribute('onclick'),
        tienePrimeFaces: typeof PrimeFaces !== 'undefined',
        innerHTML: boton.innerHTML.substring(0, 100)
      };
    });
    
    res.json({ 
      success: true, 
      boton: infoBoton,
      mensaje: infoBoton.existe 
        ? 'Botón encontrado correctamente' 
        : 'ADVERTENCIA: Botón no encontrado con ID frmLogin:btnIngresar'
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
  
  const limpiezaInterval = core.getLimpiezaInterval();
  if (limpiezaInterval) clearInterval(limpiezaInterval);
  log('info', 'SHUTDOWN', 'Intervalo de limpieza detenido');
  
  for (const [numero, sesion] of sesionesActivas.entries()) {
    if (sesion.timeoutId) clearTimeout(sesion.timeoutId);
    if (sesion.reject) sesion.reject(new Error('Servidor reiniciándose'));
    if (sesion.browser) await sesion.browser.close().catch(() => {});
  }
  
  sesionesActivas.clear();
  
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
║           LEXA SCRAPER SERVICE v4.9.9 - FIX SESIÓN ACTIVA COMPLETO             ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║  Puerto: ${String(PORT).padEnd(70)}║
║  Auth: ${(process.env.API_KEY ? 'Configurada ✓' : 'Auto-generada ⚠️').padEnd(71)}║
║  WhatsApp: ${(CONFIG.evolution.apiKey ? 'Configurado ✓' : 'NO CONFIGURADO ❌').padEnd(67)}║
║  Browserless: ${(CONFIG.browserless.token ? 'Configurado ✓' : 'Sin token ⚠️').padEnd(64)}║
╠═══════════════════════════════════════════════════════════════════════════════╣
║  FIX v4.9.7 - JQUERY TRIGGER CLICK:                                           ║
║                                                                               ║
║    ✓ PrimeFaces.ab() fallaba desde page.evaluate() (error interno)            ║
║    ✓ SINOE usa jQuery (requerido por PrimeFaces)                              ║
║    ✓ jQuery.trigger('click') simula evento real que PrimeFaces entiende       ║
║                                                                               ║
║  ESTRATEGIAS DE CLIC LOGIN (7):                                               ║
║    1. jQuery .trigger('click') - más probable que funcione                    ║
║    2. jQuery .click()                                                         ║
║    3. onclick.call(boton, fakeEvent)                                          ║
║    4. HTMLElement.click() nativo                                              ║
║    5. MouseEvent con coordenadas                                              ║
║    6. Puppeteer mouse.click() en coordenadas                                  ║
║    7. Focus CAPTCHA + Enter                                                   ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║  ENDPOINTS:                                                                   ║
║    GET  /health              POST /scraper           GET  /metricas           ║
║    GET  /sesiones            POST /webhook/whatsapp  POST /test-whatsapp      ║
║    POST /test-conexion       POST /test-credenciales POST /test-captcha       ║
║    POST /test-verificar-estado                       POST /test-clic-login    ║
╚═══════════════════════════════════════════════════════════════════════════════╝
  `);
  
  if (!process.env.API_KEY) {
    console.log(`\n⚠️  API_KEY auto-generada: ${API_KEY}`);
    console.log('   Configura API_KEY en variables de entorno para producción.\n');
  }
});
