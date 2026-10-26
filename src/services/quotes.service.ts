import fs from 'fs';
import path from 'path';
import { sendWhatsAppMessage, sendWhatsAppImage, sendWhatsAppDocument } from './whatsapp.service';
import { parseMechanicVoiceQuote, appendConversationMessage } from './ai.service';

export interface QuoteTicket {
    id: string; // "101", "102", ...
    customerJid: string;
    customerPhone: string;
    vehicle: string;
    service: string;
    details: string;
    status: 'PENDING' | 'QUOTED' | 'CLOSED';
    mechanicMessageId?: string;
    confirmMessageId?: string;
    quotePrice?: string;
    availability?: string | null;
    quoteNotes?: string;
    photoReceived?: boolean;
    createdAt: number;
    updatedAt: number;
}

const quotesFilePath = path.join(process.cwd(), 'quotes.json');

class QuotesService {
    private tickets: Record<string, QuoteTicket> = {};
    private nextId: number = 101;
    public mechanicPhone: string = process.env.MECHANIC_PHONE || '573147785316';
    public ownerPhone: string = process.env.OWNER_PHONE || '573016593654';
    public mechanicJid: string = '';

    constructor() {
        this.loadQuotes();
    }

    private loadQuotes() {
        try {
            if (fs.existsSync(quotesFilePath)) {
                const data = JSON.parse(fs.readFileSync(quotesFilePath, 'utf8'));
                this.tickets = data.tickets || {};
                this.nextId = data.nextId || 101;
                this.mechanicJid = data.mechanicJid || '';
            }
        } catch (err) {
            console.error('[QUOTES SERVICE] Error cargando quotes.json:', err);
            this.tickets = {};
            this.nextId = 101;
        }
    }

    private saveQuotes() {
        try {
            fs.writeFileSync(quotesFilePath, JSON.stringify({
                tickets: this.tickets,
                nextId: this.nextId,
                mechanicJid: this.mechanicJid
            }, null, 2), 'utf8');
        } catch (err) {
            console.error('[QUOTES SERVICE] Error guardando quotes.json:', err);
        }
    }

