const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getDatabase } = require('firebase-admin/database');
const { getMessaging } = require('firebase-admin/messaging');
const { getStorage } = require('firebase-admin/storage');
const { onValueCreated, onValueUpdated, onValueWritten } = require('firebase-functions/v2/database');
const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const sgMail = require('@sendgrid/mail');
const webpush = require('web-push');

initializeApp();

const META_VERIFY_TOKEN    = defineSecret('META_VERIFY_TOKEN');
const META_ACCESS_TOKEN    = defineSecret('META_ACCESS_TOKEN');
const META_PHONE_NUMBER_ID = defineSecret('META_PHONE_NUMBER_ID');
const GROQ_API_KEY         = defineSecret('GROQ_API_KEY');
const VAPID_PUBLIC_KEY     = defineSecret('VAPID_PUBLIC_KEY');
const VAPID_PRIVATE_KEY    = defineSecret('VAPID_PRIVATE_KEY');
const SENDGRID_API_KEY     = defineSecret('SENDGRID_API_KEY');

// ─────────────────────────────────────────
// HELPER: enviar email via SendGrid
// ─────────────────────────────────────────
async function enviarEmail(to, subject, html, apiKey) {
  sgMail.setApiKey(apiKey);
  await sgMail.send({ to, from: 'hola@nublo.com.ar', subject, html });
}

// ─────────────────────────────────────────
// HELPER: enviar WhatsApp
// ─────────────────────────────────────────
async function enviarWhatsApp(to, body, accessToken, phoneNumberId) {
  const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
  });
  if (!res.ok) console.error('Error WPP:', await res.text());
}

// ─────────────────────────────────────────
// HELPER: normalizar número de WhatsApp (solo dígitos)
// ─────────────────────────────────────────
function normalizarTel(num) {
  return (num || '').replace(/\D/g, '');
}

// ─────────────────────────────────────────
// HELPER: número apto para la API de WhatsApp (con código de país AR)
// Los clientes suelen escribir el número local (sin 54). Antepone 54 si falta.
// ─────────────────────────────────────────
function telParaWhatsApp(num) {
  let n = normalizarTel(num);
  if (!n) return '';
  if (n.startsWith('54')) {
    // 54 9 ... → ya es formato móvil correcto de WhatsApp AR
    if (n[2] === '9') return n;
    // 54 + área + número (sin el 9 de móvil) → insertarlo
    return '549' + n.slice(2);
  }
  // Número local sin código de país → asumir móvil argentino
  return '549' + n;
}

// ─────────────────────────────────────────
// HELPER: detectar si el mensaje es de ventas
// ─────────────────────────────────────────
function esModoVendedor(texto) {
  const t = texto.toLowerCase();
  return ['contratar','precio','nublo os','módulo','modulo','trimly','pitstop','auréa','aurea','purí','puri',
    'cuánto sale','cuanto sale','cómo funciona','como funciona','quiero el','quiero probar','me registré','me registre',
    'gratis'].some(w => t.includes(w));
}

// ─────────────────────────────────────────
// HELPER: preguntar a Groq — MODO ASISTENTE PERSONAL
// ─────────────────────────────────────────
async function preguntarAsistente(texto, historial, apiKey, userData) {
  const ahora = new Date().toISOString();
  const pausadoInfo = userData?.pausado_hasta ? `\nModo no molestar hasta: ${userData.pausado_hasta}` : '';

  const system = `Sos Nublix, el asistente personal de WhatsApp de Nublo. Personalidad: seco, directo, rioplatense informal. Humor seco ocasional. Máximo 2 oraciones. Sin emojis salvo 🐾 al final a veces. Nunca "¡Claro!" ni "¡Por supuesto!".

Hablás como un argentino real, nunca en español neutro ni latinoamericano genérico. Usá vocabulario rioplatense cuando entre natural: "dale", "avisame", "te mando", "¿querés que lo agendo?", "re bien", "posta", "ya quedó". Conjugá siempre con "vos" (nunca "tú").

Fecha y hora: ${ahora}${pausadoInfo}

Podés hacer:
- Recordatorios puntuales, recurrentes (diario/semanal/anual) y vencimientos
- Registrar gastos/deudas con categoría
- Modo no molestar/viaje/productividad
- Metas y hábitos con racha
- Lista de compras por categoría
- Objetivo de ahorro con seguimiento
- Registro de salud: pastillas, turnos, síntomas
- Cumpleaños con aviso día anterior
- Registro de vehículo: VTV, patente, seguro
- Cobros entre personas
- Alertas de precio
- Preparación de reuniones

Respondé ÚNICAMENTE con JSON puro, sin texto antes ni después:
{"reply":"...","reminder":null,"gasto":null,"pausar_hasta":null,"lista_item":null,"meta":null,"ahorro_objetivo":null,"sintoma":null,"cobro":null,"alerta_precio":null,"reunion":null,"suscripcion":null}

reminder: {"texto":"...","fecha_iso":"2026-06-25T10:00:00.000Z","recurrente":"diario|semanal|anual|null"}
gasto: {"monto":5000,"descripcion":"nafta","tag":"deuda|comida|transporte|salud|hogar|ahorro|null"}
lista_item: {"nombre":"leche","categoria":"lácteos|verduras|frutas|carnes|limpieza|bebidas|otros"}
meta: {"texto":"...","check":"diario|semanal","accountability":false}
ahorro_objetivo: {"nombre":"vacaciones","monto_meta":50000}
sintoma: {"descripcion":"dolor de cabeza","dias":3}
cobro: {"persona":"Nico","monto":5000,"descripcion":"la cena"}
alerta_precio: {"item":"dólar","condicion":"baja de","valor":1000}
reunion: {"tema":"cliente X","fecha_iso":"2026-06-20T15:00:00.000Z"}`;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 400,
      temperature: 0.7,
      messages: [{ role: 'system', content: system }, ...historial, { role: 'user', content: texto }],
    }),
  });

  if (!res.ok) return { reply: 'Tuve un problema técnico. ¿Me lo repetís? 🐾', reminder: null };

  const data = await res.json();
  const text = (data.choices?.[0]?.message?.content || '').trim();

  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { reply: text || 'Anotado 🐾', reminder: null };
    const parsed = JSON.parse(match[0]);
    if (!parsed.reply) parsed.reply = 'Anotado 🐾';
    return parsed;
  } catch(e) {
    return { reply: text || 'Anotado 🐾', reminder: null };
  }
}

// ─────────────────────────────────────────
// HELPER: preguntar a Groq — MODO VENDEDOR
// ─────────────────────────────────────────
async function preguntarVendedor(texto, historial, apiKey, from) {
  const system = `Sos Nublix, el asistente de ventas de Nublo OS por WhatsApp. Tu trabajo es convertir al usuario en cliente.

PERSONALIDAD: Directo, cálido, rioplatense. Sin rodeos. Máximo 3 oraciones. Usás 🐾 a veces. Hablás como un argentino real, nunca en español neutro: "dale", "te mando", "avisame", "¿querés que...?", "re bien". Conjugá con "vos", nunca "tú".

Nublo OS es gratis para siempre. Sin tarjeta, sin límites, sin trampa.

MÓDULOS: Trimly (barberías/peluquerías), PitStop (talleres mecánicos), Auréa (salones de belleza), Purí (comercios/tiendas), o cualquier otro rubro.

FLUJO — recolectá estos datos EN ORDEN, de a uno por mensaje:
1. Tipo de negocio / rubro
2. Nombre y apellido
3. Email de contacto

Cuando tengas TODOS los datos, incluí al final este tag (sin mostrárselo al usuario):
[LEAD:{"nombre":"...","apellido":"...","rubro":"...","whatsapp":"${from}","email":"..."}]

Y decile que le van a activar la cuenta.

Respondé SOLO con texto natural. Sin JSON visible, sin llaves, sin corchetes en tu respuesta.`;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 300,
      temperature: 0.7,
      messages: [{ role: 'system', content: system }, ...historial, { role: 'user', content: texto }],
    }),
  });

  if (!res.ok) return { reply: 'Tuve un problema. ¿Me lo repetís? 🐾', lead: null };

  const data = await res.json();
  const text = (data.choices?.[0]?.message?.content || '').trim();

  // Extraer LEAD tag si existe
  const leadMatch = text.match(/\[LEAD:(\{[\s\S]*?\})\]/);
  const reply = text.replace(/\[LEAD:[\s\S]*?\]/g, '').trim();
  const lead = leadMatch ? leadMatch[1] : null;

  return { reply: reply || 'En seguida te ayudo 🐾', lead };
}

// ─────────────────────────────────────────
// HELPER: mensaje de recordatorio de turno, adaptado al estilo
// de comunicación elegido para ese cliente
// ─────────────────────────────────────────
function mensajeRecordatorioTurno(estilo, nombre, hora) {
  switch (estilo) {
    case 'formal':
      return `Estimado/a ${nombre}, le recordamos su turno hoy a las ${hora}hs.`;
    case 'callejero':
      return `Ey ${nombre}! Hoy tenés turno a las ${hora}hs, no te olvides 🤙`;
    case 'under':
      return `${nombre} 👋 hoy ${hora}hs te esperamos`;
    case 'empatico':
      return `Hola ${nombre}! Solo quería avisarte que hoy te esperamos a las ${hora}hs 🤗`;
    default: // clasico
      return `Hola ${nombre}, te recordamos que hoy tenés turno a las ${hora}hs.`;
  }
}

// ─────────────────────────────────────────
// HELPER: registrar una acción de Nublix en el historial del negocio
// (sidebar "Nublix trabajó" — máximo 20 entradas)
// ─────────────────────────────────────────
async function registrarHistorialNublix(db, uid, texto, vapidPublic, vapidPrivate) {
  try {
    const ref = db.ref(`usuarios/${uid}/historial_nublix`);
    await ref.push({ texto, ts: Date.now() });
    const snap = await ref.get();
    const entradas = Object.entries(snap.val() || {});
    if (entradas.length > 20) {
      entradas.sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
      const sobran = entradas.slice(0, entradas.length - 20);
      await Promise.all(sobran.map(([id]) => ref.child(id).remove()));
    }
    if (vapidPublic && vapidPrivate) await enviarPush(db, uid, vapidPublic, vapidPrivate, texto);
  } catch(e) { console.error('registrarHistorialNublix', e); }
}

// ─────────────────────────────────────────
// HELPER: mandar una notificación push al dueño cuando Nublix actúa
// ─────────────────────────────────────────
async function enviarPush(db, uid, vapidPublic, vapidPrivate, body) {
  try {
    if (!vapidPublic || !vapidPrivate) return;
    const subSnap = await db.ref(`usuarios/${uid}/push_subscription`).get();
    const sub = subSnap.val();
    if (!sub) return;
    webpush.setVapidDetails('mailto:contacto.nublo@gmail.com', vapidPublic, vapidPrivate);
    await webpush.sendNotification(sub, JSON.stringify({ title: 'Nublix trabajó 🐾', body }));
  } catch(e) {
    if (e.statusCode === 410 || e.statusCode === 404) {
      await db.ref(`usuarios/${uid}/push_subscription`).remove();
    } else {
      console.error('enviarPush', e.message);
    }
  }
}

// ─────────────────────────────────────────
// HELPER: mensaje de cobro — alias + monto + comprobante
// ─────────────────────────────────────────
function formatCobroMsg(nombreCliente, monto, alias) {
  const montoTxt = monto ? `$${Number(monto).toLocaleString('es-AR')} ` : '';
  return `Hola ${nombreCliente} 🐾 Para abonar tu turno transferí ${montoTxt}al alias ${alias}. Cuando pagues mandame el comprobante por acá y listo.`;
}

// ─────────────────────────────────────────
// HELPER: preguntar a Groq — MODO DUEÑO DE NEGOCIO
// ─────────────────────────────────────────
async function preguntarNegocio(texto, historial, apiKey, ownerData, contextNegocio) {
  const system = `Sos Nublix, el asistente de WhatsApp del dueño de "${contextNegocio.negocio}" (rubro ${contextNegocio.rubro}). Le hablás directamente al dueño, no al cliente final.

PERSONALIDAD: directo, rioplatense, sin vueltas. Máximo 2 oraciones. Hablás como un argentino real: "dale", "te mando", "avisame", "¿querés que lo agendo?", "re bien". Conjugá con "vos". Sin emojis salvo 🐾 a veces.

DATOS DE HOY: ${contextNegocio.turnos_hoy} turnos hoy, ${contextNegocio.clientes_total} clientes totales.

Podés:
- Mandarle un cobro a un cliente (alias + monto)
- Anotar vencimientos del negocio (alquiler, VTV, seguro, impuestos) que se repiten cada mes
- Comentar turnos y clientes con los datos reales de arriba

Respondé ÚNICAMENTE con JSON puro, sin texto antes ni después:
{"reply":"...","cobro_cliente":null,"vencimiento_negocio":null}

cobro_cliente: {"cliente":"Juan Pérez","monto":5000}
vencimiento_negocio: {"texto":"Alquiler","dia_mes":10}`;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 300,
      temperature: 0.6,
      messages: [{ role: 'system', content: system }, ...historial, { role: 'user', content: texto }],
    }),
  });

  if (!res.ok) return { reply: 'Tuve un problema técnico. ¿Me lo repetís? 🐾' };

  const data = await res.json();
  const text = (data.choices?.[0]?.message?.content || '').trim();
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { reply: text || 'Dale 🐾' };
    const parsed = JSON.parse(match[0]);
    if (!parsed.reply) parsed.reply = 'Dale 🐾';
    return parsed;
  } catch(e) {
    return { reply: text || 'Dale 🐾' };
  }
}

// ─────────────────────────────────────────
// HELPER: subir comprobante de pago a Storage
// ─────────────────────────────────────────
async function subirComprobante(mediaId, accessToken, uidNegocio) {
  const metaRes = await fetch(`https://graph.facebook.com/v18.0/${mediaId}`, {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });
  const metaData = await metaRes.json();
  if (!metaData.url) throw new Error('No se pudo obtener URL del comprobante');

  const fileRes = await fetch(metaData.url, { headers: { 'Authorization': `Bearer ${accessToken}` } });
  if (!fileRes.ok) throw new Error('No se pudo descargar el comprobante');
  const buffer = await fileRes.arrayBuffer();

  const mime = metaData.mime_type || 'image/jpeg';
  const ext  = mime.includes('pdf') ? 'pdf' : (mime.includes('png') ? 'png' : 'jpg');
  const ts   = Date.now();
  const path = `comprobantes/${uidNegocio}/${ts}.${ext}`;

  const bucket = getStorage().bucket();
  const file = bucket.file(path);
  await file.save(Buffer.from(buffer), { contentType: mime });
  const [url] = await file.getSignedUrl({ action: 'read', expires: '01-01-2500' });

  return { url, ts };
}

