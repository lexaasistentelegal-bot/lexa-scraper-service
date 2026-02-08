/**
 * ============================================================
 * CERRAR.JS - Cierre Seguro de Modal de Anexos
 * ============================================================
 * 
 * Propósito:
 * Cerrar el modal de anexos de forma segura, verificando la 
 * sesión de Puppeteer y esperando la recarga AJAX de la tabla.
 * 
 * CRÍTICO:
 * 1. Verifica que sesión de Puppeteer esté activa (evita crashes)
 * 2. Múltiples estrategias de cierre (botón X, footer, ID, Escape)
 * 3. Espera recarga AJAX completa de tabla (2.5s + esperarTablaCargada)
 * 4. Espera estabilización de data-ri (1.5s adicional)
 * 
 * Esto resuelve el bug donde cerrar el modal sin esperar
 * desincroniza los data-ri y causa que notificaciones 2-9 fallen.
 * 
 * ============================================================
 */

const { delay, log, evaluarSeguro } = require('./core');
const { esperarTablaCargada, verificarEstadoTablaActual } = require('./extraccion');
const { SELECTORES_MODAL } = require('./modal');

// ============================================================
// CONFIGURACIÓN
// ============================================================

const CONFIG_CERRAR = {
  timeoutCerrarModal: 10000,       // 10s para que modal se cierre
  esperaPostClic: 2500,            // 2.5s después del clic
  tiempoEstabilidadDom: 1500,      // 1.5s para estabilizar data-ri
  intervaloVerificacion: 300,      // Verificar cada 300ms
  maxReintentos: 2                 // Reintentar cierre hasta 2 veces
};

// Selectores adicionales para cerrar
const SELECTORES_CERRAR = {
  botonX: [
    '.ui-dialog-titlebar-close',
    '.ui-dialog-titlebar .ui-icon-closethick',
    'button.ui-dialog-titlebar-close'
  ],
  
  botonFooter: [
    '.ui-dialog-footer button',
    '.ui-dialog-footer a',
    '.ui-dialog-buttonpane button'
  ],
  
  botonPorId: [
    'button[id*="Cerrar"]',
    'a[id*="Cerrar"]',
    'button[id*="cerrar"]',
    'a[id*="cerrar"]'
  ],
  
  botonPorTexto: [
    'button:has-text("Cerrar")',
    'a:has-text("Cerrar")',
    'button:has-text("CERRAR")'
  ]
};

// ============================================================
// FUNCIÓN PRINCIPAL
// ============================================================

/**
 * Cierra el modal de anexos de forma segura.
 * 
 * IMPORTANTE:
 * 1. Verifica que la sesión de Puppeteer esté activa
 * 2. Hace clic en botón "Cerrar" con múltiples estrategias
 * 3. Espera que el modal desaparezca (aria-hidden="true")
 * 4. ⭐ CRÍTICO: Espera que la tabla se recargue vía AJAX
 * 5. ⭐ CRÍTICO: Espera estabilización de data-ri (1500ms)
 * 
 * @param {Page}   page      - Instancia de Puppeteer page
 * @param {string} requestId - ID único para logs
 * @returns {Promise<{cerrado: boolean, tablaRecargada: boolean, error?: string, filasVisibles?: number}>}
 */
