/**
 * ════════════════════════════════════════════════════════════════════════════════
 * LEXA SCRAPER — EXTRACCIÓN ORCHESTRATOR v7.3.0
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * ORQUESTACIÓN Y RECOVERY (CON FIXES APLICADOS)
 *
 * ⚠️ FIXES APLICADOS EN v7.3.0:
 *   FIX-RECOVERY-001: verificarSaludPagina reintenta page.url() 3 veces con delay
 *   FIX-RECOVERY-002: Delay aumentado de 2s a 5s antes de verificar salud
 *   FIX-RECOVERY-003: Verificación prematura eliminada después de cerrar modal
 *   FIX-RECOVERY-004: Delay 2s en recuperarPaginaCasillas antes de verificar
 *
 * Changelog:
 *   v7.3.0 (2026-02-08) — FIXES CRÍTICOS aplicados
 *   v7.2.0 — Auditoría senior completa
 *   v7.1.0 — Sistema de recovery inicial
 *
 * ════════════════════════════════════════════════════════════════════════════════
 */

'use strict';

// ════════════════════════════════════════════════════════════════════════════════
// IMPORTACIONES
// ════════════════════════════════════════════════════════════════════════════════

const core = require('./core');
const extractionCore = require('./extraccion-core');

const { delay, log, evaluarSeguro } = core;

const {
  esperarTablaCargada,
  abrirModalAnexos,
  descargarConsolidado,
  cerrarModal,
  navegarAPagina,
  SELECTORES,
  CONFIG_EXTRACCION
} = extractionCore;

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
    // ⭐ FIX-001 v7.3.0: Reintentar page.url() con delay
    let url = null;
    let intentos = 0;
    const maxIntentos = 3;

    while (intentos < maxIntentos && !url) {
      intentos++;
      try {
        url = page.url();
      } catch (e) {
        if (intentos < maxIntentos) {
          log('warn', ctx, `Intento ${intentos}/${maxIntentos}: ${e.message} — reintentando en 1s...`);
          await delay(1000);
        } else {
          log('error', ctx, `No se puede obtener URL después de ${maxIntentos} intentos: ${e.message}`);
          return { viva: false, enCasillas: false, tieneTabla: false, url: 'error' };
        }
      }
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
    // ⭐ FIX-004 v7.3.0: Esperar 2s antes de verificar salud
    await delay(2000);

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
          // ⭐ FIX-002 v7.3.0: Delay aumentado de 2s a 5s
          await delay(5000);

          // ⭐ FIX-003 v7.3.0: Eliminada verificación prematura
          // Va directo a esperarTablaCargada, que es más resiliente

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
// EXPORTS
// ════════════════════════════════════════════════════════════════════════════════

module.exports = {
  verificarSaludPagina,
  recuperarPaginaCasillas,
  procesarNotificaciones
};
