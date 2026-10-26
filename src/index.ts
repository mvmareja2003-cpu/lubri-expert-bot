import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import express from 'express';
import cors from 'cors';
import { getAiResponse, transcribeAudio, appendConversationMessage, clearCustomerConversation } from './services/ai.service';
import { sock, initWhatsAppClient, sendWhatsAppMessage, sendWhatsAppImage, sendWhatsAppDocument, downloadWhatsAppMedia } from './services/whatsapp.service';
import { quotesService, QuoteTicket } from './services/quotes.service';

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

/**
 * Detecta si el cliente desea cotizar un vehículo o servicio diferente al ticket activo
 */
const detectVehicleSwitch = (cleanText: string, activeTicket: QuoteTicket | null): boolean => {
    if (!activeTicket) return false;
    const cleanLower = cleanText.toLowerCase().trim();
    const switchesVehicle = /(otro\s+(veh[ií]culo|carro|auto|coche|moto|camioneta)|otra\s+cotizaci[oó]n|cot[ií]zame\s+otro|cotizar\s+otro|tengo\s+otro|para\s+otro|cambiar\s+de\s+carro|este\s+es\s+otro|es\s+para\s+otro|cotizar\s+otra\s+cosa)/i.test(cleanLower);

    let mentionsDifferentVehicle = false;
    if (activeTicket.vehicle) {
        const ticketVehicleWords = activeTicket.vehicle.toLowerCase().split(/[\s\-_]+/);
        const knownMakesAndModels = [
            'renault', 'chevrolet', 'mazda', 'toyota', 'kia', 'hyundai', 'nissan', 'ford',
            'volkswagen', 'vw', 'suzuki', 'honda', 'mitsubishi', 'subaru', 'peugeot',
            'citroen', 'fiat', 'jeep', 'dodge', 'ram', 'byd', 'chery', 'jac', 'foton',
            'great wall', 'haval', 'geely', 'bmw', 'mercedes', 'audi', 'seat', 'skoda',
            'duster', 'sandero', 'logan', 'stepway', 'kwid', 'clio', 'captur', 'koleos', 'twingo', 'megane', 'scenic', 'symbol',
            'spark', 'sail', 'aveo', 'onix', 'tracker', 'captiva', 'cruze', 'dmax', 'd-max', 'optra', 'corsa', 'luv', 'beat', 'joy',
            'cx-3', 'cx-5', 'cx-30', 'cx-50', 'cx-9', 'mazda 2', 'mazda 3', 'mazda 6', 'allegro', 'mileno', 'matsuri',
            'picanto', 'rio', 'cerato', 'sportage', 'sorento', 'soluto', 'stonic', 'niro', 'seltos',
            'tucson', 'i10', 'i25', 'i35', 'accent', 'creta', 'getz', 'santa fe', 'elantra', 'kona',
            'hilux', 'corolla', 'yaris', 'fortuner', 'prado', 'rav4', 'land cruiser', '4runner', 'etios', 'rush',
            'march', 'versa', 'frontier', 'kicks', 'qashqai', 'sentra', 'tiida', 'xtrail', 'x-trail', 'navara',
            'gol', 'polo', 'voyage', 'jetta', 'golf', 'amarok', 't-cross', 'nivus', 'taos', 'tiguan', 'fox', 'crossfox', 'vento',
            'fiesta', 'focus', 'ecosport', 'escape', 'explorer', 'ranger', 'edge', 'f-150', 'f150', 'fusion',
            'swift', 'vitara', 'grand vitara', 'jimny', 'alto', 'baleno', 's-cross', 'ignis', 'celerio'
        ];
        for (const brand of knownMakesAndModels) {
            const regex = new RegExp(`\\b${brand}\\b`, 'i');
            if (regex.test(cleanLower) && !ticketVehicleWords.includes(brand)) {
                mentionsDifferentVehicle = true;
                break;
            }
        }
    }

    return switchesVehicle || mentionsDifferentVehicle;
};

/**
 * Prepara el contexto del ticket activo y maneja el cambio de vehículo o reseteo de contexto
 */
