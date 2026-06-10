'use strict';

/**
 * Entreprenly WhatsApp bridge.
 *
 * Links a real WhatsApp account through whatsapp-web.js (QR pairing) and connects
 * it to the chatbot backend:
 *   - shows the real QR (terminal + a local web page, and relays it to the backend
 *     so the app can display it too),
 *   - forwards every inbound message to the backend webhook,
 *   - sends the bot's automatic reply back through WhatsApp,
 *   - reports connection status so the app dashboard unlocks.
 *
 * This is an UNOFFICIAL integration (WhatsApp Web automation). Use a number you are
 * willing to risk, since it can violate WhatsApp's terms of service.
 */

require('dotenv').config();
const express = require('express');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');

const BACKEND_URL = (process.env.BACKEND_URL || 'http://localhost:8092/api/v1').replace(/\/$/, '');
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || 'entreprenly-bridge-secret';
const SELLER_ID = Number(process.env.SELLER_ID || 1);
const BUSINESS_NAME = process.env.BUSINESS_NAME || 'Mi Negocio';
const PORT = Number(process.env.PORT || 3001);
/** Optional path to an installed Chrome/Edge to avoid Chromium launch issues on Windows. */
const BROWSER_PATH = process.env.WHATSAPP_BROWSER_PATH || undefined;
/** Seller account email (login) whose catalog the bot answers with. */
const OWNER_EMAIL = process.env.OWNER_EMAIL || '';

/** Latest pairing QR (raw string) and current link state, shared with the web page. */
const state = { qr: null, connected: false, phone: null };

