/**
 * ============================================================
 * EXTRACCIÓN v1.0.0 - PASOS 14+ PARA MODIFICAR
 * ============================================================
 * 
 * ✏️  ESTE ARCHIVO SE PUEDE MODIFICAR LIBREMENTE  ✏️
 * 
 * Contiene:
 *   14. Extraer notificaciones de la tabla
 *   15. Descargar consolidados/anexos
 *   16. Procesamiento posterior
 * 
 * Para los pasos 10-13 que ya funcionan, ver: flujo-estable.js
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
  evaluarSeguro
} = core;

// ============================================================
// CONFIGURACIÓN DE EXTRACCIÓN
// ============================================================

// Tiempo máximo de espera para que cargue la tabla (AJAX)
const TIMEOUT_CARGA_TABLA = 15000;

// Intervalo de verificación mientras espera AJAX
const INTERVALO_VERIFICACION = 1000;

// ============================================================
// SELECTORES - MODIFICAR AQUÍ SI CAMBIA SINOE
// ============================================================

const SELECTORES = {
  // Selectores para encontrar la tabla de notificaciones
  tabla: {
    // PrimeFaces DataTable (más común)
    primefaces: [
      '.ui-datatable-tablewrapper table',
      '.ui-datatable table',
      'table.ui-datatable'
    ],
    // Tabla estándar con role
    estandar: [
      'table[role="grid"]',
      'table.tabla-notificaciones',
      'table.tblNotificaciones'
    ],
    // Por IDs parciales
    porId: [
      '[id*="tblNotificaciones"]',
      '[id*="tblCasillas"]',
      '[id*="dtNotificaciones"]',
      '[id*="dataTable"]'
    ]
  },
  
  // Selectores para filas de la tabla
  filas: [
    'tbody tr[data-ri]',           // PrimeFaces con row index
    'tbody tr[role="row"]',        // Con role
    'tbody tr.ui-widget-content',  // Clase PrimeFaces
    'tbody tr:not(.ui-datatable-empty-message)'  // Cualquier fila no vacía
  ],
  
  // Selectores para celdas
  celdas: [
    'td[role="gridcell"]',
    'td.ui-cell',
    'td'
  ],
  
  // Selector para mensaje de "no hay datos"
  sinDatos: [
    '.ui-datatable-empty-message',
    'tr.ui-datatable-empty-message',
    'td[colspan]:contains("No hay")',
    '.empty-message'
  ],
  
  // Selectores para el modal de anexos
  modal: {
    contenedor: '.ui-dialog[aria-hidden="false"]',
    cerrar: '.ui-dialog-titlebar-close',
    consolidado: 'button[id*="consolidado"], a[id*="consolidado"]'
  },
  
  // Selectores para botón de descarga en cada fila
  botonDescarga: [
    'button[id*="btnAnexos"]',
    'button[id*="btnDescargar"]',
    'a[onclick*="download"]',
    '.ui-button[title*="Anexos"]'
  ]
};

// ============================================================
// PASO 14: ESPERAR CARGA DE TABLA (AJAX)
// ============================================================

/**
 * Espera a que la tabla de notificaciones cargue vía AJAX.
 * SINOE usa PrimeFaces que carga datos asincrónicamente.
 * 
 * @param {Page} page - Instancia de Puppeteer page
 * @param {string} requestId - ID para logs
 * @returns {Promise<{cargada: boolean, tieneFilas: boolean, mensaje: string}>}
 */