// ─────────────────────────────────────────
// HELPER: transcribir audio con Whisper
// ─────────────────────────────────────────
async function transcribirAudio(mediaId, accessToken, groqKey) {
  const metaRes = await fetch(`https://graph.facebook.com/v18.0/${mediaId}`, {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });
  const metaData = await metaRes.json();
  if (!metaData.url) throw new Error('No se pudo obtener URL del audio');

  const audioRes = await fetch(metaData.url, { headers: { 'Authorization': `Bearer ${accessToken}` } });
  if (!audioRes.ok) throw new Error('No se pudo descargar el audio');
  const audioBuffer = await audioRes.arrayBuffer();

  const FORMATOS = [
    { mime: 'audio/ogg', ext: 'audio.ogg' },
    { mime: 'audio/mpeg', ext: 'audio.mp3' },
    { mime: 'audio/mp4', ext: 'audio.mp4' },
    { mime: 'audio/webm', ext: 'audio.webm' },
  ];

  for (const fmt of FORMATOS) {
    try {
      const formData = new FormData();
      formData.append('file', new Blob([audioBuffer], { type: fmt.mime }), fmt.ext);
      formData.append('model', 'whisper-large-v3-turbo');
      formData.append('language', 'es');
      formData.append('response_format', 'json');
      const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${groqKey}` },
        body: formData
      });
      if (r.ok) {
        const d = await r.json();
        if (d.text) return d.text;
      }
    } catch(e) { console.warn(`Whisper falló con ${fmt.mime}:`, e.message); }
  }
  throw new Error('Whisper falló con todos los formatos');
}

// ─────────────────────────────────────────
// HELPER: generar oportunidades de Nublix Proactivo para un negocio
// ─────────────────────────────────────────
async function generarOportunidadesParaUid(db, uid) {
  const [cSnap, pSnap] = await Promise.all([
    db.ref(`clientes/${uid}`).get(),
    db.ref(`pagos/${uid}`).get(),
  ]);
  const clientesObj = cSnap.val() || {};
  const pagos  = Object.values(pSnap.val() || {});
  const ahora  = Date.now();
  const oportunidades = {};

  const gastoPorCliente = {};
  pagos.forEach(p => {
    const n = (p.nombre || p.cliente || '').trim();
    if (n) gastoPorCliente[n] = (gastoPorCliente[n] || 0) + (p.monto || 0);
  });
  const mejoresNombres = Object.entries(gastoPorCliente).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n);

  // 1 y 4: clientes inactivos 30+ días (mejores clientes con umbral de 60+ días)
  for (const [cid, cl] of Object.entries(clientesObj)) {
    const ultimaVisitaCl = cl.memoria?.ultima_visita;
    if (!ultimaVisitaCl) continue;
    const dias = Math.floor((ahora - ultimaVisitaCl) / (24 * 60 * 60 * 1000));
    const esMejor = mejoresNombres.includes(cl.nombre);
    if (esMejor && dias >= 60) {
      oportunidades[`mejor_inactivo_${cid}`] = {
        tipo: 'mejor_cliente_inactivo',
        texto: `${cl.nombre} es uno de tus mejores clientes y no viene hace ${dias} días. ¿Lo recuperamos?`,
        accionLabel: 'Sí, recuperalo', ts: ahora, severidad: 'rojo',
        datos: { cid, nombre: cl.nombre, wpp: cl.wpp || null },
      };
    } else if (!esMejor && dias >= 30) {
      oportunidades[`inactivo_${cid}`] = {
        tipo: 'cliente_inactivo',
        texto: `Hace ${dias} días que ${cl.nombre} no viene. ¿Querés que le escriba?`,
        accionLabel: 'Sí, escribile', ts: ahora, severidad: 'amarillo',
        datos: { cid, nombre: cl.nombre, wpp: cl.wpp || null },
      };
    }
  }

  // Nota: la venta cruzada (upsell) y los horarios vacíos pasaron a vivir en el
  // pipeline de Corbat (generarOportunidadesCorbat) — son tareas de venta, no de
  // cuidado de relación. Nublix se queda con recuperación de relación e insights.

  // 3: caída de ingresos vs. mes anterior
  const hoy = new Date();
  const inicioMesActual   = new Date(hoy.getFullYear(), hoy.getMonth(), 1).getTime();
  const inicioMesAnterior = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1).getTime();
  const pagosMesActual   = pagos.filter(p => (p.ts || 0) >= inicioMesActual);
  const pagosMesAnterior = pagos.filter(p => (p.ts || 0) >= inicioMesAnterior && (p.ts || 0) < inicioMesActual);
  const ingresosActual   = pagosMesActual.reduce((s, p) => s + (p.monto || 0), 0);
  const ingresosAnterior = pagosMesAnterior.reduce((s, p) => s + (p.monto || 0), 0);
  if (ingresosAnterior > 0 && ingresosActual < ingresosAnterior) {
    const bajaPct = Math.round((1 - ingresosActual / ingresosAnterior) * 100);
    if (bajaPct >= 10) {
      const diasNombres = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
      const porDia = [0,0,0,0,0,0,0];
      pagosMesActual.forEach(p => { porDia[new Date(p.ts).getDay()] += (p.monto || 0); });
      const diaFlojoIdx = porDia.indexOf(Math.min(...porDia));
      oportunidades[`caida_ingresos_${hoy.getFullYear()}_${hoy.getMonth()}`] = {
        tipo: 'caida_ingresos',
        texto: `Este mes bajaste ${bajaPct}% en ventas. Los ${diasNombres[diaFlojoIdx]} están flojos.`,
        accionLabel: 'Entendido', ts: ahora, severidad: bajaPct >= 30 ? 'rojo' : 'amarillo',
        datos: {},
      };
    }
  }

  const perfilSnap = await db.ref(`usuarios/${uid}/perfil_negocio`).get();
  const perfil = perfilSnap.val();
  if (perfil?.dia_mas_cancelaciones) {
    oportunidades[`insight_cancelaciones_${hoy.getFullYear()}_${hoy.getMonth()}`] = {
      tipo: 'insight_aprendizaje',
      texto: `Los ${perfil.dia_mas_cancelaciones} son tu día con más cancelaciones. ¿Reforzamos los recordatorios ese día?`,
      accionLabel: 'Dale', ts: ahora, severidad: 'verde', datos: {},
    };
  }

  return oportunidades;
}

// Tipos de oportunidad que tienen una acción concreta (mensaje de WhatsApp) y
// por lo tanto pueden ejecutarse solas en Modo Automático. Las informativas
// (caida_ingresos, insight_aprendizaje) se muestran siempre como tarjeta, no se auto-resuelven.
const TIPOS_OPORTUNIDAD_ACCIONABLES = ['cliente_inactivo', 'mejor_cliente_inactivo'];

// ─────────────────────────────────────────
// HELPER: leer el modo de piloto del negocio ('asistente' | 'automatico')
// con fallback al booleano legacy config/piloto_automatico
// ─────────────────────────────────────────
async function obtenerModoPiloto(db, uid) {
  const snap = await db.ref(`usuarios/${uid}/config`).get();
  const cfg = snap.val() || {};
  if (cfg.modo_piloto === 'automatico' || cfg.modo_piloto === 'asistente') return cfg.modo_piloto;
  return cfg.piloto_automatico === true ? 'automatico' : 'asistente';
}

// ─────────────────────────────────────────
// HELPER: respetar las preferencias de horario que el dueño anotó a mano
// en notas_nublix (ej. "no mandar mensajes antes de las 10am"). Solo aplica
// a envíos 100% automáticos — si el dueño aprieta "Enviar" a mano, se manda igual.
// ─────────────────────────────────────────
function puedeContactarAhora(cl) {
  const notas = (cl?.notas_nublix || '').toLowerCase();
  const match = notas.match(/no\s+\w+\s+(?:mensajes?\s+)?antes\s+de\s+las?\s+(\d{1,2})/);
  if (!match) return true;
  const horaMinima = parseInt(match[1], 10);
  const horaActual = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires', hour: 'numeric', hour12: false }), 10);
  return horaActual >= horaMinima;
}

// ─────────────────────────────────────────
// HELPER: ejecutar la acción de una oportunidad (manual o automática) y borrarla.
// respetarHorario=true (modo automático) deja pendiente si choca con notas_nublix.
// ─────────────────────────────────────────
async function ejecutarOportunidadInterna(db, uid, oportunidadId, op, secrets, respetarHorario = false) {
  const { metaToken, metaPhoneId, vapidPublic, vapidPrivate } = secrets;
  const ownerSnap = await db.ref(`usuarios/${uid}`).get();
  const owner = ownerSnap.val() || {};

  if ((op.tipo === 'cliente_inactivo' || op.tipo === 'mejor_cliente_inactivo') && op.datos?.wpp) {
    if (respetarHorario) {
      const clSnap = await db.ref(`clientes/${uid}/${op.datos.cid}`).get();
      if (!puedeContactarAhora(clSnap.val())) return false;
    }
    await enviarWhatsApp(normalizarTel(op.datos.wpp), `Hola ${op.datos.nombre}! Hace rato que no te vemos por ${owner.negocio || 'el negocio'}. Tenemos una promo especial para vos, ¿te interesa? 🐾`, metaToken, metaPhoneId);
    await registrarHistorialNublix(db, uid, `Le escribí a ${op.datos.nombre} (cliente inactivo)`, vapidPublic, vapidPrivate);
  }
  await db.ref(`usuarios/${uid}/oportunidades/${oportunidadId}`).remove();
  return true;
}

// ─────────────────────────────────────────
// HELPER: calcular la memoria CRM de un cliente a partir de turnos y pagos reales.
// Devuelve null si no hay actividad real registrada — nunca se inventan datos.
// ─────────────────────────────────────────
function calcularMemoriaCliente(nombreCliente, turnos, pagos, esPremium, serviciosOrdenadosNegocio) {
  const ahora = Date.now();
  const visitas = turnos
    .filter(t => t.nombre && t.nombre.trim() === nombreCliente && t.fecha && t.estado !== 'cancelado' && t.estado !== 'ausente')
    .map(t => ({ ts: new Date(t.fecha).getTime(), hora: t.hora, servicio: t.servicio }))
    .filter(v => v.ts <= ahora && !isNaN(v.ts))
    .sort((a, b) => a.ts - b.ts);
  const cancelaciones = turnos.filter(t => t.nombre && t.nombre.trim() === nombreCliente && t.estado === 'cancelado').length;
  const pagosCliente = pagos.filter(p => (p.nombre || p.cliente || '').trim() === nombreCliente);

  if (!visitas.length) return null;

  const ultima_visita = visitas[visitas.length - 1].ts;
  const historial_visitas = visitas.slice(-10).map(v => ({ fecha: v.ts, servicio: v.servicio || null }));

  let frecuencia_dias = null;
  if (visitas.length >= 2) {
    const gaps = [];
    for (let i = 1; i < visitas.length; i++) gaps.push((visitas[i].ts - visitas[i - 1].ts) / 86400000);
    frecuencia_dias = Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length);
  }

  const diasSinVenir = (ahora - ultima_visita) / 86400000;
  let prob_abandono = 0;
  if (frecuencia_dias && frecuencia_dias > 0) {
    prob_abandono = Math.max(0, Math.min(1, (diasSinVenir - frecuencia_dias) / frecuencia_dias));
  } else if (diasSinVenir > 45) {
    prob_abandono = 0.5;
  }

  const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const porDia = {};
  const porFranja = {};
  visitas.forEach(v => {
    const d = DIAS[new Date(v.ts).getDay()];
    porDia[d] = (porDia[d] || 0) + 1;
    if (v.hora) {
      const h = parseInt(v.hora.split(':')[0], 10);
      if (!isNaN(h)) {
        const franja = h < 12 ? 'mañana' : h < 18 ? 'tarde' : 'noche';
        porFranja[franja] = (porFranja[franja] || 0) + 1;
      }
    }
  });
  const diaTop = Object.entries(porDia).sort((a, b) => b[1] - a[1])[0]?.[0];
  const franjaTop = Object.entries(porFranja).sort((a, b) => b[1] - a[1])[0]?.[0];
  const preferencias = [diaTop ? `${diaTop}s` : null, franjaTop].filter(Boolean);

  const serviciosUsados = new Set(visitas.map(v => v.servicio).filter(Boolean));
  const servicios_potenciales = serviciosUsados.size === 1 && serviciosOrdenadosNegocio.length > 1
    ? [serviciosOrdenadosNegocio.find(s => !serviciosUsados.has(s))].filter(Boolean)
    : [];

  const gastoTotal = pagosCliente.reduce((s, p) => s + (p.monto || 0), 0);
  const mesesActivo = Math.max(1, (ahora - visitas[0].ts) / (30 * 86400000));
  const valor_economico_mensual = pagosCliente.length ? Math.round(gastoTotal / mesesActivo) : 0;

  const ptsRecencia = frecuencia_dias ? Math.max(0, 40 * (1 - prob_abandono)) : (diasSinVenir < 30 ? 30 : 10);
  const ptsAntiguedad = Math.min(30, visitas.length * 3);
  const totalEventos = visitas.length + cancelaciones;
  const tasaCancel = totalEventos ? cancelaciones / totalEventos : 0;
  const ptsConfiabilidad = (1 - tasaCancel) * 30;
  const nivel_confianza = Math.round(Math.max(0, Math.min(100, ptsRecencia + ptsAntiguedad + ptsConfiabilidad)));

  return {
    historial_visitas, frecuencia_dias, ultima_visita, preferencias,
    valor_economico_mensual, prob_abandono: Math.round(prob_abandono * 100) / 100,
    servicios_potenciales, nivel_confianza, es_premium: !!esPremium,
    actualizado: ahora,
  };
}

// ─────────────────────────────────────────
// HELPER: leer el modo de cercanía del negocio ('asistente' | 'automatico')
// ─────────────────────────────────────────
async function obtenerModoCercania(db, uid) {
  const snap = await db.ref(`usuarios/${uid}/config/modo_cercania`).get();
  const modo = snap.val();
  return modo === 'automatico' ? 'automatico' : 'asistente';
}

// ─────────────────────────────────────────
// HELPER: detectar a quién contactar hoy por motivos de relación (no de venta).
// Solo motivos que NO se solapan con otras automatizaciones existentes:
// - cumpleaños hoy (campo manual cl.cumpleanos)
// - cliente premium sin venir 14+ días (más urgente que el umbral de 60 días de oportunidades)
// - canceló su último turno y nunca reagendó
// El "cliente inactivo 28+ días" genérico ya lo cubre nublixReactivacionClientes — no se duplica acá.
// ─────────────────────────────────────────
function detectarContactarHoy(clientesObj, turnos) {
  const ahora = Date.now();
  const hoy = new Date();
  const items = [];

  const turnosPorCliente = {};
  turnos.forEach(t => {
    if (!t.nombre || !t.fecha) return;
    const n = t.nombre.trim();
    (turnosPorCliente[n] = turnosPorCliente[n] || []).push(t);
  });

  for (const [cid, cl] of Object.entries(clientesObj)) {
    if (!cl.nombre) continue;

    if (cl.cumpleanos) {
      const cump = new Date(cl.cumpleanos);
      if (!isNaN(cump.getTime()) && cump.getDate() === hoy.getDate() && cump.getMonth() === hoy.getMonth()) {
        items.push({
          cid, nombre: cl.nombre, wpp: cl.wpp || null, motivo: 'cumpleanos',
          mensaje_sugerido: `Feliz cumple ${cl.nombre}! 🎉 Que la pases increíble. Cualquier cosa que necesites, contá con nosotros 🐾`,
        });
        continue;
      }
    }

    const memoria = cl.memoria;
    if (memoria?.es_premium && memoria.ultima_visita) {
      const dias = Math.floor((ahora - memoria.ultima_visita) / 86400000);
      if (dias >= 14 && (!cl.contacto_cercania_ts || (ahora - cl.contacto_cercania_ts) > 7 * 86400000)) {
        items.push({
          cid, nombre: cl.nombre, wpp: cl.wpp || null, motivo: 'premium_inactivo',
          mensaje_sugerido: `Hola ${cl.nombre}! Te extrañamos por acá, hace ${dias} días que no te vemos. ¿Todo bien? Si querés te reservo un horario 🐾`,
        });
        continue;
      }
    }

    const propios = (turnosPorCliente[cl.nombre.trim()] || []).filter(t => t.fecha).sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
    const ultimo = propios[propios.length - 1];
    if (ultimo && ultimo.estado === 'cancelado' && new Date(ultimo.fecha).getTime() < ahora) {
      const diasDesdeCancel = Math.floor((ahora - new Date(ultimo.fecha).getTime()) / 86400000);
      if (diasDesdeCancel <= 3 && (!cl.contacto_cercania_ts || (ahora - cl.contacto_cercania_ts) > 7 * 86400000)) {
        items.push({
          cid, nombre: cl.nombre, wpp: cl.wpp || null, motivo: 'cancelo_sin_reagendar',
          mensaje_sugerido: `Hola ${cl.nombre}! Vi que se canceló tu turno y no quedó nada reagendado. ¿Te busco otro horario? 🐾`,
        });
      }
    }
  }

  return items;
}

// ─────────────────────────────────────────
// HELPER: aplicar oportunidades nuevas según el modo de piloto del negocio.
// Automático → ejecuta solo las accionables. Asistente → las deja pendientes
// y avisa por push que hay sugerencias nuevas para aprobar.
// ─────────────────────────────────────────
async function aplicarOportunidadesSegunModo(db, uid, nuevas, secrets) {
  const accionables = Object.entries(nuevas).filter(([, op]) => TIPOS_OPORTUNIDAD_ACCIONABLES.includes(op.tipo));
  if (!accionables.length) return;
  const modo = await obtenerModoPiloto(db, uid);
  if (modo === 'automatico') {
    for (const [id, op] of accionables) {
      try { await ejecutarOportunidadInterna(db, uid, id, op, secrets, true); }
      catch(e) { console.error('aplicarOportunidadesSegunModo', uid, id, e); }
    }
  } else {
    await enviarPush(db, uid, secrets.vapidPublic, secrets.vapidPrivate,
      `Tengo ${accionables.length} sugerencia${accionables.length===1?'':'s'} nueva${accionables.length===1?'':'s'} para vos 🐾`);
  }
}

// ═══════════════════════════════════════════════
// CORBAT — vendedor IA de élite. Solo detecta oportunidades de venta real:
// venta cruzada, servicios sin movimiento, horarios vacíos con cliente habitual
// y cumpleaños próximos. Nunca inventa probabilidades ni descuentos.
// ═══════════════════════════════════════════════
async function obtenerConfigCorbat(db, uid) {
  const snap = await db.ref(`usuarios/${uid}/config/corbat`).get();
  const cfg = snap.val() || {};
  return { modo: cfg.modo === 'automatico' ? 'automatico' : 'asistente', ...cfg };
}

async function generarOportunidadesCorbat(db, uid) {
  const [catSnap, cSnap, tSnap] = await Promise.all([
    db.ref(`usuarios/${uid}/catalogo`).get(),
    db.ref(`clientes/${uid}`).get(),
    db.ref(`turnos/${uid}`).get(),
  ]);
  const catalogo = Object.values(catSnap.val() || {}).filter(it => it.activo !== false);
  const clientesObj = cSnap.val() || {};
  const turnos = Object.values(tSnap.val() || {});
  const ahora = Date.now();
  const oportunidades = {};

  const turnosValidos = turnos.filter(t => t.nombre && t.servicio && t.fecha && t.estado !== 'cancelado');

  // 1: venta cruzada — cliente fiel a un solo servicio
  if (turnosValidos.length) {
    const serviciosPorCliente = {};
    const visitasPorCliente = {};
    const conteoServicios = {};
    turnosValidos.forEach(t => {
      const n = t.nombre.trim();
      (serviciosPorCliente[n] = serviciosPorCliente[n] || new Set()).add(t.servicio);
      visitasPorCliente[n] = (visitasPorCliente[n] || 0) + 1;
      conteoServicios[t.servicio] = (conteoServicios[t.servicio] || 0) + 1;
    });
    const serviciosOrdenados = Object.entries(conteoServicios).sort((a, b) => b[1] - a[1]).map(([s]) => s);
    if (serviciosOrdenados.length > 1) {
      for (const [cid, cl] of Object.entries(clientesObj)) {
        if (!cl.nombre) continue;
        const n = cl.nombre.trim();
        const usados = serviciosPorCliente[n];
        const visitas = visitasPorCliente[n] || 0;
        if (usados && usados.size === 1 && visitas >= 3) {
          const servicioActual = [...usados][0];
          const sugerido = serviciosOrdenados.find(s => s !== servicioActual);
          if (sugerido) {
            oportunidades[`upsell_${cid}`] = {
              tipo: 'upsell_servicio', cliente_cid: cid, cliente_nombre: cl.nombre,
              oportunidad: `${cl.nombre} viene seguido (${visitas} veces) y siempre pide "${servicioActual}". Nunca probó "${sugerido}".`,
              mensaje_propuesto: `Hola ${cl.nombre}! La próxima vez que vengas probá ${sugerido}, combina bien con lo de siempre 🐾`,
              probabilidad: visitas >= 5 ? 'alta' : 'media', estado: 'pendiente', resultado: null, timestamp: ahora,
              datos: { cid, wpp: cl.wpp || null },
            };
          }
        }
      }
    }

    // 2: servicio del catálogo sin movimiento en 30+ días, pero que ya tuvo clientes antes
    if (catalogo.length) {
      const treinta = ahora - 30 * 24 * 60 * 60 * 1000;
      const serviciosRecientes = new Set(turnosValidos.filter(t => new Date(t.fecha).getTime() >= treinta).map(t => t.servicio));
      const serviciosDelCatalogo = catalogo.filter(it => it.tipo !== 'producto').map(it => it.nombre).filter(Boolean);
      for (const servicio of serviciosDelCatalogo) {
        if (serviciosRecientes.has(servicio)) continue;
        const clienteQueLoUso = Object.values(clientesObj).find(cl =>
          cl.wpp && turnosValidos.some(t => t.nombre.trim() === (cl.nombre || '').trim() && t.servicio === servicio)
        );
        if (!clienteQueLoUso) continue;
        oportunidades[`sin_movimiento_${servicio.replace(/\s+/g, '_')}`] = {
          tipo: 'servicio_sin_movimiento', cliente_cid: null, cliente_nombre: clienteQueLoUso.nombre,
          oportunidad: `"${servicio}" no tuvo movimiento en 30 días. ${clienteQueLoUso.nombre} ya lo pidió antes.`,
          mensaje_propuesto: `Hola ${clienteQueLoUso.nombre}! Hace rato que no pedís ${servicio}. ¿Querés que te reserve? 🐾`,
          probabilidad: 'media', estado: 'pendiente', resultado: null, timestamp: ahora,
          datos: { wpp: clienteQueLoUso.wpp || null, servicio },
        };
      }
    }
  }

  // 3: horario vacío + cliente habitual (3+ visitas reales según su memoria)
  const manana = new Date(); manana.setDate(manana.getDate() + 1); manana.setHours(0, 0, 0, 0);
  const turnosManana = turnos.filter(t => t.fecha && new Date(t.fecha).toDateString() === manana.toDateString() && t.estado !== 'cancelado');
  const CAPACIDAD_DIA_REF = 8;
  const libres = Math.max(0, CAPACIDAD_DIA_REF - turnosManana.length);
  if (libres >= 3) {
    const habituales = Object.entries(clientesObj)
      .filter(([, cl]) => cl.wpp && (cl.memoria?.historial_visitas?.length || 0) >= 3)
      .slice(0, 3);
    for (const [cid, cl] of habituales) {
      oportunidades[`horario_vacio_${cid}_${manana.toDateString()}`] = {
        tipo: 'horario_vacio_habitual', cliente_cid: cid, cliente_nombre: cl.nombre,
        oportunidad: `Mañana tenés ${libres} horarios libres. ${cl.nombre} es cliente habitual.`,
        mensaje_propuesto: `Hola ${cl.nombre}! Tenemos lugar libre mañana, ¿te interesa pasar? 🐾`,
        probabilidad: 'media', estado: 'pendiente', resultado: null, timestamp: ahora,
        datos: { cid, wpp: cl.wpp || null },
      };
    }
  }

  // 4: cumpleaños próximo (3-7 días — distinto del saludo del día de Nublix)
  const hoy = new Date();
  for (const [cid, cl] of Object.entries(clientesObj)) {
    if (!cl.cumpleanos || !cl.wpp) continue;
    const cump = new Date(cl.cumpleanos);
    if (isNaN(cump.getTime())) continue;
    const cumpEsteAno = new Date(hoy.getFullYear(), cump.getMonth(), cump.getDate());
    const diasFaltan = Math.round((cumpEsteAno.getTime() - new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate()).getTime()) / 86400000);
    if (diasFaltan >= 3 && diasFaltan <= 7) {
      oportunidades[`cumple_proximo_${cid}`] = {
        tipo: 'cumpleanos_proximo', cliente_cid: cid, cliente_nombre: cl.nombre,
        oportunidad: `${cl.nombre} cumple años en ${diasFaltan} días.`,
        mensaje_propuesto: `Hola ${cl.nombre}! Tu cumple se acerca 🎉 Quiero ofrecerte algo especial para ese día, ¿te reservo un turno?`,
        probabilidad: 'alta', estado: 'pendiente', resultado: null, timestamp: ahora,
        datos: { cid, wpp: cl.wpp || null },
      };
    }
  }

  return oportunidades;
}

async function ejecutarCorbatOportunidad(db, uid, id, op, secrets, mensaje) {
  const texto = mensaje || op.mensaje_propuesto;
  if (op.datos?.wpp) {
    await enviarWhatsApp(normalizarTel(op.datos.wpp), texto, secrets.metaToken, secrets.metaPhoneId);
    await registrarHistorialNublix(db, uid, `🦊 Corbat le escribió a ${op.cliente_nombre}`, secrets.vapidPublic, secrets.vapidPrivate);
  }
  await db.ref(`usuarios/${uid}/corbat_oportunidades/${id}`).update({ estado: 'aprobado', resultado: 'enviado', resuelto_ts: Date.now() });
}

// ═══════════════════════════════════════════════
// corbatAnalisis — cada 6hs, detecta oportunidades de venta por negocio
// ═══════════════════════════════════════════════
exports.corbatAnalisis = onSchedule(
  { schedule: 'every 6 hours', timeZone: 'America/Argentina/Buenos_Aires', secrets: [META_ACCESS_TOKEN, META_PHONE_NUMBER_ID, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY] },
  async () => {
    const db = getDatabase();
    const secrets = {
      metaToken: META_ACCESS_TOKEN.value(), metaPhoneId: META_PHONE_NUMBER_ID.value(),
      vapidPublic: VAPID_PUBLIC_KEY.value(), vapidPrivate: VAPID_PRIVATE_KEY.value(),
    };
    const usuariosSnap = await db.ref('usuarios').get();
    for (const [uid, u] of Object.entries(usuariosSnap.val() || {})) {
      if (!u.onboarding_completo) continue;
      try {
        const nuevas = await generarOportunidadesCorbat(db, uid);
        const ids = Object.keys(nuevas);
        if (!ids.length) continue;
        await db.ref(`usuarios/${uid}/corbat_oportunidades`).update(nuevas);

        const cfg = await obtenerConfigCorbat(db, uid);
        if (cfg.modo === 'automatico') {
          for (const id of ids) {
            const op = nuevas[id];
            try {
              if (op.datos?.cid) {
                const clSnap = await db.ref(`clientes/${uid}/${op.datos.cid}`).get();
                if (!puedeContactarAhora(clSnap.val())) continue;
              }
              await ejecutarCorbatOportunidad(db, uid, id, op, secrets);
            } catch(e) { console.error('corbatAnalisis exec', uid, id, e); }
          }
        } else {
          await enviarPush(db, uid, secrets.vapidPublic, secrets.vapidPrivate,
            `🦊 Corbat encontró ${ids.length} oportunidad${ids.length === 1 ? '' : 'es'} de venta para vos`);
        }
      } catch(e) { console.error('corbatAnalisis', uid, e); }
    }
  }
);

// ═══════════════════════════════════════════════
// corbatAccion — la PWA aprueba, edita o descarta una oportunidad de Corbat
// ═══════════════════════════════════════════════
exports.corbatAccion = onRequest(
  { secrets: [META_ACCESS_TOKEN, META_PHONE_NUMBER_ID, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY], cors: true },
  async (req, res) => {
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    if (req.method !== 'POST')   return res.sendStatus(405);
    try {
      const { uid, oportunidadId, accion, mensajeEditado } = req.body;
      if (!uid || !oportunidadId || !accion) return res.status(400).json({ ok: false, error: 'Faltan datos' });
      const db = getDatabase();
      const opRef = db.ref(`usuarios/${uid}/corbat_oportunidades/${oportunidadId}`);
      const op = (await opRef.get()).val();
      if (!op) return res.status(404).json({ ok: false, error: 'No encontrada' });

      if (accion === 'descartar') {
        await opRef.update({ estado: 'descartado', resultado: 'descartado', resuelto_ts: Date.now() });
        return res.json({ ok: true });
      }

      await ejecutarCorbatOportunidad(db, uid, oportunidadId, op, {
        metaToken: META_ACCESS_TOKEN.value(), metaPhoneId: META_PHONE_NUMBER_ID.value(),
        vapidPublic: VAPID_PUBLIC_KEY.value(), vapidPrivate: VAPID_PRIVATE_KEY.value(),
      }, accion === 'editar' ? mensajeEditado : null);
      return res.json({ ok: true });
    } catch(e) {
      console.error('corbatAccion', e);
      return res.status(500).json({ ok: false, error: 'Error interno' });
    }
  }
);

// ─────────────────────────────────────────
// HELPER: calcular el perfil de aprendizaje semanal de un negocio
// ─────────────────────────────────────────
async function calcularPerfilNegocio(db, uid) {
  const [tSnap, pSnap] = await Promise.all([
    db.ref(`turnos/${uid}`).get(),
    db.ref(`pagos/${uid}`).get(),
  ]);
  const turnos = Object.values(tSnap.val() || {}).filter(t => t.fecha);
  const pagos  = Object.values(pSnap.val() || {});
  if (!turnos.length && !pagos.length) return null;

  const DIAS = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
  const porDia = Array(7).fill(0);
  const porDiaCancel = Array(7).fill(0);
  const porHora = {};
  const porServicio = {};
  turnos.forEach(t => {
    const d = new Date(t.fecha).getDay();
    porDia[d]++;
    if (t.estado === 'cancelado') porDiaCancel[d]++;
    if (t.hora) porHora[t.hora] = (porHora[t.hora] || 0) + 1;
    if (t.servicio) porServicio[t.servicio] = (porServicio[t.servicio] || 0) + 1;
  });

  const diasMasOcupados = porDia.map((c, i) => [DIAS[i], c]).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([d]) => d);
  const horariosPico = Object.entries(porHora).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([h]) => h);
  const serviciosMasPedidos = Object.entries(porServicio).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s]) => s);
  const maxCancel = Math.max(...porDiaCancel);
  const diaMasCancelaciones = maxCancel > 0 ? DIAS[porDiaCancel.indexOf(maxCancel)] : null;

  const gastoPorCliente = {};
  pagos.forEach(p => {
    const n = (p.nombre || p.cliente || '').trim();
    if (n) gastoPorCliente[n] = (gastoPorCliente[n] || 0) + (p.monto || 0);
  });
  const clientesMasValiosos = Object.entries(gastoPorCliente).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n);
  const ticketPromedio = pagos.length ? Math.round(pagos.reduce((s, p) => s + (p.monto || 0), 0) / pagos.length) : 0;

  return {
    dias_mas_ocupados: diasMasOcupados,
    horarios_pico: horariosPico,
    servicios_mas_pedidos: serviciosMasPedidos,
    clientes_mas_valiosos: clientesMasValiosos,
    dia_mas_cancelaciones: diaMasCancelaciones,
    ticket_promedio: ticketPromedio,
    actualizado: Date.now(),
  };
}

// ═══════════════════════════════════════════════
// notificarTaller
// ═══════════════════════════════════════════════
exports.notificarTaller = onValueCreated(
  '/registros/{ordenId}/mensajes/{msgId}',
  async (event) => {
    const mensaje = event.data.val();
    if (!mensaje || mensaje.tipo !== 'sistema') return;
    const db = getDatabase();
    const ordenSnap = await db.ref(`registros/${event.params.ordenId}`).get();
    const orden = ordenSnap.val();
    if (!orden?.uid) return;
    const tokenSnap = await db.ref(`talleres/${orden.uid}/fcmToken`).get();
    const token = tokenSnap.val();
    if (!token) return;
    try {
      await getMessaging().send({
        token,
        notification: {
          title: mensaje.texto.includes('aceptó') ? '✅ Presupuesto aceptado' : '✕ Presupuesto rechazado',
          body: `${orden.cliente || 'Cliente'} (${orden.patente || ''}): ${mensaje.texto}`,
        },
        webpush: { fcmOptions: { link: 'https://turnify-e068f.web.app/PitStop/app.html' } },
      });
    } catch(err) { console.error('Error notificación:', err); }
  }
);

// ═══════════════════════════════════════════════
// indexarWhatsappDueno — mantiene whatsapp_index/{tel} → uid
// para encontrar rápido qué dueño de negocio escribe
// ═══════════════════════════════════════════════
exports.indexarWhatsappDueno = onValueWritten(
  '/usuarios/{uid}/whatsapp',
  async (event) => {
    const uid = event.params.uid;
    const db = getDatabase();
    const telAnterior = normalizarTel(event.data.before.val());
    const telNuevo    = normalizarTel(event.data.after.val());
    if (telAnterior && telAnterior !== telNuevo) {
      await db.ref(`whatsapp_index/${telAnterior}`).remove();
    }
    if (telNuevo) {
      await db.ref(`whatsapp_index/${telNuevo}`).set(uid);
    }
  }
);

// ═══════════════════════════════════════════════
// nublixEmailBienvenida — manda el email de bienvenida apenas el
// dueño termina el onboarding (false → true), sin esperar a que escriba primero
// ═══════════════════════════════════════════════
exports.nublixEmailBienvenida = onValueWritten(
  { ref: '/usuarios/{uid}/onboarding_completo', secrets: [SENDGRID_API_KEY] },
  async (event) => {
    const antes = event.data.before.val();
    const ahora = event.data.after.val();
    if (ahora !== true || antes === true) return;
    const db = getDatabase();
    const uid = event.params.uid;
    try {
      const userSnap = await db.ref(`usuarios/${uid}`).get();
      const u = userSnap.val() || {};
      if (!u.email) return;
      const nombre = (u.nombre || '').split(' ')[0] || 'che';
      const html = `Hola ${nombre},<br><br>` +
        `Tu cuenta de Nublo OS está lista.<br><br>` +
        `Accedé desde: <a href="https://nublo.com.ar/NubloOS/app/">https://nublo.com.ar/NubloOS/app/</a><br><br>` +
        `Nublix ya está listo para ayudarte a hacer crecer tu negocio.<br><br>` +
        `— El equipo de Nublo`;
      await enviarEmail(u.email, 'Bienvenido a Nublo 🐾', html, SENDGRID_API_KEY.value());
    } catch(e) { console.error('nublixEmailBienvenida', uid, e); }
  }
);

