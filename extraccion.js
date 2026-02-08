/**
 * ════════════════════════════════════════════════════════════════════════════════
 * LEXA SCRAPER — EXTRACCIÓN v5.5.0
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * Autor:   LEXA Assistant (CTO)
 * Fecha:   Febrero 2026
 *
 * Changelog:
 *   v5.5.0  — AUDITORÍA SENIOR — FIX CRÍTICO "0 NOTIFICACIONES"
 *     • FIX BUG-007: SINOE carga tabla con datos por defecto (últimos 7 días).
 *       El código anterior SIEMPRE re-aplicaba el filtro, lo cual causaba que
 *       PrimeFaces recargara la tabla vía AJAX y la dejara vacía temporalmente.
 *       SOLUCIÓN: Nueva función verificarEstadoTablaActual() verifica si la
 *       tabla YA tiene datos ANTES de decidir si aplicar filtro.
 *     • FIX BUG-008: tiempoEstabilidadDom aumentado de 800ms a 1500ms para
 *       dar más tiempo a PrimeFaces de reconstruir el DOM.
 *     • NUEVO: Parámetro opciones.forzarSinFiltro para bypass total del filtro.
 *     • NUEVO: Logging mejorado con separadores visuales para debugging.
 *     • NUEVO: extraerNotificacionesPaginaActual ahora loguea el método usado.
 *
 *   v3.0.0  — Reescritura completa
 *     • FIX BUG CRÍTICO: Después de cerrarModal(), se llama a
 *       esperarTablaCargada() para que PrimeFaces reconstruya las filas
 *       AJAX antes de tocar la siguiente notificación.
 *     • FIX DESCARGA: Los PDFs Consolidados ahora se capturan como base64
 *       real usando fetch() dentro de page.evaluate(). Ya no solo se hace
 *       "clic y esperar" — se intercepta el contenido del archivo.
 *     • NUEVO: filtrarBandejaPorFecha() — Rellena campos Fecha Inicial /
 *       Final del formulario PrimeFaces y hace clic en Buscar.
 *     • NUEVO: Paginación completa — navega todas las páginas de resultados.
 *     • NUEVO: Re-localización de filas por N° Notificación en vez de
 *       data-ri fijo (el AJAX de PrimeFaces reasigna data-ri al recargar).
 *     • NUEVO: Campos alias (juzgado, fecha, pdf, nombreArchivo) para
 *       compatibilidad directa con el mapeo de index.js.
 *   v2.0.2  — Selectores corregidos para estructura real de SINOE
 *   v2.0.0  — Primera versión modular
 *
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │  ESTE ARCHIVO CONTIENE LOS PASOS 14-15 DEL FLUJO DE SCRAPING              │
 * │                                                                            │
 * │  Paso 14: Filtrar bandeja + Extraer notificaciones de la tabla             │
 * │  Paso 15: Descargar PDFs consolidados como base64                          │
 * │                                                                            │
 * │  Para los pasos 1-13 (login, CAPTCHA, navegación), ver: flujo-estable.js  │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *
 * ESTRUCTURA DE LA TABLA SINOE (verificada Feb 2026):
 * ┌────────┬────────┬─────┬─────────────────┬─────────────────────────┬─────────────────┬────────────────┬──────────────────┬────────┐
 * │ Chkbox │ Estado │ N°  │ N° Notificación │ N° Expediente           │ Sumilla         │ O.J.           │ Fecha            │ Anexos │
 * │  (0)   │  (1)   │ (2) │      (3)        │         (4)             │    (5)          │     (6)        │    (7)           │  (8)   │
 * └────────┴────────┴─────┴─────────────────┴─────────────────────────┴─────────────────┴────────────────┴──────────────────┴────────┘
 *
 * IDs REALES DE SINOE:
 *   - Tabla:           tbody[id*="tblLista_data"]
 *   - Filas:           tr[data-ri="N"]
 *   - Botón anexos:    button con span.ui-icon-circle-zoomout
 *   - Modal:           div[id*="dlgListaAnexos"]
 *   - Consolidado:     button[id*="btnDescargaTodo"]
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
// CONFIGURACIÓN — v5.5.0 OPTIMIZADA
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Timeouts específicos para extracción.
 * Estos valores han sido calibrados para el rendimiento real de SINOE.
 *
 * v5.5.0: Ajustados para mayor estabilidad con PrimeFaces AJAX
 */
const CONFIG_EXTRACCION = {
  // Tiempo máximo para que cargue la tabla vía AJAX
  timeoutCargaTabla: 25000,  // ⬆️ v5.5.0: 25s (era 20s)

  // Intervalo entre verificaciones de carga
  intervaloVerificacion: 1000,  // ⬆️ v5.5.0: 1s (era 800ms)

  // Tiempo máximo para que abra el modal de anexos
  timeoutModal: 15000,  // ⬆️ v5.5.0: 15s (era 12s)

  // Tiempo de espera después de hacer clic (para que PrimeFaces procese)
  esperaPostClic: 2500,  // ⬆️ v5.5.0: 2.5s (era 2s)

  // Tiempo entre procesamiento de notificaciones (evita saturar SINOE)
  pausaEntreNotificaciones: 2000,  // ⬆️ v5.5.0: 2s (era 1.5s)

  // Tiempo de espera para que inicie la descarga
  esperaDescarga: 5000,  // ⬆️ v5.5.0: 5s (era 4s)

  // Máximo de reintentos para operaciones fallidas
  maxReintentos: 3,

  // Timeout para descarga de PDF vía fetch (ms)
  timeoutDescargaPdf: 30000,

  // ⭐ CRÍTICO v5.5.0: Tiempo de estabilidad DOM
  // PrimeFaces puede tardar en reconstruir filas después de AJAX.
  // Este valor determina cuánto tiempo esperar después de detectar
  // que la tabla "parece" cargada, antes de intentar leer las filas.
  tiempoEstabilidadDom: 1500,  // ⬆️ v5.5.0: 1.5s (era 800ms)

  // Timeout para aplicar filtro de fechas
  timeoutFiltro: 20000,  // ⬆️ v5.5.0: 20s (era 15s)

  // Máximo de páginas a recorrer en paginación
  maxPaginas: 20
};

// ════════════════════════════════════════════════════════════════════════════════
// SELECTORES — VERIFICADOS CONTRA SINOE REAL (FEBRERO 2026)
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Selectores CSS verificados contra la estructura real de SINOE.
 *
 * IMPORTANTE: Si SINOE cambia su estructura HTML, este es el único
 * lugar que necesita actualizarse.
 *
 * Última verificación: 07/02/2026
 */
