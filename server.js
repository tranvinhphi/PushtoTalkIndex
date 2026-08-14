/**
 * Bộ Đàm Web — Server v10.3.1
 * Room Lifecycle theo mô hình Paltalk:
 *   - Temporary Room: xoá khi Total_Users == 0
 *   - Permanent Room: hibernate khi empty, restore khi owner/admin quay lại
 * ACL: role gắn với username, auto-restore khi rejoin
 */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const webpush = require('web-push');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
app.use(express.json());
app.use((req,res,next)=>{
  res.header('Access-Control-Allow-Origin','*');
  res.header('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS')return res.sendStatus(200);
  next();
});
app.use(express.static(__dirname));
const server = http.createServer(app);

// ── DATABASE ──────────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || path.join('/tmp','botdam.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    room_id TEXT PRIMARY KEY,
    owner_username TEXT NOT NULL,
    room_type TEXT NOT NULL DEFAULT 'temporary',
    status TEXT NOT NULL DEFAULT 'active',
    is_public INTEGER DEFAULT 1,
    require_approval INTEGER DEFAULT 0,
    password TEXT DEFAULT '',
    description TEXT DEFAULT '',
    tts_voice TEXT DEFAULT 'nu-nam',
    created_at INTEGER NOT NULL,
    last_active INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS room_admins (
    room_id TEXT NOT NULL,
    username TEXT NOT NULL,
    granted_by TEXT,
    granted_at INTEGER,
    PRIMARY KEY (room_id, username)
  );
  CREATE TABLE IF NOT EXISTS room_bans (
    room_id TEXT NOT NULL,
    username TEXT NOT NULL,
    banned_by TEXT,
    banned_at INTEGER,
    reason TEXT DEFAULT '',
    PRIMARY KEY (room_id, username)
  );
  CREATE TABLE IF NOT EXISTS room_mutes (
    room_id TEXT NOT NULL,
    username TEXT NOT NULL,
    PRIMARY KEY (room_id, username)
  );
