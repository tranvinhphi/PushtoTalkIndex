/**
 * Walkie Talkie Web - Server v10.2.0
 * NEW: force-camera-on request, force-mic-on request (with browser notification),
 *      owner distinct color flag sent to client
 */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const webpush = require('web-push');

const app = express();
app.use(express.json());
app.use((req,res,next)=>{res.header('Access-Control-Allow-Origin','*');res.header('Access-Control-Allow-Methods','GET,POST,OPTIONS');res.header('Access-Control-Allow-Headers','Content-Type');if(req.method==='OPTIONS')return res.sendStatus(200);next()});
app.use(express.static(__dirname));
const server = http.createServer(app);

const VAPID_PUBLIC_KEY='BDTnYKWEcRAZbGHBaCekCGkDMzlnR5RZnhZKlRvrkTykxkSheHnc0xIkpYhE8_aiApr5IbhXTIRBJTkj4nUSzpc';
const VAPID_PRIVATE_KEY='f11gX6No3oeQWTsdwcI_31EQoG8HBCToU9oWV91rn0I';
webpush.setVapidDetails('mailto:admin@example.com',VAPID_PUBLIC_KEY,VAPID_PRIVATE_KEY);

const pushSubs={};
function sendPushToRoom(roomCode,{title,body,tag},excludeId){
  const m=pushSubs[roomCode];if(!m)return;
  const payload=JSON.stringify({title,body,tag,roomCode});
  m.forEach((sub,id)=>{if(id===excludeId)return;webpush.sendNotification(sub,payload).catch(e=>{if(e.statusCode===404||e.statusCode===410)m.delete(id)})});
}
function sendPushToUser(socketId,{title,body,tag},subMap){
  if(!subMap)return;
  const sub=subMap.get(socketId);if(!sub)return;
  webpush.sendNotification(sub,JSON.stringify({title,body,tag})).catch(()=>{});
}

const io=new Server(server,{cors:{origin:'*',methods:['GET','POST']},maxHttpBufferSize:10*1024*1024,pingTimeout:20000,pingInterval:10000});

app.get('/health',(_,res)=>res.json({status:'ok',version:'10.2.0'}));

// TTS handled client-side via ViettelAI direct call
app.get('/vapid-public-key',(_,res)=>res.json({key:VAPID_PUBLIC_KEY}));

const rooms={},roomMeta={},roomOwners={},micHolders={},micTimeouts={},approvalQueue={},voiceMemos={};
const MAX_HOLD_MS=90000;
const ROOM_CODE_RE=/^[A-Za-zÀ-ỹà-ỹ0-9_-]{3,20}$/;
const GIBBERISH=['test','asdf','asdfg','asdfgh','qwerty','qwe','zxcv','fdsa','lkjh','hjkl','lorem','ipsum','anonymous','nickname','unknown'];

function isRealName(raw){
  const n=raw.trim().replace(/\s+/g,' ');
  if(n.length<2||n.length>30)return false;
  if(!/^[\p{L}\s]+$/u.test(n))return false;
  if(/(.)\1{2,}/i.test(n.replace(/\s/g,'')))return false;
  const lo=n.toLowerCase();
  if(GIBBERISH.some(g=>lo.includes(g)))return false;
  if(new Set(lo.replace(/\s/g,'').split('')).size<2)return false;
  const hasVowel=w=>/[aeiouyAEIOUY]/.test(w.normalize('NFD').replace(/[\u0300-\u036f]/g,''));
  return n.split(' ').every(hasVowel);
}

function userList(code){
  if(!rooms[code])return[];
  const owner=roomOwners[code];
  return Object.entries(rooms[code]).map(([id,d])=>({
    id,username:d.username,lat:d.lat,lng:d.lng,ping:d.ping||null,battery:d.battery||null,
    muted:d.muted||false,isOwner:id===owner,hasCamera:d.hasCamera||false,cameraOn:d.cameraOn||false,
  }));
}
function broadcastUsers(code){io.to(code).emit('user-list',userList(code))}

