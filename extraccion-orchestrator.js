/**
 * ════════════════════════════════════════════════════════════════════════════════
 * LEXA SCRAPER — EXTRACCIÓN ORCHESTRATOR v8.2.0 (FINAL)
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * PRINCIPIO RECTOR:
 *   SINOE + PrimeFaces NO es observable por eventos.
 *   El comportamiento humano se imita SOLO con TIEMPO.
 *
 *   → No esperar DOM
 *   → No esperar tabla
 *   → No inspeccionar JS innecesariamente
 *
 *   ✔ Click
 *   ✔ Esperar
 *   ✔ Continuar
 *
 * ════════════════════════════════════════════════════════════════════════════════
 */

'use strict';

// ────────────────────────────────────────────────────────────────────────────────
// IMPORTACIONES
// ────────────────────────────────────────────────────────────────────────────────

const core = require('./core');
const extractionCore = require('./extraccion-core');

const { delay, log } = core;

const {
  abrirModalAnexos,
  descargarConsolidado,
  cerrarModal,
  navegarAPagina,
  CONFIG_EXTRACCION
} = extractionCore;

// ────────────────────────────────────────────────────────────────────────────────
// ESPERA HUMANA (CONCEPTO CENTRAL)
// ────────────────────────────────────────────────────────────────────────────────

async function esperarEstabilizacionHumana(requestId, motivo = '') {
  const ctx = `ESPERA:${requestId}`;
  log('debug', ctx, `⏳ Espera humana 4s ${motivo ? `(${motivo})` : ''}`);
  await delay(4000);
}

// ────────────────────────────────────────────────────────────────────────────────
// SALUD DE PÁGINA (VERSIÓN HUMANA)
// ────────────────────────────────────────────────────────────────────────────────

async function verificarSaludPagina(page, requestId) {
  const ctx = `SALUD:${requestId}`;

  try {
    if (page.isClosed()) {
      log('error', ctx, 'Página cerrada');
      return { viva: false };
    }

    let url;
    try {
      url = page.url();
    } catch {
      log('warn', ctx, 'No se pudo obtener URL');
      return { viva: false };
    }

    const enCasillas =
      url.includes('notificacion-bandeja') ||
      url.includes('casillas');

    log('debug', ctx, `Página viva (${enCasillas ? 'casillas' : 'otra'})`);
    return { viva: true, enCasillas, url };

  } catch (e) {
    log('error', ctx, `Error salud: ${e.message}`);
    return { viva: false };
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// RECOVERY SIMPLE Y ROBUSTO
// ────────────────────────────────────────────────────────────────────────────────

async function recuperarPaginaCasillas(page, requestId) {
  const ctx = `RECOVERY:${requestId}`;

  log('warn', ctx, '🔄 Recovery iniciado');

  try {
    await page.goto(
      'https://casillas.pj.gob.pe/sinoe/pages/casillas/notificaciones/notificacion-bandeja.xhtml',
      { waitUntil: 'networkidle2', timeout: CONFIG_EXTRACCION.timeoutRecovery }
    );

    await delay(5000);
    log('success', ctx, 'Página de casillas recuperada');
    return { recuperada: true };

  } catch (e) {
    log('error', ctx, `Recovery falló: ${e.message}`);
    return { recuperada: false };
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// PROCESAMIENTO PRINCIPAL
// ────────────────────────────────────────────────────────────────────────────────

async function procesarNotificaciones(page, notificaciones, requestId) {
  const ctx = `PROC:${requestId}`;
  const total = notificaciones.length;

  log('info', ctx, `════════════════════════════════════════`);
  log('info', ctx, `Procesando ${total} notificaciones`);
  log('info', ctx, `════════════════════════════════════════`);

  const resultado = {
    exitosas: 0,
    parciales: 0,
    fallidas: 0,
    detalles: []
  };

  let paginaActual = 1;
  let fallosConsecutivos = 0;

  for (let i = 0; i < total; i++) {
    const notif = notificaciones[i];
    const progreso = `[${i + 1}/${total}]`;

    const detalle = {
      indice: i,
      expediente: notif.expediente,
      numeroNotificacion: notif.numNotificacion || '',
      exito: false,
      error: null
    };

    log('info', ctx, `${progreso} Exp. ${notif.expediente}`);

    try {
      // ── Navegación de página (si aplica) ──
      if (notif.pagina && notif.pagina !== paginaActual) {
        await navegarAPagina(page, notif.pagina, requestId);
        paginaActual = notif.pagina;
        await delay(2000);
      }

      // ── Abrir modal ──
      const modal = await abrirModalAnexos(
        page,
        notif.dataRi,
        requestId,
        notif.numNotificacion
      );

      if (!modal.exito) {
        throw new Error(modal.error || 'No se abrió el modal');
      }

      await esperarEstabilizacionHumana(requestId, 'apertura modal');

      // ── Descargar ──
      const descarga = await descargarConsolidado(page, requestId);

      if (!descarga.exito) {
        throw new Error(descarga.error || 'Descarga fallida');
      }

      if (descarga.base64) {
        notif.pdf = descarga.base64;
        notif.archivo = descarga.base64;
        notif.nombreArchivo =
          `${(notif.numNotificacion || 'doc').replace(/\//g, '_')}_Consolidado.pdf`;

        resultado.exitosas++;
        detalle.exito = true;
      } else {
        resultado.parciales++;
        detalle.exito = true;
        detalle.sinBase64 = true;
      }

      // ── Cerrar modal ──
      await cerrarModal(page, requestId);
      await esperarEstabilizacionHumana(requestId, 'post-cierre modal');

      fallosConsecutivos = 0;

    } catch (e) {
      detalle.error = e.message;
      resultado.fallidas++;
      fallosConsecutivos++;

      log('warn', ctx, `${progreso} ✗ ${e.message}`);

      try {
        await cerrarModal(page, requestId);
      } catch {}

      await esperarEstabilizacionHumana(requestId, 'post-error');

      if (fallosConsecutivos >= CONFIG_EXTRACCION.maxFallosConsecutivos) {
        const recovery = await recuperarPaginaCasillas(page, requestId);
        if (!recovery.recuperada) break;
        fallosConsecutivos = 0;
        paginaActual = 1;
      }
    }

    resultado.detalles.push(detalle);
  }

  log('info', ctx, `════════════════════════════════════════`);
  log(
    'info',
    ctx,
    `RESUMEN → ${resultado.exitosas} ok | ${resultado.parciales} parciales | ${resultado.fallidas} fallidas`
  );
  log('info', ctx, `════════════════════════════════════════`);

  return resultado;
}

// ────────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────────────────────

module.exports = {
  verificarSaludPagina,
  recuperarPaginaCasillas,
  procesarNotificaciones
};
