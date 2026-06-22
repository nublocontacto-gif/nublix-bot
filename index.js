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

let qrActual = null;
let conectado = false;
const historiales = {};

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
    <p style="color:#888">WhatsApp → Dispositivos vinculados → Vincular dispositivo</p>
    <img src="https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${qrEncoded}" style="border-radius:12px;border:8px solid #fff" />
    <script>setTimeout(()=>location.reload(),20000)</script>
  </body></html>`);
});

server.listen(3000, () => {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Nublix Bot iniciado');
  console.log('  Abrí http://localhost:3000 si necesitás reconectar');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
});

// Keepalive — ping cada 10 minutos para no dormirse en Render
setInterval(() => {
  fetch('https://nublix-bot.onrender.com').catch(() => {});
}, 600000);

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

async function transcribirAudio(buffer) {
  if (!GROQ_API_KEY) {
    console.log('[transcribirAudio] Sin GROQ_API_KEY — no se puede transcribir');
    return null;
  }

  if (!buffer || buffer.length === 0) {
    console.error('[transcribirAudio] Buffer de audio vacío — el audio no llegó con datos');
    return null;
  }

  const tmpDir = os.tmpdir();
  const tmpPathOgg = path.join(tmpDir, `audio_${Date.now()}.ogg`);
  const tmpPathMp3 = path.join(tmpDir, `audio_${Date.now()}.mp3`);

  try {
    console.log(`[transcribirAudio] tmpDir=${tmpDir} bufferBytes=${buffer.length}`);

    try {
      fs.accessSync(tmpDir, fs.constants.W_OK);
    } catch (e) {
      console.error(`[transcribirAudio] Sin permiso de escritura en ${tmpDir}:`, e.message);
      return null;
    }

    fs.writeFileSync(tmpPathOgg, buffer);
    console.log(`[transcribirAudio] Archivo temporal escrito en ${tmpPathOgg} (${fs.statSync(tmpPathOgg).size} bytes)`);

    console.log('[transcribirAudio] Convirtiendo ogg/opus → mp3 con ffmpeg...');
    await convertirAMp3(tmpPathOgg, tmpPathMp3);
    console.log(`[transcribirAudio] Conversión OK: ${tmpPathMp3} (${fs.statSync(tmpPathMp3).size} bytes)`);

    const form = new FormData();
    form.append('file', fs.createReadStream(tmpPathMp3), {
      filename: 'audio.mp3',
      contentType: 'audio/mpeg',
    });
    form.append('model', 'whisper-large-v3');
    form.append('language', 'es');
    form.append('response_format', 'json');

    console.log('[transcribirAudio] Enviando audio a Groq (axios)...');
    const response = await axios.post(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      form,
      {
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          ...form.getHeaders(),
        },
      }
    );

    console.log(`[transcribirAudio] Groq respondió status=${response.status}`);
    const texto = response.data.text;

    if (!texto) {
      console.error('[transcribirAudio] Respuesta sin campo "text":', JSON.stringify(response.data));
      return null;
    }

    console.log(`[transcribirAudio] Transcripción OK: "${texto}"`);
    return texto;
  } catch (e) {
    if (e.response) {
      console.error(`[transcribirAudio] Groq devolvió error status=${e.response.status}:`, JSON.stringify(e.response.data));
    } else {
      console.error('[transcribirAudio] Error:', e.message);
      console.error(e.stack);
    }
    return null;
  } finally {
    fs.unlink(tmpPathOgg, () => {});
    fs.unlink(tmpPathMp3, () => {});
  }
}

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
    const reply = data.reply || '🐾 Hola! Soy Nublix. ¿En qué te puedo ayudar?';
    historiales[from].push({ role: 'assistant', content: reply });
    return reply;
  } catch (e) {
    console.error('Error:', e.message);
    return 'Hola! Soy Nublix 🐾 Estoy teniendo problemas de conexión. Intentá de nuevo en un momento.';
  }
}

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
      console.log(`[${new Date().toLocaleTimeString()}] ${from}: [AUDIO] transcribiendo...`);
      await sock.sendPresenceUpdate('composing', from);
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
        const transcripcion = await transcribirAudio(buffer);
        if (transcripcion) {
          texto = transcripcion;
          console.log(`[Transcripción] ${texto}`);
        } else {
          await sock.sendMessage(from, { text: 'No pude escuchar bien el audio 🐾 ¿Me lo podés escribir?' });
          return;
        }
      } catch (e) {
        console.error('Error descargando audio:', e.message);
        await sock.sendMessage(from, { text: 'Tuve un problema con el audio 🐾 ¿Me lo podés escribir?' });
        return;
      }
    }

    if (!texto.trim()) return;

    console.log(`[${new Date().toLocaleTimeString()}] ${from}: ${texto}`);
    await sock.sendPresenceUpdate('composing', from);
    const respuesta = await preguntarClaude(from, texto);
    await sock.sendMessage(from, { text: respuesta });
    console.log(`[Nublix → ${from.split('@')[0]}]: ${respuesta.substring(0, 80)}`);
  });

  return sock;
}

conectar();