async function esperarTablaCargada(page, requestId) {
  const ctx = `EXTRACCION:${requestId}`;
  const inicio = Date.now();
  
  log('info', ctx, 'Esperando carga de tabla AJAX...');
  
  while (Date.now() - inicio < TIMEOUT_CARGA_TABLA) {
    const estado = await evaluarSeguro(page, (selectores) => {
      // Verificar si hay indicador de carga
      const cargando = document.querySelector('.ui-datatable-loading, .loading-indicator');
      if (cargando && window.getComputedStyle(cargando).display !== 'none') {
        return { cargando: true };
      }
      
      // Buscar tabla
      let tabla = null;
      for (const sel of [...selectores.primefaces, ...selectores.estandar, ...selectores.porId]) {
        tabla = document.querySelector(sel);
        if (tabla) break;
      }
      
      if (!tabla) {
        return { sinTabla: true };
      }
      
      // Verificar si tiene filas
      const filas = tabla.querySelectorAll('tbody tr[data-ri], tbody tr[role="row"]');
      const filasReales = Array.from(filas).filter(f => 
        !f.classList.contains('ui-datatable-empty-message') &&
        f.querySelectorAll('td').length > 1
      );
      
      // Verificar mensaje de "no hay datos"
      const sinDatos = tabla.querySelector('.ui-datatable-empty-message') ||
                       tabla.innerText.toLowerCase().includes('no hay');
      
      return {
        cargada: true,
        tieneFilas: filasReales.length > 0,
        cantidadFilas: filasReales.length,
        sinDatos: sinDatos
      };
      
    }, SELECTORES.tabla);
    
    if (!estado) {
      await delay(INTERVALO_VERIFICACION);
      continue;
    }
    
    if (estado.cargando) {
      log('info', ctx, 'Tabla cargando...');
      await delay(INTERVALO_VERIFICACION);
      continue;
    }
    
    if (estado.sinTabla) {
      await delay(INTERVALO_VERIFICACION);
      continue;
    }
    
    if (estado.cargada) {
      if (estado.sinDatos && !estado.tieneFilas) {
        log('info', ctx, 'Tabla cargada - No hay notificaciones');
        return { cargada: true, tieneFilas: false, mensaje: 'No hay notificaciones' };
      }
      
      log('success', ctx, `Tabla cargada - ${estado.cantidadFilas} filas encontradas`);
      return { cargada: true, tieneFilas: true, mensaje: `${estado.cantidadFilas} filas` };
    }
    
    await delay(INTERVALO_VERIFICACION);
  }
  
  log('warn', ctx, 'Timeout esperando tabla');
  return { cargada: false, tieneFilas: false, mensaje: 'Timeout' };
}

// ============================================================
// PASO 14: EXTRAER NOTIFICACIONES
// ============================================================

/**
 * Extrae la lista de notificaciones de la tabla.
 * 
 * @param {Page} page - Instancia de Puppeteer page
 * @param {string} requestId - ID para logs
 * @returns {Promise<Array>} - Array de notificaciones
 */