// ═══════════════════════════════════════════════
// cocoWebhook — webhook principal de WhatsApp
// ═══════════════════════════════════════════════
exports.cocoWebhook = onRequest(
  { secrets: [META_VERIFY_TOKEN, META_ACCESS_TOKEN, META_PHONE_NUMBER_ID, GROQ_API_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY] },
  async (req, res) => {

    // Verificación Meta
    if (req.method === 'GET') {
      const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
      if (mode === 'subscribe' && token === META_VERIFY_TOKEN.value()) return res.status(200).send(challenge);
      return res.sendStatus(403);
    }

    if (req.method !== 'POST') return res.sendStatus(405);

    try {
      const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!message) return res.sendStatus(200);

      const from = message.from;

      // ── CLIENTE MANDA COMPROBANTE DE PAGO (foto o PDF) ──
      if (message.type === 'image' || message.type === 'document') {
        const mediaId = message.image?.id || message.document?.id;
        if (!mediaId) return res.sendStatus(200);
        const db = getDatabase();
        const tel = normalizarTel(from);
        const cobroSnap = await db.ref(`cobro_en_curso/${tel}`).get();
        const cobro = cobroSnap.val();
        if (!cobro) {
          await enviarWhatsApp(from, 'Recibí tu archivo, pero no tengo un cobro pendiente para vos. Pedile al negocio que te mande el cobro de nuevo 🐾', META_ACCESS_TOKEN.value(), META_PHONE_NUMBER_ID.value());
          return res.sendStatus(200);
        }
        try {
          const { url, ts } = await subirComprobante(mediaId, META_ACCESS_TOKEN.value(), cobro.uid);
          await db.ref(`usuarios/${cobro.uid}/cobros_pendientes/${ts}`).set({
            monto: cobro.monto, concepto: cobro.concepto || '', cliente: cobro.clienteNombre,
            clienteWpp: from, comprobante_url: url, timestamp: ts, estado: 'pendiente',
          });
          await db.ref(`cobro_en_curso/${tel}`).remove();
          await enviarWhatsApp(from, 'Recibí tu comprobante 🐾 Ya se lo paso al negocio para que lo confirme.', META_ACCESS_TOKEN.value(), META_PHONE_NUMBER_ID.value());
        } catch(e) {
          console.error('subirComprobante', e);
          await enviarWhatsApp(from, 'No pude procesar el comprobante. ¿Lo mandás de nuevo? 🐾', META_ACCESS_TOKEN.value(), META_PHONE_NUMBER_ID.value());
        }
        return res.sendStatus(200);
      }

      let texto = '';

      if (message.type === 'text') {
        texto = message.text?.body || '';
      } else if (message.type === 'audio' || message.type === 'voice') {
        const mediaId = message.audio?.id || message.voice?.id;
        if (!mediaId) return res.sendStatus(200);
        try {
          const t = await transcribirAudio(mediaId, META_ACCESS_TOKEN.value(), GROQ_API_KEY.value());
          if (!t || t.trim().length < 2) {
            await enviarWhatsApp(from, '🐾 No pude escuchar el audio. ¿Me lo repetís por texto?', META_ACCESS_TOKEN.value(), META_PHONE_NUMBER_ID.value());
            return res.sendStatus(200);
          }
          texto = `[Audio]: ${t.trim()}`;
        } catch(e) {
          await enviarWhatsApp(from, '🐾 No pude procesar el audio. Escribime.', META_ACCESS_TOKEN.value(), META_PHONE_NUMBER_ID.value());
          return res.sendStatus(200);
        }
      } else {
        return res.sendStatus(200);
      }

      if (!texto) return res.sendStatus(200);

      const db = getDatabase();
      const userSnap = await db.ref(`coco-data/${from}`).get();
      const userData = userSnap.val() || {};
      const historial = Object.values(userData.historial || {}).map(m => ({ role: m.role, content: m.content })).slice(-20);
      const tNorm = texto.toLowerCase().trim();
      const esSi = ['si', 'sí', 'sii', 'siii', 'dale', 'obvio'].includes(tNorm);

      // ── CLIENTE CONFIRMA TURNO DE LISTA DE ESPERA ──
      if (esSi && userData.pendiente_turno_oferta) {
        const oferta = userData.pendiente_turno_oferta;
        const turnoSnap = await db.ref(`turnos/${oferta.uid}/${oferta.turnoId}`).get();
        const turno = turnoSnap.val();
        if (turno && turno.estado === 'cancelado') {
          await db.ref(`turnos/${oferta.uid}/${oferta.turnoId}`).update({ nombre: oferta.nombre, wpp: from, estado: 'confirmado' });
          await db.ref(`listaEspera/${oferta.uid}/${oferta.listaEsperaId}`).remove();
          await enviarWhatsApp(from, `¡Listo ${oferta.nombre}! Quedó confirmado tu turno el ${oferta.fecha} a las ${oferta.hora}hs 🐾`, META_ACCESS_TOKEN.value(), META_PHONE_NUMBER_ID.value());
          const ownerSnap = await db.ref(`usuarios/${oferta.uid}`).get();
          const owner = ownerSnap.val();
          if (owner?.whatsapp) await enviarWhatsApp(owner.whatsapp, `🐾 ${oferta.nombre} tomó el turno libre del ${oferta.fecha} a las ${oferta.hora}hs.`, META_ACCESS_TOKEN.value(), META_PHONE_NUMBER_ID.value());
        } else {
          await enviarWhatsApp(from, 'Uy, ese turno ya no está disponible. Te aviso si se libera otro 🐾', META_ACCESS_TOKEN.value(), META_PHONE_NUMBER_ID.value());
        }
        await db.ref(`coco-data/${from}/pendiente_turno_oferta`).remove();
        return res.sendStatus(200);
      }

      // ── DUEÑO CONFIRMA / RECHAZA UN TURNO PEDIDO DESDE LA PÁGINA ──
      if (userData.pendiente_confirmacion) {
        const pc = userData.pendiente_confirmacion;
        const esNo = ['no', 'nop', 'nope', 'cancelar', 'rechazar', 'negativo'].some(w => tNorm === w || tNorm.startsWith(w + ' '));
        if (esSi || esNo) {
          const turnoRef = db.ref(`turnos/${pc.uid}/${pc.turnoId}`);
          const turno = (await turnoRef.get()).val();
          await db.ref(`coco-data/${from}/pendiente_confirmacion`).remove();
          await db.ref(`pendientesConfirmacion/${pc.uid}_${pc.turnoId}`).remove();
          if (turno && turno.estado === 'pendiente_confirmacion') {
            if (esSi) {
              await turnoRef.update({ estado: 'confirmado' });
              if (pc.wppCliente) await enviarWhatsApp(pc.wppCliente, `¡Listo ${pc.nombre}! Te confirmaron el turno el ${pc.fecha} a las ${pc.hora}hs. Te esperamos 🐾`, META_ACCESS_TOKEN.value(), META_PHONE_NUMBER_ID.value());
              await enviarWhatsApp(from, `Perfecto, confirmé el turno de ${pc.nombre} (${pc.fecha} ${pc.hora}hs) 🐾`, META_ACCESS_TOKEN.value(), META_PHONE_NUMBER_ID.value());
              await registrarHistorialNublix(db, pc.uid, `Confirmaste el turno de ${pc.nombre} (${pc.fecha} ${pc.hora}hs)`, VAPID_PUBLIC_KEY.value(), VAPID_PRIVATE_KEY.value());
            } else {
              await turnoRef.update({ estado: 'cancelado' });
              const linkSitio = pc.slug ? `https://nublo.com.ar/s/${pc.slug}` : '';
              if (pc.wppCliente) await enviarWhatsApp(pc.wppCliente, `Hola ${pc.nombre}, no pudimos tomar el turno del ${pc.fecha} a las ${pc.hora}hs. ¿Probás con otro horario?${linkSitio ? ' ' + linkSitio : ''} 🐾`, META_ACCESS_TOKEN.value(), META_PHONE_NUMBER_ID.value());
              await enviarWhatsApp(from, `Listo, rechacé el turno de ${pc.nombre}. Le avisé para que elija otro horario 🐾`, META_ACCESS_TOKEN.value(), META_PHONE_NUMBER_ID.value());
              await registrarHistorialNublix(db, pc.uid, `Rechazaste el turno de ${pc.nombre} (${pc.fecha} ${pc.hora}hs)`, VAPID_PUBLIC_KEY.value(), VAPID_PRIVATE_KEY.value());
            }
          } else {
            await enviarWhatsApp(from, 'Ese turno ya se había resuelto 🐾', META_ACCESS_TOKEN.value(), META_PHONE_NUMBER_ID.value());
          }
          return res.sendStatus(200);
        }
      }

      // ── DUEÑO DE NEGOCIO — detectar y rutear a modo negocio ──
      const dueñoUidSnap = await db.ref(`whatsapp_index/${normalizarTel(from)}`).get();
      const dueñoUid = dueñoUidSnap.val();
      if (dueñoUid) {
        const ownerSnap = await db.ref(`usuarios/${dueñoUid}`).get();
        const owner = ownerSnap.val() || {};

        // Confirmación de reactivación pendiente
        if (esSi && owner.pendiente_reactivacion) {
          const pend = owner.pendiente_reactivacion;
          if (pend.wpp) {
            await enviarWhatsApp(pend.wpp, `Hola ${pend.nombre}! Hace rato que no te vemos por ${owner.negocio || 'el negocio'}. Tenemos una promo especial para vos, ¿te interesa? 🐾`, META_ACCESS_TOKEN.value(), META_PHONE_NUMBER_ID.value());
            await enviarWhatsApp(from, `Dale, ya le mandé un mensaje a ${pend.nombre} 🐾`, META_ACCESS_TOKEN.value(), META_PHONE_NUMBER_ID.value());
            await registrarHistorialNublix(db, dueñoUid, `Le escribí a ${pend.nombre} (cliente inactivo)`, VAPID_PUBLIC_KEY.value(), VAPID_PRIVATE_KEY.value());
          }
          await db.ref(`usuarios/${dueñoUid}/pendiente_reactivacion`).remove();
          return res.sendStatus(200);
        }

        const [cSnap, tSnap] = await Promise.all([
          db.ref(`clientes/${dueñoUid}`).get(),
          db.ref(`turnos/${dueñoUid}`).get(),
        ]);
        const clientesNegocio = cSnap.val() || {};
        const hoyStr = new Date().toDateString();
        const turnosHoyCount = Object.values(tSnap.val() || {}).filter(t => t.fecha && new Date(t.fecha).toDateString() === hoyStr).length;

        const { reply, cobro_cliente, vencimiento_negocio } = await preguntarNegocio(texto, historial, GROQ_API_KEY.value(), owner, {
          negocio: owner.negocio || 'tu negocio', rubro: owner.rubro || 'Nublo OS',
          turnos_hoy: turnosHoyCount, clientes_total: Object.keys(clientesNegocio).length,
        });

        if (cobro_cliente?.cliente) {
          const clienteId = Object.keys(clientesNegocio).find(id =>
            (clientesNegocio[id].nombre || '').toLowerCase().includes(cobro_cliente.cliente.toLowerCase())
          );
          const cliente = clienteId ? clientesNegocio[clienteId] : null;
          if (cliente?.wpp && !owner.alias_cobro) {
            await enviarWhatsApp(from, 'Todavía no configuraste tu alias de cobro. Entrá a Mi Cuenta en la app y agregalo para poder mandar cobros 🐾', META_ACCESS_TOKEN.value(), META_PHONE_NUMBER_ID.value());
          } else if (cliente?.wpp) {
            await enviarWhatsApp(normalizarTel(cliente.wpp), formatCobroMsg(cliente.nombre, cobro_cliente.monto, owner.alias_cobro), META_ACCESS_TOKEN.value(), META_PHONE_NUMBER_ID.value());
            await enviarWhatsApp(from, `Listo, le mandé el cobro a ${cliente.nombre} 🐾`, META_ACCESS_TOKEN.value(), META_PHONE_NUMBER_ID.value());
          } else {
            await enviarWhatsApp(from, `No tengo el WhatsApp de "${cobro_cliente.cliente}" guardado. Agregalo en Clientes y probamos de nuevo.`, META_ACCESS_TOKEN.value(), META_PHONE_NUMBER_ID.value());
          }
        } else if (vencimiento_negocio?.texto && vencimiento_negocio?.dia_mes) {
          await db.ref(`usuarios/${dueñoUid}/vencimientos_negocio`).push({ texto: vencimiento_negocio.texto, dia_mes: vencimiento_negocio.dia_mes, creado: Date.now() });
          await enviarWhatsApp(from, reply || `Anotado: ${vencimiento_negocio.texto} vence el día ${vencimiento_negocio.dia_mes} de cada mes. Te aviso 3 días antes 🐾`, META_ACCESS_TOKEN.value(), META_PHONE_NUMBER_ID.value());
        } else {
          await enviarWhatsApp(from, reply || 'Dale 🐾', META_ACCESS_TOKEN.value(), META_PHONE_NUMBER_ID.value());
        }

        await db.ref(`coco-data/${from}/historial`).push({ role: 'user', content: texto, ts: Date.now() });
        await db.ref(`coco-data/${from}/historial`).push({ role: 'assistant', content: reply || 'Dale 🐾', ts: Date.now() });
        return res.sendStatus(200);
      }

      // ── BIENVENIDA NUBLIX — primer contacto y router de modo ──
      const tieneHistorial = Object.keys(userData.historial || {}).length > 0;
      const modoActual = userData.modo;

      if (!tieneHistorial && !modoActual) {
        const bienvenida = `¡Hola! 👋 Soy Nublix, el asistente de IA de Nublo 🐾

¿Cómo puedo ayudarte hoy?

1️⃣ Soy cliente de un negocio
2️⃣ Quiero registrar mi negocio en Nublo
3️⃣ Solo quiero consultar algo`;
        await db.ref(`coco-data/${from}/modo`).set('menu_inicial');
        await db.ref(`coco-data/${from}/historial`).push({ role: 'user', content: texto, ts: Date.now() });
        await db.ref(`coco-data/${from}/historial`).push({ role: 'assistant', content: bienvenida, ts: Date.now() });
        await enviarWhatsApp(from, bienvenida, META_ACCESS_TOKEN.value(), META_PHONE_NUMBER_ID.value());
        return res.sendStatus(200);
      }

      if (modoActual === 'menu_inicial') {
        let respuesta;
        let nuevoModo = 'menu_inicial';

        if (tNorm === '1' || tNorm.includes('cliente')) {
          nuevoModo = 'concierge_negocio';
          respuesta = 'Dale 🐾 ¿De qué negocio sos cliente? Decime el nombre tal como lo conocés.';
        } else if (tNorm === '2' || tNorm.includes('negocio') || tNorm.includes('registrar')) {
          nuevoModo = 'normal';
          respuesta = `¡Genial! Te ayudo a registrar tu negocio en Nublo 🐾
Entrá desde acá: https://nublo.com.ar/NubloOS/app/
Es gratis, sin tarjeta y en 5 minutos tenés todo listo.`;
        } else if (tNorm === '3' || tNorm.includes('consulta')) {
          nuevoModo = 'normal';
          respuesta = 'Dale, contame en qué te puedo ayudar 🐾';
        } else {
          respuesta = 'No te entendí 🐾 Elegí una opción:\n\n1️⃣ Soy cliente de un negocio\n2️⃣ Quiero registrar mi negocio en Nublo\n3️⃣ Solo quiero consultar algo';
        }

        await db.ref(`coco-data/${from}/modo`).set(nuevoModo);
        await db.ref(`coco-data/${from}/historial`).push({ role: 'user', content: texto, ts: Date.now() });
        await db.ref(`coco-data/${from}/historial`).push({ role: 'assistant', content: respuesta, ts: Date.now() });
        await enviarWhatsApp(from, respuesta, META_ACCESS_TOKEN.value(), META_PHONE_NUMBER_ID.value());
        return res.sendStatus(200);
      }

      if (modoActual === 'concierge_negocio') {
        const usuariosSnap = await db.ref('usuarios').get();
        const usuarios = usuariosSnap.val() || {};
        const nombreBuscado = texto.toLowerCase().trim();
        const coincidencias = Object.values(usuarios).filter(u =>
          (u.negocio || '').toLowerCase().includes(nombreBuscado)
        );

        let respuesta;
        let nuevoModo = 'concierge_negocio';
        if (coincidencias.length === 1) {
          nuevoModo = 'cliente_negocio';
          respuesta = `¡Genial! Ya te tengo ubicado, sos cliente de *${coincidencias[0].negocio}* 🐾 ¿En qué te puedo ayudar?`;
        } else if (coincidencias.length > 1) {
          const lista = coincidencias.slice(0, 5).map(u => `• ${u.negocio}`).join('\n');
          respuesta = `Encontré varios negocios parecidos, ¿cuál es el tuyo?\n\n${lista}`;
        } else {
          respuesta = 'No encontré ningún negocio con ese nombre en Nublo 🐾 ¿Podés escribirlo de nuevo, tal como lo conocés?';
        }

        await db.ref(`coco-data/${from}/modo`).set(nuevoModo);
        await db.ref(`coco-data/${from}/historial`).push({ role: 'user', content: texto, ts: Date.now() });
        await db.ref(`coco-data/${from}/historial`).push({ role: 'assistant', content: respuesta, ts: Date.now() });
        await enviarWhatsApp(from, respuesta, META_ACCESS_TOKEN.value(), META_PHONE_NUMBER_ID.value());
        return res.sendStatus(200);
      }

      // ── ADMIN ──
      const TU_NUMERO  = '5491178247713';
      const CLAVE_ADMIN = 'cocopuris07';
      if ((from === TU_NUMERO || texto.toLowerCase().includes(CLAVE_ADMIN)) &&
          (texto.toLowerCase().includes('admin') || texto.toLowerCase().includes(CLAVE_ADMIN))) {
        const snap2 = await db.ref('coco-data').get();
        const usuarios2 = snap2.val() || {};
        const num = Object.keys(usuarios2).length;
        let totalG = 0, totalR = 0, totalM = 0;
        for (const d of Object.values(usuarios2)) {
          totalG += Object.values(d.gastos || {}).reduce((s, g) => s + (g.monto || 0), 0);
          totalR += Object.values(d.recordatorios || {}).length;
          totalM += Object.values(d.metas || {}).filter(m => m.activa).length;
        }
        const msg = `🔐 *Panel Admin — Nublo*\n👥 Usuarios: ${num}\n💰 Gastos: $${totalG.toLocaleString('es-AR')}\n📋 Recordatorios: ${totalR}\n🎯 Metas activas: ${totalM}\n🕐 ${new Date().toLocaleString('es-AR', {timeZone:'America/Argentina/Buenos_Aires'})}\n🐾 Solo vos ves esto.`;
        await enviarWhatsApp(from, msg, META_ACCESS_TOKEN.value(), META_PHONE_NUMBER_ID.value());
        return res.sendStatus(200);
      }

      // ── AYUDA ──
      const t = texto.toLowerCase().trim();
      if (['qué podés hacer','que podes hacer','ayuda','help','menu','menú','comandos'].some(w => t.includes(w))) {
        const ayuda = `🐾 Soy Nublix. Esto es todo lo que puedo hacer por vos:

📋 *RECORDATORIOS*
• "Recordame el lunes a las 9 llamar al banco"
• "Avisame cada día a las 8 que tome la pastilla"

💰 *GASTOS*
• "Gasté $5000 en comida"
• "¿Cuánto gasté esta semana?"
• "Quiero ahorrar $80000 para las vacaciones"

🎯 *METAS Y HÁBITOS*
• "Meta: correr 3 veces por semana"
• "Hábito diario: leer 20 minutos"

💊 *SALUD*
• "Tengo que tomar ibuprofeno a las 8am"
• "Me duele la cabeza hace 2 días"

🛒 *LISTAS*
• "Lista de compras: leche, pan, yerba"

🚗 *VEHÍCULO*
• "VTV vence el 15 de agosto"

🤝 *COBROS*
• "Nico me debe $5000 de la cena"

🏢 *NUBLO OS*
• "¿Qué es Nublo OS?" — te cuento los planes y módulos

Para cualquier otra cosa, escribime directo. 🐾`;
        await enviarWhatsApp(from, ayuda, META_ACCESS_TOKEN.value(), META_PHONE_NUMBER_ID.value());
        await db.ref(`coco-data/${from}/historial`).push({ role: 'user', content: texto, ts: Date.now() });
        await db.ref(`coco-data/${from}/historial`).push({ role: 'assistant', content: ayuda, ts: Date.now() });
        return res.sendStatus(200);
      }

      // ── DETECTAR MODO ──
      // Revisar si la conversación reciente ya estaba en modo vendedor
      const histReciente = historial.slice(-6).map(h => h.content).join(' ').toLowerCase();
      const enModoVendedor = esModoVendedor(texto) || 
        (esModoVendedor(histReciente) && !['recordame','gasté','gaste','lista','meta','hábito','habito','salud','pastilla'].some(w => t.includes(w)));

      if (enModoVendedor) {
        // MODO VENDEDOR
        const { reply, lead } = await preguntarVendedor(texto, historial, GROQ_API_KEY.value(), from);

        // Guardar lead si está completo
        if (lead) {
          try {
            const leadObj = JSON.parse(lead);
            if (leadObj.nombre && leadObj.rubro) {
              const ts = Date.now();
              await db.ref(`leads/${ts}`).set({ ...leadObj, whatsapp: leadObj.whatsapp || from, estado: 'pendiente', ts, origen: 'whatsapp' });
              console.log('Lead guardado:', leadObj.nombre);
            }
          } catch(e) { console.error('Error lead:', e); }
        }

        await db.ref(`coco-data/${from}/historial`).push({ role: 'user', content: texto, ts: Date.now() });
        await db.ref(`coco-data/${from}/historial`).push({ role: 'assistant', content: reply, ts: Date.now() });
        await enviarWhatsApp(from, reply, META_ACCESS_TOKEN.value(), META_PHONE_NUMBER_ID.value());
        return res.sendStatus(200);
      }

      // MODO ASISTENTE PERSONAL
      const result = await preguntarAsistente(texto, historial, GROQ_API_KEY.value(), userData);
      const { reply, reminder, gasto, pausar_hasta, lista_item, meta, ahorro_objetivo, sintoma, cobro, alerta_precio, reunion, suscripcion } = result;
      const replyFinal = reply || 'Anotado 🐾';

      await db.ref(`coco-data/${from}/historial`).push({ role: 'user', content: texto, ts: Date.now() });
      await db.ref(`coco-data/${from}/historial`).push({ role: 'assistant', content: replyFinal, ts: Date.now() });

      if (reminder?.texto && reminder?.fecha_iso) {
        await db.ref(`coco-data/${from}/recordatorios`).push({ texto: reminder.texto, fecha: reminder.fecha_iso, recurrente: reminder.recurrente || null, enviado: false, creado: Date.now() });
      }
      if (gasto?.monto) {
        await db.ref(`coco-data/${from}/gastos`).push({ monto: gasto.monto, descripcion: gasto.descripcion || '', tag: gasto.tag || null, ts: Date.now() });
      }
      if (lista_item?.nombre) {
        await db.ref(`coco-data/${from}/lista_compras`).push({ nombre: lista_item.nombre, categoria: lista_item.categoria || 'otros', ts: Date.now(), comprado: false });
      }
      if (meta?.texto) {
        await db.ref(`coco-data/${from}/metas`).push({ texto: meta.texto, check: meta.check || 'semanal', racha: 0, ts: Date.now(), activa: true });
      }
      if (ahorro_objetivo?.nombre) {
        await db.ref(`coco-data/${from}/ahorros`).push({ nombre: ahorro_objetivo.nombre, monto_meta: ahorro_objetivo.monto_meta || 0, monto_actual: 0, ts: Date.now(), activo: true });
      }
      if (sintoma?.descripcion) {
        await db.ref(`coco-data/${from}/sintomas`).push({ descripcion: sintoma.descripcion, dias: sintoma.dias || 1, ts: Date.now() });
      }
      if (cobro?.persona && cobro?.monto) {
        await db.ref(`coco-data/${from}/cobros`).push({ persona: cobro.persona, monto: cobro.monto, descripcion: cobro.descripcion || '', cobrado: false, ts: Date.now() });
      }
      if (alerta_precio?.item) {
        await db.ref(`coco-data/${from}/alertas_precio`).push({ item: alerta_precio.item, condicion: alerta_precio.condicion || 'baja de', valor: alerta_precio.valor || 0, activa: true, ts: Date.now() });
      }
      if (reunion?.tema && reunion?.fecha_iso) {
        const fechaR = new Date(reunion.fecha_iso);
        await db.ref(`coco-data/${from}/recordatorios`).push({ texto: `Reunión con ${reunion.tema} en 30 minutos`, fecha: new Date(fechaR.getTime() - 30*60*1000).toISOString(), recurrente: null, enviado: false, creado: Date.now() });
        await db.ref(`coco-data/${from}/reuniones`).push({ tema: reunion.tema, fecha: reunion.fecha_iso, ts: Date.now() });
      }
      if (pausar_hasta) {
        await db.ref(`coco-data/${from}/pausado_hasta`).set(pausar_hasta);
      }

      await enviarWhatsApp(from, replyFinal, META_ACCESS_TOKEN.value(), META_PHONE_NUMBER_ID.value());
      return res.sendStatus(200);

    } catch(err) {
      console.error('Error webhook:', err);
      return res.sendStatus(200);
    }
  }
);

