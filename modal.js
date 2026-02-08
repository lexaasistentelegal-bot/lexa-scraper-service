/**
 * ============================================================
 * MODAL.JS - Gestión de Modal de Anexos
 * ============================================================
 * 
 * Propósito:
 * Esperar a que el modal de anexos esté completamente cargado
 * y listo para interactuar ANTES de intentar descargar el PDF.
 * 
 * Verifica:
 * 1. Modal está visible (aria-hidden="false")
 * 2. Tabla de anexos existe y tiene filas
 * 3. Botón "Consolidado" está presente y habilitado
 * 4. No hay spinners de carga activos
 * 
 * ============================================================
 */

const { delay, log, evaluarSeguro } = require('./core');

// ============================================================
// CONFIGURACIÓN
// ============================================================

const CONFIG_MODAL = {
  timeoutEsperaModal: 15000,        // 15s para que modal cargue
  intervaloVerificacion: 500,       // Verificar cada 500ms
  esperaPostCarga: 800,             // Espera adicional después de detectar cargado
  maxConsecutiveNulls: 3            // Máximo de evaluarSeguro() null consecutivos
};

// Selectores para elementos del modal
const SELECTORES_MODAL = {
  contenedor: [
    'div[id*="dlgListaAnexos"]',
    'div[id*="frmAnexos"][class*="ui-dialog"]',
    '.ui-dialog[aria-hidden="false"]'
  ],
  
  tablaAnexos: [
    '[id*="frmAnexos"] table',
    '.ui-dialog table',
    'div[id*="dlgListaAnexos"] table'
  ],
  
  filasAnexos: [
    '[id*="frmAnexos"] tbody tr',
    '.ui-dialog tbody tr'
  ],
  
  botonConsolidado: [
    'button[id*="btnDescargaTodo"]',
    'a[id*="btnDescargaTodo"]',
    'button:has-text("Consolidado")',
    'a:has-text("Consolidado")'
  ],
  
  cargando: [
    '.ui-blockui',
    '.ui-dialog .ui-datatable-loading',
    '[id*="frmAnexos"] .ui-blockui'
  ]
};

// ============================================================
// FUNCIÓN PRINCIPAL
// ============================================================

/**
 * Espera a que el modal de anexos esté completamente listo para interactuar.
 * 
 * @param {Page}   page      - Instancia de Puppeteer page
 * @param {string} requestId - ID único para logs
 * @returns {Promise<{listo: boolean, error?: string, detalles?: Object}>}
 */
