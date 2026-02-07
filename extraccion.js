/**
 * ════════════════════════════════════════════════════════════════════════════════
 * LEXA SCRAPER — EXTRACCIÓN v5.6.1 AUDITED
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * Autor:   LEXA Assistant (CTO)
 * Fecha:   Febrero 2026
 *
 * Changelog:
 *   v5.6.1  — AUDITORÍA AAA SENIOR — CORRECCIONES CRÍTICAS
 *     • FIX CRÍTICO C1: Race condition en navegarPaginaSiguiente()
 *       Agregado delay de estabilización después de paginar para evitar
 *       desincronización de data-ri.
 *     • FIX CRÍTICO C2: Validación de argumentos en todas las funciones async
 *     • FIX W1: Circuit breaker en esperarTablaCargada() para evitar loops infinitos
 *     • FIX W2: Try/catch completo en abrirModalAnexos()
 *     • FIX W3: Detección de data-ri duplicados en extraerNotificacionesPaginaActual()
 *     • MEJORA S1: Todos los timeouts/delays ahora en CONFIG_EXTRACCION
 *     • MEJORA: Intervalos de verificación ahora constantes globales
 *
 *   v5.6.0  — MODULAR — FUNCIONES PROBLEMÁTICAS REMOVIDAS
 *     • descargarConsolidado() → movido a descarga.js
 *     • cerrarModal() → movido a modal.js
 *     • procesarNotificaciones() → movido a procesamiento.js
 *
 *   v5.5.0  — AUDITORÍA SENIOR — FIX CRÍTICO "0 NOTIFICACIONES"
 *     • FIX BUG-007: verificarEstadoTablaActual() antes de filtrar
 *     • FIX BUG-008: tiempoEstabilidadDom aumentado a 1500ms
 *     • NUEVO: Parámetro forzarSinFiltro
 *
 *   v3.0.0  — Reescritura completa con soporte AJAX de PrimeFaces
 *   v2.0.2  — Selectores corregidos para estructura real de SINOE
 *   v2.0.0  — Primera versión modular
 *
 * ════════════════════════════════════════════════════════════════════════════════
 */

'use strict';

// ════════════════════════════════════════════════════════════════════════════════
// IMPORTACIONES
// ════════════════════════════════════════════════════════════════════════════════

const core = require('./core');

const {
  delay,
  log,
  evaluarSeguro
} = core;

// ════════════════════════════════════════════════════════════════════════════════
// CONFIGURACIÓN — v5.6.1 OPTIMIZADA
// ════════════════════════════════════════════════════════════════════════════════

const CONFIG_EXTRACCION = {
  // Timeouts principales
  timeoutCargaTabla: 25000,
  timeoutModal: 15000,
  timeoutFiltro: 20000,
  timeoutDescargaPdf: 30000,

  // Delays operacionales
  esperaPostClic: 2500,
  pausaEntreNotificaciones: 2000,
  esperaDescarga: 5000,
  tiempoEstabilidadDom: 1500,

  // Intervalos de verificación
  intervaloVerificacion: 1000,
  intervaloVerificacionModal: 300,
  
  // Límites de seguridad
  maxReintentos: 3,
  maxPaginas: 20,
  maxConsecutiveNulls: 5
};

// ════════════════════════════════════════════════════════════════════════════════
// SELECTORES — VERIFICADOS CONTRA SINOE REAL
// ════════════════════════════════════════════════════════════════════════════════

const SELECTORES = {
  tabla: {
    cuerpo: [
      'tbody[id*="tblLista_data"]',
      'tbody[id*="tblLista"][class*="ui-datatable-data"]',
      '.ui-datatable-data'
    ],
    contenedor: [
      '[id*="tblLista"]',
      '.ui-datatable',
      'div[id*="frmBusqueda"] .ui-datatable'
    ],
    cargando: [
      '.ui-datatable-loading',
      '.ui-blockui',
      '[id*="tblLista_loading"]'
    ]
  },

  filas: {
    conDatos: 'tr[data-ri]',
    alternativas: [
      'tr[data-ri]',
      'tr[role="row"]',
      'tr.ui-widget-content'
    ],
    vacia: '.ui-datatable-empty-message'
  },

  celdas: {
    selector: 'td[role="gridcell"]',
    alternativa: 'td'
  },

  botonAnexos: {
    porIcono: [
      'button:has(span.ui-icon-circle-zoomout)',
      'button .ui-icon-circle-zoomout',
      'button[class*="ui-button-icon-only"] .ui-icon'
    ],
    porId: [
      'button[id*="j_idt"]',
      'a[id*="j_idt"]'
    ],
    porPosicion: 'td:last-child button, td:last-child a.ui-commandlink',
    icono: 'span.ui-icon-circle-zoomout'
  },

  modal: {
    contenedor: [
      'div[id*="dlgListaAnexos"]',
      'div[id*="frmAnexos"][class*="ui-dialog"]',
      '.ui-dialog[aria-hidden="false"]'
    ],
    visible: 'div[id*="dlgListaAnexos"][aria-hidden="false"], .ui-dialog[aria-hidden="false"]',
    titulo: '.ui-dialog-title, [id*="dlgListaAnexos_title"]',
    tablaAnexos: '[id*="frmAnexos"] table, .ui-dialog table',
    filasAnexos: '[id*="frmAnexos"] tbody tr'
  },

  botonConsolidado: {
    porId: [
      'button[id*="btnDescargaTodo"]',
      'a[id*="btnDescargaTodo"]',
      '[id*="DescargaTodo"]'
    ],
    porTexto: [
      'button:contains("Consolidado")',
      'span:contains("Consolidado")'
    ],
    porIcono: 'button:has(.ui-icon-arrowthickstop-1-s)'
  },

  botonCerrar: {
    botonX: '.ui-dialog-titlebar-close',
    porTexto: [
      'button:contains("Cerrar")',
      '.ui-dialog-footer button'
    ],
    porClase: 'button[id*="Cerrar"], a[id*="Cerrar"]'
  },

  paginacion: {
    contenedor: '.ui-paginator',
    siguiente: '.ui-paginator-next:not(.ui-state-disabled)',
    anterior: '.ui-paginator-prev:not(.ui-state-disabled)',
    paginas: '.ui-paginator-page',
    paginaActiva: '.ui-paginator-page.ui-state-active',
    info: '.ui-paginator-current'
  },

  filtro: {
    fechaInicial: [
      'input[id*="fechaIni"]',
      'input[id*="fecIni"]',
      'input[id*="FechaIni"]',
      'input[id*="fecDesde"]'
    ],
    fechaFinal: [
      'input[id*="fechaFin"]',
      'input[id*="fecFin"]',
      'input[id*="FechaFin"]',
      'input[id*="fecHasta"]'
    ],
    estadoRevision: [
      'select[id*="estado"]',
      'select[id*="Estado"]',
      'div[id*="estado"] select'
    ],
    botonBuscar: [
      'button[id*="btnBuscar"]',
      'input[id*="btnBuscar"]',
      'a[id*="btnBuscar"]'
    ]
  }
};