// ═══════════════════════════════════════════════
// cocoRecordatorios — cada 15 minutos
// ═══════════════════════════════════════════════
exports.cocoRecordatorios = onSchedule(
  { schedule: 'every 15 minutes', secrets: [META_ACCESS_TOKEN, META_PHONE_NUMBER_ID] },
  async () => {
    const db = getDatabase();
    const ahora = Date.now();
    const usuariosSnap = await db.ref('coco-data').get();
    const usuarios = usuariosSnap.val() || {};
    for (const [telefono, datos] of Object.entries(usuarios)) {
      if (datos.pausado_hasta && new Date(datos.pausado_hasta).getTime() > ahora) continue;
      for (const [id, rec] of Object.entries(datos.recordatorios || {})) {
        if (rec.enviado || new Date(rec.fecha).getTime() > ahora) continue;
        await enviarWhatsApp(telefono, `🐾 ¡Che! Te recuerdo: ${rec.texto}`, META_ACCESS_TOKEN.value(), META_PHONE_NUMBER_ID.value());
        if (['diario','semanal','anual'].includes(rec.recurrente)) {
          const next = new Date(rec.fecha);
          if (rec.recurrente === 'diario')  next.setDate(next.getDate() + 1);
          if (rec.recurrente === 'semanal') next.setDate(next.getDate() + 7);
          if (rec.recurrente === 'anual')   next.setFullYear(next.getFullYear() + 1);
          await db.ref(`coco-data/${telefono}/recordatorios/${id}`).update({ fecha: next.toISOString(), enviado: false });
        } else {
          await db.ref(`coco-data/${telefono}/recordatorios/${id}/enviado`).set(true);
        }
      }
    }
  }
);