async function cerrarModal(page, requestId) {
  const ctx = `[CERRAR][${requestId}]`;
  
  try {
    // ═══════════════════════════════════════════════════════════
    // PASO 1: Validar sesión de Puppeteer
    // ═══════════════════════════════════════════════════════════
    
    if (!page || page.isClosed()) {
      log('error', ctx, 'Sesión de Puppeteer cerrada');
      return {
        cerrado: false,
        tablaRecargada: false,
        error: 'Sesión de Puppeteer cerrada',
        recuperable: false
      };
    }
    
    log('info', ctx, 'Iniciando cierre de modal...');
    
    // ═══════════════════════════════════════════════════════════
    // PASO 2: Verificar que modal esté visible
    // ═══════════════════════════════════════════════════════════
    
    const modalVisible = await evaluarSeguro(page, (selectores) => {
      for (const selector of selectores.contenedor) {
        const modal = document.querySelector(selector);
        if (modal && modal.getAttribute('aria-hidden') === 'false') {
          return true;
        }
      }
      return false;
    }, SELECTORES_MODAL);
    
    if (modalVisible === null) {
      log('warn', ctx, 'No se pudo verificar estado del modal (evaluación null)');
      // Continuar de todos modos, intentar cerrar
    } else if (!modalVisible) {
      log('info', ctx, 'Modal ya está cerrado');
      
      // Esperar estabilización de todos modos
      await delay(CONFIG_CERRAR.tiempoEstabilidadDom);
      
      return {
        cerrado: true,
        tablaRecargada: true,
        yaCerrado: true
      };
    }
    
    // ═══════════════════════════════════════════════════════════
    // PASO 3: Intentar cerrar modal (múltiples estrategias)
    // ═══════════════════════════════════════════════════════════
    
    log('info', ctx, 'Buscando botón de cierre...');
    
    const resultadoClic = await evaluarSeguro(page, (selectoresCerrar, selectoresModal) => {
      // Buscar modal visible
      let modal = null;
      for (const selector of selectoresModal.contenedor) {
        const m = document.querySelector(selector);
        if (m && m.getAttribute('aria-hidden') === 'false') {
          modal = m;
          break;
        }
      }
      
      if (!modal) {
        return { exito: false, error: 'Modal no encontrado' };
      }
      
      // Estrategia 1: Botón X en titlebar (más confiable)
      for (const selector of selectoresCerrar.botonX) {
        const botonX = modal.querySelector(selector);
        if (botonX && !botonX.disabled) {
          // Usar jQuery si está disponible (PrimeFaces)
          if (typeof jQuery !== 'undefined' && jQuery(botonX).length > 0) {
            jQuery(botonX).trigger('click');
          } else {
            botonX.click();
          }
          return { exito: true, metodo: 'boton_x', id: botonX.id || botonX.className };
        }
      }
      
      // Estrategia 2: Botón en footer
      for (const selector of selectoresCerrar.botonFooter) {
        const botonFooter = modal.querySelector(selector);
        if (botonFooter && !botonFooter.disabled) {
          if (typeof jQuery !== 'undefined' && jQuery(botonFooter).length > 0) {
            jQuery(botonFooter).trigger('click');
          } else {
            botonFooter.click();
          }
          return { exito: true, metodo: 'boton_footer', id: botonFooter.id };
        }
      }
      
      // Estrategia 3: Por ID (contiene "Cerrar")
      for (const selector of selectoresCerrar.botonPorId) {
        const botones = modal.querySelectorAll(selector);
        for (const btn of botones) {
          if (!btn.disabled && btn.offsetParent !== null) {
            if (typeof jQuery !== 'undefined' && jQuery(btn).length > 0) {
              jQuery(btn).trigger('click');
            } else {
              btn.click();
            }
            return { exito: true, metodo: 'id_cerrar', id: btn.id };
          }
        }
      }
      
      // Estrategia 4: Buscar por texto "Cerrar"
      const todosBotones = modal.querySelectorAll('button, a');
      for (const btn of todosBotones) {
        const texto = btn.textContent.trim().toLowerCase();
        if ((texto === 'cerrar' || texto === 'close') && !btn.disabled && btn.offsetParent !== null) {
          if (typeof jQuery !== 'undefined' && jQuery(btn).length > 0) {
            jQuery(btn).trigger('click');
          } else {
            btn.click();
          }
          return { exito: true, metodo: 'texto_cerrar', id: btn.id };
        }
      }
      
      return { exito: false, error: 'Ningún botón de cierre encontrado' };
      
    }, SELECTORES_CERRAR, SELECTORES_MODAL);
    
    if (!resultadoClic || !resultadoClic.exito) {
      log('warn', ctx, `No se encontró botón de cierre estándar: ${resultadoClic?.error || 'null'}`);
      log('info', ctx, 'Intentando con tecla Escape...');
      
      // Estrategia 5: Escape key (último recurso)
      try {
        await page.keyboard.press('Escape');
        log('info', ctx, 'Escape key enviado');
      } catch (escapeError) {
        log('error', ctx, `Error enviando Escape: ${escapeError.message}`);
        return {
          cerrado: false,
          tablaRecargada: false,
          error: 'No se pudo cerrar modal (botón no encontrado y Escape falló)'
        };
      }
    } else {
      log('info', ctx, `Clic ejecutado: ${resultadoClic.metodo} (${resultadoClic.id})`);
    }
    
    // ═══════════════════════════════════════════════════════════
    // PASO 4: Esperar que modal desaparezca
    // ═══════════════════════════════════════════════════════════
    
    log('info', ctx, 'Esperando que modal se cierre...');
    
    const tiempoInicio = Date.now();
    let modalCerrado = false;
    
    while (Date.now() - tiempoInicio < CONFIG_CERRAR.timeoutCerrarModal) {
      const estadoModal = await evaluarSeguro(page, (selectores) => {
        for (const selector of selectores.contenedor) {
          const modal = document.querySelector(selector);
          if (modal) {
            const ariaHidden = modal.getAttribute('aria-hidden');
            const display = window.getComputedStyle(modal).display;
            
            if (ariaHidden === 'false' || display !== 'none') {
              return { cerrado: false };
            }
          }
        }
        return { cerrado: true };
      }, SELECTORES_MODAL);
      
      if (estadoModal === null) {
        log('warn', ctx, 'Verificación de modal retornó null, esperando...');
        await delay(CONFIG_CERRAR.intervaloVerificacion);
        continue;
      }
      
      if (estadoModal.cerrado) {
        modalCerrado = true;
        break;
      }
      
      await delay(CONFIG_CERRAR.intervaloVerificacion);
    }
    
    if (!modalCerrado) {
      log('error', ctx, `Modal no se cerró después de ${CONFIG_CERRAR.timeoutCerrarModal}ms`);
      return {
        cerrado: false,
        tablaRecargada: false,
        error: 'Modal no se cerró después del clic'
      };
    }
    
    log('success', ctx, '✓ Modal cerrado exitosamente');
    
    // ═══════════════════════════════════════════════════════════
    // PASO 5: ⭐ CRÍTICO - Esperar recarga AJAX de tabla
    // ═══════════════════════════════════════════════════════════
    
    log('info', ctx, '⭐ Esperando recarga AJAX de tabla...');
    
    // Espera inicial post-clic (SINOE necesita tiempo para iniciar AJAX)
    await delay(CONFIG_CERRAR.esperaPostClic);
    
    // Esperar que tabla esté completamente cargada
    const recarga = await esperarTablaCargada(page, requestId);
    
    if (!recarga || !recarga.cargada) {
      log('warn', ctx, 'Tabla no recargó correctamente');
      return {
        cerrado: true,
        tablaRecargada: false,
        error: 'Modal cerrado pero tabla no recargó'
      };
    }
    
    log('success', ctx, `✓ Tabla recargada (${recarga.cantidadFilas} filas detectadas)`);
    
    // ═══════════════════════════════════════════════════════════
    // PASO 6: ⭐ CRÍTICO - Esperar estabilización de data-ri
    // ═══════════════════════════════════════════════════════════
    
    log('info', ctx, '⭐ Esperando estabilización de data-ri...');
    await delay(CONFIG_CERRAR.tiempoEstabilidadDom);
    
    // ═══════════════════════════════════════════════════════════
    // PASO 7: Verificar estado final de tabla
    // ═══════════════════════════════════════════════════════════
    
    const estadoFinal = await verificarEstadoTablaActual(page, requestId);
    
    if (!estadoFinal || estadoFinal.cantidadFilas === 0) {
      log('warn', ctx, 'Tabla sin filas después de cerrar modal');
      return {
        cerrado: true,
        tablaRecargada: true,
        filasVisibles: 0,
        error: 'Tabla recargada pero sin filas visibles'
      };
    }
    
    log('success', ctx, `✓ Estabilización completa (${estadoFinal.cantidadFilas} filas)`);
    log('info', ctx, '═══════════════════════════════════════════════════════');
    
    return {
      cerrado: true,
      tablaRecargada: true,
      filasVisibles: estadoFinal.cantidadFilas,
      dataRiEstables: estadoFinal.tieneDataRi
    };
    
  } catch (error) {
    log('error', ctx, `Error inesperado cerrando modal: ${error.message}`);
    
    // Verificar si la sesión está corrupta
    try {
      if (page.isClosed()) {
        return {
          cerrado: false,
          tablaRecargada: false,
          error: 'Sesión de Puppeteer cerrada durante cierre',
          recuperable: false
        };
      }
    } catch (e) {
      // Si hasta page.isClosed() falla, la sesión está totalmente rota
      return {
        cerrado: false,
        tablaRecargada: false,
        error: 'Sesión de Puppeteer corrupta',
        recuperable: false
      };
    }
    
    return {
      cerrado: false,
      tablaRecargada: false,
      error: `Error inesperado: ${error.message}`,
      recuperable: true
    };
  }
}

