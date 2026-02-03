/**
 * ============================================================
 * LEXA SCRAPER SERVICE v4.9.3 - FIX FALSO POSITIVO LOGIN
 * ============================================================
 * 
 * ARCHIVO MODIFICABLE - Contiene:
 *   - analizarResultadoLogin (FIX v4.9.3) ← CAMBIO PRINCIPAL
 *   - verificarEstadoPagina (NUEVA función auxiliar)
 *   - navegarACasillas (FIX v4.9.2)
 *   - Navegación SINOE post-login
 *   - Endpoints HTTP
 *   - Servidor Express
 * 
 * Las funciones base están en core.js (NO TOCAR)
 * ============================================================
 * 
 * CAMBIOS v4.9.3:
 *   ✓ FIX CRÍTICO: analizarResultadoLogin ya no usa page.content()
 *   ✓ NUEVA ESTRATEGIA: Verifica elementos DOM específicos del dashboard
 *   ✓ Verifica PRESENCIA de: form#frmNuevo, barra "Bienvenido(a):", botones
 *   ✓ Verifica AUSENCIA de: input[type="password"], campo CAPTCHA
 *   ✓ Consistente con navegarACasillas() (usa evaluarSeguro)
 *   ✓ Logging detallado para diagnóstico
 *
 * CAMBIOS v4.9.2:
 *   ✓ FIX: Espera 3s para que página se estabilice post-login
 *   ✓ FIX: Reintentos (3x) si evaluarSeguro retorna null
 *   ✓ Más robusto ante frames en transición
 *
 * CAMBIOS v4.9.1:
 *   ✓ FIX: navegarACasillas ya no aborta si textoExiste=false
 *   ✓ NUEVA estrategia: busca span.txtredbtn con "Casillas"
 * 
 * CAMBIOS v4.9.0:
 *   ✓ FIX: analizarResultadoLogin ya no confunde login.xhtml
 *   ✓ Código dividido en módulos para fácil mantenimiento
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
    // INDICADORES DE ERROR
    // ═══════════════════════════════════════════════════════════════════
    
    const bodyLower = bodyText.toLowerCase();
    const tieneMensajeCaptchaIncorrecto = 
      (bodyLower.includes('captcha') && 
       (bodyLower.includes('incorrecto') || 
        bodyLower.includes('inválido') ||
        bodyLower.includes('invalido') ||
        bodyLower.includes('erróneo') ||
        bodyLower.includes('erroneo')));
    
    const tieneMensajeCredencialesInvalidas = 
      bodyLower.includes('usuario o contraseña') ||
      bodyLower.includes('credenciales') ||
      bodyLower.includes('datos incorrectos');
    
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
        credencialesInvalidas: tieneMensajeCredencialesInvalidas
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
    
    await campoCaptcha.click({ clickCount: 3 });
    await delay(100);
    await page.keyboard.press('Backspace');
    await delay(100);
    await campoCaptcha.type(captchaTexto.toUpperCase(), { delay: 50 });
    
    // PASO 12: Hacer clic en LOGIN
    const urlAntes = await leerUrlSegura(page) || SINOE_URLS.login;
    
    log('info', `SCRAPER:${requestId}`, 'Haciendo clic en botón de login...');
    
    const btnIngresar = await page.$('button[type="submit"], input[type="submit"], .ui-button[type="submit"]');
    
    if (btnIngresar) {
      await btnIngresar.click();
    } else {
      await page.keyboard.press('Enter');
    }
    
    // PASO 13: Esperar y leer página
    log('info', `SCRAPER:${requestId}`, 'Esperando resultado...');
    
    // Esperar a que la página se estabilice
    await delay(TIMEOUT.esperaPostClick);
    
    // Cerrar popups que puedan aparecer
    await cerrarPopups(page, `SCRAPER:${requestId}`);
    await delay(500);
    
    // ═══════════════════════════════════════════════════════════════════
    // FIX v4.9.3: Usar la nueva función analizarResultadoLogin
    // ═══════════════════════════════════════════════════════════════════
    
    let resultado = await analizarResultadoLogin(page, urlAntes, requestId);
    
    // Si es indeterminado, dar un poco más de tiempo y reintentar
    if (resultado.tipo === 'indeterminado') {
      log('info', `SCRAPER:${requestId}`, 'Resultado indeterminado, esperando 3s adicionales...');
      await delay(3000);
      await cerrarPopups(page, `SCRAPER:${requestId}`);
      resultado = await analizarResultadoLogin(page, urlAntes, requestId);
    }
    
    log('info', `SCRAPER:${requestId}`, 'Resultado del análisis:', { 
      tipo: resultado.tipo, 
      mensaje: resultado.mensaje 
    });
    
    // MANEJO DE SESIÓN ACTIVA
    if (resultado.tipo === 'sesion_activa') {
      log('warn', `SCRAPER:${requestId}`, '🔄 Sesión activa detectada - finalizando automáticamente...');
      
      await enviarWhatsAppTexto(whatsappNumero, '⏳ Sesión activa detectada. Finalizando automáticamente...');
      
      const sesionFinalizada = await manejarSesionActiva(page, requestId);
      
      if (!sesionFinalizada) {
        await enviarWhatsAppTexto(whatsappNumero, '❌ No se pudo finalizar la sesión anterior. Ciérrela manualmente en SINOE e intente de nuevo.');
        throw new Error('No se pudo finalizar la sesión activa automáticamente');
      }
      
      // Reintentar login
      log('info', `SCRAPER:${requestId}`, '🔄 Reintentando login después de finalizar sesión...');
      
      await cerrarPopups(page, `SCRAPER:${requestId}`);
      await delay(1000);
      
      await page.waitForSelector('input[type="text"], input[type="password"]', { timeout: TIMEOUT.elemento });
      
      await llenarCredenciales(page, sinoeUsuario, sinoePassword);
      await delay(1000);
      
      await asegurarCaptchaValido(page, sinoeUsuario, sinoePassword);
      
      const nuevoScreenshot = await capturarFormularioLogin(page);
      await enviarWhatsAppImagen(whatsappNumero, nuevoScreenshot, 
        `📩 ${nombreAbogado}, la sesión anterior fue cerrada.\n\nEscriba el NUEVO código CAPTCHA:\n\n⏱️ Tiene 5 minutos.`
      );
      
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
      
      if (nuevoTimeoutId) clearTimeout(nuevoTimeoutId);
      
      const nuevoCampoCaptcha = await page.$('input[placeholder*="CAPTCHA"], input[placeholder*="Captcha"], input[id*="captcha"]');
      if (nuevoCampoCaptcha) {
        await nuevoCampoCaptcha.click({ clickCount: 3 });
        await page.keyboard.press('Backspace');
        await nuevoCampoCaptcha.type(nuevoCaptcha.toUpperCase(), { delay: 50 });
      }
      
      const nuevoUrlAntes = await leerUrlSegura(page);
      const nuevoBtn = await page.$('button[type="submit"], input[type="submit"]');
      if (nuevoBtn) await nuevoBtn.click();
      else await page.keyboard.press('Enter');
      
      await delay(TIMEOUT.esperaPostClick);
      await cerrarPopups(page, `SCRAPER:${requestId}`);
      
      resultado = await analizarResultadoLogin(page, nuevoUrlAntes, requestId);
      
      if (resultado.tipo !== 'login_exitoso') {
        await enviarWhatsAppTexto(whatsappNumero, `❌ ${resultado.mensaje}. Intente de nuevo.`);
        throw new Error(`Error en segundo intento: ${resultado.mensaje}`);
      }
      
      log('success', `SCRAPER:${requestId}`, 'Login exitoso en segundo intento');
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
    version: '4.9.3',
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
    
    if (sesion.timeoutId) {
      clearTimeout(sesion.timeoutId);
    }
    
    sesionesActivas.delete(numero);
    sesion.resolve(validacion.captcha);
    
  } catch (error) {
    log('error', 'WEBHOOK', `Error: ${error.message}`);
  }
});

// Endpoints de diagnóstico
app.post('/test-whatsapp', async (req, res) => {
  const { numero, mensaje } = req.body;
  
  if (!numero) return res.status(400).json({ success: false, error: 'Número requerido' });
  
  const validacion = validarNumeroWhatsApp(numero);
  if (!validacion.valido) return res.status(400).json({ success: false, error: validacion.error });
  
  const enviado = await enviarWhatsAppTexto(validacion.numero, mensaje || '🧪 Test LEXA Scraper v4.9.3');
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
║           LEXA SCRAPER SERVICE v4.9.3 - FIX FALSO POSITIVO LOGIN              ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║  Puerto: ${String(PORT).padEnd(70)}║
║  Auth: ${(process.env.API_KEY ? 'Configurada ✓' : 'Auto-generada ⚠️').padEnd(71)}║
║  WhatsApp: ${(CONFIG.evolution.apiKey ? 'Configurado ✓' : 'NO CONFIGURADO ❌').padEnd(67)}║
║  Browserless: ${(CONFIG.browserless.token ? 'Configurado ✓' : 'Sin token ⚠️').padEnd(64)}║
╠═══════════════════════════════════════════════════════════════════════════════╣
║  FIX v4.9.3 - CAMBIO CRÍTICO:                                                 ║
║                                                                               ║
║    ✓ analizarResultadoLogin() REESCRITO completamente                         ║
║    ✓ Ya NO usa page.content() (causaba falsos positivos)                      ║
║    ✓ Ahora verifica elementos DOM específicos del dashboard                   ║
║    ✓ Verifica PRESENCIA de: form#frmNuevo, barra Bienvenido, botones          ║
║    ✓ Verifica AUSENCIA de: input[type="password"], campo CAPTCHA              ║
║    ✓ Consistente con navegarACasillas() (ambos usan evaluarSeguro)            ║
║                                                                               ║
║  ESTRATEGIAS DE BÚSQUEDA CASILLAS (6):                                        ║
║    1. ID exacto: #frmNuevo:j_idt38                                            ║
║    2. span.txtredbtn → enlace padre                                           ║
║    3. a.ui-commandlink con texto "casillas"                                   ║
║    4. a[onclick*="submit"] con texto "casillas"                               ║
║    5. div.btnservicios → enlace padre                                         ║
║    6. Primer enlace frmNuevo (último recurso)                                 ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║  ENDPOINTS:                                                                   ║
║    GET  /health              POST /scraper           GET  /metricas           ║
║    GET  /sesiones            POST /webhook/whatsapp  POST /test-whatsapp      ║
║    POST /test-conexion       POST /test-credenciales POST /test-captcha       ║
║    POST /test-verificar-estado (NUEVO - para diagnóstico)                     ║
╚═══════════════════════════════════════════════════════════════════════════════╝
  `);
  
  if (!process.env.API_KEY) {
    console.log(`\n⚠️  API_KEY auto-generada: ${API_KEY}`);
    console.log('   Configura API_KEY en variables de entorno para producción.\n');
  }
});
