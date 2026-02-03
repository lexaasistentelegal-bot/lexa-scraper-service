const express = require('express');
const puppeteer = require('puppeteer-core');

const app = express();
app.use(express.json());

const CONFIG = {
  BROWSERLESS_WS: process.env.BROWSERLESS_URL || 'wss://browser.lexaasistentelegal.com',
  BROWSERLESS_TOKEN: process.env.BROWSERLESS_TOKEN || '',
  BROWSERLESS_DEBUGGER: process.env.BROWSERLESS_DEBUGGER || 'https://browser.lexaasistentelegal.com',
  EVOLUTION_URL: process.env.EVOLUTION_URL || 'https://evo.lexaasistentelegal.com',
  EVOLUTION_API_KEY: process.env.EVOLUTION_API_KEY || '',
  EVOLUTION_INSTANCE: process.env.EVOLUTION_INSTANCE || 'lexa-bot',
  TIMEOUT_CAPTCHA: 300000,  // 5 minutos
  TIMEOUT_NAV: 60000        // 1 minuto
};

// ============================================================
// FUNCIÓN: Enviar WhatsApp vía Evolution API
// ============================================================
async function enviarWhatsApp(numero, mensaje) {
  const url = `${CONFIG.EVOLUTION_URL}/message/sendText/${CONFIG.EVOLUTION_INSTANCE}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': CONFIG.EVOLUTION_API_KEY },
      body: JSON.stringify({ number: numero, text: mensaje })
    });
    console.log(`[WA] Enviado a ${numero}: ${response.ok ? 'OK' : 'ERROR'}`);
    return response.ok;
  } catch (error) {
    console.log(`[WA] Error: ${error.message}`);
    return false;
  }
}

// ============================================================
// FUNCIÓN: Esperar un tiempo
// ============================================================
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// ENDPOINT: Health Check
// ============================================================
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'lexa-scraper',
    version: '2.0.0',
    timestamp: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  res.json({ 
    service: 'LEXA Scraper',
    version: '2.0.0',
    endpoints: ['/health', '/scraper', '/test-browserless']
  });
});

// ============================================================
// ENDPOINT: Test Browserless
// ============================================================
app.get('/test-browserless', async (req, res) => {
  let browser = null;
  try {
    const wsUrl = `${CONFIG.BROWSERLESS_WS}?token=${CONFIG.BROWSERLESS_TOKEN}`;
    console.log('[TEST] Conectando a Browserless...');
    
    browser = await puppeteer.connect({ browserWSEndpoint: wsUrl });
    const version = await browser.version();
    await browser.close();
    
    res.json({ success: true, browserVersion: version });
  } catch (error) {
    if (browser) try { await browser.close(); } catch (e) {}
    res.json({ success: false, error: error.message });
  }
});

// ============================================================
// ENDPOINT: Scraper SINOE
// ============================================================
app.post('/scraper', async (req, res) => {
  const { sinoeUsuario, sinoePassword, whatsappNumero, nombreAbogado = 'Doctor(a)' } = req.body;
  
  if (!sinoeUsuario || !sinoePassword || !whatsappNumero) {
    return res.json({ success: false, error: 'Faltan datos: sinoeUsuario, sinoePassword, whatsappNumero' });
  }
  
  let browser = null;
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[SCRAPER] Iniciando para ${nombreAbogado}`);
  console.log(`[SCRAPER] Usuario SINOE: ${sinoeUsuario}`);
  console.log(`${'='.repeat(60)}\n`);
  
  try {
    // ========================================
    // PASO 1: Conectar a Browserless
    // ========================================
    console.log('[1/10] Conectando a Browserless...');
    const wsUrl = `${CONFIG.BROWSERLESS_WS}?token=${CONFIG.BROWSERLESS_TOKEN}`;
    browser = await puppeteer.connect({ browserWSEndpoint: wsUrl });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    console.log('[1/10] ✓ Conectado a Browserless');
    
    // ========================================
    // PASO 2: Navegar a SINOE
    // ========================================
    console.log('[2/10] Abriendo SINOE...');
    await page.goto('https://casillas.pj.gob.pe/sinoe/sso-validar.xhtml', {
      waitUntil: 'networkidle2',
      timeout: CONFIG.TIMEOUT_NAV
    });
    
    // Esperar a que cargue completamente
    await delay(2000);
    
    const currentUrl = page.url();
    console.log(`[2/10] ✓ URL actual: ${currentUrl}`);
    
    // Verificar si hay error de "parámetros no válidos"
    const pageContent = await page.content();
    if (pageContent.includes('PARAMETROS DE SEGURIDAD NO VALIDOS') || pageContent.includes('IR INICIO')) {
      console.log('[2/10] Detectada página de error, buscando botón IR INICIO...');
      
      // Buscar y hacer clic en "IR INICIO"
      const irInicioBtn = await page.$('a[href*="sso-validar"], button, a');
      if (irInicioBtn) {
        const buttons = await page.$$('a, button');
        for (const btn of buttons) {
          const text = await btn.evaluate(el => el.textContent || '');
          if (text.includes('IR INICIO') || text.includes('INICIO')) {
            await btn.click();
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: CONFIG.TIMEOUT_NAV }).catch(() => {});
            await delay(2000);
            break;
          }
        }
      }
    }
    
    // ========================================
    // PASO 3: Buscar campos de login
    // ========================================
    console.log('[3/10] Buscando campos de login...');
    
    // Esperar a que aparezcan los campos
    // SINOE usa inputs normales, pero pueden tener diferentes selectores
    await delay(1000);
    
    // Intentar múltiples selectores para el campo de usuario
    const userSelectors = [
      'input[type="text"]:not([type="hidden"])',
      'input[name*="usuario"]',
      'input[name*="user"]',
      'input[id*="usuario"]',
      'input[id*="user"]',
      'input.form-control',
      'input[placeholder*="usuario"]',
      'input[placeholder*="Usuario"]',
      'form input[type="text"]',
      'input:not([type="password"]):not([type="hidden"]):not([type="submit"])'
    ];
    
    let campoUsuario = null;
    for (const selector of userSelectors) {
      try {
        const inputs = await page.$$(selector);
        if (inputs.length > 0) {
          // Tomar el primer input de texto visible
          for (const input of inputs) {
            const isVisible = await input.evaluate(el => {
              const style = window.getComputedStyle(el);
              return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
            });
            if (isVisible) {
              campoUsuario = input;
              console.log(`[3/10] ✓ Campo usuario encontrado con: ${selector}`);
              break;
            }
          }
          if (campoUsuario) break;
        }
      } catch (e) {}
    }
    
    // Buscar campo de contraseña
    const campoPassword = await page.$('input[type="password"]');
    
    if (!campoUsuario) {
      // Último intento: obtener todos los inputs visibles
      console.log('[3/10] Buscando inputs de forma alternativa...');
      const allInputs = await page.$$('input');
      const visibleInputs = [];
      
      for (const input of allInputs) {
        const props = await input.evaluate(el => ({
          type: el.type,
          name: el.name,
          id: el.id,
          visible: el.offsetParent !== null,
          placeholder: el.placeholder
        }));
        
        if (props.visible && props.type !== 'hidden' && props.type !== 'submit' && props.type !== 'button') {
          visibleInputs.push({ input, props });
        }
      }
      
      console.log(`[3/10] Inputs visibles encontrados: ${visibleInputs.length}`);
      visibleInputs.forEach((v, i) => console.log(`   Input ${i}: type=${v.props.type}, name=${v.props.name}, id=${v.props.id}`));
      
      // El primer input de texto es usuario, el de password es contraseña
      for (const v of visibleInputs) {
        if (v.props.type === 'text' && !campoUsuario) {
          campoUsuario = v.input;
        }
      }
    }
    
    if (!campoUsuario || !campoPassword) {
      // Tomar screenshot para debug
      const screenshot = await page.screenshot({ encoding: 'base64' });
      console.log('[3/10] ✗ No se encontraron campos de login');
      console.log('[3/10] Screenshot guardado en logs');
      
      await browser.close();
      return res.json({ 
        success: false, 
        error: 'No se encontraron campos de login en SINOE. La página puede haber cambiado.',
        screenshot: screenshot.substring(0, 200) + '...'
      });
    }
    
    console.log('[3/10] ✓ Campos de login encontrados');
    
    // ========================================
    // PASO 4: Llenar credenciales
    // ========================================
    console.log('[4/10] Llenando credenciales...');
    
    // Limpiar y llenar usuario
    await campoUsuario.click({ clickCount: 3 });
    await page.keyboard.press('Backspace');
    await campoUsuario.type(sinoeUsuario, { delay: 50 });
    
    // Limpiar y llenar contraseña
    await campoPassword.click({ clickCount: 3 });
    await page.keyboard.press('Backspace');
    await campoPassword.type(sinoePassword, { delay: 50 });
    
    console.log('[4/10] ✓ Credenciales llenadas');
    
    // Guardar URL actual para detectar navegación
    const urlLogin = page.url();
    
    // ========================================
    // PASO 5: Enviar WhatsApp con link del debugger
    // ========================================
    console.log('[5/10] Enviando WhatsApp con link de autorización...');
    
    const debuggerUrl = `${CONFIG.BROWSERLESS_DEBUGGER}/?token=${CONFIG.BROWSERLESS_TOKEN}`;
    
    const mensajeCaptcha = `📩 *${nombreAbogado}*, nueva notificación SINOE detectada.

🔐 *Autorice el acceso:*
👉 ${debuggerUrl}

📝 *Instrucciones:*
1. Abra el link
2. Escriba el CAPTCHA que ve en pantalla
3. Presione "Ingresar"

⏱️ Tiene 5 minutos.

---
_LEXA Assistant_ 🤖`;

    await enviarWhatsApp(whatsappNumero, mensajeCaptcha);
    console.log('[5/10] ✓ WhatsApp enviado');
    
    // ========================================
    // PASO 6: Esperar que el abogado resuelva el CAPTCHA
    // ========================================
    console.log('[6/10] Esperando resolución de CAPTCHA (máx 5 min)...');
    console.log('[6/10] El abogado debe ingresar el CAPTCHA y presionar Ingresar');
    
    try {
      // Esperar a que la URL cambie (significa que el login fue exitoso)
      await page.waitForFunction(
        (urlPrevia) => window.location.href !== urlPrevia,
        { timeout: CONFIG.TIMEOUT_CAPTCHA },
        urlLogin
      );
      
      // Dar tiempo para que cargue la nueva página
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: CONFIG.TIMEOUT_NAV }).catch(() => {});
      await delay(2000);
      
      console.log('[6/10] ✓ CAPTCHA resuelto - navegación detectada');
      
    } catch (timeoutError) {
      console.log('[6/10] ✗ Timeout - CAPTCHA no resuelto en 5 minutos');
      
      await enviarWhatsApp(whatsappNumero, `⏰ *Tiempo agotado*\n\nEl tiempo para resolver el CAPTCHA expiró.\n\nPor favor, intente nuevamente.\n\n---\n_LEXA Assistant_ 🤖`);
      
      await browser.close();
      return res.json({ 
        success: false, 
        error: 'Timeout: CAPTCHA no resuelto en 5 minutos', 
        timeout: true 
      });
    }
    
    // ========================================
    // PASO 7: Verificar login exitoso
    // ========================================
    let urlActual = page.url();
    console.log(`[7/10] URL después de CAPTCHA: ${urlActual}`);
    
    // Verificar si hay sesión activa que necesita cerrarse
    if (urlActual.includes('sso-session-activa')) {
      console.log('[7/10] ⚠ Sesión activa detectada - notificando al abogado...');
      
      await enviarWhatsApp(whatsappNumero, `⚠️ *Sesión activa detectada*\n\nHay otra sesión abierta.\n\n👉 Haga clic en "FINALIZAR SESIONES"\n👉 Resuelva el nuevo CAPTCHA\n\n---\n_LEXA Assistant_ 🤖`);
      
      // Esperar a que resuelva el segundo CAPTCHA
      try {
        await page.waitForFunction(
          (urlPrevia) => window.location.href !== urlPrevia,
          { timeout: CONFIG.TIMEOUT_CAPTCHA },
          urlActual
        );
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: CONFIG.TIMEOUT_NAV }).catch(() => {});
        await delay(2000);
        
        console.log('[7/10] ✓ Segunda autorización completada');
        
      } catch (e) {
        await browser.close();
        return res.json({ 
          success: false, 
          error: 'Timeout: segundo CAPTCHA no resuelto', 
          timeout: true 
        });
      }
    }
    
    urlActual = page.url();
    
    // Verificar que estamos logueados
    if (!urlActual.includes('login.xhtml') && !urlActual.includes('sso-menu-app')) {
      console.log(`[7/10] ✗ Login fallido. URL inesperada: ${urlActual}`);
      await browser.close();
      return res.json({ 
        success: false, 
        error: `Login fallido. URL: ${urlActual}` 
      });
    }
    
    console.log('[7/10] ✓ Login exitoso');
    
    // ========================================
    // PASO 8: Notificar éxito y navegar a Casillas
    // ========================================
    console.log('[8/10] Navegando a Casillas Electrónicas...');
    
    await enviarWhatsApp(whatsappNumero, `✅ *¡Autorización exitosa!*\n\nYa puede cerrar el navegador.\n\nEn unos minutos recibirá el resumen de sus notificaciones.\n\n---\n_LEXA Assistant_ 🤖`);
    
    // Buscar y hacer clic en "Casillas Electrónicas" o "SINOE"
    const links = await page.$$('a');
    for (const link of links) {
      const text = await link.evaluate(el => el.textContent || '');
      const href = await link.evaluate(el => el.href || '');
      
      if (text.includes('Casillas') || text.includes('SINOE') || href.includes('casillas')) {
        console.log(`[8/10] Haciendo clic en: ${text.trim()}`);
        await link.click();
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: CONFIG.TIMEOUT_NAV }).catch(() => {});
        await delay(2000);
        break;
      }
    }
    
    console.log('[8/10] ✓ Navegación completada');
    
    // ========================================
    // PASO 9: Extraer notificaciones
    // ========================================
    console.log('[9/10] Extrayendo notificaciones...');
    const notificaciones = [];
    
    try {
      // Esperar a que cargue la tabla
      await page.waitForSelector('table tbody tr, .ui-datatable tbody tr, div[class*="list"]', { timeout: 10000 });
      
      // Intentar extraer de tabla
      const filas = await page.$$('table tbody tr, .ui-datatable-data tr');
      console.log(`[9/10] Filas encontradas: ${filas.length}`);
      
      for (let i = 0; i < Math.min(filas.length, 10); i++) {
        try {
          const celdas = await filas[i].$$('td');
          if (celdas.length >= 2) {
            const textos = [];
            for (const celda of celdas) {
              const texto = await celda.evaluate(el => el.textContent?.trim() || '');
              textos.push(texto);
            }
            
            // Extraer datos según la estructura de SINOE
            const notificacion = {
              expediente: textos[0] || '',
              juzgado: textos[1] || '',
              fecha: textos[2] || '',
              sumilla: textos[3] || '',
              raw: textos.join(' | ')
            };
            
            if (notificacion.expediente) {
              notificaciones.push(notificacion);
              console.log(`[9/10] → ${notificacion.expediente}`);
            }
          }
        } catch (e) {
          console.log(`[9/10] Error en fila ${i}: ${e.message}`);
        }
      }
      
    } catch (e) {
      console.log(`[9/10] No se encontró tabla de notificaciones: ${e.message}`);
      
      // Tomar screenshot de lo que hay
      const screenshot = await page.screenshot({ encoding: 'base64' });
      console.log('[9/10] Screenshot capturado para análisis');
    }
    
    console.log(`[9/10] ✓ Notificaciones extraídas: ${notificaciones.length}`);
    
    // ========================================
    // PASO 10: Cerrar y retornar
    // ========================================
    console.log('[10/10] Cerrando navegador...');
    await browser.close();
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[SCRAPER] ✓ COMPLETADO - ${notificaciones.length} notificaciones`);
    console.log(`${'='.repeat(60)}\n`);
    
    return res.json({
      success: true,
      notificaciones,
      total: notificaciones.length,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error(`[SCRAPER] ✗ ERROR: ${error.message}`);
    console.error(error.stack);
    
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
    
    return res.json({ 
      success: false, 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// ============================================================
// INICIAR SERVIDOR
// ============================================================
const PORT = process.env.PORT || 3001;

app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║           LEXA SCRAPER SERVICE v2.0.0                      ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  Servidor:     http://0.0.0.0:${PORT}                         ║`);
  console.log(`║  Health:       http://0.0.0.0:${PORT}/health                  ║`);
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  Browserless:  ${CONFIG.BROWSERLESS_WS.substring(0, 40)}...  ║`);
  console.log(`║  Evolution:    ${CONFIG.EVOLUTION_URL.substring(0, 40)}...   ║`);
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
});

// Manejo de señales
process.on('SIGTERM', () => {
  console.log('[SCRAPER] Recibido SIGTERM, cerrando...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[SCRAPER] Recibido SIGINT, cerrando...');
  process.exit(0);
});