const prepareCustomerTicketContext = (
    from: string,
    phoneNumber: string,
    messageText: string
): { activeTicket: QuoteTicket | null; ticketContext?: string } => {
    let activeTicket = quotesService.getActiveCustomerTicket(from, phoneNumber);
    let ticketContext: string | undefined = undefined;

    if (activeTicket) {
        const isSwitching = detectVehicleSwitch(messageText, activeTicket);
        if (isSwitching) {
            console.log(`[COTIZADOR] Cliente +${phoneNumber} solicitó cambio de vehículo o cotizar otro auto. Cerrando ticket #${activeTicket.id} (${activeTicket.vehicle}).`);
            quotesService.closeTicket(activeTicket.id, 'Cliente solicitó cotizar otro vehículo / tema');
            clearCustomerConversation(phoneNumber);
            activeTicket = null;
            ticketContext = `ATENCIÓN: El cliente desea cotizar un NUEVO vehículo o servicio diferente al anterior. Olvida completamente la cotización previa, el precio previo, la cita o disponibilidad anterior y cualquier nota de fotos anterior. Solicita marca, modelo, año y posición si faltan, y genera de inmediato la etiqueta [SOLICITAR_COTIZACION] en cuanto tengas esos datos.`;
        } else if (activeTicket.status === 'QUOTED') {
            let notes = activeTicket.quoteNotes || '';
            if (activeTicket.photoReceived) {
                notes = 'Foto del cliente ya fue recibida y compartida con Arias.';
            }
            ticketContext = `Ticket #${activeTicket.id} (${activeTicket.vehicle} - ${activeTicket.service}): Cotizado por Arias en ${activeTicket.quotePrice}.` +
                (notes ? ` Nota/Explicación técnica de Arias: ${notes}.` : '') +
                (activeTicket.availability ? ` Disponibilidad indicada por Arias: ${activeTicket.availability}.` : ' Arias no indicó hora específica, preguntar al cliente su preferencia.');
        }
    }

    return { activeTicket, ticketContext };
};

