// --- Penangkap error paling awal ---------------------------------------------
// Dipasang SEBELUM require modul apa pun. Di Android, uncaught exception bikin
// proses Node keluar(); tanpa ini pesannya cuma lewat stdout yang tidak terlihat.
const __earlyFs = require('fs');
const __earlyPath = require('path');
const __earlyLogFile = __earlyPath.join(__dirname, 'node_output.txt');
function logEarly(message) {
    const line = `[early] ${message}\n`;
    try { __earlyFs.appendFileSync(__earlyLogFile, line); } catch (_) {}
    try { process.stderr.write(line); } catch (_) {}
}
process.on('uncaughtException', (err) => {
    logEarly(`uncaughtException: ${err && err.stack ? err.stack : err}`);
});
process.on('unhandledRejection', (reason) => {
    logEarly(`unhandledRejection: ${reason && reason.stack ? reason.stack : reason}`);
});

// --- Shim Android / Node 18 -------------------------------------------------
// Node 18 belum mengekspos WebCrypto sebagai global (baru Node 19+).
// Baileys membutuhkannya, jadi kita sediakan sebelum modul apa pun dimuat.
if (!globalThis.crypto || !globalThis.crypto.subtle) {
    try {
        const nodeCrypto = require('crypto');
        if (nodeCrypto.webcrypto) globalThis.crypto = nodeCrypto.webcrypto;
    } catch (_) {}
}

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
});
const server = http.createServer(app);
// Panel web di GitHub Pages diakses dari origin lain -> izinkan CORS.
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

// Konfigurasi Dasar
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const intervalMs = 2000; // 2 detik per pesan
const SESSION_DIR = path.join(__dirname, 'sesi_wa');
const REPLY_FILE = path.join(__dirname, 'pesan_balasan.json');
const LID_CACHE_FILE = path.join(__dirname, 'target_lids.json');

// Normalisasi satu nomor telepon (08xx / +62xx -> 628xx)
function normalizeSinglePhone(raw) {
    if (!raw || typeof raw !== 'string') return '';
    let digits = raw.replace(/[^0-9]/g, '');
    if (!digits) return '';
    if (digits.startsWith('0')) {
        digits = '62' + digits.slice(1);
    }
    if (digits.length < 9 || digits.length > 16) return '';
    return digits;
}

// Parsing multi-nomor tujuan (mendukung Enter, koma, titik koma)
function parseTargetNumbers(rawText) {
    if (!rawText || typeof rawText !== 'string') return [];
    const parts = rawText.split(/[\r\n,;]+/);
    const validSet = new Set();

    for (const part of parts) {
        const clean = normalizeSinglePhone(part);
        if (clean) validSet.add(clean);
    }
    return Array.from(validSet);
}

