/**
 * ════════════════════════════════════════════════════════════════════════════════
 * LEXA SCRAPER — EXTRACCIÓN v7.2.0
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * Autor:   LEXA Assistant (CTO)
 * Fecha:   Febrero 2026
 *
 * Changelog:
 *   v7.2.0  — AUDITORÍA SENIOR COMPLETA
 *     • FIX-001: verificarSaludPagina — enCasillas ahora se evalúa desde URL
 *       incluso con contexto JS muerto (antes retornaba false y recovery
 *       nunca intentaba reload porque creía que no estábamos en casillas)
 *     • FIX-002/003: recuperarPaginaCasillas — popup close ahora scoped a
 *       diálogos PrimeFaces (antes hacía querySelector en TODA la página,
 *       podía hacer clic en botones de navegación reales, NO solo popups).
 *       + Detección de sesión expirada (redirect a login después de reload)
 *     • FIX-004: procesarNotificaciones — paginaActualTabla se resetea a 1
 *       después de recovery (reload/goto siempre vuelve a pág 1, pero el
 *       tracker seguía en la página anterior → navegarAPagina fallaba)
 *     • FIX-005: abrirModalAnexos — modal detection filtra diálogos de
 *       error/confirmación (antes confundía un diálogo de "Error" con el
 *       modal de anexos y reportaba "modal abierto" cuando no lo estaba)
 *     • FIX-006: cerrarModal — reescrita con indentación correcta y estructura
 *       try/catch limpia (antes tenía indentación de 2 espacios dentro de un
 *       bloque de 4, y un try/catch anidado confuso)
 *     • FIX-008: procesarNotificaciones — corregido double-count de fallidas:
 *       si descarga fallaba (fallidas++) y luego cerrarModal/tableWait lanzaba
 *       error, el catch global hacía fallidas++ DE NUEVO. Peor: si descarga
 *       era exitosa (exitosas++) y cerrarModal lanzaba, se contaban AMBAS.
 *       Ahora usa flag yaContado + try/catch interno para limpieza
 *
 *   v7.1.0  — FIX CASCADA DE FALLOS EN MODALES
 *     • FIX BUG-CASCADE-001: Detección de página muerta (evaluarSeguro=null)
 *     • FIX BUG-CASCADE-002: Recovery automático (reload/navegación a casillas)
 *     • FIX BUG-CASCADE-003: Verificación de salud ANTES de esperar tabla
 *       (evita 25s de timeout inútil en página muerta)
 *     • FIX BUG-MODAL-001: timeoutModal 15s → 25s (SINOE puede ser lento)
 *     • NUEVO: verificarSaludPagina() — detecta contexto JS muerto
 *     • NUEVO: recuperarPaginaCasillas() — reload o navegación directa
 *     • NUEVO: Contador de fallos consecutivos con auto-recovery
 *     • NUEVO: Abort automático después de N recuperaciones fallidas
 *
 *   v7.0.0  — FIX CRÍTICO: DESCARGA CROSS-CONTAINER
 *     • FIX BUG FATAL: lexa-scraper y browserless son contenedores Docker
 *       separados. CDP Browser.downloadProgress descargaba al filesystem
 *       de browserless, pero el scraper intentaba leer de su propio
 *       filesystem → ENOENT siempre.
 *     • NUEVA ESTRATEGIA: CDP Fetch domain (intercepta response en memoria)
 *       - Fetch.enable intercepta responses HTTP en fase Response
 *       - Fetch.getResponseBody obtiene el PDF como base64 directo
 *       - CERO operaciones de filesystem (no necesita fs, path, crypto)
 *       - Funciona sin importar la arquitectura de contenedores
 *     • Eliminadas dependencias: fs, path, crypto (ya no se necesitan)
 *     • Timeout 60s mantenido para PDFs grandes
 *     • Validación magic number %PDF mantenida
 *
 *   v5.5.0  — AUDITORÍA SENIOR — FIX CRÍTICO "0 NOTIFICACIONES"
 *     • FIX BUG-007: Verificación de tabla antes de aplicar filtro
 *     • FIX BUG-008: tiempoEstabilidadDom aumentado a 1500ms
 *
 *   v3.0.0  — Reescritura completa
 *     • FIX: esperarTablaCargada() después de cerrarModal()
 *     • NUEVO: Paginación completa
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
  timeoutModal: 25000,  // ⬆️ v7.1.0: 25s (era 15s — SINOE puede ser MUY lento)

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
  maxPaginas: 20,

  // ⭐ v7.1.0: Configuración de recuperación
  // Máximo de fallos consecutivos antes de intentar recuperar la página
  maxFallosConsecutivos: 2,

  // Máximo de recuperaciones antes de abortar
  maxRecuperaciones: 2,

  // URL de la bandeja de casillas (para navegación de recovery)
  urlCasillas: 'https://casillas.pj.gob.pe/sinoe/pages/casillas/notificaciones/notificacion-bandeja.xhtml',

  // Timeout para recovery navigation
  timeoutRecovery: 30000
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
            const tituloTexto = titulo ? titulo.textContent.trim() : '';

            // ⭐ FIX-005 v7.2.0: Si es un selector genérico (.ui-dialog), verificar
            // que el título contenga algo relevante a anexos/lista. Si es un diálogo
            // de error o confirmación, NO es nuestro modal.
            if (sel === '.ui-dialog[aria-hidden="false"]') {
              const tituloLower = tituloTexto.toLowerCase();
              const esDialogoError = tituloLower.includes('error') ||
                                     tituloLower.includes('mensaje') ||
                                     tituloLower.includes('confirmación') ||
                                     tituloLower.includes('aviso');
              if (esDialogoError) {
                // Es un diálogo de error/sistema, no el modal de anexos
                return { visible: false, esDialogoError: true, titulo: tituloTexto };
              }
            }

            return {
              visible: true,
              titulo: tituloTexto.substring(0, 100)
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
// PASO 15.2: DESCARGAR CONSOLIDADO CON CDP FETCH (v7.0.0)
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Descarga el PDF consolidado usando CDP Fetch domain.
 *
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │  v7.0.0 — CAMBIO ARQUITECTÓNICO CRÍTICO                                    │
 * │                                                                            │
 * │  PROBLEMA: lexa-scraper y browserless son contenedores Docker separados.   │
 * │  La v6.x usaba Browser.setDownloadBehavior que descargaba al filesystem    │
 * │  de browserless. El scraper intentaba leer de SU filesystem → ENOENT.     │
 * │                                                                            │
 * │  SOLUCIÓN: CDP Fetch domain intercepta el HTTP response ANTES de que       │
 * │  Chrome lo procese como descarga. Fetch.getResponseBody obtiene el PDF     │
 * │  como base64 directamente en memoria. CERO operaciones de filesystem.     │
 * │  Funciona sin importar dónde estén los contenedores.                      │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *
 * FLUJO:
 *   1. Buscar botón "Consolidado" en el modal
 *   2. Crear CDP session + habilitar Fetch interceptación en fase Response
 *   3. Clic en Consolidado → SINOE envía POST con PDF como attachment
 *   4. Fetch.requestPaused detecta Content-Disposition: attachment
 *   5. Fetch.getResponseBody obtiene el PDF como base64 en memoria
 *   6. Fetch.fulfillRequest deja pasar el response al browser
 *   7. Retornar base64 directamente (sin tocar disco)
 *
 * @param {Page}   page      - Instancia de Puppeteer page
 * @param {string} requestId - ID único para logs
 * @returns {Promise<{exito: boolean, base64?: string, nombre?: string, error?: string}>}
 */