// Endpoint para el simulador web o pruebas locales
app.post('/api/chat', async (req, res) => {
    try {
        const { message, phoneNumber = '573109998877' } = req.body;
        if (!message) {
            res.status(400).json({ error: 'Mensaje requerido' });
            return;
        }

        const from = `${phoneNumber}@s.whatsapp.net`;
        const { activeTicket, ticketContext } = prepareCustomerTicketContext(from, phoneNumber, message);

        let aiReply = await getAiResponse(message, phoneNumber, ticketContext);

        const quoteMatch = aiReply.match(/\[SOLICITAR_COTIZACION:\s*([^\|]+)\s*\|\s*([^\|]+)\s*\|\s*([^\]]+)\]/i);
        if (quoteMatch) {
            const vehicle = quoteMatch[1].trim();
            const service = quoteMatch[2].trim();
            const details = quoteMatch[3].trim();
            aiReply = aiReply.replace(/\[SOLICITAR_COTIZACION:[^\]]+\]/i, '').trim();
            await quotesService.createTicket(from, phoneNumber, vehicle, service, details);
        }

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

        const contextInfo = actualMsg?.extendedTextMessage?.contextInfo || actualMsg?.audioMessage?.contextInfo || actualMsg?.imageMessage?.contextInfo || actualMsg?.documentMessage?.contextInfo;
        const quotedStanzaId = contextInfo?.stanzaId;

        // Extraer número de teléfono real del remitente (desenredando LIDs @lid de WhatsApp)
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

        let textMessage = actualMsg?.conversation || 
                          actualMsg?.extendedTextMessage?.text || 
                          actualMsg?.imageMessage?.caption || 
                          actualMsg?.videoMessage?.caption || 
                          actualMsg?.documentMessage?.caption || '';

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
            console.log(`[MEDIA] Recibido archivo/foto de ${from} (+${phoneNumber}). Descargando...`);
            const mediaPath = await downloadWhatsAppMedia(msg);
            const isDoc = !!actualMsg?.documentMessage;
            const filename = actualMsg?.documentMessage?.fileName || (isDoc ? 'documento.pdf' : 'foto.jpg');

            const isArias = quotesService.isMechanic(phoneNumber, from, quotedStanzaId, textMessage);

            if (isArias) {
                // Si Arias envía una foto o documento para el cliente:
                const matchedTicket = quotesService.findMechanicTicket(quotedStanzaId, textMessage);
                if (matchedTicket && mediaPath) {
                    await quotesService.forwardMechanicMediaToCustomer(matchedTicket, mediaPath, isDoc, filename, textMessage);
                    try { fs.unlinkSync(mediaPath); } catch (e) { }
                    await sendWhatsAppMessage(quotesService.mechanicJid || quotesService.mechanicPhone, `✅ Foto/documento del ticket #${matchedTicket.id} enviada al cliente.`);
                    return;
                }
            } else {
                // Mensaje proviene de un cliente:
                const activeTicket = quotesService.getActiveCustomerTicket(from, phoneNumber);

                if (activeTicket && mediaPath) {
                    // ¡EL CLIENTE TIENE UN TICKET CON ARIAS! Reenviar la foto DIRECTAMENTE a Arias
                    console.log(`[MEDIA] Cliente +${phoneNumber} envió foto/documento con ticket activo #${activeTicket.id}. Reenviando a Arias...`);
                    await quotesService.forwardCustomerMedia(activeTicket, mediaPath, isDoc, filename, textMessage);

                    // Notificar también al dueño de Lubri Expert para respaldo
                    const ownerPhone = process.env.OWNER_PHONE || '573016593654';
                    const alertMsg = `📸 *FOTO / DOCUMENTO RECIBIDO DEL CLIENTE - TICKET #${activeTicket.id}*\n\n` +
                        `🚗 *Vehículo:* ${activeTicket.vehicle}\n` +
                        `🔧 *Servicio:* ${activeTicket.service}\n` +
                        `📱 *Cliente:* +${phoneNumber}\n` +
                        `👉 *Reenviada automáticamente a Arias para cotizar repuestos/revisión.*`;
                    if (isDoc) {
                        await sendWhatsAppDocument(ownerPhone, mediaPath, filename, alertMsg);
                    } else {
                        await sendWhatsAppImage(ownerPhone, mediaPath, alertMsg);
                    }

                    try { fs.unlinkSync(mediaPath); } catch (e) { }

                    const replyMsg = `¡Muchas gracias por la foto! 📸 Ya se la compartí directamente a Arias, nuestro técnico especialista, para revisar los repuestos y detalles de tu ${activeTicket.vehicle}. En unos momentos te confirmamos la información 🚗`;
                    await sendWhatsAppMessage(from, replyMsg);
                    appendConversationMessage(phoneNumber, 'assistant', replyMsg);
                    return;
                } else if (mediaPath) {
                    // Si no tiene ticket activo con Arias, enviar al asesor humano / dueño
                    const ownerPhone = process.env.OWNER_PHONE || '573016593654';
                    const alertMsg = `🚨 *¡ATENCIÓN HUMANA REQUERIDA - LUBRI EXPERT!* 🚨\n\n📱 *Cliente:* +${phoneNumber}\n📄 *Motivo:* Envió una foto o documento (tarjeta de propiedad, daño o comprobante).\n\n👉 *Abrir chat directo:* https://wa.me/${phoneNumber}`;
                    if (isDoc) {
                        await sendWhatsAppDocument(ownerPhone, mediaPath, filename, alertMsg);
                    } else {
                        await sendWhatsAppImage(ownerPhone, mediaPath, alertMsg);
                    }
                    try { fs.unlinkSync(mediaPath); } catch (e) { }

                    await sendWhatsAppMessage(from, 'Muchas gracias por la foto. Nuestro asesor de servicio la revisará en breve 🚗');
                    return;
                }
            }
            return;
        }

        if (!textMessage || textMessage.trim().length === 0) return;

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

        // Obtener ticket activo reciente e interpretar contexto o cambio de vehículo
        const { activeTicket, ticketContext } = prepareCustomerTicketContext(from, phoneNumber, textMessage);

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
