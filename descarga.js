/**
 * ============================================================
 * DESCARGA.JS - Descarga de PDF Consolidado
 * ============================================================
 * 
 * Propósito:
 * Descargar el PDF consolidado interceptando la respuesta HTTP
 * y capturándolo como base64, con FIX CRÍTICO del race condition.
 * 
 * FIX CRÍTICO:
 * - Delay de 500ms ANTES del click para que el listener se registre
 * - Esto resuelve el bug donde el PDF pasa por la red antes de que
 *   el event listener esté completamente registrado en el event loop
 * 
 * ============================================================
 */

const { delay, log, evaluarSeguro } = require('./core');
const { SELECTORES_MODAL } = require('./modal');

// ============================================================
// CONFIGURACIÓN
// ============================================================

const CONFIG_DESCARGA = {
  delayPreClick: 500,              // ⭐ CRÍTICO: Delay antes de click
  timeoutDescarga: 45000,          // 45s para descargas grandes
  intervaloVerificacion: 1000,     // Verificar cada 1s
  tamanoMinimoPdf: 1024,           // 1KB mínimo
  maxReintentos: 2                 // Reintentar hasta 2 veces si falla
};

// ============================================================
// FUNCIÓN PRINCIPAL
// ============================================================

/**
 * Descarga el PDF consolidado desde el modal de anexos.
 * 
 * ESTRATEGIA (FIX CRÍTICO):
 * 1. Registrar listener de 'response'
 * 2. ⭐ ESPERAR 500ms para que el listener se registre en event loop
 * 3. Hacer clic en botón "Consolidado"
 * 4. Esperar respuesta (timeout 45s)
 * 5. Filtrar respuesta por Content-Type: application/pdf
 * 6. Capturar buffer y convertir a base64
 * 7. Extraer nombre de archivo desde Content-Disposition header
 * 
 * @param {Page}   page      - Instancia de Puppeteer page
 * @param {string} requestId - ID único para logs
 * @returns {Promise<{exito: boolean, base64?: string, nombreArchivo?: string, tamano?: number, error?: string}>}
 */
