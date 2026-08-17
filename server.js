/**
 * Bộ Đàm Web — Server v11.0.4
 * Room Lifecycle theo mô hình Paltalk:
 *   - Temporary Room: xoá khi Total_Users == 0
 *   - Permanent Room: hibernate khi empty, restore khi owner/admin quay lại
 * ACL: role gắn với username, auto-restore khi rejoin
 */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const webpush = require('web-push');
const sqlite3 = require('sqlite3').verbose();
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
const db = new sqlite3.Database(DB_PATH);

// Wrap sqlite3 callbacks into sync-style helpers
function dbRun(sql, params=[]){ return new Promise((res,rej)=>db.run(sql,params,function(e){if(e)rej(e);else res(this)})); }
function dbGet(sql, params=[]){ return new Promise((res,rej)=>db.get(sql,params,(e,row)=>{if(e)rej(e);else res(row)})); }
function dbAll(sql, params=[]){ return new Promise((res,rej)=>db.all(sql,params,(e,rows)=>{if(e)rej(e);else res(rows)})); }

// Init tables
db.serialize(()=>{
  db.run('PRAGMA journal_mode=WAL');
  db.run(`CREATE TABLE IF NOT EXISTS rooms (
    room_id TEXT PRIMARY KEY, owner_username TEXT NOT NULL,
    room_type TEXT NOT NULL DEFAULT 'temporary', status TEXT NOT NULL DEFAULT 'active',
    is_public INTEGER DEFAULT 1, require_approval INTEGER DEFAULT 0,
    password TEXT DEFAULT '', description TEXT DEFAULT '',
    tts_voice TEXT DEFAULT 'nu-nam', created_at INTEGER NOT NULL, last_active INTEGER NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS room_admins (
    room_id TEXT NOT NULL, username TEXT NOT NULL, granted_by TEXT, granted_at INTEGER,
    PRIMARY KEY (room_id, username))`);
  db.run(`CREATE TABLE IF NOT EXISTS room_bans (
    room_id TEXT NOT NULL, username TEXT NOT NULL, banned_by TEXT, banned_at INTEGER,
    reason TEXT DEFAULT '', PRIMARY KEY (room_id, username))`);
  db.run(`CREATE TABLE IF NOT EXISTS room_mutes (
    room_id TEXT NOT NULL, username TEXT NOT NULL, PRIMARY KEY (room_id, username))`);
});

// Sync-style DB wrappers (used throughout)
const stmts = {
  getRoom:     (id)        => dbGet('SELECT * FROM rooms WHERE room_id=?',[id]),
  createRoom:  (id,owner,type,status,pub,appr,pass,desc,ca,la) => dbRun('INSERT OR IGNORE INTO rooms (room_id,owner_username,room_type,status,is_public,require_approval,password,description,created_at,last_active) VALUES (?,?,?,?,?,?,?,?,?,?)',[id,owner,type,status,pub,appr,pass,desc,ca,la]),
  updateRoom:  (status,pub,appr,pass,desc,la,voice,id) => dbRun('UPDATE rooms SET status=?,is_public=?,require_approval=?,password=?,description=?,last_active=?,tts_voice=? WHERE room_id=?',[status,pub,appr,pass,desc,la,voice,id]),
  setStatus:   (status,la,id) => dbRun('UPDATE rooms SET status=?,last_active=? WHERE room_id=?',[status,la,id]),
  setVoice:    (voice,id)  => dbRun('UPDATE rooms SET tts_voice=? WHERE room_id=?',[voice,id]),
  getAdmins:   (id)        => dbAll('SELECT username FROM room_admins WHERE room_id=?',[id]),
  addAdmin:    (id,u,by,at)=> dbRun('INSERT OR IGNORE INTO room_admins (room_id,username,granted_by,granted_at) VALUES (?,?,?,?)',[id,u,by,at]),
  removeAdmin: (id,u)      => dbRun('DELETE FROM room_admins WHERE room_id=? AND username=?',[id,u]),
  isBanned:    (id,u)      => dbGet('SELECT 1 FROM room_bans WHERE room_id=? AND username=?',[id,u]),
  addBan:      (id,u,by,at,r)=> dbRun('INSERT OR IGNORE INTO room_bans (room_id,username,banned_by,banned_at,reason) VALUES (?,?,?,?,?)',[id,u,by,at,r]),
  removeBan:   (id,u)      => dbRun('DELETE FROM room_bans WHERE room_id=? AND username=?',[id,u]),
  isMuted:     (id,u)      => dbGet('SELECT 1 FROM room_mutes WHERE room_id=? AND username=?',[id,u]),
  addMute:     (id,u)      => dbRun('INSERT OR IGNORE INTO room_mutes (room_id,username) VALUES (?,?)',[id,u]),
  removeMute:  (id,u)      => dbRun('DELETE FROM room_mutes WHERE room_id=? AND username=?',[id,u]),
  publicRooms: ()          => dbAll("SELECT * FROM rooms WHERE is_public=1 AND status='active'",[]),
};

