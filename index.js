const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const FormData = require('form-data');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegPath);

const NUBLIX_PROXY = 'https://us-central1-turnify-e068f.cloudfunctions.net/nublixChat';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MI_NUMERO = '5491178247713';
// Los últimos 8 dígitos del número para detección robusta
const MI_NUMERO_SUFIJO = '78247713';

let qrActual = null;
let conectado = false;
const historiales = {};

// ── Depósito Ford — contexto para Jarvis ──
const DEPOSITO_CONTEXT = `DEPÓSITO DE REPUESTOS — FORD:
Pasillo 1 · Lado Derecho:
  Estante 1: Masa rueda, Punta eje, Rulemanes rueda, Depósito agua, Depósito refrigerante
  Estante 2: Rulemanes, Bocha columna dirección, Cazoletas traseras, Cazoletas delanteras
  Estante 3: Manchones, Buje barra estabilizadora, Elástico, Soporte motor F100, Soporte cardán, Faros traseros EcoSport, Faros traseros Fiesta
  Estante 4: Bujes, Soporte caja, Soporte motor, Pata de caja
  Estante 5: Goma caño escape, Soporte motor redondo, Soporte motor cuadrado, Rótulas, Extremos, Depósitos de agua, Cilindros
  Estante 6: Extremos, Brazo Pitman, Brazo auxiliar, Rótulas F100, Rótulas Transit, Cilindros de frenos
  Estante 7: Flexibles de freno, Bomba de freno, Bulones de rueda, Radiadores de agua, Tricetas
Pasillo 1 · Lado Izquierdo:
  Estante 7: Precap, Homosinética
Fondo (conexión Pasillo 1 y 2):
  Engranajes, Cadena distribución, Poleas, Bomba de frenos, Balancines, Botadores, Crucetas, Tubos Falcón, Moldura pasa rueda EcoSport`;

// ── Servidor HTTP para QR ──
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (conectado) {
    res.end('<html><body style="background:#000;color:#0f0;font-family:monospace;text-align:center;padding:50px"><h1>✅ Nublix conectado!</h1></body></html>');
    return;
  }
  if (!qrActual) {
    res.end('<html><body style="background:#000;color:#fff;font-family:monospace;text-align:center;padding:50px"><h2>⏳ Generando QR...</h2><script>setTimeout(()=>location.reload(),2000)</script></body></html>');
    return;
  }
  const qrEncoded = encodeURIComponent(qrActual);
  res.end(`<html><head><title>Nublix QR</title></head>
  <body style="background:#111;color:#fff;font-family:sans-serif;text-align:center;padding:40px">
    <h2>Escaneá con WhatsApp</h2>
    <img src="https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${qrEncoded}" style="border-radius:12px;border:8px solid #fff" />
    <script>setTimeout(()=>location.reload(),20000)</script>
  </body></html>`);
});

server.listen(3000, () => {
  console.log('Nublix Bot iniciado — http://localhost:3000');
});

// Keepalive para Render
setInterval(() => {
  fetch('https://nublix-bot.onrender.com').catch(() => {});
}, 600000);

// ── Convertir audio a mp3 ──
function convertirAMp3(origenPath, destinoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(origenPath)
      .audioCodec('libmp3lame')
      .format('mp3')
      .on('end', resolve)
      .on('error', reject)
      .save(destinoPath);
  });
}

// ── Transcribir audio con Whisper ──
async function transcribirAudio(buffer) {
  if (!GROQ_API_KEY || !buffer || buffer.length === 0) return null;

  const tmpDir = os.tmpdir();
  const tmpOgg = path.join(tmpDir, `audio_${Date.now()}.ogg`);
  const tmpMp3 = path.join(tmpDir, `audio_${Date.now()}.mp3`);

  try {
    fs.writeFileSync(tmpOgg, buffer);
    await convertirAMp3(tmpOgg, tmpMp3);

    const form = new FormData();
    form.append('file', fs.createReadStream(tmpMp3), { filename: 'audio.mp3', contentType: 'audio/mpeg' });
    form.append('model', 'whisper-large-v3');
    form.append('language', 'es');
    form.append('response_format', 'json');

    const response = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', form, {
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, ...form.getHeaders() },
    });

    return response.data.text || null;
  } catch(e) {
    console.error('[transcribirAudio]', e.message);
    return null;
  } finally {
    fs.unlink(tmpOgg, () => {});
    fs.unlink(tmpMp3, () => {});
  }
}