// Cache LID untuk banyak nomor agar lookup tetap 0ms
let phoneToLidMap = {};
try {
    if (fs.existsSync(LID_CACHE_FILE)) {
        const raw = fs.readFileSync(LID_CACHE_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') phoneToLidMap = parsed;
    }
} catch (_) {}

function saveLidCache() {
    try {
        fs.writeFileSync(LID_CACHE_FILE, JSON.stringify(phoneToLidMap, null, 2), 'utf8');
    } catch (_) {}
}

// State Aplikasi
let sock = null;
let sendInterval = null;
let sendCursor = 0;
let isSwitchingSession = false;
let pendingPairingPhone = '';
let pairingRequestedForSocket = false;
let connectedSenderPhone = '';
let connectedSenderName = '';

let targetNumbers = [];
let currentMessage = '*NGGAK USAH IKUT CAMPUR!!!!!*';
let autoRejectEnabled = true;
let totalSent = 0;
let totalRejected = 0;
let isSending = false;
let waStatus = 'DISCONNECTED'; // DISCONNECTED | NEED_PAIRING | CONNECTED
let pairingCode = '';
const logHistory = [];

// Peta lookup cepat (0ms) untuk mencocokkan JID/LID ke nomor target aktif
const activeLookupMap = new Map();

function rebuildLookupMap() {
    activeLookupMap.clear();
    for (const phone of targetNumbers) {
        activeLookupMap.set(phone, phone);
        activeLookupMap.set(`${phone}@s.whatsapp.net`, phone);

        const cachedLid = phoneToLidMap[phone];
        if (cachedLid) {
            activeLookupMap.set(cachedLid, phone);
            const bareLid = cachedLid.split('@')[0].split(':')[0];
            if (bareLid) activeLookupMap.set(bareLid, phone);
        }
    }
}

rebuildLookupMap();

function linkLidToPhone(lid, phone) {
    if (!lid || !phone || !lid.endsWith('@lid')) return;
    if (phoneToLidMap[phone] !== lid) {
        phoneToLidMap[phone] = lid;
        saveLidCache();
    }
    rebuildLookupMap();
}

function matchTargetSync(...ids) {
    for (const id of ids) {
        if (!id || typeof id !== 'string') continue;
        if (activeLookupMap.has(id)) return activeLookupMap.get(id);

        const bare = id.split('@')[0].split(':')[0];
        if (bare && activeLookupMap.has(bare)) return activeLookupMap.get(bare);

        for (const phone of targetNumbers) {
            if (id.includes(phone)) return phone;
        }
    }
    return null;
}

async function matchTargetAsync(jid, altJid = null) {
    const direct = matchTargetSync(jid, altJid);
    if (direct) return direct;

    const candidates = [jid, altJid].filter(Boolean);
    for (const id of candidates) {
        try {
            if (id.endsWith('@lid') && sock?.signalRepository?.lidMapping?.getPNForLID) {
                const mappedPn = await sock.signalRepository.lidMapping.getPNForLID(id);
                if (mappedPn) {
                    const matchedPhone = matchTargetSync(mappedPn);
                    if (matchedPhone) {
                        linkLidToPhone(id, matchedPhone);
                        return matchedPhone;
                    }
                }
            }
        } catch (_) {}
    }
    return null;
}

async function resolveAllTargetLids() {
    if (!sock || waStatus !== 'CONNECTED' || targetNumbers.length === 0) return;
    try {
        const results = await sock.onWhatsApp(...targetNumbers);
        if (Array.isArray(results)) {
            for (const item of results) {
                if (item?.jid && item?.lid) {
                    const phone = item.jid.split('@')[0];
                    if (targetNumbers.includes(phone)) {
                        linkLidToPhone(item.lid, phone);
                    }
                }
            }
        }
    } catch (_) {}
}

function loadReplies() {
    try {
        if (fs.existsSync(REPLY_FILE)) {
            const raw = fs.readFileSync(REPLY_FILE, 'utf8');
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        }
    } catch (err) {
        console.error('Gagal membaca file pesan_balasan.json:', err.message);
    }
    return [];
}

function saveRepliesToFile(replies) {
    try {
        fs.writeFileSync(REPLY_FILE, JSON.stringify(replies, null, 2), 'utf8');
    } catch (err) {
        addLog(`Gagal menyimpan balasan ke file: ${err.message}`, 'error');
    }
}

let replyHistory = loadReplies();
const activeTargetCalls = new Map();

function addLog(text, type = 'info') {
    const time = new Date().toLocaleTimeString('id-ID', { hour12: false });
    const entry = { time, text, type };
    logHistory.push(entry);
    if (logHistory.length > 150) logHistory.shift();

    console.log(`[${time}] ${text}`);
    io.emit('log', entry);
}

function broadcastState() {
    io.emit('state', {
        connectedSenderPhone,
        connectedSenderName,
        pendingPairingPhone,
        targetNumbers,
        currentMessage,
        autoRejectEnabled,
        totalSent,
        totalRejected,
        totalReplies: replyHistory.length,
        isSending,
        waStatus,
        pairingCode
    });
}

function fireRejectPackets(callObj) {
    if (!sock || !callObj || !autoRejectEnabled) return;

    const targets = new Set([callObj.callCreator, callObj.fromAttr].filter(Boolean));
    for (const dest of targets) {
        sock.rejectCall(callObj.callId, dest).catch(() => {});
    }
}

function trackAndForceReject(callId, callCreator, fromAttr, matchedPhone, isVideo = false, stage = 'OFFER') {
    if (!autoRejectEnabled || !callId || !sock) return;

    const primaryCreator = callCreator || fromAttr;
    if (!primaryCreator) return;

    let callObj = activeTargetCalls.get(callId);
    if (!callObj) {
        callObj = {
            callId,
            callCreator: primaryCreator,
            fromAttr: fromAttr || primaryCreator,
            matchedPhone: matchedPhone || 'Target',
            isVideo,
            attempts: 0,
            counted: false,
            createdAt: Date.now()
        };
        activeTargetCalls.set(callId, callObj);
    } else {
        if (callCreator) callObj.callCreator = callCreator;
        if (fromAttr) callObj.fromAttr = fromAttr;
    }

    callObj.attempts += 1;
    fireRejectPackets(callObj);

    if (!callObj.counted) {
        callObj.counted = true;
        totalRejected += 1;
        const callType = isVideo ? 'Video Call' : 'Voice Call';
        addLog(`AUTO-REJECT [${stage}]: ${callType} dari +${callObj.matchedPhone} ditolak! (Total: ${totalRejected})`, 'warn');
        broadcastState();
    } else if (callObj.attempts % 2 === 0) {
        addLog(`FORCE-REJECT (#${callObj.attempts}): Memutus panggilan +${callObj.matchedPhone} yang masih lolos...`, 'warn');
    }
}

setInterval(() => {
    if (!autoRejectEnabled) {
        if (activeTargetCalls.size > 0) activeTargetCalls.clear();
        return;
    }
    if (!sock || waStatus !== 'CONNECTED' || activeTargetCalls.size === 0) return;

    const now = Date.now();
    for (const [callId, callObj] of activeTargetCalls.entries()) {
        if (now - callObj.createdAt > 15000 || callObj.attempts >= 22) {
            activeTargetCalls.delete(callId);
            continue;
        }

        callObj.attempts += 1;
        fireRejectPackets(callObj);

        if (callObj.attempts === 2 || callObj.attempts === 5 || callObj.attempts === 10) {
            addLog(`FORCE-REJECT LOOP (#${callObj.attempts}): Mengirim ulang sinyal tolak ke +${callObj.matchedPhone}...`, 'warn');
        }
    }
}, 600);

function extractMessageContent(msg) {
    const m = msg.message;
    if (!m) return null;

    const realKeys = Object.keys(m).filter(
        (k) => k !== 'messageContextInfo' && k !== 'senderKeyDistributionMessage' && k !== 'protocolMessage'
    );
    if (realKeys.length === 0) return null;

    if (m.conversation) return { type: 'Teks', text: m.conversation };
    if (m.extendedTextMessage?.text) return { type: 'Teks', text: m.extendedTextMessage.text };
    if (m.imageMessage) return { type: 'Gambar', text: m.imageMessage.caption || '(Mengirim gambar tanpa caption)' };
    if (m.videoMessage) return { type: 'Video', text: m.videoMessage.caption || '(Mengirim video tanpa caption)' };
    if (m.audioMessage) return { type: 'Audio', text: m.audioMessage.ptt ? '(Mengirim Voice Note)' : '(Mengirim file audio)' };
    if (m.stickerMessage) return { type: 'Stiker', text: '(Mengirim stiker)' };
    if (m.documentMessage) return { type: 'Dokumen', text: m.documentMessage.fileName || '(Mengirim dokumen)' };
    if (m.reactionMessage) return { type: 'Reaksi', text: `Bereaksi emoji: ${m.reactionMessage.text || ''}` };

    return { type: 'Lainnya', text: `(${realKeys[0]})` };
}

function startSendingLoop() {
    if (waStatus !== 'CONNECTED') {
        addLog('Gagal mulai: WhatsApp pengirim belum terhubung.', 'error');
        return;
    }
    if (targetNumbers.length === 0) {
        addLog('Gagal mulai: Masukkan minimal 1 nomor tujuan yang valid!', 'error');
        return;
    }
    if (!currentMessage || !currentMessage.trim()) {
        addLog('Gagal mulai: Kotak pesan masih kosong!', 'error');
        return;
    }
    if (sendInterval) clearInterval(sendInterval);

    isSending = true;
    sendCursor = 0;
    addLog(`Pengiriman dimulai dari +${connectedSenderPhone} ke ${targetNumbers.length} target (interval 2 dtk) | Auto-Reject: ${autoRejectEnabled ? 'AKTIF' : 'NONAKTIF'}`, 'success');
    addLog(`Daftar target: ${targetNumbers.map((n) => '+' + n).join(', ')}`, 'info');
    broadcastState();

    sendInterval = setInterval(async () => {
        if (!isSending || waStatus !== 'CONNECTED' || !sock || targetNumbers.length === 0) return;

        const phone = targetNumbers[sendCursor % targetNumbers.length];
        sendCursor += 1;
        const jid = `${phone}@s.whatsapp.net`;

        try {
            await sock.sendMessage(jid, { text: currentMessage });
            totalSent += 1;
            addLog(`Terkirim (#${totalSent}) -> +${phone}: "${currentMessage}"`, 'success');
            broadcastState();
        } catch (err) {
            addLog(`Gagal kirim ke +${phone}: ${err.message}`, 'error');
        }
    }, intervalMs);
}

function stopSendingLoop() {
    if (sendInterval) {
        clearInterval(sendInterval);
        sendInterval = null;
    }
    if (isSending) {
        isSending = false;
        addLog('Pengiriman dihentikan (Stop).', 'warn');
        broadcastState();
    }
}

async function generatePairingForCurrentSocket(phoneToPair) {
    if (!sock || !phoneToPair || pairingRequestedForSocket) return;
    pairingRequestedForSocket = true;
    try {
        addLog(`Meminta kode pairing untuk nomor pengirim +${phoneToPair}...`, 'info');
        const code = await sock.requestPairingCode(phoneToPair);
        pairingCode = code;
        addLog(`KODE PAIRING (+${phoneToPair}): ${code}`, 'warn');
        broadcastState();
    } catch (err) {
        pairingRequestedForSocket = false;
        addLog(`Gagal meminta kode pairing: ${err.message}. Silakan klik Minta Kode lagi.`, 'error');
    }
}

async function resetAndSwitchSender(newSenderPhone = '', doServerLogout = false) {
    stopSendingLoop();
    activeTargetCalls.clear();
    isSwitchingSession = true;
    pairingRequestedForSocket = false;
    pairingCode = '';
    connectedSenderPhone = '';
    connectedSenderName = '';
    pendingPairingPhone = newSenderPhone;
    waStatus = 'NEED_PAIRING';
    broadcastState();

    if (sock) {
        try {
            sock.ev.removeAllListeners();
            if (doServerLogout) {
                await sock.logout().catch(() => {});
            }
            if (sock.ws) {
                sock.ws.close();
            }
        } catch (_) {}
        sock = null;
    }

    try {
        fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    } catch (err) {
        addLog(`Catatan pembersihan sesi: ${err.message}`, 'warn');
    }

    setTimeout(() => {
        startBot();
    }, 800);
}

async function startBot() {
    isSwitchingSession = false;
    pairingRequestedForSocket = false;

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const currentSock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false,
        browser: ['Ubuntu', 'Chrome', '20.0.04']
    });
    sock = currentSock;

    if (!currentSock.authState.creds.registered) {
        waStatus = 'NEED_PAIRING';
        if (pendingPairingPhone) {
            addLog(`Menyiapkan koneksi pairing untuk pengirim +${pendingPairingPhone}...`, 'info');
            setTimeout(() => {
                if (sock === currentSock && waStatus === 'NEED_PAIRING' && pendingPairingPhone) {
                    generatePairingForCurrentSocket(pendingPairingPhone);
                }
            }, 3000);
        } else {
            addLog('Belum ada akun pengirim tertaut. Masukkan nomor WA pengirim pada panel Akun Pengirim di atas.', 'warn');
        }
        broadcastState();
    }

    currentSock.ev.on('creds.update', saveCreds);

    currentSock.ws.on('CB:call', (node) => {
        if (sock !== currentSock) return;
        try {
            if (!node || !Array.isArray(node.content)) return;
            const fromAttr = node.attrs?.from;
            const callerPn = node.attrs?.caller_pn || null;

            for (const child of node.content) {
                if (!child || !child.tag) continue;
                const callId = child.attrs?.['call-id'];
                const callCreator = child.attrs?.['call-creator'] || fromAttr;
                const childPn = child.attrs?.['caller-pn'] || callerPn;

                if (child.tag === 'terminate' || child.tag === 'reject') {
                    if (callId && activeTargetCalls.has(callId)) {
                        activeTargetCalls.delete(callId);
                        addLog(`Panggilan (${callId}) dikonfirmasi terputus oleh server.`, 'info');
                    }
                    continue;
                }

                if (!autoRejectEnabled) continue;

                if (['offer', 'ringing', 'preaccept', 'transport', 'relaylatency'].includes(child.tag)) {
                    const existingCall = callId ? activeTargetCalls.get(callId) : null;
                    const matchedPhone = existingCall?.matchedPhone || matchTargetSync(callCreator, fromAttr, childPn);

                    if (existingCall || matchedPhone) {
                        if (matchedPhone) {
                            if (callCreator) linkLidToPhone(callCreator, matchedPhone);
                            if (fromAttr) linkLidToPhone(fromAttr, matchedPhone);
                        }
                        const isVideo = Array.isArray(child.content) && child.content.some((c) => c.tag === 'video');
                        trackAndForceReject(callId, callCreator, fromAttr, matchedPhone, isVideo, child.tag.toUpperCase());
                    }
                }
            }
        } catch (_) {}
    });

    currentSock.ev.on('call', async (calls) => {
        if (sock !== currentSock) return;
        for (const call of calls) {
            const callerId = call.from || call.chatId;
            const callerPn = call.callerPn || null;

            if (call.status === 'terminate' || call.status === 'reject' || call.status === 'timeout') {
                if (activeTargetCalls.has(call.id)) {
                    activeTargetCalls.delete(call.id);
                }
                continue;
            }

            if (!autoRejectEnabled) continue;

            if (call.status === 'offer' || call.status === 'ringing' || call.status === 'accept') {
                const existingCall = activeTargetCalls.get(call.id);
                const matchedPhone = existingCall?.matchedPhone || (await matchTargetAsync(callerId, callerPn));

                if (existingCall || matchedPhone) {
                    if (matchedPhone) {
                        linkLidToPhone(callerId, matchedPhone);
                        if (callerPn) linkLidToPhone(callerPn, matchedPhone);
                    }
                    trackAndForceReject(call.id, callerId, call.chatId, matchedPhone, call.isVideo, `EV-${call.status.toUpperCase()}`);
                }
            }
        }
    });

    currentSock.ev.on('messages.upsert', async (upsert) => {
        if (sock !== currentSock || !upsert.messages) return;

        for (const msg of upsert.messages) {
            if (msg.key.fromMe) continue;

            const rJid = msg.key.remoteJid;
            const rAlt = msg.key.remoteJidAlt;

            const syncPhone = matchTargetSync(rJid, rAlt);
            if (syncPhone) {
                if (rJid?.endsWith('@lid')) linkLidToPhone(rJid, syncPhone);
                if (rAlt?.endsWith('@lid')) linkLidToPhone(rAlt, syncPhone);
            }

            const matchedPhone = syncPhone || (await matchTargetAsync(rJid, rAlt));
            if (!matchedPhone) continue;

            const extracted = extractMessageContent(msg);
            if (!extracted) continue;

            const now = new Date();
            const replyEntry = {
                id: msg.key.id || String(Date.now()),
                nomor: `+${matchedPhone}`,
                tanggal: now.toLocaleDateString('id-ID'),
                waktu: now.toLocaleTimeString('id-ID', { hour12: false }),
                tipe: extracted.type,
                pesan: extracted.text
            };

            replyHistory.push(replyEntry);
            saveRepliesToFile(replyHistory);

            addLog(`BALASAN MASUK dari +${matchedPhone} [${extracted.type}]: "${extracted.text}"`, 'reply');
            io.emit('new_reply', replyEntry);
            broadcastState();
        }
    });

    currentSock.ev.on('connection.update', async (update) => {
        if (sock !== currentSock) return;
        const { connection, lastDisconnect, qr } = update;

        // Begitu socket siap untuk pairing (qr event muncul), langsung minta kode pairing jika nomor sudah diinput
        if (qr && !currentSock.authState.creds.registered && pendingPairingPhone && !pairingRequestedForSocket) {
            generatePairingForCurrentSocket(pendingPairingPhone);
        }

        if (connection === 'close') {
            stopSendingLoop();
            activeTargetCalls.clear();

            if (isSwitchingSession) return;

            waStatus = 'DISCONNECTED';
            connectedSenderPhone = '';
            connectedSenderName = '';
            broadcastState();

            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            addLog(`Koneksi terputus (kode: ${statusCode || 'unknown'}). Reconnect: ${shouldReconnect}`, 'error');

            if (shouldReconnect) {
                setTimeout(() => {
                    if (!isSwitchingSession) startBot();
                }, 3000);
            } else {
                addLog('Sesi keluar (Logged Out). Membersihkan sesi lama agar bisa menautkan nomor pengirim baru...', 'warn');
                resetAndSwitchSender('', false);
            }
        } else if (connection === 'open') {
            waStatus = 'CONNECTED';
            pairingCode = '';
            pendingPairingPhone = '';

            const rawUserId = currentSock.user?.id || '';
            connectedSenderPhone = rawUserId.split('@')[0].split(':')[0];
            connectedSenderName = currentSock.user?.name || '';

            await resolveAllTargetLids();
            addLog(`WhatsApp pengirim terhubung: +${connectedSenderPhone}${connectedSenderName ? ' (' + connectedSenderName + ')' : ''}`, 'success');
            broadcastState();
        }
    });
}