async function isAdmin(roomId, username) {
  const row = await dbGet('SELECT 1 FROM room_admins WHERE room_id=? AND username=?',[roomId,username]);
  return !!row;
}
async function isOwnerFn(roomId, username) {
  const row = await stmts.getRoom(roomId);
  return row && row.owner_username === username;
}
async function hasAdminPrivilege(roomId, username) {
  return (await isOwnerFn(roomId,username)) || (await isAdmin(roomId,username));
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

app.get('/health', async (_, res) => res.json({ status:'ok', version:'11.0.4' }));

// ══════════════════════════════════════════════════════════
//  TTS PROVIDER MANAGER — tự động fallback, admin quản lý
// ══════════════════════════════════════════════════════════
const https_mod = require('https');
const tts_agent = new (require('https').Agent)({keepAlive:true,maxSockets:10});
const ttsCache = new Map();
const TTS_CACHE_MAX = 200;

// Providers theo thứ tự ưu tiên
const TTS_PROVIDERS = [
  {id:'google-vn', name:'Google (.com.vn)', type:'google', domain:'translate.google.com.vn', enabled:true, failCount:0, lastFail:0},
  {id:'google-com',name:'Google (.com)',    type:'google', domain:'translate.google.com',    enabled:true, failCount:0, lastFail:0},
  {id:'google-api',name:'Google (APIs)',    type:'google', domain:'translate.googleapis.com', enabled:true, failCount:0, lastFail:0},
  {id:'fptai',     name:'FPT.AI TTS',      type:'fptai',  apiKey:'', voice:'banmai',          enabled:false,failCount:0, lastFail:0},
];
const FAIL_COOLDOWN=5*60*1000; // 5 phút cooldown sau 3 lần fail
const MAX_FAIL=3;

function loadTTSConfig(){
  try{
    const r=db.prepare('SELECT value FROM kv WHERE key=?').get('tts_providers');
    if(r){JSON.parse(r.value).forEach(s=>{const p=TTS_PROVIDERS.find(x=>x.id===s.id);if(p){if(s.enabled!==undefined)p.enabled=s.enabled;if(s.apiKey)p.apiKey=s.apiKey;if(s.voice)p.voice=s.voice;}});}
  }catch(e){}
}
function saveTTSConfig(){
  try{db.prepare('INSERT OR REPLACE INTO kv(key,value) VALUES(?,?)').run('tts_providers',JSON.stringify(TTS_PROVIDERS.map(p=>({id:p.id,enabled:p.enabled,apiKey:p.apiKey||'',voice:p.voice||''}))));}catch(e){}
}
// Init KV table + load config after DB ready
db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)');
setTimeout(loadTTSConfig,800);

function getActiveProviders(){
  const now=Date.now();
  return TTS_PROVIDERS.filter(p=>{
    if(!p.enabled)return false;
    if(p.type==='fptai'&&!p.apiKey)return false;
    if(p.failCount>=MAX_FAIL&&now-p.lastFail<FAIL_COOLDOWN)return false;
    return true;
  });
}

function splitChunks(text,max=180){
  if(text.length<=max)return[text];
  const chunks=[];const words=text.split(' ');let cur='';
  for(const w of words){if((cur+' '+w).trim().length>max){if(cur)chunks.push(cur.trim());cur=w;}else cur=(cur+' '+w).trim();}
  if(cur)chunks.push(cur.trim());
  return chunks.length?chunks:[text.substring(0,max)];
}

function fetchGoogleChunk(text,domain){
  return new Promise((resolve,reject)=>{
    const enc=encodeURIComponent(text);
    const url=`https://${domain}/translate_tts?ie=UTF-8&q=${enc}&tl=vi&total=1&idx=0&textlen=${text.length}&client=tw-ob&prev=input&ttsspeed=0.9`;
    const req=https_mod.get(url,{agent:tts_agent,timeout:7000,headers:{
      'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
      'Referer':`https://${domain}/`,'Accept':'audio/mpeg,audio/*;q=0.9','Accept-Language':'vi-VN,vi;q=0.9',
    }},res=>{
      const chunks=[];res.on('data',d=>chunks.push(d));
      res.on('end',()=>{const buf=Buffer.concat(chunks);if(res.statusCode===200&&buf.length>300)resolve(buf);else reject(new Error(`${domain} ${res.statusCode} size=${buf.length}`));});
    });
    req.on('error',reject);req.on('timeout',()=>{req.destroy();reject(new Error(`${domain} timeout`));});
  });
}

