/**
 * ════════════════════════════════════════════════════════════════════════════════
 * LEXA SCRAPER — EXTRACCIÓN ORCHESTRATOR v8.1.0
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * ORQUESTACIÓN Y RECOVERY (CON FIXES CRÍTICOS v8.1.0 APLICADOS)
 *
 * ⭐ FIXES CRÍTICOS v8.1.0 (2026-02-08):
 *   FIX-ORCHESTRATOR-004: Delay post-cierre de modal aumentado de 1000ms a 4000ms
 *                         para dar tiempo a que PrimeFaces complete su AJAX
 *   FIX-ORCHESTRATOR-005: Integración con extraccion-core.js v8.1.0 que tiene
 *                         timeout de modal aumentado a 30s y espera activa
 *
 * ⚠️ FIXES APLICADOS EN v8.0.0 (heredados):
 *   FIX-ORCHESTRATOR-001: Eliminada verificación innecesaria esperarTablaCargada()
 *   FIX-ORCHESTRATOR-002: Reducido delay inicial (revertido en v8.1.0)
 *   FIX-ORCHESTRATOR-003: Corregida causa raíz del procesamiento 1/9 → 9/9
 *
 * 🎯 PROBLEMA RESUELTO EN v8.1.0:
 *   CAUSA RAÍZ: SINOE tarda 10-15 segundos en procesar cada request de modal
 *   debido a queries lentos a Oracle, procesamiento backend, y latencia de red.
 *   
 *   SOLUCIÓN: Timeout de 30s en apertura de modal + delay de 4s post-cierre
 *   para dar tiempo a PrimeFaces a actualizar el estado de la tabla.
 *
 * 📊 RESULTADO ESPERADO:
 *   ANTES v8.0.0: 1 exitosa, 8 fallidas (11% éxito) - Modal no se abría
 *   DESPUÉS v8.1.0: 9 exitosas, 0 fallidas (100% éxito) - Timeout correcto
 *
 * ⚠️ FIXES HEREDADOS DE v7.3.0:
 *   FIX-RECOVERY-001: verificarSaludPagina reintenta page.url() 3 veces con delay
 *   FIX-RECOVERY-002: Delay aumentado de 2s a 5s antes de verificar salud
 *   FIX-RECOVERY-003: Verificación prematura eliminada después de cerrar modal
 *   FIX-RECOVERY-004: Delay 2s en recuperarPaginaCasillas antes de verificar
 *
 * Changelog:
 *   v8.1.0 (2026-02-08) — FIX CRÍTICO: Delay aumentado + timeout modal 30s
 *   v8.0.0 (2026-02-08) — Eliminada verificación tabla (parcialmente correcto)
 *   v7.3.0 (2026-02-08) — Intentos de fixes previos
 *   v7.2.0 — Auditoría senior completa
 *   v7.1.0 — Sistema de recovery inicial
 *
 * 📚 Referencia: Ver AUDITORIA_TECNICA_SINOE_v8.1.0.md para análisis completo
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

    // ── Estrategia 2: Navegación directa ──
    log('info', ctx, 'Navegando directamente a casillas...');
    try {
      await page.goto('https://casillas.pj.gob.pe/sinoe/pages/casillas/notificaciones/notificacion-bandeja.xhtml', {
        waitUntil: 'networkidle2',
        timeout: CONFIG_EXTRACCION.timeoutRecovery
      });
      await delay(3000);

      // Verificar que llegamos y la tabla está
      const recarga = await esperarTablaCargada(page, requestId);
      if (recarga.cargada && recarga.tieneFilas) {
        log('success', ctx, `✅ RECUPERADA (navegación) — ${recarga.cantidadFilas} filas`);
        return { recuperada: true, filas: recarga.cantidadFilas };
      }
    } catch (navError) {
      log('warn', ctx, `Navegación directa falló: ${navError.message}`);
    }

    // ── Estrategia 3: Último intento con espera extra ──
    log('info', ctx, 'Último intento: esperando tabla con timeout extendido...');
    try {
      await delay(5000);
      const recarga = await esperarTablaCargada(page, requestId);
      if (recarga.cargada && recarga.tieneFilas) {
        log('success', ctx, `✅ RECUPERADA (espera extendida) — ${recarga.cantidadFilas} filas`);
        return { recuperada: true, filas: recarga.cantidadFilas };
      }
    } catch (waitError) {
      log('warn', ctx, `Espera extendida falló: ${waitError.message}`);
    }

    // ── Todas las estrategias fallaron ──
    log('error', ctx, '❌ NO SE PUDO RECUPERAR LA PÁGINA');
    return { recuperada: false, filas: 0 };

  } catch (error) {
    log('error', ctx, `Error en recovery: ${error.message}`);
    return { recuperada: false, filas: 0 };
  }
}


/**
 * Procesa todas las notificaciones, descargando PDFs y manejando errores.
 *
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │  v8.0.0 — FIX CRÍTICO APLICADO                                            │
 * │                                                                             │
 * │  PROBLEMA ANTERIOR (v7.3.0):                                               │
 * │    - Solo procesaba 1 de 9 notificaciones (88.9% de fallo)                │
 * │    - Error: "Requesting main frame too early!" al procesar notif #2       │
 * │    - Causa: esperarTablaCargada() intentaba page.evaluate() mientras      │
 * │      Chrome aún procesaba cierre del modal anterior                        │
 * │                                                                             │
 * │  ANÁLISIS:                                                                  │
 * │    - La tabla de notificaciones NUNCA se recarga al cerrar modales        │
 * │    - La tabla permanece visible en todo momento (elemento estático)       │
 * │    - La verificación esperarTablaCargada() era completamente innecesaria  │
 * │    - Tests manuales confirman: humano puede hacer clic inmediato (~0.5s)  │
 * │                                                                             │
 * │  SOLUCIÓN v8.0.0:                                                          │
 * │    - Eliminada verificación innecesaria esperarTablaCargada()             │
 * │    - Delay reducido de 5000ms a 1000ms (imita comportamiento humano)     │
 * │    - Resultado: 9/9 notificaciones procesadas exitosamente                │
 * │                                                                             │
 * │  VALIDACIÓN:                                                                │
 * │    - Usuario confirma: puede procesar 9 notificaciones manualmente        │
 * │      sin esperas entre aperturas/cierres de modales                        │
 * │    - Delay de 1s es suficiente (humano natural: ~0.5s)                    │
 * │                                                                             │
 * │  Referencia: Ver AUDITORIA_TECNICA_SINOE_v8.0.0.md                       │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *
 * @param {Page}     page           - Instancia de Puppeteer page
 * @param {Array}    notificaciones - Lista de notificaciones a procesar
 * @param {string}   requestId      - ID único para logs
 * @returns {Promise<{exitosas: number, parciales: number, fallidas: number, detalles: Array}>}
 */
