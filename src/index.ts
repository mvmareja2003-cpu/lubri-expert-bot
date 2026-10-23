import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import express from 'express';
import cors from 'cors';
import { getAiResponse, transcribeAudio } from './services/ai.service';
import { sock, initWhatsAppClient, sendWhatsAppMessage, sendWhatsAppImage, sendWhatsAppDocument, downloadWhatsAppMedia } from './services/whatsapp.service';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Servir simulador web
const publicPath = path.join(process.cwd(), 'public');
if (fs.existsSync(publicPath)) {
    app.use(express.static(publicPath));
}

// Variables de control de toma de control humana (Takeover)
const humanTakeover: Record<string, number> = {};
const TAKEOVER_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos de pausa (evita que el bot se quede pegado)
const lastImageReply: Record<string, number> = {};

// Endpoint para el simulador web o pruebas locales
app.post('/api/chat', async (req, res) => {
    try {
        const { message, phoneNumber = '573109998877' } = req.body;
        if (!message) {
            res.status(400).json({ error: 'Mensaje requerido' });
            return;
        }

        let aiReply = await getAiResponse(message, phoneNumber);
        const isHandoff = aiReply.includes('[ESCALAR_HUMANO]');
        if (isHandoff) {
            aiReply = aiReply.replace('[ESCALAR_HUMANO]', '').trim();
            humanTakeover[`${phoneNumber}@s.whatsapp.net`] = Date.now();
        }

        res.json({
            reply: aiReply,
            isHandoff,
            phoneNumber
        });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/reset', (req, res) => {
    const { phoneNumber = '573109998877' } = req.body;
    delete humanTakeover[`${phoneNumber}@s.whatsapp.net`];
    res.json({ success: true, message: `Chat reiniciado para +${phoneNumber}` });
});

app.get('/status', (req, res) => {
    res.json({
        status: 'online',
        service: 'Lubri Expert Bot (Baileys + IA)',
        whatsappConnected: sock !== null && sock.user !== undefined
    });
});

app.listen(port, () => {
    console.log(`=======================================================`);
    console.log(`🛢️  LUBRI EXPERT - BOT WHATSAPP CON BAILEYS E IA`);
    console.log(`🌐  Servidor web activo en: http://localhost:${port}`);
    console.log(`📲  Simulador web en: http://localhost:${port}`);
    console.log(`👨‍🔧  Teléfono Asesor Alertas: ${process.env.OWNER_PHONE || '573104654686'}`);
    console.log(`=======================================================`);
});

/**
 * Procesador principal de mensajes de WhatsApp
 */
const handleMessage = async (msg: any) => {
    try {
        const fromMe = msg.key.fromMe;
        const from = msg.key.remoteJid;

        if (!msg.message || from === 'status@broadcast') return;

        const isGroup = from.endsWith('@g.us');
        if (isGroup) return; // Ignorar grupos

        const senderJid = msg.key.participant || from;
        const phoneNumber = senderJid.split('@')[0].split(':')[0];

        const textMessage = msg.message?.conversation || 
                            msg.message?.extendedTextMessage?.text || 
                            msg.message?.imageMessage?.caption || 
                            msg.message?.videoMessage?.caption || '';

        // Si el cliente envía palabras de saludo o reinicio, reactivar de inmediato
        const cleanText = textMessage.toLowerCase().trim();
        const isReactivateCmd = ['bot', 'activar', 'hola', 'menu', 'buenos dias', 'buenas tardes', 'reiniciar', 'cotizar', 'informacion', 'buena'].some(k => cleanText.includes(k));

        // Si el humano responde desde el celular o WhatsApp Web, pausar el bot por 5 mins
        if (fromMe) {
            if (textMessage.trim().length > 0) {
                console.log(`[PAUSA] Asesor humano respondió en el chat con ${phoneNumber}. Bot silenciado 5 mins.`);
                humanTakeover[from] = Date.now();
            }
            return;
        }

        // Si el chat está en manos de un asesor humano, respetar silencio temporal salvo reactivación o tras 3 mins
        if (humanTakeover[from]) {
            const elapsed = Date.now() - humanTakeover[from];
            if (isReactivateCmd || elapsed > 3 * 60 * 1000) {
                delete humanTakeover[from];
                console.log(`[REACTIVADO] Bot reactivado automáticamente para ${phoneNumber}.`);
            } else {
                console.log(`[SILENCIO] Chat con ${phoneNumber} está siendo atendido por un asesor humano (${Math.round((TAKEOVER_TIMEOUT_MS - elapsed)/1000)}s restantes).`);
                return;
            }
        }

        let actualMessage = msg.message;
        if (actualMessage?.ephemeralMessage) actualMessage = actualMessage.ephemeralMessage.message;
        else if (actualMessage?.viewOnceMessageV2) actualMessage = actualMessage.viewOnceMessageV2.message;

        let msgBody = '';
        const messageType = Object.keys(actualMessage || {})[0];

        if (messageType === 'extendedTextMessage') {
            msgBody = actualMessage.extendedTextMessage?.text;
        } else if (messageType === 'conversation') {
            msgBody = actualMessage.conversation;
        } else if (messageType === 'audioMessage') {
            console.log(`[AUDIO] Recibido audio de ${phoneNumber}. Descargando y transcribiendo con Whisper...`);
            const audioPath = await downloadWhatsAppMedia(msg);
            if (audioPath) {
                const transcribedText = await transcribeAudio(audioPath);
                try { fs.unlinkSync(audioPath); } catch (e) { }

                if (transcribedText) {
                    msgBody = transcribedText;
                    console.log(`[AUDIO TRANSCRITO] ${phoneNumber}: "${msgBody}"`);
                } else {
                    await sendWhatsAppMessage(from, 'Disculpa, no pude entender claramente la nota de voz. ¿Podrías escribirla por favor? 🚗');
                    return;
                }
            } else {
                await sendWhatsAppMessage(from, 'Disculpa, tuve un problema al descargar el audio. ¿Podrías escribirme? 🚗');
                return;
            }
        } else if (messageType === 'imageMessage' || messageType === 'documentMessage') {
            const now = Date.now();
            if (lastImageReply[phoneNumber] && (now - lastImageReply[phoneNumber] < 60000)) return;
            lastImageReply[phoneNumber] = now;

            const ownerPhone = process.env.OWNER_PHONE || '573016593654';
            const alertMsg = `🚨 *¡ATENCIÓN HUMANA REQUERIDA - LUBRI EXPERT!* 🚨\n\n📱 *Cliente:* +${phoneNumber}\n📄 *Motivo:* Envió una foto o documento (tarjeta de propiedad, daño o comprobante).\n\n👉 *Abrir chat directo:* https://wa.me/${phoneNumber}`;
            await sendWhatsAppMessage(ownerPhone, alertMsg);

            await sendWhatsAppMessage(from, 'Muchas gracias por la foto. Nuestro asesor de servicio la revisará en breve 🚗');
            humanTakeover[from] = Date.now();
            return;
        } else {
            return;
        }

        if (!msgBody || msgBody.trim().length === 0) return;

        console.log(`[MENSAJE] De +${phoneNumber}: "${msgBody}"`);

        // Obtener respuesta de la IA
        let aiResponse = await getAiResponse(msgBody, phoneNumber);

        // Verificar si la IA activó traspaso a humano
        if (aiResponse.includes('[ESCALAR_HUMANO]')) {
            aiResponse = aiResponse.replace('[ESCALAR_HUMANO]', '').trim();
            const ownerPhone = process.env.OWNER_PHONE || '573016593654';
            const alertMsg = `🚨 *¡ATENCIÓN HUMANA REQUERIDA - LUBRI EXPERT!* 🚨\n\n📱 *Cliente:* +${phoneNumber}\n💬 *Último mensaje:* "${msgBody}"\n\n👉 *Abrir chat directo:* https://wa.me/${phoneNumber}`;
            
            await sendWhatsAppMessage(ownerPhone, alertMsg);
            humanTakeover[from] = Date.now();
        }

        // Enviar respuesta al cliente
        if (aiResponse) {
            await sendWhatsAppMessage(from, aiResponse);
        }
    } catch (err) {
        console.error('[HANDLE MESSAGE ERROR]:', err);
    }
};

// Iniciar cliente de WhatsApp con Baileys
initWhatsAppClient(handleMessage);