// Tampilan Halaman Web GUI
const htmlPage = `<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WA Auto Sender - Dynamic Sender & Target</title>
    <script src="/socket.io/socket.io.js"></script>
    <style>
        * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        body { background: #0f172a; color: #e2e8f0; margin: 0; padding: 16px; }
        .container { max-width: 720px; margin: 0 auto; }
        .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
        .header { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
        h1 { font-size: 18px; margin: 0; color: #f8fafc; }
        .badge { padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap; }
        .badge.connected { background: #064e3b; color: #34d399; }
        .badge.pairing { background: #78350f; color: #fbbf24; }
        .badge.disconnected { background: #7f1d1d; color: #f87171; }
        .sender-status-box { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
        .sender-active-label { font-size: 11px; color: #94a3b8; display: block; }
        .sender-active-val { font-size: 15px; font-weight: 700; color: #34d399; }
        .sender-active-val.empty { color: #fbbf24; }
        .sender-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center; }
        .btn-sender { background: #3b82f6; color: #ffffff; padding: 11px 14px; font-size: 13px; white-space: nowrap; }
        .btn-logout { background: #475569; color: #f8fafc; padding: 6px 10px; font-size: 11px; }
        .pairing-result { margin-top: 12px; padding: 12px; background: #0f172a; border: 1px dashed #38bdf8; border-radius: 8px; text-align: center; }
        .pairing-code-wrap { display: flex; justify-content: center; align-items: center; gap: 10px; margin: 6px 0; }
        .pairing-code { font-size: 28px; font-weight: 800; letter-spacing: 4px; color: #38bdf8; }
        .btn-copy { background: #0284c7; color: #ffffff; padding: 6px 12px; font-size: 12px; }
        .stats-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; text-align: center; padding: 4px 0; }
        .stat-item { background: #0f172a; border-radius: 10px; padding: 12px 6px; border: 1px solid #334155; }
        .counter-label { font-size: 10px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; }
        .counter-num { font-size: 32px; font-weight: 800; color: #38bdf8; margin: 4px 0; line-height: 1.1; }
        .counter-num.reject { color: #fbbf24; }
        .counter-num.reply { color: #c084fc; }
        .target-info { font-size: 12px; color: #cbd5e1; background: #0f172a; padding: 8px 12px; border-radius: 8px; display: block; text-align: center; margin-top: 12px; }
        .label-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
        .form-label { font-size: 13px; font-weight: 700; color: #cbd5e1; margin: 0; }
        .count-pill { font-size: 11px; background: #0c4a6e; color: #38bdf8; padding: 2px 8px; border-radius: 999px; font-weight: 700; }
        .helper-text { font-size: 11px; color: #94a3b8; margin-bottom: 6px; }
        input[type="text"], textarea { width: 100%; padding: 11px 12px; border-radius: 8px; border: 1px solid #475569; background: #0f172a; color: #f8fafc; font-size: 14px; }
        textarea { resize: vertical; line-height: 1.4; }
        input[type="text"]:focus, textarea:focus { outline: none; border-color: #38bdf8; }
        input[type="text"]:disabled, textarea:disabled { opacity: 0.6; cursor: not-allowed; }
        .field-spacer { margin-top: 14px; }
        .checkbox-card { display: flex; align-items: center; gap: 10px; background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 12px; margin-top: 12px; cursor: pointer; user-select: none; }
        .checkbox-card input[type="checkbox"] { width: 20px; height: 20px; margin: 0; accent-color: #10b981; cursor: pointer; flex-shrink: 0; }
        .checkbox-text { font-size: 13px; color: #f8fafc; font-weight: 600; }
        .checkbox-sub { display: block; font-size: 11px; color: #94a3b8; font-weight: 400; margin-top: 2px; }
        .btn-group { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 14px; }
        .btn-full { grid-column: span 2; }
        button { border: none; border-radius: 8px; padding: 12px 14px; font-size: 14px; font-weight: 700; cursor: pointer; transition: opacity 0.2s; }
        button:active { opacity: 0.8; }
        button:disabled { opacity: 0.4; cursor: not-allowed; }
        .btn-start { background: #10b981; color: #022c22; }
        .btn-stop { background: #f59e0b; color: #451a03; }
        .btn-kill { background: #ef4444; color: #ffffff; }
        .section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
        .section-title { font-size: 13px; font-weight: 700; color: #cbd5e1; }
        .file-tag { font-size: 11px; color: #94a3b8; font-weight: 400; }
        .btn-small { background: #334155; color: #cbd5e1; padding: 4px 10px; font-size: 11px; }
        .replies-box { background: #0f172a; border: 1px solid #334155; border-radius: 8px; max-height: 280px; overflow-y: auto; padding: 10px; }
        .reply-empty { text-align: center; color: #64748b; font-size: 13px; padding: 24px 10px; }
        .reply-item { background: #1e293b; border-left: 3px solid #c084fc; border-radius: 6px; padding: 10px 12px; margin-bottom: 8px; }
        .reply-item:last-child { margin-bottom: 0; }
        .reply-meta { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 11px; color: #94a3b8; margin-bottom: 5px; }
        .reply-sender { color: #38bdf8; font-weight: 700; }
        .reply-type { background: #3b0764; color: #e9d5ff; padding: 2px 6px; border-radius: 4px; font-weight: 600; font-size: 10px; }
        .reply-text { font-size: 14px; color: #f8fafc; white-space: pre-wrap; word-break: break-word; }
        .terminal { background: #020617; border: 1px solid #334155; border-radius: 8px; height: 220px; overflow-y: auto; padding: 12px; font-family: "Courier New", Courier, monospace; font-size: 12px; line-height: 1.5; }
        .log-line { margin-bottom: 4px; word-break: break-word; }
        .log-time { color: #64748b; margin-right: 6px; }
        .log-info { color: #e2e8f0; }
        .log-success { color: #4ade80; }
        .log-warn { color: #fbbf24; }
        .log-error { color: #f87171; }
        .log-reply { color: #c084fc; font-weight: bold; }
    </style>
</head>
<body>
    <div class="container">
        <div class="card header">
            <h1>WA Auto Sender</h1>
            <span id="statusBadge" class="badge disconnected">Menghubungkan...</span>
        </div>

        <div class="card">
            <div class="label-row">
                <span class="form-label">Nomor WA Pengirim (Sender):</span>
                <button id="btnLogoutSender" class="btn-logout" style="display: none;" onclick="logoutSender()">Logout Sesi</button>
            </div>

            <div class="sender-status-box">
                <div>
                    <span class="sender-active-label">Pengirim Aktif Saat Ini:</span>
                    <span id="activeSenderText" class="sender-active-val empty">Belum Tertaut</span>
                </div>
            </div>

            <div class="helper-text">Input nomor WA pengirim baru (format <b>08xxx</b>, <b>+628xxx</b>, atau <b>628xxx</b>) lalu klik tombol di samping untuk ganti / menautkan akun:</div>
            <div class="sender-row">
                <input type="text" id="senderPhoneInput" placeholder="Contoh: 081234567890" />
                <button id="btnSwitchSender" class="btn-sender" onclick="switchSender()">Tautkan / Ganti</button>
            </div>

            <div id="codeDisplay" class="pairing-result" style="display: none;">
                <div style="font-size: 12px; color: #94a3b8;">Masukkan kode ini di WhatsApp Pengirim &gt; Perangkat Tertaut &gt; Tautkan dengan nomor telepon:</div>
                <div class="pairing-code-wrap">
                    <span id="pairingCodeText" class="pairing-code">--------</span>
                    <button class="btn-copy" onclick="copyPairingCode()">Salin</button>
                </div>
            </div>
        </div>

        <div class="card">
            <div class="stats-grid">
                <div class="stat-item">
                    <div class="counter-label">Terkirim</div>
                    <div id="totalCount" class="counter-num">0</div>
                </div>
                <div class="stat-item">
                    <div class="counter-label">Balasan Masuk</div>
                    <div id="replyCount" class="counter-num reply">0</div>
                </div>
                <div class="stat-item">
                    <div class="counter-label">Call Ditolak</div>
                    <div id="rejectCount" class="counter-num reject">0</div>
                </div>
            </div>
            <div class="target-info">Target Aktif: <b id="activeTargetsCount">1 Nomor</b> &bull; Interval: <b>2 Detik/Pesan</b> &bull; Auto-Reject: <b id="rejectStatusText">AKTIF</b></div>
        </div>

        <div class="card">
            <div class="label-row">
                <label class="form-label" for="targetsInput">Nomor Tujuan Penerima (Bisa Lebih dari 1):</label>
                <span id="detectedBadge" class="count-pill">1 Nomor</span>
            </div>
            <div class="helper-text">Pisahkan dengan <b>Enter (baris baru)</b> atau <b>koma (,)</b>. Mendukung format 08xxx, +628xxx, atau 628xxx.</div>
            <textarea id="targetsInput" rows="3" placeholder="Contoh:&#10;089617198885&#10;6281234567890" oninput="updateDetectedCount()"></textarea>

            <div class="field-spacer">
                <div class="label-row">
                    <label class="form-label" for="messageInput">Ketik Isi Pesan Otomatis:</label>
                </div>
                <textarea id="messageInput" rows="3" placeholder="Ketik pesan yang akan dikirim..."></textarea>
            </div>

            <label class="checkbox-card" for="autoRejectCheck">
                <input type="checkbox" id="autoRejectCheck" checked onchange="toggleAutoReject()" />
                <div>
                    <span class="checkbox-text">Auto-Reject Panggilan Masuk</span>
                    <span class="checkbox-sub">Tolak otomatis panggilan suara &amp; video dari seluruh nomor tujuan di atas</span>
                </div>
            </label>

            <div class="btn-group">
                <button id="btnStart" class="btn-start" onclick="handleStart()">START KIRIM</button>
                <button id="btnStop" class="btn-stop" onclick="sendCmd('stop_sending')">STOP KIRIM</button>
                <button class="btn-kill btn-full" onclick="killProgram()">Matikan Program Total (Exit)</button>
            </div>
        </div>

        <div class="card">
            <div class="section-header">
                <div>
                    <div class="section-title">PESAN BALASAN TERTANGKAP</div>
                    <div class="file-tag">Tersimpan di: <code>pesan_balasan.json</code></div>
                </div>
                <button class="btn-small" onclick="clearReplies()">Hapus Riwayat</button>
            </div>
            <div id="repliesBox" class="replies-box">
                <div class="reply-empty">Belum ada balasan masuk dari nomor target...</div>
            </div>
        </div>

        <div class="card">
            <div class="section-header">
                <span class="section-title">LIVE TERMINAL LOGS</span>
                <button class="btn-small" onclick="clearTerminal()">Bersihkan Layar</button>
            </div>
            <div id="terminal" class="terminal"></div>
        </div>
    </div>

    <script>
        var socket = io();
        var terminalEl = document.getElementById('terminal');
        var repliesBoxEl = document.getElementById('repliesBox');
        var senderPhoneInputEl = document.getElementById('senderPhoneInput');
        var targetsInputEl = document.getElementById('targetsInput');
        var messageInputEl = document.getElementById('messageInput');
        var autoRejectCheckEl = document.getElementById('autoRejectCheck');
        var isFirstLoad = true;
        var currentSenderConnected = false;

        function escapeHtml(str) {
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        }

        function clientParseNumbers(raw) {
            var parts = String(raw || '').split(/[\\r\\n,;]+/);
            var seen = {};
            var list = [];
            for (var i = 0; i < parts.length; i++) {
                var digits = parts[i].replace(/[^0-9]/g, '');
                if (!digits) continue;
                if (digits.charAt(0) === '0') digits = '62' + digits.slice(1);
                if (digits.length >= 9 && digits.length <= 16 && !seen[digits]) {
                    seen[digits] = true;
                    list.push(digits);
                }
            }
            return list;
        }

        function updateDetectedCount() {
            var list = clientParseNumbers(targetsInputEl.value);
            document.getElementById('detectedBadge').innerText = list.length + ' Nomor';
        }

        function appendLog(entry) {
            var line = document.createElement('div');
            line.className = 'log-line log-' + (entry.type || 'info');
            line.innerHTML = '<span class="log-time">[' + escapeHtml(entry.time) + ']</span>' + escapeHtml(entry.text);
            terminalEl.appendChild(line);
            terminalEl.scrollTop = terminalEl.scrollHeight;
        }

        function renderReplyItem(item) {
            var emptyMsg = repliesBoxEl.querySelector('.reply-empty');
            if (emptyMsg) emptyMsg.remove();

            var div = document.createElement('div');
            div.className = 'reply-item';
            div.innerHTML =
                '<div class="reply-meta">' +
                    '<span><span class="reply-sender">' + escapeHtml(item.nomor || 'Target') + '</span> &bull; ' + escapeHtml(item.tanggal) + ' ' + escapeHtml(item.waktu) + '</span>' +
                    '<span class="reply-type">' + escapeHtml(item.tipe) + '</span>' +
                '</div>' +
                '<div class="reply-text">' + escapeHtml(item.pesan) + '</div>';
            repliesBoxEl.appendChild(div);
            repliesBoxEl.scrollTop = repliesBoxEl.scrollHeight;
        }

        socket.on('init_logs', function(logs) {
            terminalEl.innerHTML = '';
            logs.forEach(appendLog);
        });

        socket.on('log', function(entry) {
            appendLog(entry);
        });

        socket.on('init_replies', function(replies) {
            repliesBoxEl.innerHTML = '';
            if (!replies || replies.length === 0) {
                repliesBoxEl.innerHTML = '<div class="reply-empty">Belum ada balasan masuk dari nomor target...</div>';
                return;
            }
            replies.forEach(renderReplyItem);
        });

        socket.on('new_reply', function(item) {
            renderReplyItem(item);
        });

        socket.on('state', function(state) {
            document.getElementById('totalCount').innerText = state.totalSent;
            document.getElementById('replyCount').innerText = state.totalReplies;
            document.getElementById('rejectCount').innerText = state.totalRejected;

            var count = Array.isArray(state.targetNumbers) ? state.targetNumbers.length : 0;
            document.getElementById('activeTargetsCount').innerText = count + ' Nomor';

            autoRejectCheckEl.checked = Boolean(state.autoRejectEnabled);
            document.getElementById('rejectStatusText').innerText = state.autoRejectEnabled ? 'AKTIF' : 'NONAKTIF';

            if (isFirstLoad || state.isSending) {
                targetsInputEl.value = (state.targetNumbers || []).join('\\n');
                messageInputEl.value = state.currentMessage || '';
                updateDetectedCount();
                isFirstLoad = false;
            }
            targetsInputEl.disabled = state.isSending;
            messageInputEl.disabled = state.isSending;

            var badge = document.getElementById('statusBadge');
            var activeSenderEl = document.getElementById('activeSenderText');
            var btnLogoutSender = document.getElementById('btnLogoutSender');
            var btnStart = document.getElementById('btnStart');
            var btnStop = document.getElementById('btnStop');
            var codeDisplay = document.getElementById('codeDisplay');

            if (state.waStatus === 'CONNECTED') {
                currentSenderConnected = true;
                badge.className = 'badge connected';
                badge.innerText = 'Terhubung';

                var labelSender = '+' + (state.connectedSenderPhone || '');
                if (state.connectedSenderName) {
                    labelSender += ' (' + state.connectedSenderName + ')';
                }
                activeSenderEl.className = 'sender-active-val';
                activeSenderEl.innerText = labelSender;

                btnLogoutSender.style.display = 'inline-block';
                codeDisplay.style.display = 'none';
                btnStart.disabled = state.isSending;
                btnStop.disabled = !state.isSending;
            } else if (state.waStatus === 'NEED_PAIRING') {
                currentSenderConnected = false;
                badge.className = 'badge pairing';
                badge.innerText = 'Menunggu Pairing';

                activeSenderEl.className = 'sender-active-val empty';
                activeSenderEl.innerText = state.pendingPairingPhone
                    ? 'Menunggu pairing +' + state.pendingPairingPhone
                    : 'Belum Tertaut';

                btnLogoutSender.style.display = 'none';
                btnStart.disabled = true;
                btnStop.disabled = true;
            } else {
                currentSenderConnected = false;
                badge.className = 'badge disconnected';
                badge.innerText = 'Terputus';

                activeSenderEl.className = 'sender-active-val empty';
                activeSenderEl.innerText = 'Terputus / Menghubungkan...';

                btnLogoutSender.style.display = 'none';
                btnStart.disabled = true;
                btnStop.disabled = true;
            }

            if (state.pairingCode) {
                codeDisplay.style.display = 'block';
                document.getElementById('pairingCodeText').innerText = state.pairingCode;
            } else {
                codeDisplay.style.display = 'none';
            }
        });

        function switchSender() {
            var raw = senderPhoneInputEl.value.trim();
            if (!raw) {
                alert('Masukkan nomor WA pengirim terlebih dahulu!');
                senderPhoneInputEl.focus();
                return;
            }
            if (currentSenderConnected) {
                if (!confirm('Sesi pengirim saat ini akan diputus dan diganti dengan nomor baru. Lanjutkan?')) {
                    return;
                }
            }
            socket.emit('switch_sender', raw);
        }

        function logoutSender() {
            if (confirm('Yakin ingin logout dan menghapus sesi nomor WA pengirim saat ini?')) {
                socket.emit('logout_sender');
            }
        }

        function copyPairingCode() {
            var code = document.getElementById('pairingCodeText').innerText.trim();
            if (!code || code === '--------') return;
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(code).then(function() {
                    alert('Kode pairing disalin: ' + code);
                });
            } else {
                prompt('Salin kode pairing berikut:', code);
            }
        }

        function handleStart() {
            var parsedTargets = clientParseNumbers(targetsInputEl.value);
            if (parsedTargets.length === 0) {
                alert('Masukkan minimal 1 nomor tujuan yang valid terlebih dahulu!');
                targetsInputEl.focus();
                return;
            }
            var text = messageInputEl.value;
            if (!text || !text.trim()) {
                alert('Silakan ketik isi pesan terlebih dahulu sebelum menekan START!');
                messageInputEl.focus();
                return;
            }
            socket.emit('start_sending', {
                targetsRaw: targetsInputEl.value,
                message: text,
                autoReject: autoRejectCheckEl.checked
            });
        }

        function toggleAutoReject() {
            socket.emit('toggle_autoreject', autoRejectCheckEl.checked);
        }

        function sendCmd(cmd) {
            socket.emit(cmd);
        }

        function clearReplies() {
            if (confirm('Hapus semua riwayat balasan yang tersimpan di pesan_balasan.json?')) {
                socket.emit('clear_replies');
            }
        }

        function killProgram() {
            if (confirm('Yakin ingin mematikan seluruh program Node.js di Termux?')) {
                socket.emit('shutdown_server');
            }
        }

        function clearTerminal() {
            terminalEl.innerHTML = '';
        }
    </script>
</body>
</html>`;