    /**
     * Verifica si el mensaje proviene de Arias el técnico
     * Identifica por teléfono, JID almacenado, mensaje citado de ticket, o comando de ticket
     */
    public isMechanic(
        phone: string,
        jid?: string,
        quotedStanzaId?: string,
        textMessage?: string
    ): boolean {
        const cleanPhone = phone.replace(/\D/g, '');
        const cleanMechanic = this.mechanicPhone.replace(/\D/g, '');

        // 1. Coincidencia por teléfono directo (+57 314 778 5316)
        if (cleanPhone && (cleanPhone === cleanMechanic || cleanPhone.endsWith(cleanMechanic.slice(-10)))) {
            if (jid) {
                this.mechanicJid = jid;
                this.saveQuotes();
            }
            return true;
        }

        // 2. Coincidencia por JID / LID previamente aprendido de Arias
        if (jid && this.mechanicJid && jid === this.mechanicJid) {
            return true;
        }

        // 3. Coincidencia por mensaje citado (Arias hizo swipe / citar en WhatsApp al ticket o confirmación)
        if (quotedStanzaId) {
            const hasMatchedTicket = Object.values(this.tickets).some(
                t => t.mechanicMessageId === quotedStanzaId || t.confirmMessageId === quotedStanzaId
            );
            if (hasMatchedTicket) {
                if (jid) {
                    this.mechanicJid = jid;
                    this.saveQuotes();
                }
                return true;
            }
        }

        // 4. Coincidencia por comando explícito de ticket (#101, #102...)
        if (textMessage) {
            const match = textMessage.match(/(?:#|ticket\s*#?)\s*(\d{3,4})\b/i);
            if (match && this.tickets[match[1]]) {
                if (jid) {
                    this.mechanicJid = jid;
                    this.saveQuotes();
                }
                return true;
            }
        }

        return false;
    }

    /**
     * Crea un ticket y notifica a Arias el técnico por WhatsApp
     */
    public async createTicket(
        customerJid: string,
        customerPhone: string,
        vehicle: string,
        service: string,
        details: string = ''
    ): Promise<QuoteTicket> {
        const id = String(this.nextId++);
        const now = Date.now();

        const ticket: QuoteTicket = {
            id,
            customerJid,
            customerPhone,
            vehicle: vehicle || 'Vehículo no especificado',
            service: service || 'Cotización de mecánica',
            details: details || 'Sin detalles adicionales',
            status: 'PENDING',
            createdAt: now,
            updatedAt: now
        };

        this.tickets[id] = ticket;
        this.saveQuotes();

        let displayPhone = ticket.customerPhone;
        if (displayPhone.length > 13) {
            displayPhone = 'Chat directo (WhatsApp)';
        } else {
            displayPhone = `+${displayPhone}`;
        }

        // Enviar ticket a Arias el técnico
        const mechanicMsg = `🔔 *NUEVA SOLICITUD DE COTIZACIÓN #${id}*\n\n` +
            `🚗 *Vehículo:* ${ticket.vehicle}\n` +
            `🔧 *Trabajo a cotizar:* ${ticket.service}\n` +
            `💬 *Detalle:* ${ticket.details}\n` +
            `📱 *Cliente:* ${displayPhone}\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `👉 *Para cotizar, responde/cita este mensaje con audio o texto:*\n` +
            `🎤 *Nota de voz:* Desliza este mensaje y habla (ej: "Son 140 mil mano de obra")\n` +
            `✍️ *Texto:* Desliza y pon el valor, o escribe: \`#${id} 140.000\``;

        const targetArias = this.mechanicJid || this.mechanicPhone;
        const sent = await sendWhatsAppMessage(targetArias, mechanicMsg);
        if (sent?.key?.id) {
            ticket.mechanicMessageId = sent.key.id;
            this.saveQuotes();
        }

        console.log(`[QUOTES] Ticket #${id} creado para ${displayPhone}. Notificado a Arias (${targetArias}).`);
        return ticket;
    }

    /**
     * Busca un ticket asignado a Arias según cita, comando o contexto
     */
    public findMechanicTicket(quotedStanzaId?: string, textMessage?: string): QuoteTicket | null {
        const cleanText = textMessage ? textMessage.trim() : '';

        // A) Por cita/deslizar mensaje en WhatsApp
        if (quotedStanzaId) {
            const byQuote = Object.values(this.tickets).find(
                t => t.mechanicMessageId === quotedStanzaId || t.confirmMessageId === quotedStanzaId
            );
            if (byQuote) return byQuote;
        }

        // B) Por comando explícito (#101, # 101, ticket 101)
        if (cleanText) {
            const match = cleanText.match(/(?:#|ticket\s*#?)\s*(\d{3,4})\b/i);
            if (match && this.tickets[match[1]]) {
                return this.tickets[match[1]];
            }
        }

        // C) Si empieza directamente por el número del ticket (ej: "101 140.000")
        if (cleanText) {
            const matchStart = cleanText.match(/^(\d{3,4})\b/);
            if (matchStart && this.tickets[matchStart[1]]) {
                return this.tickets[matchStart[1]];
            }
        }

        // D) Por contexto inteligente
        const pendingTickets = Object.values(this.tickets)
            .filter(t => t.status === 'PENDING')
            .sort((a, b) => b.updatedAt - a.updatedAt);

        if (pendingTickets.length === 1) {
            return pendingTickets[0];
        } else if (pendingTickets.length === 0) {
            const recentTickets = Object.values(this.tickets)
                .filter(t => (Date.now() - t.updatedAt < 2 * 60 * 60 * 1000))
                .sort((a, b) => b.updatedAt - a.updatedAt);

            if (recentTickets.length > 0) {
                return recentTickets[0];
            }
        }

        return null;
    }

    /**
     * Procesa la respuesta de Arias el técnico
     */
    public async handleMechanicMessage(
        from: string,
        textMessage: string,
        quotedStanzaId?: string
    ): Promise<boolean> {
        const cleanText = textMessage.trim();

        // 1. Buscar ticket:
        let matchedTicket: QuoteTicket | null = this.findMechanicTicket(quotedStanzaId, textMessage);

        // Si no se encuentra el ticket
        if (!matchedTicket) {
            const activeList = Object.values(this.tickets)
                .filter(t => t.status === 'PENDING')
                .map(t => `• *#${t.id}:* ${t.vehicle} - ${t.service}`)
                .join('\n');

            const helpMsg = `⚠️ *No pude identificar el número de ticket.*\n\n` +
                (activeList 
                    ? `Actualmente tienes estas cotizaciones pendientes:\n${activeList}\n\n👉 Por favor responde deslizando el mensaje de la cotización o escribiendo: \`#NUMERO [Precio]\``
                    : `No tienes cotizaciones pendientes en este momento.`);

            await sendWhatsAppMessage(this.mechanicJid || this.mechanicPhone, helpMsg);
            return true;
        }

        // Limpiar texto para extraer precio y notas
        let cleanQuote = cleanText
            .replace(new RegExp(`#?${matchedTicket.id}\\b`, 'gi'), '')
            .replace(/^[:\-,\s]+/, '')
            .trim();

        // Limpiar frases introductorias comunes como "el cambio de amortiguadores vale $120.000"
        cleanQuote = cleanQuote
            .replace(/^(el\s+trabajo|el\s+servicio|el\s+cambio(\s+de\s+[^,]+)?)\s+(vale|sale\s+en|cuesta|es\s+de)\s*/i, '')
            .replace(/^(vale|sale\s+en|cuesta|es\s+de)\s*/i, '')
            .trim();

        // Detectar si es una corrección
        const isCorrection = cleanQuote.toLowerCase().startsWith('corregir') ||
                             cleanText.toLowerCase().startsWith('no') ||
                             cleanText.toLowerCase().startsWith('espera') ||
                             cleanText.toLowerCase().startsWith('rectifico') ||
                             cleanText.toLowerCase().startsWith('error') ||
                             matchedTicket.status === 'QUOTED';

        if (isCorrection) {
            cleanQuote = cleanQuote
                .replace(/^corregir\s*/i, '')
                .replace(/^no[,\s]*/i, '')
                .replace(/^espera[,\s]*/i, '')
                .replace(/^rectifico[,\s]*/i, '')
                .replace(/^error[,\s]*/i, '')
                .trim();
        }

        if (!cleanQuote) {
            await sendWhatsAppMessage(this.mechanicJid || this.mechanicPhone, `⚠️ Por favor indica el valor o detalle para el ticket #${matchedTicket.id}. Ejemplo: \`#${matchedTicket.id} 120.000 mano de obra\``);
            return true;
        }

        // Si el mensaje es una frase conversacional o proviene de una nota de voz de Arias, procesar con IA
        let quotePrice = cleanQuote;
        let quoteAvailability: string | null = null;
        let quoteNotes: string | null = null;

        if (cleanQuote.split(' ').length > 2 || cleanQuote.toLowerCase().includes('mil') || cleanQuote.toLowerCase().includes('pesos') || cleanQuote.toLowerCase().includes('dile') || cleanQuote.toLowerCase().includes('explica') || cleanQuote.toLowerCase().includes('revision') || cleanQuote.toLowerCase().includes('revisión') || cleanQuote.toLowerCase().includes('costo') || cleanQuote.toLowerCase().includes('taller') || cleanQuote.toLowerCase().includes('hora') || cleanQuote.toLowerCase().includes('tarde') || cleanQuote.toLowerCase().includes('mañana') || cleanQuote.toLowerCase().includes('miercoles') || cleanQuote.toLowerCase().includes('miércoles') || isCorrection) {
            const aiParsed = await parseMechanicVoiceQuote(cleanQuote);
            if (aiParsed) {
                quotePrice = (aiParsed.price || cleanQuote).replace(/\*/g, '').trim();
                quoteAvailability = aiParsed.availability ? aiParsed.availability.replace(/\*/g, '').trim() : null;
                quoteNotes = aiParsed.notes ? aiParsed.notes.replace(/\*/g, '').trim() : null;
            }
        }

        matchedTicket.quotePrice = quotePrice;
        if (quoteAvailability) {
            matchedTicket.availability = quoteAvailability;
        }
        if (quoteNotes) {
            matchedTicket.quoteNotes = quoteNotes;
        }
        matchedTicket.status = 'QUOTED';
        matchedTicket.updatedAt = Date.now();
        this.saveQuotes();

        // 2. Enviar respuesta formal, cordial y humana al cliente
        let clientMsg = '';
        if (isCorrection) {
            clientMsg = `Disculpa, Arias, nuestro técnico especialista, te actualiza el valor exacto para tu ${matchedTicket.vehicle}:\n\n` +
                `🔧 Servicio: ${matchedTicket.service}\n` +
                `💵 Valor: ${matchedTicket.quotePrice}\n` +
                (matchedTicket.quoteNotes ? `💡 Nota del técnico: ${matchedTicket.quoteNotes}\n` : '') +
                (matchedTicket.availability ? `📅 Disponibilidad de Arias: ${matchedTicket.availability}\n\n` : `\n`) +
                `¿Te gustaría agendar una cita para esta semana? 🚗`;
        } else {
            clientMsg = `¡Hola! Arias, nuestro técnico especialista, revisó la cotización para tu ${matchedTicket.vehicle}:\n\n` +
                `🔧 Servicio: ${matchedTicket.service}\n` +
                `💵 Valor: ${matchedTicket.quotePrice}\n` +
                (matchedTicket.quoteNotes ? `💡 Nota del técnico: ${matchedTicket.quoteNotes}\n\n` : '\n') +
                (matchedTicket.availability ? `📅 Disponibilidad de Arias: ${matchedTicket.availability}\n\n` : '') +
                (matchedTicket.availability
                    ? `Recuerda que este trabajo se realiza con garantía técnica en nuestras bahías de servicio 🚗 ¿Te agendamos para esa hora o prefieres otro momento?`
                    : `Recuerda que este trabajo se realiza con garantía técnica en nuestras bahías de servicio (de lunes a sábado) 🚗 ¿Te gustaría agendar tu cita para hoy o mañana?`);
        }

        // Enviar respuesta al cliente (ÚNICAMENTE UNA SOLA VEZ)
        const targetCustomer = matchedTicket.customerJid || `${matchedTicket.customerPhone}@s.whatsapp.net`;
        await sendWhatsAppMessage(targetCustomer, clientMsg);

        // Guardar mensaje en el historial de conversación para asegurar congruencia total en el chat
        if (matchedTicket.customerPhone) {
            appendConversationMessage(matchedTicket.customerPhone, 'assistant', clientMsg);
        }
        if (matchedTicket.customerJid && matchedTicket.customerJid !== matchedTicket.customerPhone) {
            appendConversationMessage(matchedTicket.customerJid, 'assistant', clientMsg);
        }

        // 3. Confirmar a Arias el técnico
        let customerDisplay = matchedTicket.customerPhone;
        if (customerDisplay.length > 13) customerDisplay = 'Chat de WhatsApp';
        else customerDisplay = `+${customerDisplay}`;

        const actionText = isCorrection ? 'CORREGIDA y enviada' : 'enviada con éxito';
        const confirmMsg = `✅ *Cotización #${matchedTicket.id} ${actionText} al cliente (${customerDisplay}).*\n\n` +
            `🚗 *Vehículo:* ${matchedTicket.vehicle}\n` +
            `🔧 *Trabajo:* ${matchedTicket.service}\n` +
            `💵 *Valor enviado:* ${matchedTicket.quotePrice}\n` +
            (matchedTicket.quoteNotes ? `💡 *Nota enviada:* ${matchedTicket.quoteNotes}\n` : '') +
            (matchedTicket.availability ? `📅 *Disponibilidad enviada:* ${matchedTicket.availability}\n` : '') +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `*(Si el cliente hace preguntas adicionales, te notificaré aquí).*`;

        const sentConfirm = await sendWhatsAppMessage(this.mechanicJid || this.mechanicPhone, confirmMsg);
        if (sentConfirm?.key?.id) {
            matchedTicket.confirmMessageId = sentConfirm.key.id;
            this.saveQuotes();
        }

        console.log(`[QUOTES] Cotización #${matchedTicket.id} ${actionText} a ${customerDisplay}`);
        return true;
    }

    /**
     * Obtiene el ticket activo más reciente de un cliente
     */
    public getActiveCustomerTicket(customerJid?: string, customerPhone?: string): QuoteTicket | null {
        const now = Date.now();
        const cleanPhone = customerPhone ? customerPhone.replace(/\D/g, '') : '';
        const customerTickets = Object.values(this.tickets)
            .filter(t => {
                const matchJid = customerJid && t.customerJid === customerJid;
                const matchPhone = cleanPhone && (t.customerPhone === cleanPhone || t.customerPhone.endsWith(cleanPhone.slice(-10)));
                const isRecent = (now - t.createdAt < 24 * 60 * 60 * 1000);
                return (matchJid || matchPhone) && isRecent && t.status !== 'CLOSED';
            })
            .sort((a, b) => b.createdAt - a.createdAt);

        return customerTickets[0] || null;
    }

    /**
     * Cierra un ticket activo para evitar loops o interferencias cuando el cliente cambia de vehículo
     */
    public closeTicket(ticketId: string, reason?: string): boolean {
        if (this.tickets[ticketId]) {
            this.tickets[ticketId].status = 'CLOSED';
            this.tickets[ticketId].updatedAt = Date.now();
            this.saveQuotes();
            console.log(`[QUOTES] Ticket #${ticketId} cerrado. Motivo: ${reason || 'N/A'}`);
            return true;
        }
        return false;
    }

    /**
     * Reenvía a Arias una pregunta o requerimiento adicional del cliente
     */
    public async forwardCustomerFollowup(ticket: QuoteTicket, followupText: string) {
        const cleanFollowup = followupText.trim().toLowerCase();
        const isCourtesy = /^(gracias|muchas gracias|mil gracias|ok|vale|listo|dale|perfecto|excelente|bien|bueno|de una|está bien|ya voy|voy para allá|voy saliendo|hola|buenos días|buenas tardes|buenas noches|hasta luego|chao|adiós|grx|grax)[\s!.,]*$/i.test(cleanFollowup);
        if (isCourtesy) {
            return;
        }

        const updateMsg = `🔔 *PREGUNTA ADICIONAL DEL CLIENTE - TICKET #${ticket.id}*\n\n` +
            `🚗 *Vehículo:* ${ticket.vehicle}\n` +
            `🔧 *Servicio inicial:* ${ticket.service}\n` +
            `💬 *El cliente pregunta:* "${followupText}"\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `👉 *Responde citando este mensaje o con:*\n` +
            `*#${ticket.id} [Respuesta / Precio adicional]*`;

        const sent = await sendWhatsAppMessage(this.mechanicPhone, updateMsg);
        if (sent?.key?.id) {
            ticket.mechanicMessageId = sent.key.id;
            ticket.updatedAt = Date.now();
            this.saveQuotes();
        }
    }

    /**
     * Reenvía una foto o documento del cliente a Arias el técnico (+57 314 778 5316)
     */
    public async forwardCustomerMedia(
        ticket: QuoteTicket,
        mediaPath: string,
        isDocument: boolean = false,
        filename: string = 'documento.pdf',
        customerComment: string = ''
    ): Promise<boolean> {
        let displayPhone = ticket.customerPhone;
        if (displayPhone.length > 13) displayPhone = 'Chat de WhatsApp';
        else displayPhone = `+${displayPhone}`;

        const ariasCaption = `📸 *FOTO / DOCUMENTO DEL CLIENTE - TICKET #${ticket.id}*\n\n` +
            `🚗 *Vehículo:* ${ticket.vehicle}\n` +
            `🔧 *Trabajo inicial:* ${ticket.service}\n` +
            `📱 *Cliente:* ${displayPhone}\n` +
            (customerComment ? `💬 *Mensaje del cliente:* "${customerComment}"\n` : '') +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `👉 *Arias, aquí tienes la foto/documento enviada por el cliente para la cotización de repuestos o revisión.*\n` +
            `*(Para responder, desliza esta imagen con audio o texto: \`#${ticket.id} [Valor/Notas]\`)*`;

        const targetArias = this.mechanicJid || this.mechanicPhone;
        let sent: any = null;
        if (isDocument) {
            sent = await sendWhatsAppDocument(targetArias, mediaPath, filename, ariasCaption);
        } else {
            sent = await sendWhatsAppImage(targetArias, mediaPath, ariasCaption);
        }

        ticket.photoReceived = true;
        if (ticket.quoteNotes && /(foto|tarjeta|imagen|documento)/i.test(ticket.quoteNotes)) {
            ticket.quoteNotes = 'Foto de la tarjeta de propiedad / repuesto ya recibida del cliente y reenviada a Arias.';
        }

        if (sent?.key?.id) {
            ticket.mechanicMessageId = sent.key.id;
        }
        ticket.updatedAt = Date.now();
        this.saveQuotes();

        console.log(`[QUOTES] Foto/documento del ticket #${ticket.id} reenviada exitosamente a Arias (${targetArias})`);
        return true;
    }

    /**
     * Reenvía una foto o documento de Arias al cliente
     */
    public async forwardMechanicMediaToCustomer(
        ticket: QuoteTicket,
        mediaPath: string,
        isDocument: boolean = false,
        filename: string = 'documento.pdf',
        mechanicCaption: string = ''
    ): Promise<boolean> {
        const targetCustomer = ticket.customerJid || `${ticket.customerPhone}@s.whatsapp.net`;
        const clientCaption = `¡Hola! Arias, nuestro técnico especialista, te comparte esta imagen respecto a la cotización de tu ${ticket.vehicle}:\n\n` +
            (mechanicCaption ? `🔧 ${mechanicCaption}\n\n` : '') +
            `¿Tienes alguna duda o te gustaría agendar tu cita? 🚗`;

        if (isDocument) {
            await sendWhatsAppDocument(targetCustomer, mediaPath, filename, clientCaption);
        } else {
            await sendWhatsAppImage(targetCustomer, mediaPath, clientCaption);
        }

        appendConversationMessage(ticket.customerPhone, 'assistant', clientCaption);
        if (ticket.customerJid && ticket.customerJid !== ticket.customerPhone) {
            appendConversationMessage(ticket.customerJid, 'assistant', clientCaption);
        }

        console.log(`[QUOTES] Foto de Arias reenviada al cliente (${ticket.customerPhone})`);
        return true;
    }
}

export const quotesService = new QuotesService();