async function extraerNotificaciones(page, requestId) {
  const ctx = `EXTRACCION:${requestId}`;
  
  log('info', ctx, 'Iniciando extracción de notificaciones...');
  
  // Primero esperar que cargue
  const estadoCarga = await esperarTablaCargada(page, requestId);
  
  if (!estadoCarga.cargada) {
    log('error', ctx, 'Tabla no cargó');
    await diagnosticarPaginaCasillas(page, requestId);
    return [];
  }
  
  if (!estadoCarga.tieneFilas) {
    log('info', ctx, 'No hay notificaciones en la tabla');
    return [];
  }
  
  // Extraer datos de la tabla
  const notificaciones = await evaluarSeguro(page, (selectores) => {
    const resultado = [];
    
    // ═══════════════════════════════════════════════════════
    // BUSCAR TABLA
    // ═══════════════════════════════════════════════════════
    let tabla = null;
    let metodoEncontrado = '';
    
    // Intento 1: PrimeFaces
    for (const sel of selectores.tabla.primefaces) {
      tabla = document.querySelector(sel);
      if (tabla) {
        metodoEncontrado = `PrimeFaces: ${sel}`;
        break;
      }
    }
    
    // Intento 2: Estándar
    if (!tabla) {
      for (const sel of selectores.tabla.estandar) {
        tabla = document.querySelector(sel);
        if (tabla) {
          metodoEncontrado = `Estándar: ${sel}`;
          break;
        }
      }
    }
    
    // Intento 3: Por ID
    if (!tabla) {
      for (const sel of selectores.tabla.porId) {
        tabla = document.querySelector(sel);
        if (tabla) {
          metodoEncontrado = `Por ID: ${sel}`;
          break;
        }
      }
    }
    
    // Intento 4: Cualquier tabla con más de 3 columnas
    if (!tabla) {
      const todasTablas = document.querySelectorAll('table');
      for (const t of todasTablas) {
        const primeraFila = t.querySelector('tr');
        if (primeraFila && primeraFila.querySelectorAll('th, td').length >= 3) {
          tabla = t;
          metodoEncontrado = 'Tabla genérica';
          break;
        }
      }
    }
    
    if (!tabla) {
      return { error: 'No se encontró tabla', metodo: 'ninguno' };
    }
    
    // ═══════════════════════════════════════════════════════
    // BUSCAR FILAS
    // ═══════════════════════════════════════════════════════
    let filas = [];
    
    for (const sel of selectores.filas) {
      filas = tabla.querySelectorAll(sel);
      if (filas.length > 0) break;
    }
    
    // Si no encontró con selectores específicos, buscar todas las filas del tbody
    if (filas.length === 0) {
      filas = tabla.querySelectorAll('tbody tr');
    }
    
    // ═══════════════════════════════════════════════════════
    // EXTRAER DATOS DE CADA FILA
    // ═══════════════════════════════════════════════════════
    for (let i = 0; i < filas.length; i++) {
      const fila = filas[i];
      
      // Saltar filas vacías o de mensaje
      if (fila.classList.contains('ui-datatable-empty-message')) continue;
      if (fila.querySelector('td[colspan]')) continue;
      
      const celdas = fila.querySelectorAll('td');
      if (celdas.length < 3) continue;
      
      // Detectar offset (algunas tablas tienen checkbox o índice al inicio)
      let offset = 0;
      const primeraCelda = celdas[0];
      if (primeraCelda) {
        const tieneCheckbox = primeraCelda.querySelector('input[type="checkbox"]');
        const esIndice = /^\d+$/.test(primeraCelda.textContent.trim());
        const estaVacia = !primeraCelda.textContent.trim();
        if (tieneCheckbox || esIndice || estaVacia) {
          offset = 1;
        }
      }
      
      // Extraer campos (ajustar índices según estructura de SINOE)
      // Estructura típica: [checkbox?] [índice?] [expediente] [juzgado] [fecha] [tipo] [estado] [acciones]
      const notificacion = {
        indice: i,
        filaDataRi: fila.getAttribute('data-ri'),
        expediente: (celdas[offset]?.textContent || '').trim(),
        juzgado: (celdas[offset + 1]?.textContent || '').trim(),
        fechaNotificacion: (celdas[offset + 2]?.textContent || '').trim(),
        tipo: (celdas[offset + 3]?.textContent || '').trim(),
        estado: (celdas[offset + 4]?.textContent || '').trim(),
        // Buscar botón de descarga
        tieneBotonDescarga: !!fila.querySelector('button, a[onclick*="download"]')
      };
      
      // Solo agregar si tiene datos válidos
      if (notificacion.expediente || notificacion.juzgado) {
        resultado.push(notificacion);
      }
    }
    
    return { 
      notificaciones: resultado, 
      metodo: metodoEncontrado,
      totalFilas: filas.length
    };
    
  }, SELECTORES);
  
  if (!notificaciones || notificaciones.error) {
    log('error', ctx, `Error extrayendo: ${notificaciones?.error || 'desconocido'}`);
    await diagnosticarPaginaCasillas(page, requestId);
    return [];
  }
  
  log('success', ctx, `✅ Extraídas ${notificaciones.notificaciones.length} notificaciones (${notificaciones.metodo})`);
  
  return notificaciones.notificaciones;
}

// ============================================================
// DIAGNÓSTICO DE PÁGINA
// ============================================================

/**
 * Genera un diagnóstico detallado de la página para debug.
 * 
 * @param {Page} page - Instancia de Puppeteer page
 * @param {string} requestId - ID para logs
 * @returns {Promise<object>} - Diagnóstico completo
 */
