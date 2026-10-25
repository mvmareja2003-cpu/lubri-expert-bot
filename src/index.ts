import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import express from 'express';
import cors from 'cors';
import { getAiResponse, transcribeAudio } from './services/ai.service';
import { sock, initWhatsAppClient, sendWhatsAppMessage, sendWhatsAppImage, sendWhatsAppDocument, downloadWhatsAppMedia } from './services/whatsapp.service';
import { quotesService } from './services/quotes.service';

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

const humanTakeover: Record<string, number> = {};
const TAKEOVER_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutos de pausa para atención humana
const lastImageReply: Record<string, number> = {};

// Endpoint para el simulador web o pruebas locales
app.post('/api/chat', async (req, res) => {
    try {
        const { message, phoneNumber = '573109998877' } = req.body;
        if (!message) {
            res.status(400).json({ error: 'Mensaje requerido' });
            return;
        }

        const activeTicket = quotesService.getActiveCustomerTicket(`${phoneNumber}@s.whatsapp.net`, phoneNumber);
        let ticketContext: string | undefined = undefined;
        if (activeTicket && activeTicket.status === 'QUOTED') {
            ticketContext = `Ticket #${activeTicket.id} (${activeTicket.vehicle} - ${activeTicket.service}): Cotizado por Arias en ${activeTicket.quotePrice}.` +
                (activeTicket.quoteNotes ? ` Nota/Explicación técnica de Arias: ${activeTicket.quoteNotes}.` : '') +
                (activeTicket.availability ? ` Disponibilidad indicada por Arias: ${activeTicket.availability}.` : ' Arias no indicó hora específica, preguntar al cliente su preferencia.');
        }

        let aiReply = await getAiResponse(message, phoneNumber, ticketContext);
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

        const key = msg.key || {};
        let actualMsg = msg.message;
        if (actualMsg?.ephemeralMessage) actualMsg = actualMsg.ephemeralMessage.message;
        else if (actualMsg?.viewOnceMessageV2) actualMsg = actualMsg.viewOnceMessageV2.message;

        const contextInfo = actualMsg?.extendedTextMessage?.contextInfo || actualMsg?.audioMessage?.contextInfo;
        const quotedStanzaId = contextInfo?.stanzaId;

        let textMessage = actualMsg?.conversation || 
                          actualMsg?.extendedTextMessage?.text || 
                          actualMsg?.imageMessage?.caption || 
                          actualMsg?.videoMessage?.caption || '';

        // Si es una nota de voz o audio (del cliente o de Arias), transcribir primero con Whisper
        if (actualMsg?.audioMessage) {
            console.log(`[AUDIO] Recibido audio de ${from}. Descargando y transcribiendo con Whisper...`);
            const audioPath = await downloadWhatsAppMedia(msg);
            if (audioPath) {
                const transcribedText = await transcribeAudio(audioPath);
                try { fs.unlinkSync(audioPath); } catch (e) { }

                if (transcribedText) {
                    textMessage = transcribedText;
                    console.log(`[AUDIO TRANSCRITO] ${from}: "${textMessage}"`);
                } else {
                    await sendWhatsAppMessage(from, 'Disculpa, no pude entender claramente la nota de voz. ¿Podrías escribirla por favor? 🚗');
                    return;
                }
            } else {
                await sendWhatsAppMessage(from, 'Disculpa, tuve un problema al descargar el audio. ¿Podrías escribirme? 🚗');
                return;
            }
        } else if (actualMsg?.imageMessage || actualMsg?.documentMessage) {
            const now = Date.now();
            const photoPhone = (key.remoteJidAlt || from).split('@')[0].split(':')[0].replace(/\D/g, '');
            if (lastImageReply[photoPhone] && (now - lastImageReply[photoPhone] < 60000)) return;
            lastImageReply[photoPhone] = now;

            const ownerPhone = process.env.OWNER_PHONE || '573016593654';
            const alertMsg = `🚨 *¡ATENCIÓN HUMANA REQUERIDA - LUBRI EXPERT!* 🚨\n\n📱 *Cliente:* +${photoPhone}\n📄 *Motivo:* Envió una foto o documento (tarjeta de propiedad, daño o comprobante).\n\n👉 *Abrir chat directo:* https://wa.me/${photoPhone}`;
            await sendWhatsAppMessage(ownerPhone, alertMsg);

            await sendWhatsAppMessage(from, 'Muchas gracias por la foto. Nuestro asesor de servicio la revisará en breve 🚗');
            return;
        }

        if (!textMessage || textMessage.trim().length === 0) return;

        // Extraer número de teléfono real del cliente (desenredando LIDs @lid de WhatsApp)
        let phoneNumber = '';
        const candidates = [
            key.remoteJidAlt,
            key.participantAlt,
            key.remoteJid,
            key.participant,
            msg.participant
        ];

        for (const c of candidates) {
            if (c && typeof c === 'string' && (c.includes('@s.whatsapp.net') || c.includes('@c.us'))) {
                const clean = c.split('@')[0].split(':')[0].replace(/\D/g, '');
                if (clean.length >= 10 && clean.length <= 13) {
                    phoneNumber = clean;
                    break;
                }
            }
        }

        // Si todavía no hay número y es un @lid, consultar al almacén de Baileys
        if (!phoneNumber && from.includes('@lid') && (sock as any)?.signalRepository?.lidMapping?.getPNForLID) {
            try {
                const pnJid = await (sock as any).signalRepository.lidMapping.getPNForLID(from);
                if (pnJid) {
                    phoneNumber = pnJid.split('@')[0].split(':')[0].replace(/\D/g, '');
                }
            } catch (e) { }
        }

        if (!phoneNumber) {
            phoneNumber = (key.participant || from).split('@')[0].split(':')[0].replace(/\D/g, '');
        }

        // Si el mensaje proviene de Arias el técnico (+57 314 778 5316), procesar cotización
        if (quotesService.isMechanic(phoneNumber, from, quotedStanzaId, textMessage)) {
            console.log(`[COTIZADOR ARIAS] Mensaje reconocido de Arias (Tel/ID: ${phoneNumber}, JID: ${from}): "${textMessage}" (Quoted ID: ${quotedStanzaId || 'ninguno'})`);
            await quotesService.handleMechanicMessage(from, textMessage, quotedStanzaId);
            return;
        }

        // Si el cliente envía palabras de saludo o reinicio, reactivar de inmediato
        const cleanText = textMessage.toLowerCase().trim();

        // Si el humano responde desde el celular o WhatsApp Web, pausar el bot por 15 mins
        if (fromMe) {
            if (textMessage.trim().length > 0) {
                console.log(`[PAUSA] Asesor humano respondió en el chat con ${phoneNumber}. Bot silenciado 15 mins.`);
                humanTakeover[from] = Date.now();
            }
            return;
        }

        // Si el chat está en manos de un asesor humano, respetar silencio estricto de 15 minutos
        if (humanTakeover[from]) {
            const elapsed = Date.now() - humanTakeover[from];
            if (cleanText === 'activar bot' || cleanText === 'reiniciar bot' || elapsed >= TAKEOVER_TIMEOUT_MS) {
                delete humanTakeover[from];
                console.log(`[REACTIVADO] Bot reactivado automáticamente para ${phoneNumber} (cumplidos los 15 minutos).`);
            } else {
                console.log(`[SILENCIO] Chat con ${phoneNumber} está siendo atendido por un asesor humano (${Math.round((TAKEOVER_TIMEOUT_MS - elapsed)/1000)}s restantes de los 15 mins).`);
                return;
            }
        }

        console.log(`[MENSAJE] De +${phoneNumber}: "${textMessage}"`);

        // Obtener ticket activo reciente para inyectar contexto si existe
        const activeTicket = quotesService.getActiveCustomerTicket(from, phoneNumber);
        let ticketContext: string | undefined = undefined;

        if (activeTicket && activeTicket.status === 'QUOTED') {
            ticketContext = `Ticket #${activeTicket.id} (${activeTicket.vehicle} - ${activeTicket.service}): Cotizado por Arias en ${activeTicket.quotePrice}.` +
                (activeTicket.quoteNotes ? ` Nota/Explicación técnica de Arias: ${activeTicket.quoteNotes}.` : '') +
                (activeTicket.availability ? ` Disponibilidad indicada por Arias: ${activeTicket.availability}.` : ' Arias no indicó hora específica, preguntar al cliente su preferencia.');
        }

        // Obtener respuesta de la IA
        let aiResponse = await getAiResponse(textMessage, phoneNumber, ticketContext);

        // Verificar si la IA generó una solicitud de cotización para Arias el técnico
        const quoteMatch = aiResponse.match(/\[SOLICITAR_COTIZACION:\s*([^\|]+)\s*\|\s*([^\|]+)\s*\|\s*([^\]]+)\]/i);
        if (quoteMatch) {
            const vehicle = quoteMatch[1].trim();
            const service = quoteMatch[2].trim();
            const details = quoteMatch[3].trim();
            aiResponse = aiResponse.replace(/\[SOLICITAR_COTIZACION:[^\]]+\]/i, '').trim();

            await quotesService.createTicket(from, phoneNumber, vehicle, service, details);
        } else {
            // Verificar si la IA generó una repregunta técnica para Arias
            const consultMatch = aiResponse.match(/\[CONSULTAR_ARIAS:\s*([^\]]+)\]/i);

            if (consultMatch && activeTicket) {
                const techQuestion = consultMatch[1].trim();
                aiResponse = aiResponse.replace(/\[CONSULTAR_ARIAS:[^\]]+\]/i, '').trim();
                await quotesService.forwardCustomerFollowup(activeTicket, techQuestion);
            } else {
                aiResponse = aiResponse.replace(/\[CONSULTAR_ARIAS:[^\]]+\]/i, '').trim();

                // Filtrar cortesías, servicios de catálogo y agendamiento para NUNCA molestar a Arias con preguntas que el bot responde
                const isCourtesy = /^(gracias|muchas gracias|mil gracias|ok|vale|listo|dale|perfecto|excelente|bien|bueno|de una|está bien|ya voy|voy para allá|voy saliendo|hola|buenos días|buenas tardes|buenas noches|hasta luego|chao|adiós|grx|grax)[\s!.,]*$/i.test(cleanText);
                const isCatalogOrGeneral = /(alineaci|balanceo|aceite|combo|llanta|bater|plumilla|desinfecci|refrigerante|liquido|hora|cu[aá]ndo|cita|turno|d[ií]a|agend|llegar|llevar|donde|d[oó]nde|ubicaci[oó]n|pago|tarjeta|transferencia)/i.test(cleanText);

                // Si no fue cortesía ni servicio de catálogo/agendamiento y el cliente tiene un ticket activo con una repregunta técnica sobre el trabajo mecánico cotizado
                if (activeTicket && !isCourtesy && !isCatalogOrGeneral && !cleanText.includes('activar') && (cleanText.includes('cuanto') || cleanText.includes('incluye') || cleanText.includes('demora') || cleanText.includes('rebaja') || cleanText.includes('descuento') || cleanText.includes('repuesto'))) {
                    await quotesService.forwardCustomerFollowup(activeTicket, textMessage);
                }
            }
        }

        // Verificar si la IA activó traspaso a humano
        if (aiResponse.includes('[ESCALAR_HUMANO]')) {
            aiResponse = aiResponse.replace('[ESCALAR_HUMANO]', '').trim();
            const ownerPhone = process.env.OWNER_PHONE || '573016593654';
            const alertMsg = `🚨 *¡ATENCIÓN HUMANA REQUERIDA - LUBRI EXPERT!* 🚨\n\n📱 *Cliente:* +${phoneNumber}\n💬 *Último mensaje:* "${textMessage}"\n\n👉 *Abrir chat directo:* https://wa.me/${phoneNumber}`;
            
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