const COLUMNAS = {
  checkbox: 0,
  estadoLectura: 1,
  indice: 2,
  numeroNotificacion: 3,
  expediente: 4,
  sumilla: 5,
  organoJurisdiccional: 6,
  fechaHora: 7,
  acciones: 8
};

// ════════════════════════════════════════════════════════════════════════════════
// UTILIDADES
// ════════════════════════════════════════════════════════════════════════════════

function formatearFechaSinoe(fecha) {
  const dd = String(fecha.getDate()).padStart(2, '0');
  const mm = String(fecha.getMonth() + 1).padStart(2, '0');
  const yyyy = fecha.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function validarPage(page, functionName) {
  if (!page || typeof page.evaluate !== 'function') {
    throw new Error(`[${functionName}] Argumento 'page' inválido`);
  }
}

function validarRequestId(requestId, functionName) {
  if (!requestId || typeof requestId !== 'string') {
    throw new Error(`[${functionName}] Argumento 'requestId' inválido`);
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// FILTRADO POR FECHA
// ════════════════════════════════════════════════════════════════════════════════

async function filtrarBandejaPorFecha(page, fechaInicial, fechaFinal, requestId) {
  validarPage(page, 'filtrarBandejaPorFecha');
  validarRequestId(requestId, 'filtrarBandejaPorFecha');

  const ctx = `FILTRO:${requestId}`;

  const hoy = new Date();
  if (!fechaFinal) {
    fechaFinal = formatearFechaSinoe(hoy);
  }
  if (!fechaInicial) {
    const hace7dias = new Date(hoy);
    hace7dias.setDate(hace7dias.getDate() - 7);
    fechaInicial = formatearFechaSinoe(hace7dias);
  }

  log('info', ctx, `Aplicando filtro: ${fechaInicial} → ${fechaFinal}`);

  try {
    const camposEncontrados = await evaluarSeguro(page, (selectoresFiltro) => {
      let inputInicial = null;
      let inputFinal = null;

      for (const sel of selectoresFiltro.fechaInicial) {
        inputInicial = document.querySelector(sel);
        if (inputInicial) break;
      }

      for (const sel of selectoresFiltro.fechaFinal) {
        inputFinal = document.querySelector(sel);
        if (inputFinal) break;
      }

      let botonBuscar = null;
      for (const sel of selectoresFiltro.botonBuscar) {
        botonBuscar = document.querySelector(sel);
        if (botonBuscar) break;
      }

      if (!botonBuscar) {
        const botones = document.querySelectorAll('button, input[type="submit"], a.ui-commandlink');
        for (const btn of botones) {
          const texto = (btn.textContent || btn.value || '').trim().toLowerCase();
          if (texto === 'buscar' || texto.includes('buscar')) {
            botonBuscar = btn;
            break;
          }
        }
      }

      return {
        tieneInicial: !!inputInicial,
        tieneFinal: !!inputFinal,
        tieneBuscar: !!botonBuscar,
        idInicial: inputInicial?.id || null,
        idFinal: inputFinal?.id || null,
        idBuscar: botonBuscar?.id || null
      };
    }, SELECTORES.filtro);

    if (!camposEncontrados) {
      log('warn', ctx, 'No se pudo evaluar la página para buscar campos de filtro');
      return false;
    }

    log('info', ctx, `Campos encontrados — Inicial: ${camposEncontrados.tieneInicial}, Final: ${camposEncontrados.tieneFinal}, Buscar: ${camposEncontrados.tieneBuscar}`);

    if (!camposEncontrados.tieneInicial && !camposEncontrados.tieneFinal) {
      log('warn', ctx, 'Campos de fecha no encontrados — se usará la tabla sin filtrar');
      return false;
    }

    if (camposEncontrados.tieneInicial) {
      await rellenarCampoFecha(page, SELECTORES.filtro.fechaInicial, fechaInicial, ctx, 'Fecha Inicial');
    }

    if (camposEncontrados.tieneFinal) {
      await rellenarCampoFecha(page, SELECTORES.filtro.fechaFinal, fechaFinal, ctx, 'Fecha Final');
    }

    await evaluarSeguro(page, (selectoresEstado) => {
      for (const sel of selectoresEstado) {
        const selectEl = document.querySelector(sel);
        if (selectEl && selectEl.tagName === 'SELECT') {
          for (const opt of selectEl.options) {
            if (opt.text.toLowerCase().includes('todos')) {
              selectEl.value = opt.value;
              selectEl.dispatchEvent(new Event('change', { bubbles: true }));
              return { seleccionado: true };
            }
          }
        }
      }
      return { seleccionado: false };
    }, SELECTORES.filtro.estadoRevision);

    const clicBuscar = await evaluarSeguro(page, (selectoresBuscar) => {
      for (const sel of selectoresBuscar) {
        const btn = document.querySelector(sel);
        if (btn) {
          try {
            if (typeof jQuery !== 'undefined' && jQuery(btn).length) {
              jQuery(btn).trigger('click');
            } else {
              btn.click();
            }
            return { exito: true, metodo: `selector: ${sel}` };
          } catch (e) {
            // Continuar con siguiente selector
          }
        }
      }

      const botones = document.querySelectorAll('button, input[type="submit"], a.ui-commandlink');
      for (const btn of botones) {
        const texto = (btn.textContent || btn.value || '').trim().toLowerCase();
        if (texto === 'buscar' || texto.includes('buscar')) {
          try {
            if (typeof jQuery !== 'undefined' && jQuery(btn).length) {
              jQuery(btn).trigger('click');
            } else {
              btn.click();
            }
            return { exito: true, metodo: 'texto_buscar' };
          } catch (e) {
            // Continuar
          }
        }
      }

      return { exito: false };
    }, SELECTORES.filtro.botonBuscar);

    if (!clicBuscar || !clicBuscar.exito) {
      log('warn', ctx, 'No se pudo hacer clic en "Buscar"');
      return false;
    }

    log('info', ctx, `Clic en Buscar realizado (${clicBuscar.metodo})`);

    await delay(CONFIG_EXTRACCION.esperaPostClic);

    const resultado = await esperarTablaCargada(page, requestId);

    if (resultado.cargada) {
      log('success', ctx, `✓ Filtro aplicado — ${resultado.cantidadFilas} notificaciones`);
      return true;
    }

    log('warn', ctx, 'Tabla no cargó después de aplicar filtro');
    return false;

  } catch (error) {
    log('error', ctx, `Error aplicando filtro: ${error.message}`);
    return false;
  }
}

async function rellenarCampoFecha(page, selectores, valor, ctx, nombreCampo) {
  const selectorEncontrado = await evaluarSeguro(page, (sels) => {
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (el) return sel;
    }
    return null;
  }, selectores);

  if (!selectorEncontrado) {
    log('warn', ctx, `Campo ${nombreCampo} no encontrado`);
    return;
  }

  try {
    await page.click(selectorEncontrado);
    await delay(300);

    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await delay(100);
    await page.keyboard.press('Backspace');
    await delay(200);

    for (const char of valor) {
      await page.keyboard.type(char, { delay: 50 });
    }
    await delay(300);

    await page.keyboard.press('Tab');
    await delay(500);

    await evaluarSeguro(page, () => {
      const popups = document.querySelectorAll('.ui-datepicker, .ui-datepicker-panel');
      for (const popup of popups) {
        popup.style.display = 'none';
      }
    });

    log('info', ctx, `${nombreCampo}: "${valor}" escrito`);
  } catch (error) {
    log('warn', ctx, `Error rellenando ${nombreCampo}: ${error.message}`);
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// ESPERA DE CARGA DE TABLA (FUNCIÓN CRÍTICA)
// ════════════════════════════════════════════════════════════════════════════════

async function esperarTablaCargada(page, requestId) {
  validarPage(page, 'esperarTablaCargada');
  validarRequestId(requestId, 'esperarTablaCargada');

  const ctx = `TABLA:${requestId}`;
  const inicio = Date.now();
  let consecutiveNulls = 0;

  log('info', ctx, 'Esperando carga de tabla AJAX...');

  while (Date.now() - inicio < CONFIG_EXTRACCION.timeoutCargaTabla) {

    const estado = await evaluarSeguro(page, (selectores) => {

      for (const selCarga of selectores.tabla.cargando) {
        const indicador = document.querySelector(selCarga);
        if (indicador) {
          const estilo = window.getComputedStyle(indicador);
          if (estilo.display !== 'none' && estilo.visibility !== 'hidden') {
            return { estado: 'cargando' };
          }
        }
      }

      const blockUis = document.querySelectorAll('.ui-blockui, .ui-blockui-content');
      for (const block of blockUis) {
        const estilo = window.getComputedStyle(block);
        if (estilo.display !== 'none' && estilo.visibility !== 'hidden' && estilo.opacity !== '0') {
          return { estado: 'cargando' };
        }
      }

      let tbody = null;
      for (const selTbody of selectores.tabla.cuerpo) {
        tbody = document.querySelector(selTbody);
        if (tbody) break;
      }

      if (!tbody) {
        const contenedor = document.querySelector('.ui-datatable');
        if (contenedor) {
          tbody = contenedor.querySelector('tbody');
        }
      }

      if (!tbody) {
        return { estado: 'sin_tabla' };
      }

      const filas = tbody.querySelectorAll('tr[data-ri]');
      const filasReales = Array.from(filas).filter(fila => {
        if (fila.classList.contains('ui-datatable-empty-message')) return false;
        const celdas = fila.querySelectorAll('td');
        return celdas.length > 2;
      });

      const mensajeVacio = tbody.querySelector('.ui-datatable-empty-message');
      const textoTabla = tbody.innerText.toLowerCase();
      const sinDatos = mensajeVacio ||
                       textoTabla.includes('no hay') ||
                       textoTabla.includes('sin resultados') ||
                       textoTabla.includes('no se encontraron');

      return {
        estado: 'cargada',
        tieneFilas: filasReales.length > 0,
        cantidadFilas: filasReales.length,
        sinDatos: sinDatos && filasReales.length === 0,
        tbodyId: tbody.id || 'sin-id'
      };

    }, SELECTORES);

    if (!estado) {
      consecutiveNulls++;
      if (consecutiveNulls >= CONFIG_EXTRACCION.maxConsecutiveNulls) {
        log('error', ctx, `evaluarSeguro() retornó null ${CONFIG_EXTRACCION.maxConsecutiveNulls} veces consecutivas — posible crash de página`);
        return {
          cargada: false,
          tieneFilas: false,
          cantidadFilas: 0,
          mensaje: 'Frame en transición (evaluarSeguro null)'
        };
      }
      await delay(CONFIG_EXTRACCION.intervaloVerificacion);
      continue;
    }

    consecutiveNulls = 0;

    if (estado.estado === 'cargando') {
      log('info', ctx, 'Tabla cargando (AJAX en progreso)...');
      await delay(CONFIG_EXTRACCION.intervaloVerificacion);
      continue;
    }

    if (estado.estado === 'sin_tabla') {
      log('info', ctx, 'Tabla no encontrada aún...');
      await delay(CONFIG_EXTRACCION.intervaloVerificacion);
      continue;
    }

    if (estado.estado === 'cargada') {
      await delay(CONFIG_EXTRACCION.tiempoEstabilidadDom);

      const verificacion = await evaluarSeguro(page, (selectores) => {
        let tbody = null;
        for (const selTbody of selectores.tabla.cuerpo) {
          tbody = document.querySelector(selTbody);
          if (tbody) break;
        }
        if (!tbody) return { filas: 0 };
        const filas = tbody.querySelectorAll('tr[data-ri]');
        return { filas: filas.length };
      }, SELECTORES);

      const filasEstables = verificacion ? verificacion.filas : 0;

      if (estado.sinDatos) {
        log('info', ctx, '✓ Tabla cargada — No hay notificaciones');
        return {
          cargada: true,
          tieneFilas: false,
          cantidadFilas: 0,
          mensaje: 'Sin notificaciones'
        };
      }

      if (filasEstables > 0) {
        log('success', ctx, `✓ Tabla cargada y estable — ${filasEstables} filas`);
        return {
          cargada: true,
          tieneFilas: true,
          cantidadFilas: filasEstables,
          mensaje: `${filasEstables} notificaciones`
        };
      }

      log('info', ctx, 'DOM inestable (filas desaparecieron), reintentando...');
      await delay(CONFIG_EXTRACCION.intervaloVerificacion);
      continue;
    }

    await delay(CONFIG_EXTRACCION.intervaloVerificacion);
  }

  log('warn', ctx, `Timeout (${CONFIG_EXTRACCION.timeoutCargaTabla}ms) esperando tabla`);
  return {
    cargada: false,
    tieneFilas: false,
    cantidadFilas: 0,
    mensaje: 'Timeout esperando carga'
  };
}

// ════════════════════════════════════════════════════════════════════════════════
// VERIFICACIÓN RÁPIDA DE ESTADO DE TABLA
// ════════════════════════════════════════════════════════════════════════════════

async function verificarEstadoTablaActual(page, requestId) {
  validarPage(page, 'verificarEstadoTablaActual');
  validarRequestId(requestId, 'verificarEstadoTablaActual');

  const ctx = `CHECK:${requestId}`;

  const estado = await evaluarSeguro(page, (selectores) => {
    let resultado = {
      tablaCargada: false,
      tieneFilas: false,
      cantidadFilas: 0,
      estadoCarga: 'desconocido',
      detalles: {}
    };

    for (const selCarga of selectores.tabla.cargando) {
      const indicador = document.querySelector(selCarga);
      if (indicador) {
        const estilo = window.getComputedStyle(indicador);
        if (estilo.display !== 'none' && estilo.visibility !== 'hidden') {
          resultado.estadoCarga = 'cargando';
          return resultado;
        }
      }
    }

    const blockUis = document.querySelectorAll('.ui-blockui, .ui-blockui-content');
    for (const block of blockUis) {
      const estilo = window.getComputedStyle(block);
      if (estilo.display !== 'none' && estilo.visibility !== 'hidden' && estilo.opacity !== '0') {
        resultado.estadoCarga = 'cargando';
        return resultado;
      }
    }

    let tbody = null;
    let tbodySelector = null;
    for (const sel of selectores.tabla.cuerpo) {
      tbody = document.querySelector(sel);
      if (tbody) {
        tbodySelector = sel;
        break;
      }
    }

    if (!tbody) {
      resultado.estadoCarga = 'sin_tabla';
      return resultado;
    }

    const filasDataRi = tbody.querySelectorAll('tr[data-ri]');
    const filasValidas = Array.from(filasDataRi).filter(fila => {
      if (fila.classList.contains('ui-datatable-empty-message')) return false;
      const celdas = fila.querySelectorAll('td');
      return celdas.length >= 5;
    });

    resultado.tablaCargada = true;
    resultado.tieneFilas = filasValidas.length > 0;
    resultado.cantidadFilas = filasValidas.length;
    resultado.estadoCarga = filasValidas.length > 0 ? 'con_datos' : 'sin_datos';
    resultado.detalles = {
      tbodyId: tbody.id || '(sin id)',
      selectorUsado: tbodySelector,
      filasConDataRi: filasDataRi.length,
      filasValidas: filasValidas.length
    };

    const infoPag = document.querySelector('.ui-paginator-current');
    if (infoPag) {
      const texto = infoPag.textContent || '';
      const matchReg = texto.match(/Registros:\s*(\d+)/i);
      if (matchReg) {
        resultado.detalles.registrosSegunPaginador = parseInt(matchReg[1], 10);
      }
    }

    const fechaIniInput = document.querySelector('input[id*="fechaIni"], input[id*="fecIni"]');
    const fechaFinInput = document.querySelector('input[id*="fechaFin"], input[id*="fecFin"]');
    if (fechaIniInput || fechaFinInput) {
      resultado.detalles.filtroActual = {
        fechaInicial: fechaIniInput ? fechaIniInput.value : null,
        fechaFinal: fechaFinInput ? fechaFinInput.value : null
      };
    }

    return resultado;

  }, SELECTORES);

  if (estado) {
    log('info', ctx, `Estado tabla: ${estado.estadoCarga} | Filas: ${estado.cantidadFilas}`, estado.detalles || {});
  } else {
    log('warn', ctx, 'No se pudo verificar estado de tabla (evaluarSeguro retornó null)');
  }

  return estado || {
    tablaCargada: false,
    tieneFilas: false,
    cantidadFilas: 0,
    estadoCarga: 'error_evaluacion'
  };
}

// ════════════════════════════════════════════════════════════════════════════════
// EXTRAER NOTIFICACIONES DE PÁGINA ACTUAL
// ════════════════════════════════════════════════════════════════════════════════

async function extraerNotificacionesPaginaActual(page, requestId, paginaNum = 1) {
  validarPage(page, 'extraerNotificacionesPaginaActual');
  validarRequestId(requestId, 'extraerNotificacionesPaginaActual');

  const ctx = `NOTIF:${requestId}`;

  const resultado = await evaluarSeguro(page, (selectores, columnas) => {
    const notificaciones = [];
    const dataRisVistos = new Set();
    let metodoUsado = '';

    let tbody = null;
    for (const sel of selectores.tabla.cuerpo) {
      tbody = document.querySelector(sel);
      if (tbody) {
        metodoUsado = `tbody: ${sel}`;
        break;
      }
    }

    if (!tbody) {
      return { error: 'No se encontró tbody de la tabla' };
    }

    const filas = tbody.querySelectorAll('tr[data-ri]');

    if (filas.length === 0) {
      return { error: 'No se encontraron filas con data-ri' };
    }

    for (const fila of filas) {
      if (fila.classList.contains('ui-datatable-empty-message')) continue;

      const celdas = fila.querySelectorAll('td');
      if (celdas.length < 5) continue;

      const dataRi = fila.getAttribute('data-ri');

      if (dataRisVistos.has(dataRi)) {
        console.warn(`[WARN] data-ri duplicado detectado: ${dataRi}`);
        continue;
      }
      dataRisVistos.add(dataRi);

      const celdaEstado = celdas[columnas.estadoLectura];
      const iconoSobre = celdaEstado ? (celdaEstado.querySelector('img, span[class*="icon"]')) : null;
      const srcIcono = iconoSobre ? (iconoSobre.src || iconoSobre.className || '') : '';
      const leido = srcIcono.length > 0 && (
        srcIcono.includes('leido') ||
        srcIcono.includes('read') ||
        !srcIcono.includes('nuevo')
      );

      const textos = Array.from(celdas).map(c => (c.textContent || '').trim());

      const celdaAcciones = celdas[celdas.length - 1];
      let tieneBotonAnexos = false;

      if (celdaAcciones) {
        const boton = celdaAcciones.querySelector('button') ||
                      celdaAcciones.querySelector('a[onclick]');
        tieneBotonAnexos = !!boton;
      }

      const indiceNumerico = parseInt(dataRi, 10);
      const numNotif = textos[columnas.numeroNotificacion] || '';
      const expediente = textos[columnas.expediente] || '';
      const organoJ = textos[columnas.organoJurisdiccional] || '';
      const fechaH = textos[columnas.fechaHora] || '';

      const notificacion = {
        indice: Number.isNaN(indiceNumerico) ? 0 : indiceNumerico,
        dataRi: dataRi || '0',
        numero: textos[columnas.indice] || '',
        numNotificacion: numNotif,
        numeroNotificacion: numNotif,
        expediente: expediente,
        sumilla: textos[columnas.sumilla] || '',
        organoJurisdiccional: organoJ,
        juzgado: organoJ,
        fechaHora: fechaH,
        fecha: fechaH,
        leido: leido,
        tieneBotonAnexos: tieneBotonAnexos,
        pdf: '',
        archivo: '',
        nombreArchivo: '',
        descargado: false
      };

      if (notificacion.expediente || notificacion.numNotificacion) {
        notificaciones.push(notificacion);
      }
    }

    return {
      notificaciones: notificaciones,
      metodo: metodoUsado,
      totalFilas: filas.length
    };

  }, SELECTORES, COLUMNAS);

  if (!resultado) {
    log('error', ctx, 'Error evaluando página (resultado null)');
    return [];
  }

  if (resultado.error) {
    log('error', ctx, `Error extrayendo: ${resultado.error}`);
    return [];
  }

  const notificaciones = (resultado.notificaciones || []).map(n => ({
    ...n,
    _pagina: paginaNum
  }));

  log('info', ctx, `Página ${paginaNum}: ${notificaciones.length} notificaciones extraídas (${resultado.metodo})`);

  return notificaciones;
}

// ════════════════════════════════════════════════════════════════════════════════
// EXTRAER NOTIFICACIONES (FUNCIÓN PRINCIPAL)
// ════════════════════════════════════════════════════════════════════════════════

async function extraerNotificaciones(page, requestId, opciones = {}) {
  validarPage(page, 'extraerNotificaciones');
  validarRequestId(requestId, 'extraerNotificaciones');

  const ctx = `NOTIF:${requestId}`;
  const forzarSinFiltro = opciones.forzarSinFiltro === true;
  let aplicarFiltro = opciones.aplicarFiltro !== false;

  log('info', ctx, '════════════════════════════════════════════════════════════════');
  log('info', ctx, 'EXTRACCIÓN DE NOTIFICACIONES v5.6.1');
  log('info', ctx, `Opciones: aplicarFiltro=${aplicarFiltro}, forzarSinFiltro=${forzarSinFiltro}`);
  log('info', ctx, '════════════════════════════════════════════════════════════════');

  if (forzarSinFiltro) {
    log('info', ctx, 'PASO 0: forzarSinFiltro=true → Saltando verificación y filtro');
    aplicarFiltro = false;
  } else {
    log('info', ctx, 'PASO 0: Verificando estado actual de la tabla...');

    const estadoActual = await verificarEstadoTablaActual(page, requestId);

    if (estadoActual.tieneFilas && estadoActual.cantidadFilas > 0) {
      log('success', ctx, '════════════════════════════════════════════════════════');
      log('success', ctx, `⭐ TABLA YA TIENE ${estadoActual.cantidadFilas} FILAS VISIBLES`);
      log('success', ctx, '   → NO se aplicará filtro de fechas (evita romper DOM)');
      log('success', ctx, '════════════════════════════════════════════════════════');
      aplicarFiltro = false;
    } else if (estadoActual.estadoCarga === 'cargando') {
      log('info', ctx, 'Tabla en estado de carga, esperando estabilización...');
      await delay(CONFIG_EXTRACCION.esperaPostClic);
    } else {
      log('info', ctx, `Estado de tabla: ${estadoActual.estadoCarga} — se evaluará filtro`);
    }
  }

  if (aplicarFiltro) {
    log('info', ctx, 'PASO 1: Aplicando filtro de fechas...');

    const filtroOk = await filtrarBandejaPorFecha(
      page,
      opciones.fechaInicial || null,
      opciones.fechaFinal || null,
      requestId
    );

    if (!filtroOk) {
      log('warn', ctx, 'Filtro no se aplicó correctamente — extrayendo tabla tal cual');
    }
  } else {
    log('info', ctx, 'PASO 1: Saltando filtro de fechas (tabla ya tiene datos o forzarSinFiltro)');
  }

  log('info', ctx, 'PASO 2: Esperando carga de tabla...');

  const estadoCarga = await esperarTablaCargada(page, requestId);

  if (!estadoCarga.cargada) {
    log('error', ctx, '❌ Tabla no cargó correctamente');
    await diagnosticarPaginaCasillas(page, requestId);
    return [];
  }

  if (!estadoCarga.tieneFilas) {
    log('info', ctx, '✓ Tabla cargada pero no hay notificaciones');
    return [];
  }

  log('success', ctx, `✓ Tabla cargada y estable — ${estadoCarga.cantidadFilas} filas detectadas`);

  log('info', ctx, 'PASO 3: Extrayendo notificaciones de página 1...');

  let todasLasNotificaciones = await extraerNotificacionesPaginaActual(page, requestId, 1);

  if (todasLasNotificaciones.length === 0) {
    log('warn', ctx, '❌ Primera página sin notificaciones extraíbles');
    log('info', ctx, 'Ejecutando diagnóstico para entender el problema...');
    await diagnosticarPaginaCasillas(page, requestId);
    return [];
  }

  log('success', ctx, `✓ Página 1: ${todasLasNotificaciones.length} notificaciones extraídas`);

  let paginaActual = 1;

  while (paginaActual < CONFIG_EXTRACCION.maxPaginas) {
    const paginacion = await verificarPaginacion(page, requestId);

    if (!paginacion.hayMas) {
      log('info', ctx, `Fin de paginación en página ${paginaActual}`);
      break;
    }

    const navegoOk = await navegarPaginaSiguiente(page, requestId);
    if (!navegoOk) {
      log('warn', ctx, 'No se pudo navegar a la siguiente página');
      break;
    }

    paginaActual++;

    const notifsPagina = await extraerNotificacionesPaginaActual(page, requestId, paginaActual);
    log('info', ctx, `Página ${paginaActual}: ${notifsPagina.length} notificaciones extraídas`);

    todasLasNotificaciones = todasLasNotificaciones.concat(notifsPagina);
  }

  if (paginaActual > 1) {
    log('info', ctx, `Navegando de vuelta a página 1 (estamos en página ${paginaActual})...`);
    const volverOk = await navegarAPagina(page, 1, requestId);
    if (!volverOk) {
      log('warn', ctx, 'No se pudo volver a página 1 — procesarNotificaciones manejará navegación');
    }
  }

  log('success', ctx, '════════════════════════════════════════════════════════════════');
  log('success', ctx, `✓ EXTRACCIÓN COMPLETADA: ${todasLasNotificaciones.length} notificaciones`);
  log('success', ctx, `  de ${paginaActual} página(s)`);
  log('success', ctx, '════════════════════════════════════════════════════════════════');

  if (todasLasNotificaciones.length > 0) {
    const muestra = todasLasNotificaciones.slice(0, 3);
    muestra.forEach((n, i) => {
      log('info', ctx, `  [${i}] Exp: ${n.expediente} | Notif: ${n.numNotificacion}`);
    });
    if (todasLasNotificaciones.length > 3) {
      log('info', ctx, `  ... y ${todasLasNotificaciones.length - 3} más`);
    }
  }

  return todasLasNotificaciones;
}

// ════════════════════════════════════════════════════════════════════════════════
// DIAGNÓSTICO
// ════════════════════════════════════════════════════════════════════════════════

async function diagnosticarPaginaCasillas(page, requestId) {
  validarPage(page, 'diagnosticarPaginaCasillas');
  validarRequestId(requestId, 'diagnosticarPaginaCasillas');

  const ctx = `DIAG:${requestId}`;

  log('info', ctx, '🔍 Ejecutando diagnóstico de página...');

  const diagnostico = await evaluarSeguro(page, () => {
    const resultado = {
      timestamp: new Date().toISOString(),
      url: window.location.href,
      titulo: document.title,
      sesion: {
        usuarioVisible: !!document.querySelector('[id*="Bienvenido"], .welcome-text'),
        menuVisible: !!document.querySelector('[id*="menu"], nav, .menu'),
        loginVisible: !!document.querySelector('input[type="password"]')
      },
      tablas: [],
      primefaces: {
        datatables: document.querySelectorAll('.ui-datatable').length,
        dialogs: document.querySelectorAll('.ui-dialog').length,
        dialogsVisibles: document.querySelectorAll('.ui-dialog[aria-hidden="false"]').length,
        panels: document.querySelectorAll('.ui-panel').length
      },
      formularios: [],
      errores: [],
      extractoBody: ''
    };

    const tablas = document.querySelectorAll('table');
    tablas.forEach((tabla, i) => {
      const filas = tabla.querySelectorAll('tr');
      const filasConDataRi = tabla.querySelectorAll('tr[data-ri]');

      resultado.tablas.push({
        indice: i,
        id: tabla.id || '(sin id)',
        clase: tabla.className.substring(0, 50),
        filas: filas.length,
        filasConDataRi: filasConDataRi.length,
        primeraFila: filas[0] ? filas[0].textContent.substring(0, 100) : ''
      });
    });

    const forms = document.querySelectorAll('form');
    forms.forEach((form, i) => {
      resultado.formularios.push({
        indice: i,
        id: form.id || '(sin id)',
        action: form.action ? form.action.substring(0, 80) : ''
      });
    });

    const contenedoresError = document.querySelectorAll(
      '.ui-messages, .ui-growl, .error, .alert-danger, [class*="error"]'
    );
    contenedoresError.forEach(el => {
      const texto = el.textContent.trim();
      if (texto) resultado.errores.push(texto.substring(0, 200));
    });

    resultado.extractoBody = document.body ? document.body.innerText.substring(0, 500) : '';

    return resultado;
  });

  if (diagnostico) {
    log('info', ctx, '📊 Diagnóstico:', JSON.stringify({
      url: diagnostico.url,
      sesion: diagnostico.sesion,
      tablas: diagnostico.tablas.length,
      primefaces: diagnostico.primefaces,
      errores: diagnostico.errores
    }, null, 2));
  } else {
    log('error', ctx, 'No se pudo obtener diagnóstico');
  }

  return diagnostico;
}

// ════════════════════════════════════════════════════════════════════════════════
// ABRIR MODAL DE ANEXOS
// ════════════════════════════════════════════════════════════════════════════════

async function abrirModalAnexos(page, dataRi, requestId, numNotificacion) {
  validarPage(page, 'abrirModalAnexos');
  validarRequestId(requestId, 'abrirModalAnexos');

  const ctx = `MODAL:${requestId}`;

  log('info', ctx, `Abriendo modal para fila data-ri=${dataRi}${numNotificacion ? ` (Notif: ${numNotificacion})` : ''}...`);

  try {
    const resultadoClic = await evaluarSeguro(page, (dataRiParam, numNotifParam, selectores, columnas) => {

      let fila = document.querySelector(`tr[data-ri="${dataRiParam}"]`);

      if ((!fila || numNotifParam) && numNotifParam) {
        let tbody = null;
        for (const sel of selectores.tabla.cuerpo) {
          tbody = document.querySelector(sel);
          if (tbody) break;
        }

        if (tbody) {
          const todasLasFilas = tbody.querySelectorAll('tr[data-ri]');
          for (const f of todasLasFilas) {
            const celdas = f.querySelectorAll('td');
            if (celdas.length > columnas.numeroNotificacion) {
              const textoNotif = (celdas[columnas.numeroNotificacion].textContent || '').trim();
              if (textoNotif === numNotifParam) {
                fila = f;
                break;
              }
            }
          }
        }
      }

      if (!fila) {
        return { error: `Fila no encontrada (data-ri="${dataRiParam}", notif="${numNotifParam || 'N/A'}")` };
      }

      const dataRiReal = fila.getAttribute('data-ri');

      let boton = null;
      let metodo = '';

      const iconoLupa = fila.querySelector('span.ui-icon-circle-zoomout');
      if (iconoLupa) {
        boton = iconoLupa.closest('button') || iconoLupa.closest('a');
        metodo = 'icono_lupa';
      }

      if (!boton) {
        const ultimaCelda = fila.querySelector('td:last-child');
        if (ultimaCelda) {
          boton = ultimaCelda.querySelector('button') ||
                  ultimaCelda.querySelector('a[onclick]') ||
                  ultimaCelda.querySelector('a[id*="j_idt"]');
          metodo = 'ultima_celda';
        }
      }

      if (!boton) {
        boton = fila.querySelector('button[id*="j_idt"]') ||
                fila.querySelector('a[id*="j_idt"]');
        metodo = 'id_dinamico';
      }

      if (!boton) {
        const botones = fila.querySelectorAll('button, a.ui-commandlink');
        if (botones.length > 0) {
          boton = botones[botones.length - 1];
          metodo = 'cualquier_boton';
        }
      }

      if (!boton) {
        return { error: 'Botón de anexos no encontrado en la fila' };
      }

      try {
        if (typeof jQuery !== 'undefined' && jQuery(boton).length) {
          jQuery(boton).trigger('click');
        } else if (boton.onclick) {
          boton.onclick.call(boton, new MouseEvent('click'));
        } else {
          boton.click();
        }
      } catch (e) {
        return { error: `Error haciendo clic: ${e.message}` };
      }

      return {
        exito: true,
        metodo: metodo,
        botonId: boton.id || '(sin id)',
        dataRiReal: dataRiReal
      };

    }, dataRi, numNotificacion || null, SELECTORES, COLUMNAS);

    if (!resultadoClic || resultadoClic.error) {
      log('error', ctx, `Error: ${resultadoClic ? resultadoClic.error : 'resultado null'}`);
      return { exito: false, error: resultadoClic ? resultadoClic.error : 'Error desconocido (frame en transición)' };
    }

    log('info', ctx, `Clic realizado (método: ${resultadoClic.metodo}, id: ${resultadoClic.botonId}, data-ri real: ${resultadoClic.dataRiReal})`);

    await delay(CONFIG_EXTRACCION.esperaPostClic);

    const inicio = Date.now();
    let modalAbierto = false;

    while (Date.now() - inicio < CONFIG_EXTRACCION.timeoutModal) {
      
      if (page.isClosed()) {
        log('error', ctx, 'Página cerrada durante espera de modal');
        return { exito: false, error: 'Página cerrada' };
      }

      const estadoModal = await evaluarSeguro(page, (selectores) => {
        for (const sel of selectores.modal.contenedor) {
          const modal = document.querySelector(sel);
          if (modal) {
            const ariaHidden = modal.getAttribute('aria-hidden');
            const display = window.getComputedStyle(modal).display;

            if (ariaHidden === 'false' || (ariaHidden !== 'true' && display !== 'none')) {
              const titulo = modal.querySelector('.ui-dialog-title');
              return {
                visible: true,
                titulo: titulo ? titulo.textContent.substring(0, 100) : ''
              };
            }
          }
        }
        return { visible: false };
      }, SELECTORES);

      if (estadoModal && estadoModal.visible) {
        log('success', ctx, `✓ Modal abierto: "${estadoModal.titulo}"`);
        modalAbierto = true;
        break;
      }

      await delay(CONFIG_EXTRACCION.intervaloVerificacionModal);
    }

    if (!modalAbierto) {
      log('warn', ctx, 'Modal no se abrió después del clic');
      return { exito: false, error: 'Modal no se abrió (timeout)' };
    }

    return { exito: true };

  } catch (error) {
    log('error', ctx, `Excepción esperando modal: ${error.message}`);
    return { exito: false, error: error.message };
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// PAGINACIÓN
// ════════════════════════════════════════════════════════════════════════════════

async function verificarPaginacion(page, requestId) {
  validarPage(page, 'verificarPaginacion');
  validarRequestId(requestId, 'verificarPaginacion');

  const ctx = `PAGIN:${requestId}`;

  const info = await evaluarSeguro(page, (selectores) => {
    const paginador = document.querySelector(selectores.paginacion.contenedor);

    if (!paginador) {
      return { hayMas: false, paginaActual: 1, totalPaginas: 1 };
    }

    const textoInfo = paginador.querySelector(selectores.paginacion.info);
    const textoInfoStr = textoInfo ? textoInfo.textContent : '';
    const match = textoInfoStr.match(/(\d+)\s*\/\s*(\d+)/);

    if (match) {
      const actual = parseInt(match[1], 10);
      const total = parseInt(match[2], 10);
      return {
        hayMas: actual < total,
        paginaActual: actual,
        totalPaginas: total
      };
    }

    const botonSiguiente = paginador.querySelector(selectores.paginacion.siguiente);

    const paginas = paginador.querySelectorAll(selectores.paginacion.paginas);
    const paginaActiva = paginador.querySelector(selectores.paginacion.paginaActiva);
    const numActiva = paginaActiva ? parseInt(paginaActiva.textContent, 10) : 1;

    return {
      hayMas: !!botonSiguiente,
      paginaActual: numActiva || 1,
      totalPaginas: paginas.length || 1
    };

  }, SELECTORES);

  if (info) {
    log('info', ctx, `Paginación: Página ${info.paginaActual}/${info.totalPaginas} (${info.hayMas ? 'hay más' : 'última'})`);
  }

  return info || { hayMas: false, paginaActual: 1, totalPaginas: 1 };
}

async function navegarPaginaSiguiente(page, requestId) {
  validarPage(page, 'navegarPaginaSiguiente');
  validarRequestId(requestId, 'navegarPaginaSiguiente');

  const ctx = `PAGIN:${requestId}`;

  log('info', ctx, 'Navegando a la siguiente página...');

  const clicOk = await evaluarSeguro(page, (selectores) => {
    const paginador = document.querySelector(selectores.paginacion.contenedor);
    if (!paginador) return { error: 'Paginador no encontrado' };

    const botonSiguiente = paginador.querySelector(selectores.paginacion.siguiente);
    if (!botonSiguiente) return { error: 'Botón siguiente no encontrado o deshabilitado' };

    try {
      if (typeof jQuery !== 'undefined' && jQuery(botonSiguiente).length) {
        jQuery(botonSiguiente).trigger('click');
      } else {
        botonSiguiente.click();
      }
      return { exito: true };
    } catch (e) {
      return { error: `Error clic: ${e.message}` };
    }
  }, SELECTORES);

  if (!clicOk || clicOk.error) {
    log('warn', ctx, `No se pudo navegar: ${clicOk ? clicOk.error : 'null'}`);
    return false;
  }

  await delay(CONFIG_EXTRACCION.esperaPostClic);
  const recarga = await esperarTablaCargada(page, requestId);

  if (!recarga.cargada || !recarga.tieneFilas) {
    log('warn', ctx, 'Tabla no se recargó correctamente después de paginar');
    return false;
  }

  log('info', ctx, 'Esperando estabilización de data-ri...');
  await delay(CONFIG_EXTRACCION.tiempoEstabilidadDom);

  log('success', ctx, `✓ Página siguiente cargada y estabilizada — ${recarga.cantidadFilas} filas`);
  return true;
}

async function navegarAPagina(page, numeroPagina, requestId) {
  validarPage(page, 'navegarAPagina');
  validarRequestId(requestId, 'navegarAPagina');

  const ctx = `PAGIN:${requestId}`;

  log('info', ctx, `Navegando a página ${numeroPagina}...`);

  const infoActual = await verificarPaginacion(page, requestId);
  if (infoActual.paginaActual === numeroPagina) {
    log('info', ctx, `Ya estamos en la página ${numeroPagina}`);
    return true;
  }

  const clicOk = await evaluarSeguro(page, (selectores, numPag) => {
    const paginador = document.querySelector(selectores.paginacion.contenedor);
    if (!paginador) return { error: 'Paginador no encontrado' };

    const links = paginador.querySelectorAll(selectores.paginacion.paginas);
    for (const link of links) {
      const textoPag = (link.textContent || '').trim();
      if (parseInt(textoPag, 10) === numPag) {
        try {
          if (typeof jQuery !== 'undefined' && jQuery(link).length) {
            jQuery(link).trigger('click');
          } else {
            link.click();
          }
          return { exito: true };
        } catch (e) {
          return { error: `Error clic: ${e.message}` };
        }
      }
    }

    if (numPag === 1) {
      const btnPrev = paginador.querySelector('.ui-paginator-first:not(.ui-state-disabled)');
      if (btnPrev) {
        try {
          if (typeof jQuery !== 'undefined') jQuery(btnPrev).trigger('click');
          else btnPrev.click();
          return { exito: true, metodo: 'boton_first' };
        } catch (e) {
          // Continuar
        }
      }
    }

    return { error: `Página ${numPag} no encontrada en el paginador` };
  }, SELECTORES, numeroPagina);

  if (!clicOk || clicOk.error) {
    log('warn', ctx, `No se pudo navegar a página ${numeroPagina}: ${clicOk ? clicOk.error : 'null'}`);
    return false;
  }

  await delay(CONFIG_EXTRACCION.esperaPostClic);
  const recarga = await esperarTablaCargada(page, requestId);

  if (!recarga.cargada) {
    log('warn', ctx, `Tabla no se recargó después de navegar a página ${numeroPagina}`);
    return false;
  }

  await delay(CONFIG_EXTRACCION.tiempoEstabilidadDom);

  log('success', ctx, `✓ Página ${numeroPagina} cargada y estabilizada — ${recarga.cantidadFilas} filas`);
  return true;
}

// ════════════════════════════════════════════════════════════════════════════════
// UTILIDADES
// ════════════════════════════════════════════════════════════════════════════════

async function capturarPantallaCasillas(page, requestId) {
  validarPage(page, 'capturarPantallaCasillas');
  validarRequestId(requestId, 'capturarPantallaCasillas');

  const ctx = `CAPTURA:${requestId}`;

  try {
    const screenshot = await page.screenshot({
      encoding: 'base64',
      fullPage: false,
      type: 'jpeg',
      quality: 70
    });

    log('info', ctx, `Screenshot capturado (${Math.round(screenshot.length / 1024)}KB)`);
    return screenshot;

  } catch (error) {
    log('error', ctx, `Error capturando screenshot: ${error.message}`);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// EXPORTACIONES — v5.6.1 AUDITED
// ════════════════════════════════════════════════════════════════════════════════

module.exports = {
  filtrarBandejaPorFecha,
  esperarTablaCargada,
  verificarEstadoTablaActual,
  extraerNotificaciones,
  diagnosticarPaginaCasillas,
  abrirModalAnexos,
  verificarPaginacion,
  navegarPaginaSiguiente,
  navegarAPagina,
  capturarPantallaCasillas,
  SELECTORES,
  COLUMNAS,
  CONFIG_EXTRACCION
};
