/**
 * ════════════════════════════════════════════════════════════════════════════════
 * EXTRACCIÓN v2.0.0 - SINOE SCRAPER
 * ════════════════════════════════════════════════════════════════════════════════
 * 
 * Autor: LEXA Assistant (CTO)
 * Fecha: Febrero 2026
 * Versión: 2.0.0 - Selectores corregidos para estructura real de SINOE
 * 
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │  ESTE ARCHIVO CONTIENE LOS PASOS 14-15 DEL FLUJO DE SCRAPING               │
 * │                                                                             │
 * │  Paso 14: Extraer notificaciones de la tabla                                │
 * │  Paso 15: Descargar PDFs consolidados                                       │
 * │                                                                             │
 * │  Para los pasos 1-13 (login, CAPTCHA, navegación), ver: flujo-estable.js   │
 * └─────────────────────────────────────────────────────────────────────────────┘
 * 
 * ESTRUCTURA DE LA TABLA SINOE (verificada Feb 2026):
 * ┌────────┬────────┬─────┬─────────────────┬─────────────────────────┬─────────────────┬────────────────┬──────────────────┬────────┐
 * │ Chkbox │ Estado │ N°  │ N° Notificación │ N° Expediente           │ Sumilla         │ O.J.           │ Fecha            │ Anexos │
 * │  (0)   │  (1)   │ (2) │      (3)        │         (4)             │    (5)          │     (6)        │    (7)           │  (8)   │
 * └────────┴────────┴─────┴─────────────────┴─────────────────────────┴─────────────────┴────────────────┴──────────────────┴────────┘
 * 
 * IDs REALES DE SINOE:
 *   - Tabla: tbody[id*="tblLista_data"]
 *   - Filas: tr[data-ri="N"]
 *   - Botón anexos: button con span.ui-icon-circle-zoomout
 *   - Modal: div[id*="dlgListaAnexos"]
 *   - Consolidado: button[id*="btnDescargaTodo"]
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
// CONFIGURACIÓN
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Timeouts específicos para extracción.
 * Estos valores han sido calibrados para el rendimiento real de SINOE.
 */
const CONFIG_EXTRACCION = {
  // Tiempo máximo para que cargue la tabla vía AJAX
  timeoutCargaTabla: 20000,
  
  // Intervalo entre verificaciones de carga
  intervaloVerificacion: 800,
  
  // Tiempo máximo para que abra el modal de anexos
  timeoutModal: 12000,
  
  // Tiempo de espera después de hacer clic (para que PrimeFaces procese)
  esperaPostClic: 2000,
  
  // Tiempo entre procesamiento de notificaciones (evita saturar SINOE)
  pausaEntreNotificaciones: 1500,
  
  // Tiempo de espera para que inicie la descarga
  esperaDescarga: 4000,
  
  // Máximo de reintentos para operaciones fallidas
  maxReintentos: 3
};

// ════════════════════════════════════════════════════════════════════════════════
// SELECTORES - VERIFICADOS CONTRA SINOE REAL (FEBRERO 2026)
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Selectores CSS verificados contra la estructura real de SINOE.
 * 
 * IMPORTANTE: Si SINOE cambia su estructura HTML, este es el único
 * lugar que necesita actualizarse.
 * 
 * Última verificación: 03/02/2026
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
    info: '.ui-paginator-current' // "Registros: 26 - [ Página : 1/2 ]"
  }
};

// ════════════════════════════════════════════════════════════════════════════════
// MAPEO DE COLUMNAS DE LA TABLA
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Índices de las columnas en la tabla de notificaciones.
 * Basado en la estructura real de SINOE (verificada Feb 2026).
 * 
 * Ajustar estos valores si SINOE cambia el orden de las columnas.
 */
const COLUMNAS = {
  checkbox: 0,           // Checkbox de selección
  estadoLectura: 1,      // Ícono de sobre (leído/no leído)
  indice: 2,             // Número de fila (1, 2, 3...)
  numeroNotificacion: 3, // N° Notificación (ej: "00310-2026")
  expediente: 4,         // N° Expediente (ej: "00489-2025-0-1606-JP-FC-01")
  sumilla: 5,            // Descripción/Tipo (ej: "ESCRITO 522-2026 RESOLUCION CUATRO")
  organoJurisdiccional: 6, // Juzgado (ej: "JUZGADO DE PAZ LETRADO - Pacasmayo")
  fechaHora: 7,          // Fecha y hora (ej: "03/02/2026 12:02:33")
  acciones: 8            // Columna con botón de anexos
};