async function fetchFPTChunk(text,apiKey,voice){
  return new Promise((resolve,reject)=>{
    const options={hostname:'api.fpt.ai',path:'/hmi/tts/v5',method:'POST',timeout:10000,agent:tts_agent,
      headers:{'api-key':apiKey,'voice':voice||'banmai','speed':'','Content-Type':'text/plain','Content-Length':Buffer.byteLength(text)}};
    const req=https_mod.request(options,res=>{
      const chunks=[];res.on('data',d=>chunks.push(d));
      res.on('end',async()=>{
        try{
          const j=JSON.parse(Buffer.concat(chunks).toString());
          if(j.error===0&&j.async){
            for(let i=0;i<8;i++){
              await new Promise(r=>setTimeout(r,1000));
              try{
                const audioBuf=await new Promise((r2,rj)=>{https_mod.get(j.async,{agent:tts_agent,timeout:5000},rs=>{const ac=[];rs.on('data',d=>ac.push(d));rs.on('end',()=>{const b=Buffer.concat(ac);if(rs.statusCode===200&&b.length>300)r2(b);else rj(new Error('not ready'));});}).on('error',rj);});
                return resolve(audioBuf);
              }catch(e){continue;}
            }
            reject(new Error('FPT audio timeout'));
          }else reject(new Error('FPT: '+JSON.stringify(j)));
        }catch(e){reject(e);}
      });
    });
    req.on('error',reject);req.on('timeout',()=>{req.destroy();reject(new Error('FPT timeout'));});
    req.write(text);req.end();
  });
}

async function ttsWithFallback(text){
  const providers=getActiveProviders();
  if(!providers.length)throw new Error('Không có TTS provider nào khả dụng');
  for(const p of providers){
    try{
      let buf;
      if(p.type==='google'){const parts=splitChunks(text);const bufs=await Promise.all(parts.map(ch=>fetchGoogleChunk(ch,p.domain)));buf=Buffer.concat(bufs);}
      else if(p.type==='fptai')buf=await fetchFPTChunk(text,p.apiKey,p.voice);
      p.failCount=0;
      console.log(`[TTS] OK via ${p.name}`);
      return buf;
    }catch(e){
      p.failCount++;p.lastFail=Date.now();
      console.warn(`[TTS] ${p.name} fail (${p.failCount}): ${e.message}`);
    }
  }
  throw new Error('Tất cả TTS providers thất bại');
}

app.post('/tts',express.json(),async(req,res)=>{
  const{text=''}=req.body||{};
  if(!text||text.length>500)return res.status(400).json({error:'text required'});
  const ck=`vi::${text.substring(0,200)}`;
  if(ttsCache.has(ck)){res.setHeader('Content-Type','audio/mpeg');res.setHeader('Cache-Control','public,max-age=7200');return res.end(ttsCache.get(ck));}
  try{
    const buf=await ttsWithFallback(text);
    if(ttsCache.size>=TTS_CACHE_MAX)ttsCache.delete(ttsCache.keys().next().value);
    ttsCache.set(ck,buf);
    res.setHeader('Content-Type','audio/mpeg');res.setHeader('Cache-Control','public,max-age=7200');res.end(buf);
  }catch(e){console.error('[TTS]',e.message);res.status(503).json({error:e.message});}
});

// ── ADMIN TTS APIs (dùng từ trong app) ────────────────────
// Admin API không cần key riêng — chỉ dùng nội bộ từ browser owner
app.get('/admin/tts',async(req,res)=>{
  res.json(TTS_PROVIDERS.map(p=>({id:p.id,name:p.name,type:p.type,enabled:p.enabled,
    failCount:p.failCount,status:p.failCount>=MAX_FAIL&&Date.now()-p.lastFail<FAIL_COOLDOWN?'cooling':'ok',
    hasKey:!!(p.apiKey),voice:p.voice||''})));
});
app.post('/admin/tts/:id',express.json(),async(req,res)=>{
  const p=TTS_PROVIDERS.find(x=>x.id===req.params.id);
  if(!p)return res.status(404).json({error:'Not found'});
  const{enabled,apiKey,voice,resetFail}=req.body||{};
  if(typeof enabled==='boolean')p.enabled=enabled;
  if(typeof apiKey==='string')p.apiKey=apiKey.trim();
  if(typeof voice==='string')p.voice=voice.trim();
  if(resetFail){p.failCount=0;p.lastFail=0;}
  saveTTSConfig();
  res.json({ok:true,id:p.id,name:p.name,enabled:p.enabled});
});
app.post('/admin/tts-test',express.json(),async(req,res)=>{
  const{providerId,text='Xin chào bộ đàm web'}=req.body||{};
  const p=TTS_PROVIDERS.find(x=>x.id===providerId);
  if(!p)return res.status(404).json({error:'Not found'});
  const t0=Date.now();
  try{
    let buf;
    if(p.type==='google')buf=await fetchGoogleChunk(text,p.domain);
    else buf=await fetchFPTChunk(text,p.apiKey,p.voice);
    res.json({ok:true,provider:p.name,ms:Date.now()-t0,size:buf.length});
  }catch(e){res.json({ok:false,provider:p.name,error:e.message,ms:Date.now()-t0});}
});