const SELECTORES = {

  // ──────────────────────────────────────────────────────────────────────────
  // TABLA DE NOTIFICACIONES
  // ──────────────────────────────────────────────────────────────────────────
  tabla: {
    // El tbody que contiene los datos (PrimeFaces DataTable)
    // ID real: "frmBusqueda:tblLista_data"
    cuerpo: [
      'tbody[id*="tblLista_data"]',
      'tbody[id*="tblLista"][class*="ui-datatable-data"]',
      '.ui-datatable-data'
    ],

    // El contenedor de la tabla completa
    contenedor: [
      '[id*="tblLista"]',
      '.ui-datatable',
      'div[id*="frmBusqueda"] .ui-datatable'
    ],

    // Indicador de carga AJAX de PrimeFaces
    cargando: [
      '.ui-datatable-loading',
      '.ui-blockui',
      '[id*="tblLista_loading"]'
    ]
  },

  // ──────────────────────────────────────────────────────────────────────────
  // FILAS Y CELDAS
  // ──────────────────────────────────────────────────────────────────────────
  filas: {
    // Filas con datos (tienen atributo data-ri de PrimeFaces)
    conDatos: 'tr[data-ri]',

    // Alternativas
    alternativas: [
      'tr[data-ri]',
      'tr[role="row"]',
      'tr.ui-widget-content'
    ],

    // Fila de "no hay datos"
    vacia: '.ui-datatable-empty-message'
  },

  celdas: {
    // Celdas estándar de PrimeFaces
    selector: 'td[role="gridcell"]',
    alternativa: 'td'
  },

  // ──────────────────────────────────────────────────────────────────────────
  // BOTÓN DE ANEXOS (ícono rojo en cada fila)
  // ──────────────────────────────────────────────────────────────────────────
  botonAnexos: {
    // El botón tiene un span con el ícono de lupa/zoom
    // En SINOE se ve como un círculo rojo con lupa
    porIcono: [
      'button:has(span.ui-icon-circle-zoomout)',
      'button .ui-icon-circle-zoomout',
      'button[class*="ui-button-icon-only"] .ui-icon'
    ],

    // Por ID parcial (PrimeFaces genera IDs dinámicos)
    porId: [
      'button[id*="j_idt"]',
      'a[id*="j_idt"]'
    ],

    // Por posición (última columna de la fila)
    porPosicion: 'td:last-child button, td:last-child a.ui-commandlink',

    // El ícono específico dentro del botón
    icono: 'span.ui-icon-circle-zoomout'
  },

  // ──────────────────────────────────────────────────────────────────────────
  // MODAL DE ANEXOS
  // ──────────────────────────────────────────────────────────────────────────
  modal: {
    // El contenedor del modal
    // ID real: "frmAnexos:dlgListaAnexos"
    contenedor: [
      'div[id*="dlgListaAnexos"]',
      'div[id*="frmAnexos"][class*="ui-dialog"]',
      '.ui-dialog[aria-hidden="false"]'
    ],

    // El modal visible (no oculto)
    visible: 'div[id*="dlgListaAnexos"][aria-hidden="false"], .ui-dialog[aria-hidden="false"]',

    // Título del modal (contiene "Lista de anexos de XXXXX-XXXX")
    titulo: '.ui-dialog-title, [id*="dlgListaAnexos_title"]',

    // Tabla de anexos dentro del modal
    tablaAnexos: '[id*="frmAnexos"] table, .ui-dialog table',

    // Filas de la tabla de anexos
    filasAnexos: '[id*="frmAnexos"] tbody tr'
  },

  // ──────────────────────────────────────────────────────────────────────────
  // BOTÓN CONSOLIDADO (descarga todos los PDFs en uno)
  // ──────────────────────────────────────────────────────────────────────────
  botonConsolidado: {
    // Por ID (el más confiable)
    // ID real: contiene "btnDescargaTodo"
    porId: [
      'button[id*="btnDescargaTodo"]',
      'a[id*="btnDescargaTodo"]',
      '[id*="DescargaTodo"]'
    ],

    // Por texto visible
    porTexto: [
      'button:contains("Consolidado")',
      'span:contains("Consolidado")'
    ],

    // Por ícono de descarga
    porIcono: 'button:has(.ui-icon-arrowthickstop-1-s)'
  },

  // ──────────────────────────────────────────────────────────────────────────
  // BOTÓN CERRAR MODAL
  // ──────────────────────────────────────────────────────────────────────────
  botonCerrar: {
    // Botón X en la esquina
    botonX: '.ui-dialog-titlebar-close',

    // Botón "Cerrar" en el footer
    porTexto: [
      'button:contains("Cerrar")',
      '.ui-dialog-footer button'
    ],

    // Por clase de PrimeFaces
    porClase: 'button[id*="Cerrar"], a[id*="Cerrar"]'
  },

  // ──────────────────────────────────────────────────────────────────────────
  // PAGINACIÓN (si hay más de 15 notificaciones)
  // ──────────────────────────────────────────────────────────────────────────
  paginacion: {
    contenedor: '.ui-paginator',
    siguiente: '.ui-paginator-next:not(.ui-state-disabled)',
    anterior: '.ui-paginator-prev:not(.ui-state-disabled)',
    paginas: '.ui-paginator-page',
    paginaActiva: '.ui-paginator-page.ui-state-active',
    info: '.ui-paginator-current' // "Registros: 26 - [ Página : 1/2 ]"
  },

  // ──────────────────────────────────────────────────────────────────────────
  // FILTRO DE FECHAS
  // ──────────────────────────────────────────────────────────────────────────
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

// ════════════════════════════════════════════════════════════════════════════════
// MAPEO DE COLUMNAS DE LA TABLA
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Índices de las columnas en la tabla de notificaciones.
 * Basado en la estructura real de SINOE (verificada Feb 2026).
 */
const COLUMNAS = {
  checkbox: 0,             // Checkbox de selección
  estadoLectura: 1,        // Ícono de sobre (leído/no leído)
  indice: 2,               // Número de fila (1, 2, 3...)
  numeroNotificacion: 3,   // N° Notificación (ej: "00310-2026")
  expediente: 4,           // N° Expediente (ej: "00489-2025-0-1606-JP-FC-01")
  sumilla: 5,              // Descripción/Tipo (ej: "ESCRITO 522-2026 RESOLUCION CUATRO")
  organoJurisdiccional: 6, // Juzgado (ej: "JUZGADO DE PAZ LETRADO - Pacasmayo")
  fechaHora: 7,            // Fecha y hora (ej: "03/02/2026 12:02:33")
  acciones: 8              // Columna con botón de anexos
};

// ════════════════════════════════════════════════════════════════════════════════
// UTILIDAD: FORMATO DE FECHA
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Genera una fecha en formato DD/MM/YYYY para los campos de SINOE.
 * @param {Date} fecha - Objeto Date
 * @returns {string} Fecha formateada (ej: "06/02/2026")
 */
function formatearFechaSinoe(fecha) {
  const dd = String(fecha.getDate()).padStart(2, '0');
  const mm = String(fecha.getMonth() + 1).padStart(2, '0');
  const yyyy = fecha.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

// ════════════════════════════════════════════════════════════════════════════════
// PASO 14.0: FILTRAR BANDEJA POR FECHA
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Filtra la bandeja de SINOE por rango de fechas.
 * Rellena los campos Fecha Inicial y Fecha Final del formulario
 * PrimeFaces y hace clic en "Buscar".
 *
 * IMPORTANTE: Los campos de fecha PrimeFaces (p:calendar) requieren:
 *   1. Clic para enfocar
 *   2. Ctrl+A → Backspace para limpiar
 *   3. Escritura carácter por carácter
 *   4. Clic fuera para disparar onchange/blur
 *
 * @param {Page}   page          - Instancia de Puppeteer page
 * @param {string} fechaInicial  - "DD/MM/YYYY" o null (default: 7 días atrás)
 * @param {string} fechaFinal    - "DD/MM/YYYY" o null (default: hoy)
 * @param {string} requestId     - ID único para logs
 * @returns {Promise<boolean>} true si se aplicó el filtro correctamente
 */
async function filtrarBandejaPorFecha(page, fechaInicial, fechaFinal, requestId) {
  const ctx = `FILTRO:${requestId}`;

  // ── Calcular fechas por defecto ──
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
    // ────────────────────────────────────────────────────────────────────
    // 1. Localizar los campos de fecha en el DOM
    // ────────────────────────────────────────────────────────────────────
    const camposEncontrados = await evaluarSeguro(page, (selectoresFiltro) => {
      let inputInicial = null;
      let inputFinal = null;

      // Buscar campo Fecha Inicial
      for (const sel of selectoresFiltro.fechaInicial) {
        inputInicial = document.querySelector(sel);
        if (inputInicial) break;
      }

      // Buscar campo Fecha Final
      for (const sel of selectoresFiltro.fechaFinal) {
        inputFinal = document.querySelector(sel);
        if (inputFinal) break;
      }

      // Buscar botón Buscar
      let botonBuscar = null;
      for (const sel of selectoresFiltro.botonBuscar) {
        botonBuscar = document.querySelector(sel);
        if (botonBuscar) break;
      }

      // Si no encontró el botón por ID, buscar por texto
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

    // ────────────────────────────────────────────────────────────────────
    // 2. Rellenar Fecha Inicial
    // ────────────────────────────────────────────────────────────────────
    if (camposEncontrados.tieneInicial) {
      await rellenarCampoFecha(page, SELECTORES.filtro.fechaInicial, fechaInicial, ctx, 'Fecha Inicial');
    }

    // ────────────────────────────────────────────────────────────────────
    // 3. Rellenar Fecha Final
    // ────────────────────────────────────────────────────────────────────
    if (camposEncontrados.tieneFinal) {
      await rellenarCampoFecha(page, SELECTORES.filtro.fechaFinal, fechaFinal, ctx, 'Fecha Final');
    }

    // ────────────────────────────────────────────────────────────────────
    // 4. Seleccionar Estado "Todos" (si existe el selector)
    // ────────────────────────────────────────────────────────────────────
    await evaluarSeguro(page, (selectoresEstado) => {
      for (const sel of selectoresEstado) {
        const selectEl = document.querySelector(sel);
        if (selectEl && selectEl.tagName === 'SELECT') {
          // Buscar la opción "Todos"
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

    // ────────────────────────────────────────────────────────────────────
    // 5. Hacer clic en "Buscar"
    // ────────────────────────────────────────────────────────────────────
    const clicBuscar = await evaluarSeguro(page, (selectoresBuscar) => {
      // Por ID
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

      // Fallback: buscar por texto
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

    // ────────────────────────────────────────────────────────────────────
    // 6. Esperar que la tabla se recargue con los resultados filtrados
    // ────────────────────────────────────────────────────────────────────
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

/**
 * Rellena un campo de fecha PrimeFaces de forma robusta.
 * Los p:calendar de PrimeFaces necesitan un tratamiento especial:
 * clic → limpiar → escribir carácter a carácter → blur.
 *
 * @param {Page}     page       - Instancia de Puppeteer page
 * @param {string[]} selectores - Array de selectores CSS a probar
 * @param {string}   valor      - Fecha en formato "DD/MM/YYYY"
 * @param {string}   ctx        - Contexto para logs
 * @param {string}   nombreCampo - Nombre legible del campo
 */
async function rellenarCampoFecha(page, selectores, valor, ctx, nombreCampo) {
  // Encontrar el elemento en la página
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
    // Hacer clic en el campo para enfocarlo
    await page.click(selectorEncontrado);
    await delay(300);

    // Seleccionar todo el contenido y borrarlo (Ctrl+A → Backspace)
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await delay(100);
    await page.keyboard.press('Backspace');
    await delay(200);

    // Escribir la fecha carácter por carácter (necesario para p:calendar)
    for (const char of valor) {
      await page.keyboard.type(char, { delay: 50 });
    }
    await delay(300);

    // Disparar blur para que PrimeFaces procese el valor
    await page.keyboard.press('Tab');
    await delay(500);

    // Cerrar cualquier popup de calendario que se haya abierto
    await evaluarSeguro(page, () => {
      // Ocultar popups de p:calendar (datepicker)
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
// PASO 14.1: ESPERAR CARGA DE TABLA (FUNCIÓN CRÍTICA)
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Espera a que la tabla de notificaciones cargue completamente tras un
 * AJAX update de PrimeFaces.
 *
 * Esta función verifica:
 *   1. Que los spinners/overlays de PrimeFaces hayan desaparecido
 *   2. Que exista el tbody de la tabla
 *   3. Que haya filas con datos O un mensaje de "no hay datos"
 *   4. Que el DOM esté estable (sin mutaciones durante ~1500ms)
 *
 * Es la función más importante del archivo. El bug principal
 * ("resultado null" en notificaciones 2-7) se debía a no llamar
 * esta función después de cerrar el modal.
 *
 * @param {Page}   page      - Instancia de Puppeteer page
 * @param {string} requestId - ID único para logs
 * @returns {Promise<{cargada: boolean, tieneFilas: boolean, cantidadFilas: number, mensaje: string}>}
 */
async function esperarTablaCargada(page, requestId) {
  const ctx = `TABLA:${requestId}`;
  const inicio = Date.now();

  log('info', ctx, 'Esperando carga de tabla AJAX...');

  while (Date.now() - inicio < CONFIG_EXTRACCION.timeoutCargaTabla) {

    const estado = await evaluarSeguro(page, (selectores) => {

      // ────────────────────────────────────────────────────────────────
      // 1. Verificar si hay indicador de carga activo
      // ────────────────────────────────────────────────────────────────
      for (const selCarga of selectores.tabla.cargando) {
        const indicador = document.querySelector(selCarga);
        if (indicador) {
          const estilo = window.getComputedStyle(indicador);
          if (estilo.display !== 'none' && estilo.visibility !== 'hidden') {
            return { estado: 'cargando' };
          }
        }
      }

      // Verificar overlays genéricos de PrimeFaces
      const blockUis = document.querySelectorAll('.ui-blockui, .ui-blockui-content');
      for (const block of blockUis) {
        const estilo = window.getComputedStyle(block);
        if (estilo.display !== 'none' && estilo.visibility !== 'hidden' && estilo.opacity !== '0') {
          return { estado: 'cargando' };
        }
      }

      // ────────────────────────────────────────────────────────────────
      // 2. Buscar el tbody de la tabla
      // ────────────────────────────────────────────────────────────────
      let tbody = null;
      for (const selTbody of selectores.tabla.cuerpo) {
        tbody = document.querySelector(selTbody);
        if (tbody) break;
      }

      if (!tbody) {
        // Intentar buscar dentro de un contenedor de datatable
        const contenedor = document.querySelector('.ui-datatable');
        if (contenedor) {
          tbody = contenedor.querySelector('tbody');
        }
      }

      if (!tbody) {
        return { estado: 'sin_tabla' };
      }

      // ────────────────────────────────────────────────────────────────
      // 3. Contar filas con datos
      // ────────────────────────────────────────────────────────────────
      const filas = tbody.querySelectorAll('tr[data-ri]');
      const filasReales = Array.from(filas).filter(fila => {
        // Excluir filas de mensaje vacío
        if (fila.classList.contains('ui-datatable-empty-message')) return false;
        // Debe tener más de 2 celdas
        const celdas = fila.querySelectorAll('td');
        return celdas.length > 2;
      });

      // ────────────────────────────────────────────────────────────────
      // 4. Verificar mensaje de "no hay datos"
      // ────────────────────────────────────────────────────────────────
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

    // ──────────────────────────────────────────────────────────────────
    // Procesar resultado
    // ──────────────────────────────────────────────────────────────────

    if (!estado) {
      // Error evaluando (frame en transición), reintentar
      await delay(CONFIG_EXTRACCION.intervaloVerificacion);
      continue;
    }

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
      // Esperar un poco más para asegurar estabilidad del DOM
      await delay(CONFIG_EXTRACCION.tiempoEstabilidadDom);

      // Verificar una segunda vez que las filas siguen ahí (anti-flicker)
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

      // Las filas desaparecieron entre la primera y segunda lectura → DOM inestable
      log('info', ctx, 'DOM inestable (filas desaparecieron), reintentando...');
      await delay(CONFIG_EXTRACCION.intervaloVerificacion);
      continue;
    }

    await delay(CONFIG_EXTRACCION.intervaloVerificacion);
  }

  // Timeout alcanzado
  log('warn', ctx, `Timeout (${CONFIG_EXTRACCION.timeoutCargaTabla}ms) esperando tabla`);
  return {
    cargada: false,
    tieneFilas: false,
    cantidadFilas: 0,
    mensaje: 'Timeout esperando carga'
  };
}

// ════════════════════════════════════════════════════════════════════════════════
// ⭐ NUEVO v5.5.0: VERIFICACIÓN RÁPIDA DE ESTADO DE TABLA
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Verifica si la tabla YA tiene datos SIN modificar nada.
 * Se usa ANTES de decidir si aplicar filtro de fechas.
 *
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │  FIX BUG-007: Esta función es la solución al bug "0 notificaciones".       │
 * │                                                                            │
 * │  PROBLEMA: SINOE carga la tabla con los últimos 7 días por defecto.        │
 * │            El código anterior SIEMPRE re-aplicaba el filtro, causando      │
 * │            que PrimeFaces recargara la tabla vía AJAX y la dejara vacía    │
 * │            temporalmente mientras el DOM se reconstruía.                   │
 * │                                                                            │
 * │  SOLUCIÓN: Verificar si la tabla YA tiene datos ANTES de aplicar filtro.   │
 * │            Si ya hay datos → NO tocar el filtro → extraer directamente.    │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *
 * @param {Page}   page      - Instancia de Puppeteer page
 * @param {string} requestId - ID único para logs
 * @returns {Promise<Object>} Estado de la tabla con información detallada
 */
async function verificarEstadoTablaActual(page, requestId) {
  const ctx = `CHECK:${requestId}`;

  const estado = await evaluarSeguro(page, (selectores) => {
    let resultado = {
      tablaCargada: false,
      tieneFilas: false,
      cantidadFilas: 0,
      estadoCarga: 'desconocido',
      detalles: {}
    };

    // ── 1. Verificar si hay indicadores de carga activos ──
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

    // Verificar overlays de PrimeFaces
    const blockUis = document.querySelectorAll('.ui-blockui, .ui-blockui-content');
    for (const block of blockUis) {
      const estilo = window.getComputedStyle(block);
      if (estilo.display !== 'none' && estilo.visibility !== 'hidden' && estilo.opacity !== '0') {
        resultado.estadoCarga = 'cargando';
        return resultado;
      }
    }

    // ── 2. Buscar el tbody de la tabla ──
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

    // ── 3. Contar filas válidas con data-ri ──
    const filasDataRi = tbody.querySelectorAll('tr[data-ri]');
    const filasValidas = Array.from(filasDataRi).filter(fila => {
      // Excluir filas de mensaje vacío
      if (fila.classList.contains('ui-datatable-empty-message')) return false;
      // Verificar que tenga suficientes celdas (mínimo 5 para ser una fila real)
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

    // ── 4. Obtener info del paginador si existe ──
    const infoPag = document.querySelector('.ui-paginator-current');
    if (infoPag) {
      const texto = infoPag.textContent || '';
      const matchReg = texto.match(/Registros:\s*(\d+)/i);
      if (matchReg) {
        resultado.detalles.registrosSegunPaginador = parseInt(matchReg[1], 10);
      }
    }

    // ── 5. Verificar valores de los campos de fecha (para debug) ──
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
// PASO 14.2: EXTRAER NOTIFICACIONES DE LA PÁGINA ACTUAL
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Extrae la lista de notificaciones de la tabla visible en la página actual.
 * NO maneja paginación — solo lee lo que está visible.
 *
 * @param {Page}   page      - Instancia de Puppeteer page
 * @param {string} requestId - ID único para logs
 * @param {number} paginaNum - Número de página actual (1, 2, 3...)
 * @returns {Promise<Array>} Array de objetos notificación
 */
async function extraerNotificacionesPaginaActual(page, requestId, paginaNum = 1) {
  const ctx = `NOTIF:${requestId}`;

  const resultado = await evaluarSeguro(page, (selectores, columnas) => {
    const notificaciones = [];
    let metodoUsado = '';

    // ── Buscar el tbody ──
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

    // ── Obtener todas las filas con data-ri ──
    const filas = tbody.querySelectorAll('tr[data-ri]');

    if (filas.length === 0) {
      return { error: 'No se encontraron filas con data-ri' };
    }

    // ── Procesar cada fila ──
    for (const fila of filas) {
      // Saltar filas de mensaje vacío
      if (fila.classList.contains('ui-datatable-empty-message')) continue;

      const celdas = fila.querySelectorAll('td');
      if (celdas.length < 5) continue; // Fila incompleta

      // Obtener el data-ri (índice de PrimeFaces)
      const dataRi = fila.getAttribute('data-ri');

      // ── Detectar si está leída (icono de sobre) ──
      const celdaEstado = celdas[columnas.estadoLectura];
      const iconoSobre = celdaEstado ? (celdaEstado.querySelector('img, span[class*="icon"]')) : null;
      const srcIcono = iconoSobre ? (iconoSobre.src || iconoSobre.className || '') : '';
      const leido = srcIcono.length > 0 && (
        srcIcono.includes('leido') ||
        srcIcono.includes('read') ||
        !srcIcono.includes('nuevo')
      );

      // ── Extraer texto de cada columna ──
      const textos = Array.from(celdas).map(c => (c.textContent || '').trim());

      // ── Verificar si tiene botón de anexos ──
      const celdaAcciones = celdas[celdas.length - 1];
      let tieneBotonAnexos = false;

      if (celdaAcciones) {
        const boton = celdaAcciones.querySelector('button') ||
                      celdaAcciones.querySelector('a[onclick]');
        tieneBotonAnexos = !!boton;
      }

      // ── Construir objeto de notificación ──
      const indiceNumerico = parseInt(dataRi, 10);
      const numNotif = textos[columnas.numeroNotificacion] || '';
      const expediente = textos[columnas.expediente] || '';
      const organoJ = textos[columnas.organoJurisdiccional] || '';
      const fechaH = textos[columnas.fechaHora] || '';

      const notificacion = {
        // Campos internos
        indice: Number.isNaN(indiceNumerico) ? 0 : indiceNumerico,
        dataRi: dataRi || '0',

        // Campos de datos
        numero: textos[columnas.indice] || '',
        numNotificacion: numNotif,
        numeroNotificacion: numNotif,      // Alias para compatibilidad v2
        expediente: expediente,
        sumilla: textos[columnas.sumilla] || '',
        organoJurisdiccional: organoJ,
        juzgado: organoJ,                  // Alias para index.js
        fechaHora: fechaH,
        fecha: fechaH,                     // Alias para index.js

        // Estado
        leido: leido,
        tieneBotonAnexos: tieneBotonAnexos,

        // Se rellenarán en procesarNotificaciones()
        pdf: '',
        archivo: '',           // Alias de pdf — index.js lee n.archivo
        nombreArchivo: '',
        descargado: false
      };

      // Solo agregar si tiene datos mínimos
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

  // Agregar número de página a cada notificación (para navegación en procesarNotificaciones)
  const notificaciones = (resultado.notificaciones || []).map(n => ({
    ...n,
    _pagina: paginaNum
  }));

  // v5.5.0: Log mejorado con método usado
  log('info', ctx, `Página ${paginaNum}: ${notificaciones.length} notificaciones extraídas (${resultado.metodo})`);

  return notificaciones;
}

// ════════════════════════════════════════════════════════════════════════════════
// ⭐ PASO 14.3: EXTRAER NOTIFICACIONES — v5.5.0 CORREGIDA
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Función principal de extracción. Opcionalmente filtra por fecha,
 * luego extrae notificaciones de todas las páginas de resultados.
 *
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │  v5.5.0 — CAMBIO CRÍTICO:                                                  │
 * │                                                                            │
 * │  Ahora verifica si la tabla YA tiene datos ANTES de aplicar filtro.        │
 * │  Si ya hay datos visibles → NO toca el filtro → extrae directamente.       │
 * │                                                                            │
 * │  Esto soluciona el bug "0 notificaciones" causado por PrimeFaces           │
 * │  recargando la tabla y dejándola vacía temporalmente.                      │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *
 * @param {Page}   page      - Instancia de Puppeteer page
 * @param {string} requestId - ID único para logs
 * @param {Object} opciones  - Opciones de filtrado
 * @param {string} opciones.fechaInicial    - "DD/MM/YYYY" o null
 * @param {string} opciones.fechaFinal      - "DD/MM/YYYY" o null
 * @param {boolean} opciones.aplicarFiltro  - true para permitir filtrado (default: true)
 * @param {boolean} opciones.forzarSinFiltro - true para NUNCA filtrar (default: false) ⬅️ NUEVO v5.5.0
 * @returns {Promise<Array>} Array completo de notificaciones (todas las páginas)
 */
async function extraerNotificaciones(page, requestId, opciones = {}) {
  const ctx = `NOTIF:${requestId}`;
  const forzarSinFiltro = opciones.forzarSinFiltro === true;
  let aplicarFiltro = opciones.aplicarFiltro !== false; // Default: true

  log('info', ctx, '════════════════════════════════════════════════════════════════');
  log('info', ctx, 'EXTRACCIÓN DE NOTIFICACIONES v5.5.0');
  log('info', ctx, `Opciones: aplicarFiltro=${aplicarFiltro}, forzarSinFiltro=${forzarSinFiltro}`);
  log('info', ctx, '════════════════════════════════════════════════════════════════');

  // ────────────────────────────────────────────────────────────────────────
  // ⭐ PASO 0 (NUEVO v5.5.0): Verificar si la tabla YA tiene datos
  //
  // LÓGICA: Si la tabla ya tiene notificaciones cargadas, NO tocar el filtro.
  //         Esto evita que PrimeFaces recargue la tabla vía AJAX y la deje
  //         vacía temporalmente, causando que se extraigan 0 notificaciones.
  // ────────────────────────────────────────────────────────────────────────
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

  // ────────────────────────────────────────────────────────────────────────
  // PASO 1: Aplicar filtro de fechas (SOLO si no hay datos y está permitido)
  // ────────────────────────────────────────────────────────────────────────
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

  // ────────────────────────────────────────────────────────────────────────
  // PASO 2: Esperar que la tabla cargue y esté estable
  // ────────────────────────────────────────────────────────────────────────
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

  // ────────────────────────────────────────────────────────────────────────
  // PASO 3: Extraer notificaciones de la primera página
  // ────────────────────────────────────────────────────────────────────────
  log('info', ctx, 'PASO 3: Extrayendo notificaciones de página 1...');

  let todasLasNotificaciones = await extraerNotificacionesPaginaActual(page, requestId, 1);

  if (todasLasNotificaciones.length === 0) {
    log('warn', ctx, '❌ Primera página sin notificaciones extraíbles');
    log('info', ctx, 'Ejecutando diagnóstico para entender el problema...');
    await diagnosticarPaginaCasillas(page, requestId);
    return [];
  }

  log('success', ctx, `✓ Página 1: ${todasLasNotificaciones.length} notificaciones extraídas`);

  // ────────────────────────────────────────────────────────────────────────
  // PASO 4: Manejar paginación — recorrer páginas siguientes (si las hay)
  // ────────────────────────────────────────────────────────────────────────
  let paginaActual = 1;

  while (paginaActual < CONFIG_EXTRACCION.maxPaginas) {
    const paginacion = await verificarPaginacion(page, requestId);

    if (!paginacion.hayMas) {
      log('info', ctx, `Fin de paginación en página ${paginaActual}`);
      break;
    }

    // Navegar a la siguiente página
    const navegoOk = await navegarPaginaSiguiente(page, requestId);
    if (!navegoOk) {
      log('warn', ctx, 'No se pudo navegar a la siguiente página');
      break;
    }

    paginaActual++;

    // Extraer notificaciones de la nueva página
    const notifsPagina = await extraerNotificacionesPaginaActual(page, requestId, paginaActual);
    log('info', ctx, `Página ${paginaActual}: ${notifsPagina.length} notificaciones extraídas`);

    todasLasNotificaciones = todasLasNotificaciones.concat(notifsPagina);
  }

  // ────────────────────────────────────────────────────────────────────────
  // PASO 4.5: Si hubo múltiples páginas, volver a página 1
  // ────────────────────────────────────────────────────────────────────────
  if (paginaActual > 1) {
    log('info', ctx, `Navegando de vuelta a página 1 (estamos en página ${paginaActual})...`);
    const volverOk = await navegarAPagina(page, 1, requestId);
    if (!volverOk) {
      log('warn', ctx, 'No se pudo volver a página 1 — procesarNotificaciones manejará navegación');
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // PASO 5: Resumen y retorno
  // ────────────────────────────────────────────────────────────────────────
  log('success', ctx, '════════════════════════════════════════════════════════════════');
  log('success', ctx, `✓ EXTRACCIÓN COMPLETADA: ${todasLasNotificaciones.length} notificaciones`);
  log('success', ctx, `  de ${paginaActual} página(s)`);
  log('success', ctx, '════════════════════════════════════════════════════════════════');

  // Log de las primeras notificaciones para verificación
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
// DIAGNÓSTICO DE PÁGINA
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Genera un diagnóstico detallado de la página para debug.
 * Se usa cuando algo falla para entender el estado de la página.
 *
 * @param {Page}   page      - Instancia de Puppeteer page
 * @param {string} requestId - ID único para logs
 * @returns {Promise<Object>} Diagnóstico completo
 */
async function diagnosticarPaginaCasillas(page, requestId) {
  const ctx = `DIAG:${requestId}`;

  log('info', ctx, '🔍 Ejecutando diagnóstico de página...');

  const diagnostico = await evaluarSeguro(page, () => {
    const resultado = {
      timestamp: new Date().toISOString(),
      url: window.location.href,
      titulo: document.title,

      // Estado de la sesión
      sesion: {
        usuarioVisible: !!document.querySelector('[id*="Bienvenido"], .welcome-text'),
        menuVisible: !!document.querySelector('[id*="menu"], nav, .menu'),
        loginVisible: !!document.querySelector('input[type="password"]')
      },

      // Tablas encontradas
      tablas: [],

      // Elementos PrimeFaces
      primefaces: {
        datatables: document.querySelectorAll('.ui-datatable').length,
        dialogs: document.querySelectorAll('.ui-dialog').length,
        dialogsVisibles: document.querySelectorAll('.ui-dialog[aria-hidden="false"]').length,
        panels: document.querySelectorAll('.ui-panel').length
      },

      // Formularios
      formularios: [],

      // Mensajes de error
      errores: [],

      // Texto relevante
      extractoBody: ''
    };

    // ── Analizar tablas ──
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

    // ── Analizar formularios ──
    const forms = document.querySelectorAll('form');
    forms.forEach((form, i) => {
      resultado.formularios.push({
        indice: i,
        id: form.id || '(sin id)',
        action: form.action ? form.action.substring(0, 80) : ''
      });
    });

    // ── Buscar mensajes de error ──
    const contenedoresError = document.querySelectorAll(
      '.ui-messages, .ui-growl, .error, .alert-danger, [class*="error"]'
    );
    contenedoresError.forEach(el => {
      const texto = el.textContent.trim();
      if (texto) resultado.errores.push(texto.substring(0, 200));
    });

    // ── Extracto del body ──
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
// PASO 15.1: ABRIR MODAL DE ANEXOS
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Abre el modal de anexos para una notificación específica.
 * Hace clic en el botón de anexos (ícono rojo/lupa) de la fila indicada.
 *
 * IMPORTANTE: Después de un AJAX reload de PrimeFaces, los data-ri pueden
 * cambiar. Por eso esta función acepta tanto dataRi como numNotificacion
 * para re-localizar la fila.
 *
 * @param {Page}          page             - Instancia de Puppeteer page
 * @param {number|string} dataRi           - Índice data-ri de la fila (puede haber cambiado)
 * @param {string}        requestId        - ID único para logs
 * @param {string}        [numNotificacion] - N° de notificación para re-localizar la fila
 * @returns {Promise<{exito: boolean, error?: string}>}
 */
async function abrirModalAnexos(page, dataRi, requestId, numNotificacion) {
  const ctx = `MODAL:${requestId}`;

  log('info', ctx, `Abriendo modal para fila data-ri=${dataRi}${numNotificacion ? ` (Notif: ${numNotificacion})` : ''}...`);

  // ────────────────────────────────────────────────────────────────────────
  // 1. Buscar la fila y hacer clic en el botón de anexos
  // ────────────────────────────────────────────────────────────────────────
  const resultadoClic = await evaluarSeguro(page, (dataRiParam, numNotifParam, selectores, columnas) => {

    // ── Estrategia A: Buscar fila por data-ri directo ──
    let fila = document.querySelector(`tr[data-ri="${dataRiParam}"]`);

    // ── Estrategia B: Si no se encuentra o se pasa numNotificacion, buscar por texto ──
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

    // Actualizar el data-ri real de la fila encontrada
    const dataRiReal = fila.getAttribute('data-ri');

    // ── Buscar el botón de anexos dentro de la fila ──
    let boton = null;
    let metodo = '';

    // Estrategia 1: Buscar por ícono de lupa/zoom
    const iconoLupa = fila.querySelector('span.ui-icon-circle-zoomout');
    if (iconoLupa) {
      boton = iconoLupa.closest('button') || iconoLupa.closest('a');
      metodo = 'icono_lupa';
    }

    // Estrategia 2: Buscar cualquier botón en la última celda
    if (!boton) {
      const ultimaCelda = fila.querySelector('td:last-child');
      if (ultimaCelda) {
        boton = ultimaCelda.querySelector('button') ||
                ultimaCelda.querySelector('a[onclick]') ||
                ultimaCelda.querySelector('a[id*="j_idt"]');
        metodo = 'ultima_celda';
      }
    }

    // Estrategia 3: Buscar cualquier botón con ID dinámico de PrimeFaces
    if (!boton) {
      boton = fila.querySelector('button[id*="j_idt"]') ||
              fila.querySelector('a[id*="j_idt"]');
      metodo = 'id_dinamico';
    }

    // Estrategia 4: Cualquier botón en la fila
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

    // ── Hacer clic usando jQuery (SINOE usa PrimeFaces/jQuery) ──
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

  // ────────────────────────────────────────────────────────────────────────
  // 2. Verificar resultado del clic
  // ────────────────────────────────────────────────────────────────────────
  if (!resultadoClic || resultadoClic.error) {
    log('error', ctx, `Error: ${resultadoClic ? resultadoClic.error : 'resultado null'}`);
    return { exito: false, error: resultadoClic ? resultadoClic.error : 'Error desconocido (frame en transición)' };
  }

  log('info', ctx, `Clic realizado (método: ${resultadoClic.metodo}, id: ${resultadoClic.botonId}, data-ri real: ${resultadoClic.dataRiReal})`);

  // ────────────────────────────────────────────────────────────────────────
  // 3. Esperar que aparezca el modal
  // ────────────────────────────────────────────────────────────────────────
  await delay(CONFIG_EXTRACCION.esperaPostClic);

  const inicio = Date.now();
  let modalAbierto = false;

  while (Date.now() - inicio < CONFIG_EXTRACCION.timeoutModal) {

    const estadoModal = await evaluarSeguro(page, (selectores) => {
      // Buscar modal visible
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

    await delay(300);
  }

  if (!modalAbierto) {
    log('warn', ctx, 'Modal no se abrió después del clic');
    return { exito: false, error: 'Modal no se abrió (timeout)' };
  }

  return { exito: true };
}

// ════════════════════════════════════════════════════════════════════════════════
// PASO 15.2: DESCARGAR CONSOLIDADO COMO BASE64
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Descarga el PDF consolidado desde el modal de anexos abierto.
 *
 * ESTRATEGIA DE CAPTURA:
 *   1. Buscar el botón/link "Consolidado" (o "btnDescargaTodo")
 *   2. Si es un <a> con href → capturar vía fetch() dentro del navegador
 *   3. Si es un <button> que dispara AJAX → interceptar response con
 *      page.on('response') y capturar el PDF vía response.buffer()
 *   4. Retornar el PDF como base64 crudo (sin prefijo data:)
 *
 * @param {Page}   page      - Instancia de Puppeteer page
 * @param {string} requestId - ID único para logs
 * @returns {Promise<{exito: boolean, base64?: string, nombre?: string, error?: string}>}
 */
async function descargarConsolidado(page, requestId) {
  const ctx = `DESCARGA:${requestId}`;

  log('info', ctx, 'Buscando botón Consolidado y descargando PDF...');

  // ────────────────────────────────────────────────────────────────────────
  // 1. Localizar el botón Consolidado y obtener su información
  // ────────────────────────────────────────────────────────────────────────
  const infoBoton = await evaluarSeguro(page, (selectores) => {

    // ── Buscar el modal visible ──
    let modal = null;
    for (const sel of selectores.modal.contenedor) {
      const m = document.querySelector(sel);
      if (m && m.getAttribute('aria-hidden') !== 'true') {
        modal = m;
        break;
      }
    }

    if (!modal) {
      modal = document.querySelector('.ui-dialog[aria-hidden="false"]');
    }

    const contenedor = modal || document;
    let boton = null;
    let metodo = '';

    // ── Estrategia 1: Por ID que contenga "btnDescargaTodo" ──
    boton = contenedor.querySelector('[id*="btnDescargaTodo"]');
    if (boton) metodo = 'id_btnDescargaTodo';

    // ── Estrategia 2: Por ID que contenga "DescargaTodo" ──
    if (!boton) {
      boton = contenedor.querySelector('[id*="DescargaTodo"]');
      if (boton) metodo = 'id_DescargaTodo';
    }

    // ── Estrategia 3: Por texto "Consolidado" ──
    if (!boton) {
      const botones = contenedor.querySelectorAll('button, a.ui-commandlink, a[href]');
      for (const btn of botones) {
        const texto = (btn.textContent || '').toLowerCase();
        if (texto.includes('consolidado')) {
          boton = btn;
          metodo = 'texto_consolidado';
          break;
        }
      }
    }

    // ── Estrategia 4: Por ícono de descarga ──
    if (!boton) {
      const iconoDesc = contenedor.querySelector('.ui-icon-arrowthickstop-1-s');
      if (iconoDesc) {
        boton = iconoDesc.closest('button') || iconoDesc.closest('a');
        if (boton) metodo = 'icono_descarga';
      }
    }

    // ── Estrategia 5: Primer botón en el fieldset del modal ──
    if (!boton && modal) {
      const fieldset = modal.querySelector('fieldset');
      if (fieldset) {
        const primerBoton = fieldset.querySelector('button');
        if (primerBoton) {
          boton = primerBoton;
          metodo = 'primer_boton_fieldset';
        }
      }
    }

    if (!boton) {
      const todosBotones = contenedor.querySelectorAll('button');
      const listaBotones = Array.from(todosBotones).map(b => ({
        id: b.id || '(sin id)',
        texto: (b.textContent || '').substring(0, 40),
        tag: b.tagName
      }));

      return {
        error: 'Botón Consolidado no encontrado',
        botonesDisponibles: listaBotones
      };
    }

    // ── Determinar tipo de botón y si tiene href directo ──
    const tag = boton.tagName.toUpperCase();
    const href = boton.href || boton.getAttribute('href') || '';
    const tieneHref = href && href.length > 10 && !href.startsWith('javascript:');
    const botonId = boton.id || '';

    return {
      encontrado: true,
      metodo: metodo,
      tag: tag,
      botonId: botonId,
      tieneHref: tieneHref,
      href: tieneHref ? href : null,
      botonTexto: (boton.textContent || '').substring(0, 50)
    };

  }, SELECTORES);

  if (!infoBoton || infoBoton.error) {
    log('error', ctx, `Error: ${infoBoton ? infoBoton.error : 'resultado null'}`);
    if (infoBoton && infoBoton.botonesDisponibles) {
      log('info', ctx, 'Botones disponibles:', JSON.stringify(infoBoton.botonesDisponibles));
    }
    return { exito: false, error: infoBoton ? infoBoton.error : 'Error desconocido' };
  }

  log('info', ctx, `Botón encontrado (método: ${infoBoton.metodo}, tag: ${infoBoton.tag}, id: ${infoBoton.botonId})`);

  // ────────────────────────────────────────────────────────────────────────
  // 2. Capturar el PDF como base64
  // ────────────────────────────────────────────────────────────────────────

  let base64Pdf = null;

  // ── MÉTODO A: Si el botón es un <a> con href directo → fetch() en el navegador ──
  if (infoBoton.tieneHref) {
    log('info', ctx, `Descargando PDF vía fetch() del href...`);

    base64Pdf = await evaluarSeguro(page, async (href, timeoutMs) => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(href, {
          credentials: 'include',
          signal: controller.signal
        });

        clearTimeout(timer);

        if (!response.ok) {
          return { error: `HTTP ${response.status}` };
        }

        const blob = await response.blob();

        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => {
            const resultado = reader.result;
            // Extraer base64 puro (sin prefijo "data:application/pdf;base64,")
            const coma = resultado.indexOf(',');
            const base64 = coma >= 0 ? resultado.substring(coma + 1) : resultado;
            resolve({ base64: base64, size: base64.length });
          };
          reader.onerror = () => resolve({ error: 'FileReader error' });
          reader.readAsDataURL(blob);
        });
      } catch (e) {
        return { error: e.message };
      }
    }, infoBoton.href, CONFIG_EXTRACCION.timeoutDescargaPdf);

    if (base64Pdf && base64Pdf.base64) {
      log('success', ctx, `✓ PDF capturado vía href (${Math.round(base64Pdf.base64.length / 1024)}KB base64)`);
      return {
        exito: true,
        base64: base64Pdf.base64,
        nombre: 'Consolidado.pdf'
      };
    }

    log('warn', ctx, `fetch() por href falló: ${base64Pdf ? base64Pdf.error : 'null'} — intentando método B`);
  }

  // ── MÉTODO B: Interceptar la respuesta HTTP tras hacer clic en el botón ──
  log('info', ctx, 'Descargando PDF vía intercepción de response...');

  let pdfCapturedResolve;
  const pdfCapturedPromise = new Promise((resolve) => {
    pdfCapturedResolve = resolve;
  });

  // Timeout de seguridad
  const timeoutId = setTimeout(() => {
    pdfCapturedResolve(null);
  }, CONFIG_EXTRACCION.timeoutDescargaPdf);

  // Listener para interceptar la respuesta PDF
  const responseHandler = async (response) => {
    try {
      const contentType = response.headers()['content-type'] || '';
      const url = response.url();

      // Detectar si es un PDF
      if (contentType.includes('application/pdf') ||
          contentType.includes('application/octet-stream') ||
          url.includes('.pdf') ||
          url.includes('download') ||
          url.includes('Consolidado') ||
          url.includes('DescargaTodo')) {

        const buffer = await response.buffer();
        if (buffer && buffer.length > 100) { // PDF válido tiene más de 100 bytes
          const base64 = buffer.toString('base64');
          clearTimeout(timeoutId);
          pdfCapturedResolve({ base64: base64, size: base64.length, url: url });
        }
      }
    } catch (e) {
      // Ignorar errores de responses que no nos interesan
    }
  };

  page.on('response', responseHandler);

  // ⭐ FIX CRÍTICO: Delay de 1000ms para que el listener se registre completamente
  // Esto resuelve el race condition donde el PDF pasa antes de que el listener esté activo
  log('info', ctx, '⭐ Esperando 1000ms para registro de listener (fix race condition)...');
  await delay(1000);

  // Hacer clic en el botón Consolidado
  const clicOk = await evaluarSeguro(page, (botonId) => {
    let boton = null;

    // Re-localizar el botón por ID
    if (botonId) {
      boton = document.getElementById(botonId);
    }

    // Si no se encontró por ID, volver a buscar
    if (!boton) {
      const contenedor = document.querySelector('.ui-dialog[aria-hidden="false"]') || document;

      boton = contenedor.querySelector('[id*="btnDescargaTodo"]') ||
              contenedor.querySelector('[id*="DescargaTodo"]');

      if (!boton) {
        const botones = contenedor.querySelectorAll('button, a.ui-commandlink');
        for (const btn of botones) {
          if ((btn.textContent || '').toLowerCase().includes('consolidado')) {
            boton = btn;
            break;
          }
        }
      }
    }

    if (!boton) {
      return { error: 'No se pudo re-localizar el botón' };
    }

    try {
      if (typeof jQuery !== 'undefined' && jQuery(boton).length) {
        jQuery(boton).trigger('click');
      } else {
        boton.click();
      }
      return { exito: true };
    } catch (e) {
      return { error: `Clic fallido: ${e.message}` };
    }
  }, infoBoton.botonId);

  if (!clicOk || clicOk.error) {
    page.removeListener('response', responseHandler);
    clearTimeout(timeoutId);
    log('error', ctx, `Error haciendo clic en Consolidado: ${clicOk ? clicOk.error : 'null'}`);
    return { exito: false, error: clicOk ? clicOk.error : 'Error desconocido' };
  }

  log('info', ctx, 'Clic en Consolidado realizado, esperando respuesta PDF...');

  // Esperar la captura del PDF
  const pdfResult = await pdfCapturedPromise;
  page.removeListener('response', responseHandler);

  if (pdfResult && pdfResult.base64) {
    log('success', ctx, `✓ PDF interceptado (${Math.round(pdfResult.base64.length / 1024)}KB base64)`);
    return {
      exito: true,
      base64: pdfResult.base64,
      nombre: 'Consolidado.pdf'
    };
  }

  // ── MÉTODO C (último recurso): Solo confirmar clic, sin PDF base64 ──
  // Esto replica el comportamiento original v2 como fallback
  log('warn', ctx, 'No se pudo interceptar el PDF — el clic se realizó pero no hay base64');
  await delay(CONFIG_EXTRACCION.esperaDescarga);

  return {
    exito: true,
    base64: null,
    nombre: null,
    advertencia: 'PDF no capturado como base64 (descarga iniciada pero no interceptada)'
  };
}

// ════════════════════════════════════════════════════════════════════════════════
// PASO 15.3: CERRAR MODAL
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Cierra el modal de anexos.
 * Intenta múltiples estrategias: botón X, botón Cerrar, tecla Escape.
 *
 * @param {Page}   page      - Instancia de Puppeteer page
 * @param {string} requestId - ID único para logs
 * @returns {Promise<boolean>} true si se cerró exitosamente
 */
async function cerrarModal(page, requestId) {
  const ctx = `CERRAR:${requestId}`;

  try {
    // ⭐ FIX: Validar que la sesión siga activa antes de intentar cerrar
    if (!page || page.isClosed()) {
      log('warn', ctx, 'Página ya cerrada, modal no necesita cerrarse');
      return true; // Considerar exitoso porque el modal ya no existe
    }

    // ────────────────────────────────────────────────────────────────────────
    // 1. Intentar cerrar con botón
    // ────────────────────────────────────────────────────────────────────────
  const cerrado = await evaluarSeguro(page, (selectores) => {

    // Buscar modal visible
    let modal = document.querySelector('.ui-dialog[aria-hidden="false"]');

    if (!modal) {
      for (const sel of selectores.modal.contenedor) {
        modal = document.querySelector(sel);
        if (modal && modal.getAttribute('aria-hidden') !== 'true') break;
        modal = null;
      }
    }

    if (!modal) {
      return { noHayModal: true };
    }

    // ── Estrategia 1: Botón X en la esquina ──
    const botonX = modal.querySelector('.ui-dialog-titlebar-close');
    if (botonX) {
      try {
        if (typeof jQuery !== 'undefined') {
          jQuery(botonX).trigger('click');
        } else {
          botonX.click();
        }
        return { exito: true, metodo: 'boton_X' };
      } catch (e) {
        // Continuar con siguiente estrategia si falla
      }
    }

    // ── Estrategia 2: Botón "Cerrar" en el footer ──
    const botones = modal.querySelectorAll('button, a.ui-commandlink');
    for (const btn of botones) {
      const texto = (btn.textContent || '').toLowerCase();
      if (texto.includes('cerrar') || texto.includes('close')) {
        try {
          if (typeof jQuery !== 'undefined') {
            jQuery(btn).trigger('click');
          } else {
            btn.click();
          }
          return { exito: true, metodo: 'boton_cerrar' };
        } catch (e) {
          // Continuar con siguiente botón si falla
        }
      }
    }

    return { exito: false, metodo: 'ninguno' };

  }, SELECTORES);

  // ────────────────────────────────────────────────────────────────────────
  // 2. Verificar resultado
  // ────────────────────────────────────────────────────────────────────────
  if (cerrado && cerrado.noHayModal) {
    log('info', ctx, 'No hay modal abierto');
    return true;
  }

  if (cerrado && cerrado.exito) {
    log('info', ctx, `Modal cerrado (método: ${cerrado.metodo})`);
    await delay(500);
    return true;
  }

  // ────────────────────────────────────────────────────────────────────────
  // 3. Fallback: Tecla Escape
  // ────────────────────────────────────────────────────────────────────────
  
  // ⭐ FIX: Verificar sesión antes de usar keyboard
  if (page.isClosed()) {
    log('warn', ctx, 'Página cerrada antes de Escape, asumiendo modal cerrado');
    return true;
  }
  
  try {
    await page.keyboard.press('Escape');
    log('info', ctx, 'Modal cerrado (Escape)');
    await delay(500);
    return true;
  } catch (e) {
    // ⭐ FIX: Manejar específicamente error de sesión cerrada
    if (e.message && (
        e.message.includes('Session closed') ||
        e.message.includes('Target closed') ||
        e.message.includes('Protocol error'))) {
      log('warn', ctx, 'Sesión cerrada durante cierre de modal (ignorar - modal ya no existe)');
      return true; // Considerar exitoso
    }
    
    log('warn', ctx, `Error cerrando modal: ${e.message}`);
    return false;
  }
  
  } catch (error) {
    // ⭐ NUEVO: Catch global para errores inesperados
    if (error.message && (
        error.message.includes('Session closed') ||
        error.message.includes('Target closed'))) {
      log('warn', ctx, 'Sesión cerrada (catch global) - asumiendo modal cerrado');
      return true;
    }
    
    log('error', ctx, `Error inesperado: ${error.message}`);
    return false;
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// PASO 15.4: PROCESAR TODAS LAS NOTIFICACIONES
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Procesa todas las notificaciones: abre modal, descarga PDF, cierra modal.
 *
 * FIX v3.0.0 — CAMBIO CRÍTICO:
 *   Después de cerrar cada modal, PrimeFaces hace un AJAX update que
 *   destruye y recrea las filas de la tabla (tr[data-ri]). El código
 *   ahora llama a esperarTablaCargada() para esperar que la tabla se
 *   reconstruya ANTES de intentar abrir el siguiente modal.
 *
 *   Además, las filas se re-localizan por N° Notificación (no por
 *   data-ri) porque PrimeFaces puede reasignar los data-ri.
 *
 * @param {Page}   page            - Instancia de Puppeteer page
 * @param {Array}  notificaciones  - Lista de notificaciones extraídas
 * @param {string} requestId       - ID único para logs
 * @returns {Promise<{exitosas: number, fallidas: number, detalles: Array}>}
 */
async function procesarNotificaciones(page, notificaciones, requestId) {
  const ctx = `PROC:${requestId}`;

  const resultado = {
    exitosas: 0,
    fallidas: 0,
    parciales: 0,    // Clic OK pero sin base64 (Método C)
    detalles: []
  };

  const total = notificaciones.length;

  log('info', ctx, `════════════════════════════════════════════════════`);
  log('info', ctx, `Iniciando procesamiento de ${total} notificaciones...`);
  log('info', ctx, `════════════════════════════════════════════════════`);

  // Detectar si hay notificaciones multi-página
  const tieneMultiPagina = notificaciones.some(n => (n._pagina || 1) > 1);
  let paginaActualTabla = 1; // Rastrear en qué página está la tabla actualmente

  if (tieneMultiPagina) {
    log('info', ctx, `Notificaciones multi-página detectadas — se navegará entre páginas`);
  }

  for (let i = 0; i < total; i++) {
    const notif = notificaciones[i];
    const dataRi = notif.dataRi || notif.indice || i;
    const numNotif = notif.numNotificacion || notif.numeroNotificacion || '';
    const paginaNotif = notif._pagina || 1;
    const progreso = `[${i + 1}/${total}]`;

    log('info', ctx, `${progreso} Procesando: Exp. ${notif.expediente || '?'} | Notif. ${numNotif} | Pág. ${paginaNotif}`);

    const detalle = {
      indice: i,
      dataRi: dataRi,
      expediente: notif.expediente,
      numeroNotificacion: numNotif,
      exito: false,
      error: null
    };

    try {
      // ── 0. Navegar a la página correcta si es necesario ──
      if (paginaNotif !== paginaActualTabla) {
        log('info', ctx, `${progreso} Navegando de página ${paginaActualTabla} a página ${paginaNotif}...`);
        const navegoOk = await navegarAPagina(page, paginaNotif, requestId);
        if (navegoOk) {
          paginaActualTabla = paginaNotif;
        } else {
          log('warn', ctx, `${progreso} No se pudo navegar a página ${paginaNotif} — intentando de todas formas`);
        }
      }

      // ── 1. Abrir modal de anexos (con re-localización por N° Notificación) ──
      const modalResult = await abrirModalAnexos(page, dataRi, requestId, numNotif);

      if (!modalResult.exito) {
        detalle.error = modalResult.error || 'No se pudo abrir modal';
        log('warn', ctx, `${progreso} ✗ ${detalle.error}`);
        resultado.fallidas++;
        resultado.detalles.push(detalle);

        // ── Limpieza defensiva: el clic PrimeFaces pudo haber disparado ──
        // ── un AJAX aunque el modal no se detectó. Cerrar modal zombie   ──
        // ── y esperar que la tabla se estabilice antes de continuar.     ──
        try {
          await cerrarModal(page, requestId);
          await delay(CONFIG_EXTRACCION.pausaEntreNotificaciones);
          await esperarTablaCargada(page, requestId);
        } catch (cleanupError) {
          // Ignorar — es limpieza defensiva
        }

        continue;
      }

      // ── 2. Descargar PDF Consolidado como base64 ──
      const descargaResult = await descargarConsolidado(page, requestId);

      if (!descargaResult.exito) {
        detalle.error = descargaResult.error || 'No se pudo descargar';
        log('warn', ctx, `${progreso} ✗ ${detalle.error}`);
        resultado.fallidas++;
      } else {
        // Guardar PDF en el objeto de la notificación
        if (descargaResult.base64) {
          notif.pdf = descargaResult.base64;
          notif.archivo = descargaResult.base64;
          notif.nombreArchivo = `${(numNotif || 'doc').replace(/\//g, '_')}_Consolidado.pdf`;
          notif.descargado = true;
          detalle.exito = true;
          resultado.exitosas++;
          log('success', ctx, `${progreso} ✓ PDF descargado (${Math.round(descargaResult.base64.length / 1024)}KB)`);
        } else {
          // Clic exitoso pero sin base64 (Método C fallback)
          notif.descargado = false;
          notif.nombreArchivo = `${(numNotif || 'doc').replace(/\//g, '_')}_Consolidado.pdf`;
          detalle.exito = true;
          detalle.sinBase64 = true;
          resultado.parciales++;
          log('warn', ctx, `${progreso} ⚠ Clic en Consolidado OK pero PDF no capturado como base64`);
        }
      }

      // ── 3. Cerrar modal ──
      await cerrarModal(page, requestId);

      // ══════════════════════════════════════════════════════════════════
      // ██ FIX CRÍTICO v3.0.0: Esperar que PrimeFaces recargue la tabla
      // ══════════════════════════════════════════════════════════════════
      //
      // Después de cerrar el modal, PrimeFaces hace un AJAX update que
      // DESTRUYE y RECREA todas las filas de la tabla. Si intentamos
      // abrir el siguiente modal sin esperar, el DOM está en transición
      // y evaluarSeguro() retorna null → "resultado null".
      //
      // Este era el bug original que causaba que solo la 1ra descarga
      // funcionara y las 2-7 fallaran.
      // ══════════════════════════════════════════════════════════════════
      if (i < total - 1) {
        await delay(CONFIG_EXTRACCION.pausaEntreNotificaciones);

        // Esperar que la tabla se reconstruya antes de tocar la siguiente fila
        const recarga = await esperarTablaCargada(page, requestId);

        if (!recarga.cargada) {
          log('warn', ctx, `${progreso} Tabla no recargó después de cerrar modal, esperando extra...`);
          await delay(3000);

          // Segundo intento
          const recarga2 = await esperarTablaCargada(page, requestId);
          if (!recarga2.cargada) {
            log('error', ctx, `${progreso} Tabla sigue sin cargar — las siguientes notificaciones pueden fallar`);
          }
        }
      }

    } catch (error) {
      detalle.error = error.message;
      log('error', ctx, `${progreso} ✗ Error: ${error.message}`);
      resultado.fallidas++;

      // Intentar cerrar modal si quedó abierto
      try {
        await cerrarModal(page, requestId);
      } catch (closeError) {
        // Ignorar error al cerrar — ya estamos en manejo de error
      }

      // Intentar recuperar la tabla
      try {
        await delay(2000);
        await esperarTablaCargada(page, requestId);
      } catch (recoverError) {
        // Ignorar
      }
    }

    resultado.detalles.push(detalle);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Resumen final
  // ────────────────────────────────────────────────────────────────────────
  log('info', ctx, `════════════════════════════════════════════════════`);
  log('info', ctx, `RESUMEN: ${resultado.exitosas} exitosas, ${resultado.parciales} parciales, ${resultado.fallidas} fallidas de ${total}`);
  log('info', ctx, `════════════════════════════════════════════════════`);

  return resultado;
}

// ════════════════════════════════════════════════════════════════════════════════
// PAGINACIÓN
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Verifica si hay más páginas de notificaciones y retorna info de paginación.
 *
 * @param {Page}   page      - Instancia de Puppeteer page
 * @param {string} requestId - ID único para logs
 * @returns {Promise<{hayMas: boolean, paginaActual: number, totalPaginas: number}>}
 */
async function verificarPaginacion(page, requestId) {
  const ctx = `PAGIN:${requestId}`;

  const info = await evaluarSeguro(page, (selectores) => {
    const paginador = document.querySelector(selectores.paginacion.contenedor);

    if (!paginador) {
      return { hayMas: false, paginaActual: 1, totalPaginas: 1 };
    }

    // Intentar extraer de texto tipo "Registros: 26 - [ Página : 1/2 ]"
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

    // Verificar si existe botón "siguiente" habilitado
    const botonSiguiente = paginador.querySelector(selectores.paginacion.siguiente);

    // Contar páginas por número de links de página
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

/**
 * Navega a la siguiente página de resultados de la tabla.
 * Hace clic en el botón de página siguiente y espera recarga AJAX.
 *
 * @param {Page}   page      - Instancia de Puppeteer page
 * @param {string} requestId - ID único para logs
 * @returns {Promise<boolean>} true si se navegó exitosamente
 */
async function navegarPaginaSiguiente(page, requestId) {
  const ctx = `PAGIN:${requestId}`;

  log('info', ctx, 'Navegando a la siguiente página...');

  // ── Hacer clic en el botón de página siguiente ──
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

  // ── Esperar recarga AJAX de la tabla ──
  await delay(CONFIG_EXTRACCION.esperaPostClic);
  const recarga = await esperarTablaCargada(page, requestId);

  if (!recarga.cargada || !recarga.tieneFilas) {
    log('warn', ctx, 'Tabla no se recargó correctamente después de paginar');
    return false;
  }

  log('success', ctx, `✓ Página siguiente cargada — ${recarga.cantidadFilas} filas`);
  return true;
}

/**
 * Navega a una página específica del paginador.
 * Útil para volver a la página 1 después de extraer todas las páginas.
 *
 * @param {Page}   page           - Instancia de Puppeteer page
 * @param {number} numeroPagina   - Número de página destino (1-based)
 * @param {string} requestId      - ID único para logs
 * @returns {Promise<boolean>} true si se navegó exitosamente
 */
async function navegarAPagina(page, numeroPagina, requestId) {
  const ctx = `PAGIN:${requestId}`;

  log('info', ctx, `Navegando a página ${numeroPagina}...`);

  // Verificar si ya estamos en la página correcta
  const infoActual = await verificarPaginacion(page, requestId);
  if (infoActual.paginaActual === numeroPagina) {
    log('info', ctx, `Ya estamos en la página ${numeroPagina}`);
    return true;
  }

  // Hacer clic en el número de página específico
  const clicOk = await evaluarSeguro(page, (selectores, numPag) => {
    const paginador = document.querySelector(selectores.paginacion.contenedor);
    if (!paginador) return { error: 'Paginador no encontrado' };

    // Buscar el link de la página específica
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

    // Si no encontró el número, intentar navegar con botón "anterior" repetidamente
    // (para volver a página 1 desde cualquier página)
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

  // Esperar recarga AJAX
  await delay(CONFIG_EXTRACCION.esperaPostClic);
  const recarga = await esperarTablaCargada(page, requestId);

  if (!recarga.cargada) {
    log('warn', ctx, `Tabla no se recargó después de navegar a página ${numeroPagina}`);
    return false;
  }

  log('success', ctx, `✓ Página ${numeroPagina} cargada — ${recarga.cantidadFilas} filas`);
  return true;
}

// ════════════════════════════════════════════════════════════════════════════════
// UTILIDADES ADICIONALES
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Captura un screenshot de la página actual.
 * Útil para debug cuando algo falla.
 *
 * @param {Page}   page      - Instancia de Puppeteer page
 * @param {string} requestId - ID único para logs
 * @returns {Promise<string|null>} Screenshot en base64 o null si falla
 */
async function capturarPantallaCasillas(page, requestId) {
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
// EXPORTACIONES — v5.5.0 ACTUALIZADA
// ════════════════════════════════════════════════════════════════════════════════

module.exports = {
  // ── Paso 14: Filtrado + Extracción ──
  filtrarBandejaPorFecha,
  esperarTablaCargada,
  verificarEstadoTablaActual,  // ⬅️ NUEVO v5.5.0
  extraerNotificaciones,
  diagnosticarPaginaCasillas,

  // ── Paso 15: Modal + Descarga ──
  abrirModalAnexos,
  descargarConsolidado,
  cerrarModal,
  procesarNotificaciones,

  // ── Utilidades ──
  capturarPantallaCasillas,
  verificarPaginacion,
  navegarPaginaSiguiente,
  navegarAPagina,

  // ── Configuración (para modificar externamente si es necesario) ──
  SELECTORES,
  COLUMNAS,
  CONFIG_EXTRACCION
};