function publicRooms(query){
  const q=(query||'').toLowerCase();const out=[];
  for(const [code,meta] of Object.entries(roomMeta)){
    if(!meta.isPublic)continue;
    const cnt=rooms[code]?Object.keys(rooms[code]).length:0;
    if(cnt===0)continue;
    if(q&&!code.toLowerCase().includes(q)&&!(meta.description||'').toLowerCase().includes(q))continue;
    out.push({code,memberCount:cnt,description:meta.description||'',requireApproval:meta.requireApproval||false,hasPassword:!!(meta.password),createdAt:meta.createdAt});
  }
  return out.sort((a,b)=>b.memberCount-a.memberCount);
}
app.get('/rooms',(req,res)=>res.json(publicRooms(req.query.q)));

function clearMicTo(code){if(micTimeouts[code]){clearTimeout(micTimeouts[code]);delete micTimeouts[code]}}
function releaseMic(code,reason){const h=micHolders[code];if(!h)return;micHolders[code]=null;clearMicTo(code);io.to(code).emit('speaking-stop',{username:h.username,reason:reason||'released'})}
function grantMic(code,socket,username){
  micHolders[code]={socketId:socket.id,username,sinceTs:Date.now()};
  clearMicTo(code);
  micTimeouts[code]=setTimeout(()=>releaseMic(code,'timeout'),MAX_HOLD_MS);
  socket.emit('mic-granted',{username});
  io.to(code).emit('speaking-start',{username});
  sendPushToRoom(code,{title:`🎙️ ${username} đang nói`,body:`Phòng ${code}`,tag:'botdam-speaking'},socket.id);
}

function sanitizeMeta(code){const m=roomMeta[code]||{};return{isPublic:m.isPublic,requireApproval:m.requireApproval,description:m.description,hasPassword:!!(m.password),createdAt:m.createdAt}}

function doJoin(socket,code,username){
  socket.join(code);
  socket.data.roomCode=code;socket.data.username=username;
  socket.data.pendingRoom=null;socket.data.pendingUsername=null;
  const isNew=!rooms[code];
  if(!rooms[code])rooms[code]={};
  rooms[code][socket.id]={username,lat:null,lng:null,ping:null,battery:null,muted:false,hasCamera:false,cameraOn:false};
  if(!(code in micHolders))micHolders[code]=null;
  if(!approvalQueue[code])approvalQueue[code]=[];
  if(isNew){
    roomOwners[code]=socket.id;
    if(!roomMeta[code])roomMeta[code]={isPublic:true,requireApproval:false,password:'',description:'',createdAt:Date.now()};
  }
  const isOwner=roomOwners[code]===socket.id;
  if(isOwner){
    socket.emit('you-are-owner');
    socket.emit('room-settings',sanitizeMeta(code));
    if(approvalQueue[code]?.length>0)approvalQueue[code].forEach(r=>socket.emit('approval-request',{socketId:r.socketId,username:r.username,roomCode:code}));
  }
  socket.emit('joined',{roomCode:code,username,isOwner});
  broadcastUsers(code);
  socket.to(code).emit('system-message',`${username} đã vào phòng.`);
  const h=micHolders[code];if(h)socket.emit('speaking-start',{username:h.username});
  if(voiceMemos[code]){const m=voiceMemos[code];socket.emit('voice-memo',{username:m.username,audio:m.audioBuffer,ts:m.ts})}
}

function doLeave(socket){
  const {roomCode:code,username}=socket.data;
  if(!code||!rooms[code])return;
  const h=micHolders[code];if(h&&h.socketId===socket.id)releaseMic(code,'left');
  if(rooms[code][socket.id]){rooms[code][socket.id].cameraOn=false;rooms[code][socket.id].hasCamera=false}
  delete rooms[code][socket.id];
  socket.leave(code);
  if(pushSubs[code])pushSubs[code].delete(socket.id);
  if(approvalQueue[code])approvalQueue[code]=approvalQueue[code].filter(r=>r.socketId!==socket.id);
  if(Object.keys(rooms[code]).length===0){
    delete rooms[code];delete micHolders[code];delete pushSubs[code];delete roomOwners[code];delete voiceMemos[code];delete approvalQueue[code];
    clearMicTo(code);
  }else{
    if(roomOwners[code]===socket.id){
      const next=Object.keys(rooms[code])[0];
      roomOwners[code]=next;
      const nextName=rooms[code][next].username;
      io.to(code).emit('system-message',`👑 ${nextName} trở thành Chủ phòng mới.`);
      io.to(next).emit('you-are-owner');
      io.to(next).emit('room-settings',sanitizeMeta(code));
      if(approvalQueue[code]?.length>0)approvalQueue[code].forEach(r=>io.to(next).emit('approval-request',{socketId:r.socketId,username:r.username,roomCode:code}));
    }
    broadcastUsers(code);
    io.to(code).emit('system-message',`${username||'Một người dùng'} đã rời phòng.`);
  }
}