// ============================================================
// FUNCIÓN AUXILIAR: Verificar si modal está cerrado
// ============================================================

/**
 * Verifica si el modal de anexos está cerrado.
 * 
 * @param {Page} page - Instancia de Puppeteer page
 * @returns {Promise<boolean>} - true si está cerrado, false si está abierto
 */
async function verificarModalCerrado(page) {
  try {
    const resultado = await evaluarSeguro(page, (selectores) => {
      for (const selector of selectores.contenedor) {
        const modal = document.querySelector(selector);
        if (modal) {
          const ariaHidden = modal.getAttribute('aria-hidden');
          const display = window.getComputedStyle(modal).display;
          
          if (ariaHidden === 'false' || display !== 'none') {
            return false; // Modal visible
          }
        }
      }
      return true; // Modal cerrado
    }, SELECTORES_MODAL);
    
    return resultado === true;
    
  } catch (error) {
    return false;
  }
}

// ============================================================
// FUNCIÓN AUXILIAR: Cerrar modal con reintentos
// ============================================================

/**
 * Cierra el modal con reintentos automáticos.
 * 
 * @param {Page}   page      - Instancia de Puppeteer page
 * @param {string} requestId - ID único para logs
 * @param {number} maxReintentos - Número máximo de reintentos
 * @returns {Promise<{cerrado: boolean, tablaRecargada: boolean, error?: string}>}
 */
async function cerrarModalConReintentos(page, requestId, maxReintentos = CONFIG_CERRAR.maxReintentos) {
  const ctx = `[CERRAR][${requestId}]`;
  
  for (let intento = 1; intento <= maxReintentos; intento++) {
    if (intento > 1) {
      log('info', ctx, `Reintento ${intento}/${maxReintentos}...`);
    }
    
    const resultado = await cerrarModal(page, requestId);
    
    if (resultado.cerrado && resultado.tablaRecargada) {
      return resultado;
    }
    
    if (!resultado.recuperable) {
      log('error', ctx, 'Error no recuperable, abortando reintentos');
      return resultado;
    }
    
    if (intento < maxReintentos) {
      log('warn', ctx, 'Esperando antes de reintentar...');
      await delay(2000);
    }
  }
  
  log('error', ctx, `Falló después de ${maxReintentos} intentos`);
  return {
    cerrado: false,
    tablaRecargada: false,
    error: `Falló después de ${maxReintentos} intentos`
  };
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  cerrarModal,
  verificarModalCerrado,
  cerrarModalConReintentos,
  SELECTORES_CERRAR,
  CONFIG_CERRAR
};