async function diagnosticarPaginaCasillas(page, requestId) {
  const ctx = `EXTRACCION:${requestId}`;
  
  log('info', ctx, '🔍 Ejecutando diagnóstico de página...');
  
  const diagnostico = await evaluarSeguro(page, () => {
    const resultado = {
      url: window.location.href,
      titulo: document.title,
      
      // Tablas encontradas
      tablas: [],
      
      // Formularios
      formularios: [],
      
      // Elementos PrimeFaces
      primefaces: {
        datatables: document.querySelectorAll('.ui-datatable').length,
        dialogs: document.querySelectorAll('.ui-dialog').length,
        panels: document.querySelectorAll('.ui-panel').length
      },
      
      // Mensajes de error o vacío
      mensajes: [],
      
      // Texto relevante
      textoRelevante: []
    };
    
    // Analizar todas las tablas
    const tablas = document.querySelectorAll('table');
    tablas.forEach((tabla, i) => {
      const info = {
        indice: i,
        id: tabla.id,
        clases: tabla.className,
        filas: tabla.querySelectorAll('tr').length,
        columnas: (tabla.querySelector('tr')?.querySelectorAll('th, td').length) || 0,
        tieneDataRi: !!tabla.querySelector('tr[data-ri]'),
        primeraCelda: tabla.querySelector('td')?.textContent?.substring(0, 50)
      };
      resultado.tablas.push(info);
    });
    
    // Analizar formularios
    const forms = document.querySelectorAll('form');
    forms.forEach((form, i) => {
      resultado.formularios.push({
        indice: i,
        id: form.id,
        action: form.action
      });
    });
    
    // Buscar mensajes
    const mensajesElementos = document.querySelectorAll(
      '.ui-messages, .ui-growl, .message, .alert, [class*="empty"]'
    );
    mensajesElementos.forEach(el => {
      const texto = el.textContent.trim();
      if (texto) resultado.mensajes.push(texto.substring(0, 100));
    });
    
    // Extraer texto relevante
    const keywords = ['notificac', 'casilla', 'expediente', 'juzgado', 'no hay', 'vacío', 'error'];
    const bodyText = document.body.innerText.toLowerCase();
    keywords.forEach(kw => {
      if (bodyText.includes(kw)) {
        const idx = bodyText.indexOf(kw);
        resultado.textoRelevante.push(bodyText.substring(Math.max(0, idx - 20), idx + 50));
      }
    });
    
    return resultado;
  });
  
  if (diagnostico) {
    log('info', ctx, '📊 Diagnóstico:', JSON.stringify(diagnostico, null, 2));
  } else {
    log('error', ctx, 'No se pudo obtener diagnóstico');
  }
  
  return diagnostico;
}

// ============================================================
// PASO 15: ABRIR MODAL DE ANEXOS
// ============================================================

/**
 * Abre el modal de anexos para una fila específica.
 * 
 * @param {Page} page - Instancia de Puppeteer page
 * @param {number} indiceFila - Índice de la fila (data-ri o índice visual)
 * @param {string} requestId - ID para logs
 * @returns {Promise<boolean>} - true si se abrió el modal
 */
async function abrirModalAnexos(page, indiceFila, requestId) {
  const ctx = `EXTRACCION:${requestId}`;
  
  log('info', ctx, `Abriendo modal de anexos para fila ${indiceFila}...`);
  
  const abierto = await evaluarSeguro(page, (indice, selectores) => {
    // Buscar la fila
    const fila = document.querySelector(`tr[data-ri="${indice}"]`) ||
                 document.querySelectorAll('tbody tr')[indice];
    
    if (!fila) return { error: 'Fila no encontrada' };
    
    // Buscar botón de descarga/anexos en la fila
    let boton = null;
    for (const sel of selectores) {
      boton = fila.querySelector(sel);
      if (boton) break;
    }
    
    if (!boton) {
      // Intentar con cualquier botón en la fila
      boton = fila.querySelector('button, a.ui-commandlink');
    }
    
    if (!boton) return { error: 'Botón no encontrado' };
    
    // Hacer clic
    if (typeof jQuery !== 'undefined') {
      jQuery(boton).trigger('click');
    } else {
      boton.click();
    }
    
    return { exito: true };
    
  }, indiceFila, SELECTORES.botonDescarga);
  
  if (!abierto || abierto.error) {
    log('error', ctx, `Error abriendo modal: ${abierto?.error || 'desconocido'}`);
    return false;
  }
  
  // Esperar que aparezca el modal
  await delay(2000);
  
  // Verificar que se abrió
  const modalVisible = await evaluarSeguro(page, (sel) => {
    const modal = document.querySelector(sel);
    return modal && window.getComputedStyle(modal).display !== 'none';
  }, SELECTORES.modal.contenedor);
  
  if (modalVisible) {
    log('success', ctx, '✅ Modal abierto');
    return true;
  }
  
  log('warn', ctx, 'Modal no se abrió');
  return false;
}

