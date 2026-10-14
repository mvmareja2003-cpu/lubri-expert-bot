import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || '',
});

const knowledgeBasePath = path.join(process.cwd(), 'knowledge_base.md');
let knowledgeBase = '';
try {
  if (fs.existsSync(knowledgeBasePath)) {
    knowledgeBase = fs.readFileSync(knowledgeBasePath, 'utf8');
  }
} catch (error) {
  console.error('[AI SERVICE] Error cargando knowledge_base.md:', error);
}

const getSystemPrompt = (): string => {
  return `
Eres Andrés, el asesor estrella de servicio al cliente de "Lubri Expert" (by Cerón Zapata) en Palmira, Valle del Cauca.
Tu objetivo principal es atender a los conductores, asesorarlos con amabilidad, recomendarles el mejor servicio y concretar su visita o turno en la serviteca.

REGLA DE ORO 1: Eres un ser humano real, asesor de Lubri Expert. NUNCA digas que eres un bot, una inteligencia artificial, asistente virtual o robot.
REGLA DE ORO 2: Tus respuestas DEBEN ser MUY CORTAS (máximo 1 a 2 oraciones por mensaje). En WhatsApp a los clientes no les gusta leer textos largos. Sé directo, ágil y servicial.
REGLA DE ORO 3: PROHIBIDO USAR ASTERISCOS (*). No uses asteriscos para resaltar textos en negrita ni viñetas. Usa texto plano limpio y emojis automotrices (🚗, 🛢️, 🔧, 📍, ⏰) para que el chat se vea 100% natural, como una persona escribiendo por WhatsApp.

ESTA ES LA INFORMACIÓN OFICIAL DE LUBRI EXPERT:
${knowledgeBase}

REGLAS DE TONO Y OPERACIÓN:
1. SALUDO INICIAL: Si es la primera interacción, saluda cordial: "¡Hola! Bienvenido a Lubri Expert Palmira 🚗 ¿En qué te podemos colaborar hoy? ¿Buscas cambio de aceite, llantas, alineación o escáner?"
2. CAMBIO DE ACEITE: Si preguntan qué aceite lleva su vehículo o precio, pregúntale de forma concisa:
   "¿Qué carro o moto tienes, de qué año y qué kilometraje aproximado tiene? 🛢️"
   Con esos datos, recomiéndale la viscosidad y las marcas líderes (Mobil, Motul, Castrol, Shell, Terpel) y aclara que el servicio express incluye revisión gratuita de niveles y fugas.
3. LLANTAS Y ALINEACIÓN: Pregunta la medida de la llanta (ejemplo: 185/65 R15). Menciona que manejamos marcas como Pirelli, Greenlander y Wanda, con alineación computarizada 3D y balanceo.
4. HORARIOS Y UBICACIÓN:
   - Estamos en la Carrera 34C # 44-176 en Palmira (fácil acceso).
   - Lunes a viernes de 7:00 am a 5:00 pm, sábados de 7:00 am a 4:30 pm y domingos de 7:30 am a 12:30 pm.
   - Atendemos sin cita previa por orden de llegada con servicio express.
5. ESCALAMIENTO HUMANO:
   Si el cliente pide expresamente hablar con una persona ("asesor", "humano", "persona", "comunicarme con alguien") o requiere una cotización mecánica especializada:
   Respóndele muy amable diciendo que ya lo estás comunicando con un asesor técnico de la serviteca e incluye exactamente al final la etiqueta: [ESCALAR_HUMANO]
`;
};

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const conversations: Record<string, ChatMessage[]> = {};

export const getAiResponse = async (message: string, phone: string): Promise<string> => {
  // Si no hay API key de OpenAI, usar respuestas inteligentes basadas en la base de conocimiento
  if (!process.env.OPENAI_API_KEY) {
    return handleKnowledgeFallback(message);
  }

  try {
    if (!conversations[phone]) {
      conversations[phone] = [
        { role: 'system', content: getSystemPrompt() }
      ];
    } else {
      conversations[phone][0] = { role: 'system', content: getSystemPrompt() };
    }

    conversations[phone].push({ role: 'user', content: message });

    // Mantener historial compacto (últimos 12 mensajes)
    if (conversations[phone].length > 14) {
      conversations[phone] = [
        conversations[phone][0],
        ...conversations[phone].slice(-12)
      ];
    }

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: conversations[phone] as any,
      temperature: 0.5,
      max_tokens: 250
    });

    const aiMessage = response.choices[0]?.message?.content || 'Un momento por favor, ya te confirmo esa información.';
    conversations[phone].push({ role: 'assistant', content: aiMessage });

    return aiMessage;
  } catch (error: any) {
    console.error('[AI SERVICE] Error OpenAI:', error?.message || error);
    return handleKnowledgeFallback(message);
  }
};

export const transcribeAudio = async (filePath: string): Promise<string | null> => {
  if (!process.env.OPENAI_API_KEY) return null;

  try {
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: 'whisper-1',
      language: 'es',
    });
    return transcription.text;
  } catch (error) {
    console.error('[AI SERVICE] Error transcribiendo audio con Whisper:', error);
    return null;
  }
};

const handleKnowledgeFallback = (message: string): string => {
  const text = message.toLowerCase();

  if (text.includes('asesor') || text.includes('humano') || text.includes('persona') || text.includes('hablar con')) {
    return 'Con gusto, te comunico en este instante con uno de nuestros asesores de servicio. [ESCALAR_HUMANO]';
  } else if (text.includes('horario') || text.includes('hora') || text.includes('abierto') || text.includes('domingo')) {
    return 'Atendemos de lunes a viernes de 7:00 am a 5:00 pm, sábados de 7:00 am a 4:30 pm y domingos de 7:30 am a 12:30 pm en jornada continua 🚗';
  } else if (text.includes('donde') || text.includes('ubicacion') || text.includes('direccion') || text.includes('queda')) {
    return 'Estamos ubicados en la Carrera 34C # 44-176 en Palmira, con fácil acceso vehicular y bahía express 📍';
  } else if (text.includes('aceite') || text.includes('filtro') || text.includes('lubricante')) {
    return 'Manejamos las mejores marcas como Mobil, Motul y Castrol. ¿Qué vehículo tienes, qué año es y qué kilometraje tiene aproximadamente? 🛢️';
  } else if (text.includes('llanta') || text.includes('alineacion') || text.includes('balanceo')) {
    return 'Tenemos llantas Pirelli, Greenlander y Wanda con alineación 3D y balanceo. ¿Qué medida de llanta estás buscando? 🛞';
  } else if (text.includes('escaner') || text.includes('check') || text.includes('falla') || text.includes('diagnostico')) {
    return 'Realizamos escaneo computarizado para diagnosticar fallas y el testigo Check Engine. ¿Qué síntoma presenta tu carro? 🔌';
  }

  return '¡Hola! Bienvenido a Lubri Expert Palmira 🚗 ¿En qué servicio te podemos colaborar hoy?';
};