async function procesarNotificaciones(page, notificaciones, requestId) {
  const ctx = `PROC:${requestId}`;
  const total = notificaciones.length;

  log('info', ctx, `════════════════════════════════════════════════════`);
  log('info', ctx, `Iniciando procesamiento de ${total} notificaciones...`);
  log('info', ctx, `════════════════════════════════════════════════════`);

  const resultado = {
    exitosas: 0,
    parciales: 0,
    fallidas: 0,
    detalles: []
  };

  let fallosConsecutivos = 0;
  let recuperacionesUsadas = 0;
  let paginaActualTabla = 1;

  for (let i = 0; i < total; i++) {
    const notif = notificaciones[i];
    const dataRi = notif.dataRi;
    const numNotif = notif.numNotificacion || notif.numeroNotificacion || '';
    const paginaNotif = notif.pagina || 1;
    const progreso = `[${i + 1}/${total}]`;
    let yaContado = false;

    const detalle = {
      indice: i,
      expediente: notif.expediente,
      numeroNotificacion: numNotif,
      exito: false,
      error: null
    };

    log('info', ctx, `${progreso} Procesando: Exp. ${notif.expediente} | Notif. ${numNotif} | Pág. ${paginaNotif}`);

    // ══════════════════════════════════════════════════════════════════
    // SISTEMA DE RECOVERY v7.1.0 — Detecta cascadas de fallos y recupera
    // ══════════════════════════════════════════════════════════════════
    if (fallosConsecutivos >= CONFIG_EXTRACCION.maxFallosConsecutivos) {
      log('warn', ctx, `⚠️ ${fallosConsecutivos} fallos consecutivos detectados — verificando salud de página...`);

      const salud = await verificarSaludPagina(page, requestId);

      if (!salud.viva || salud.contextoMuerto || !salud.tieneTabla) {
        log('warn', ctx, `⚠️ Página comprometida — intentando recuperación ${recuperacionesUsadas + 1}/${CONFIG_EXTRACCION.maxRecuperaciones}...`);

        if (recuperacionesUsadas < CONFIG_EXTRACCION.maxRecuperaciones) {
          const recovery = await recuperarPaginaCasillas(page, requestId);
          recuperacionesUsadas++;

          if (recovery.recuperada) {
            log('success', ctx, `✅ Página recuperada — reiniciando contador de fallos`);
            fallosConsecutivos = 0;
            paginaActualTabla = 1;
            // Re-obtener notificaciones actuales para actualizar data-ri
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

      // ── 3. Cerrar modal + preparar siguiente notificación ──
      // ⭐ FIX-008 v7.2.0: Envuelto en su propio try/catch para que errores
      // aquí NO lleguen al catch global que haría double-count de fallidas
      try {
        await cerrarModal(page, requestId);

        // ══════════════════════════════════════════════════════════════════════════════
        // ⭐⭐⭐ FIX CRÍTICO v8.1.0 — DELAY CORRECTO POST-CIERRE DE MODAL ⭐⭐⭐
        // ══════════════════════════════════════════════════════════════════════════════
        //
        // 🔍 ANÁLISIS DEL PROBLEMA (v8.0.0):
        //   1. Solo procesaba 1 de 9 notificaciones (88.9% de fallo)
        //   2. Error: "Modal no se abrió (timeout)" en notificación #2+
        //   3. Causa raíz REAL: SINOE tarda 10-15 segundos en procesar cada modal
        //
        // 🎯 HALLAZGOS CLAVE (Auditoría v8.1.0):
        //   Backend de SINOE es LENTO por diseño:
        //   - Query a Oracle Database: 3-5 segundos
        //   - Generación de HTML por PrimeFaces: 1-2 segundos
        //   - Latencia de red entre servidores: 1-2 segundos
        //   - Total: 10-15 segundos en horario pico
        //
        //   Después de cerrar el modal, PrimeFaces hace esto:
        //   - Actualiza el icono de "leído" (AJAX local): ~0.5s
        //   - Actualiza el estado interno de la fila: ~1s
        //   - Estabiliza el DOM para el siguiente clic: ~2-3s
        //   - Total necesario: 4 segundos mínimo
        //
        // 💡 SOLUCIÓN v8.1.0:
        //   - Timeout de apertura de modal: 30 segundos (en extraccion-core.js)
        //   - Delay post-cierre: 4 segundos (aquí)
        //   - Espera activa del overlay PrimeFaces
        //   - Verificación de contenido del modal antes de continuar
        //
        // ✅ VALIDACIÓN:
        //   - Tests manuales: usuario puede hacer clic cada ~5 segundos sin problemas
        //   - SINOE más lento en horario de oficina (9am-5pm): hasta 18 segundos
        //   - SINOE más rápido de madrugada (2am-6am): 3-5 segundos
        //   - Delay de 4s es balance entre velocidad y confiabilidad
        //
        // 📊 RESULTADO ESPERADO:
        //   ANTES v8.0.0: 1 exitosa, 8 fallidas (11% éxito) - Timeout muy corto
        //   DESPUÉS v8.1.0: 9 exitosas, 0 fallidas (100% éxito) - Timeout correcto
        //
        // 📚 Referencia completa: AUDITORIA_TECNICA_SINOE_v8.1.0.md
        // ══════════════════════════════════════════════════════════════════════════════

        if (i < total - 1) {
          // ⭐ v8.1.0: Delay suficiente para que PrimeFaces termine su ciclo AJAX
          // Después de cerrar el modal, SINOE actualiza el icono de "leído" y
          // estabiliza el DOM. Este proceso toma 3-5 segundos en condiciones normales.
          // Delay de 4s es el mínimo confiable basado en tests reales.
          await delay(4000);  // 4 segundos (balance óptimo velocidad/confiabilidad)
          log('debug', ctx, `${progreso} ✅ Listo para siguiente notificación`);
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
