# 🛢️ Bot de WhatsApp con IA para Lubri Expert (Serviteca)

Bot inteligente para atención al cliente y gestión de servicios automotrices en **Lubri Expert** (by Cerón Zapata) en **Palmira, Valle del Cauca, Colombia**.

---

## 🌟 Características Principales

1. **Inteligencia Artificial con Google Gemini:**
   - Asesor virtual *"Experto Lubri"*, entrenado con información oficial de la serviteca.
   - Recomendador inteligente de viscosidad y tipo de lubricante (Mobil, Motul, Castrol, Shell, etc.) según marca, modelo, año y kilometraje.
   - Asesoría sobre llantas (Pirelli, Greenlander, Wanda), alineación 3D, balanceo y escáner computarizado de fallas.

2. **Memoria Conversacional por Teléfono:**
   - Mantiene el hilo y contexto del cliente durante la conversación.

3. **Sistema de Traspaso a Humano (Human Handoff):**
   - Detecta automáticamente cuando el cliente desea hablar con una persona o cuando la consulta requiere criterio técnico/cotización especial.
   - Pausa las respuestas automáticas del bot y genera una alerta con los datos del cliente para el asesor humano (`+57 310 465 4686`).

4. **Simulador Web de WhatsApp Integrado:**
   - Interfaz web interactiva en `http://localhost:3000` con estética idéntica a WhatsApp para probar flujos, respuestas y traspasos sin necesidad de configurar Meta inicialmente.

5. **Conector Oficial WhatsApp Cloud API (Meta):**
   - Endpoints listos para webhook verification (`GET /webhook`) y procesamiento de mensajes entrantes (`POST /webhook`).

---

## 🚀 Inicio Rápido

### 1. Requisitos
- **Node.js** v18 o superior.

### 2. Instalación de dependencias
```bash
cd lubri-expert-bot
npm install
```

### 3. Configuración de Variables de Entorno
Copia el archivo `.env.example` a `.env`:
```bash
cp .env.example .env
```
Edita `.env` con tus credenciales:
```env
PORT=3000
GEMINI_API_KEY=tu_api_key_de_gemini
WHATSAPP_TOKEN=tu_whatsapp_token_de_meta
WHATSAPP_PHONE_NUMBER_ID=tu_phone_number_id
WHATSAPP_VERIFY_TOKEN=lubri_expert_webhook_secret_2026
HUMAN_ADVISOR_PHONE=+573104654686
```
*(Nota: Si no agregas `GEMINI_API_KEY` inmediatamente, el bot cuenta con un modo de respaldo inteligente basado en reglas para que puedas probarlo de inmediato).*

### 4. Ejecutar en Modo Desarrollo
```bash
npm run dev
```

Abre tu navegador en:
👉 **`http://localhost:3000`** para interactuar con el simulador de WhatsApp.

---

## 📲 Conectar con WhatsApp Cloud API (Meta)

1. En [Meta for Developers](https://developers.facebook.com/), ve a tu aplicación de WhatsApp Business.
2. Expón tu servidor local usando ngrok o Cloudflare Tunnels:
   ```bash
   ngrok http 3000
   ```
3. En la configuración de Webhooks de WhatsApp en Meta:
   - **URL de devolución de llamada:** `https://tu-dominio-ngrok.ngrok-free.app/webhook`
   - **Token de verificación:** `lubri_expert_webhook_secret_2026` (o el que definas en `.env`)
4. Suscríbete al campo `messages`.
5. ¡Listo! Cualquier mensaje enviado a tu número de WhatsApp de prueba o comercial será respondido por el bot.

---

## 📂 Estructura del Proyecto

```
lubri-expert-bot/
├── public/
│   └── index.html               # Simulador visual de WhatsApp
├── src/
│   ├── config/
│   │   ├── env.ts               # Carga de variables de entorno
│   │   └── lubriInfo.ts         # Base de Conocimiento oficial de Lubri Expert
│   ├── prompts/
│   │   └── systemPrompt.ts      # Prompt y directrices del agente "Experto Lubri"
│   ├── services/
│   │   ├── ai.service.ts        # Motor de IA (Gemini + Fallback de Conocimiento)
│   │   ├── memory.service.ts    # Historial de conversación por cliente
│   │   ├── handoff.service.ts   # Control de estado y traspaso a asesor humano
│   │   └── whatsapp.service.ts  # Envío de mensajes a través de WhatsApp Cloud API
│   ├── controllers/
│   │   ├── webhook.controller.ts # Handshake y recepción de eventos de Meta
│   │   └── simulator.controller.ts # APIs para el simulador web
│   ├── routes/
│   │   ├── webhook.routes.ts    # Rutas /webhook
│   │   └── simulator.routes.ts  # Rutas /api/...
│   ├── app.ts                   # Configuración de Express y middlewares
│   └── server.ts                # Inicialización del servidor HTTP
├── .env.example
├── package.json
└── tsconfig.json
```