// ═══════════════════════════════════════════════
// cocoResumenSemanal — domingos 9am Argentina
// ═══════════════════════════════════════════════
exports.cocoResumenSemanal = onSchedule(
  { schedule: '0 9 * * 0', timeZone: 'America/Argentina/Buenos_Aires', secrets: [META_ACCESS_TOKEN, META_PHONE_NUMBER_ID] },
  async () => {
    const db = getDatabase();
    const ahora = Date.now();
    const haceUnaSemana = ahora - 7 * 24 * 60 * 60 * 1000;
    const enUnaSemana = ahora + 7 * 24 * 60 * 60 * 1000;
    const snap = await db.ref('coco-data').get();
    for (const [tel, datos] of Object.entries(snap.val() || {})) {
      if (datos.pausado_hasta && new Date(datos.pausado_hasta).getTime() > ahora) continue;
      const pendientes = Object.values(datos.recordatorios || {}).filter(r => !r.enviado && new Date(r.fecha).getTime() <= enUnaSemana);
      const gastos = Object.values(datos.gastos || {}).filter(g => g.ts >= haceUnaSemana);
      if (!pendientes.length && !gastos.length) continue;
      let texto = '🐾 Resumen de la semana:\n\n';
      if (pendientes.length) {
        texto += '📋 Esta semana tenés:\n';
        pendientes.forEach(r => {
          const f = new Date(r.fecha).toLocaleDateString('es-AR', { weekday:'short', day:'numeric', month:'short' });
          texto += `• ${r.texto} — ${f}\n`;
        });
        texto += '\n';
      }
      if (gastos.length) {
        const total = gastos.reduce((s, g) => s + (g.monto || 0), 0);
        texto += `💰 Gastaste $${total.toLocaleString('es-AR')} esta semana.\n`;
      }
      texto += '\n¡Buena semana! 🐾';
      await enviarWhatsApp(tel, texto, META_ACCESS_TOKEN.value(), META_PHONE_NUMBER_ID.value());
    }
  }
);

// ═══════════════════════════════════════════════
// cocoResumenLaboral — viernes 18hs Argentina
// ═══════════════════════════════════════════════
exports.cocoResumenLaboral = onSchedule(
  { schedule: '0 18 * * 5', timeZone: 'America/Argentina/Buenos_Aires', secrets: [META_ACCESS_TOKEN, META_PHONE_NUMBER_ID] },
  async () => {
    const db = getDatabase();
    const ahora = Date.now();
    const haceUnaSemana = ahora - 7 * 24 * 60 * 60 * 1000;
    const enUnaSemana = ahora + 7 * 24 * 60 * 60 * 1000;
    const snap = await db.ref('coco-data').get();
    for (const [tel, datos] of Object.entries(snap.val() || {})) {
      if (datos.pausado_hasta && new Date(datos.pausado_hasta).getTime() > ahora) continue;
      const recs = Object.values(datos.recordatorios || {});
      const hecho = recs.filter(r => r.enviado && new Date(r.fecha).getTime() >= haceUnaSemana);
      const proxima = recs.filter(r => !r.enviado && new Date(r.fecha).getTime() <= enUnaSemana);
      if (!hecho.length && !proxima.length) continue;
      let texto = '🐾 Resumen laboral:\n\n';
      if (hecho.length) { texto += '✅ Esta semana:\n'; hecho.forEach(r => { texto += `• ${r.texto}\n`; }); texto += '\n'; }
      if (proxima.length) {
        texto += '📋 La semana que viene:\n';
        proxima.forEach(r => {
          const f = new Date(r.fecha).toLocaleDateString('es-AR', { weekday:'short', day:'numeric', month:'short' });
          texto += `• ${r.texto} — ${f}\n`;
        });
      }
      texto += '\n¡Buen fin de semana! 🐾';
      await enviarWhatsApp(tel, texto, META_ACCESS_TOKEN.value(), META_PHONE_NUMBER_ID.value());
    }
  }
);

// ═══════════════════════════════════════════════
// cocoCheckRachas — 9am diario Argentina
// ═══════════════════════════════════════════════
exports.cocoCheckRachas = onSchedule(
  { schedule: '0 9 * * *', timeZone: 'America/Argentina/Buenos_Aires', secrets: [META_ACCESS_TOKEN, META_PHONE_NUMBER_ID] },
  async () => {
    const db = getDatabase();
    const ahora = Date.now();
    const snap = await db.ref('coco-data').get();
    for (const [tel, datos] of Object.entries(snap.val() || {})) {
      if (datos.pausado_hasta && new Date(datos.pausado_hasta).getTime() > ahora) continue;
      for (const [, meta] of Object.entries(datos.metas || {}).filter(([,m]) => m.activa && m.check === 'diario')) {
        const racha = meta.racha || 0;
        const msg = racha === 0 ? `🐾 ¿Hoy arrancás con "${meta.texto}"?`
          : racha < 7  ? `🐾 ${racha} día${racha!==1?'s':''} con "${meta.texto}". No rompas la racha.`
          : racha < 30 ? `🔥 ${racha} días seguidos. Estás en racha seria.`
          : `🏆 ${racha} días con "${meta.texto}". Ya es un hábito. 🐾`;
        await enviarWhatsApp(tel, msg, META_ACCESS_TOKEN.value(), META_PHONE_NUMBER_ID.value());
      }
    }
  }
);

