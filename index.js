'use strict';

/**
 * Entreprenly WhatsApp bridge — Multi-tenant.
 *
 * Manages one WhatsApp session per seller (identified by ownerEmail).
 * Sessions are initialised lazily on the first QR poll and persist across
 * restarts thanks to LocalAuth (each seller gets its own auth folder).
 *
 * REST API
 * --------
 *   GET  /health                    → { ok, sessions: [{ email, connected, phone }] }
 *   GET  /qr?email=X                → { qr, connected }   — starts session if not running
 *   POST /send                      → send a message on behalf of a seller
 *        body: { email, phone, content }   header: X-Bridge-Token
 *   GET  /                          → HTML status page (admin view)
 */

require('dotenv').config();
const express = require('express');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');

const BACKEND_URL  = (process.env.BACKEND_URL  || 'http://localhost:8092/api/v1').replace(/\/$/, '');
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN  || 'entreprenly-bridge-secret';
const PORT         = Number(process.env.PORT   || 3001);
const BROWSER_PATH = process.env.WHATSAPP_BROWSER_PATH || undefined;

// ── Session registry ─────────────────────────────────────────────────────────
// email → { client, state: { qr, connected, phone }, sellerId, businessName }
const sessions    = new Map();
const initializing = new Set(); // guard against duplicate init

// phone (+digits) → the real WhatsApp chatId seen on an inbound message.
// WhatsApp now addresses some users by LID (e.g. "250061904675033@lid") instead
// of their phone, so reconstructing "<digits>@c.us" for an outbound /send fails
// with "No LID for user". We remember the exact chatId the client wrote from and
// reuse it, which is always available for the payment flow (the client messages
// first to send the receipt before the seller approves).
const chatIdByPhone = new Map();

// ── Helpers ──────────────────────────────────────────────────────────────────

function toPhone(jid) {
  const digits = String(jid || '').split('@')[0].replace(/\D/g, '');
  return digits ? `+${digits}` : '';
}

async function callBackend(path, body) {
  try {
    const res = await fetch(`${BACKEND_URL}${path}`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': BRIDGE_TOKEN },
      body   : JSON.stringify(body),
    });
    if (!res.ok) console.warn(`[backend] ${path} → ${res.status}`);
    return res.status === 204 ? {} : await res.json().catch(() => ({}));
  } catch (err) {
    console.warn(`[backend] ${path} falló: ${err.message}`);
    return null;
  }
}

// ── Session factory ───────────────────────────────────────────────────────────