app.get('/vapid-public-key', async (_, res) => res.json({ key: VAPID_PUBLIC_KEY }));
app.get('/rooms', async (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  let rows = await stmts.publicRooms();
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

async function userList(roomId) {
  if (!activeRooms[roomId]) return [];
  const roomRow = await stmts.getRoom(roomId);
  const ownerName = roomRow?.owner_username;
  const entries = Object.entries(activeRooms[roomId]);
  // Precompute async fields
  const results = await Promise.all(entries.map(async ([id, d]) => {
    const muted = !!(await stmts.isMuted(roomId, d.username));
    const adminFlag = !!(await dbGet('SELECT 1 FROM room_admins WHERE room_id=? AND username=?',[roomId, d.username]));
    return {
      id, username: d.username,
      lat: d.lat, lng: d.lng,
      ping: d.ping || null, battery: d.battery || null,
      muted, isOwner: d.username === ownerName, isAdmin: adminFlag,
      hasCamera: d.hasCamera || false, cameraOn: d.cameraOn || false,
    };
  }));
  return results;
}
async function broadcastUsers(roomId) { io.to(roomId).emit('user-list', await userList(roomId)); }

function clearMicTo(roomId) { if (micTimeouts[roomId]) { clearTimeout(micTimeouts[roomId]); delete micTimeouts[roomId]; } }
async function releaseMic(roomId, reason) {
  const h = micHolders[roomId]; if (!h) return;
  micHolders[roomId] = null; clearMicTo(roomId);
  io.to(roomId).emit('speaking-stop', { username: h.username, reason: reason || 'released' });
}
async function grantMic(roomId, socket, username) {
  micHolders[roomId] = { socketId: socket.id, username, sinceTs: Date.now() };
  clearMicTo(roomId);
  micTimeouts[roomId] = setTimeout(() => releaseMic(roomId, 'timeout'), MAX_MIC_MS);
  socket.emit('mic-granted', { username });
  io.to(roomId).emit('speaking-start', { username });
  sendPush(roomId, { title:`🎙️ ${username} đang nói`, body:`Phòng ${roomId}`, tag:'botdam-speaking' }, socket.id);
}

async function destroyRoom(roomId) {
  // Temporary room: wipe everything
  delete activeRooms[roomId];
  delete micHolders[roomId];
  delete approvalQueue[roomId];
  delete voiceMemos[roomId];
  delete pushSubs[roomId];
  clearMicTo(roomId);
  // DB: delete temporary room entirely
  const row = await stmts.getRoom(roomId);
  if (row && row.room_type === 'temporary') {
    await dbRun('DELETE FROM rooms WHERE room_id=?',[roomId]);
    await dbRun('DELETE FROM room_admins WHERE room_id=?',[roomId]);
    await dbRun('DELETE FROM room_mutes WHERE room_id=?',[roomId]);
  }
}

async function hibernateRoom(roomId) {
  // Permanent room: keep DB, just mark offline
  await stmts.setStatus('hibernated', Date.now(), roomId);
  delete activeRooms[roomId];
  delete micHolders[roomId];
  delete approvalQueue[roomId];
  clearMicTo(roomId);
  console.log(`[Room] ${roomId} → hibernated`);
}

async function wakeRoom(roomId) {
  await stmts.setStatus('active', Date.now(), roomId);
  if (!activeRooms[roomId]) activeRooms[roomId] = {};
  console.log(`[Room] ${roomId} → active (wake)`);
}

// ── CORE JOIN/LEAVE ────────────────────────────────────────
async function doJoin(socket, roomId, username) {
  socket.join(roomId);
  socket.data.roomCode = roomId;
  socket.data.username = username;
  socket.data.pendingRoom = null;

  if (!activeRooms[roomId]) activeRooms[roomId] = {};
  activeRooms[roomId][socket.id] = { username, lat:null, lng:null, ping:null, battery:null, hasCamera:false, cameraOn:false, status:'online' };
  if (!(roomId in micHolders)) micHolders[roomId] = null;
  if (!approvalQueue[roomId]) approvalQueue[roomId] = [];

  const roomRow = await stmts.getRoom(roomId);
  const ownerName = roomRow?.owner_username;
  const userIsOwner = username === ownerName;
  const userIsAdmin = await isAdmin(roomId, username);

  // Wake permanent room if needed
  if (roomRow?.status === 'hibernated' && (userIsOwner || userIsAdmin)) {
    await wakeRoom(roomId);
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
  await broadcastUsers(roomId);
  socket.to(roomId).emit('system-message', `${username} đã vào phòng.`);

  const h = micHolders[roomId];
  if (h) socket.emit('speaking-start', { username: h.username });
  if (voiceMemos[roomId]) {
    const m = voiceMemos[roomId];
    socket.emit('voice-memo', { username: m.username, audio: m.audioBuffer, ts: m.ts });
  }
}

async function doLeave(socket) {
  const { roomCode: roomId, username } = socket.data;
  if (!roomId || !activeRooms[roomId]) return;

  const h = micHolders[roomId];
  if (h && h.socketId === socket.id) await releaseMic(roomId, 'left');
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
    const roomRow = await stmts.getRoom(roomId);
    if (!roomRow) { await destroyRoom(roomId); return; }
    if (roomRow.room_type === 'permanent') {
      await hibernateRoom(roomId);
    } else {
      await destroyRoom(roomId);
    }
    return;
  }

  await broadcastUsers(roomId);
  // If owner left temporary room → transfer ownership to first remaining
  const roomRow = await stmts.getRoom(roomId);
  if (roomRow && roomRow.owner_username === username && roomRow.room_type === 'temporary') {
    const nextEntry = Object.values(activeRooms[roomId])[0];
    if (nextEntry) {
      await dbRun('UPDATE rooms SET owner_username=? WHERE room_id=?',nextEntry.username, roomId);
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
      await broadcastUsers(roomId);
    }
  }
}

// ── SOCKET EVENTS ──────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[+] ${socket.id}`);

  socket.on('join-room', async ({ roomCode, username, password }) => {
    if (!roomCode || !username) return socket.emit('join-error', 'Thiếu thông tin.');
    roomCode = String(roomCode).trim().substring(0, 20);
    username = String(username).trim().replace(/\s+/g, ' ').substring(0, 30);
    if (!ROOM_RE.test(roomCode)) return socket.emit('join-error', 'Mã phòng không hợp lệ (3-20 ký tự, không dấu cách).');
    if (!NAME_RE.test(username)) return socket.emit('join-error', 'Tên không hợp lệ — chỉ dùng chữ cái và dấu cách.');

    // Check ban
    if (await stmts.isBanned(roomCode, username)) return socket.emit('join-error', 'Bạn đã bị cấm vào phòng này.');

    await doLeave(socket);
    let roomRow = await stmts.getRoom(roomCode);

    if (!roomRow) {
      // Create new temporary room
      await stmts.createRoom(roomCode, username, 'temporary', 'active', 1, 0, '', '', Date.now(), Date.now());
      roomRow = await stmts.getRoom(roomCode);
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
      const admins = await stmts.getAdmins(roomCode).map(r => r.username);
      if (activeRooms[roomCode]) {
        Object.entries(activeRooms[roomCode]).forEach(([sid, d]) => {
          if (admins.includes(d.username)) io.to(sid).emit('approval-request', { socketId: socket.id, username, roomCode });
        });
      }
      return;
    }

    await doJoin(socket, roomCode, username);
  });

  socket.on('create-room-options', async ({ password, isPublic, requireApproval, description, isPermanent }) => {
    const { roomCode: code, username } = socket.data;
    if (!code || !await isOwnerFn(code, username)) return;
    const roomRow = await stmts.getRoom(code);
    if (!roomRow) return;
    await stmts.updateRoom(
      'active',
      typeof isPublic === 'boolean' ? (isPublic ? 1 : 0) : roomRow.is_public,
      typeof requireApproval === 'boolean' ? (requireApproval ? 1 : 0) : roomRow.require_approval,
      typeof password === 'string' ? password.substring(0, 30) : roomRow.password,
      typeof description === 'string' ? description.substring(0, 80) : roomRow.description,
      Date.now(),
      roomRow.tts_voice,
      code
    );
    if (isPermanent) await dbRun("UPDATE rooms SET room_type='permanent' WHERE room_id=?",[code]);
  });

  socket.on('rejoin-room', async ({ roomCode, username }) => {
    if (!roomCode || !username) return;
    roomCode = String(roomCode).trim().substring(0, 20);
    username = String(username).trim().replace(/\s+/g, ' ').substring(0, 30);
    if (!ROOM_RE.test(roomCode) || !NAME_RE.test(username)) return;
    if (await stmts.isBanned(roomCode, username)) return socket.emit('kicked', { reason: 'Bạn đã bị cấm vào phòng này.' });
    const roomRow = await stmts.getRoom(roomCode);
    if (!roomRow || (roomRow.status === 'active' && !activeRooms[roomCode])) {
      return socket.emit('room-closed', { roomCode });
    }
    await doJoin(socket, roomCode, username);
  });

  socket.on('approve-user', async ({ targetSocketId }) => {
    const { roomCode: code, username } = socket.data;
    if (!code || !await hasAdminPrivilege(code, username)) return;
    const q = approvalQueue[code] || [];
    const idx = q.findIndex(r => r.socketId === targetSocketId);
    if (idx === -1) return;
    const { username: targetName } = q[idx];
    approvalQueue[code].splice(idx, 1);
    socket.emit('approval-done', { socketId: targetSocketId });
    const t = io.sockets.sockets.get(targetSocketId);
    if (!t) return;
    await doJoin(t, code, targetName);
    t.emit('approval-granted', { roomCode: code });
  });

  socket.on('reject-user', async ({ targetSocketId }) => {
    const { roomCode: code, username } = socket.data;
    if (!code || !await hasAdminPrivilege(code, username)) return;
    const q = approvalQueue[code] || [];
    const idx = q.findIndex(r => r.socketId === targetSocketId);
    if (idx === -1) return;
    const { username: targetName } = q[idx];
    approvalQueue[code].splice(idx, 1);
    socket.emit('approval-done', { socketId: targetSocketId });
    io.sockets.sockets.get(targetSocketId)?.emit('approval-rejected', { roomCode: code });
    io.to(code).emit('system-message', `❌ ${targetName} bị từ chối.`);
  });

  socket.on('update-room-settings', async ({ isPublic, requireApproval, password, description }) => {
    const { roomCode: code, username } = socket.data;
    if (!code || !await hasAdminPrivilege(code, username)) return;
    const row = await stmts.getRoom(code); if (!row) return;
    await stmts.updateRoom(
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
  socket.on('add-admin', async ({ targetUsername }) => {
    const { roomCode: code, username } = socket.data;
    if (!code || !await isOwnerFn(code, username)) return;
    if (isOwner(code, targetUsername)) return;
    await stmts.addAdmin(code, targetUsername, username, Date.now());
    const target = activeRooms[code] && Object.entries(activeRooms[code]).find(([,d]) => d.username === targetUsername);
    if (target) {
      io.to(target[0]).emit('you-are-admin');
      stmts.getRoom(code).then(r => {
        if(r) io.to(target[0]).emit('room-settings', { isPublic:!!r.is_public, requireApproval:!!r.require_approval, description:r.description, hasPassword:!!r.password, isPermanent:r.room_type==='permanent', ttsVoice:r.tts_voice });
      });
    }
    io.to(code).emit('system-message', `👑 ${targetUsername} được thăng làm Admin phòng.`);
    await broadcastUsers(code);
  });

  socket.on('remove-admin', async ({ targetUsername }) => {
    const { roomCode: code, username } = socket.data;
    if (!code || !await isOwnerFn(code, username)) return;
    await stmts.removeAdmin(code, targetUsername);
    const target = activeRooms[code] && Object.entries(activeRooms[code]).find(([,d]) => d.username === targetUsername);
    if (target) io.to(target[0]).emit('you-are-demoted');
    io.to(code).emit('system-message', `🔽 ${targetUsername} đã bị thu hồi quyền Admin.`);
    await broadcastUsers(code);
  });

  // ── BAN ────────────────────────────────────────────────────
  socket.on('ban-user', async ({ targetId, reason }) => {
    const { roomCode: code, username } = socket.data;
    if (!code || !await hasAdminPrivilege(code, username)) return;
    const target = activeRooms[code]?.[targetId]; if (!target) return;
    if (await isOwnerFn(code, target.username)) return;
    await stmts.addBan(code, target.username, username, Date.now(), reason || '');
    const t = io.sockets.sockets.get(targetId);
    if (t) { t.emit('kicked', { reason: `Bạn đã bị cấm: ${reason || 'Vi phạm nội quy'}` }); await doLeave(t); }
    io.to(code).emit('system-message', `🚫 ${target.username} đã bị cấm vào phòng.`);
  });

  socket.on('unban-user', async ({ targetUsername }) => {
    const { roomCode: code, username } = socket.data;
    if (!code || !await hasAdminPrivilege(code, username)) return;
    await stmts.removeBan(code, targetUsername);
    io.to(code).emit('system-message', `✅ ${targetUsername} đã được gỡ lệnh cấm.`);
  });

  // ── TTS VOICE FOR ROOM ────────────────────────────────────
  socket.on('set-room-tts-voice', async ({ voice, voiceLabel }) => {
    const { roomCode: code, username } = socket.data;
    if (!code || !await hasAdminPrivilege(code, username)) return;
    const allowed = ['nu-nam','nu-bac','nam-nam','nam-bac'];
    if (!allowed.includes(voice)) return;
    await stmts.setVoice(voice, code);
    socket.to(code).emit('room-tts-voice', { voice, voiceLabel });
    io.to(code).emit('system-message', `🔊 Admin đặt giọng đọc: ${voiceLabel || voice}`);
  });

  socket.on('save-subscription', sub => {
    const { roomCode: code } = socket.data;
    if (!code || !sub?.endpoint) return;
    if (!pushSubs[code]) pushSubs[code] = new Map();
    pushSubs[code].set(socket.id, sub);
  });

  socket.on('update-location', async ({ lat, lng }) => {
    const { roomCode: code } = socket.data;
    if (!code || !activeRooms[code]?.[socket.id]) return;
    if (typeof lat !== 'number' || typeof lng !== 'number') return;
    activeRooms[code][socket.id].lat = lat;
    activeRooms[code][socket.id].lng = lng;
    await broadcastUsers(code);
  });

  socket.on('update-status', async ({ ping, battery, status }) => {
    const { roomCode: code } = socket.data;
    if (!code || !activeRooms[code]?.[socket.id]) return;
    if (typeof ping === 'number') activeRooms[code][socket.id].ping = ping;
    if (typeof battery === 'number') activeRooms[code][socket.id].battery = battery;
    if (status && ['online','away','busy','offline'].includes(status)){
      activeRooms[code][socket.id].status = status;
    }
    await broadcastUsers(code);
  });

  socket.on('ping-custom', async () => socket.emit('pong-custom'));

  socket.on('start-speaking', async () => {
    const { roomCode: code, username } = socket.data;
    if (!code) return;
    if (await stmts.isMuted(code, username)) return socket.emit('mic-denied', { holder: 'Chủ phòng (mic bị khoá)' });
    const h = micHolders[code];
    if (!h) await grantMic(code, socket, username);
    else if (h.socketId === socket.id) {}
    else socket.emit('mic-denied', { holder: h.username });
  });

  socket.on('stop-speaking', async () => {
    const { roomCode: code } = socket.data;
    if (!code) return;
    if (micHolders[code]?.socketId === socket.id) await releaseMic(code, 'released');
  });

  socket.on('audio-data', buf => {
    const { roomCode: code, username } = socket.data;
    if (!code || !buf) return;
    if (micHolders[code]?.socketId !== socket.id) return;
    socket.to(code).emit('audio-data', { username, audio: buf });
    voiceMemos[code] = { username, audioBuffer: buf, ts: Date.now() };
  });

  socket.on('camera-state', async ({ hasCamera, cameraOn }) => {
    const { roomCode: code } = socket.data;
    if (!code || !activeRooms[code]?.[socket.id]) return;
    if (typeof hasCamera === 'boolean') activeRooms[code][socket.id].hasCamera = hasCamera;
    if (typeof cameraOn === 'boolean') activeRooms[code][socket.id].cameraOn = cameraOn;
    await broadcastUsers(code);
  });

  socket.on('video-frame', async ({ frame }) => {
    const { roomCode: code, username } = socket.data;
    if (!code || !frame) return;
    socket.to(code).emit('video-frame', { username, frame });
  });

  socket.on('force-camera-off', async ({ targetId }) => {
    const { roomCode: code, username } = socket.data;
    if (!code || !await hasAdminPrivilege(code, username)) return;
    io.sockets.sockets.get(targetId)?.emit('camera-forced-off');
    if (activeRooms[code]?.[targetId]) { activeRooms[code][targetId].cameraOn = false; activeRooms[code][targetId].hasCamera = false; await broadcastUsers(code); }
  });

  socket.on('request-camera-on', async ({ targetId }) => {
    const { roomCode: code, username: ownerName } = socket.data;
    if (!code || !hasAdminPrivilege(code, ownerName)) return;
    const t = io.sockets.sockets.get(targetId);
    if (!t) return;
    t.emit('camera-on-requested', { fromOwner: ownerName });
    sendPushToSocket(targetId, { title:'📷 Yêu cầu bật camera', body:`${ownerName} yêu cầu bạn bật camera`, tag:'botdam-cam-req' }, code);
  });

  socket.on('request-mic-on', async ({ targetId }) => {
    const { roomCode: code, username: ownerName } = socket.data;
    if (!code || !hasAdminPrivilege(code, ownerName)) return;
    const t = io.sockets.sockets.get(targetId);
    if (!t || !activeRooms[code]?.[targetId]) return;
    if (await stmts.isMuted(code, activeRooms[code][targetId].username)) {
      await stmts.removeMute(code, activeRooms[code][targetId].username);
      await broadcastUsers(code);
    }
    t.emit('mic-on-requested', { fromOwner: ownerName });
    sendPushToSocket(targetId, { title:'🎙️ Yêu cầu bật mic', body:`${ownerName} yêu cầu bạn nói ngay!`, tag:'botdam-mic-req' }, code);
  });

  socket.on('sos', async ({ lat, lng }) => {
    const { roomCode: code, username } = socket.data;
    if (!code || !username) return;
    io.to(code).emit('sos-alert', { username, lat, lng, ts: Date.now() });
    sendPush(code, { title:`🆘 SOS từ ${username}!`, body:`Cần hỗ trợ - Phòng ${code}`, tag:'botdam-sos' }, socket.id);
  });

  socket.on('chat-message', async ({ text }) => {
    const { roomCode: code, username } = socket.data;
    if (!code || !username || !text) return;
    const msg = String(text).trim().substring(0, 300);
    if (!msg) return;
    io.to(code).emit('chat-message', { username, text: msg, ts: Date.now() });
    sendPush(code, { title:`💬 ${username}`, body: msg.length > 80 ? msg.substring(0,80)+'…' : msg, tag:'botdam-chat', chatText: msg, sender: username }, socket.id);
  });

  socket.on('kick-user', async ({ targetId }) => {
    const { roomCode: code, username } = socket.data;
    if (!code || !await hasAdminPrivilege(code, username)) return;
    const t = io.sockets.sockets.get(targetId);
    if (!t || !activeRooms[code]?.[targetId]) return;
    const name = activeRooms[code][targetId].username;
    if (await isOwnerFn(code, name)) return;
    t.emit('kicked', { reason: 'Chủ phòng đã mời bạn rời phòng.' });
    await doLeave(t);
    io.to(code).emit('system-message', `👢 ${name} đã bị mời ra.`);
  });

  socket.on('toggle-mute', async ({ targetId }) => {
    const { roomCode: code, username } = socket.data;
    if (!code || !await hasAdminPrivilege(code, username)) return;
    if (!activeRooms[code]?.[targetId]) return;
    const targetName = activeRooms[code][targetId].username;
    if (await isOwnerFn(code, targetName)) return;
    const wasMuted = !!(await stmts.isMuted(code, targetName));
    if (wasMuted) await stmts.removeMute(code, targetName);
    else { await stmts.addMute(code, targetName); if (micHolders[code]?.socketId === targetId) await releaseMic(code, 'muted'); }
    io.sockets.sockets.get(targetId)?.emit('you-are-muted', { muted: !wasMuted });
    io.to(code).emit('system-message', !wasMuted ? `🔇 ${targetName} bị tắt mic.` : `🔊 ${targetName} được bật mic.`);
    await broadcastUsers(code);
  });

  socket.on('add-admin-by-id', async ({ targetId }) => {
    const { roomCode: code, username } = socket.data;
    if (!code || !await isOwnerFn(code, username)) return;
    const target = activeRooms[code]?.[targetId]; if (!target) return;
    socket.emit('add-admin', { targetUsername: target.username });
    socket.emit('add-admin', { targetUsername: target.username });
  });

  // Shortcut: promote from member panel (targetId → username lookup)
  socket.on('promote-to-admin', async ({ targetId }) => {
    const { roomCode: code, username } = socket.data;
    if (!code || !await isOwnerFn(code, username)) return;
    const target = activeRooms[code]?.[targetId]; if (!target) return;
    if (await isOwnerFn(code, target.username)) return;
    await stmts.addAdmin(code, target.username, username, Date.now());
    const t = io.sockets.sockets.get(targetId);
    if (t) {
      const r = await stmts.getRoom(code);
      t.emit('you-are-admin');
      t.emit('room-settings', { isPublic:!!r.is_public, requireApproval:!!r.require_approval, description:r.description, hasPassword:!!r.password, isPermanent:r.room_type==='permanent', ttsVoice:r.tts_voice });
    }
    io.to(code).emit('system-message', `👑 ${target.username} được thăng làm Admin phòng.`);
    await broadcastUsers(code);
  });

  socket.on('demote-from-admin', async ({ targetId }) => {
    const { roomCode: code, username } = socket.data;
    if (!code || !await isOwnerFn(code, username)) return;
    const target = activeRooms[code]?.[targetId]; if (!target) return;
    await stmts.removeAdmin(code, target.username);
    io.sockets.sockets.get(targetId)?.emit('you-are-demoted');
    io.to(code).emit('system-message', `🔽 ${target.username} đã bị thu hồi quyền Admin.`);
    await broadcastUsers(code);
  });

  socket.on('reaction', async ({ emoji }) => {
    const { roomCode: code, username } = socket.data;
    if (!code || !emoji) return;
    io.to(code).emit('reaction', { username, emoji: String(emoji).substring(0, 8) });
  });

  socket.on('disconnect', async () => { await doLeave(socket); console.log(`[-] ${socket.id}`); });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`[Bộ Đàm Web] Server v11.0.4 on port ${PORT}`));
