import fs from 'fs';
import path from 'path';
import { sendWhatsAppMessage } from './whatsapp.service';

export interface QuoteTicket {
    id: string; // "101", "102", ...
    customerJid: string;
    customerPhone: string;
    vehicle: string;
    service: string;
    details: string;
    status: 'PENDING' | 'QUOTED' | 'CLOSED';
    mechanicMessageId?: string;
    quotePrice?: string;
    quoteNotes?: string;
    createdAt: number;
    updatedAt: number;
}

const quotesFilePath = path.join(process.cwd(), 'quotes.json');

class QuotesService {
    private tickets: Record<string, QuoteTicket> = {};
    private nextId: number = 101;
    public mechanicPhone: string = process.env.MECHANIC_PHONE || '573147785316';
    public ownerPhone: string = process.env.OWNER_PHONE || '573016593654';

    constructor() {
        this.loadQuotes();
    }

    private loadQuotes() {
        try {
            if (fs.existsSync(quotesFilePath)) {
                const data = JSON.parse(fs.readFileSync(quotesFilePath, 'utf8'));
                this.tickets = data.tickets || {};
                this.nextId = data.nextId || 101;
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
                nextId: this.nextId
            }, null, 2), 'utf8');
        } catch (err) {
            console.error('[QUOTES SERVICE] Error guardando quotes.json:', err);
        }
    }

    /**
     * Verifica si el número que envía el mensaje es Arias el técnico
     */
    public isMechanic(phone: string): boolean {
        const cleanPhone = phone.replace(/\D/g, '');
        const cleanMechanic = this.mechanicPhone.replace(/\D/g, '');
        return cleanPhone === cleanMechanic || cleanPhone.endsWith(cleanMechanic.slice(-10));
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

        // Enviar ticket a Arias el técnico
        const mechanicMsg = `🔔 *NUEVA SOLICITUD DE COTIZACIÓN #${id}*\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `🚗 *Vehículo:* ${ticket.vehicle}\n` +
            `🔧 *Trabajo a cotizar:* ${ticket.service}\n` +
            `💬 *Detalle:* ${ticket.details}\n` +
            `📱 *Cliente:* +${ticket.customerPhone}\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `👉 *Para cotizar, responde/cita este mensaje o escribe:*\n` +
            `*#${id} [Precio] [Detalle opcional]*\n\n` +
            `*Ejemplos:* \n` +
            `• Desliza este mensaje y pon: \`140.000 mano de obra\`\n` +
            `• O escribe: \`#${id} 140.000\``;

        const sent = await sendWhatsAppMessage(this.mechanicPhone, mechanicMsg);
        if (sent?.key?.id) {
            ticket.mechanicMessageId = sent.key.id;
            this.saveQuotes();
        }

        console.log(`[QUOTES] Ticket #${id} creado para +${customerPhone}. Notificado a Arias (+${this.mechanicPhone}).`);
        return ticket;
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
        // A) Por cita/deslizar mensaje en WhatsApp
        let matchedTicket: QuoteTicket | null = null;

        if (quotedStanzaId) {
            matchedTicket = Object.values(this.tickets).find(
                t => t.mechanicMessageId === quotedStanzaId
            ) || null;
        }

        // B) Por número de ticket explícito (#101 o 101)
        if (!matchedTicket) {
            const match = cleanText.match(/#?(\d{3,4})/);
            if (match) {
                const idCandidate = match[1];
                if (this.tickets[idCandidate]) {
                    matchedTicket = this.tickets[idCandidate];
                }
            }
        }

        // C) Si no puso número pero solo hay 1 ticket PENDING activo
        if (!matchedTicket) {
            const pendingTickets = Object.values(this.tickets).filter(t => t.status === 'PENDING');
            if (pendingTickets.length === 1) {
                matchedTicket = pendingTickets[0];
            }
        }

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

            await sendWhatsAppMessage(this.mechanicPhone, helpMsg);
            return true;
        }

        // Limpiar texto para extraer precio y notas
        let cleanQuote = cleanText
            .replace(new RegExp(`#?${matchedTicket.id}\\b`, 'gi'), '')
            .replace(/^[:\-,\s]+/, '')
            .trim();

        if (!cleanQuote) {
            await sendWhatsAppMessage(this.mechanicPhone, `⚠️ Por favor indica el valor o detalle para el ticket #${matchedTicket.id}. Ejemplo: \`#${matchedTicket.id} 120.000 mano de obra\``);
            return true;
        }

        // Verificar si es una corrección
        const isCorrection = cleanQuote.toLowerCase().startsWith('corregir');
        if (isCorrection) {
            cleanQuote = cleanQuote.replace(/^corregir\s*/i, '').trim();
        }

        matchedTicket.quotePrice = cleanQuote;
        matchedTicket.status = 'QUOTED';
        matchedTicket.updatedAt = Date.now();
        this.saveQuotes();

        // 2. Enviar respuesta formal, cordial y humana al cliente
        let clientMsg = '';
        if (isCorrection) {
            clientMsg = `Disculpa, Arias, nuestro técnico especialista, estaba validando dos cotizaciones en simultáneo y te actualiza el valor exacto para tu ${matchedTicket.vehicle}:\n\n` +
                `🔧 Servicio: ${matchedTicket.service}\n` +
                `💵 Valor: ${cleanQuote}\n\n` +
                `¿Te gustaría agendar una cita para esta semana? 🚗`;
        } else {
            clientMsg = `¡Hola! Arias, nuestro técnico especialista, revisó la cotización para tu ${matchedTicket.vehicle}:\n\n` +
                `🔧 Servicio: ${matchedTicket.service}\n` +
                `💵 Valor: ${cleanQuote}\n\n` +
                `Recuerda que este trabajo se realiza con garantía técnica en nuestras bahías de servicio (de lunes a sábado) 🚗 ¿Te gustaría agendar tu cita para hoy o mañana?`;
        }

        await sendWhatsAppMessage(matchedTicket.customerJid, clientMsg);

        // 3. Confirmar a Arias el técnico
        const confirmMsg = `✅ *Cotización #${matchedTicket.id} enviada con éxito al cliente (+${matchedTicket.customerPhone}).*\n` +
            `🚗 *Vehículo:* ${matchedTicket.vehicle}\n` +
            `🔧 *Trabajo:* ${matchedTicket.service}\n` +
            `💵 *Valor enviado:* ${cleanQuote}\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `*(Si el cliente hace preguntas adicionales, te notificaré aquí).*`;

        await sendWhatsAppMessage(this.mechanicPhone, confirmMsg);
        console.log(`[QUOTES] Cotización #${matchedTicket.id} respondida por Arias y remitida a +${matchedTicket.customerPhone}`);
        return true;
    }

    /**
     * Obtiene el ticket activo más reciente de un cliente
     */
    public getActiveCustomerTicket(customerJid: string): QuoteTicket | null {
        const now = Date.now();
        const customerTickets = Object.values(this.tickets)
            .filter(t => t.customerJid === customerJid && (now - t.createdAt < 24 * 60 * 60 * 1000))
            .sort((a, b) => b.createdAt - a.createdAt);

        return customerTickets[0] || null;
    }

    /**
     * Reenvía a Arias una pregunta o requerimiento adicional del cliente
     */
    public async forwardCustomerFollowup(ticket: QuoteTicket, followupText: string) {
        const updateMsg = `🔔 *PREGUNTA ADICIONAL DEL CLIENTE - TICKET #${ticket.id}*\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
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
}

export const quotesService = new QuotesService();