`);

// DB helpers
const stmts = {
  getRoom:        db.prepare('SELECT * FROM rooms WHERE room_id=?'),
  createRoom:     db.prepare('INSERT OR IGNORE INTO rooms (room_id,owner_username,room_type,status,is_public,require_approval,password,description,created_at,last_active) VALUES (?,?,?,?,?,?,?,?,?,?)'),
  updateRoom:     db.prepare('UPDATE rooms SET status=?,is_public=?,require_approval=?,password=?,description=?,last_active=?,tts_voice=? WHERE room_id=?'),
  setStatus:      db.prepare('UPDATE rooms SET status=?,last_active=? WHERE room_id=?'),
  setVoice:       db.prepare('UPDATE rooms SET tts_voice=? WHERE room_id=?'),
  getAdmins:      db.prepare('SELECT username FROM room_admins WHERE room_id=?'),
  addAdmin:       db.prepare('INSERT OR IGNORE INTO room_admins (room_id,username,granted_by,granted_at) VALUES (?,?,?,?)'),
  removeAdmin:    db.prepare('DELETE FROM room_admins WHERE room_id=? AND username=?'),
  isBanned:       db.prepare('SELECT 1 FROM room_bans WHERE room_id=? AND username=?'),
  addBan:         db.prepare('INSERT OR IGNORE INTO room_bans (room_id,username,banned_by,banned_at,reason) VALUES (?,?,?,?,?)'),
  removeBan:      db.prepare('DELETE FROM room_bans WHERE room_id=? AND username=?'),
  isMuted:        db.prepare('SELECT 1 FROM room_mutes WHERE room_id=? AND username=?'),
  addMute:        db.prepare('INSERT OR IGNORE INTO room_mutes (room_id,username) VALUES (?,?)'),
  removeMute:     db.prepare('DELETE FROM room_mutes WHERE room_id=? AND username=?'),
  publicRooms:    db.prepare("SELECT r.*,(SELECT COUNT(*) FROM room_admins WHERE room_id=r.room_id) as admin_count FROM rooms r WHERE r.is_public=1 AND r.status='active'"),
};

function isAdmin(roomId, username) {
  const row = db.prepare('SELECT 1 FROM room_admins WHERE room_id=? AND username=?').get(roomId, username);
  return !!row;
}
function isOwner(roomId, username) {
  const row = stmts.getRoom.get(roomId);
  return row && row.owner_username === username;
}
function hasAdminPrivilege(roomId, username) {
  return isOwner(roomId, username) || isAdmin(roomId, username);
}

// ── PUSH ──────────────────────────────────────────────────
const VAPID_PUBLIC_KEY  = 'BDTnYKWEcRAZbGHBaCekCGkDMzlnR5RZnhZKlRvrkTykxkSheHnc0xIkpYhE8_aiApr5IbhXTIRBJTkj4nUSzpc';
const VAPID_PRIVATE_KEY = 'f11gX6No3oeQWTsdwcI_31EQoG8HBCToU9oWV91rn0I';
webpush.setVapidDetails('mailto:admin@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const pushSubs = {}; // roomId → Map<socketId, sub>
function sendPush(roomId, payload, excludeId) {
  const m = pushSubs[roomId]; if (!m) return;
  const pl = JSON.stringify(payload);
  m.forEach((sub, id) => {
    if (id === excludeId) return;
    webpush.sendNotification(sub, pl).catch(e => { if (e.statusCode === 410 || e.statusCode === 404) m.delete(id); });
  });
}
function sendPushToSocket(socketId, payload, roomId) {
  const m = pushSubs[roomId]; if (!m) return;
  const sub = m.get(socketId); if (!sub) return;
  webpush.sendNotification(sub, JSON.stringify(payload)).catch(() => {});
}

// ── SOCKET.IO ─────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin:'*', methods:['GET','POST'] },
  maxHttpBufferSize: 10 * 1024 * 1024,
  pingTimeout: 20000,
  pingInterval: 10000,
});

app.get('/health', (_, res) => res.json({ status:'ok', version:'10.3.1' }));

// ── TTS PROXY — gọi ViettelAI server-side để tránh CORS ──
const https_mod = require('https');
const VIETTEL_VOICES = {
  'nu-nam' :'hcm-diemmy',
  'nu-bac' :'hn-thanh',
  'nam-nam':'hcm-minhquang',
  'nam-bac':'hn-thanhlong',
};
const ttsCache = new Map();
const TTS_CACHE_MAX = 200;

app.post('/tts', express.json(), async (req, res) => {
  const { text='', voice='nu-nam', speed=1 } = req.body || {};
  if (!text || text.length > 600) return res.status(400).json({ error: 'text required' });
  const ck = `${voice}::${text.substring(0,200)}`;
  if (ttsCache.has(ck)) {
    res.setHeader('Content-Type','audio/mpeg');
    res.setHeader('Cache-Control','public,max-age=3600');
    return res.end(ttsCache.get(ck));
  }
  const voiceName = VIETTEL_VOICES[voice] || 'hcm-diemmy';
  const body = JSON.stringify({ speed, voice: voiceName, text, tts_return_option: 3, without_filter: false });
  const options = {
    hostname: 'viettelai.vn',
    path: '/tts/speech_synthesis',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Connection': 'keep-alive',
      'User-Agent': 'Mozilla/5.0',
    },
    timeout: 12000,
  };
  try {
    const buf = await new Promise((resolve, reject) => {
      const req2 = https_mod.request(options, r2 => {
        const chunks = [];
        r2.on('data', d => chunks.push(d));
        r2.on('end', () => {
          const b = Buffer.concat(chunks);
          if (r2.statusCode === 200 && b.length > 500) resolve(b);
          else reject(new Error(`ViettelAI status ${r2.statusCode}, size ${b.length}`));
        });
      });
      req2.on('error', reject);
      req2.on('timeout', () => { req2.destroy(); reject(new Error('timeout')); });
      req2.write(body);
      req2.end();
    });
    if (ttsCache.size >= TTS_CACHE_MAX) ttsCache.delete(ttsCache.keys().next().value);
    ttsCache.set(ck, buf);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public,max-age=3600');
    res.end(buf);
  } catch(e) {
    console.error('[TTS]', e.message);
    res.status(503).json({ error: e.message });
  }
});
app.get('/vapid-public-key', (_, res) => res.json({ key: VAPID_PUBLIC_KEY }));
app.get('/rooms', (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  let rows = stmts.publicRooms.all();
  // Merge với số người online hiện tại
  rows = rows.map(r => {
    const members = Object.keys(activeRooms[r.room_id] || {});
    return { ...r, memberCount: members.length };
  }).filter(r => r.memberCount > 0 || r.room_type === 'permanent');
  if (q) rows = rows.filter(r => r.room_id.toLowerCase().includes(q) || r.description.toLowerCase().includes(q));
  res.json(rows.map(r => ({
    code: r.room_id,
    memberCount: r.memberCount,
    description: r.description,
    requireApproval: !!r.require_approval,
    hasPassword: !!r.password,
    isPermanent: r.room_type === 'permanent',
    createdAt: r.created_at,
  })));
});

// In-memory session state
const activeRooms  = {}; // roomId → { socketId: {username, lat, lng, ping, battery, cameraOn, hasCamera} }
const micHolders   = {}; // roomId → {socketId, username, sinceTs} | null
const micTimeouts  = {}; // roomId → timeout
const approvalQueue = {}; // roomId → [{socketId, username, requestedAt}]
const voiceMemos   = {}; // roomId → {username, audioBuffer, ts}
const MAX_MIC_MS   = 90000;

const NAME_RE = /^[A-Za-zÀ-ỹà-ỹ\s]{2,30}$/;
const ROOM_RE = /^[A-Za-zÀ-ỹà-ỹ0-9_-]{3,20}$/;

function userList(roomId) {
  if (!activeRooms[roomId]) return [];
  const roomRow = stmts.getRoom.get(roomId);
  const ownerName = roomRow?.owner_username;
  return Object.entries(activeRooms[roomId]).map(([id, d]) => ({
    id, username: d.username,
    lat: d.lat, lng: d.lng,
    ping: d.ping || null, battery: d.battery || null,
    muted: !!stmts.isMuted.get(roomId, d.username),
    isOwner: d.username === ownerName,
    isAdmin: isAdmin(roomId, d.username),
    hasCamera: d.hasCamera || false,
    cameraOn: d.cameraOn || false,
  }));
}
function broadcastUsers(roomId) { io.to(roomId).emit('user-list', userList(roomId)); }

function clearMicTo(roomId) { if (micTimeouts[roomId]) { clearTimeout(micTimeouts[roomId]); delete micTimeouts[roomId]; } }
function releaseMic(roomId, reason) {
  const h = micHolders[roomId]; if (!h) return;
  micHolders[roomId] = null; clearMicTo(roomId);
  io.to(roomId).emit('speaking-stop', { username: h.username, reason: reason || 'released' });
}
function grantMic(roomId, socket, username) {
  micHolders[roomId] = { socketId: socket.id, username, sinceTs: Date.now() };
  clearMicTo(roomId);
  micTimeouts[roomId] = setTimeout(() => releaseMic(roomId, 'timeout'), MAX_MIC_MS);
  socket.emit('mic-granted', { username });
  io.to(roomId).emit('speaking-start', { username });
  sendPush(roomId, { title:`🎙️ ${username} đang nói`, body:`Phòng ${roomId}`, tag:'botdam-speaking' }, socket.id);
}

function destroyRoom(roomId) {
  // Temporary room: wipe everything
  delete activeRooms[roomId];
  delete micHolders[roomId];
  delete approvalQueue[roomId];
  delete voiceMemos[roomId];
  delete pushSubs[roomId];
  clearMicTo(roomId);
  // DB: delete temporary room entirely
  const row = stmts.getRoom.get(roomId);
  if (row && row.room_type === 'temporary') {
    db.prepare('DELETE FROM rooms WHERE room_id=?').run(roomId);
    db.prepare('DELETE FROM room_admins WHERE room_id=?').run(roomId);
    db.prepare('DELETE FROM room_mutes WHERE room_id=?').run(roomId);
  }
}

function hibernateRoom(roomId) {
  // Permanent room: keep DB, just mark offline
  stmts.setStatus.run('hibernated', Date.now(), roomId);
  delete activeRooms[roomId];
  delete micHolders[roomId];
  delete approvalQueue[roomId];
  clearMicTo(roomId);
  console.log(`[Room] ${roomId} → hibernated`);
}

function wakeRoom(roomId) {
  stmts.setStatus.run('active', Date.now(), roomId);
  if (!activeRooms[roomId]) activeRooms[roomId] = {};
  console.log(`[Room] ${roomId} → active (wake)`);
}

// ── CORE JOIN/LEAVE ────────────────────────────────────────
function doJoin(socket, roomId, username) {
  socket.join(roomId);
  socket.data.roomCode = roomId;
  socket.data.username = username;
  socket.data.pendingRoom = null;

  if (!activeRooms[roomId]) activeRooms[roomId] = {};
  activeRooms[roomId][socket.id] = { username, lat:null, lng:null, ping:null, battery:null, hasCamera:false, cameraOn:false };
  if (!(roomId in micHolders)) micHolders[roomId] = null;
  if (!approvalQueue[roomId]) approvalQueue[roomId] = [];

  const roomRow = stmts.getRoom.get(roomId);
  const ownerName = roomRow?.owner_username;
  const userIsOwner = username === ownerName;
  const userIsAdmin = isAdmin(roomId, username);

  // Wake permanent room if needed
  if (roomRow?.status === 'hibernated' && (userIsOwner || userIsAdmin)) {
    wakeRoom(roomId);
    io.to(roomId).emit('system-message', `🌅 Phòng vĩnh viễn "${roomId}" đã hoạt động trở lại.`);
  }

  if (userIsOwner) {
    socket.emit('you-are-owner');
    socket.emit('room-settings', {
      isPublic: !!roomRow.is_public,
      requireApproval: !!roomRow.require_approval,
      description: roomRow.description,
      hasPassword: !!roomRow.password,
      isPermanent: roomRow.room_type === 'permanent',
      ttsVoice: roomRow.tts_voice || 'nu-nam',
    });
    const pending = approvalQueue[roomId] || [];
    pending.forEach(r => socket.emit('approval-request', { socketId: r.socketId, username: r.username, roomCode: roomId }));
  } else if (userIsAdmin) {
    socket.emit('you-are-admin');
    socket.emit('room-settings', {
      isPublic: !!roomRow.is_public,
      requireApproval: !!roomRow.require_approval,
      description: roomRow.description,
      hasPassword: !!roomRow.password,
      isPermanent: roomRow.room_type === 'permanent',
      ttsVoice: roomRow.tts_voice || 'nu-nam',
    });
  }

  socket.emit('joined', { roomCode: roomId, username, isOwner: userIsOwner, isAdmin: userIsAdmin, ttsVoice: roomRow?.tts_voice || 'nu-nam' });
  broadcastUsers(roomId);
  socket.to(roomId).emit('system-message', `${username} đã vào phòng.`);

  const h = micHolders[roomId];
  if (h) socket.emit('speaking-start', { username: h.username });
  if (voiceMemos[roomId]) {
    const m = voiceMemos[roomId];
    socket.emit('voice-memo', { username: m.username, audio: m.audioBuffer, ts: m.ts });
  }
}

function doLeave(socket) {
  const { roomCode: roomId, username } = socket.data;
  if (!roomId || !activeRooms[roomId]) return;

  const h = micHolders[roomId];
  if (h && h.socketId === socket.id) releaseMic(roomId, 'left');
  if (activeRooms[roomId][socket.id]) {
    activeRooms[roomId][socket.id].cameraOn = false;
    activeRooms[roomId][socket.id].hasCamera = false;
  }
  delete activeRooms[roomId][socket.id];
  socket.leave(roomId);
  if (pushSubs[roomId]) pushSubs[roomId].delete(socket.id);
  if (approvalQueue[roomId]) approvalQueue[roomId] = approvalQueue[roomId].filter(r => r.socketId !== socket.id);

  const remaining = Object.keys(activeRooms[roomId]).length;
  io.to(roomId).emit('system-message', `${username || 'Một người dùng'} đã rời phòng.`);

  if (remaining === 0) {
    const roomRow = stmts.getRoom.get(roomId);
    if (!roomRow) { destroyRoom(roomId); return; }
    if (roomRow.room_type === 'permanent') {
      hibernateRoom(roomId);
    } else {
      destroyRoom(roomId);
    }
    return;
  }

  broadcastUsers(roomId);
  // If owner left temporary room → transfer ownership to first remaining
  const roomRow = stmts.getRoom.get(roomId);
  if (roomRow && roomRow.owner_username === username && roomRow.room_type === 'temporary') {
    const nextEntry = Object.values(activeRooms[roomId])[0];
    if (nextEntry) {
      db.prepare('UPDATE rooms SET owner_username=? WHERE room_id=?').run(nextEntry.username, roomId);
      const nextSocket = Object.entries(activeRooms[roomId]).find(([,d]) => d.username === nextEntry.username);
      if (nextSocket) {
        io.to(nextSocket[0]).emit('you-are-owner');
        io.to(nextSocket[0]).emit('room-settings', {
          isPublic: !!roomRow.is_public, requireApproval: !!roomRow.require_approval,
          description: roomRow.description, hasPassword: !!roomRow.password,
          isPermanent: false, ttsVoice: roomRow.tts_voice || 'nu-nam',
        });
      }
      io.to(roomId).emit('system-message', `👑 ${nextEntry.username} trở thành Chủ phòng mới.`);
      broadcastUsers(roomId);
    }
  }
}

// ── SOCKET EVENTS ──────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[+] ${socket.id}`);

  socket.on('join-room', ({ roomCode, username, password }) => {
    if (!roomCode || !username) return socket.emit('join-error', 'Thiếu thông tin.');
    roomCode = String(roomCode).trim().substring(0, 20);
    username = String(username).trim().replace(/\s+/g, ' ').substring(0, 30);
    if (!ROOM_RE.test(roomCode)) return socket.emit('join-error', 'Mã phòng không hợp lệ (3-20 ký tự, không dấu cách).');
    if (!NAME_RE.test(username)) return socket.emit('join-error', 'Tên không hợp lệ — chỉ dùng chữ cái và dấu cách.');

    // Check ban
    if (stmts.isBanned.get(roomCode, username)) return socket.emit('join-error', 'Bạn đã bị cấm vào phòng này.');

    doLeave(socket);
    let roomRow = stmts.getRoom.get(roomCode);

    if (!roomRow) {
      // Create new temporary room
      stmts.createRoom.run(roomCode, username, 'temporary', 'active', 1, 0, '', '', Date.now(), Date.now());
      roomRow = stmts.getRoom.get(roomCode);
    } else {
      // Check password (only for existing active rooms)
      if (roomRow.password && roomRow.status === 'active') {
        if (!password || password !== roomRow.password) return socket.emit('join-error', 'Sai mật khẩu phòng.');
      }
    }

    // Check approval
    const userIsOwner = username === roomRow.owner_username;
    const userIsAdmin = isAdmin(roomCode, username);
    if (roomRow.require_approval && roomRow.status === 'active' && !userIsOwner && !userIsAdmin) {
      if (!approvalQueue[roomCode]) approvalQueue[roomCode] = [];
      if (!approvalQueue[roomCode].find(r => r.username === username)) {
        approvalQueue[roomCode].push({ socketId: socket.id, username, requestedAt: Date.now() });
      }
      socket.data.pendingRoom = roomCode; socket.data.pendingUsername = username;
      socket.emit('waiting-approval', { roomCode, username });
      // Notify owner
      const ownerEntry = activeRooms[roomCode] && Object.entries(activeRooms[roomCode]).find(([,d]) => d.username === roomRow.owner_username);
      if (ownerEntry) io.to(ownerEntry[0]).emit('approval-request', { socketId: socket.id, username, roomCode });
      // Also notify admins
      const admins = stmts.getAdmins.all(roomCode).map(r => r.username);
      if (activeRooms[roomCode]) {
        Object.entries(activeRooms[roomCode]).forEach(([sid, d]) => {
          if (admins.includes(d.username)) io.to(sid).emit('approval-request', { socketId: socket.id, username, roomCode });
        });
      }
      return;
    }

    doJoin(socket, roomCode, username);
  });

  socket.on('create-room-options', ({ password, isPublic, requireApproval, description, isPermanent }) => {
    const { roomCode: code, username } = socket.data;
    if (!code || !isOwner(code, username)) return;
    const roomRow = stmts.getRoom.get(code);
    if (!roomRow) return;
    stmts.updateRoom.run(
      'active',
      typeof isPublic === 'boolean' ? (isPublic ? 1 : 0) : roomRow.is_public,
      typeof requireApproval === 'boolean' ? (requireApproval ? 1 : 0) : roomRow.require_approval,
      typeof password === 'string' ? password.substring(0, 30) : roomRow.password,
      typeof description === 'string' ? description.substring(0, 80) : roomRow.description,
      Date.now(),
      roomRow.tts_voice,
      code
    );
    if (isPermanent) db.prepare("UPDATE rooms SET room_type='permanent' WHERE room_id=?").run(code);
  });

  socket.on('rejoin-room', ({ roomCode, username }) => {
    if (!roomCode || !username) return;
    roomCode = String(roomCode).trim().substring(0, 20);
    username = String(username).trim().replace(/\s+/g, ' ').substring(0, 30);
    if (!ROOM_RE.test(roomCode) || !NAME_RE.test(username)) return;
    if (stmts.isBanned.get(roomCode, username)) return socket.emit('kicked', { reason: 'Bạn đã bị cấm vào phòng này.' });
    const roomRow = stmts.getRoom.get(roomCode);
    if (!roomRow || (roomRow.status === 'active' && !activeRooms[roomCode])) {
      return socket.emit('room-closed', { roomCode });
    }
    doJoin(socket, roomCode, username);
  });

  socket.on('approve-user', ({ targetSocketId }) => {
    const { roomCode: code, username } = socket.data;
    if (!code || !hasAdminPrivilege(code, username)) return;
    const q = approvalQueue[code] || [];
    const idx = q.findIndex(r => r.socketId === targetSocketId);
    if (idx === -1) return;
    const { username: targetName } = q[idx];
    approvalQueue[code].splice(idx, 1);
    socket.emit('approval-done', { socketId: targetSocketId });
    const t = io.sockets.sockets.get(targetSocketId);
    if (!t) return;
    doJoin(t, code, targetName);
    t.emit('approval-granted', { roomCode: code });
  });

  socket.on('reject-user', ({ targetSocketId }) => {
    const { roomCode: code, username } = socket.data;
    if (!code || !hasAdminPrivilege(code, username)) return;
    const q = approvalQueue[code] || [];
    const idx = q.findIndex(r => r.socketId === targetSocketId);
    if (idx === -1) return;
    const { username: targetName } = q[idx];
    approvalQueue[code].splice(idx, 1);
    socket.emit('approval-done', { socketId: targetSocketId });
    io.sockets.sockets.get(targetSocketId)?.emit('approval-rejected', { roomCode: code });
    io.to(code).emit('system-message', `❌ ${targetName} bị từ chối.`);
  });

  socket.on('update-room-settings', ({ isPublic, requireApproval, password, description }) => {
    const { roomCode: code, username } = socket.data;
    if (!code || !hasAdminPrivilege(code, username)) return;
    const row = stmts.getRoom.get(code); if (!row) return;
    stmts.updateRoom.run(
      row.status,
      typeof isPublic === 'boolean' ? (isPublic ? 1 : 0) : row.is_public,
      typeof requireApproval === 'boolean' ? (requireApproval ? 1 : 0) : row.require_approval,
      typeof password === 'string' ? password.substring(0, 30) : row.password,
      typeof description === 'string' ? description.substring(0, 80) : row.description,
      Date.now(),
      row.tts_voice,
      code
    );
    socket.emit('room-settings', {
      isPublic: typeof isPublic === 'boolean' ? isPublic : !!row.is_public,
      requireApproval: typeof requireApproval === 'boolean' ? requireApproval : !!row.require_approval,
      description: typeof description === 'string' ? description : row.description,
      hasPassword: !!(typeof password === 'string' ? password : row.password),
      isPermanent: row.room_type === 'permanent',
      ttsVoice: row.tts_voice,
    });
    io.to(code).emit('system-message', '⚙️ Cài đặt phòng đã được cập nhật.');
  });

  // ── ADMIN MANAGEMENT ──────────────────────────────────────
  socket.on('add-admin', ({ targetUsername }) => {
    const { roomCode: code, username } = socket.data;
    if (!code || !isOwner(code, username)) return;
    if (isOwner(code, targetUsername)) return;
    stmts.addAdmin.run(code, targetUsername, username, Date.now());
    const target = activeRooms[code] && Object.entries(activeRooms[code]).find(([,d]) => d.username === targetUsername);
    if (target) {
      io.to(target[0]).emit('you-are-admin');
      io.to(target[0]).emit('room-settings', (() => {
        const r = stmts.getRoom.get(code);
        return { isPublic:!!r.is_public, requireApproval:!!r.require_approval, description:r.description, hasPassword:!!r.password, isPermanent:r.room_type==='permanent', ttsVoice:r.tts_voice };
      })());
    }
    io.to(code).emit('system-message', `👑 ${targetUsername} được thăng làm Admin phòng.`);
    broadcastUsers(code);
  });

  socket.on('remove-admin', ({ targetUsername }) => {
    const { roomCode: code, username } = socket.data;
    if (!code || !isOwner(code, username)) return;
    stmts.removeAdmin.run(code, targetUsername);
    const target = activeRooms[code] && Object.entries(activeRooms[code]).find(([,d]) => d.username === targetUsername);
    if (target) io.to(target[0]).emit('you-are-demoted');
    io.to(code).emit('system-message', `🔽 ${targetUsername} đã bị thu hồi quyền Admin.`);
    broadcastUsers(code);
  });

  // ── BAN ────────────────────────────────────────────────────
  socket.on('ban-user', ({ targetId, reason }) => {
    const { roomCode: code, username } = socket.data;
    if (!code || !hasAdminPrivilege(code, username)) return;
    const target = activeRooms[code]?.[targetId]; if (!target) return;
    if (isOwner(code, target.username)) return;
    stmts.addBan.run(code, target.username, username, Date.now(), reason || '');
    const t = io.sockets.sockets.get(targetId);
    if (t) { t.emit('kicked', { reason: `Bạn đã bị cấm: ${reason || 'Vi phạm nội quy'}` }); doLeave(t); }
    io.to(code).emit('system-message', `🚫 ${target.username} đã bị cấm vào phòng.`);
  });

  socket.on('unban-user', ({ targetUsername }) => {
    const { roomCode: code, username } = socket.data;
    if (!code || !hasAdminPrivilege(code, username)) return;
    stmts.removeBan.run(code, targetUsername);
    io.to(code).emit('system-message', `✅ ${targetUsername} đã được gỡ lệnh cấm.`);
  });

  // ── TTS VOICE FOR ROOM ────────────────────────────────────
  socket.on('set-room-tts-voice', ({ voice, voiceLabel }) => {
    const { roomCode: code, username } = socket.data;
    if (!code || !hasAdminPrivilege(code, username)) return;
    const allowed = ['nu-nam','nu-bac','nam-nam','nam-bac'];
    if (!allowed.includes(voice)) return;
    stmts.setVoice.run(voice, code);
    socket.to(code).emit('room-tts-voice', { voice, voiceLabel });
    io.to(code).emit('system-message', `🔊 Admin đặt giọng đọc: ${voiceLabel || voice}`);
  });

  socket.on('save-subscription', sub => {
    const { roomCode: code } = socket.data;
    if (!code || !sub?.endpoint) return;
    if (!pushSubs[code]) pushSubs[code] = new Map();
    pushSubs[code].set(socket.id, sub);
  });

  socket.on('update-location', ({ lat, lng }) => {
    const { roomCode: code } = socket.data;
    if (!code || !activeRooms[code]?.[socket.id]) return;
    if (typeof lat !== 'number' || typeof lng !== 'number') return;
    activeRooms[code][socket.id].lat = lat;
    activeRooms[code][socket.id].lng = lng;
    broadcastUsers(code);
  });

  socket.on('update-status', ({ ping, battery }) => {
    const { roomCode: code } = socket.data;
    if (!code || !activeRooms[code]?.[socket.id]) return;
    if (typeof ping === 'number') activeRooms[code][socket.id].ping = ping;
    if (typeof battery === 'number') activeRooms[code][socket.id].battery = battery;
    broadcastUsers(code);
  });

  socket.on('ping-custom', () => socket.emit('pong-custom'));

  socket.on('start-speaking', () => {
    const { roomCode: code, username } = socket.data;
    if (!code) return;
    if (stmts.isMuted.get(code, username)) return socket.emit('mic-denied', { holder: 'Chủ phòng (mic bị khoá)' });
    const h = micHolders[code];
    if (!h) grantMic(code, socket, username);
    else if (h.socketId === socket.id) {}
    else socket.emit('mic-denied', { holder: h.username });
  });

  socket.on('stop-speaking', () => {
    const { roomCode: code } = socket.data;
    if (!code) return;
    if (micHolders[code]?.socketId === socket.id) releaseMic(code, 'released');
  });

  socket.on('audio-data', buf => {
    const { roomCode: code, username } = socket.data;
    if (!code || !buf) return;
    if (micHolders[code]?.socketId !== socket.id) return;
    socket.to(code).emit('audio-data', { username, audio: buf });
    voiceMemos[code] = { username, audioBuffer: buf, ts: Date.now() };
  });

  socket.on('camera-state', ({ hasCamera, cameraOn }) => {
    const { roomCode: code } = socket.data;
    if (!code || !activeRooms[code]?.[socket.id]) return;
    if (typeof hasCamera === 'boolean') activeRooms[code][socket.id].hasCamera = hasCamera;
    if (typeof cameraOn === 'boolean') activeRooms[code][socket.id].cameraOn = cameraOn;
    broadcastUsers(code);
  });

  socket.on('video-frame', ({ frame }) => {
    const { roomCode: code, username } = socket.data;
    if (!code || !frame) return;
    socket.to(code).emit('video-frame', { username, frame });
  });

  socket.on('force-camera-off', ({ targetId }) => {
    const { roomCode: code, username } = socket.data;
    if (!code || !hasAdminPrivilege(code, username)) return;
    io.sockets.sockets.get(targetId)?.emit('camera-forced-off');
    if (activeRooms[code]?.[targetId]) { activeRooms[code][targetId].cameraOn = false; activeRooms[code][targetId].hasCamera = false; broadcastUsers(code); }
  });

  socket.on('request-camera-on', ({ targetId }) => {
    const { roomCode: code, username: ownerName } = socket.data;
    if (!code || !hasAdminPrivilege(code, ownerName)) return;
    const t = io.sockets.sockets.get(targetId);
    if (!t) return;
    t.emit('camera-on-requested', { fromOwner: ownerName });
    sendPushToSocket(targetId, { title:'📷 Yêu cầu bật camera', body:`${ownerName} yêu cầu bạn bật camera`, tag:'botdam-cam-req' }, code);
  });

  socket.on('request-mic-on', ({ targetId }) => {
    const { roomCode: code, username: ownerName } = socket.data;
    if (!code || !hasAdminPrivilege(code, ownerName)) return;
    const t = io.sockets.sockets.get(targetId);
    if (!t || !activeRooms[code]?.[targetId]) return;
    if (stmts.isMuted.get(code, activeRooms[code][targetId].username)) {
      stmts.removeMute.run(code, activeRooms[code][targetId].username);
      broadcastUsers(code);
    }
    t.emit('mic-on-requested', { fromOwner: ownerName });
    sendPushToSocket(targetId, { title:'🎙️ Yêu cầu bật mic', body:`${ownerName} yêu cầu bạn nói ngay!`, tag:'botdam-mic-req' }, code);
  });

  socket.on('sos', ({ lat, lng }) => {
    const { roomCode: code, username } = socket.data;
    if (!code || !username) return;
    io.to(code).emit('sos-alert', { username, lat, lng, ts: Date.now() });
    sendPush(code, { title:`🆘 SOS từ ${username}!`, body:`Cần hỗ trợ - Phòng ${code}`, tag:'botdam-sos' }, socket.id);
  });

  socket.on('chat-message', ({ text }) => {
    const { roomCode: code, username } = socket.data;
    if (!code || !username || !text) return;
    const msg = String(text).trim().substring(0, 300);
    if (!msg) return;
    io.to(code).emit('chat-message', { username, text: msg, ts: Date.now() });
    sendPush(code, { title:`💬 ${username}`, body: msg.length > 80 ? msg.substring(0,80)+'…' : msg, tag:'botdam-chat', chatText: msg, sender: username }, socket.id);
  });

  socket.on('kick-user', ({ targetId }) => {
    const { roomCode: code, username } = socket.data;
    if (!code || !hasAdminPrivilege(code, username)) return;
    const t = io.sockets.sockets.get(targetId);
    if (!t || !activeRooms[code]?.[targetId]) return;
    const name = activeRooms[code][targetId].username;
    if (isOwner(code, name)) return;
    t.emit('kicked', { reason: 'Chủ phòng đã mời bạn rời phòng.' });
    doLeave(t);
    io.to(code).emit('system-message', `👢 ${name} đã bị mời ra.`);
  });

  socket.on('toggle-mute', ({ targetId }) => {
    const { roomCode: code, username } = socket.data;
    if (!code || !hasAdminPrivilege(code, username)) return;
    if (!activeRooms[code]?.[targetId]) return;
    const targetName = activeRooms[code][targetId].username;
    if (isOwner(code, targetName)) return;
    const wasMuted = !!stmts.isMuted.get(code, targetName);
    if (wasMuted) stmts.removeMute.run(code, targetName);
    else { stmts.addMute.run(code, targetName); if (micHolders[code]?.socketId === targetId) releaseMic(code, 'muted'); }
    io.sockets.sockets.get(targetId)?.emit('you-are-muted', { muted: !wasMuted });
    io.to(code).emit('system-message', !wasMuted ? `🔇 ${targetName} bị tắt mic.` : `🔊 ${targetName} được bật mic.`);
    broadcastUsers(code);
  });

  socket.on('add-admin-by-id', ({ targetId }) => {
    const { roomCode: code, username } = socket.data;
    if (!code || !isOwner(code, username)) return;
    const target = activeRooms[code]?.[targetId]; if (!target) return;
    socket.emit('add-admin', { targetUsername: target.username });
    socket.emit('add-admin', { targetUsername: target.username });
  });

  // Shortcut: promote from member panel (targetId → username lookup)
  socket.on('promote-to-admin', ({ targetId }) => {
    const { roomCode: code, username } = socket.data;
    if (!code || !isOwner(code, username)) return;
    const target = activeRooms[code]?.[targetId]; if (!target) return;
    if (isOwner(code, target.username)) return;
    stmts.addAdmin.run(code, target.username, username, Date.now());
    const t = io.sockets.sockets.get(targetId);
    if (t) {
      const r = stmts.getRoom.get(code);
      t.emit('you-are-admin');
      t.emit('room-settings', { isPublic:!!r.is_public, requireApproval:!!r.require_approval, description:r.description, hasPassword:!!r.password, isPermanent:r.room_type==='permanent', ttsVoice:r.tts_voice });
    }
    io.to(code).emit('system-message', `👑 ${target.username} được thăng làm Admin phòng.`);
    broadcastUsers(code);
  });

  socket.on('demote-from-admin', ({ targetId }) => {
    const { roomCode: code, username } = socket.data;
    if (!code || !isOwner(code, username)) return;
    const target = activeRooms[code]?.[targetId]; if (!target) return;
    stmts.removeAdmin.run(code, target.username);
    io.sockets.sockets.get(targetId)?.emit('you-are-demoted');
    io.to(code).emit('system-message', `🔽 ${target.username} đã bị thu hồi quyền Admin.`);
    broadcastUsers(code);
  });

  socket.on('reaction', ({ emoji }) => {
    const { roomCode: code, username } = socket.data;
    if (!code || !emoji) return;
    io.to(code).emit('reaction', { username, emoji: String(emoji).substring(0, 8) });
  });

  socket.on('disconnect', () => { doLeave(socket); console.log(`[-] ${socket.id}`); });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`[Bộ Đàm Web] Server v10.3.1 on port ${PORT}`));
