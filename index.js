const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const http = require('http');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

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

async function transcribirAudio(buffer) {
  if (!GROQ_API_KEY) {
    console.log('Sin GROQ_API_KEY — no se puede transcribir');
    return null;
  }
  try {
    const tmpPath = path.join('/tmp', `audio_${Date.now()}.ogg`);
    fs.writeFileSync(tmpPath, buffer);

    const form = new FormData();
    form.append('file', fs.createReadStream(tmpPath), {
      filename: 'audio.ogg',
      contentType: 'audio/ogg',
    });
    form.append('model', 'whisper-large-v3');
    form.append('language', 'es');
    form.append('response_format', 'json');

    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        ...form.getHeaders(),
      },
      body: form,
    });

    fs.unlinkSync(tmpPath);
    const data = await res.json();
    return data.text || null;
  } catch (e) {
    console.error('Error transcribiendo audio:', e.message);
    return null;
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