async function descargarConsolidado(page, requestId) {
  const ctx = `DESCARGA:${requestId}`;

  let cdpSession = null;
  let downloadTimeout = null;
  let fetchHandler = null;
  let fetchEnabled = false;

  try {
    log('info', ctx, 'Buscando botón Consolidado...');

    // ────────────────────────────────────────────────────────────────────────
    // PASO 1: Localizar el botón Consolidado
    // ────────────────────────────────────────────────────────────────────────
    const infoBoton = await evaluarSeguro(page, (selectores) => {
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

      // Buscar botón por ID
      boton = contenedor.querySelector('[id*="btnDescargaTodo"]');
      if (boton) metodo = 'id_btnDescargaTodo';

      if (!boton) {
        boton = contenedor.querySelector('[id*="DescargaTodo"]');
        if (boton) metodo = 'id_DescargaTodo';
      }

      // Buscar por texto
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

      if (!boton) {
        return { error: 'Botón Consolidado no encontrado' };
      }

      return {
        encontrado: true,
        metodo: metodo,
        botonId: boton.id || '',
        botonTexto: (boton.textContent || '').substring(0, 50)
      };
    }, SELECTORES);

    if (!infoBoton || infoBoton.error) {
      log('error', ctx, infoBoton ? infoBoton.error : 'Error buscando botón');
      return { exito: false, error: infoBoton ? infoBoton.error : 'Error desconocido' };
    }

    log('info', ctx, `Botón encontrado: ${infoBoton.metodo} (${infoBoton.botonId})`);

    // ────────────────────────────────────────────────────────────────────────
    // PASO 2: Configurar CDP Fetch para interceptar response HTTP
    // ────────────────────────────────────────────────────────────────────────

    cdpSession = await page.target().createCDPSession();

    // Promise que se resolverá cuando capturemos el PDF
    const capturaPromise = new Promise((resolve, reject) => {

      // Timeout de 60s
      downloadTimeout = setTimeout(() => {
        reject(new Error('Timeout: PDF no capturado en 60s después del clic'));
      }, 60000);

      // Handler para responses interceptados por Fetch domain
      fetchHandler = async (event) => {
        const { requestId: fetchReqId, responseStatusCode, responseHeaders } = event;
        const headers = responseHeaders || [];

        // Buscar headers relevantes (case-insensitive)
        const contentDisp = headers.find(h => h.name.toLowerCase() === 'content-disposition');
        const contentType = headers.find(h => h.name.toLowerCase() === 'content-type');
        const contentTypeVal = (contentType && contentType.value) ? contentType.value.toLowerCase() : '';
        const contentDispVal = (contentDisp && contentDisp.value) ? contentDisp.value.toLowerCase() : '';

        // Detectar si es una descarga (PDF o attachment)
        const esDescarga =
          contentDispVal.includes('attachment') ||
          contentTypeVal.includes('application/pdf') ||
          contentTypeVal.includes('application/octet-stream') ||
          contentTypeVal.includes('application/force-download') ||
          contentTypeVal.includes('application/x-download');

        if (esDescarga && responseStatusCode === 200) {
          // ═══════════════════════════════════════════════════════════════
          // ¡PDF DETECTADO! Capturar el body directamente en memoria
          // ═══════════════════════════════════════════════════════════════
          log('info', ctx, `📥 PDF detectado en response HTTP`);
          log('info', ctx, `   Content-Type: ${contentTypeVal}`);
          log('info', ctx, `   Content-Disposition: ${contentDispVal}`);

          try {
            // Obtener el body del response (viene como base64 del CDP)
            const { body, base64Encoded } = await cdpSession.send('Fetch.getResponseBody', {
              requestId: fetchReqId
            });

            // Convertir a base64 si no lo es ya
            const pdfBase64 = base64Encoded
              ? body
              : Buffer.from(body, 'utf-8').toString('base64');

            // Calcular tamaño real del PDF
            const tamanoBytes = Math.round(pdfBase64.length * 0.75);
            log('success', ctx, `✅ PDF capturado en memoria: ${Math.round(tamanoBytes / 1024)}KB`);

            // Extraer nombre del archivo del Content-Disposition
            let pdfFileName = 'consolidado.pdf';
            if (contentDisp && contentDisp.value) {
              // Intentar filename*= (RFC 5987, con encoding)
              const matchStar = contentDisp.value.match(/filename\*=(?:UTF-8''|utf-8'')([^;\r\n]+)/i);
              if (matchStar) {
                pdfFileName = decodeURIComponent(matchStar[1].trim());
              } else {
                // Intentar filename= (simple)
                const matchSimple = contentDisp.value.match(/filename=["']?([^"';\r\n]+)/i);
                if (matchSimple) {
                  pdfFileName = matchSimple[1].trim().replace(/^"|"$/g, '');
                  // Decodificar si tiene encoding URL
                  try { pdfFileName = decodeURIComponent(pdfFileName); } catch (e) { /* ignorar */ }
                }
              }
            }
            log('info', ctx, `   Nombre: ${pdfFileName}`);

            // Dejar pasar el response original al browser (sin re-enviar body)
            await cdpSession.send('Fetch.continueResponse', {
              requestId: fetchReqId
            }).catch((continueErr) => {
              log('debug', ctx, `continueResponse falló (${continueErr.message}) — ignorar`);
            });

            // Limpiar timeout
            if (downloadTimeout) {
              clearTimeout(downloadTimeout);
              downloadTimeout = null;
            }

            resolve({
              base64: pdfBase64,
              fileName: pdfFileName,
              tamano: tamanoBytes
            });

          } catch (bodyError) {
            log('warn', ctx, `Error obteniendo body del response: ${bodyError.message}`);
            // Dejar pasar el response para no bloquear la página
            await cdpSession.send('Fetch.continueResponse', { requestId: fetchReqId }).catch(() => {});
            // NO rechazar la promise aquí — puede haber otro response que sí funcione
          }

        } else {
          // No es PDF — dejar pasar inmediatamente (CRÍTICO para no bloquear la página)
          await cdpSession.send('Fetch.continueResponse', { requestId: fetchReqId }).catch(() => {});
        }
      };

      // Registrar handler ANTES de habilitar Fetch
      cdpSession.on('Fetch.requestPaused', fetchHandler);
    });

    // Habilitar interceptación de responses HTTP
    // urlPattern '*' intercepta TODAS las responses (las no-PDF se pasan inmediatamente)
    await cdpSession.send('Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Response' }]
    });
    fetchEnabled = true;

    log('success', ctx, '✓ CDP Fetch configurado — interceptando responses HTTP');

    // ────────────────────────────────────────────────────────────────────────
    // PASO 3: Hacer clic en Consolidado
    // ────────────────────────────────────────────────────────────────────────

    log('info', ctx, 'Haciendo clic en Consolidado...');

    const clicOk = await evaluarSeguro(page, (botonId) => {
      let boton = null;

      if (botonId) {
        boton = document.getElementById(botonId);
      }

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
      throw new Error(clicOk ? clicOk.error : 'Error desconocido al hacer clic');
    }

    log('success', ctx, '✓ Clic realizado, esperando PDF en response HTTP...');

    // ────────────────────────────────────────────────────────────────────────
    // PASO 4: Esperar captura del PDF (máx 60s)
    // ────────────────────────────────────────────────────────────────────────

    const resultado = await capturaPromise;

    // ────────────────────────────────────────────────────────────────────────
    // PASO 5: Validar que es un PDF real (magic number %PDF)
    // ────────────────────────────────────────────────────────────────────────

    const pdfBuffer = Buffer.from(resultado.base64, 'base64');
    const magicNumber = pdfBuffer.toString('hex', 0, 4);

    if (magicNumber !== '25504446') { // %PDF en hex
      throw new Error(`Archivo capturado no es PDF válido (magic: ${magicNumber}, primeros bytes: "${pdfBuffer.toString('utf-8', 0, 20)}")`);
    }

    log('success', ctx, `✅ PDF validado: ${Math.round(pdfBuffer.length / 1024)}KB — ${resultado.fileName}`);

    return {
      exito: true,
      base64: resultado.base64,
      nombre: resultado.fileName,
      tamano: pdfBuffer.length
    };

  } catch (error) {
    // Limpiar timeout si hay error
    if (downloadTimeout) {
      clearTimeout(downloadTimeout);
      downloadTimeout = null;
      log('debug', ctx, 'Timeout cancelado debido a error');
    }

    log('error', ctx, `Error: ${error.message}`);

    return {
      exito: false,
      error: error.message
    };

  } finally {
    // Cleanup CDP: deshabilitar Fetch, remover handler, cerrar session
    if (cdpSession) {
      try {
        // Deshabilitar interceptación para no bloquear requests futuros
        if (fetchEnabled) {
          await cdpSession.send('Fetch.disable').catch(() => {});
        }

        // Remover handler
        if (fetchHandler) {
          cdpSession.off('Fetch.requestPaused', fetchHandler);
        }

        // Cerrar CDP session
        await cdpSession.detach();
        log('debug', ctx, 'CDP session cerrada y Fetch deshabilitado');
      } catch (e) {
        log('warn', ctx, `Error cerrando CDP: ${e.message}`);
      }
    }

    // Limpiar timeout final si quedó pendiente
    if (downloadTimeout) {
      clearTimeout(downloadTimeout);
      log('debug', ctx, 'Timeout final limpiado');
    }
  }
}


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
    // ⭐ FIX-006 v7.2.0: Reescrita con indentación y estructura correctas
    // Validar que la sesión siga activa antes de intentar cerrar
    if (!page || page.isClosed()) {
      log('warn', ctx, 'Página ya cerrada, modal no necesita cerrarse');
      return true;
    }

    // ────────────────────────────────────────────────────────────────────────
    // 1. Intentar cerrar con botón (evaluarSeguro en el contexto del browser)
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
          // Continuar con siguiente estrategia
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
            // Continuar con siguiente botón
          }
        }
      }

      return { exito: false, metodo: 'ninguno' };

    }, SELECTORES);

    // ────────────────────────────────────────────────────────────────────────
    // 2. Evaluar resultado del clic
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
    if (page.isClosed()) {
      log('warn', ctx, 'Página cerrada antes de Escape');
      return true;
    }

    await page.keyboard.press('Escape');
    log('info', ctx, 'Modal cerrado (Escape)');
    await delay(500);
    return true;

  } catch (error) {
    // Catch global: sesión cerrada = modal ya no existe
    const msg = error.message || '';
    if (msg.includes('Session closed') || msg.includes('Target closed') || msg.includes('Protocol error')) {
      log('warn', ctx, `Sesión cerrada durante cierre de modal: ${msg}`);
      return true;
    }

    log('error', ctx, `Error cerrando modal: ${msg}`);
    return false;
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// PASO 15.3b: VERIFICACIÓN DE SALUD Y RECUPERACIÓN DE PÁGINA (v7.1.0)
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Verifica si la página sigue viva y en la bandeja de casillas.
 *
 * ┌────────────────────────────────────────────────────────────────────────┐
 * │  v7.1.0 — FIX BUG-CASCADE-001                                        │
 * │  Después de un modal fallido, PrimeFaces puede destruir el contexto  │
 * │  JS. evaluarSeguro() retorna null y TODAS las siguientes fallan.     │
 * │  Esta función detecta ese estado para poder recuperar.               │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * @param {Page}   page      - Instancia de Puppeteer page
 * @param {string} requestId - ID único para logs
 * @returns {Promise<{viva: boolean, enCasillas: boolean, tieneTabla: boolean, url: string}>}
 */
async function verificarSaludPagina(page, requestId) {
  const ctx = `SALUD:${requestId}`;

  try {
    // Test 1: ¿La página está cerrada?
    if (page.isClosed()) {
      log('error', ctx, 'Página cerrada (isClosed=true)');
      return { viva: false, enCasillas: false, tieneTabla: false, url: 'closed' };
    }

    // Test 2: ¿Podemos obtener la URL?
    let url;
    try {
      url = page.url();
    } catch (e) {
      log('error', ctx, `No se puede obtener URL: ${e.message}`);
      return { viva: false, enCasillas: false, tieneTabla: false, url: 'error' };
    }

    // Test 3: ¿El contexto JS está vivo? (evaluarSeguro retorna null si no)
    const test = await evaluarSeguro(page, () => {
      const tbody = document.querySelector('tbody[id*="tblLista_data"]');
      const filas = tbody ? tbody.querySelectorAll('tr[data-ri]').length : 0;
      return {
        readyState: document.readyState,
        tieneTabla: filas > 0,
        filas: filas
      };
    });

    if (!test) {
      // ⭐ FIX-001 v7.2.0: Evaluar enCasillas desde URL incluso con contexto muerto
      // Si no evaluamos la URL, recovery nunca intenta reload (cree que no estamos en casillas)
      const enCasillasUrl = url.includes('notificacion-bandeja') || url.includes('casillas');
      log('warn', ctx, `Contexto JS muerto (evaluarSeguro=null). URL: ${url}, enCasillas(URL): ${enCasillasUrl}`);
      return { viva: true, enCasillas: enCasillasUrl, tieneTabla: false, url: url, contextoMuerto: true };
    }

    const enCasillas = url.includes('notificacion-bandeja') || url.includes('casillas');

    log('debug', ctx, `OK — URL: ${url.substring(url.lastIndexOf('/') + 1)}, tabla: ${test.tieneTabla}, filas: ${test.filas}`);

    return {
      viva: true,
      enCasillas: enCasillas,
      tieneTabla: test.tieneTabla,
      filas: test.filas,
      url: url,
      contextoMuerto: false
    };

  } catch (error) {
    log('error', ctx, `Error verificando salud: ${error.message}`);
    return { viva: false, enCasillas: false, tieneTabla: false, url: 'error' };
  }
}


/**
 * Recupera la página de casillas cuando el DOM está roto.
 *
 * Estrategias en orden:
 *   1. Reload de la página actual (si todavía estamos en casillas)
 *   2. Navegación directa a la URL de casillas
 *   3. Esperar que la tabla se cargue
 *
 * @param {Page}   page      - Instancia de Puppeteer page
 * @param {string} requestId - ID único para logs
 * @returns {Promise<{recuperada: boolean, filas: number}>}
 */
async function recuperarPaginaCasillas(page, requestId) {
  const ctx = `RECOVERY:${requestId}`;

  log('warn', ctx, '🔄 INICIANDO RECUPERACIÓN DE PÁGINA...');

  try {
    // ── Estrategia 1: Reload si estamos en casillas ──
    const salud = await verificarSaludPagina(page, requestId);

    if (salud.enCasillas || salud.contextoMuerto) {
      log('info', ctx, 'Recargando página actual...');
      try {
        await page.reload({ waitUntil: 'networkidle2', timeout: CONFIG_EXTRACCION.timeoutRecovery });
        await delay(3000); // Esperar que PrimeFaces inicialice

        // ⭐ FIX-002a v7.2.0: Detectar si SINOE redirigió a login después del reload
        const urlPostReload = page.url();
        if (urlPostReload.includes('login') || urlPostReload.includes('iniciarSesion') || urlPostReload.includes('autenticacion')) {
          log('error', ctx, 'Sesión expirada — SINOE redirigió a login después del reload');
          return { recuperada: false, filas: 0, sesionExpirada: true };
        }

        // ⭐ FIX-002b v7.2.0: Cerrar popup SOLO en diálogos/overlays (no botones de navegación)
        try {
          await evaluarSeguro(page, () => {
            // Buscar solo en diálogos modales de PrimeFaces, no en toda la página
            const dialogos = document.querySelectorAll('.ui-dialog[aria-hidden="false"], .ui-overlaypanel, .ui-confirm-dialog');
            for (const dlg of dialogos) {
              const botones = dlg.querySelectorAll('button, a.ui-commandlink');
              for (const btn of botones) {
                const texto = (btn.textContent || '').toLowerCase().trim();
                if (texto === 'aceptar' || texto === 'cerrar' || texto === 'ok' || texto === 'sí') {
                  btn.click();
                  return { cerrado: true };
                }
              }
            }
            return { cerrado: false };
          });
          await delay(1000);
        } catch (e) { /* ignorar popup */ }

        // Verificar que la tabla cargó
        const recarga = await esperarTablaCargada(page, requestId);
        if (recarga.cargada && recarga.tieneFilas) {
          log('success', ctx, `✅ RECUPERADA (reload) — ${recarga.cantidadFilas} filas`);
          return { recuperada: true, filas: recarga.cantidadFilas };
        }
      } catch (reloadError) {
        log('warn', ctx, `Reload falló: ${reloadError.message}`);
      }
    }

    // ── Estrategia 2: Navegación directa a casillas ──
    log('info', ctx, 'Navegando directamente a bandeja de casillas...');
    try {
      await page.goto(CONFIG_EXTRACCION.urlCasillas, {
        waitUntil: 'networkidle2',
        timeout: CONFIG_EXTRACCION.timeoutRecovery
      });
      await delay(3000);

      // ⭐ FIX-003a v7.2.0: Detectar redirect a login
      const urlPostNav = page.url();
      if (urlPostNav.includes('login') || urlPostNav.includes('iniciarSesion') || urlPostNav.includes('autenticacion')) {
        log('error', ctx, 'Sesión expirada — SINOE redirigió a login');
        return { recuperada: false, filas: 0, sesionExpirada: true };
      }

      // ⭐ FIX-003b v7.2.0: Cerrar popup scoped a diálogos
      try {
        await evaluarSeguro(page, () => {
          const dialogos = document.querySelectorAll('.ui-dialog[aria-hidden="false"], .ui-overlaypanel, .ui-confirm-dialog');
          for (const dlg of dialogos) {
            const botones = dlg.querySelectorAll('button, a.ui-commandlink');
            for (const btn of botones) {
              const texto = (btn.textContent || '').toLowerCase().trim();
              if (texto === 'aceptar' || texto === 'cerrar' || texto === 'ok' || texto === 'sí') {
                btn.click();
                return true;
              }
            }
          }
          return false;
        });
        await delay(1000);
      } catch (e) { /* ignorar */ }

      // Verificar tabla
      const recarga = await esperarTablaCargada(page, requestId);
      if (recarga.cargada && recarga.tieneFilas) {
        log('success', ctx, `✅ RECUPERADA (navegación) — ${recarga.cantidadFilas} filas`);
        return { recuperada: true, filas: recarga.cantidadFilas };
      }

      // Puede que la tabla cargue sin filtro, intentar una vez más
      log('info', ctx, 'Tabla sin datos, esperando más...');
      await delay(5000);
      const recarga2 = await esperarTablaCargada(page, requestId);
      if (recarga2.cargada) {
        log('success', ctx, `✅ RECUPERADA (2do intento) — ${recarga2.cantidadFilas} filas`);
        return { recuperada: true, filas: recarga2.cantidadFilas };
      }
    } catch (navError) {
      log('error', ctx, `Navegación falló: ${navError.message}`);
    }

    log('error', ctx, '❌ NO SE PUDO RECUPERAR LA PÁGINA');
    return { recuperada: false, filas: 0 };

  } catch (error) {
    log('error', ctx, `Error en recuperación: ${error.message}`);
    return { recuperada: false, filas: 0 };
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
  let fallosConsecutivos = 0;    // ⭐ v7.1.0: Contador de cascada
  let recuperacionesUsadas = 0;  // ⭐ v7.1.0: Contador de recoveries

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

    // ⭐ FIX-008 v7.2.0: Flag para evitar double-count en el catch
    let yaContado = false;

    // ══════════════════════════════════════════════════════════════════════
    // ⭐ v7.1.0: DETECCIÓN DE CASCADA — Si hay N fallos consecutivos,
    // la página probablemente está muerta. Intentar recovery.
    // ══════════════════════════════════════════════════════════════════════
    if (fallosConsecutivos >= CONFIG_EXTRACCION.maxFallosConsecutivos) {
      log('warn', ctx, `⚠️ ${fallosConsecutivos} fallos consecutivos detectados — verificando salud de página...`);

      const salud = await verificarSaludPagina(page, requestId);

      if (!salud.viva || salud.contextoMuerto || !salud.tieneTabla) {
        // Página muerta — intentar recovery
        if (recuperacionesUsadas >= CONFIG_EXTRACCION.maxRecuperaciones) {
          log('error', ctx, `❌ ABORTANDO — ${recuperacionesUsadas} recuperaciones fallidas. Página irrecuperable.`);
          // Marcar todas las restantes como fallidas
          for (let j = i; j < total; j++) {
            resultado.fallidas++;
            resultado.detalles.push({
              indice: j,
              expediente: notificaciones[j].expediente,
              numeroNotificacion: notificaciones[j].numNotificacion || notificaciones[j].numeroNotificacion || '',
              exito: false,
              error: 'Abortado: página irrecuperable después de múltiples intentos'
            });
          }
          break; // Salir del for
        }

        log('warn', ctx, `🔄 Intentando recuperación ${recuperacionesUsadas + 1}/${CONFIG_EXTRACCION.maxRecuperaciones}...`);
        const recovery = await recuperarPaginaCasillas(page, requestId);
        recuperacionesUsadas++;

        if (recovery.recuperada) {
          log('success', ctx, `✅ Página recuperada — continuando desde notificación ${i + 1}`);
          fallosConsecutivos = 0; // Reset contador
          paginaActualTabla = 1;  // ⭐ FIX-004 v7.2.0: Recovery siempre vuelve a pág 1
          // La tabla se re-cargó, los data-ri pueden haber cambiado
          // Las notificaciones se re-localizan por numNotificacion
        } else {
          log('error', ctx, `❌ Recovery falló — abortando procesamiento`);
          for (let j = i; j < total; j++) {
            resultado.fallidas++;
            resultado.detalles.push({
              indice: j,
              expediente: notificaciones[j].expediente,
              numeroNotificacion: notificaciones[j].numNotificacion || notificaciones[j].numeroNotificacion || '',
              exito: false,
              error: 'Abortado: no se pudo recuperar la página'
            });
          }
          break;
        }
      } else {
        // Página viva pero los modales fallan — puede ser un problema de SINOE
        log('info', ctx, `Página viva (${salud.filas} filas) — reiniciando contador de fallos`);
        fallosConsecutivos = 0;
      }
    }

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
        fallosConsecutivos++;  // ⭐ v7.1.0: Incrementar cascada

        // ── Limpieza defensiva: el clic PrimeFaces pudo haber disparado ──
        // ── un AJAX aunque el modal no se detectó. Cerrar modal zombie   ──
        // ── y esperar que la tabla se estabilice antes de continuar.     ──
        try {
          await cerrarModal(page, requestId);
          await delay(CONFIG_EXTRACCION.pausaEntreNotificaciones);

          // ⭐ v7.1.0: Verificar salud antes de esperar tabla (evita 25s de timeout inútil)
          const saludPost = await verificarSaludPagina(page, requestId);
          if (saludPost.viva && !saludPost.contextoMuerto) {
            await esperarTablaCargada(page, requestId);
          } else {
            log('warn', ctx, `${progreso} Página muerta después de modal fallido — saltando espera de tabla`);
          }
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
        fallosConsecutivos++;  // ⭐ v7.1.0
        yaContado = true;
      } else {
        // Guardar PDF en el objeto de la notificación
        if (descargaResult.base64) {
          notif.pdf = descargaResult.base64;
          notif.archivo = descargaResult.base64;
          notif.nombreArchivo = `${(numNotif || 'doc').replace(/\//g, '_')}_Consolidado.pdf`;
          notif.descargado = true;
          detalle.exito = true;
          resultado.exitosas++;
          fallosConsecutivos = 0;  // ⭐ v7.1.0: Reset en éxito
          yaContado = true;
          log('success', ctx, `${progreso} ✓ PDF descargado (${Math.round(descargaResult.base64.length / 1024)}KB)`);
        } else {
          // Clic exitoso pero sin base64 (Método C fallback)
          notif.descargado = false;
          notif.nombreArchivo = `${(numNotif || 'doc').replace(/\//g, '_')}_Consolidado.pdf`;
          detalle.exito = true;
          detalle.sinBase64 = true;
          resultado.parciales++;
          fallosConsecutivos = 0;  // ⭐ v7.1.0: Reset parcial también cuenta
          yaContado = true;
          log('warn', ctx, `${progreso} ⚠ Clic en Consolidado OK pero PDF no capturado como base64`);
        }
      }

      // ── 3. Cerrar modal + esperar tabla ──
      // ⭐ FIX-008 v7.2.0: Envuelto en su propio try/catch para que errores
      // aquí NO lleguen al catch global que haría double-count de fallidas
      try {
        await cerrarModal(page, requestId);

        // ══════════════════════════════════════════════════════════════════
        // ██ FIX CRÍTICO v3.0.0: Esperar que PrimeFaces recargue la tabla
        // ══════════════════════════════════════════════════════════════════
        if (i < total - 1) {
          await delay(CONFIG_EXTRACCION.pausaEntreNotificaciones);

          // ⭐ v7.1.0: Verificar salud ANTES de esperar tabla
          const saludPost = await verificarSaludPagina(page, requestId);
          if (!saludPost.viva || saludPost.contextoMuerto) {
            log('warn', ctx, `${progreso} Página muerta después de cerrar modal — recovery en siguiente iteración`);
            fallosConsecutivos = CONFIG_EXTRACCION.maxFallosConsecutivos; // Forzar recovery
            resultado.detalles.push(detalle); // ⭐ FIX-009 v7.2.0: No perder el detalle
            continue;
          }

          // Esperar que la tabla se reconstruya antes de tocar la siguiente fila
          const recarga = await esperarTablaCargada(page, requestId);

          if (!recarga.cargada) {
            log('warn', ctx, `${progreso} Tabla no recargó después de cerrar modal, esperando extra...`);
            await delay(3000);

            // Segundo intento
            const recarga2 = await esperarTablaCargada(page, requestId);
            if (!recarga2.cargada) {
              log('error', ctx, `${progreso} Tabla sigue sin cargar — forzando recovery`);
              fallosConsecutivos = CONFIG_EXTRACCION.maxFallosConsecutivos; // Forzar recovery
            }
          }
        }
      } catch (cleanupError) {
        // ⭐ FIX-008 v7.2.0: Error en limpieza post-descarga NO debe re-contar fallidas
        log('warn', ctx, `${progreso} Error en limpieza post-descarga: ${cleanupError.message}`);
        try {
          const saludPost = await verificarSaludPagina(page, requestId);
          if (!saludPost.viva || saludPost.contextoMuerto) {
            fallosConsecutivos = CONFIG_EXTRACCION.maxFallosConsecutivos;
          }
        } catch (e) { /* ignorar */ }
      }

    } catch (error) {
      // ⭐ FIX-008 v7.2.0: Solo contar si no se contó ya en el try
      // (errores en abrirModal o descargarConsolidado antes de yaContado=true)
      if (!yaContado) {
        detalle.error = error.message;
        resultado.fallidas++;
      } else {
        // Ya se contó arriba, solo guardar el error de limpieza para debug
        log('warn', ctx, `${progreso} Error post-conteo: ${error.message}`);
      }
      log('error', ctx, `${progreso} ✗ Error: ${error.message}`);
      fallosConsecutivos++;  // ⭐ v7.1.0

      // Intentar cerrar modal si quedó abierto
      try {
        await cerrarModal(page, requestId);
      } catch (closeError) {
        // Ignorar error al cerrar — ya estamos en manejo de error
      }

      // ⭐ v7.1.0: Verificar salud antes de intentar recuperar tabla
      try {
        const saludPost = await verificarSaludPagina(page, requestId);
        if (saludPost.viva && !saludPost.contextoMuerto) {
          await delay(2000);
          await esperarTablaCargada(page, requestId);
        }
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
  if (recuperacionesUsadas > 0) {
    log('info', ctx, `  Recuperaciones de página: ${recuperacionesUsadas}`);
  }
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

  // ── v7.1.0: Salud + Recovery ──
  verificarSaludPagina,
  recuperarPaginaCasillas,

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
