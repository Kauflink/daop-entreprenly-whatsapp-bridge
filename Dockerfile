FROM node:20-slim

# Chromium + fuentes para que whatsapp-web.js funcione sin pantalla
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-noto-color-emoji \
    fonts-liberation \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Apuntar al Chromium del sistema (no descargar otro)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV WHATSAPP_BROWSER_PATH=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY index.js .

EXPOSE 3001

CMD ["node", "index.js"]
