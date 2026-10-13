#!/usr/bin/env node
// CareDesk CRM WhatsApp QR Bridge.
// Links your WhatsApp (via QR scan or 8-digit pairing code) to https://hhcs-caredesk.secondmedic.workers.dev/whatsapp
// so incoming and outgoing WhatsApp chats work live inside CareDesk CRM.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const ROOT = resolve(process.cwd());
const BRIDGE_DIR = join(ROOT, '.whatsapp-bridge');
const AUTH_DIR = join(BRIDGE_DIR, 'auth');
const CFG_FILE = join(BRIDGE_DIR, 'config.json');

mkdirSync(BRIDGE_DIR, { recursive: true });

const PID_FILE = join(BRIDGE_DIR, 'bridge.pid');
if (existsSync(PID_FILE)) {
  try {
    const oldPid = parseInt(readFileSync(PID_FILE, 'utf8'), 10);
    if (oldPid && !isNaN(oldPid) && oldPid !== process.pid) {
      try {
        process.kill(oldPid, 0);
        console.log(`[WhatsApp Bridge] Central bridge is already running in background (PID ${oldPid}). Exiting duplicate.`);
        process.exit(0);
      } catch {
        // Stale PID file
      }
    }
  } catch {}
}
try { writeFileSync(PID_FILE, String(process.pid)); } catch {}
const cleanupPid = () => {
  try {
    if (existsSync(PID_FILE) && parseInt(readFileSync(PID_FILE, 'utf8'), 10) === process.pid) {
      rmSync(PID_FILE, { force: true });
    }
  } catch {}
};
process.on('exit', cleanupPid);
process.on('SIGINT', () => { cleanupPid(); process.exit(0); });
process.on('SIGTERM', () => { cleanupPid(); process.exit(0); });

function ensurePackages() {
  const pkgJson = join(BRIDGE_DIR, 'package.json');
  if (!existsSync(pkgJson)) {
    writeFileSync(pkgJson, JSON.stringify({ name: 'caredesk-whatsapp-bridge', private: true, type: 'module' }, null, 2));
  }
  const baileysPath = join(BRIDGE_DIR, 'node_modules', '@whiskeysockets', 'baileys');
  const qrPath = join(BRIDGE_DIR, 'node_modules', 'qrcode');
  if (!existsSync(baileysPath) || !existsSync(qrPath)) {
    console.log('[WhatsApp Bridge] Installing WhatsApp multi-device engine (first-time setup)...');
    execSync('npm install --prefix ".whatsapp-bridge" --no-audit --no-fund @whiskeysockets/baileys@6.7.16 qrcode@1.5.4 pino@9.6.0', {
      cwd: ROOT,
      stdio: 'inherit',
    });
  }
}

ensurePackages();

const requireFromBridge = createRequire(join(BRIDGE_DIR, 'package.json'));
const baileys = requireFromBridge('@whiskeysockets/baileys');
const QRCode = requireFromBridge('qrcode');
const pino = requireFromBridge('pino');

const makeWASocket = baileys.default?.default || baileys.default || baileys.makeWASocket;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, fetchLatestWaWebVersion, Browsers } = baileys;

function loadConfig() {
  let saved = {};
  if (existsSync(CFG_FILE)) {
    try { saved = JSON.parse(readFileSync(CFG_FILE, 'utf8')); } catch { saved = {}; }
  }
  const url = (process.env.CAREDESK_URL || saved.url || 'https://hhcs-caredesk.secondmedic.workers.dev').replace(/\/$/, '');
  const key = process.env.CAREDESK_BRIDGE_KEY || process.env.MYOPERATOR_WEBHOOK_KEY || saved.key || '';
  if (key && (saved.url !== url || saved.key !== key)) {
    writeFileSync(CFG_FILE, JSON.stringify({ url, key }, null, 2));
  }
  return { url, key };
}

const { url: BASE_URL, key: BRIDGE_KEY } = loadConfig();
if (!BRIDGE_KEY) {
  console.error('[WhatsApp Bridge] Missing CAREDESK_BRIDGE_KEY. Run WHATSAPP-CONNECT.bat or set CAREDESK_BRIDGE_KEY.');
  process.exit(1);
}

const WEBHOOK_URL = `${BASE_URL}/webhooks/myoperator?bridge=whatsapp_qr`;

let state = {
  status: 'starting',
  qr_svg: null,
  pairing_code: null,
  phone: null,
  name: null,
  error: null,
};

let sock = null;
let starting = false;
let contactNames = new Map();
let recentMessages = [];
let pendingSyncQueue = [];
const sentMessageIds = new Set();

