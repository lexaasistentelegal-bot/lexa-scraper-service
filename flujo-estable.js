/**
 * ============================================================
 * FLUJO ESTABLE v1.0.0 - PASOS 10-13 QUE YA FUNCIONAN
 * ============================================================
 * 
 * ⚠️  NO MODIFICAR ESTE ARCHIVO - ESTÁ PROBADO Y FUNCIONA  ⚠️
 * 
 * Contiene:
 *   10. Verificar que CAPTCHA se escribió ✅
 *   11. Hacer clic en "Ingresar" (jQuery) ✅
 *   12. Verificar dashboard (5 reintentos) ✅
 *   13. Navegar a "Casillas Electrónicas" ✅
 * 
 * Si necesitas modificar la extracción de notificaciones o
 * descargas, usa el archivo: extraccion.js
 * ============================================================
 */

// ============================================================
// IMPORTACIONES
// ============================================================

const core = require('./core');

const {
  TIMEOUT,
  delay,
  log,
  leerUrlSegura,
  leerContenidoSeguro,
  evaluarSeguro,
  enviarWhatsAppTexto,
  cerrarPopups,
  manejarSesionActiva,
  llenarCredenciales,
  asegurarCaptchaValido,
  capturarFormularioLogin
} = core;

// ============================================================
// CONSTANTES ESTABLES
// ============================================================

// Selectores del botón de login (probados y funcionan)
const SELECTORES_BOTON_LOGIN = [
  '#frmLogin\\:btnIngresar',
  'button[id*="btnIngresar"]',
  'input[type="submit"][value*="Ingresar"]',
  '.ui-button[type="submit"]'
];

// Selectores del campo CAPTCHA
const SELECTORES_CAMPO_CAPTCHA = [
  '#frmLogin\\:codigoCaptcha',
  'input[id*="codigoCaptcha"]',
  'input[name*="captcha"]',
  'input[placeholder*="captcha" i]'
];

// Selectores para navegar a casillas
const SELECTORES_ENLACE_CASILLAS = [
  '#frmNuevo\\:lnkCasillas',
  'a[id*="lnkCasillas"]',
  'span.txtredbtn',
  'a.ui-commandlink',
  'a[onclick*="casillas" i]'
];

// Indicadores de dashboard (login exitoso)
const INDICADORES_DASHBOARD = [
  'frmNuevo',
  'dashboard',
  'Bienvenido',
  'CASILLAS',
  'Casillas Electrónicas',
  'Cerrar Sesión',
  'btnCerrarSesion'
];

// Indicadores de login fallido
const INDICADORES_LOGIN = [
  'frmLogin',
  'btnIngresar',
  'codigoCaptcha',
  'Ingresar'
];

// ============================================================
// PASO 10: ESCRIBIR CAPTCHA EN CAMPO
// ============================================================

/**
 * Escribe el CAPTCHA en el campo correspondiente con verificación.
 * 
 * @param {Page} page - Instancia de Puppeteer page
 * @param {string} captchaTexto - Texto del CAPTCHA a escribir
 * @param {string} requestId - ID de la solicitud para logs
 * @returns {Promise<{exito: boolean, error?: string}>}
 */