// ============================================================
// PASO 15: DESCARGAR CONSOLIDADO
// ============================================================

/**
 * Descarga el PDF consolidado desde el modal abierto.
 * 
 * @param {Page} page - Instancia de Puppeteer page
 * @param {string} requestId - ID para logs
 * @returns {Promise<{exito: boolean, error?: string}>}
 */
async function descargarConsolidado(page, requestId) {
  const ctx = `EXTRACCION:${requestId}`;
  
  log('info', ctx, 'Buscando botón de descarga consolidado...');
  
  const resultado = await evaluarSeguro(page, () => {
    // Buscar dentro del modal visible
    const modal = document.querySelector('.ui-dialog[aria-hidden="false"]');
    const contenedor = modal || document;
    
    // Estrategia 1: Por ID
    let boton = contenedor.querySelector('[id*="consolidado" i]');
    
    // Estrategia 2: Por texto
    if (!boton) {
      const botones = contenedor.querySelectorAll('button, a.ui-commandlink');
      for (const btn of botones) {
        const texto = (btn.textContent || '').toLowerCase();
        if (texto.includes('consolidado') || texto.includes('descargar todo')) {
          boton = btn;
          break;
        }
      }
    }
    
    // Estrategia 3: Por onclick
    if (!boton) {
      const botones = contenedor.querySelectorAll('[onclick*="download"], [onclick*="consolidado"]');
      if (botones.length > 0) boton = botones[0];
    }
    
    // Estrategia 4: Primer botón de descarga en el modal
    if (!boton && modal) {
      boton = modal.querySelector('button .ui-icon-download')?.closest('button') ||
              modal.querySelector('a[href*=".pdf"]');
    }
    
    if (!boton) {
      return { error: 'Botón consolidado no encontrado' };
    }
    
    // Hacer clic
    if (typeof jQuery !== 'undefined') {
      jQuery(boton).trigger('click');
    } else {
      boton.click();
    }
    
    return { exito: true };
  });
  
  if (!resultado || resultado.error) {
    log('error', ctx, `Error descargando: ${resultado?.error || 'desconocido'}`);
    return { exito: false, error: resultado?.error };
  }
  
  log('success', ctx, '✅ Descarga iniciada');
  
  // Esperar que inicie la descarga
  await delay(3000);
  
  return { exito: true };
}

// ============================================================
// PASO 15: CERRAR MODAL
// ============================================================

/**
 * Cierra el modal de anexos.
 * 
 * @param {Page} page - Instancia de Puppeteer page
 * @param {string} requestId - ID para logs
 * @returns {Promise<boolean>}
 */
async function cerrarModal(page, requestId) {
  const ctx = `EXTRACCION:${requestId}`;
  
  const cerrado = await evaluarSeguro(page, () => {
    // Estrategia 1: Botón X
    const btnX = document.querySelector('.ui-dialog[aria-hidden="false"] .ui-dialog-titlebar-close');
    if (btnX) {
      btnX.click();
      return true;
    }
    
    // Estrategia 2: Botón "Cerrar"
    const modal = document.querySelector('.ui-dialog[aria-hidden="false"]');
    if (modal) {
      const botones = modal.querySelectorAll('button');
      for (const btn of botones) {
        if ((btn.textContent || '').toLowerCase().includes('cerrar')) {
          btn.click();
          return true;
        }
      }
    }
    
    return false;
  });
  
  if (cerrado) {
    log('info', ctx, 'Modal cerrado');
    await delay(500);
    return true;
  }
  
  // Estrategia 3: Tecla Escape
  try {
    await page.keyboard.press('Escape');
    log('info', ctx, 'Modal cerrado (Escape)');
    await delay(500);
    return true;
  } catch (e) {
    log('warn', ctx, 'No se pudo cerrar modal');
    return false;
  }
}