// ═══════════════════════════════════════════════
// enviarCobroWhatsapp — la PWA pide a Nublix mandar el cobro al cliente
// ═══════════════════════════════════════════════
exports.enviarCobroWhatsapp = onRequest(
  { secrets: [META_ACCESS_TOKEN, META_PHONE_NUMBER_ID, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY], cors: true },
  async (req, res) => {
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    if (req.method !== 'POST')   return res.sendStatus(405);
    try {
      const { uid, clienteWpp, clienteNombre, monto, concepto } = req.body;
      if (!uid || !clienteWpp || !clienteNombre || !monto) {
        return res.status(400).json({ ok: false, error: 'Faltan datos' });
      }
      const db = getDatabase();
      const ownerSnap = await db.ref(`usuarios/${uid}`).get();
      const owner = ownerSnap.val();
      if (!owner) return res.status(404).json({ ok: false, error: 'Negocio no encontrado' });
      if (!owner.alias_cobro) return res.status(400).json({ ok: false, error: 'sin_alias' });

      const tel = normalizarTel(clienteWpp);
      await enviarWhatsApp(tel, formatCobroMsg(clienteNombre, monto, owner.alias_cobro), META_ACCESS_TOKEN.value(), META_PHONE_NUMBER_ID.value());

      // Guarda quién es el dueño para este teléfono, así cuando el cliente
      // mande el comprobante sabemos a qué negocio/cobro corresponde
      await db.ref(`cobro_en_curso/${tel}`).set({ uid, clienteNombre, monto: Number(monto), concepto: concepto || '', ts: Date.now() });
      await registrarHistorialNublix(db, uid, `Envié un cobro a ${clienteNombre} ($${Number(monto).toLocaleString('es-AR')})`, VAPID_PUBLIC_KEY.value(), VAPID_PRIVATE_KEY.value());

      return res.json({ ok: true });
    } catch(e) {
      console.error('enviarCobroWhatsapp', e);
      return res.status(500).json({ ok: false, error: 'Error interno' });
    }
  }
);

// ═══════════════════════════════════════════════
// rechazarCobro — la PWA rechaza un comprobante pendiente
// ═══════════════════════════════════════════════
exports.rechazarCobro = onRequest(
  { secrets: [META_ACCESS_TOKEN, META_PHONE_NUMBER_ID], cors: true },
  async (req, res) => {
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    if (req.method !== 'POST')   return res.sendStatus(405);
    try {
      const { uid, cobroId } = req.body;
      if (!uid || !cobroId) return res.status(400).json({ ok: false, error: 'Faltan datos' });

      const db = getDatabase();
      const cobroSnap = await db.ref(`usuarios/${uid}/cobros_pendientes/${cobroId}`).get();
      const cobro = cobroSnap.val();
      if (!cobro) return res.status(404).json({ ok: false, error: 'Cobro no encontrado' });

      await db.ref(`usuarios/${uid}/cobros_pendientes/${cobroId}`).update({ estado: 'rechazado' });

      if (cobro.clienteWpp) {
        await enviarWhatsApp(cobro.clienteWpp, `Hola ${cobro.cliente || ''}, no pudimos verificar tu pago. ¿Podés mandar el comprobante de nuevo? 🐾`, META_ACCESS_TOKEN.value(), META_PHONE_NUMBER_ID.value());
      }

      return res.json({ ok: true });
    } catch(e) {
      console.error('rechazarCobro', e);
      return res.status(500).json({ ok: false, error: 'Error interno' });
    }
  }
);

// ═══════════════════════════════════════════════
// nublixChat — proxy para la PWA
// ═══════════════════════════════════════════════
exports.nublixChat = onRequest(
  { secrets: [GROQ_API_KEY], cors: true },
  async (req, res) => {
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    if (req.method !== 'POST')   return res.sendStatus(405);
    try {
      const { messages = [], context = {} } = req.body;
      const {
        nombre = 'Usuario', negocio = 'Mi negocio', modulo = 'Nublo OS',
        clientes_total = 0, clientes_activos = 0, clientes_lista = 'Sin clientes todavía',
        turnos_hoy = 0, turnos_pendientes = 0, ingresos_semana = 'Sin datos', ingresos_mes = 'Sin datos',
        fecha_hoy = new Date().toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' }),
        dias_de_cuenta = 0,
      } = context;

      const ultimoMsg = (messages[messages.length - 1]?.content || '').toLowerCase();
      const KEYWORDS_VENTA = ['contratar', 'precio', 'módulo', 'modulo', 'trimly', 'pitstop', 'aurea', 'auréa', 'quiero probar', 'cuánto sale', 'cuanto sale'];
      const esVendedor = KEYWORDS_VENTA.some(k => ultimoMsg.includes(k));
      const esUsuarioNuevo = clientes_total === 0 && turnos_hoy === 0 && dias_de_cuenta < 7;
      const primerNombre = (nombre || 'Usuario').split(' ')[0];

      const system = esVendedor
        ? `Sos Nublix, el asistente de ventas de Nublo OS. Tu trabajo es explicarle a ${nombre} cómo funciona y ayudarlo a empezar.
Directo, cálido, rioplatense. Máximo 2-3 oraciones. 🐾 a veces. Hablás como un argentino real, nunca en español neutro: "dale", "te mando", "avisame". Conjugá con "vos".

Nublo OS es gratis para siempre. Sin tarjeta, sin límites, sin trampa.
Para empezar, mandalo a hablar por WhatsApp: https://wa.me/5491164146464

Hoy: ${fecha_hoy}.`
        : esUsuarioNuevo
        ? `Sos Nublix, el asistente IA de Nublo OS para "${negocio}" (módulo: ${modulo}). Le hablás a ${primerNombre}, que se acaba de registrar y todavía no tiene clientes ni turnos cargados.
Directo, cálido, rioplatense. Máximo 2-3 oraciones. 🐾 a veces. Hablás como un argentino real, nunca en español neutro: "dale", "te mando", "avisame". Conjugá con "vos".

REGLA ABSOLUTA: nunca le digas que "no tiene clientes ni turnos" ni nada parecido — es obvio porque recién se registró, y decirlo suena ofensivo. En cambio, dale la bienvenida como algo positivo y proponele un primer paso concreto (cargar servicios o cargar el primer cliente).
Si es el primer mensaje de la charla, arrancá con algo en este espíritu (no copies literal, adaptalo): "¡Hola ${primerNombre}! Bienvenido a Nublo 🐾 Soy Nublix, tu asistente de IA. Estoy acá para ayudarte a organizar y hacer crecer ${negocio}. ¿Por dónde arrancamos — cargamos tus servicios o tu primer cliente?"

Hoy: ${fecha_hoy}.`
        : `Sos Nublix, el asistente IA de Nublo OS para "${negocio}" (módulo: ${modulo}). Le hablás a ${nombre}.
Directo, rioplatense, humor seco. Máximo 2-3 oraciones. 🐾 a veces. Hablás como un argentino real, nunca en español neutro: "dale", "te mando", "avisame", "¿querés que lo agendo?", "re bien". Conjugá con "vos".

DATOS DEL NEGOCIO HOY:
- Clientes: ${clientes_total} totales, ${clientes_activos} activos (${clientes_lista})
- Turnos hoy: ${turnos_hoy} (${turnos_pendientes} pendientes)
- Ingresos esta semana: ${ingresos_semana} · este mes: ${ingresos_mes}

Podés: comentar turnos, clientes e ingresos con esos datos reales, explicar funciones, dar consejos de negocio, redactar mensajes para clientes.
No podés: enviar WPP directamente, cobrar.
Hoy: ${fecha_hoy}.`;

      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY.value()}` },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: 200, messages: [{ role: 'system', content: system }, ...messages.slice(-10)] })
      });
      const d = await r.json();
      return res.json({ reply: d.choices?.[0]?.message?.content || '🐾' });
    } catch(e) {
      return res.status(500).json({ reply: 'Sin conexión. Reintentá. 🐾' });
    }
  }
);

// ═══════════════════════════════════════════════
// nublixLanding — vendedor en la landing
// ═══════════════════════════════════════════════
exports.nublixLanding = onRequest(
  { secrets: [GROQ_API_KEY], cors: true },
  async (req, res) => {
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    if (req.method !== 'POST')   return res.sendStatus(405);
    try {
      const { messages = [], leadData = {} } = req.body;
      const db = getDatabase();
      const system = `Sos Nublix, el asistente de Nublo OS en la landing. Tu trabajo es responder cualquier pregunta del visitante de forma clara, específica y servicial — nunca con una respuesta vacía como "dale" solo. Si en la charla muestra intención real de sumarse, ahí lo guiás a registrarse.

PERSONALIDAD: directo, cálido, rioplatense. Nunca en español neutro ni latinoamericano genérico: "dale", "te cuento", "posta", "re bien", "¿arrancamos?". Conjugá siempre con "vos". Máximo 3 oraciones, siempre completas y con la info pedida. Emoji 🐾 ocasional, no en cada mensaje.

DATOS REALES DE NUBLO OS (usalos para responder con precisión, nunca inventes otra cosa):
- Es gratis para siempre. Sin tarjeta, sin límite de tiempo, sin trampa.
- Es un sistema operativo para negocios: centraliza turnos, clientes, cobros y WhatsApp en un solo lugar.
- Nublix (vos) es la IA que asiste al dueño del negocio: manda recordatorios automáticos, cobra por WhatsApp, recupera clientes inactivos, contesta consultas de clientes.
- Módulos según rubro: Trimly (barberías/peluquerías), PitStop (talleres mecánicos), Auréa (salones de belleza), Purí (comercios/tiendas) — y funciona para cualquier otro rubro también.
- Es una PWA: se usa desde el navegador, sin instalar nada de una tienda de apps.

EJEMPLOS DE BUENA RESPUESTA (no los copies literal, adaptalos a la pregunta exacta):
- "¿Qué es Nublo OS?" → explicación clara y vendedora de qué es y qué problema resuelve.
- "¿Cuánto cuesta?" → "Es gratis. Sin tarjeta, sin límite de tiempo."
- "¿Para barberías?" → explicación específica con un ejemplo concreto de uso en una barbería.

Si el visitante pide empezar, probar o registrarse, recolectá en orden: tipo de negocio → nombre y apellido → WhatsApp → email. Cuando tengas todo, incluí al final de tu respuesta (sin mostrárselo nunca al usuario): [LEAD:{"nombre":"...","apellido":"...","rubro":"...","whatsapp":"...","email":"..."}]

Datos recolectados hasta ahora: ${JSON.stringify(leadData)}. Hoy: ${new Date().toLocaleDateString('es-AR')}.`;
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY.value()}` },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: 300, messages: [{ role: 'system', content: system }, ...messages.slice(-12)] })
      });
      const d = await r.json();
      let reply = d.choices?.[0]?.message?.content || '🐾';
      const leadMatch = reply.match(/\[LEAD:(\{[\s\S]*?\})\]/);
      let leadGuardado = false;
      if (leadMatch) {
        try {
          const lead = JSON.parse(leadMatch[1]);
          if (lead.nombre && lead.rubro) {
            await db.ref(`leads/${Date.now()}`).set({ ...lead, estado: 'pendiente', ts: Date.now() });
            leadGuardado = true;
          }
        } catch(e) { console.error('Lead parse error:', e); }
        reply = reply.replace(/\[LEAD:[\s\S]*?\]/g, '').trim();
      }
      return res.json({ reply, leadGuardado });
    } catch(e) {
      return res.status(500).json({ reply: 'Sin conexión. Reintentá. 🐾' });
    }
  }
);