function jidToPhone(jid) {
  if (!jid || typeof jid !== 'string') return null;
  if (jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return null;
  const user = jid.split('@')[0].split(':')[0].replace(/\D/g, '');
  if (!user || user.length < 10 || user.length > 15) return null;
  if (user.length === 10 && /^[6-9]/.test(user)) return `+91${user}`;
  return `+${user}`;
}

function phoneToJid(mobile) {
  const d = String(mobile || '').replace(/\D/g, '');
  if (!d) return null;
  const full = d.length === 10 ? `91${d}` : d.length === 11 && d.startsWith('0') ? `91${d.slice(1)}` : d;
  return `${full}@s.whatsapp.net`;
}

function extractText(msg) {
  const m = msg?.message;
  if (!m) return '';
  const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || m.documentWithCaptionMessage?.message || m;
  return (
    inner.conversation ||
    inner.extendedTextMessage?.text ||
    inner.imageMessage?.caption ||
    inner.videoMessage?.caption ||
    inner.documentMessage?.caption ||
    inner.buttonsResponseMessage?.selectedDisplayText ||
    inner.listResponseMessage?.title ||
    inner.templateButtonReplyMessage?.selectedDisplayText ||
    ''
  ).trim();
}

async function postBridge(payload) {
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-key': BRIDGE_KEY,
        'x-whatsapp-bridge': '1',
      },
      body: JSON.stringify({ bridge: 'whatsapp_qr', ...payload }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.error(`[WhatsApp Bridge] Server returned ${res.status}: ${txt.slice(0, 160)}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.error('[WhatsApp Bridge] Network error:', e.message);
    return null;
  }
}

function queueMessagesForSync(rawList, historical) {
  for (const m of rawList || []) {
    if (!m?.key) continue;
    const id = m.key.id;
    if (!id || sentMessageIds.has(id)) continue;
    const remoteJid = m.key.remoteJidAlt || m.key.remoteJid;
    const mobile = jidToPhone(remoteJid);
    if (!mobile) continue;
    const text = extractText(m);
    if (!text) continue;
    const fromMe = !!m.key.fromMe;
    const pushName = (!fromMe && m.pushName) ? String(m.pushName).trim() : null;
    if (pushName) contactNames.set(mobile, pushName);
    const name = contactNames.get(mobile) || pushName || mobile;
    const tsRaw = m.messageTimestamp;
    const timestamp = typeof tsRaw === 'number' ? tsRaw : Number(tsRaw?.low || tsRaw || Math.floor(Date.now() / 1000));
    const item = {
      id,
      mobile,
      name,
      direction: fromMe ? 'outbound' : 'inbound',
      text,
      timestamp,
      historical: !!historical,
    };
    pendingSyncQueue.push(item);
    recentMessages.push(item);
    if (recentMessages.length > 150) recentMessages.shift();
  }
}

async function flushSyncQueue() {
  while (pendingSyncQueue.length > 0) {
    const batch = pendingSyncQueue.splice(0, 35);
    const res = await postBridge({ action: 'sync_messages', messages: batch });
    if (res?.imported) {
      console.log(`[WhatsApp Bridge] Synced ${res.imported} WhatsApp message(s) to CareDesk CRM.`);
    }
  }
}

let lastSocketStartAt = 0;

async function startSocket(resetAuth = false) {
  if (starting) return;
  starting = true;
  lastSocketStartAt = Date.now();
  try {
    if (sock) {
      const old = sock;
      sock = null;
      try { old.ev.removeAllListeners(); old.end(undefined); } catch {}
    }
    if (resetAuth && existsSync(AUTH_DIR)) {
      rmSync(AUTH_DIR, { recursive: true, force: true });
    }
    mkdirSync(AUTH_DIR, { recursive: true });
    const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let version = [2, 3000, 1050037037];
    try {
      const w = await (fetchLatestWaWebVersion ? fetchLatestWaWebVersion() : fetchLatestBaileysVersion());
      if (w?.version) version = w.version;
    } catch {}

    state.status = 'starting';
    state.error = null;

    const currentSock = makeWASocket({
      version,
      auth: authState,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      markOnlineOnConnect: false,
    });
    sock = currentSock;

    currentSock.ev.on('creds.update', saveCreds);

    currentSock.ev.on('contacts.upsert', (contacts) => {
      for (const c of contacts || []) {
        const phone = jidToPhone(c.id);
        const label = c.notify || c.name || c.verifiedName;
        if (phone && label) contactNames.set(phone, String(label).trim());
      }
    });

    currentSock.ev.on('messaging-history.set', ({ contacts, messages }) => {
      for (const c of contacts || []) {
        const phone = jidToPhone(c.id);
        const label = c.notify || c.name || c.verifiedName;
        if (phone && label) contactNames.set(phone, String(label).trim());
      }
      const recent = (messages || []).slice(-80);
      queueMessagesForSync(recent, true);
      flushSyncQueue().catch(() => {});
    });

    currentSock.ev.on('messages.upsert', ({ messages, type }) => {
      queueMessagesForSync(messages, type !== 'notify');
      flushSyncQueue().catch(() => {});
    });

    currentSock.ev.on('connection.update', async (update) => {
      if (sock !== currentSock) return;
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        try {
          const svg = await QRCode.toString(qr, { type: 'svg', margin: 1, width: 220 });
          state.status = 'qr_ready';
          state.qr_svg = svg;
          state.error = null;
          console.log('[WhatsApp Bridge] New QR code ready on https://hhcs-caredesk.secondmedic.workers.dev/whatsapp');
          await postBridge({ action: 'poll', ...state });
        } catch (e) {
          console.error('[WhatsApp Bridge] QR generation error:', e.message);
        }
      }
      if (connection === 'open') {
        const mePhone = jidToPhone(currentSock.user?.id) || currentSock.user?.id?.split(':')[0] || 'Linked';
        const meName = currentSock.user?.name || 'Hinduja Home Care';
        state.status = 'connected';
        state.qr_svg = null;
        state.pairing_code = null;
        state.phone = mePhone;
        state.name = meName;
        state.error = null;
        console.log(`[WhatsApp Bridge] Connected to WhatsApp as ${mePhone} (${meName})`);
        await postBridge({ action: 'poll', ...state });
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut || code === 401;
        console.log(`[WhatsApp Bridge] Connection closed (code=${code}, loggedOut=${loggedOut}). Reconnecting...`);
        state.status = 'starting';
        state.qr_svg = null;
        setTimeout(() => startSocket(loggedOut), loggedOut ? 1500 : 3000);
      }
    });
  } finally {
    starting = false;
  }
}

async function handleOutbox(outbox) {
  if (!sock || state.status !== 'connected' || !Array.isArray(outbox) || outbox.length === 0) return;
  for (const item of outbox) {
    const jid = phoneToJid(item.mobile);
    if (!jid || !item.body) {
      await postBridge({ action: 'ack', id: item.id, status: 'failed', error: 'Invalid mobile number or empty message' });
      continue;
    }
    try {
      const sent = await sock.sendMessage(jid, { text: String(item.body) });
      const msgId = sent?.key?.id || null;
      if (msgId) sentMessageIds.add(msgId);
      await postBridge({ action: 'ack', id: item.id, status: 'sent', message_id: msgId });
      console.log(`[WhatsApp Bridge] Sent message to ${item.mobile}`);
    } catch (e) {
      console.error(`[WhatsApp Bridge] Failed to send to ${item.mobile}:`, e.message);
      await postBridge({ action: 'ack', id: item.id, status: 'failed', error: e.message });
    }
  }
}

async function pollLoop() {
  const res = await postBridge({ action: 'poll', ...state });
  if (!res) return;

  if (res.command === 'logout') {
    console.log('[WhatsApp Bridge] Received logout command from CareDesk CRM.');
    try { await sock?.logout(); } catch {}
    state = { status: 'starting', qr_svg: null, pairing_code: null, phone: null, name: null, error: null };
    await startSocket(true);
    return;
  }

  if (res.command === 'start') {
    const pairPhone = res.command_meta?.phone_number;
    if (pairPhone && sock && state.status !== 'connected') {
      try {
        const digits = String(pairPhone).replace(/\D/g, '');
        const full = digits.length === 10 ? `91${digits}` : digits;
        const code = await sock.requestPairingCode(full);
        state.pairing_code = code;
        await postBridge({ action: 'poll', ...state });
      } catch (e) {
        state.error = 'Could not request pairing code: ' + e.message;
      }
    } else if (state.status !== 'connected' && (!sock || Date.now() - lastSocketStartAt > 25000)) {
      await startSocket(false);
    }
  }

  if (res.command === 'sync') {
    if (recentMessages.length > 0) {
      pendingSyncQueue.push(...recentMessages);
      await flushSyncQueue();
    }
  }

  if (Array.isArray(res.outbox) && res.outbox.length > 0) {
    await handleOutbox(res.outbox);
  }
}

console.log(`[WhatsApp Bridge] Connecting to CareDesk CRM at ${BASE_URL}...`);
await startSocket(false);
await pollLoop();
setInterval(() => {
  pollLoop().catch((e) => console.error('[WhatsApp Bridge] Poll error:', e.message));
}, 2500);