/** Calls a backend /bridge endpoint, tolerating failures so the bridge never crashes. */
async function callBackend(path, body) {
  try {
    const res = await fetch(`${BACKEND_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': BRIDGE_TOKEN },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn(`[backend] ${path} respondio ${res.status}`);
      return null;
    }
    return res.status === 204 ? {} : await res.json();
  } catch (err) {
    console.warn(`[backend] no se pudo llamar ${path}: ${err.message}`);
    return null;
  }
}

/** Converts a WhatsApp JID (e.g. "51987654321@c.us") into "+51987654321". */
function toPhone(jid) {
  const digits = String(jid || '').split('@')[0].replace(/\D/g, '');
  return digits ? `+${digits}` : '';
}

const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'entreprenly' }),
  puppeteer: {
    headless: true,
    executablePath: BROWSER_PATH,
    timeout: 60000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
    ],
  },
});

client.on('qr', async (qr) => {
  state.qr = qr;
  state.connected = false;
  console.log('\n[whatsapp] Escanea este QR desde tu telefono (WhatsApp > Dispositivos vinculados):\n');
  qrcodeTerminal.generate(qr, { small: true });
  console.log(`\n[whatsapp] Tambien puedes abrir http://localhost:${PORT} para escanearlo desde la pantalla.\n`);
  await callBackend('/chatbot/whatsapp/bridge/qr', { qr });
});

client.on('ready', async () => {
  state.qr = null;
  state.connected = true;
  state.phone = toPhone(client.info?.wid?._serialized);
  console.log(`[whatsapp] Conectado como ${state.phone} (${BUSINESS_NAME}).`);
  await callBackend('/chatbot/whatsapp/bridge/status', {
    connected: true,
    phone: state.phone,
    businessName: BUSINESS_NAME,
    sellerId: SELLER_ID,
    ownerEmail: OWNER_EMAIL,
  });
});

client.on('authenticated', () => console.log('[whatsapp] Sesion autenticada.'));
client.on('auth_failure', (m) => console.error('[whatsapp] Fallo de autenticacion:', m));

client.on('disconnected', async (reason) => {
  state.connected = false;
  console.warn('[whatsapp] Desconectado:', reason);
  await callBackend('/chatbot/whatsapp/bridge/status', {
    connected: false,
    phone: state.phone,
    businessName: BUSINESS_NAME,
    sellerId: SELLER_ID,
    ownerEmail: OWNER_EMAIL,
  });
});

client.on('message', async (msg) => {
  // Ignore own messages, status broadcasts and group chats.
  if (msg.fromMe || msg.from === 'status@broadcast' || msg.from.endsWith('@g.us')) return;

  const fromPhone = toPhone(msg.from);

  // Payment receipt: an image/document is forwarded to the receipt endpoint.
  if (msg.hasMedia && (msg.type === 'image' || msg.type === 'document')) {
    try {
      const media = await msg.downloadMedia();
      if (media && media.data) {
        const image = `data:${media.mimetype};base64,${media.data}`;
        console.log(`[whatsapp] Comprobante recibido de ${fromPhone}`);
        const reply = await callBackend('/chatbot/whatsapp/webhook/receipt',
          { fromPhone, ownerEmail: OWNER_EMAIL, image });
        if (reply && reply.content) await client.sendMessage(msg.from, reply.content);
      }
    } catch (err) {
      console.warn('[whatsapp] No se pudo procesar el comprobante:', err.message);
    }
    return;
  }

  if (!msg.body || !msg.body.trim()) return;

  let clientName = fromPhone;
  try {
    const contact = await msg.getContact();
    clientName = contact.pushname || contact.name || contact.number || fromPhone;
  } catch {
    /* keep the phone as the name */
  }

  console.log(`[whatsapp] Mensaje de ${clientName} (${fromPhone}): ${msg.body}`);

  const reply = await callBackend('/chatbot/whatsapp/webhook', {
    fromPhone,
    clientName,
    content: msg.body,
    ownerEmail: OWNER_EMAIL,
  });

  if (reply && reply.content) {
    try {
      await client.sendMessage(msg.from, reply.content);
      console.log(`[whatsapp] Respuesta del bot enviada: ${reply.content}`);
    } catch (err) {
      console.warn('[whatsapp] No se pudo enviar la respuesta:', err.message);
    }
  }
});

// --- Local web page to scan the QR comfortably from the screen ---
const app = express();
app.use(express.json({ limit: '5mb' }));

app.get('/health', (_req, res) => res.json({ connected: state.connected, phone: state.phone }));

/**
 * Outbound relay: lets the backend push a message to a client through WhatsApp
 * (e.g. "payment approved"), beyond the automatic reply to an inbound message.
 * Guarded by the shared bridge token.
 */
app.post('/send', async (req, res) => {
  if ((req.get('X-Bridge-Token') || '') !== BRIDGE_TOKEN) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const { phone, content } = req.body || {};
  if (!phone || !content) {
    return res.status(400).json({ error: 'phone and content are required' });
  }
  if (!state.connected) {
    return res.status(409).json({ error: 'whatsapp not connected' });
  }
  const digits = String(phone).replace(/\D/g, '');
  if (!digits) {
    return res.status(400).json({ error: 'invalid phone' });
  }
  try {
    await client.sendMessage(`${digits}@c.us`, String(content));
    console.log(`[bridge] Mensaje saliente enviado a +${digits}: ${content}`);
    res.json({ ok: true });
  } catch (err) {
    console.warn(`[bridge] No se pudo enviar a +${digits}: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

app.get('/', async (_req, res) => {
  if (state.connected) {
    res.send(page(`<h2>WhatsApp conectado ✅</h2><p>${state.phone || ''} — ${BUSINESS_NAME}</p>
      <p>Ya puedes volver a la app y ver tus conversaciones.</p>`));
    return;
  }
  if (!state.qr) {
    res.send(page('<h2>Generando codigo QR…</h2><p>Espera unos segundos y recarga.</p>'));
    return;
  }
  const dataUrl = await qrcode.toDataURL(state.qr, { width: 300 });
  res.send(page(`<h2>Vincula tu WhatsApp</h2>
    <p>WhatsApp &gt; Dispositivos vinculados &gt; Vincular un dispositivo</p>
    <img src="${dataUrl}" alt="QR" />
    <p style="color:#888">El codigo se renueva solo; esta pagina se recarga cada 8s.</p>`));
});

function page(body) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8" />
    <meta http-equiv="refresh" content="8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Entreprenly · WhatsApp Bridge</title>
    <style>body{font-family:system-ui,Arial,sans-serif;display:flex;flex-direction:column;
      align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f5;color:#222;text-align:center}
      img{margin:16px;border:8px solid #fff;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.1)}</style>
    </head><body><main>${body}</main></body></html>`;
}

app.listen(PORT, () => {
  console.log(`[bridge] Pagina del QR en http://localhost:${PORT}`);
  console.log(`[bridge] Backend: ${BACKEND_URL}`);
});

console.log('[bridge] Iniciando cliente de WhatsApp (puede tardar la primera vez)…');
client.initialize();
