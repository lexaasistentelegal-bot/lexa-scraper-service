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
  TIMEOUT_CAPTCHA: 300000,
  TIMEOUT_NAV: 60000
};

async function enviarWhatsApp(numero, mensaje) {
  const url = `${CONFIG.EVOLUTION_URL}/message/sendText/${CONFIG.EVOLUTION_INSTANCE}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': CONFIG.EVOLUTION_API_KEY },
      body: JSON.stringify({ number: numero, text: mensaje })
    });
    console.log(`[WA] Enviado: ${response.ok ? 'OK' : 'ERROR'}`);
    return response.ok;
  } catch (error) {
    console.log(`[WA] Error: ${error.message}`);
    return false;
  }
}

async function clicPorTexto(page, textoContiene) {
  const elementos = await page.$$('a, button, input[type="submit"], input[type="button"], div[onclick]');
  for (const el of elementos) {
    const texto = await el.evaluate(e => (e.textContent || e.value || '').toUpperCase().trim());
    if (texto.includes(textoContiene.toUpperCase())) {
      await el.click();
      console.log(`[CLIC] ${textoContiene}`);
      return true;
    }
  }
  return false;
}

app.post('/scraper', async (req, res) => {
  const { sinoeUsuario, sinoePassword, whatsappNumero, nombreAbogado = 'Doctor(a)' } = req.body;
  
  if (!sinoeUsuario || !sinoePassword || !whatsappNumero) {
    return res.json({ success: false, error: 'Faltan datos' });
  }
  
  let browser = null;
  
  console.log(`\n${'='.repeat(50)}`);
  console.log(`[SCRAPER] Iniciando para ${nombreAbogado}`);
  console.log(`${'='.repeat(50)}\n`);
  
  try {
    console.log('[1] Conectando a Browserless...');
    const wsUrl = `${CONFIG.BROWSERLESS_WS}?token=${CONFIG.BROWSERLESS_TOKEN}`;
    browser = await puppeteer.connect({ browserWSEndpoint: wsUrl });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    console.log('[1] Conectado');
    
    console.log('[2] Abriendo SINOE...');
    await page.goto('https://casillas.pj.gob.pe/sinoe/sso-validar.xhtml', {
      waitUntil: 'networkidle2',
      timeout: CONFIG.TIMEOUT_NAV
    });
    console.log('[2] SINOE cargado');
    
    console.log('[3] Llenando credenciales...');
    await page.waitForSelector('input[type="text"]', { timeout: 10000 });
    const inputs = await page.$$('input');
    let campoUsuario = null, campoPassword = null;
    
    for (const input of inputs) {
      const type = await input.evaluate(el => el.type);
      const ph = await input.evaluate(el => (el.placeholder || el.name || '').toLowerCase());
      if (type === 'text' && !ph.includes('captcha') && !campoUsuario) campoUsuario = input;
      else if (type === 'password') campoPassword = input;
    }
    
    if (!campoUsuario || !campoPassword) {
      throw new Error('No se encontraron campos de login');
    }
    
    await campoUsuario.click({ clickCount: 3 });
    await page.keyboard.press('Backspace');
    await campoUsuario.type(sinoeUsuario, { delay: 50 });
    await campoPassword.click({ clickCount: 3 });
    await page.keyboard.press('Backspace');
    await campoPassword.type(sinoePassword, { delay: 50 });
    console.log('[3] Credenciales llenadas');
    
    const urlLogin = page.url();
    
    console.log('[4] Enviando WhatsApp...');
    const debuggerUrl = `${CONFIG.BROWSERLESS_DEBUGGER}/?token=${CONFIG.BROWSERLESS_TOKEN}`;
    await enviarWhatsApp(whatsappNumero, 
      `📩 ${nombreAbogado}, nueva notificación SINOE.\n\nAutorice el acceso:\n👉 ${debuggerUrl}\n\n🔒 Escriba el CAPTCHA y presione "Ingresar".\n\n⏱️ Tiene 5 minutos.`
    );
    
    console.log('[5] Esperando CAPTCHA (max 5 min)...');
    try {
      await page.waitForFunction(
        (urlPrevia) => window.location.href !== urlPrevia,
        { timeout: CONFIG.TIMEOUT_CAPTCHA },
        urlLogin
      );
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: CONFIG.TIMEOUT_NAV }).catch(() => {});
      console.log('[5] CAPTCHA resuelto');
    } catch (e) {
      await browser.close();
      return res.json({ success: false, error: 'Timeout: CAPTCHA no resuelto en 5 min', timeout: true });
    }
    
    let urlActual = page.url();
    console.log(`[6] URL: ${urlActual}`);
    
    if (urlActual.includes('sso-session-activa')) {
      console.log('[6] Sesión activa detectada...');
      await enviarWhatsApp(whatsappNumero, '⚠️ Hay sesión activa.\n\nClic en "FINALIZAR SESIONES" y resuelva el nuevo CAPTCHA.');
      
      try {
        await page.waitForFunction(
          (urlPrevia) => window.location.href !== urlPrevia,
          { timeout: CONFIG.TIMEOUT_CAPTCHA },
          urlActual
        );
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: CONFIG.TIMEOUT_NAV }).catch(() => {});
      } catch (e) {
        await browser.close();
        return res.json({ success: false, error: 'Timeout: 2do CAPTCHA no resuelto', timeout: true });
      }
    }
    
    urlActual = page.url();
    if (!urlActual.includes('login.xhtml') && !urlActual.includes('sso-menu-app')) {
      await browser.close();
      return res.json({ success: false, error: `Login fallido. URL: ${urlActual}` });
    }
    console.log('[7] Login exitoso');
    
    await enviarWhatsApp(whatsappNumero, '✅ ¡Autorización exitosa!\n\nPuede cerrar el navegador.\nEn minutos recibirá el resumen.');
    
    if (urlActual.includes('login.xhtml')) {
      console.log('[8] Navegando a Casillas...');
      await clicPorTexto(page, 'CASILLAS');
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: CONFIG.TIMEOUT_NAV }).catch(() => {});
    }
    
    console.log('[9] Extrayendo notificaciones...');
    const notificaciones = [];
    
    try {
      await page.waitForSelector('table tbody tr', { timeout: 10000 });
      const filas = await page.$$('table tbody tr');
      console.log(`[9] ${filas.length} filas encontradas`);
      
      for (let i = 0; i < Math.min(filas.length, 10); i++) {
        try {
          const celdas = await filas[i].$$('td');
          if (celdas.length < 2) continue;
          const expediente = await celdas[0]?.evaluate(el => el.textContent?.trim()) || '';
          const juzgado = await celdas[1]?.evaluate(el => el.textContent?.trim()) || '';
          const fecha = await celdas[2]?.evaluate(el => el.textContent?.trim()) || '';
          if (expediente) {
            console.log(`[9] -> ${expediente}`);
            notificaciones.push({ expediente, juzgado, fecha });
          }
        } catch (e) {}
      }
    } catch (e) {
      console.log('[9] Error tabla:', e.message);
    }
    
    console.log('[10] Cerrando browser...');
    await browser.close();
    
    console.log(`\n${'='.repeat(50)}`);
    console.log(`[SCRAPER] Completado: ${notificaciones.length} notificaciones`);
    console.log(`${'='.repeat(50)}\n`);
    
    return res.json({
      success: true,
      notificaciones,
      total: notificaciones.length,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error(`[ERROR] ${error.message}`);
    if (browser) try { await browser.close(); } catch (e) {}
    return res.json({ success: false, error: error.message, timestamp: new Date().toISOString() });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'lexa-scraper' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[SCRAPER] Corriendo en puerto ${PORT}`);
});