// ════════════════════════════════════════════════════════════════════════════════
// PASO 14.1: ESPERAR CARGA DE TABLA
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Espera a que la tabla de notificaciones cargue completamente.
 * SINOE usa PrimeFaces que carga datos vía AJAX.
 * 
 * Esta función verifica:
 *   1. Que no haya indicador de carga visible
 *   2. Que exista el tbody de la tabla
 *   3. Que haya filas con datos O mensaje de "no hay datos"
 * 
 * @param {Page} page - Instancia de Puppeteer page
 * @param {string} requestId - ID único para logs
 * @returns {Promise<{cargada: boolean, tieneFilas: boolean, cantidadFilas: number, mensaje: string}>}
 */
async function esperarTablaCargada(page, requestId) {
  const ctx = `TABLA:${requestId}`;
  const inicio = Date.now();
  
  log('info', ctx, 'Esperando carga de tabla AJAX...');
  
  while (Date.now() - inicio < CONFIG_EXTRACCION.timeoutCargaTabla) {
    
    const estado = await evaluarSeguro(page, (selectores) => {
      
      // ────────────────────────────────────────────────────────────────────
      // 1. Verificar si hay indicador de carga activo
      // ────────────────────────────────────────────────────────────────────
      for (const selCarga of selectores.tabla.cargando) {
        const indicador = document.querySelector(selCarga);
        if (indicador) {
          const estilo = window.getComputedStyle(indicador);
          if (estilo.display !== 'none' && estilo.visibility !== 'hidden') {
            return { estado: 'cargando' };
          }
        }
      }
      
      // ────────────────────────────────────────────────────────────────────
      // 2. Buscar el tbody de la tabla
      // ────────────────────────────────────────────────────────────────────
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
      
      // ────────────────────────────────────────────────────────────────────
      // 3. Contar filas con datos
      // ────────────────────────────────────────────────────────────────────
      const filas = tbody.querySelectorAll('tr[data-ri]');
      const filasReales = Array.from(filas).filter(fila => {
        // Excluir filas de mensaje vacío
        if (fila.classList.contains('ui-datatable-empty-message')) return false;
        // Debe tener más de 2 celdas
        const celdas = fila.querySelectorAll('td');
        return celdas.length > 2;
      });
      
      // ────────────────────────────────────────────────────────────────────
      // 4. Verificar mensaje de "no hay datos"
      // ────────────────────────────────────────────────────────────────────
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
    
    // ──────────────────────────────────────────────────────────────────────
    // Procesar resultado
    // ──────────────────────────────────────────────────────────────────────
    
    if (!estado) {
      // Error evaluando, reintentar
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
      if (estado.sinDatos) {
        log('info', ctx, '✓ Tabla cargada - No hay notificaciones pendientes');
        return { 
          cargada: true, 
          tieneFilas: false, 
          cantidadFilas: 0, 
          mensaje: 'Sin notificaciones' 
        };
      }
      
      log('success', ctx, `✓ Tabla cargada - ${estado.cantidadFilas} notificaciones encontradas`);
      return { 
        cargada: true, 
        tieneFilas: true, 
        cantidadFilas: estado.cantidadFilas, 
        mensaje: `${estado.cantidadFilas} notificaciones` 
      };
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
// PASO 14.2: EXTRAER NOTIFICACIONES
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Extrae la lista de notificaciones de la tabla de SINOE.
 * 
 * Retorna un array de objetos con los datos de cada notificación:
 *   - indice: Índice de la fila en la tabla
 *   - dataRi: Atributo data-ri de PrimeFaces (para referenciar la fila)
 *   - numeroNotificacion: N° de notificación (ej: "00310-2026")
 *   - expediente: N° de expediente completo
 *   - sumilla: Descripción/tipo de documento
 *   - organoJurisdiccional: Nombre del juzgado
 *   - fechaHora: Fecha y hora de la notificación
 *   - leido: Boolean indicando si ya fue leída
 *   - tieneBotonAnexos: Boolean indicando si tiene botón de descarga
 * 
 * @param {Page} page - Instancia de Puppeteer page
 * @param {string} requestId - ID único para logs
 * @returns {Promise<Array>} Array de notificaciones
 */
async function extraerNotificaciones(page, requestId) {
  const ctx = `NOTIF:${requestId}`;
  
  log('info', ctx, 'Iniciando extracción de notificaciones...');
  
  // ────────────────────────────────────────────────────────────────────────
  // 1. Esperar que la tabla cargue
  // ────────────────────────────────────────────────────────────────────────
  const estadoCarga = await esperarTablaCargada(page, requestId);
  
  if (!estadoCarga.cargada) {
    log('error', ctx, 'Tabla no cargó correctamente');
    await diagnosticarPaginaCasillas(page, requestId);
    return [];
  }
  
  if (!estadoCarga.tieneFilas) {
    log('info', ctx, 'No hay notificaciones para extraer');
    return [];
  }
  
  // ────────────────────────────────────────────────────────────────────────
  // 2. Extraer datos de cada fila
  // ────────────────────────────────────────────────────────────────────────
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
      const iconoSobre = celdaEstado?.querySelector('img, span[class*="icon"]');
      const srcIcono = iconoSobre?.src || iconoSobre?.className || '';
      // NOTA: Si no hay ícono (srcIcono vacío), asumimos NO leído por defecto
      const leido = srcIcono.length > 0 && (
        srcIcono.includes('leido') || 
        srcIcono.includes('read') || 
        !srcIcono.includes('nuevo')
      );
      
      // ── Extraer texto de cada columna ──
      const textos = Array.from(celdas).map(c => (c.textContent || '').trim());
      
      // ── Verificar si tiene botón de anexos ──
      const celdaAcciones = celdas[celdas.length - 1]; // Última celda
      let tieneBotonAnexos = false;
      
      // Buscar botón con ícono de lupa/zoom
      if (celdaAcciones) {
        const boton = celdaAcciones.querySelector('button') || 
                      celdaAcciones.querySelector('a[onclick]');
        tieneBotonAnexos = !!boton;
      }
      
      // ── Construir objeto de notificación ──
      const notificacion = {
        indice: parseInt(dataRi, 10),
        dataRi: dataRi,
        numeroNotificacion: textos[columnas.numeroNotificacion] || '',
        expediente: textos[columnas.expediente] || '',
        sumilla: textos[columnas.sumilla] || '',
        organoJurisdiccional: textos[columnas.organoJurisdiccional] || '',
        fechaHora: textos[columnas.fechaHora] || '',
        leido: leido,
        tieneBotonAnexos: tieneBotonAnexos
      };
      
      // Solo agregar si tiene datos mínimos
      if (notificacion.expediente || notificacion.numeroNotificacion) {
        notificaciones.push(notificacion);
      }
    }
    
    return {
      notificaciones: notificaciones,
      metodo: metodoUsado,
      totalFilas: filas.length
    };
    
  }, SELECTORES, COLUMNAS);
  
  // ────────────────────────────────────────────────────────────────────────
  // 3. Validar y retornar
  // ────────────────────────────────────────────────────────────────────────
  
  if (!resultado) {
    log('error', ctx, 'Error evaluando página (resultado null)');
    await diagnosticarPaginaCasillas(page, requestId);
    return [];
  }
  
  if (resultado.error) {
    log('error', ctx, `Error extrayendo: ${resultado.error}`);
    await diagnosticarPaginaCasillas(page, requestId);
    return [];
  }
  
  const notificaciones = resultado.notificaciones || [];
  
  log('success', ctx, `✓ Extraídas ${notificaciones.length} notificaciones (${resultado.metodo})`);
  
  // Log de las primeras 3 para verificación
  if (notificaciones.length > 0) {
    const muestra = notificaciones.slice(0, 3);
    muestra.forEach((n, i) => {
      log('info', ctx, `  [${i}] Exp: ${n.expediente} | Notif: ${n.numeroNotificacion}`);
    });
    if (notificaciones.length > 3) {
      log('info', ctx, `  ... y ${notificaciones.length - 3} más`);
    }
  }
  
  return notificaciones;
}

// ════════════════════════════════════════════════════════════════════════════════
// DIAGNÓSTICO DE PÁGINA
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Genera un diagnóstico detallado de la página para debug.
 * Se usa cuando algo falla para entender el estado de la página.
 * 
 * @param {Page} page - Instancia de Puppeteer page
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
        primeraFila: filas[0]?.textContent?.substring(0, 100) || ''
      });
    });
    
    // ── Analizar formularios ──
    const forms = document.querySelectorAll('form');
    forms.forEach((form, i) => {
      resultado.formularios.push({
        indice: i,
        id: form.id || '(sin id)',
        action: form.action?.substring(0, 80) || ''
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
    resultado.extractoBody = document.body?.innerText?.substring(0, 500) || '';
    
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
 * @param {Page} page - Instancia de Puppeteer page
 * @param {number|string} dataRi - Índice data-ri de la fila (0, 1, 2...)
 * @param {string} requestId - ID único para logs
 * @returns {Promise<{exito: boolean, error?: string}>}
 */
async function abrirModalAnexos(page, dataRi, requestId) {
  const ctx = `MODAL:${requestId}`;
  
  log('info', ctx, `Abriendo modal de anexos para fila ${dataRi}...`);
  
  // ────────────────────────────────────────────────────────────────────────
  // 1. Buscar y hacer clic en el botón de anexos
  // ────────────────────────────────────────────────────────────────────────
  const resultadoClic = await evaluarSeguro(page, (dataRiParam, selectores) => {
    
    // ── Buscar la fila por data-ri ──
    const fila = document.querySelector(`tr[data-ri="${dataRiParam}"]`);
    
    if (!fila) {
      return { error: `Fila con data-ri="${dataRiParam}" no encontrada` };
    }
    
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
        // Tomar el último (generalmente es el de acciones)
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
      botonId: boton.id || '(sin id)'
    };
    
  }, dataRi, SELECTORES);
  
  // ────────────────────────────────────────────────────────────────────────
  // 2. Verificar resultado del clic
  // ────────────────────────────────────────────────────────────────────────
  
  if (!resultadoClic || resultadoClic.error) {
    log('error', ctx, `Error: ${resultadoClic?.error || 'resultado null'}`);
    return { exito: false, error: resultadoClic?.error || 'Error desconocido' };
  }
  
  log('info', ctx, `Clic realizado (método: ${resultadoClic.metodo}, id: ${resultadoClic.botonId})`);
  
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
          
          // Modal está visible si aria-hidden es false o display no es none
          if (ariaHidden === 'false' || (ariaHidden !== 'true' && display !== 'none')) {
            const titulo = modal.querySelector('.ui-dialog-title')?.textContent || '';
            return { 
              visible: true, 
              titulo: titulo.substring(0, 100) 
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
// PASO 15.2: DESCARGAR CONSOLIDADO
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Descarga el PDF consolidado desde el modal de anexos abierto.
 * Busca y hace clic en el botón "Consolidado".
 * 
 * @param {Page} page - Instancia de Puppeteer page
 * @param {string} requestId - ID único para logs
 * @returns {Promise<{exito: boolean, error?: string}>}
 */
async function descargarConsolidado(page, requestId) {
  const ctx = `DESCARGA:${requestId}`;
  
  log('info', ctx, 'Buscando botón Consolidado...');
  
  // ────────────────────────────────────────────────────────────────────────
  // 1. Buscar y hacer clic en el botón Consolidado
  // ────────────────────────────────────────────────────────────────────────
  const resultado = await evaluarSeguro(page, (selectores) => {
    
    // ── Buscar el modal visible ──
    let modal = null;
    for (const sel of selectores.modal.contenedor) {
      const m = document.querySelector(sel);
      if (m && m.getAttribute('aria-hidden') !== 'true') {
        modal = m;
        break;
      }
    }
    
    // Si no encontró por selectores específicos, buscar cualquier dialog visible
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
      const botones = contenedor.querySelectorAll('button, a.ui-commandlink');
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
    
    // ── Estrategia 5: Primer botón en el header/toolbar del modal ──
    if (!boton && modal) {
      // El botón Consolidado suele estar arriba, en el fieldset o antes de la tabla
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
      // Listar todos los botones para debug
      const todosBotones = contenedor.querySelectorAll('button');
      const listaBotones = Array.from(todosBotones).map(b => ({
        id: b.id || '(sin id)',
        texto: (b.textContent || '').substring(0, 30)
      }));
      
      return { 
        error: 'Botón Consolidado no encontrado',
        botonesDisponibles: listaBotones
      };
    }
    
    // ── Hacer clic ──
    try {
      if (typeof jQuery !== 'undefined' && jQuery(boton).length) {
        jQuery(boton).trigger('click');
      } else {
        boton.click();
      }
    } catch (e) {
      return { error: `Error al hacer clic: ${e.message}` };
    }
    
    return { 
      exito: true, 
      metodo: metodo,
      botonId: boton.id || '(sin id)',
      botonTexto: (boton.textContent || '').substring(0, 50)
    };
    
  }, SELECTORES);
  
  // ────────────────────────────────────────────────────────────────────────
  // 2. Verificar resultado
  // ────────────────────────────────────────────────────────────────────────
  
  if (!resultado || resultado.error) {
    log('error', ctx, `Error: ${resultado?.error || 'resultado null'}`);
    if (resultado?.botonesDisponibles) {
      log('info', ctx, 'Botones disponibles:', JSON.stringify(resultado.botonesDisponibles));
    }
    return { exito: false, error: resultado?.error || 'Error desconocido' };
  }
  
  log('success', ctx, `✓ Clic en Consolidado (método: ${resultado.metodo}, id: ${resultado.botonId})`);
  
  // ────────────────────────────────────────────────────────────────────────
  // 3. Esperar que inicie la descarga
  // ────────────────────────────────────────────────────────────────────────
  await delay(CONFIG_EXTRACCION.esperaDescarga);
  
  return { exito: true };
}

// ════════════════════════════════════════════════════════════════════════════════
// PASO 15.3: CERRAR MODAL
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Cierra el modal de anexos.
 * Intenta múltiples estrategias: botón X, botón Cerrar, tecla Escape.
 * 
 * @param {Page} page - Instancia de Puppeteer page
 * @param {string} requestId - ID único para logs
 * @returns {Promise<boolean>} true si se cerró exitosamente
 */
async function cerrarModal(page, requestId) {
  const ctx = `CERRAR:${requestId}`;
  
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
      } catch (e) {}
    }
    
    // ── Estrategia 2: Botón "Cerrar" ──
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
        } catch (e) {}
      }
    }
    
    return { exito: false, metodo: 'ninguno' };
    
  }, SELECTORES);
  
  // ────────────────────────────────────────────────────────────────────────
  // 2. Verificar resultado
  // ────────────────────────────────────────────────────────────────────────
  
  if (cerrado?.noHayModal) {
    log('info', ctx, 'No hay modal abierto');
    return true;
  }
  
  if (cerrado?.exito) {
    log('info', ctx, `Modal cerrado (método: ${cerrado.metodo})`);
    await delay(500);
    return true;
  }
  
  // ────────────────────────────────────────────────────────────────────────
  // 3. Fallback: Tecla Escape
  // ────────────────────────────────────────────────────────────────────────
  try {
    await page.keyboard.press('Escape');
    log('info', ctx, 'Modal cerrado (Escape)');
    await delay(500);
    return true;
  } catch (e) {
    log('warn', ctx, `Error cerrando modal: ${e.message}`);
    return false;
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// PASO 15.4: PROCESAR TODAS LAS NOTIFICACIONES
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Procesa todas las notificaciones: abre modal, descarga PDF, cierra modal.
 * 
 * Para cada notificación:
 *   1. Abre el modal de anexos
 *   2. Hace clic en "Consolidado" para descargar
 *   3. Cierra el modal
 *   4. Pausa antes de la siguiente
 * 
 * @param {Page} page - Instancia de Puppeteer page
 * @param {Array} notificaciones - Lista de notificaciones extraídas
 * @param {string} requestId - ID único para logs
 * @returns {Promise<{exitosas: number, fallidas: number, detalles: Array}>}
 */
async function procesarNotificaciones(page, notificaciones, requestId) {
  const ctx = `PROC:${requestId}`;
  
  const resultado = {
    exitosas: 0,
    fallidas: 0,
    detalles: []
  };
  
  const total = notificaciones.length;
  
  log('info', ctx, `════════════════════════════════════════════════════`);
  log('info', ctx, `Iniciando procesamiento de ${total} notificaciones...`);
  log('info', ctx, `════════════════════════════════════════════════════`);
  
  for (let i = 0; i < total; i++) {
    const notif = notificaciones[i];
    const dataRi = notif.dataRi || notif.indice || i;
    const progreso = `[${i + 1}/${total}]`;
    
    log('info', ctx, `${progreso} Procesando: Exp. ${notif.expediente || '?'}`);
    
    const detalle = {
      indice: i,
      dataRi: dataRi,
      expediente: notif.expediente,
      numeroNotificacion: notif.numeroNotificacion,
      exito: false,
      error: null
    };
    
    try {
      // ── 1. Abrir modal de anexos ──
      const modalResult = await abrirModalAnexos(page, dataRi, requestId);
      
      if (!modalResult.exito) {
        detalle.error = modalResult.error || 'No se pudo abrir modal';
        log('warn', ctx, `${progreso} ✗ ${detalle.error}`);
        resultado.fallidas++;
        resultado.detalles.push(detalle);
        continue;
      }
      
      // ── 2. Descargar consolidado ──
      const descargaResult = await descargarConsolidado(page, requestId);
      
      if (!descargaResult.exito) {
        detalle.error = descargaResult.error || 'No se pudo descargar';
        log('warn', ctx, `${progreso} ✗ ${detalle.error}`);
        resultado.fallidas++;
      } else {
        detalle.exito = true;
        resultado.exitosas++;
        log('success', ctx, `${progreso} ✓ Descarga iniciada`);
      }
      
      // ── 3. Cerrar modal ──
      await cerrarModal(page, requestId);
      
      // ── 4. Pausa antes de la siguiente ──
      if (i < total - 1) {
        await delay(CONFIG_EXTRACCION.pausaEntreNotificaciones);
      }
      
    } catch (error) {
      detalle.error = error.message;
      log('error', ctx, `${progreso} ✗ Error: ${error.message}`);
      resultado.fallidas++;
      
      // Intentar cerrar modal si quedó abierto
      try {
        await cerrarModal(page, requestId);
      } catch (e) {}
    }
    
    resultado.detalles.push(detalle);
  }
  
  // ────────────────────────────────────────────────────────────────────────
  // Resumen final
  // ────────────────────────────────────────────────────────────────────────
  log('info', ctx, `════════════════════════════════════════════════════`);
  log('info', ctx, `RESUMEN: ${resultado.exitosas} exitosas, ${resultado.fallidas} fallidas de ${total}`);
  log('info', ctx, `════════════════════════════════════════════════════`);
  
  return resultado;
}

// ════════════════════════════════════════════════════════════════════════════════
// UTILIDADES ADICIONALES
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Captura un screenshot de la página actual.
 * Útil para debug cuando algo falla.
 * 
 * @param {Page} page - Instancia de Puppeteer page
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

/**
 * Verifica si hay más páginas de notificaciones.
 * Retorna información sobre la paginación actual.
 * 
 * @param {Page} page - Instancia de Puppeteer page
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
    const textoInfo = paginador.querySelector(selectores.paginacion.info)?.textContent || '';
    const match = textoInfo.match(/(\d+)\s*\/\s*(\d+)/);
    
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
    
    return {
      hayMas: !!botonSiguiente,
      paginaActual: 1,
      totalPaginas: 1
    };
    
  }, SELECTORES);
  
  if (info) {
    log('info', ctx, `Paginación: Página ${info.paginaActual}/${info.totalPaginas}`);
  }
  
  return info || { hayMas: false, paginaActual: 1, totalPaginas: 1 };
}

// ════════════════════════════════════════════════════════════════════════════════
// EXPORTACIONES
// ════════════════════════════════════════════════════════════════════════════════

module.exports = {
  // ── Paso 14: Extracción ──
  esperarTablaCargada,
  extraerNotificaciones,
  diagnosticarPaginaCasillas,
  
  // ── Paso 15: Descarga ──
  abrirModalAnexos,
  descargarConsolidado,
  cerrarModal,
  procesarNotificaciones,
  
  // ── Utilidades ──
  capturarPantallaCasillas,
  verificarPaginacion,
  
  // ── Configuración (para modificar externamente si es necesario) ──
  SELECTORES,
  COLUMNAS,
  CONFIG_EXTRACCION
};