async function initSession(email, sellerId = 1, businessName = 'Mi Negocio') {
  if (sessions.has(email) || initializing.has(email)) return;
  initializing.add(email);
  console.log(`[bridge] Iniciando sesión para ${email} …`);

  const state    = { qr: null, connected: false, phone: null };
  // Each seller gets its own auth folder so sessions are fully independent.
  const clientId = `seller-${email.replace(/[^a-z0-9]/gi, '-')}`;

  const client = new Client({
    authStrategy: new LocalAuth({ clientId }),
    puppeteer: {
      headless: true,
      executablePath: BROWSER_PATH,
      timeout: 60_000,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
      ],
    },
  });

  // Store before initialize() so /qr can return immediately.
  sessions.set(email, { client, state, sellerId, businessName });
  initializing.delete(email);

  client.on('qr', async (qr) => {
    state.qr        = qr;
    state.connected = false;
    console.log(`[whatsapp:${email}] Nuevo QR generado`);
    qrcodeTerminal.generate(qr, { small: true });
    await callBackend('/chatbot/whatsapp/bridge/qr', { qr, ownerEmail: email });
  });

  client.on('authenticated', () =>
    console.log(`[whatsapp:${email}] Sesión autenticada`));

  client.on('auth_failure', (m) =>
    console.error(`[whatsapp:${email}] Fallo de autenticación:`, m));

  client.on('ready', async () => {
    state.qr        = null;
    state.connected = true;
    state.phone     = toPhone(client.info?.wid?._serialized);
    console.log(`[whatsapp:${email}] Conectado como ${state.phone}`);
    await callBackend('/chatbot/whatsapp/bridge/status', {
      connected   : true,
      phone       : state.phone,
      businessName,
      sellerId,
      ownerEmail  : email,
    });
  });

  client.on('disconnected', async (reason) => {
    console.warn(`[whatsapp:${email}] Desconectado: ${reason}`);
    state.connected = false;
    state.qr        = null;
    await callBackend('/chatbot/whatsapp/bridge/status', {
      connected   : false,
      phone       : state.phone,
      businessName,
      sellerId,
      ownerEmail  : email,
    });
  });

  client.on('message', async (msg) => {
    // Ignore own messages, status broadcasts and groups.
    if (msg.fromMe || msg.from === 'status@broadcast' || msg.from.endsWith('@g.us')) return;

    const fromPhone = toPhone(msg.from);
    // Remember the exact chatId so a later /send reaches this client even when
    // WhatsApp addresses them by LID rather than by their phone number.
    if (fromPhone) chatIdByPhone.set(fromPhone, msg.from);

    // Payment receipt image.
    if (msg.hasMedia && (msg.type === 'image' || msg.type === 'document')) {
      try {
        const media = await msg.downloadMedia();
        if (media?.data) {
          const image = `data:${media.mimetype};base64,${media.data}`;
          console.log(`[whatsapp:${email}] Comprobante de ${fromPhone}`);
          const reply = await callBackend('/chatbot/whatsapp/webhook/receipt',
            { fromPhone, ownerEmail: email, image });
          if (reply?.content) await client.sendMessage(msg.from, reply.content);
        }
      } catch (err) {
        console.warn(`[whatsapp:${email}] Error procesando comprobante:`, err.message);
      }
      return;
    }

    if (!msg.body?.trim()) return;

    let clientName = fromPhone;
    try {
      const contact = await msg.getContact();
      clientName = contact.pushname || contact.name || contact.number || fromPhone;
    } catch { /* keep phone */ }

    console.log(`[whatsapp:${email}] Mensaje de ${clientName} (${fromPhone}): ${msg.body}`);

    const reply = await callBackend('/chatbot/whatsapp/webhook', {
      fromPhone,
      clientName,
      content   : msg.body,
      ownerEmail: email,
    });

    if (reply?.content) {
      try {
        await client.sendMessage(msg.from, reply.content);
        console.log(`[whatsapp:${email}] Bot respondió: ${reply.content}`);
      } catch (err) {
        console.warn(`[whatsapp:${email}] No se pudo enviar respuesta:`, err.message);
      }
    }
  });

  client.initialize();
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '10mb' }));

/** Health check — lists all active sessions. */
app.get('/health', (_req, res) => {
  const list = [...sessions.entries()].map(([email, s]) => ({
    email,
    connected: s.state.connected,
    phone    : s.state.phone,
  }));
  res.json({ ok: true, sessions: list });
});

/**
 * Returns the QR state for one seller.
 * If no session exists yet, starts one (first call triggers Puppeteer launch).
 * The frontend polls this endpoint every 5 s via the backend proxy.
 *
 * Query params:
 *   email  (required) — ownerEmail of the seller
 */
app.get('/qr', async (req, res) => {
  const { email, sellerId, businessName } = req.query;
  if (!email) return res.status(400).json({ error: 'email es requerido' });

  if (!sessions.has(email)) {
    // Fire-and-forget; next poll will see the session.
    initSession(email, Number(sellerId) || 1, businessName || 'Mi Negocio')
      .catch(err => console.error(`[bridge] init falló para ${email}:`, err));
    return res.json({ qr: null, connected: false });
  }

  const { state } = sessions.get(email);
  res.json({ qr: state.qr, connected: state.connected });
});