async function esperarModalListo(page, requestId) {
  const ctx = `[MODAL][${requestId}]`;
  
  try {
    // Validar que page esté abierto
    if (!page || page.isClosed()) {
      log('error', ctx, 'Página cerrada');
      return {
        listo: false,
        error: 'Página cerrada'
      };
    }
    
    log('info', ctx, 'Esperando a que modal de anexos esté listo...');
    
    const tiempoInicio = Date.now();
    let consecutiveNulls = 0;
    
    // Loop de verificación con timeout
    while (Date.now() - tiempoInicio < CONFIG_MODAL.timeoutEsperaModal) {
      
      // Verificación 1: Modal está visible
      const estadoModal = await evaluarSeguro(page, (selectores) => {
        // Buscar modal visible
        let modal = null;
        
        for (const selector of selectores.contenedor) {
          const elem = document.querySelector(selector);
          if (elem && elem.getAttribute('aria-hidden') === 'false') {
            modal = elem;
            break;
          }
        }
        
        if (!modal) {
          return { modalVisible: false };
        }
        
        // Verificar que tabla de anexos exista
        let tabla = null;
        for (const selector of selectores.tablaAnexos) {
          const elem = modal.querySelector(selector);
          if (elem) {
            tabla = elem;
            break;
          }
        }
        
        if (!tabla) {
          return {
            modalVisible: true,
            tablaExiste: false
          };
        }
        
        // Contar filas de anexos
        const filas = modal.querySelectorAll(selectores.filasAnexos[0]) ||
                      modal.querySelectorAll(selectores.filasAnexos[1]);
        
        const cantidadAnexos = filas.length;
        
        if (cantidadAnexos === 0) {
          return {
            modalVisible: true,
            tablaExiste: true,
            cantidadAnexos: 0
          };
        }
        
        // Verificar spinners activos
        let spinnerActivo = false;
        for (const selector of selectores.cargando) {
          const spinner = modal.querySelector(selector);
          if (spinner && spinner.offsetParent !== null) {
            spinnerActivo = true;
            break;
          }
        }
        
        if (spinnerActivo) {
          return {
            modalVisible: true,
            tablaExiste: true,
            cantidadAnexos: cantidadAnexos,
            spinnerActivo: true
          };
        }
        
        // Buscar botón "Consolidado"
        let botonConsolidado = null;
        let botonId = null;
        
        for (const selector of selectores.botonConsolidado) {
          const btn = modal.querySelector(selector);
          if (btn) {
            botonConsolidado = btn;
            botonId = btn.id || btn.className;
            break;
          }
        }
        
        if (!botonConsolidado) {
          return {
            modalVisible: true,
            tablaExiste: true,
            cantidadAnexos: cantidadAnexos,
            spinnerActivo: false,
            botonConsolidado: false
          };
        }
        
        // Verificar que botón esté habilitado
        const botonHabilitado = !botonConsolidado.disabled &&
                                !botonConsolidado.classList.contains('ui-state-disabled');
        
        // Extraer título del modal
        const tituloElem = modal.querySelector('.ui-dialog-title');
        const titulo = tituloElem ? tituloElem.textContent.trim() : 'N/A';
        
        return {
          modalVisible: true,
          tablaExiste: true,
          cantidadAnexos: cantidadAnexos,
          spinnerActivo: false,
          botonConsolidado: true,
          botonHabilitado: botonHabilitado,
          botonId: botonId,
          titulo: titulo
        };
        
      }, SELECTORES_MODAL);
      
      // Manejar null (evaluación falló)
      if (estadoModal === null) {
        consecutiveNulls++;
        
        if (consecutiveNulls >= CONFIG_MODAL.maxConsecutiveNulls) {
          log('error', ctx, `Evaluación retornó null ${consecutiveNulls} veces consecutivas`);
          return {
            listo: false,
            error: 'Error al evaluar estado del modal (null consecutivo)'
          };
        }
        
        log('warn', ctx, `Evaluación retornó null (${consecutiveNulls}/${CONFIG_MODAL.maxConsecutiveNulls})`);
        await delay(CONFIG_MODAL.intervaloVerificacion);
        continue;
      }
      
      // Reset contador de nulls
      consecutiveNulls = 0;
      
      // Verificar resultado
      if (!estadoModal.modalVisible) {
        log('warn', ctx, 'Modal no encontrado, esperando...');
        await delay(CONFIG_MODAL.intervaloVerificacion);
        continue;
      }
      
      if (!estadoModal.tablaExiste) {
        log('warn', ctx, 'Tabla de anexos no encontrada, esperando...');
        await delay(CONFIG_MODAL.intervaloVerificacion);
        continue;
      }
      
      if (estadoModal.cantidadAnexos === 0) {
        log('error', ctx, 'Sin anexos en la notificación');
        return {
          listo: false,
          error: 'Sin anexos en la notificación',
          detalles: {
            titulo: estadoModal.titulo,
            cantidadAnexos: 0
          }
        };
      }
      
      if (estadoModal.spinnerActivo) {
        log('info', ctx, `Modal cargando (${estadoModal.cantidadAnexos} anexos detectados)...`);
        await delay(CONFIG_MODAL.intervaloVerificacion);
        continue;
      }
      
      if (!estadoModal.botonConsolidado) {
        log('error', ctx, 'Botón Consolidado no encontrado');
        return {
          listo: false,
          error: 'Botón Consolidado no encontrado',
          detalles: {
            titulo: estadoModal.titulo,
            cantidadAnexos: estadoModal.cantidadAnexos
          }
        };
      }
      
      if (!estadoModal.botonHabilitado) {
        log('error', ctx, 'Botón Consolidado deshabilitado');
        return {
          listo: false,
          error: 'Botón Consolidado deshabilitado',
          detalles: {
            titulo: estadoModal.titulo,
            cantidadAnexos: estadoModal.cantidadAnexos,
            botonId: estadoModal.botonId
          }
        };
      }
      
      // ✅ Modal está listo!
      log('success', ctx, `✓ Modal listo: ${estadoModal.cantidadAnexos} anexos, botón habilitado`);
      log('info', ctx, `Título: ${estadoModal.titulo}`);
      
      // Espera adicional post-carga para estabilización
      await delay(CONFIG_MODAL.esperaPostCarga);
      
      return {
        listo: true,
        detalles: {
          cantidadAnexos: estadoModal.cantidadAnexos,
          tituloModal: estadoModal.titulo,
          botonConsolidado: {
            existe: true,
            habilitado: true,
            id: estadoModal.botonId
          }
        }
      };
    }
    
    // Timeout alcanzado
    log('error', ctx, `Timeout esperando modal (${CONFIG_MODAL.timeoutEsperaModal}ms)`);
    return {
      listo: false,
      error: `Timeout esperando modal (${CONFIG_MODAL.timeoutEsperaModal / 1000}s)`
    };
    
  } catch (error) {
    log('error', ctx, `Error inesperado: ${error.message}`);
    return {
      listo: false,
      error: `Error inesperado: ${error.message}`
    };
  }
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  esperarModalListo,
  SELECTORES_MODAL,
  CONFIG_MODAL
};