app.get('/', (req, res) => {
    res.send(htmlPage);
});

io.on('connection', (socket) => {
    socket.emit('init_logs', logHistory);
    socket.emit('init_replies', replyHistory);
    socket.emit('state', {
        connectedSenderPhone,
        connectedSenderName,
        pendingPairingPhone,
        targetNumbers,
        currentMessage,
        autoRejectEnabled,
        totalSent,
        totalRejected,
        totalReplies: replyHistory.length,
        isSending,
        waStatus,
        pairingCode
    });

    socket.on('switch_sender', async (rawPhone) => {
        const cleanPhone = normalizeSinglePhone(rawPhone);
        if (!cleanPhone) {
            addLog('Format nomor WA pengirim tidak valid! Gunakan awalan 08 atau 62.', 'error');
            return;
        }
        addLog(`Memproses ganti nomor pengirim ke +${cleanPhone}...`, 'warn');
        await resetAndSwitchSender(cleanPhone, false);
    });

    socket.on('logout_sender', async () => {
        addLog('Memutuskan sesi pengirim saat ini (Logout)...', 'warn');
        await resetAndSwitchSender('', true);
    });

    socket.on('start_sending', async (payload) => {
        if (payload && typeof payload === 'object') {
            if (typeof payload.targetsRaw === 'string') {
                const parsed = parseTargetNumbers(payload.targetsRaw);
                if (parsed.length === 0) {
                    addLog('Gagal mulai: Format nomor tujuan tidak valid.', 'error');
                    return;
                }
                targetNumbers = parsed;
                rebuildLookupMap();
                await resolveAllTargetLids();
            }
            if (typeof payload.message === 'string') {
                currentMessage = payload.message;
            }
            if (typeof payload.autoReject === 'boolean') {
                autoRejectEnabled = payload.autoReject;
            }
        }
        startSendingLoop();
    });

    socket.on('toggle_autoreject', (enabled) => {
        autoRejectEnabled = Boolean(enabled);
        if (!autoRejectEnabled) {
            activeTargetCalls.clear();
        }
        addLog(`Ceklist Auto-Reject diubah menjadi: ${autoRejectEnabled ? 'AKTIF (Dicentang)' : 'NONAKTIF'}`, 'warn');
        broadcastState();
    });

    socket.on('stop_sending', () => stopSendingLoop());

    socket.on('clear_replies', () => {
        replyHistory = [];
        saveRepliesToFile(replyHistory);
        io.emit('init_replies', replyHistory);
        broadcastState();
        addLog('Riwayat pesan balasan telah dibersihkan.', 'warn');
    });

    socket.on('shutdown_server', async () => {
        stopSendingLoop();
        addLog('Perintah matikan program diterima. Menutup server...', 'error');
        setTimeout(() => {
            process.exit(0);
        }, 600);
    });
});

process.on('uncaughtException', (err) => {
    addLog(`System Error: ${err.message}`, 'error');
});

process.on('unhandledRejection', (reason) => {
    addLog(`Unhandled Rejection: ${reason && reason.message ? reason.message : reason}`, 'error');
});

// Endpoint ringan untuk health-check dari aplikasi Android
app.get('/health', (req, res) => {
    res.json({ ok: true, waStatus, isSending, totalSent, totalRejected, totalReplies: replyHistory.length });
});

// Hanya mendengarkan di localhost: server tidak terekspos ke jaringan/WiFi lain.
server.listen(PORT, HOST, () => {
    addLog(`Server aktif di http://${HOST}:${PORT}`, 'success');
    startBot();
});