/**
 * Send a message through a seller's WhatsApp.
 * Called by the backend when a payment is approved etc.
 * Protected by X-Bridge-Token header.
 */
app.post('/send', async (req, res) => {
  if ((req.get('X-Bridge-Token') || '') !== BRIDGE_TOKEN)
    return res.status(403).json({ error: 'forbidden' });

  const { email, phone, content } = req.body || {};
  if (!email || !phone || !content)
    return res.status(400).json({ error: 'email, phone y content son requeridos' });

  const session = sessions.get(email);
  if (!session?.state.connected)
    return res.status(409).json({ error: 'WhatsApp no conectado para ese email' });

  const digits = String(phone).replace(/\D/g, '');
  if (!digits) return res.status(400).json({ error: 'teléfono inválido' });

  // Resolve the chatId to send to, in order of reliability:
  //   1. the exact chatId the client wrote from (handles LID-addressed users),
  //   2. WhatsApp's own number→id resolution,
  //   3. the classic "<digits>@c.us" fallback.
  let chatId = chatIdByPhone.get(`+${digits}`);
  if (!chatId) {
    try {
      const numberId = await session.client.getNumberId(digits);
      chatId = numberId ? numberId._serialized : `${digits}@c.us`;
    } catch {
      chatId = `${digits}@c.us`;
    }
  }

  try {
    await session.client.sendMessage(chatId, String(content));
    console.log(`[bridge:${email}] Mensaje enviado a +${digits} (${chatId})`);
    res.json({ ok: true });
  } catch (err) {
    console.warn(`[bridge:${email}] No se pudo enviar a +${digits} (${chatId}):`, err.message);
    res.status(502).json({ error: err.message });
  }
});

/** Admin HTML status page. */
app.get('/', async (_req, res) => {
  const rows = [...sessions.entries()].map(([email, { state }]) => {
    if (state.connected) {
      return `<tr><td>${email}</td><td>✅ ${state.phone}</td><td>Conectado</td></tr>`;
    }
    if (state.qr) {
      return `<tr><td>${email}</td><td>—</td><td>⏳ Esperando escaneo</td></tr>`;
    }
    return `<tr><td>${email}</td><td>—</td><td>🔄 Iniciando…</td></tr>`;
  });

  const table = rows.length
    ? `<table border="1" cellpadding="8"><tr><th>Email</th><th>Teléfono</th><th>Estado</th></tr>${rows.join('')}</table>`
    : '<p>No hay sesiones activas todavía.</p>';

  res.send(`<!doctype html><html lang="es"><head>
    <meta charset="utf-8"><meta http-equiv="refresh" content="10">
    <title>Entreprenly Bridge</title>
    <style>body{font-family:system-ui;padding:2rem;background:#f5f5f5}
    table{border-collapse:collapse;background:#fff}th{background:#f90;color:#fff}</style>
    </head><body><h1>Entreprenly WhatsApp Bridge</h1>${table}
    <p style="color:#888;font-size:12px">Recarga automática cada 10 s.</p>
    </body></html>`);
});

app.listen(PORT, () => {
  console.log(`[bridge] Multi-tenant bridge escuchando en puerto ${PORT}`);
  console.log(`[bridge] Backend: ${BACKEND_URL}`);
  console.log(`[bridge] Página de estado: http://localhost:${PORT}`);

  // Auto-start the session for the owner configured in .env (if provided).
  const autoEmail      = process.env.OWNER_EMAIL;
  const autoSellerId   = Number(process.env.SELLER_ID)   || 1;
  const autoBusinessName = process.env.BUSINESS_NAME    || 'Mi Negocio';
  if (autoEmail) {
    console.log(`[bridge] Auto-iniciando sesión para ${autoEmail} …`);
    initSession(autoEmail, autoSellerId, autoBusinessName)
      .catch(err => console.error(`[bridge] Auto-inicio fallido:`, err));
  }
});
