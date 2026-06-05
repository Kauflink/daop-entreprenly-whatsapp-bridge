# Entreprenly · WhatsApp Bridge

Puente entre **WhatsApp** (vía [whatsapp-web.js](https://wwebjs.dev/)) y el backend del chatbot de Entreprenly.

Genera el **QR real**, recibe los mensajes que te escriben, los manda al backend (que responde
automáticamente con el bot) y reenvía esa respuesta por WhatsApp. Todo aparece en tu app en vivo.

> ⚠️ **Es una integración NO oficial** (automatiza WhatsApp Web). WhatsApp puede **banear el número**.
> Usa un número que no te importe perder, no tu WhatsApp personal importante.

## Requisitos
- Node.js 18+ (tienes 24 ✅).
- Un teléfono con WhatsApp (el número que hará de "bot/negocio").
- Para la demo: un segundo teléfono que haga de "cliente".

## Pasos
1. Copia la configuración y ajústala:
   ```bash
   cp .env.example .env
   ```
   - `BACKEND_URL`: por defecto producción (`https://daop-api.entreprenly.online/api/v1`).
   - `BRIDGE_TOKEN`: debe **coincidir** con `chatbot.whatsapp.bridge-token` del backend.
   - `SELLER_ID`: tu id de usuario/vendedor.
2. Instala dependencias (la primera vez descarga un Chromium, puede tardar):
   ```bash
   npm install
   ```
3. Arranca el puente:
   ```bash
   npm start
   ```
4. Abre **http://localhost:3001** (o mira el QR en la terminal) y escanéalo desde tu teléfono:
   **WhatsApp → Dispositivos vinculados → Vincular un dispositivo**.
5. Cuando diga *“WhatsApp conectado ✅”*, vuelve a la app: el dashboard se desbloquea.
6. Desde **otro teléfono**, escríbele al número vinculado: *“Hola, quiero 5 kilos de manzana”*.
   El mensaje aparece en la app y **el bot responde solo**. 🎉

## Cómo funciona
```
Cliente (WhatsApp) ──▶ este puente ──▶ POST /chatbot/whatsapp/webhook (backend)
                                            │  el backend guarda el mensaje,
                                            │  genera la respuesta del bot
                                            ▼
Cliente (WhatsApp) ◀── este puente ◀── respuesta del bot
                         (y la app se actualiza en vivo por SSE)
```

La sesión queda guardada en `.wwebjs_auth/`, así que no tienes que re-escanear cada vez.
Para desvincular: WhatsApp → Dispositivos vinculados → cerrar sesión, y borra la carpeta `.wwebjs_auth/`.