// ============================================================
// PASO 15: PROCESAR TODAS LAS NOTIFICACIONES
// ============================================================

/**
 * Procesa todas las notificaciones: abre modal, descarga, cierra.
 * 
 * @param {Page} page - Instancia de Puppeteer page
 * @param {Array} notificaciones - Lista de notificaciones extraídas
 * @param {string} requestId - ID para logs
 * @returns {Promise<{exitosas: number, fallidas: number, detalles: Array}>}
 */
async function procesarNotificaciones(page, notificaciones, requestId) {
  const ctx = `EXTRACCION:${requestId}`;
  
  const resultado = {
    exitosas: 0,
    fallidas: 0,
    detalles: []
  };
  
  log('info', ctx, `Procesando ${notificaciones.length} notificaciones...`);
  
  for (let i = 0; i < notificaciones.length; i++) {
    const notif = notificaciones[i];
    const indice = notif.filaDataRi || i;
    
    log('info', ctx, `[${i + 1}/${notificaciones.length}] Procesando: ${notif.expediente || 'Sin expediente'}`);
    
    try {
      // 1. Abrir modal
      const modalAbierto = await abrirModalAnexos(page, indice, requestId);
      
      if (!modalAbierto) {
        resultado.fallidas++;
        resultado.detalles.push({
          indice: i,
          expediente: notif.expediente,
          error: 'No se pudo abrir modal'
        });
        continue;
      }
      
      // 2. Descargar consolidado
      const descarga = await descargarConsolidado(page, requestId);
      
      if (!descarga.exito) {
        resultado.fallidas++;
        resultado.detalles.push({
          indice: i,
          expediente: notif.expediente,
          error: descarga.error
        });
      } else {
        resultado.exitosas++;
        resultado.detalles.push({
          indice: i,
          expediente: notif.expediente,
          exito: true
        });
      }
      
      // 3. Cerrar modal
      await cerrarModal(page, requestId);
      
      // 4. Pausa entre notificaciones
      await delay(1500);
      
    } catch (error) {
      log('error', ctx, `Error procesando fila ${i}: ${error.message}`);
      resultado.fallidas++;
      resultado.detalles.push({
        indice: i,
        expediente: notif.expediente,
        error: error.message
      });
      
      // Intentar cerrar modal si quedó abierto
      await cerrarModal(page, requestId);
    }
  }
  
  log('info', ctx, `Procesamiento completo: ${resultado.exitosas} exitosas, ${resultado.fallidas} fallidas`);
  
  return resultado;
}

// ============================================================
// CAPTURAR SCREENSHOT PARA DEBUG
// ============================================================

/**
 * Captura screenshot de la página actual para debug.
 * 
 * @param {Page} page - Instancia de Puppeteer page
 * @param {string} requestId - ID para logs
 * @returns {Promise<string|null>} - Base64 del screenshot o null
 */
async function capturarPantallaCasillas(page, requestId) {
  const ctx = `EXTRACCION:${requestId}`;
  
  try {
    const screenshot = await page.screenshot({
      encoding: 'base64',
      fullPage: false
    });
    
    log('info', ctx, 'Screenshot capturado');
    return screenshot;
    
  } catch (error) {
    log('error', ctx, `Error capturando screenshot: ${error.message}`);
    return null;
  }
}

// ============================================================
// EXPORTACIONES
// ============================================================

module.exports = {
  // Paso 14
  esperarTablaCargada,
  extraerNotificaciones,
  diagnosticarPaginaCasillas,
  
  // Paso 15
  abrirModalAnexos,
  descargarConsolidado,
  cerrarModal,
  procesarNotificaciones,
  
  // Utilidades
  capturarPantallaCasillas,
  
  // Configuración (exportar para poder modificar externamente)
  SELECTORES,
  TIMEOUT_CARGA_TABLA,
  INTERVALO_VERIFICACION
};