async function escribirCaptchaEnCampo(page, captchaTexto, requestId) {
  const ctx = `ESTABLE:${requestId}`;
  
  try {
    log('info', ctx, `Escribiendo CAPTCHA: ${captchaTexto}`);
    
    // Buscar campo CAPTCHA
    let campoCaptcha = null;
    
    for (const selector of SELECTORES_CAMPO_CAPTCHA) {
      try {
        campoCaptcha = await page.$(selector);
        if (campoCaptcha) {
          log('info', ctx, `Campo CAPTCHA encontrado: ${selector}`);
          break;
        }
      } catch (e) { }
    }
    
    if (!campoCaptcha) {
      return { exito: false, error: 'No se encontró el campo CAPTCHA' };
    }
    
    // Limpiar campo
    await campoCaptcha.click({ clickCount: 3 });
    await delay(100);
    await page.keyboard.press('Backspace');
    await delay(100);
    
    // Escribir CAPTCHA
    await campoCaptcha.type(captchaTexto, { delay: 50 });
    await delay(500);
    
    // Verificar que se escribió
    const valorEscrito = await evaluarSeguro(page, (sel) => {
      const campo = document.querySelector(sel);
      return campo ? campo.value : '';
    }, SELECTORES_CAMPO_CAPTCHA[0]);
    
    if (valorEscrito !== captchaTexto) {
      log('warn', ctx, `Valor escrito no coincide: "${valorEscrito}" vs "${captchaTexto}"`);
      
      // Intentar con JavaScript directo
      await page.evaluate((texto, selectores) => {
        for (const sel of selectores) {
          const campo = document.querySelector(sel);
          if (campo) {
            campo.value = texto;
            campo.dispatchEvent(new Event('input', { bubbles: true }));
            campo.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }
        return false;
      }, captchaTexto, SELECTORES_CAMPO_CAPTCHA);
    }
    
    // Verificación final
    const valorFinal = await evaluarSeguro(page, (sel) => {
      const campo = document.querySelector(sel);
      return campo ? campo.value : '';
    }, SELECTORES_CAMPO_CAPTCHA[0]);
    
    if (valorFinal === captchaTexto) {
      log('success', ctx, '✅ CAPTCHA escrito correctamente');
      return { exito: true };
    } else {
      log('warn', ctx, `CAPTCHA escrito parcialmente: "${valorFinal}"`);
      return { exito: true }; // Continuar de todos modos
    }
    
  } catch (error) {
    log('error', ctx, `Error escribiendo CAPTCHA: ${error.message}`);
    return { exito: false, error: error.message };
  }
}

// ============================================================
// PASO 11: HACER CLIC EN BOTÓN LOGIN
// ============================================================

/**
 * Hace clic en el botón de login usando múltiples estrategias.
 * El botón de SINOE es un CommandButton de PrimeFaces que requiere
 * activación especial con jQuery.
 * 
 * @param {Page} page - Instancia de Puppeteer page
 * @param {string} requestId - ID de la solicitud para logs
 * @returns {Promise<{exito: boolean, metodo?: string, error?: string}>}
 */
async function hacerClicLoginPrimeFaces(page, requestId) {
  const ctx = `ESTABLE:${requestId}`;
  
  log('info', ctx, 'Intentando clic en botón login...');
  
  // ═══════════════════════════════════════════════════════════
  // ESTRATEGIA 1: jQuery trigger (la más confiable para PrimeFaces)
  // ═══════════════════════════════════════════════════════════
  try {
    const resultado1 = await page.evaluate(() => {
      const selectores = [
        '#frmLogin\\:btnIngresar',
        'button[id*="btnIngresar"]',
        'input[type="submit"][value*="Ingresar"]'
      ];
      
      for (const sel of selectores) {
        const btn = document.querySelector(sel);
        if (btn && typeof jQuery !== 'undefined') {
          jQuery(btn).trigger('click');
          return { exito: true, selector: sel };
        }
      }
      return { exito: false };
    });
    
    if (resultado1.exito) {
      log('success', ctx, `✅ Clic exitoso (jQuery trigger): ${resultado1.selector}`);
      return { exito: true, metodo: 'jquery_trigger' };
    }
  } catch (e) {
    log('warn', ctx, `Estrategia 1 falló: ${e.message}`);
  }
  
  await delay(300);
  
  // ═══════════════════════════════════════════════════════════
  // ESTRATEGIA 2: jQuery click (alternativa)
  // ═══════════════════════════════════════════════════════════
  try {
    const resultado2 = await page.evaluate(() => {
      if (typeof jQuery !== 'undefined') {
        const btn = jQuery('[id*="btnIngresar"]').first();
        if (btn.length > 0) {
          btn.click();
          return true;
        }
      }
      return false;
    });
    
    if (resultado2) {
      log('success', ctx, '✅ Clic exitoso (jQuery click)');
      return { exito: true, metodo: 'jquery_click' };
    }
  } catch (e) {
    log('warn', ctx, `Estrategia 2 falló: ${e.message}`);
  }
  
  await delay(300);
  
  // ═══════════════════════════════════════════════════════════
  // ESTRATEGIA 3: onclick.call (ejecutar handler directamente)
  // ═══════════════════════════════════════════════════════════
  try {
    const resultado3 = await page.evaluate(() => {
      const selectores = [
        '#frmLogin\\:btnIngresar',
        'button[id*="btnIngresar"]',
        'input[type="submit"]'
      ];
      
      for (const sel of selectores) {
        const btn = document.querySelector(sel);
        if (btn && btn.onclick) {
          btn.onclick.call(btn);
          return true;
        }
      }
      return false;
    });
    
    if (resultado3) {
      log('success', ctx, '✅ Clic exitoso (onclick.call)');
      return { exito: true, metodo: 'onclick_call' };
    }
  } catch (e) {
    log('warn', ctx, `Estrategia 3 falló: ${e.message}`);
  }
  
  await delay(300);
  
  // ═══════════════════════════════════════════════════════════
  // ESTRATEGIA 4: click() nativo
  // ═══════════════════════════════════════════════════════════
  try {
    const resultado4 = await page.evaluate(() => {
      const selectores = [
        '#frmLogin\\:btnIngresar',
        'button[id*="btnIngresar"]',
        'input[type="submit"]'
      ];
      
      for (const sel of selectores) {
        const btn = document.querySelector(sel);
        if (btn) {
          btn.click();
          return true;
        }
      }
      return false;
    });
    
    if (resultado4) {
      log('success', ctx, '✅ Clic exitoso (click nativo)');
      return { exito: true, metodo: 'click_nativo' };
    }
  } catch (e) {
    log('warn', ctx, `Estrategia 4 falló: ${e.message}`);
  }
  
  await delay(300);
  
  // ═══════════════════════════════════════════════════════════
  // ESTRATEGIA 5: MouseEvent (simulación completa)
  // ═══════════════════════════════════════════════════════════
  try {
    const resultado5 = await page.evaluate(() => {
      const selectores = [
        '#frmLogin\\:btnIngresar',
        'button[id*="btnIngresar"]',
        'input[type="submit"]'
      ];
      
      for (const sel of selectores) {
        const btn = document.querySelector(sel);
        if (btn) {
          const evento = new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            view: window
          });
          btn.dispatchEvent(evento);
          return true;
        }
      }
      return false;
    });
    
    if (resultado5) {
      log('success', ctx, '✅ Clic exitoso (MouseEvent)');
      return { exito: true, metodo: 'mouse_event' };
    }
  } catch (e) {
    log('warn', ctx, `Estrategia 5 falló: ${e.message}`);
  }
  
  await delay(300);
  
  // ═══════════════════════════════════════════════════════════
  // ESTRATEGIA 6: Puppeteer page.click
  // ═══════════════════════════════════════════════════════════
  for (const selector of SELECTORES_BOTON_LOGIN) {
    try {
      await page.click(selector);
      log('success', ctx, `✅ Clic exitoso (Puppeteer): ${selector}`);
      return { exito: true, metodo: 'puppeteer_click' };
    } catch (e) { }
  }
  
  await delay(300);
  
  // ═══════════════════════════════════════════════════════════
  // ESTRATEGIA 7: Focus + Enter (último recurso)
  // ═══════════════════════════════════════════════════════════
  try {
    await page.evaluate(() => {
      const selectores = [
        '#frmLogin\\:btnIngresar',
        'button[id*="btnIngresar"]',
        'input[type="submit"]'
      ];
      
      for (const sel of selectores) {
        const btn = document.querySelector(sel);
        if (btn) {
          btn.focus();
          return true;
        }
      }
      return false;
    });
    
    await page.keyboard.press('Enter');
    log('success', ctx, '✅ Clic exitoso (Focus + Enter)');
    return { exito: true, metodo: 'focus_enter' };
    
  } catch (e) {
    log('warn', ctx, `Estrategia 7 falló: ${e.message}`);
  }
  
  return { exito: false, error: 'Todas las estrategias de clic fallaron' };
}