io.on('connection',socket=>{
  console.log(`[+] ${socket.id}`);

  socket.on('join-room',({roomCode,username,password})=>{
    if(!roomCode||!username){socket.emit('join-error','Vui lòng nhập đầy đủ thông tin.');return}
    roomCode=String(roomCode).trim().substring(0,20);
    username=String(username).trim().replace(/\s+/g,' ').substring(0,30);
    if(!ROOM_CODE_RE.test(roomCode)){socket.emit('join-error','Mã phòng không hợp lệ.');return}
    if(!isRealName(username)){socket.emit('join-error','Tên không hợp lệ - chỉ dùng chữ cái.');return}
    const meta=roomMeta[roomCode];
    if(meta?.password&&rooms[roomCode]){if(!password||password!==meta.password){socket.emit('join-error','Sai mật khẩu phòng.');return}}
    const lo=username.toLowerCase();
    const isSelf=socket.data.roomCode===roomCode&&socket.data.username?.toLowerCase()===lo;
    if(!isSelf&&rooms[roomCode]){if(Object.values(rooms[roomCode]).some(u=>u.username.toLowerCase()===lo)){socket.emit('join-error',`Tên "${username}" đã có người dùng trong phòng này.`);return}}
    doLeave(socket);
    const roomExists=!!rooms[roomCode];
    const isOwnerJoining=roomOwners[roomCode]===socket.id;
    if(roomExists&&meta?.requireApproval&&!isOwnerJoining){
      if(!approvalQueue[roomCode])approvalQueue[roomCode]=[];
      if(!approvalQueue[roomCode].find(r=>r.username.toLowerCase()===lo))approvalQueue[roomCode].push({socketId:socket.id,username,requestedAt:Date.now()});
      socket.data.pendingRoom=roomCode;socket.data.pendingUsername=username;
      socket.emit('waiting-approval',{roomCode,username});
      io.to(roomOwners[roomCode]).emit('approval-request',{socketId:socket.id,username,roomCode});
      return;
    }
    doJoin(socket,roomCode,username);
  });

  socket.on('create-room-options',({password,isPublic,requireApproval,description})=>{
    const code=socket.data.roomCode;
    if(!code||roomOwners[code]!==socket.id)return;
    if(!roomMeta[code])roomMeta[code]={isPublic:true,requireApproval:false,password:'',description:'',createdAt:Date.now()};
    if(typeof isPublic==='boolean')roomMeta[code].isPublic=isPublic;
    if(typeof requireApproval==='boolean')roomMeta[code].requireApproval=requireApproval;
    if(typeof password==='string')roomMeta[code].password=password.substring(0,30);
    if(typeof description==='string')roomMeta[code].description=description.substring(0,80);
    socket.emit('room-settings',sanitizeMeta(code));
  });

  socket.on('rejoin-room',({roomCode,username})=>{
    if(!roomCode||!username)return;
    roomCode=String(roomCode).trim().substring(0,20);
    username=String(username).trim().replace(/\s+/g,' ').substring(0,30);
    if(!ROOM_CODE_RE.test(roomCode)||!isRealName(username))return;
    if(!rooms[roomCode]){socket.emit('room-closed',{roomCode});return}
    doJoin(socket,roomCode,username);
  });

  socket.on('approve-user',({targetSocketId})=>{
    const {roomCode:code}=socket.data;if(!code||roomOwners[code]!==socket.id)return;
    const q=approvalQueue[code]||[];const idx=q.findIndex(r=>r.socketId===targetSocketId);if(idx===-1)return;
    const {username}=q[idx];approvalQueue[code].splice(idx,1);
    socket.emit('approval-done',{socketId:targetSocketId});
    const t=io.sockets.sockets.get(targetSocketId);if(!t)return;
    doJoin(t,code,username);t.emit('approval-granted',{roomCode:code});
  });

  socket.on('reject-user',({targetSocketId})=>{
    const {roomCode:code}=socket.data;if(!code||roomOwners[code]!==socket.id)return;
    const q=approvalQueue[code]||[];const idx=q.findIndex(r=>r.socketId===targetSocketId);if(idx===-1)return;
    const {username}=q[idx];approvalQueue[code].splice(idx,1);
    socket.emit('approval-done',{socketId:targetSocketId});
    io.sockets.sockets.get(targetSocketId)?.emit('approval-rejected',{roomCode:code});
    io.to(code).emit('system-message',`❌ ${username} bị từ chối.`);
  });

  socket.on('update-room-settings',({isPublic,requireApproval,password,description})=>{
    const {roomCode:code}=socket.data;if(!code||roomOwners[code]!==socket.id)return;
    if(!roomMeta[code])roomMeta[code]={isPublic:true,requireApproval:false,password:'',description:'',createdAt:Date.now()};
    if(typeof isPublic==='boolean')roomMeta[code].isPublic=isPublic;
    if(typeof requireApproval==='boolean')roomMeta[code].requireApproval=requireApproval;
    if(typeof password==='string')roomMeta[code].password=password.substring(0,30);
    if(typeof description==='string')roomMeta[code].description=description.substring(0,80);
    socket.emit('room-settings',sanitizeMeta(code));
    io.to(code).emit('system-message','⚙️ Chủ phòng cập nhật cài đặt phòng.');
  });

  socket.on('save-subscription',sub=>{
    const {roomCode:code}=socket.data;if(!code||!sub?.endpoint)return;
    if(!pushSubs[code])pushSubs[code]=new Map();
    pushSubs[code].set(socket.id,sub);
  });

  socket.on('update-location',({lat,lng})=>{
    const {roomCode:code}=socket.data;if(!code||!rooms[code]?.[socket.id])return;
    if(typeof lat!=='number'||typeof lng!=='number')return;
    rooms[code][socket.id].lat=lat;rooms[code][socket.id].lng=lng;broadcastUsers(code);
  });

  socket.on('update-status',({ping,battery})=>{
    const {roomCode:code}=socket.data;if(!code||!rooms[code]?.[socket.id])return;
    if(typeof ping==='number')rooms[code][socket.id].ping=ping;
    if(typeof battery==='number')rooms[code][socket.id].battery=battery;
    broadcastUsers(code);
  });

  socket.on('ping-custom',()=>socket.emit('pong-custom'));

  socket.on('start-speaking',()=>{
    const {roomCode:code,username}=socket.data;if(!code)return;
    if(rooms[code]?.[socket.id]?.muted){socket.emit('mic-denied',{holder:'Chủ phòng (mic bị khoá)'});return}
    const h=micHolders[code];
    if(!h)grantMic(code,socket,username);
    else if(h.socketId===socket.id){}
    else socket.emit('mic-denied',{holder:h.username});
  });

  socket.on('stop-speaking',()=>{
    const {roomCode:code}=socket.data;if(!code)return;
    if(micHolders[code]?.socketId===socket.id)releaseMic(code,'released');
  });

  socket.on('audio-data',buf=>{
    const {roomCode:code,username}=socket.data;if(!code||!buf)return;
    if(micHolders[code]?.socketId!==socket.id)return;
    socket.to(code).emit('audio-data',{username,audio:buf});
    voiceMemos[code]={username,audioBuffer:buf,ts:Date.now()};
  });

  socket.on('camera-state',({hasCamera,cameraOn})=>{
    const {roomCode:code}=socket.data;if(!code||!rooms[code]?.[socket.id])return;
    if(typeof hasCamera==='boolean')rooms[code][socket.id].hasCamera=hasCamera;
    if(typeof cameraOn==='boolean')rooms[code][socket.id].cameraOn=cameraOn;
    broadcastUsers(code);
  });

  socket.on('video-frame',({frame})=>{
    const {roomCode:code,username}=socket.data;if(!code||!frame)return;
    socket.to(code).emit('video-frame',{username,frame});
  });

  socket.on('force-camera-off',({targetId})=>{
    const {roomCode:code}=socket.data;if(!code||roomOwners[code]!==socket.id)return;
    io.sockets.sockets.get(targetId)?.emit('camera-forced-off');
    if(rooms[code]?.[targetId]){rooms[code][targetId].cameraOn=false;rooms[code][targetId].hasCamera=false;broadcastUsers(code)}
  });

  // ═══ NEW v10: force-camera-on request (admin asks user to open webcam) ═══
  socket.on('request-camera-on',({targetId})=>{
    const {roomCode:code,username:ownerName}=socket.data;
    if(!code||roomOwners[code]!==socket.id)return;
    const targetSocket=io.sockets.sockets.get(targetId);
    if(!targetSocket||!rooms[code]?.[targetId])return;
    targetSocket.emit('camera-on-requested',{fromOwner:ownerName});
    // Push notification even if user is on another tab
    sendPushToUser(targetId,{title:'📷 Yêu cầu bật camera',body:`${ownerName} yêu cầu bạn bật camera`,tag:'botdam-cam-req'},pushSubs[code]);
  });

  // ═══ NEW v10: force-mic-on request (admin forces user to speak) ═══
  socket.on('request-mic-on',({targetId})=>{
    const {roomCode:code,username:ownerName}=socket.data;
    if(!code||roomOwners[code]!==socket.id)return;
    const targetSocket=io.sockets.sockets.get(targetId);
    if(!targetSocket||!rooms[code]?.[targetId])return;
    // If target is muted by owner, auto-unmute so they CAN speak
    if(rooms[code][targetId].muted){rooms[code][targetId].muted=false;broadcastUsers(code)}
    targetSocket.emit('mic-on-requested',{fromOwner:ownerName});
    sendPushToUser(targetId,{title:'🎙️ Yêu cầu bật mic',body:`${ownerName} yêu cầu bạn nói ngay!`,tag:'botdam-mic-req'},pushSubs[code]);
  });

  socket.on('sos',({lat,lng})=>{
    const {roomCode:code,username}=socket.data;if(!code||!username)return;
    io.to(code).emit('sos-alert',{username,lat,lng,ts:Date.now()});
    sendPushToRoom(code,{title:`🆘 SOS từ ${username}!`,body:`Cần hỗ trợ - Phòng ${code}`,tag:'botdam-sos'},socket.id);
  });

  socket.on('chat-message',({text})=>{
    const {roomCode:code,username}=socket.data;if(!code||!username||!text)return;
    const msg=String(text).trim().substring(0,300);if(!msg)return;
    io.to(code).emit('chat-message',{username,text:msg,ts:Date.now()});
    // Push notification cho người đang ở tab khác
    // Gửi kèm nội dung để SW trigger TTS
    sendPushToRoom(code,{
      title:`💬 ${username}`,
      body:msg.length>80?msg.substring(0,80)+'…':msg,
      tag:'botdam-chat',
      chatText:msg,
      sender:username,
    },socket.id);
  });

  socket.on('kick-user',({targetId})=>{
    const {roomCode:code}=socket.data;if(!code||roomOwners[code]!==socket.id)return;
    const t=io.sockets.sockets.get(targetId);if(!t||!rooms[code]?.[targetId])return;
    const name=rooms[code][targetId].username;
    t.emit('kicked',{reason:'Chủ phòng đã mời bạn rời phòng.'});
    doLeave(t);
    io.to(code).emit('system-message',`👢 ${name} đã bị mời ra.`);
  });

  socket.on('toggle-mute',({targetId})=>{
    const {roomCode:code}=socket.data;if(!code||roomOwners[code]!==socket.id)return;
    if(!rooms[code]?.[targetId])return;
    const wasHolding=micHolders[code]?.socketId===targetId;
    rooms[code][targetId].muted=!rooms[code][targetId].muted;
    const isMuted=rooms[code][targetId].muted;
    const name=rooms[code][targetId].username;
    if(isMuted&&wasHolding)releaseMic(code,'muted');
    io.sockets.sockets.get(targetId)?.emit('you-are-muted',{muted:isMuted});
    io.to(code).emit('system-message',isMuted?`🔇 ${name} bị tắt mic.`:`🔊 ${name} được bật mic.`);
    broadcastUsers(code);
  });

  socket.on('reaction',({emoji})=>{
    const {roomCode:code,username}=socket.data;if(!code||!emoji)return;
    io.to(code).emit('reaction',{username,emoji:String(emoji).substring(0,8)});
  });

  socket.on('disconnect',()=>{doLeave(socket);console.log(`[-] ${socket.id}`)});
});

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`Server v10.2.0 on port ${PORT}`));