// ── Preguntar a Groq directamente (para modo Jarvis personal) ──
async function preguntarJarvis(from, texto) {
  if (!historiales[from]) historiales[from] = [];
  historiales[from].push({ role: 'user', content: texto });
  if (historiales[from].length > 20) historiales[from] = historiales[from].slice(-20);

  const system = `Sos Jarvis, el asistente personal de Tomi — el fundador de Nublo y dueño de una casa de repuestos automotrices.

PERSONALIDAD: Hablás exactamente como Jarvis de Iron Man. Formal pero con calidez. Preciso, eficiente, ligeramente irónico. Nunca usás "dale", "che" ni vocabulario rioplatense. En cambio usás frases como "Por supuesto, señor", "Entendido", "Permítame verificar", "Como usted prefiera", "Está hecho", "Debo señalar que...", "Con todo el respeto que le merece...". Máximo 2-3 oraciones. Sin emojis.

FECHA Y HORA: ${new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}

DEPÓSITO DE REPUESTOS (usá esto para responder dónde está cada pieza):
${DEPOSITO_CONTEXT}

Cuando te pregunten por una pieza, respondé con la ubicación exacta: Pasillo X · Lado Y · Estante Z.
Si no está en el depósito, decí que no figura en el inventario actual.

También podés ayudar con recordatorios, consultas rápidas y cualquier tema personal o del negocio.`;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 300,
        temperature: 0.6,
        messages: [{ role: 'system', content: system }, ...historiales[from]],
      }),
    });
    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content || 'A sus órdenes, señor.';
    historiales[from].push({ role: 'assistant', content: reply });
    return reply;
  } catch(e) {
    console.error('[preguntarJarvis]', e.message);
    return 'Parece que tengo un problema de conexión, señor. Intente nuevamente.';
  }
}

// ── Preguntar a nublixChat (para usuarios normales) ──
async function preguntarClaude(from, texto) {
  if (!historiales[from]) historiales[from] = [];
  historiales[from].push({ role: 'user', content: texto });
  if (historiales[from].length > 10) historiales[from] = historiales[from].slice(-10);

  try {
    const res = await fetch(NUBLIX_PROXY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: historiales[from],
        context: {
          nombre: 'Cliente',
          negocio: 'Nublo OS',
          canal: 'whatsapp',
          modulo: 'Nublo OS',
          plan: 'consulta',
        }
      })
    });
    const data = await res.json();
    const reply = data.reply || 'Hola! Soy Nublix 🐾 ¿En qué te puedo ayudar?';
    historiales[from].push({ role: 'assistant', content: reply });
    return reply;
  } catch(e) {
    console.error('[preguntarClaude]', e.message);
    return 'Hola! Soy Nublix 🐾 Estoy teniendo problemas de conexión. Intentá de nuevo en un momento.';
  }
}

// ── Conexión Baileys ──
async function conectar() {
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const sock = makeWASocket({ auth: state });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) { qrActual = qr; console.log('QR listo → abrí http://localhost:3000'); }
    if (connection === 'open') { conectado = true; qrActual = null; console.log('✅ Nublix conectado!'); }
    if (connection === 'close') {
      conectado = false;
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) { console.log('Reconectando...'); conectar(); }
      else console.log('Sesión cerrada. Borrá la carpeta auth y volvé a correr.');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;
    const from = msg.key.remoteJid;
    if (from.endsWith('@g.us')) return;

    let texto = msg.message.conversation
      || msg.message.extendedTextMessage?.text
      || '';

    // Manejar audios
    const esAudio = msg.message.audioMessage || msg.message.pttMessage;
    if (esAudio) {
      await sock.sendPresenceUpdate('composing', from);
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
        const transcripcion = await transcribirAudio(buffer);
        if (transcripcion) {
          texto = transcripcion;
          console.log(`[Transcripción] ${texto}`);
        } else {
          const esTomi = from.replace(/\D/g, '').includes(MI_NUMERO_SUFIJO);
          await sock.sendMessage(from, { text: esTomi
            ? 'No pude procesar el audio, señor. ¿Podría escribirlo?'
            : 'No pude escuchar bien el audio 🐾 ¿Me lo podés escribir?' });
          return;
        }
      } catch(e) {
        console.error('[Audio]', e.message);
        return;
      }
    }

    if (!texto.trim()) return;

    console.log(`[${new Date().toLocaleTimeString()}] ${from}: ${texto}`);
    await sock.sendPresenceUpdate('composing', from);

    // Detectar si es Tomi por el número
    const esTomi = from.replace(/\D/g, '').includes(MI_NUMERO_SUFIJO);

    const respuesta = esTomi
      ? await preguntarJarvis(from, texto)
      : await preguntarClaude(from, texto);

    await sock.sendMessage(from, { text: respuesta });
    console.log(`[Nublix → ${from.split('@')[0]}]: ${respuesta.substring(0, 80)}`);
  });

  return sock;
}

conectar();