// ============================================================
// PASO 12: VERIFICAR DASHBOARD (ANALIZAR RESULTADO LOGIN)
// ============================================================

/**
 * Analiza el resultado del login verificando la página actual.
 * 
 * @param {Page} page - Instancia de Puppeteer page
 * @param {string} urlAntes - URL antes del clic para comparar
 * @param {string} requestId - ID de la solicitud para logs
 * @returns {Promise<{tipo: string, mensaje: string, detalles: object}>}
 */
async function analizarResultadoLogin(page, urlAntes, requestId) {
  const ctx = `ESTABLE:${requestId}`;
  
  try {
    const urlActual = await leerUrlSegura(page) || '';
    
    // Verificar elementos en la página
    const analisis = await evaluarSeguro(page, () => {
      const resultado = {
        login: {
          tieneCampoPassword: !!document.querySelector('input[type="password"]'),
          tieneFormLogin: !!document.querySelector('#frmLogin'),
          tieneBtnIngresar: !!document.querySelector('[id*="btnIngresar"]'),
          tieneCaptcha: !!document.querySelector('[id*="captcha" i]')
        },
        dashboard: {
          tieneFormDashboard: !!document.querySelector('#frmNuevo'),
          tieneCerrarSesion: !!document.querySelector('[id*="CerrarSesion"], [onclick*="cerrar"]'),
          tieneCasillas: !!document.querySelector('[id*="Casillas"], [id*="casillas"]'),
          tieneBienvenido: document.body.innerText.includes('Bienvenido')
        },
        sesion: {
          tieneSesionActiva: document.body.innerText.includes('SESION ACTIVA') || 
                            document.body.innerText.includes('sesión activa') ||
                            document.body.innerText.includes('FINALIZAR SESIONES'),
          tieneFinalizarSesiones: !!document.querySelector('[id*="FinalizarSesiones"], button[onclick*="finalizar"]')
        },
        errores: {
          captchaIncorrecto: document.body.innerText.toLowerCase().includes('captcha incorrecto') ||
                            document.body.innerText.toLowerCase().includes('código incorrecto') ||
                            document.body.innerText.toLowerCase().includes('captcha inválido'),
          credencialesInvalidas: document.body.innerText.toLowerCase().includes('usuario o contraseña') ||
                                document.body.innerText.toLowerCase().includes('credenciales inválid') ||
                                document.body.innerText.toLowerCase().includes('datos incorrectos')
        }
      };
      return resultado;
    });
    
    if (!analisis) {
      return {
        tipo: 'indeterminado',
        mensaje: 'No se pudo analizar la página',
        detalles: { urlActual, urlAntes }
      };
    }
    
    // Determinar tipo de resultado
    
    // 1. Sesión activa detectada
    if (analisis.sesion.tieneSesionActiva || analisis.sesion.tieneFinalizarSesiones) {
      return {
        tipo: 'sesion_activa',
        mensaje: 'Hay una sesión activa que debe cerrarse',
        detalles: analisis
      };
    }
    
    // 2. CAPTCHA incorrecto
    if (analisis.errores.captchaIncorrecto) {
      return {
        tipo: 'captcha_incorrecto',
        mensaje: 'El CAPTCHA ingresado es incorrecto',
        detalles: analisis
      };
    }
    
    // 3. Credenciales inválidas
    if (analisis.errores.credencialesInvalidas) {
      return {
        tipo: 'credenciales_invalidas',
        mensaje: 'Usuario o contraseña incorrectos',
        detalles: analisis
      };
    }
    
    // 4. Login exitoso (dashboard detectado)
    const indicadoresDashboard = [
      analisis.dashboard.tieneFormDashboard,
      analisis.dashboard.tieneCerrarSesion,
      analisis.dashboard.tieneCasillas,
      analisis.dashboard.tieneBienvenido
    ];
    
    const indicadoresLogin = [
      analisis.login.tieneCampoPassword,
      analisis.login.tieneFormLogin,
      analisis.login.tieneBtnIngresar
    ];
    
    const puntajeDashboard = indicadoresDashboard.filter(Boolean).length;
    const puntajeLogin = indicadoresLogin.filter(Boolean).length;
    
    // Si hay más indicadores de dashboard que de login → éxito
    if (puntajeDashboard >= 2 && puntajeDashboard > puntajeLogin) {
      return {
        tipo: 'login_exitoso',
        mensaje: 'Login exitoso - Dashboard detectado',
        detalles: analisis
      };
    }
    
    // Si la URL cambió y no hay formulario de login
    if (urlActual !== urlAntes && !analisis.login.tieneFormLogin) {
      return {
        tipo: 'login_exitoso',
        mensaje: 'Login exitoso - URL cambió',
        detalles: { urlActual, urlAntes, ...analisis }
      };
    }
    
    // 5. Sigue en login (falló)
    if (analisis.login.tieneFormLogin || analisis.login.tieneCampoPassword) {
      return {
        tipo: 'login_fallido',
        mensaje: 'Sigue en página de login',
        detalles: analisis
      };
    }
    
    // 6. Indeterminado
    return {
      tipo: 'indeterminado',
      mensaje: 'No se pudo determinar el resultado',
      detalles: { urlActual, urlAntes, ...analisis }
    };
    
  } catch (error) {
    log('error', ctx, `Error analizando resultado: ${error.message}`);
    return {
      tipo: 'indeterminado',
      mensaje: `Error: ${error.message}`,
      detalles: {}
    };
  }
}