async function descargarConsolidado(page, requestId) {
  const ctx = `[DESCARGA][${requestId}]`;
  
  let responseHandler = null;
  
  try {
    // Validar que page esté abierto
    if (!page || page.isClosed()) {
      log('error', ctx, 'Página cerrada');
      return {
        exito: false,
        error: 'Página cerrada'
      };
    }
    
    log('info', ctx, 'Iniciando descarga de PDF consolidado...');
    
    // Variables para captura de PDF
    let pdfCapturado = null;
    let pdfMetadata = null;
    
    // Crear Promise para captura del PDF
    const promesaPdf = new Promise((resolve, reject) => {
      
      // Timeout interno para rechazar si no llega PDF
      const timeoutId = setTimeout(() => {
        reject(new Error('Timeout esperando PDF'));
      }, CONFIG_DESCARGA.timeoutDescarga);
      
      // Handler de respuestas HTTP
      responseHandler = async (response) => {
        try {
          const url = response.url();
          const headers = response.headers();
          const contentType = headers['content-type'] || '';
          const status = response.status();
          
          // Filtro 1: Debe ser PDF
          if (!contentType.includes('application/pdf')) {
            return;
          }
          
          // Filtro 2: Debe ser del dominio de SINOE
          if (!url.includes('cej.pj.gob.pe')) {
            log('warn', ctx, `PDF desde dominio no esperado: ${url}`);
            return;
          }
          
          // Filtro 3: Solo responses exitosos
          if (status !== 200) {
            log('warn', ctx, `PDF response con status ${status}`);
            return;
          }
          
          log('info', ctx, `PDF detectado en respuesta HTTP (${status})`);
          
          // Capturar buffer
          const buffer = await response.buffer();
          
          // Validación: PDF debe tener header mágico "%PDF"
          const magicNumber = buffer.toString('hex', 0, 4);
          if (magicNumber !== '25504446') { // "%PDF" en hex
            log('warn', ctx, `Response no es un PDF válido (magic: ${magicNumber})`);
            return;
          }
          
          const base64 = buffer.toString('base64');
          const tamano = buffer.length;
          
          // Validación: Tamaño mínimo
          if (tamano < CONFIG_DESCARGA.tamanoMinimoPdf) {
            log('error', ctx, `PDF muy pequeño (${tamano} bytes) — posible error`);
            clearTimeout(timeoutId);
            reject(new Error(`PDF muy pequeño (${tamano} bytes)`));
            return;
          }
          
          // Extraer nombre de archivo desde Content-Disposition
          const contentDisposition = headers['content-disposition'] || '';
          let nombreArchivo = 'consolidado.pdf';
          
          if (contentDisposition) {
            const matchFilename = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
            if (matchFilename && matchFilename[1]) {
              nombreArchivo = matchFilename[1].replace(/['"]/g, '');
              
              // Decodificar si está en formato RFC 2231 (filename*=UTF-8''...)
              if (nombreArchivo.includes('UTF-8')) {
                const parts = nombreArchivo.split("''");
                if (parts.length > 1) {
                  nombreArchivo = decodeURIComponent(parts[1]);
                }
              } else {
                try {
                  nombreArchivo = decodeURIComponent(nombreArchivo);
                } catch (e) {
                  // Si falla decodificación, dejar como está
                }
              }
            }
          }
          
          log('success', ctx, `✓ PDF capturado: ${nombreArchivo} (${Math.round(tamano / 1024)}KB)`);
          
          // Guardar metadata para validación final
          pdfMetadata = {
            url: url,
            tamano: tamano,
            contentType: contentType,
            nombreArchivo: nombreArchivo
          };
          
          // Validación final: Verificar integridad de base64
          try {
            const testBuffer = Buffer.from(base64, 'base64');
            if (testBuffer.length !== tamano) {
              throw new Error('Corrupción en conversión base64');
            }
          } catch (error) {
            log('error', ctx, `PDF corrupto: ${error.message}`);
            clearTimeout(timeoutId);
            reject(new Error(`PDF corrupto: ${error.message}`));
            return;
          }
          
          // ✅ PDF válido capturado
          pdfCapturado = {
            exito: true,
            base64: base64,
            nombreArchivo: nombreArchivo,
            tamano: tamano
          };
          
          clearTimeout(timeoutId);
          resolve(pdfCapturado);
          
        } catch (error) {
          log('error', ctx, `Error en responseHandler: ${error.message}`);
          clearTimeout(timeoutId);
          reject(error);
        }
      };
      
      // Registrar listener
      page.on('response', responseHandler);
    });
    
    // ⭐ FIX CRÍTICO: Esperar 500ms para que el listener se registre en event loop
    log('info', ctx, '⭐ Esperando registro de listener (fix race condition)...');
    await delay(CONFIG_DESCARGA.delayPreClick);
    
    log('info', ctx, 'Listener registrado, ejecutando clic en Consolidado...');
    
    // Hacer clic en botón "Consolidado"
    const clicOk = await evaluarSeguro(page, (selectores) => {
      // Buscar modal visible
      const modal = document.querySelector('.ui-dialog[aria-hidden="false"]');
      if (!modal) {
        return { exito: false, error: 'Modal no encontrado' };
      }
      
      // Buscar botón Consolidado
      let boton = null;
      for (const selector of selectores.botonConsolidado) {
        const btn = modal.querySelector(selector);
        if (btn && !btn.disabled && !btn.classList.contains('ui-state-disabled')) {
          boton = btn;
          break;
        }
      }
      
      if (!boton) {
        return { exito: false, error: 'Botón Consolidado no encontrado' };
      }
      
      // Click con jQuery si está disponible (más confiable en PrimeFaces)
      if (typeof jQuery !== 'undefined' && jQuery(boton).length > 0) {
        jQuery(boton).trigger('click');
      } else {
        boton.click();
      }
      
      return { 
        exito: true, 
        botonId: boton.id || boton.className 
      };
      
    }, SELECTORES_MODAL);
    
    if (!clicOk || !clicOk.exito) {
      // Limpiar listener
      if (responseHandler) {
        page.off('response', responseHandler);
      }
      
      log('error', ctx, `Error al hacer clic: ${clicOk?.error || 'null'}`);
      return {
        exito: false,
        error: `Error al hacer clic en Consolidado: ${clicOk?.error || 'evaluación retornó null'}`
      };
    }
    
    log('info', ctx, `Clic ejecutado (${clicOk.botonId}), esperando PDF...`);
    
    // Esperar PDF con timeout
    try {
      const resultado = await promesaPdf;
      
      // Limpiar listener
      if (responseHandler) {
        page.off('response', responseHandler);
      }
      
      log('success', ctx, `✓ Descarga completada: ${resultado.nombreArchivo}`);
      
      return resultado;
      
    } catch (timeoutError) {
      // Limpiar listener
      if (responseHandler) {
        page.off('response', responseHandler);
      }
      
      log('error', ctx, `Timeout esperando PDF: ${timeoutError.message}`);
      
      return {
        exito: false,
        error: `Timeout esperando PDF (${CONFIG_DESCARGA.timeoutDescarga / 1000}s)`
      };
    }
    
  } catch (error) {
    // Limpiar listener en caso de error
    if (responseHandler) {
      try {
        page.off('response', responseHandler);
      } catch (e) {
        // Ignorar errores al limpiar
      }
    }
    
    log('error', ctx, `Error inesperado: ${error.message}`);
    
    return {
      exito: false,
      error: `Error inesperado: ${error.message}`
    };
  }
}

// ============================================================
// FUNCIÓN DE VALIDACIÓN POST-DESCARGA
// ============================================================

/**
 * Valida que un PDF descargado sea válido.
 * 
 * @param {string} base64 - PDF en base64
 * @returns {{valido: boolean, error?: string, detalles?: Object}}
 */
function validarPdfDescargado(base64) {
  try {
    // Convertir a buffer
    const buffer = Buffer.from(base64, 'base64');
    const tamano = buffer.length;
    
    // Validación 1: Tamaño mínimo
    if (tamano < CONFIG_DESCARGA.tamanoMinimoPdf) {
      return {
        valido: false,
        error: `PDF muy pequeño (${tamano} bytes)`,
        detalles: { tamano }
      };
    }
    
    // Validación 2: Magic number
    const magicNumber = buffer.toString('hex', 0, 4);
    if (magicNumber !== '25504446') { // "%PDF"
      return {
        valido: false,
        error: `Magic number incorrecto (${magicNumber})`,
        detalles: { magicNumber, esperado: '25504446' }
      };
    }
    
    // Validación 3: Tiene EOF marker
    const finalBytes = buffer.toString('ascii', Math.max(0, tamano - 50));
    const tieneEOF = finalBytes.includes('%%EOF');
    
    if (!tieneEOF) {
      return {
        valido: false,
        error: 'PDF no tiene EOF marker',
        detalles: { tamano, finalBytes }
      };
    }
    
    return {
      valido: true,
      detalles: {
        tamano,
        tamanoKB: Math.round(tamano / 1024),
        magicNumber,
        tieneEOF
      }
    };
    
  } catch (error) {
    return {
      valido: false,
      error: `Error validando PDF: ${error.message}`
    };
  }
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  descargarConsolidado,
  validarPdfDescargado,
  CONFIG_DESCARGA
};