// ═══════════════════════════════════════════════
// nublixConcierge — chat público de un Nublo Site específico (nublo.com.ar/s/slug)
// ═══════════════════════════════════════════════
exports.nublixConcierge = onRequest(
  { secrets: [GROQ_API_KEY], cors: true },
  async (req, res) => {
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    if (req.method !== 'POST')   return res.sendStatus(405);
    try {
      const { slug, messages = [] } = req.body;
      if (!slug) return res.status(400).json({ reply: 'Sin conexión. Reintentá. 🐾' });
      const db = getDatabase();
      const sitioSnap = await db.ref(`sitios/${slug}`).get();
      const sitio = sitioSnap.val();
      if (!sitio || sitio.activo === false) {
        return res.json({ reply: 'Este sitio no está disponible ahora 🐾' });
      }

      const catSnap = await db.ref(`usuarios/${sitio.uid}/catalogo`).get();
      const catalogo = Object.values(catSnap.val() || {}).filter(it => it.activo !== false);
      const catalogoTxt = catalogo.length
        ? catalogo.map(it => `- ${it.nombre}: $${(it.precio||0).toLocaleString('es-AR')}${it.tipo==='producto' && it.stock!=null ? ` (stock: ${it.stock})` : ''}`).join('\n')
        : 'Todavía no cargaron el catálogo.';

      const system = `Sos Nublix, el asistente del negocio "${sitio.nombre}" (rubro: ${sitio.rubro || 'no especificado'}). Le hablás a un visitante de la página pública del negocio, NO al dueño.

PERSONALIDAD: rioplatense, cálido, directo. "dale", "te cuento", "¿querés que te pase el link?". Conjugá con "vos". Máximo 2-3 oraciones.

DATOS REALES DEL NEGOCIO (no inventes nada que no esté acá):
- Descripción: ${sitio.descripcion || 'sin descripción cargada'}
- Horarios: ${sitio.horarios || 'no especificados, decile que consulte por WhatsApp'}
- Catálogo:
${catalogoTxt}

Si preguntan precios o servicios, respondé SOLO con lo que está en el catálogo de arriba. Si no está, decí que no lo tenés cargado y que pregunte por WhatsApp.
Si quieren reservar un turno o ya decidieron, decíles que toquen el botón "Reservar turno" acá en la página: ahí eligen día y horario libre y yo me encargo de confirmarlo con el negocio. No los mandes a WhatsApp.
Nunca inventes precios, horarios ni disponibilidad que no esté en los datos de arriba.`;

      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY.value()}` },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: 200, messages: [{ role: 'system', content: system }, ...messages.slice(-10)] })
      });
      const d = await r.json();
      return res.json({ reply: d.choices?.[0]?.message?.content || '🐾' });
    } catch(e) {
      console.error('nublixConcierge', e);
      return res.status(500).json({ reply: 'Sin conexión. Reintentá. 🐾' });
    }
  }
);

// ═══════════════════════════════════════════════
// nublixReservarTurno — reservas desde la página pública (Nublo Site)
//   accion: 'disponibilidad' → horarios libres de un día
//   accion: 'reservar'       → crea turno pendiente_confirmacion y avisa al dueño
// La confirmación la resuelve el dueño por WhatsApp (cocoWebhook) o, si no
// responde en 5 minutos, la toma Nublix (nublixAutoConfirmarTurnos).
// ═══════════════════════════════════════════════
const RSV_HORA_INICIO = 9;   // primera franja del día (09:00)
const RSV_HORA_FIN    = 20;  // las franjas arrancan hasta las 19:00 (con paso de 60')
const RSV_PASO_MIN    = 60;  // duración de cada franja, en minutos

function rsvSlotsDelDia(fechaYMD, turnos) {
  const ocupados = new Set(
    Object.values(turnos || {})
      .filter(t => t && t.estado !== 'cancelado' && t.fecha && new Date(t.fecha).toISOString().slice(0, 10) === fechaYMD)
      .map(t => t.hora)
  );
  const libres = [];
  for (let h = RSV_HORA_INICIO; h < RSV_HORA_FIN; h++) {
    for (let m = 0; m < 60; m += RSV_PASO_MIN) {
      const hora = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      if (!ocupados.has(hora)) libres.push(hora);
    }
  }
  return { libres, ocupados: [...ocupados] };
}

exports.nublixReservarTurno = onRequest(
  { secrets: [META_ACCESS_TOKEN, META_PHONE_NUMBER_ID, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY], cors: true },
  async (req, res) => {
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    if (req.method !== 'POST')   return res.sendStatus(405);
    try {
      const { accion, slug, fecha, hora, servicio, nombre, wpp } = req.body || {};
      if (!slug || !fecha) return res.status(400).json({ ok: false, error: 'Faltan datos.' });

      const db = getDatabase();
      const sitioSnap = await db.ref(`sitios/${slug}`).get();
      const sitio = sitioSnap.val();
      if (!sitio || sitio.activo === false) return res.status(404).json({ ok: false, error: 'Sitio no disponible.' });
      const uid = sitio.uid;

      const turnosSnap = await db.ref(`turnos/${uid}`).get();
      const turnos = turnosSnap.val() || {};

      // ── DISPONIBILIDAD ──
      if (accion === 'disponibilidad') {
        const { libres, ocupados } = rsvSlotsDelDia(fecha, turnos);
        return res.json({ ok: true, libres, ocupados });
      }

      // ── RESERVAR ──
      if (accion === 'reservar') {
        if (!hora || !nombre || !wpp) return res.status(400).json({ ok: false, error: 'Completá nombre, WhatsApp y horario.' });

        // Chequeo de choque (incluye carreras entre dos clientes)
        const choca = Object.values(turnos).some(t =>
          t && t.estado !== 'cancelado' && t.hora === hora &&
          t.fecha && new Date(t.fecha).toISOString().slice(0, 10) === fecha
        );
        if (choca) {
          const { libres } = rsvSlotsDelDia(fecha, turnos);
          return res.json({ ok: false, motivo: 'ocupado', libres });
        }

        const fechaISO   = new Date(`${fecha}T00:00:00`).toISOString();
        const wppCliente = telParaWhatsApp(wpp);
        // El aviso al dueño sale del WhatsApp registrado en su cuenta de usuario
        // (no del que quedó en el sitio), normalizado al formato de WhatsApp.
        const ownerWppSnap = await db.ref(`usuarios/${uid}/whatsapp`).get();
        const ownerTel   = telParaWhatsApp(ownerWppSnap.val() || sitio.whatsapp || '');
        const tieneDuenoWpp = !!ownerTel;

        const turnoRef = db.ref(`turnos/${uid}`).push();
        const turnoId  = turnoRef.key;
        const solicitado_ts = Date.now();

        await turnoRef.set({
          nombre, wpp: wppCliente, servicio: servicio || 'Turno',
          fecha: fechaISO, hora,
          estado: tieneDuenoWpp ? 'pendiente_confirmacion' : 'confirmado',
          origen: 'sitio', solicitado_ts, creado: solicitado_ts, recordatorio_enviado: false,
        });

        const fechaTxt = new Date(fechaISO).toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
        const metaToken = META_ACCESS_TOKEN.value(), metaPhone = META_PHONE_NUMBER_ID.value();

        // Sin WhatsApp del dueño no hay a quién pedirle confirmación → la toma Nublix
        if (!tieneDuenoWpp) {
          await enviarWhatsApp(wppCliente, `¡Listo ${nombre}! Tu turno en ${sitio.nombre || 'el negocio'} quedó reservado para el ${fechaTxt} a las ${hora}hs 🐾`, metaToken, metaPhone);
          await registrarHistorialNublix(db, uid, `Reservé un turno de ${nombre} (${fechaTxt} ${hora}hs) desde la página`, VAPID_PUBLIC_KEY.value(), VAPID_PRIVATE_KEY.value());
          return res.json({ ok: true, estado: 'confirmado' });
        }

        // Punteros para resolver la confirmación (webhook + barrido de 5')
        await db.ref(`coco-data/${ownerTel}/pendiente_confirmacion`).set({
          uid, turnoId, nombre, wppCliente, fecha: fechaTxt, hora, servicio: servicio || 'Turno', slug,
        });
        await db.ref(`pendientesConfirmacion/${uid}_${turnoId}`).set({
          uid, turnoId, nombre, wppCliente, ownerTel, fecha: fechaTxt, hora, servicio: servicio || 'Turno', slug, solicitado_ts,
        });

        await enviarWhatsApp(ownerTel,
          `🐾 ${nombre} quiere reservar "${servicio || 'Turno'}" el ${fechaTxt} a las ${hora}hs.\n\n¿Lo confirmás? Respondé *SÍ* o *NO*.\nSi no contestás en 5 minutos, lo confirmo yo.`,
          metaToken, metaPhone);
        await enviarWhatsApp(wppCliente,
          `Recibí tu pedido de turno en ${sitio.nombre || 'el negocio'} para el ${fechaTxt} a las ${hora}hs. Lo estoy confirmando, en unos minutos te aviso 🐾`,
          metaToken, metaPhone);
        await registrarHistorialNublix(db, uid, `${nombre} pidió turno el ${fechaTxt} a las ${hora}hs — esperando tu confirmación`, VAPID_PUBLIC_KEY.value(), VAPID_PRIVATE_KEY.value());

        return res.json({ ok: true, estado: 'pendiente_confirmacion' });
      }

      return res.status(400).json({ ok: false, error: 'Acción inválida.' });
    } catch(e) {
      console.error('nublixReservarTurno', e);
      return res.status(500).json({ ok: false, error: 'Error del servidor.' });
    }
  }
);

// ═══════════════════════════════════════════════
// nublixAutoConfirmarTurnos — cada 1 minuto.
// Toma los turnos pedidos desde la página que el dueño no confirmó en 5 min
// y, como el horario ya se validó libre, los confirma solo (mejor decisión).
// ═══════════════════════════════════════════════
exports.nublixAutoConfirmarTurnos = onSchedule(
  { schedule: 'every 1 minutes', secrets: [META_ACCESS_TOKEN, META_PHONE_NUMBER_ID, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY] },
  async () => {
    const db = getDatabase();
    const snap = await db.ref('pendientesConfirmacion').get();
    const pend = snap.val() || {};
    const ahora = Date.now();
    const LIMITE_MS = 5 * 60 * 1000;
    const metaToken = META_ACCESS_TOKEN.value(), metaPhone = META_PHONE_NUMBER_ID.value();

    for (const [key, pc] of Object.entries(pend)) {
      if (!pc || (ahora - (pc.solicitado_ts || 0)) < LIMITE_MS) continue;

      const turnoRef = db.ref(`turnos/${pc.uid}/${pc.turnoId}`);
      const turno = (await turnoRef.get()).val();

      // Limpiar punteros pase lo que pase
      await db.ref(`pendientesConfirmacion/${key}`).remove();
      if (pc.ownerTel) await db.ref(`coco-data/${pc.ownerTel}/pendiente_confirmacion`).remove();

      if (!turno || turno.estado !== 'pendiente_confirmacion') continue; // ya lo resolvió el dueño

      await turnoRef.update({ estado: 'confirmado' });
      if (pc.wppCliente) await enviarWhatsApp(pc.wppCliente, `¡Listo ${pc.nombre}! Tu turno del ${pc.fecha} a las ${pc.hora}hs quedó confirmado 🐾`, metaToken, metaPhone);
      if (pc.ownerTel)   await enviarWhatsApp(pc.ownerTel, `🐾 Confirmé solo el turno de ${pc.nombre} (${pc.fecha} ${pc.hora}hs) — no llegaste a responder en 5 minutos.`, metaToken, metaPhone);
      try { await registrarHistorialNublix(db, pc.uid, `Confirmé solo el turno de ${pc.nombre} (${pc.fecha} ${pc.hora}hs) tras 5 min sin respuesta`, VAPID_PUBLIC_KEY.value(), VAPID_PRIVATE_KEY.value()); } catch(e) {}
    }
  }
);

// ═══════════════════════════════════════════════
// crearUsuarioNublo — desde panel admin
// ═══════════════════════════════════════════════
exports.crearUsuarioNublo = onRequest(
  { cors: true },
  async (req, res) => {
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    if (req.method !== 'POST')   return res.sendStatus(405);
    const { email, nombre, rubro, whatsapp, adminKey, soloResetPass, nuevaPass } = req.body;
    if (adminKey !== 'nublo-admin-2026') return res.status(403).json({ ok: false, error: 'No autorizado' });
    if (!email) return res.status(400).json({ ok: false, error: 'Falta email' });
    try {
      const auth = getAuth();
      const db = getDatabase();
      const pass = nuevaPass || ('Nublo' + Math.floor(1000 + Math.random() * 9000));
      if (soloResetPass) {
        const u = await auth.getUserByEmail(email);
        await auth.updateUser(u.uid, { password: pass });
        return res.json({ ok: true, pass_temporal: pass });
      }
      let uid;
      try {
        uid = (await auth.createUser({ email, password: pass, displayName: nombre })).uid;
      } catch(e) {
        if (e.code === 'auth/email-already-exists') {
          const u = await auth.getUserByEmail(email);
          uid = u.uid;
          await auth.updateUser(uid, { password: pass });
        } else throw e;
      }
      await db.ref(`usuarios/${uid}`).set({ nombre, email, rubro: rubro || null, whatsapp: whatsapp || null, onboarding_completo: true, creado: Date.now(), pass_temporal: pass });
      return res.json({ ok: true, uid, pass_temporal: pass });
    } catch(e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }
);

// ═══════════════════════════════════════════════
// nublixResumenDiario — 8:30am diario Argentina, al dueño
// ═══════════════════════════════════════════════
exports.nublixResumenDiario = onSchedule(
  { schedule: '30 8 * * *', timeZone: 'America/Argentina/Buenos_Aires', secrets: [META_ACCESS_TOKEN, META_PHONE_NUMBER_ID] },
  async () => {
    const db = getDatabase();
    const usuariosSnap = await db.ref('usuarios').get();
    const hoyStr = new Date().toDateString();
    for (const [uid, u] of Object.entries(usuariosSnap.val() || {})) {
      if (!u.whatsapp || !u.onboarding_completo) continue;
      const nombre = (u.nombre || '').split(' ')[0] || 'che';
      const tSnap = await db.ref(`turnos/${uid}`).get();
      const turnosHoy = Object.values(tSnap.val() || {})
        .filter(t => t.fecha && new Date(t.fecha).toDateString() === hoyStr && t.estado !== 'cancelado')
        .sort((a, b) => (a.hora || '').localeCompare(b.hora || ''));

      const msg = turnosHoy.length
        ? `Buenos días ${nombre} 🐾 Hoy tenés ${turnosHoy.length} turno${turnosHoy.length === 1 ? '' : 's'}. El primero a las ${turnosHoy[0].hora}. ¿Arrancamos?`
        : `Buenos días ${nombre} 🐾 Hoy no tenés turnos agendados todavía. Tranqui, cualquier novedad te aviso.`;
      await enviarWhatsApp(u.whatsapp, msg, META_ACCESS_TOKEN.value(), META_PHONE_NUMBER_ID.value());
    }
  }
);

// ═══════════════════════════════════════════════
// nublixResumenSemanalNegocio — lunes 9am Argentina, al dueño
// ═══════════════════════════════════════════════
exports.nublixResumenSemanalNegocio = onSchedule(
  { schedule: '0 9 * * 1', timeZone: 'America/Argentina/Buenos_Aires', secrets: [META_ACCESS_TOKEN, META_PHONE_NUMBER_ID] },
  async () => {
    const db = getDatabase();
    const usuariosSnap = await db.ref('usuarios').get();
    const ahora = Date.now();
    const haceUnaSemana = ahora - 7 * 24 * 60 * 60 * 1000;
    const fechaInicio = new Date(haceUnaSemana).toLocaleDateString('es-AR', { day: 'numeric', month: 'short' });

    for (const [uid, u] of Object.entries(usuariosSnap.val() || {})) {
      if (!u.whatsapp || !u.onboarding_completo) continue;
      const [tSnap, pSnap, cSnap] = await Promise.all([
        db.ref(`turnos/${uid}`).get(),
        db.ref(`pagos/${uid}`).get(),
        db.ref(`clientes/${uid}`).get(),
      ]);
      const turnos = Object.values(tSnap.val() || {}).filter(t => t.fecha && new Date(t.fecha).getTime() >= haceUnaSemana);
      const pagos  = Object.values(pSnap.val() || {}).filter(p => (p.ts || 0) >= haceUnaSemana);
      const clientesNuevos = Object.values(cSnap.val() || {}).filter(c => ((c.creado || c.ts) || 0) >= haceUnaSemana);
      const ingresos = pagos.reduce((s, p) => s + (p.monto || 0), 0);

      const msg = `Semana del ${fechaInicio}: ${turnos.length} turnos · $${ingresos.toLocaleString('es-AR')} · ${clientesNuevos.length} clientes nuevos 🐾`;
      await enviarWhatsApp(u.whatsapp, msg, META_ACCESS_TOKEN.value(), META_PHONE_NUMBER_ID.value());
    }
  }
);

// ═══════════════════════════════════════════════
// nublixReactivacionClientes — 10am diario Argentina
// detecta clientes sin turno hace 28+ días y le avisa al dueño
// ═══════════════════════════════════════════════
exports.nublixReactivacionClientes = onSchedule(
  { schedule: '0 10 * * *', timeZone: 'America/Argentina/Buenos_Aires', secrets: [META_ACCESS_TOKEN, META_PHONE_NUMBER_ID] },
  async () => {
    const db = getDatabase();
    const usuariosSnap = await db.ref('usuarios').get();
    const ahora = Date.now();
    const DIAS_28 = 28 * 24 * 60 * 60 * 1000;
    const DIAS_14 = 14 * 24 * 60 * 60 * 1000;

    for (const [uid, u] of Object.entries(usuariosSnap.val() || {})) {
      if (!u.whatsapp || !u.onboarding_completo || u.pendiente_reactivacion) continue;
      const cSnap = await db.ref(`clientes/${uid}`).get();
      const clientes = cSnap.val() || {};
      for (const [clienteId, cl] of Object.entries(clientes)) {
        const ultimaVisita = cl.memoria?.ultima_visita;
        if (!ultimaVisita) continue;
        const diasSinVenir = Math.floor((ahora - ultimaVisita) / (24 * 60 * 60 * 1000));
        if (diasSinVenir < 28) continue;
        if (cl.reactivacion_sugerida_ts && (ahora - cl.reactivacion_sugerida_ts) < DIAS_14) continue;

        await db.ref(`usuarios/${uid}/pendiente_reactivacion`).set({ clienteId, nombre: cl.nombre, wpp: cl.wpp || null });
        await db.ref(`clientes/${uid}/${clienteId}/reactivacion_sugerida_ts`).set(ahora);
        await enviarWhatsApp(u.whatsapp, `${cl.nombre} no viene hace ${diasSinVenir} días. ¿Le mando una promo? Respondé SÍ para que lo contacte.`, META_ACCESS_TOKEN.value(), META_PHONE_NUMBER_ID.value());
        break; // un cliente por día por dueño, para no saturar
      }
    }
  }
);

// ═══════════════════════════════════════════════
// nublixListaEspera — se dispara cuando un turno pasa a "cancelado"
// avisa al primero en lista de espera para ese horario
// ═══════════════════════════════════════════════
exports.nublixListaEspera = onValueUpdated(
  { ref: '/turnos/{uid}/{turnoId}/estado', secrets: [META_ACCESS_TOKEN, META_PHONE_NUMBER_ID, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY] },
  async (event) => {
    const antes = event.data.before.val();
    const despues = event.data.after.val();
    if (despues !== 'cancelado' || antes === 'cancelado') return;

    const { uid, turnoId } = event.params;
    const db = getDatabase();
    const turnoSnap = await db.ref(`turnos/${uid}/${turnoId}`).get();
    const turno = turnoSnap.val();
    if (!turno?.fecha || !turno?.hora) return;

    const esperaSnap = await db.ref(`listaEspera/${uid}`).get();
    const espera = esperaSnap.val() || {};
    const candidatoEntry = Object.entries(espera)
      .filter(([, e]) => e.fecha === turno.fecha && e.hora === turno.hora && !e.ofrecido)
      .sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0))[0];
    if (!candidatoEntry) return;

    const [listaEsperaId, candidato] = candidatoEntry;
    if (!candidato.wpp) return;

    const fechaTxt = new Date(turno.fecha).toLocaleDateString('es-AR', { day: 'numeric', month: 'short' });
    await db.ref(`coco-data/${candidato.wpp}/pendiente_turno_oferta`).set({
      uid, turnoId, listaEsperaId, nombre: candidato.nombre, fecha: fechaTxt, hora: turno.hora,
    });
    await db.ref(`listaEspera/${uid}/${listaEsperaId}/ofrecido`).set(true);
    await enviarWhatsApp(candidato.wpp, `${candidato.nombre}, se liberó un turno el ${fechaTxt} a las ${turno.hora}. ¿Lo tomás? Respondé SÍ para confirmarlo.`, META_ACCESS_TOKEN.value(), META_PHONE_NUMBER_ID.value());
    await registrarHistorialNublix(db, uid, `Ofrecí el horario libre del ${fechaTxt} a ${candidato.nombre}`, VAPID_PUBLIC_KEY.value(), VAPID_PRIVATE_KEY.value());
  }
);

// ═══════════════════════════════════════════════
// nublixRecordatorioTurnoCliente — cada 15 minutos
// le avisa al cliente por WhatsApp 3hs antes de su turno
// ═══════════════════════════════════════════════
exports.nublixRecordatorioTurnoCliente = onSchedule(
  { schedule: 'every 15 minutes', secrets: [META_ACCESS_TOKEN, META_PHONE_NUMBER_ID, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY] },
  async () => {
    const db = getDatabase();
    const ahora = Date.now();
    const VENTANA_MIN = 15 * 60 * 1000;
    const TRES_HORAS  = 3 * 60 * 60 * 1000;

    const usuariosSnap = await db.ref('usuarios').get();
    for (const uid of Object.keys(usuariosSnap.val() || {})) {
      const [tSnap, cSnap] = await Promise.all([
        db.ref(`turnos/${uid}`).get(),
        db.ref(`clientes/${uid}`).get(),
      ]);
      const turnos   = tSnap.val() || {};
      const clientes = Object.values(cSnap.val() || {});

      for (const [turnoId, t] of Object.entries(turnos)) {
        if (!t.fecha || !t.hora || !t.wpp || t.recordatorio_enviado || t.estado === 'cancelado') continue;
        const [hh, mm] = t.hora.split(':').map(Number);
        const fechaTurno = new Date(t.fecha);
        fechaTurno.setHours(hh || 0, mm || 0, 0, 0);
        const faltan = fechaTurno.getTime() - ahora;
        if (faltan > TRES_HORAS || faltan < TRES_HORAS - VENTANA_MIN) continue;

        const clienteData = clientes.find(c => normalizarTel(c.wpp) === normalizarTel(t.wpp));
        const estilo = clienteData?.estilo_nublix || 'clasico';
        const msg = mensajeRecordatorioTurno(estilo, t.nombre || 'che', t.hora);
        await enviarWhatsApp(t.wpp, msg, META_ACCESS_TOKEN.value(), META_PHONE_NUMBER_ID.value());
        await db.ref(`turnos/${uid}/${turnoId}/recordatorio_enviado`).set(true);
        await registrarHistorialNublix(db, uid, `Envié un recordatorio a ${t.nombre || 'un cliente'}`, VAPID_PUBLIC_KEY.value(), VAPID_PRIVATE_KEY.value());
      }
    }
  }
);

// ═══════════════════════════════════════════════
// nublixCheckVencimientosNegocio — 8am diario Argentina
// avisa al dueño 3 días antes de un vencimiento del negocio
// ═══════════════════════════════════════════════
exports.nublixCheckVencimientosNegocio = onSchedule(
  { schedule: '0 8 * * *', timeZone: 'America/Argentina/Buenos_Aires', secrets: [META_ACCESS_TOKEN, META_PHONE_NUMBER_ID] },
  async () => {
    const db = getDatabase();
    const usuariosSnap = await db.ref('usuarios').get();
    const hoy = new Date();

    for (const [uid, u] of Object.entries(usuariosSnap.val() || {})) {
      if (!u.whatsapp || !u.vencimientos_negocio) continue;
      for (const v of Object.values(u.vencimientos_negocio)) {
        if (!v.dia_mes) continue;
        let proximo = new Date(hoy.getFullYear(), hoy.getMonth(), v.dia_mes);
        if (proximo < hoy) proximo = new Date(hoy.getFullYear(), hoy.getMonth() + 1, v.dia_mes);
        const diasFaltan = Math.round((proximo - hoy) / (24 * 60 * 60 * 1000));
        if (diasFaltan === 3) {
          await enviarWhatsApp(u.whatsapp, `🐾 Ojo: ${v.texto} vence en 3 días (día ${v.dia_mes}).`, META_ACCESS_TOKEN.value(), META_PHONE_NUMBER_ID.value());
        }
      }
    }
  }
);

// ═══════════════════════════════════════════════
// nublixOportunidades — la PWA pide generar oportunidades al abrir la app
// ═══════════════════════════════════════════════
exports.nublixOportunidades = onRequest(
  { secrets: [META_ACCESS_TOKEN, META_PHONE_NUMBER_ID, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY], cors: true },
  async (req, res) => {
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    if (req.method !== 'POST')   return res.sendStatus(405);
    try {
      const { uid } = req.body;
      if (!uid) return res.status(400).json({ ok: false, error: 'Falta uid' });
      const db = getDatabase();
      const nuevas = await generarOportunidadesParaUid(db, uid);
      if (Object.keys(nuevas).length) {
        await db.ref(`usuarios/${uid}/oportunidades`).update(nuevas);
        await aplicarOportunidadesSegunModo(db, uid, nuevas, {
          metaToken: META_ACCESS_TOKEN.value(), metaPhoneId: META_PHONE_NUMBER_ID.value(),
          vapidPublic: VAPID_PUBLIC_KEY.value(), vapidPrivate: VAPID_PRIVATE_KEY.value(),
        });
      }
      const snap = await db.ref(`usuarios/${uid}/oportunidades`).get();
      return res.json({ ok: true, oportunidades: snap.val() || {} });
    } catch(e) {
      console.error('nublixOportunidades', e);
      return res.status(500).json({ ok: false, error: 'Error interno' });
    }
  }
);

// ═══════════════════════════════════════════════
// nublixOportunidadesMediodia — 12pm diario Argentina, para todos los negocios
// ═══════════════════════════════════════════════
exports.nublixOportunidadesMediodia = onSchedule(
  { schedule: '0 12 * * *', timeZone: 'America/Argentina/Buenos_Aires', secrets: [META_ACCESS_TOKEN, META_PHONE_NUMBER_ID, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY] },
  async () => {
    const db = getDatabase();
    const secrets = {
      metaToken: META_ACCESS_TOKEN.value(), metaPhoneId: META_PHONE_NUMBER_ID.value(),
      vapidPublic: VAPID_PUBLIC_KEY.value(), vapidPrivate: VAPID_PRIVATE_KEY.value(),
    };
    const usuariosSnap = await db.ref('usuarios').get();
    for (const [uid, u] of Object.entries(usuariosSnap.val() || {})) {
      if (!u.onboarding_completo) continue;
      try {
        const nuevas = await generarOportunidadesParaUid(db, uid);
        if (Object.keys(nuevas).length) {
          await db.ref(`usuarios/${uid}/oportunidades`).update(nuevas);
          await aplicarOportunidadesSegunModo(db, uid, nuevas, secrets);
        }
      } catch(e) { console.error('nublixOportunidadesMediodia', uid, e); }
    }
  }
);

// ═══════════════════════════════════════════════
// nublixAprendizaje — lunes 5am Argentina, perfil semanal por negocio
// ═══════════════════════════════════════════════
// ═══════════════════════════════════════════════
// nublixGuardarPushSubscription — la PWA guarda su suscripción push
// ═══════════════════════════════════════════════
exports.nublixGuardarPushSubscription = onRequest(
  { cors: true },
  async (req, res) => {
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    if (req.method !== 'POST')   return res.sendStatus(405);
    try {
      const { uid, subscription } = req.body;
      if (!uid || !subscription?.endpoint) return res.status(400).json({ ok: false, error: 'Faltan datos' });
      const db = getDatabase();
      await db.ref(`usuarios/${uid}/push_subscription`).set(subscription);
      return res.json({ ok: true });
    } catch(e) {
      console.error('nublixGuardarPushSubscription', e);
      return res.status(500).json({ ok: false, error: 'Error interno' });
    }
  }
);

exports.nublixAprendizaje = onSchedule(
  { schedule: '0 5 * * 1', timeZone: 'America/Argentina/Buenos_Aires' },
  async () => {
    const db = getDatabase();
    const usuariosSnap = await db.ref('usuarios').get();
    for (const [uid, u] of Object.entries(usuariosSnap.val() || {})) {
      if (!u.onboarding_completo) continue;
      try {
        const perfil = await calcularPerfilNegocio(db, uid);
        if (perfil) await db.ref(`usuarios/${uid}/perfil_negocio`).set(perfil);
      } catch(e) { console.error('nublixAprendizaje', uid, e); }
    }
  }
);

// ═══════════════════════════════════════════════
// nublixActualizarMemoriaClientes — 4am diario Argentina
// recalcula la memoria CRM (clientes/$uid/$cid/memoria) de cada negocio
// a partir de turnos y pagos reales
// ═══════════════════════════════════════════════
exports.nublixActualizarMemoriaClientes = onSchedule(
  { schedule: '0 4 * * *', timeZone: 'America/Argentina/Buenos_Aires' },
  async () => {
    const db = getDatabase();
    const usuariosSnap = await db.ref('usuarios').get();
    for (const [uid, u] of Object.entries(usuariosSnap.val() || {})) {
      if (!u.onboarding_completo) continue;
      try {
        const [cSnap, tSnap, pSnap] = await Promise.all([
          db.ref(`clientes/${uid}`).get(),
          db.ref(`turnos/${uid}`).get(),
          db.ref(`pagos/${uid}`).get(),
        ]);
        const clientesObj = cSnap.val() || {};
        if (!Object.keys(clientesObj).length) continue;
        const turnos = Object.values(tSnap.val() || {});
        const pagos  = Object.values(pSnap.val() || {});

        const gastoPorCliente = {};
        pagos.forEach(p => {
          const n = (p.nombre || p.cliente || '').trim();
          if (n) gastoPorCliente[n] = (gastoPorCliente[n] || 0) + (p.monto || 0);
        });
        const mejoresNombres = Object.entries(gastoPorCliente).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n);

        const conteoServicios = {};
        turnos.forEach(t => { if (t.servicio && t.estado !== 'cancelado') conteoServicios[t.servicio] = (conteoServicios[t.servicio] || 0) + 1; });
        const serviciosOrdenados = Object.entries(conteoServicios).sort((a, b) => b[1] - a[1]).map(([s]) => s);

        const updates = {};
        for (const [cid, cl] of Object.entries(clientesObj)) {
          if (!cl.nombre) continue;
          const nombre = cl.nombre.trim();
          const memoria = calcularMemoriaCliente(nombre, turnos, pagos, mejoresNombres.includes(nombre), serviciosOrdenados);
          if (memoria) updates[`${cid}/memoria`] = memoria;
        }
        if (Object.keys(updates).length) await db.ref(`clientes/${uid}`).update(updates);
      } catch(e) { console.error('nublixActualizarMemoriaClientes', uid, e); }
    }
  }
);

// ═══════════════════════════════════════════════
// nublixContactarHoy — 7am diario Argentina
// genera usuarios/$uid/contactar_hoy/$fecha con cumpleaños, premium ausente
// y cancelaciones sin reagendar. Automático manda solo, Asistente pide aprobación.
// ═══════════════════════════════════════════════
exports.nublixContactarHoy = onSchedule(
  { schedule: '0 7 * * *', timeZone: 'America/Argentina/Buenos_Aires', secrets: [META_ACCESS_TOKEN, META_PHONE_NUMBER_ID, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY] },
  async () => {
    const db = getDatabase();
    const fechaStr = new Date().toISOString().slice(0, 10);
    const secrets = {
      metaToken: META_ACCESS_TOKEN.value(), metaPhoneId: META_PHONE_NUMBER_ID.value(),
      vapidPublic: VAPID_PUBLIC_KEY.value(), vapidPrivate: VAPID_PRIVATE_KEY.value(),
    };
    const usuariosSnap = await db.ref('usuarios').get();
    for (const [uid, u] of Object.entries(usuariosSnap.val() || {})) {
      if (!u.onboarding_completo) continue;
      try {
        const [cSnap, tSnap] = await Promise.all([
          db.ref(`clientes/${uid}`).get(),
          db.ref(`turnos/${uid}`).get(),
        ]);
        const clientesObj = cSnap.val() || {};
        if (!Object.keys(clientesObj).length) continue;
        const turnos = Object.values(tSnap.val() || {});
        const items = detectarContactarHoy(clientesObj, turnos);
        if (!items.length) continue;

        const modo = await obtenerModoCercania(db, uid);
        const refHoy = db.ref(`usuarios/${uid}/contactar_hoy/${fechaStr}`);

        if (modo === 'automatico') {
          for (const item of items) {
            const itemRef = refHoy.push();
            await itemRef.set({ ...item, estado: 'pendiente', ts: Date.now() });
            if (item.wpp && puedeContactarAhora(clientesObj[item.cid])) {
              await enviarWhatsApp(normalizarTel(item.wpp), item.mensaje_sugerido, secrets.metaToken, secrets.metaPhoneId);
              await db.ref(`clientes/${uid}/${item.cid}/contacto_cercania_ts`).set(Date.now());
              await itemRef.update({ estado: 'enviado' });
              await registrarHistorialNublix(db, uid, `Le escribí a ${item.nombre} (${item.motivo === 'cumpleanos' ? 'cumpleaños' : item.motivo === 'premium_inactivo' ? 'cliente premium ausente' : 'turno cancelado sin reagendar'})`, secrets.vapidPublic, secrets.vapidPrivate);
            }
          }
        } else {
          for (const item of items) await refHoy.push({ ...item, estado: 'pendiente', ts: Date.now() });
          await enviarPush(db, uid, secrets.vapidPublic, secrets.vapidPrivate,
            `Tengo ${items.length} persona${items.length === 1 ? '' : 's'} para contactar hoy 🐾`);
        }
      } catch(e) { console.error('nublixContactarHoy', uid, e); }
    }
  }
);

// ═══════════════════════════════════════════════
// nublixAccionContactarHoy — la PWA aprueba, edita u omite un contacto del día
// ═══════════════════════════════════════════════
exports.nublixAccionContactarHoy = onRequest(
  { secrets: [META_ACCESS_TOKEN, META_PHONE_NUMBER_ID, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY], cors: true },
  async (req, res) => {
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    if (req.method !== 'POST')   return res.sendStatus(405);
    try {
      const { uid, fecha, itemId, accion, mensajeEditado } = req.body;
      if (!uid || !fecha || !itemId || !accion) return res.status(400).json({ ok: false, error: 'Faltan datos' });
      const db = getDatabase();
      const itemRef = db.ref(`usuarios/${uid}/contactar_hoy/${fecha}/${itemId}`);
      const itemSnap = await itemRef.get();
      const item = itemSnap.val();
      if (!item) return res.status(404).json({ ok: false, error: 'No encontrado' });

      if (accion === 'omitir') {
        await itemRef.update({ estado: 'omitido' });
        return res.json({ ok: true });
      }

      const mensaje = accion === 'editar' && mensajeEditado ? mensajeEditado : item.mensaje_sugerido;
      if (item.wpp) {
        await enviarWhatsApp(normalizarTel(item.wpp), mensaje, META_ACCESS_TOKEN.value(), META_PHONE_NUMBER_ID.value());
        await db.ref(`clientes/${uid}/${item.cid}/contacto_cercania_ts`).set(Date.now());
        await registrarHistorialNublix(db, uid, `Le escribí a ${item.nombre} (contacto del día)`, VAPID_PUBLIC_KEY.value(), VAPID_PRIVATE_KEY.value());
      }
      await itemRef.update({ estado: 'enviado' });
      return res.json({ ok: true });
    } catch(e) {
      console.error('nublixAccionContactarHoy', e);
      return res.status(500).json({ ok: false, error: 'Error interno' });
    }
  }
);

// ═══════════════════════════════════════════════
// nublixAccionOportunidad — la PWA ejecuta o descarta una oportunidad sugerida
// ═══════════════════════════════════════════════
exports.nublixAccionOportunidad = onRequest(
  { secrets: [META_ACCESS_TOKEN, META_PHONE_NUMBER_ID, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY], cors: true },
  async (req, res) => {
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    if (req.method !== 'POST')   return res.sendStatus(405);
    try {
      const { uid, oportunidadId, ejecutarAccion } = req.body;
      if (!uid || !oportunidadId) return res.status(400).json({ ok: false, error: 'Faltan datos' });

      const db = getDatabase();
      const opSnap = await db.ref(`usuarios/${uid}/oportunidades/${oportunidadId}`).get();
      const op = opSnap.val();
      if (!op) return res.status(404).json({ ok: false, error: 'No encontrada' });

      if (ejecutarAccion !== false) {
        await ejecutarOportunidadInterna(db, uid, oportunidadId, op, {
          metaToken: META_ACCESS_TOKEN.value(), metaPhoneId: META_PHONE_NUMBER_ID.value(),
          vapidPublic: VAPID_PUBLIC_KEY.value(), vapidPrivate: VAPID_PRIVATE_KEY.value(),
        });
      } else {
        await db.ref(`usuarios/${uid}/oportunidades/${oportunidadId}`).remove();
      }
      return res.json({ ok: true });
    } catch(e) {
      console.error('nublixAccionOportunidad', e);
      return res.status(500).json({ ok: false, error: 'Error interno' });
    }
  }
);