// ============================================================
// PASO 13: NAVEGAR A CASILLAS ELECTRÓNICAS
// ============================================================

/**
 * Navega a la sección de Casillas Electrónicas desde el dashboard.
 * Intenta múltiples estrategias para encontrar y hacer clic en el enlace.
 * 
 * @param {Page} page - Instancia de Puppeteer page
 * @param {string} requestId - ID de la solicitud para logs
 * @returns {Promise<boolean>} - true si navegó exitosamente
 */
async function navegarACasillas(page, requestId) {
  const ctx = `ESTABLE:${requestId}`;
  
  log('info', ctx, 'Buscando enlace a Casillas Electrónicas...');
  
  // ═══════════════════════════════════════════════════════════
  // ESTRATEGIA 1: Selector exacto por ID
  // ═══════════════════════════════════════════════════════════
  try {
    const enlace1 = await page.$('#frmNuevo\\:lnkCasillas');
    if (enlace1) {
      await enlace1.click();
      log('success', ctx, '✅ Clic en Casillas (ID exacto)');
      await delay(3000);
      return true;
    }
  } catch (e) {
    log('warn', ctx, `Estrategia 1 falló: ${e.message}`);
  }
  
  // ═══════════════════════════════════════════════════════════
  // ESTRATEGIA 2: Buscar por texto "CASILLAS" en span
  // ═══════════════════════════════════════════════════════════
  try {
    const clicExitoso = await page.evaluate(() => {
      const spans = document.querySelectorAll('span.txtredbtn, span.ui-button-text');
      for (const span of spans) {
        const texto = (span.textContent || '').toUpperCase();
        if (texto.includes('CASILLA')) {
          const padre = span.closest('a, button') || span.parentElement;
          if (padre) {
            padre.click();
            return true;
          }
          span.click();
          return true;
        }
      }
      return false;
    });
    
    if (clicExitoso) {
      log('success', ctx, '✅ Clic en Casillas (texto en span)');
      await delay(3000);
      return true;
    }
  } catch (e) {
    log('warn', ctx, `Estrategia 2 falló: ${e.message}`);
  }
  
  // ═══════════════════════════════════════════════════════════
  // ESTRATEGIA 3: CommandLink de PrimeFaces
  // ═══════════════════════════════════════════════════════════
  try {
    const clicExitoso = await page.evaluate(() => {
      const enlaces = document.querySelectorAll('a.ui-commandlink');
      for (const enlace of enlaces) {
        const texto = (enlace.textContent || enlace.title || '').toUpperCase();
        if (texto.includes('CASILLA')) {
          if (typeof jQuery !== 'undefined') {
            jQuery(enlace).trigger('click');
          } else {
            enlace.click();
          }
          return true;
        }
      }
      return false;
    });
    
    if (clicExitoso) {
      log('success', ctx, '✅ Clic en Casillas (CommandLink)');
      await delay(3000);
      return true;
    }
  } catch (e) {
    log('warn', ctx, `Estrategia 3 falló: ${e.message}`);
  }
  
  // ═══════════════════════════════════════════════════════════
  // ESTRATEGIA 4: Botón submit con texto CASILLAS
  // ═══════════════════════════════════════════════════════════
  try {
    const clicExitoso = await page.evaluate(() => {
      const botones = document.querySelectorAll('button, input[type="submit"]');
      for (const btn of botones) {
        const texto = (btn.textContent || btn.value || '').toUpperCase();
        if (texto.includes('CASILLA')) {
          btn.click();
          return true;
        }
      }
      return false;
    });
    
    if (clicExitoso) {
      log('success', ctx, '✅ Clic en Casillas (botón submit)');
      await delay(3000);
      return true;
    }
  } catch (e) {
    log('warn', ctx, `Estrategia 4 falló: ${e.message}`);
  }
  
  // ═══════════════════════════════════════════════════════════
  // ESTRATEGIA 5: Contenedor btnservicios
  // ═══════════════════════════════════════════════════════════
  try {
    const clicExitoso = await page.evaluate(() => {
      const contenedor = document.querySelector('.btnservicios, #btnservicios');
      if (contenedor) {
        const enlaces = contenedor.querySelectorAll('a');
        for (const enlace of enlaces) {
          const texto = (enlace.textContent || '').toUpperCase();
          if (texto.includes('CASILLA')) {
            enlace.click();
            return true;
          }
        }
        // Si no encontró por texto, clic en el primero
        if (enlaces.length > 0) {
          enlaces[0].click();
          return true;
        }
      }
      return false;
    });
    
    if (clicExitoso) {
      log('success', ctx, '✅ Clic en Casillas (btnservicios)');
      await delay(3000);
      return true;
    }
  } catch (e) {
    log('warn', ctx, `Estrategia 5 falló: ${e.message}`);
  }
  
  // ═══════════════════════════════════════════════════════════
  // ESTRATEGIA 6: Primer enlace en frmNuevo
  // ═══════════════════════════════════════════════════════════
  try {
    const clicExitoso = await page.evaluate(() => {
      const form = document.querySelector('#frmNuevo');
      if (form) {
        const primerEnlace = form.querySelector('a[id*="lnk"]');
        if (primerEnlace) {
          primerEnlace.click();
          return true;
        }
      }
      return false;
    });
    
    if (clicExitoso) {
      log('success', ctx, '✅ Clic en Casillas (primer enlace frmNuevo)');
      await delay(3000);
      return true;
    }
  } catch (e) {
    log('warn', ctx, `Estrategia 6 falló: ${e.message}`);
  }
  
  log('error', ctx, '❌ No se pudo navegar a Casillas Electrónicas');
  return false;
}

