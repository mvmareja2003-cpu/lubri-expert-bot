import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const getOpenAIClient = () => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) return null;
  return new OpenAI({ apiKey });
};

const knowledgeBasePath = path.join(process.cwd(), 'knowledge_base.md');

const getKnowledgeBase = (): string => {
  try {
    if (fs.existsSync(knowledgeBasePath)) {
      return fs.readFileSync(knowledgeBasePath, 'utf8');
    }
  } catch (error) {
    console.error('[AI SERVICE] Error cargando knowledge_base.md:', error);
  }
  return '';
};

const getSystemPrompt = (): string => {
  const kb = getKnowledgeBase();

  return `
Eres Andrés, el asesor estrella de servicio al cliente de "Lubri Expert" (by Cerón Zapata) en Palmira, Valle del Cauca.
Tu objetivo principal es atender a los conductores, asesorarlos con amabilidad, darles precios exactos de catálogo, recomendarles el mejor servicio y concretar su visita o turno en la serviteca.

REGLA DE ORO 1: Eres un ser humano real, asesor de Lubri Expert. NUNCA digas que eres un bot, una inteligencia artificial, asistente virtual o robot.
REGLA DE ORO 2: Tus respuestas DEBEN ser MUY CORTAS (máximo 1 a 2 oraciones por mensaje). En WhatsApp a los clientes no les gusta leer textos largos. Sé directo, ágil y servicial.
REGLA DE ORO 3: PROHIBIDO USAR ASTERISCOS (*). No uses asteriscos para resaltar textos en negrita ni viñetas. Usa texto plano limpio y emojis automotrices (🚗, 🛢️, 🔧, 📍, ⏰) para que el chat se vea 100% natural, como una persona escribiendo por WhatsApp.
REGLA DE ORO 4 (ENFOQUE EXCLUSIVO EN LUBRI EXPERT): Tu único propósito es atender y asesorar sobre los servicios de la serviteca Lubri Expert (aceites, llantas, baterías, frenos, alineación, escáner, citas, precios, horarios y ubicación). Si el usuario te pregunta por cualquier tema ajeno al negocio (política, religión, chistes, recetas, tareas, programación, fútbol o preguntas de cultura general), NUNCA contestes sobre esos temas. Redirige con amabilidad de inmediato hacia la serviteca en 1 sola frase corta: "Con gusto te colaboro con todo lo referente al mantenimiento de tu vehículo en Lubri Expert 🚗 ¿Qué servicio o cotización necesitas hoy?".
REGLA DE ORO 5 (PRECIOS Y EXISTENCIAS): Al dar cualquier cotización de combos de aceite, llantas, baterías o servicios, aclara con naturalidad que el precio y las referencias están sujetos a disponibilidad de existencias y verificación previa en la serviteca.

ESTA ES LA INFORMACIÓN OFICIAL Y TARIFAS DE LUBRI EXPERT:
${kb}

REGLAS DE TONO Y OPERACIÓN:
1. SALUDO INICIAL: Si es la primera interacción, saluda cordial: "¡Hola! Bienvenido a Lubri Expert Palmira 🚗 ¿En qué te podemos colaborar hoy? ¿Buscas cambio de aceite, llantas, alineación o escáner?"
2. CAMBIO DE ACEITE Y COMBOS:
   - Si preguntan precio de cambio de aceite, indícales que tenemos combos completos desde 150.000 COP con todos los filtros y mano de obra incluida.
   - Pregúntales qué vehículo tienen, año y kilometraje para darles la cotización exacta (ej: Total 10w30 a 214.000 COP, Elf 20w50 a 210.000 COP, Mobil 5w30 a 413.500 COP, Mazda 0w20 a 323.000 COP).
3. COTIZACIÓN DE LLANTAS:
   - Si te dan la medida (ej: 185/65 R15, 205/55 R16, etc.), dales de inmediato 2 opciones (la más económica y una intermedia o premium con marca y precio exacto del catálogo).
   - Recuerda SIEMPRE mencionar que el montaje y las válvulas nuevas son GRATIS por la compra de la llanta.
4. BATERÍAS Y FRENOS:
   - Baterías oficiales Willard con diagnóstico computarizado del alternador gratis. Menciona el Plan Chatarra (descuento de 20.000 COP por entregar la batería vieja).
   - Pastillas de freno marca Brake Pad.
5. SERVICIOS INDIVIDUALES:
   - Alineación 3D y balanceo de las 4 ruedas: 120.000 COP (45 min).
   - Escaneo computarizado OBD-II para testigos o Check Engine: 70.000 COP (15 min).
   - Desinfección de aire acondicionado con KER: 40.000 COP.
   - Plumillas limpiaparabrisas (16" a 24") con instalación gratis.
6. HORARIOS Y HORARIO VALLE:
   - Estamos en la Carrera 34C # 44-176 en Palmira.
   - Si preguntan por horarios o cuándo ir sin fila, recomiéndales el horario valle de 12:00 m a 2:00 pm, o los horarios habituales de lunes a viernes de 7:00 am a 5:00 pm, sábados de 7:00 am a 4:30 pm y domingos de 7:30 am a 12:30 pm.
7. ESCALAMIENTO HUMANO:
   Si el cliente pide expresamente hablar con una persona ("asesor", "humano", "persona", "comunicarme con alguien") o requiere una reparación mecánica pesada:
   Respóndele muy amable diciendo que ya lo estás comunicando con un asesor técnico de la serviteca e incluye exactamente al final la etiqueta: [ESCALAR_HUMANO]
`;
};

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const conversations: Record<string, ChatMessage[]> = {};

export const getAiResponse = async (message: string, phone: string): Promise<string> => {
  const openai = getOpenAIClient();
  if (!openai) {
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
  const openai = getOpenAIClient();
  if (!openai) return null;

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
    return 'Atendemos de lunes a viernes de 7:00 am a 5:00 pm, sábados de 7:00 am a 4:30 pm y domingos de 7:30 am a 12:30 pm. Te recomendamos venir entre 12:00 m y 2:00 pm para atención sin espera 🚗';
  } else if (text.includes('donde') || text.includes('ubicacion') || text.includes('direccion') || text.includes('queda')) {
    return 'Estamos ubicados en la Carrera 34C # 44-176 en Palmira, con 4 bahías express e instalaciones cómodas 📍';
  } else if (text.includes('aceite') || text.includes('combo') || text.includes('lubricante')) {
    return 'Tenemos combos de cambio de aceite con todos los filtros incluidos desde 150.000 COP. ¿Qué carro tienes y de qué año es para cotizarte el exacto? 🛢️';
  } else if (text.includes('alineacion') || text.includes('balanceo')) {
    return 'La alineación 3D y balanceo computarizado de las 4 ruedas te cuesta 120.000 COP y toma unos 45 minutos 🚗';
  } else if (text.includes('escaner') || text.includes('check') || text.includes('falla') || text.includes('diagnostico')) {
    return 'El escaneo computarizado OBD-II para lectura y borrado de fallas te cuesta 70.000 COP y toma unos 15 minutos 🔌';
  } else if (text.includes('llanta')) {
    return 'Manejamos marcas como Pirelli, Roadx, Zextour, Austone y Wanda, con montaje y válvulas nuevas gratis. ¿Qué medida de llanta buscas? 🛞';
  } else if (text.includes('bateria')) {
    return 'Manejamos baterías Willard con prueba computarizada del alternador gratis y te descontamos 20.000 COP por tu batería vieja 🔋';
  }

  return '¡Hola! Bienvenido a Lubri Expert Palmira 🚗 ¿En qué servicio te podemos colaborar hoy?';
};