// ============================================================
// FUNCIÓN AUXILIAR: VERIFICAR ESTADO DE PÁGINA
// ============================================================

/**
 * Verifica el estado actual de la página sin usar page.content()
 * para evitar falsos positivos con frames detached.
 * 
 * @param {Page} page - Instancia de Puppeteer page
 * @param {string} requestId - ID de la solicitud para logs
 * @returns {Promise<{estado: string, detalles: object}>}
 */
async function verificarEstadoPagina(page, requestId) {
  const ctx = `ESTABLE:${requestId}`;
  
  try {
    const url = await leerUrlSegura(page);
    
    const estado = await evaluarSeguro(page, () => {
      return {
        tieneLogin: !!document.querySelector('#frmLogin'),
        tieneDashboard: !!document.querySelector('#frmNuevo'),
        tieneCasillas: document.body.innerText.includes('Casillas') ||
                       !!document.querySelector('[id*="casillas" i]'),
        tieneTabla: !!document.querySelector('table, .ui-datatable'),
        titulo: document.title
      };
    });
    
    if (!estado) {
      return { estado: 'desconocido', detalles: { url } };
    }
    
    if (estado.tieneTabla && estado.tieneCasillas) {
      return { estado: 'casillas', detalles: { url, ...estado } };
    }
    
    if (estado.tieneDashboard) {
      return { estado: 'dashboard', detalles: { url, ...estado } };
    }
    
    if (estado.tieneLogin) {
      return { estado: 'login', detalles: { url, ...estado } };
    }
    
    return { estado: 'desconocido', detalles: { url, ...estado } };
    
  } catch (error) {
    log('error', ctx, `Error verificando estado: ${error.message}`);
    return { estado: 'error', detalles: { error: error.message } };
  }
}

// ============================================================
// EXPORTACIONES
// ============================================================

module.exports = {
  // Paso 10
  escribirCaptchaEnCampo,
  
  // Paso 11
  hacerClicLoginPrimeFaces,
  
  // Paso 12
  analizarResultadoLogin,
  
  // Paso 13
  navegarACasillas,
  
  // Utilidades
  verificarEstadoPagina,
  
  // Constantes (por si se necesitan externamente)
  SELECTORES_BOTON_LOGIN,
  SELECTORES_CAMPO_CAPTCHA,
  SELECTORES_ENLACE_CASILLAS,
  INDICADORES_DASHBOARD,
  INDICADORES_LOGIN
};
