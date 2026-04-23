
const fs=require('fs');
const path=require('path');
const express=require('express');
const http=require('http');
const {Server}=require('socket.io');
const crypto=require('crypto');
let createRedisClient=null;
let createAdapter=null;
try {
  ({ createClient: createRedisClient } = require('redis'));
  ({ createAdapter } = require('@socket.io/redis-adapter'));
} catch (error) {
  // Redis packages are optional until installed with npm install
}


const app=express();
const server=http.createServer(app);
const io=new Server(server,{
  maxHttpBufferSize: Number(process.env.SOCKET_MAX_BUFFER_BYTES||1200000),
  pingTimeout: 20000,
  pingInterval: 25000,
  cors:{origin:true,credentials:true}
});
const PORT=process.env.PORT||3000;
const DATA_DIR=path.join(__dirname,'data');
const DATA_FILE=path.join(DATA_DIR,'storage.json');
const SESSION_TTL_MS=1000*60*60*24*7;
const ROOM_IDLE_EVICT_MS=1000*60*15;
const ROOM_CLEANUP_INTERVAL_MS=1000*60;
const COLOR_IMAGE_MAX_DATA_URL_LENGTH=1100000;
const USER_COOKIE='challenge_user_token';
const OWNER_COOKIE='challenge_owner_token';

function isRedisEnabled(){
  const raw=String(process.env.REDIS_ENABLED||'').trim().toLowerCase();
  return raw==='1' || raw==='true' || raw==='yes' || !!String(process.env.REDIS_URL||'').trim();
}
async function setupRedisAdapter(){
  if(!isRedisEnabled()){
    console.log('Redis adapter disabled');
    return {enabled:false, reason:'disabled'};
  }
  if(!createRedisClient || !createAdapter){
    console.warn('Redis requested but packages are not installed yet. Run: npm install redis @socket.io/redis-adapter');
    return {enabled:false, reason:'packages-missing'};
  }
  const redisUrl=String(process.env.REDIS_URL||'redis://127.0.0.1:6379').trim();
  const pubClient=createRedisClient({url:redisUrl});
  const subClient=pubClient.duplicate();
  pubClient.on('error', err=>console.error('Redis pub error:', err?.message||err));
  subClient.on('error', err=>console.error('Redis sub error:', err?.message||err));
  await pubClient.connect();
  await subClient.connect();
  io.adapter(createAdapter(pubClient, subClient));
  console.log(`Redis adapter connected: ${redisUrl}`);
  return {enabled:true, url:redisUrl};
}

const ownerAccounts=[];
const ownerSessions=new Map();
const userSessions=new Map();
const users=new Map();
const activationCodes=new Map();
const roomDefinitions=new Map();
const roomSnapshots=new Map();

function safeNow(){ return Date.now(); }
function normalizeEmail(email=''){ return String(email||'').trim().toLowerCase(); }
function normalizeRoomCode(room=''){ return String(room||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,8); }
function createToken(prefix='sess'){ return `${prefix}_${crypto.randomBytes(24).toString('hex')}`; }
function generateRoomCode(){ return crypto.randomBytes(3).toString('hex').toUpperCase(); }
function hashPassword(password=''){
  const salt=crypto.randomBytes(16).toString('hex');
  const derived=crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt:${salt}:${derived}`;
}
function verifyPassword(password='', stored=''){
  const raw=String(stored||'');
  if(!raw) return false;
  if(!raw.startsWith('scrypt:')) return raw===String(password||'');
  const parts=raw.split(':');
  if(parts.length!==3) return false;
  const [,salt,expected]=parts;
  const derived=crypto.scryptSync(String(password||''), salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(derived,'hex'), Buffer.from(expected,'hex'));
  } catch {
    return false;
  }
}
function parseCookies(req){
  const raw=req.headers.cookie||'';
  const out={};
  String(raw).split(';').forEach(part=>{
    const i=part.indexOf('=');
    if(i===-1) return;
    const key=part.slice(0,i).trim();
    const value=part.slice(i+1).trim();
    if(key) out[key]=decodeURIComponent(value);
  });
  return out;
}
function readAuthToken(req, cookieName){
  const raw=req.headers.authorization||req.headers['x-session-token']||'';
  const auth=Array.isArray(raw)?raw[0]:raw;
  if(String(auth).startsWith('Bearer ')) return String(auth).slice(7).trim();
  const cookies=parseCookies(req);
  return String(cookies[cookieName]||'').trim();
}
function baseCookieOptions(){
  const isProd=process.env.NODE_ENV==='production';
  return [`Path=/`,`HttpOnly`,`SameSite=Lax`,isProd?`Secure`:'' ,`Max-Age=${Math.floor(SESSION_TTL_MS/1000)}`].filter(Boolean).join('; ');
}
function setAuthCookie(res,name,token){
  res.append('Set-Cookie', `${name}=${encodeURIComponent(token)}; ${baseCookieOptions()}`);
}
function clearAuthCookie(res,name){
  res.append('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
function serializeUser(user){
  return {
    name:user.name,
    email:user.email,
    activated:!!user.activated,
    roomId:user.roomId||'',
    isActive:user.isActive!==false,
    activationCode:user.activationCode||'',
    plan:user.plan||'',
    createdAt:user.createdAt||0,
    updatedAt:user.updatedAt||0
  };
}
function validatePasswordStrength(password=''){
  return String(password||'').length>=6;
}
function touchUser(user){ user.updatedAt=safeNow(); saveData(); }
function loadOwners(){
  const defaultOwnerUser=process.env.OWNER_USER||'mlmol_';
  const defaultOwnerPass=process.env.OWNER_PASS||'M664422m';
  ownerAccounts.length=0;
  ownerAccounts.push({
    username:defaultOwnerUser,
    passwordHash:hashPassword(defaultOwnerPass),
    displayName:process.env.OWNER_DISPLAY_NAME||'المالك الرئيسي'
  });
}
function loadData(){
  loadOwners();
  users.clear();
  activationCodes.clear();
  if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR,{recursive:true});
  if(!fs.existsSync(DATA_FILE)){
    activationCodes.set('DEMO-PRO-2026',{code:'DEMO-PRO-2026',plan:'pro',used:false,usedBy:'',createdAt:safeNow()});
    saveData();
    return;
  }
  try {
    const raw=JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));
    for(const item of raw.users||[]){
      const email=normalizeEmail(item.email);
      if(!email) continue;
      const passwordHash=item.passwordHash || (item.password ? hashPassword(item.password) : '');
      users.set(email,{
        name:String(item.name||'').trim(),
        email,
        passwordHash,
        activated:!!item.activated,
        roomId:normalizeRoomCode(item.roomId||''),
        activationCode:String(item.activationCode||''),
        plan:String(item.plan||''),
        isActive:item.isActive!==false,
        createdAt:Number(item.createdAt)||safeNow(),
        updatedAt:Number(item.updatedAt)||safeNow()
      });
    }
    for(const item of raw.activationCodes||[]){
      const code=String(item.code||'').trim().toUpperCase();
      if(!code) continue;
      activationCodes.set(code,{
        code,
        plan:String(item.plan||'pro').toLowerCase(),
        used:!!item.used,
        usedBy:normalizeEmail(item.usedBy||''),
        usedAt:Number(item.usedAt)||0,
        createdAt:Number(item.createdAt)||safeNow()
      });
    }
    for(const item of raw.roomDefinitions||[]){
      const roomId=normalizeRoomCode(item.roomId||'');
      if(!roomId) continue;
      roomDefinitions.set(roomId,{
        roomId,
        ownerEmail:normalizeEmail(item.ownerEmail||''),
        label:String(item.label||roomId),
        isPermanent:item.isPermanent!==false,
        createdAt:Number(item.createdAt)||safeNow(),
        updatedAt:Number(item.updatedAt)||safeNow(),
        lastOpenedAt:Number(item.lastOpenedAt)||0
      });
    }
    for(const item of raw.roomSnapshots||[]){
      const roomId=normalizeRoomCode(item.roomId||'');
      if(!roomId) continue;
      roomSnapshots.set(roomId,{
        roomId,
        savedAt:Number(item.savedAt)||0,
        state:item.state&&typeof item.state==='object'?item.state:{}
      });
    }
    if(!activationCodes.size){
      activationCodes.set('DEMO-PRO-2026',{code:'DEMO-PRO-2026',plan:'pro',used:false,usedBy:'',createdAt:safeNow()});
      saveData();
    }
  } catch(err){
    console.error('Failed to load storage.json',err);
    activationCodes.set('DEMO-PRO-2026',{code:'DEMO-PRO-2026',plan:'pro',used:false,usedBy:'',createdAt:safeNow()});
    saveData();
  }
}
function saveData(){
  if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR,{recursive:true});
  const payload={
    users:Array.from(users.values()).map(u=>({
      name:u.name,email:u.email,passwordHash:u.passwordHash||'',activated:!!u.activated,roomId:u.roomId||'',activationCode:u.activationCode||'',plan:u.plan||'',isActive:u.isActive!==false,createdAt:u.createdAt||0,updatedAt:u.updatedAt||0
    })),
    activationCodes:Array.from(activationCodes.values()).map(c=>({
      code:c.code,plan:c.plan,used:!!c.used,usedBy:c.usedBy||'',usedAt:c.usedAt||0,createdAt:c.createdAt||0
    })),
    roomDefinitions:Array.from(roomDefinitions.values()).map(r=>({
      roomId:r.roomId,ownerEmail:r.ownerEmail||'',label:r.label||r.roomId,isPermanent:r.isPermanent!==false,createdAt:r.createdAt||0,updatedAt:r.updatedAt||0,lastOpenedAt:r.lastOpenedAt||0
    })),
    roomSnapshots:Array.from(roomSnapshots.values()).map(r=>({
      roomId:r.roomId,savedAt:r.savedAt||0,state:r.state||{}
    }))
  };
  fs.writeFileSync(DATA_FILE, JSON.stringify(payload,null,2),'utf8');
}
function cleanupExpiredSessions(){
  const cutoff=safeNow()-SESSION_TTL_MS;
  for(const [token,session] of userSessions.entries()) if((session.createdAt||0)<cutoff) userSessions.delete(token);
  for(const [token,session] of ownerSessions.entries()) if((session.createdAt||0)<cutoff) ownerSessions.delete(token);
}
function getOwnerSession(req){
  cleanupExpiredSessions();
  const token=readAuthToken(req, OWNER_COOKIE);
  if(!token || !ownerSessions.has(token)) return null;
  const session=ownerSessions.get(token);
  return {token,...session};
}
function getUserSession(req){
  cleanupExpiredSessions();
  const token=readAuthToken(req, USER_COOKIE);
  if(!token || !userSessions.has(token)) return null;
  const session=userSessions.get(token);
  const user=users.get(session.email);
  if(!user || user.isActive===false) return null;
  return {token,email:session.email,user};
}
function requireOwner(req,res){
  const session=getOwnerSession(req);
  if(!session){ res.status(401).json({ok:false,message:'غير مصرح'}); return null; }
  return session;
}
function requireUser(req,res){
  const session=getUserSession(req);
  if(!session){ res.status(401).json({ok:false,message:'سجل دخولك أولاً'}); return null; }
  return session;
}
function requireUserPage(req,res,next){
  const session=getUserSession(req);
  if(!session) return res.redirect('/login');
  req.userSession=session;
  next();
}
function requireActivatedUserPage(req,res,next){
  const session=getUserSession(req);
  if(!session) return res.redirect('/login');
  if(!session.user.activated) return res.redirect('/activate');
  req.userSession=session;
  next();
}
function requireOwnerPage(req,res,next){
  const session=getOwnerSession(req);
  if(!session) return res.redirect('/admin-mlmol-6644');
  req.ownerSession=session;
  next();
}
function issueOwnerSession(username){
  const token=createToken('owner');
  ownerSessions.set(token,{username,createdAt:safeNow()});
  return token;
}
function issueUserSession(email){
  const token=createToken('user');
  userSessions.set(token,{email,createdAt:safeNow()});
  return token;
}
function createActivationCode(plan='pro'){
  const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code='';
  do {
    const part=()=>Array.from({length:4},()=>chars[Math.floor(Math.random()*chars.length)]).join('');
    code=`${String(plan||'PRO').toUpperCase()}-${part()}-${part()}`;
  } while(activationCodes.has(code));
  const entry={code,plan:String(plan||'pro').toLowerCase(),used:false,usedBy:'',createdAt:safeNow()};
  activationCodes.set(code,entry);
  saveData();
  return entry;
}
function ensureUserRoom(user){
  const roomCode=createPersistentRoomForUser(user, user.roomId||'');
  getRoomContext(roomCode);
  touchUser(user);
  return roomCode;
}
function usersHasRoom(roomId=''){
  const target=String(roomId||'').trim().toUpperCase();
  for(const u of users.values()) if((u.roomId||'')===target) return true;
  return false;
}
function buildSessionPayload(user){ return {ok:true,user:serializeUser(user)}; }

function upsertRoomDefinition(roomId, data={}){
  const code=normalizeRoomCode(roomId||'');
  if(!code) return null;
  const prev=roomDefinitions.get(code)||{roomId:code,ownerEmail:'',label:code,isPermanent:true,createdAt:safeNow(),updatedAt:safeNow(),lastOpenedAt:0};
  const next={
    ...prev,
    ...data,
    roomId:code,
    ownerEmail:normalizeEmail(data.ownerEmail!=null?data.ownerEmail:prev.ownerEmail||''),
    label:String(data.label||prev.label||code),
    isPermanent:data.isPermanent!==undefined ? data.isPermanent!==false : prev.isPermanent!==false,
    updatedAt:safeNow()
  };
  roomDefinitions.set(code,next);
  return next;
}
function touchRoomDefinition(roomId, patch={}){
  const room=upsertRoomDefinition(roomId,patch);
  if(room){ room.lastOpenedAt=safeNow(); room.updatedAt=safeNow(); }
  return room;
}
function sanitizeRoomSnapshot(snapshot={}){
  const safe=snapshot&&typeof snapshot==='object'?snapshot:{};
  const defaultLettersSettings={
    answerSeconds:10,
    otherTeamSeconds:7,
    frameTopBottom:'#62c924',
    frameSides:'#ff8a3d',
    team1Color:'#51c84d',
    team2Color:'#ff8a3d'
  };
  const defaultOutsiderCategory='اكلات';
  const defaultOutsiderOptionsCount=8;
  return {
    teamNames:{
      team1:String(safe.teamNames?.team1||'الفريق الأحمر'),
      team2:String(safe.teamNames?.team2||'الفريق الأزرق')
    },
    app:{
      selectedGame:'',
      selectedGameLabel:'',
      currentView:'lobby',
      statusText:'بانتظار اختيار اللعبة',
      gamePhase:'',
      currentRound:0,
      introDismissed:!!safe.app?.introDismissed,
      overlayState:{type:'none',url:''}
    },
    games:{
      mafia:{settings:{...defaultMafiaState(0).settings, ...(safe.games?.mafia?.settings||{})}},
      color:{settings:{...defaultColorState().settings, ...(safe.games?.color?.settings||{})}, recentColors:Array.isArray(safe.games?.color?.recentColors)?safe.games.color.recentColors.slice(0,6):[]},
      letters:{gridSize:Math.max(3, Math.min(5, Number(safe.games?.letters?.gridSize)||5)), settings:{...defaultLettersSettings, ...(safe.games?.letters?.settings||{})}},
      outsider:{category:String(safe.games?.outsider?.category||defaultOutsiderCategory), optionsCount:Math.max(4, Number(safe.games?.outsider?.optionsCount)||defaultOutsiderOptionsCount)}
    }
  };
}
function buildRoomSnapshotFromState(state){
  return sanitizeRoomSnapshot({
    teamNames:state.teamNames,
    app:{introDismissed:state.app?.introDismissed},
    games:{
      mafia:{settings:state.games?.mafia?.settings},
      color:{settings:state.games?.color?.settings, recentColors:state.games?.color?.recentColors},
      letters:{gridSize:state.games?.letters?.gridSize, settings:state.games?.letters?.settings},
      outsider:{category:state.games?.outsider?.category, optionsCount:state.games?.outsider?.optionsCount}
    }
  });
}
function persistRoomSnapshot(roomId, state){
  const code=normalizeRoomCode(roomId||'');
  if(!code || !state) return;
  roomSnapshots.set(code,{roomId:code,savedAt:safeNow(),state:buildRoomSnapshotFromState(state)});
  touchRoomDefinition(code);
  saveData();
}
function getStoredRoomSnapshot(roomId){
  const code=normalizeRoomCode(roomId||'');
  if(!code) return null;
  const item=roomSnapshots.get(code);
  return item && item.state ? sanitizeRoomSnapshot(item.state) : null;
}
function createPersistentRoomForUser(user, preferredRoomId=''){
  let roomCode=normalizeRoomCode(preferredRoomId||user.roomId||'');
  if(!roomCode){
    do { roomCode=generateRoomCode(); } while(usersHasRoom(roomCode) || roomDefinitions.has(roomCode));
  }
  user.roomId=roomCode;
  upsertRoomDefinition(roomCode,{ownerEmail:user.email,label:user.name||roomCode,isPermanent:true,lastOpenedAt:safeNow()});
  if(!roomSnapshots.has(roomCode)) roomSnapshots.set(roomCode,{roomId:roomCode,savedAt:safeNow(),state:sanitizeRoomSnapshot({})});
  saveData();
  return roomCode;
}

app.use(express.json({limit:'2mb'}));
app.use((req,res,next)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','same-origin');
  res.setHeader('Cross-Origin-Opener-Policy','same-origin');
  next();
});

loadData();
for(const user of users.values()) if(user.activated && user.roomId) createPersistentRoomForUser(user, user.roomId);

app.get('/',(req,res)=>{
  const roomCode=normalizeRoomCode(req.query?.room||'');
  if(!roomCode) return res.redirect('/lobby');
  const roomState=getRoomContext(roomCode).state;
  const game=roomState?.app?.selectedGame||'';
  if(game==='mafia') return res.sendFile(path.join(__dirname,'public','games','mafia','screen.html'));
  if(game==='color') return res.sendFile(path.join(__dirname,'public','games','color','screen.html'));
  if(game==='letters') return res.sendFile(path.join(__dirname,'public','games','letters','screen.html'));
  if(game==='outsider') return res.sendFile(path.join(__dirname,'public','games','outsider','screen.html'));
  return res.sendFile(path.join(__dirname,'public','index.html'));
});
app.get('/lobby', (_req,res)=>res.sendFile(path.join(__dirname,'public','lobby.html')));
app.get('/host', requireActivatedUserPage, (req,res)=>{
  const userRoom=normalizeRoomCode(req.userSession?.user?.roomId||'');
  const roomCode=normalizeRoomCode(req.query?.room||userRoom||'');
  if(!userRoom) return res.redirect('/dashboard');
  if(roomCode!==userRoom) return res.redirect(`/host?room=${encodeURIComponent(userRoom)}`);
  return res.sendFile(path.join(__dirname,'public','host.html'));
});
app.get('/team-settings', requireActivatedUserPage, (req,res)=>{
  const userRoom=normalizeRoomCode(req.userSession?.user?.roomId||'');
  const roomCode=normalizeRoomCode(req.query?.room||userRoom||'');
  if(!userRoom) return res.redirect('/dashboard');
  if(roomCode!==userRoom) return res.redirect(`/team-settings?room=${encodeURIComponent(userRoom)}`);
  return res.sendFile(path.join(__dirname,'public','team-settings.html'));
});
app.get('/player', (req,res)=>{
  const roomCode=normalizeRoomCode(req.query?.room||'');
  if(!roomCode) return res.redirect('/lobby');
  const roomState=getRoomContext(roomCode).state;
  const view=roomState?.app?.currentView||'lobby';
  const game=roomState?.app?.selectedGame||'';
  const running=['game_selected','game_select','game_running','game_results'].includes(view);
  if(running && game==='mafia') return res.sendFile(path.join(__dirname,'public','games','mafia','player.html'));
  if(running && game==='color') return res.sendFile(path.join(__dirname,'public','games','color','player.html'));
  if(running && game==='letters') return res.sendFile(path.join(__dirname,'public','games','letters','player.html'));
  if(running && game==='outsider') return res.sendFile(path.join(__dirname,'public','games','outsider','player.html'));
  return res.sendFile(path.join(__dirname,'public','player.html'));
});
app.get('/games', requireActivatedUserPage, (req,res)=>{
  const userRoom=normalizeRoomCode(req.userSession?.user?.roomId||'');
  const roomCode=normalizeRoomCode(req.query?.room||userRoom||'');
  if(!userRoom) return res.redirect('/dashboard');
  if(roomCode!==userRoom) return res.redirect(`/games?room=${encodeURIComponent(userRoom)}`);
  return res.sendFile(path.join(__dirname,'public','games.html'));
});
app.get('/games/mafia/setup', requireActivatedUserPage, (req,res)=>{
  const userRoom=normalizeRoomCode(req.userSession?.user?.roomId||'');
  const roomCode=normalizeRoomCode(req.query?.room||userRoom||'');
  if(!userRoom) return res.redirect('/dashboard');
  if(roomCode!==userRoom) return res.redirect(`/games/mafia/setup?room=${encodeURIComponent(userRoom)}`);
  return res.sendFile(path.join(__dirname,'public','games','mafia','setup.html'));
});
app.get('/games/mafia/host', requireActivatedUserPage, (req,res)=>{
  const userRoom=normalizeRoomCode(req.userSession?.user?.roomId||'');
  const roomCode=normalizeRoomCode(req.query?.room||userRoom||'');
  if(!userRoom) return res.redirect('/dashboard');
  if(roomCode!==userRoom) return res.redirect(`/games/mafia/host?room=${encodeURIComponent(userRoom)}`);
  return res.sendFile(path.join(__dirname,'public','games','mafia','host.html'));
});
app.get('/games/mafia/screen', (_,res)=>res.sendFile(path.join(__dirname,'public','games','mafia','screen.html')));
app.get('/games/mafia/player', (_,res)=>res.sendFile(path.join(__dirname,'public','games','mafia','player.html')));
app.get('/games/color/setup', requireActivatedUserPage, (req,res)=>{
  const userRoom=normalizeRoomCode(req.userSession?.user?.roomId||'');
  const roomCode=normalizeRoomCode(req.query?.room||userRoom||'');
  if(!userRoom) return res.redirect('/dashboard');
  if(roomCode!==userRoom) return res.redirect(`/games/color/setup?room=${encodeURIComponent(userRoom)}`);
  return res.sendFile(path.join(__dirname,'public','games','color','setup.html'));
});
app.get('/games/color/host', requireActivatedUserPage, (req,res)=>{
  const userRoom=normalizeRoomCode(req.userSession?.user?.roomId||'');
  const roomCode=normalizeRoomCode(req.query?.room||userRoom||'');
  if(!userRoom) return res.redirect('/dashboard');
  if(roomCode!==userRoom) return res.redirect(`/games/color/host?room=${encodeURIComponent(userRoom)}`);
  return res.sendFile(path.join(__dirname,'public','games','color','host.html'));
});
app.get('/games/color/screen', (_,res)=>res.sendFile(path.join(__dirname,'public','games','color','screen.html')));
app.get('/games/color/player', (_,res)=>res.sendFile(path.join(__dirname,'public','games','color','player.html')));
app.get('/games/letters/setup', requireActivatedUserPage, (req,res)=>{
  const userRoom=normalizeRoomCode(req.userSession?.user?.roomId||'');
  const roomCode=normalizeRoomCode(req.query?.room||userRoom||'');
  if(!userRoom) return res.redirect('/dashboard');
  if(roomCode!==userRoom) return res.redirect(`/games/letters/setup?room=${encodeURIComponent(userRoom)}`);
  return res.sendFile(path.join(__dirname,'public','games','letters','setup.html'));
});
app.get('/games/letters/host', requireActivatedUserPage, (req,res)=>{
  const userRoom=normalizeRoomCode(req.userSession?.user?.roomId||'');
  const roomCode=normalizeRoomCode(req.query?.room||userRoom||'');
  if(!userRoom) return res.redirect('/dashboard');
  if(roomCode!==userRoom) return res.redirect(`/games/letters/host?room=${encodeURIComponent(userRoom)}`);
  return res.sendFile(path.join(__dirname,'public','games','letters','host.html'));
});
app.get('/games/letters/screen', (_,res)=>res.sendFile(path.join(__dirname,'public','games','letters','screen.html')));
app.get('/games/letters/player', (_,res)=>res.sendFile(path.join(__dirname,'public','games','letters','player.html')));
app.get('/games/outsider/setup', requireActivatedUserPage, (req,res)=>{
  const userRoom=normalizeRoomCode(req.userSession?.user?.roomId||'');
  const roomCode=normalizeRoomCode(req.query?.room||userRoom||'');
  if(!userRoom) return res.redirect('/dashboard');
  if(roomCode!==userRoom) return res.redirect(`/games/outsider/setup?room=${encodeURIComponent(userRoom)}`);
  return res.sendFile(path.join(__dirname,'public','games','outsider','setup.html'));
});
app.get('/games/outsider/host', requireActivatedUserPage, (req,res)=>{
  const userRoom=normalizeRoomCode(req.userSession?.user?.roomId||'');
  const roomCode=normalizeRoomCode(req.query?.room||userRoom||'');
  if(!userRoom) return res.redirect('/dashboard');
  if(roomCode!==userRoom) return res.redirect(`/games/outsider/host?room=${encodeURIComponent(userRoom)}`);
  return res.sendFile(path.join(__dirname,'public','games','outsider','host.html'));
});
app.get('/games/outsider/screen', (_,res)=>res.sendFile(path.join(__dirname,'public','games','outsider','screen.html')));
app.get('/games/outsider/player', (_,res)=>res.sendFile(path.join(__dirname,'public','games','outsider','player.html')));

app.get('/login',(_req,res)=>res.sendFile(path.join(__dirname,'public','login.html')));
app.get('/register',(_req,res)=>res.sendFile(path.join(__dirname,'public','register.html')));
app.get('/activate', requireUserPage, (_req,res)=>res.sendFile(path.join(__dirname,'public','activate.html')));
app.get('/dashboard', requireUserPage, (_req,res)=>res.sendFile(path.join(__dirname,'public','dashboard.html')));
app.get('/owner-login',(_req,res)=>res.redirect('/admin-mlmol-6644'));
app.get('/owner-dashboard',(_req,res)=>res.redirect('/admin-mlmol-6644/dashboard'));
app.get('/admin-mlmol-6644',(_req,res)=>res.sendFile(path.join(__dirname,'public','owner-login.html')));
app.get('/admin-mlmol-6644/dashboard', requireOwnerPage, (_req,res)=>res.sendFile(path.join(__dirname,'public','owner-dashboard.html')));
app.get('/admin-mlmol-6644/dashboard-monitor', requireOwnerPage, (_req,res)=>res.sendFile(path.join(__dirname,'public','owner-dashboard-live-monitor.html')));

app.use(express.static(path.join(__dirname,'public')));

function defaultMafiaState(playerCount=0){
  return {
    phase:'setup',
    phaseLabel:'التجهيز',
    round:0,
    started:false,
    statusText:'بانتظار تجهيز لعبة المافيا',
    aliveCount:playerCount,
    mafiaCount:0,
    selectedTargetId:'',
    lastEliminatedId:'',
    votes:{},
    revealRoles:false,
    winner:'',
    settings:{
      mafiaCount:1,
      investigationSeconds:45,
      defenseSeconds:30,
      enableMayor:false,
      enableSniper:false,
      enableRopePlayer:false,
      enableSilentMafia:false
    },
    roleSummary:{mafia:0,doctor:0,detective:0,mayor:0,sniper:0,rope:0,silentMafia:0,citizen:0},
    nightActions:{mafiaKillId:'',silentTargetId:'',doctorSaveId:'',detectiveCheckId:'',sniperKillId:''},
    voteResult:{selectedPlayerId:'',status:'pending',defenseOpen:false,ropeDecisionPending:false,ropePullTargetId:'',notes:'',revealedRole:'',revealedAlignment:''},
    daySummary:{killedId:'',savedId:'',silencedId:'',checkedId:'',checkedRole:'',sniperKilledId:'',notes:'',ropeVictimId:''},
    sniperUsed:false,
    timer:{mode:'idle',secondsLeft:0,totalSeconds:0,label:''}
  };
}


function defaultColorState(){
  return {
    started:false,
    phase:'setup',
    phaseLabel:'التجهيز',
    statusText:'بانتظار تجهيز صيد اللون',
    round:0,
    secondsLeft:0,
    settings:{rounds:3,prepSeconds:10,playSeconds:20},
    targetColorName:'',
    targetColorHex:'',
    prepEndsAt:0,
    roundEndsAt:0,
    playStartedAt:0,
    submissions:[],
    lastRoundResult:null,
    finalWinnerName:'',
    finalWinnerPoints:0,
    finalWinnerTeamName:'',
    recentColors:[]
  };
}



const LETTER_POOL='ابتثجحخدذرزسشصضطظعغفقكلمنهوي'.split('');
function shuffleArray(arr=[]){
  const copy=[...arr];
  for(let i=copy.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [copy[i],copy[j]]=[copy[j],copy[i]];
  }
  return copy;
}
function generateLettersGrid(size){
  const safeSize=Math.max(3, Math.min(5, Number(size)||3));
  const needed=safeSize*safeSize;
  const pool=shuffleArray(LETTER_POOL).slice(0, needed);
  return Array.from({length:safeSize},(_,r)=>Array.from({length:safeSize},(_,c)=>pool[r*safeSize+c]||''));
}

function defaultLettersState(size=5){
  const safeSize=Math.max(3, Math.min(5, Number(size)||5));
  return {
    started:false,
    phase:'setup',
    phaseLabel:'التجهيز',
    statusText:'بانتظار تجهيز لعبة الحروف',
    gridSize:safeSize,
    settings:{answerSeconds:10,otherTeamSeconds:7,frameTopBottom:'#62c924',frameSides:'#ff8a3d',team1Color:'#51c84d',team2Color:'#ff8a3d'},
    grid:generateLettersGrid(safeSize),
    owners:Array.from({length:safeSize},()=>Array.from({length:safeSize},()=>'')),
    currentLetter:'',
    currentResponderId:'',
    currentResponderName:'',
    currentResponderTeam:'',
    winnerTeam:'',
    winningPath:[],
    moveCount:0,
    buzzMode:'open',
    answerStage:'open',
    timerSecondsLeft:0,
    timerLabel:'',
    timerMaxSeconds:0,
    currentAnswerTeam:'',
    waitingTeam:'',
    noticeText:'بانتظار بداية اللعبة',
    presentedQuestion:null
  };
}


function defaultOutsiderState(){
  return {
    started:false,
    phase:'waiting',
    phaseLabel:'بانتظار البداية',
    statusText:'بانتظار بدء لعبة برا السالفة',
    round:0,
    word:'',
    category:'اكلات',
    optionsCount:8,
    outsiderPlayerId:'',
    outsiderRevealedName:'',
    mandatoryPairs:[],
    currentPairIndex:0,
    votes:{},
    votedOutPlayerId:'',
    votedOutName:'',
    winnerText:'',
    guessOptions:[],
    guessedCorrect:false,
    guessedWord:'',
    canRevealOutsider:false
  };
}

function createRoomContext(roomCode, persistedSnapshot=null){
const COLOR_POOL = [
  {name:'أحمر',hex:'#ef4444'},{name:'أحمر داكن',hex:'#b91c1c'},{name:'قرمزي',hex:'#dc2626'},
  {name:'أزرق',hex:'#3b82f6'},{name:'أزرق ملكي',hex:'#2563eb'},{name:'أزرق فاتح',hex:'#38bdf8'},
  {name:'أخضر',hex:'#22c55e'},{name:'أخضر زمردي',hex:'#10b981'},{name:'أخضر فاتح',hex:'#84cc16'},
  {name:'أصفر',hex:'#facc15'},{name:'أصفر فاتح',hex:'#fde68a'},
  {name:'برتقالي',hex:'#f97316'},{name:'كهرماني',hex:'#f59e0b'},
  {name:'بنفسجي',hex:'#8b5cf6'},{name:'بنفسجي داكن',hex:'#6d28d9'},{name:'لافندر',hex:'#c4b5fd'},
  {name:'وردي',hex:'#ec4899'},{name:'وردي فاتح',hex:'#f9a8d4'},{name:'فوشي',hex:'#d946ef'},
  {name:'فيروزي',hex:'#14b8a6'},{name:'تركوازي',hex:'#2dd4bf'},
  {name:'نيلي',hex:'#4338ca'},{name:'سماوي',hex:'#06b6d4'},
  {name:'زيتي',hex:'#708238'},{name:'ليموني',hex:'#a3e635'},
  {name:'بني',hex:'#8b5e3c'},{name:'بيج',hex:'#d6c4a1'},
  {name:'ذهبي',hex:'#d4a017'},{name:'فضي',hex:'#b8c4d4'},
  {name:'رمادي',hex:'#6b7280'},{name:'فحمي',hex:'#1f2937'},
  {name:'أبيض',hex:'#f8fafc'},{name:'أسود',hex:'#111111'},
  {name:'مرجاني',hex:'#fb7185'},{name:'عنابي',hex:'#7f1d1d'}
];
const state={
  players:[],
  hosts:[],
  teamNames:{team1:'الفريق الأحمر',team2:'الفريق الأزرق'},
  teamScores:{team1:0,team2:0},
  playerScores:{},
  app:{
    selectedGame:'',
    selectedGameLabel:'',
    currentView:'lobby',
    statusText:'بانتظار اختيار اللعبة',
    gamePhase:'',
    currentRound:0,
    introDismissed:false,
    overlayState:{type:'none',url:''}
  },
  games:{mafia:defaultMafiaState(0), color:defaultColorState(), letters:defaultLettersState(), outsider:defaultOutsiderState()}
};
const restoredSnapshot=sanitizeRoomSnapshot(persistedSnapshot||{});
state.teamNames={...state.teamNames,...(restoredSnapshot.teamNames||{})};
state.app={...state.app,...(restoredSnapshot.app||{}),overlayState:{type:'none',url:''},currentView:'lobby',statusText:'بانتظار اختيار اللعبة',selectedGame:'',selectedGameLabel:'',gamePhase:'',currentRound:0};
state.games.mafia.settings={...state.games.mafia.settings,...(restoredSnapshot.games?.mafia?.settings||{})};
state.games.color.settings={...state.games.color.settings,...(restoredSnapshot.games?.color?.settings||{})};
state.games.color.recentColors=Array.isArray(restoredSnapshot.games?.color?.recentColors)?restoredSnapshot.games.color.recentColors.slice(0,6):[];
const restoredGridSize=Math.max(3,Math.min(5,Number(restoredSnapshot.games?.letters?.gridSize)||state.games.letters.gridSize));
state.games.letters=defaultLettersState(restoredGridSize);
state.games.letters.settings={...state.games.letters.settings,...(restoredSnapshot.games?.letters?.settings||{})};
state.games.outsider.category=String(restoredSnapshot.games?.outsider?.category||state.games.outsider.category);
state.games.outsider.optionsCount=Math.max(4, Number(restoredSnapshot.games?.outsider?.optionsCount)||state.games.outsider.optionsCount);

let mafiaTimerInterval=null;
let colorTimerInterval=null;
let colorPhaseTimeout=null;
let lettersTimerInterval=null;

function sanitizeColorSubmissions(items=[]){
  return (Array.isArray(items)?items:[]).map(s=>({
    id:s.id,
    playerId:s.playerId,
    name:s.name,
    team:s.team||'',
    timestamp:s.timestamp||0,
    elapsedMs:s.elapsedMs||0,
    correct:s.correct===true?true:(s.correct===false?false:null),
    points:Number(s.points)||0
  }));
}
function buildPublicGamesState(){
  return {
    ...state.games,
    color:{
      ...state.games.color,
      submissions:sanitizeColorSubmissions(state.games.color?.submissions||[])
    }
  };
}
function buildColorHostAdminState(){
  const color=state.games.color||defaultColorState();
  return {
    ...color,
    submissions:(Array.isArray(color.submissions)?color.submissions:[]).map(s=>({
      id:s.id,
      playerId:s.playerId,
      name:s.name,
      team:s.team||'',
      image:s.image||'',
      timestamp:s.timestamp||0,
      elapsedMs:s.elapsedMs||0,
      correct:s.correct===true?true:(s.correct===false?false:null),
      points:Number(s.points)||0
    }))
  };
}
function buildState(){
  return {
    players:state.players,
    hosts:(state.hosts||[]).map(h=>({page:h.page||'host',connectedAt:h.connectedAt||0})),
    teamNames:state.teamNames,
    teamScores:state.teamScores,
    playerScores:state.playerScores,
    appState:state.app,
    games:buildPublicGamesState()
  };
}
function emitColorHostAdminState(){
  const payload=buildColorHostAdminState();
  for(const host of state.hosts||[]){
    if(!host?.socketId) continue;
    io.to(host.socketId).emit('colorHostAdminState', payload);
  }
}
function emitState(){
  state.lastActivityAt=Date.now();
  persistRoomSnapshot(roomCode,state);
  io.to(roomCode).emit('stateUpdate',buildState());
  emitColorHostAdminState();
}
function ensurePlayerScore(name){if(typeof state.playerScores[name]!=='number') state.playerScores[name]=0;}
function getMafia(){return state.games.mafia;}
function getColor(){return state.games.color;}
function getLetters(){return state.games.letters;}
function getOutsider(){return state.games.outsider;}
function alivePlayers(){return state.players.filter(p=>p.isAlive);}
function getPlayer(id){return state.players.find(p=>p.playerId===id);}

const OUTSIDER_WORD_BANK = {
  اكلات:['بيتزا','شاورما','برجر','مكرونة','كبسة','مندي','سوشي','فلافل','بان كيك','دونات','كباب','كنافة','شوربة','سلطة','معكرونة','سمبوسة','ورق عنب','بيتزا خضار','تشيز كيك','مطبق'],
  حيوانات:['أسد','حصان','نمر','فيل','زرافة','ذئب','ثعلب','قطة','كلب','جمل','خروف','أرنب','باندا','تمساح','دلفين','بطريق','نسر','سلحفاة','قرد','كنغر'],
  ملابس:['قميص','بنطلون','فستان','جاكيت','عباية','شماغ','حذاء','جورب','قبعة','نظارة','حقيبة','ساعة','هودي','تيشيرت','معطف','شال','بيجامة','بدلة','تنورة','ثوب'],
  سيارات:['تويوتا','هيونداي','مرسيدس','بي ام دبليو','لكزس','كيا','جيب','فورد','تسلا','نيسان','شيفروليه','هوندا','جي ام سي','دودج','بورش','رانج روفر','مازدا','اودي','لاندكروزر','كامري'],
  فواكه:['تفاح','موز','برتقال','عنب','فراولة','مانجو','بطيخ','أناناس','خوخ','رمان','كمثرى','كيوي','تين','تمر','جوافة','كرز','شمام','يوسفي','ليمون','توت'],
  خضروات:['طماطم','خيار','بطاطس','جزر','بصل','فلفل','خس','باذنجان','كوسا','ملفوف','قرنبيط','سبانخ','بروكلي','فجل','ذرة','فاصوليا','بازلاء','ثوم','كراث','شمندر'],
  انمي:['ناروتو','ون بيس','هجوم العمالقة','ديث نوت','بليتش','دراغون بول','جوجوتسو كايسن','هايكيو','ون بنش مان','هنتر','ديمون سلاير','بلاك كلوفر','سباي فاميلي','طوكيو غول','بلو لوك'],
  'العاب قيمنق':['فيفا','ماينكرافت','فورتنايت','كول اوف ديوتي','قراند','فالورانت','روبلوكس','ماريو','زيلدا','ببجي','اوفرواتش','راكت ليق','ابيكس','دوتا 2','ليغ اوف ليجندز','فال قايز','ريد ديد','سبايدرمان']
};
function shuffled(arr=[]){ return [...arr].sort(()=>Math.random()-0.5); }
function outsiderCategoryWords(category='اكلات'){
  return OUTSIDER_WORD_BANK[category] || OUTSIDER_WORD_BANK['اكلات'];
}
function pickOutsiderWord(category='اكلات'){
  const words=outsiderCategoryWords(category);
  return words[Math.floor(Math.random()*words.length)]||'قميص';
}
function buildOutsiderPairs(outsiderPlayerId=''){
  const ids=shuffled(state.players.map(p=>p.playerId).filter(Boolean));
  if(ids.length<2) return [];
  const outsiderIndex=ids.indexOf(outsiderPlayerId);
  if(outsiderIndex>=0){
    const desired=Math.max(1, Math.floor(ids.length/2));
    const rotated=ids.slice(outsiderIndex).concat(ids.slice(0,outsiderIndex));
    const shift=Math.max(0, Math.min(rotated.length-1, desired));
    const arranged=rotated.slice(shift).concat(rotated.slice(0,shift));
    return arranged.map((id,i)=>({askerId:id,targetId:arranged[(i+1)%arranged.length]}));
  }
  return ids.map((id,i)=>({askerId:id,targetId:ids[(i+1)%ids.length]}));
}
function resetOutsiderGame(preserveConfig=true){
  const prev=state.games.outsider||defaultOutsiderState();
  const next=defaultOutsiderState();
  if(preserveConfig){
    next.category=prev.category||next.category;
    next.optionsCount=Math.max(4, Number(prev.optionsCount)||next.optionsCount);
  }
  state.games.outsider=next;
}
function setOutsiderPhase(phase,status=''){
  const g=getOutsider();
  g.phase=phase;
  g.phaseLabel={waiting:'بانتظار البداية',mandatory:'الأسئلة الإجباريّة',open:'الأسئلة المفتوحة',voting:'التصويت',guessing:'تخمين الكلمة',finished:'النتيجة'}[phase]||phase;
  g.statusText=status||g.phaseLabel;
  state.app.selectedGame='outsider';
  state.app.selectedGameLabel='برا السالفة';
  state.app.currentView=['finished'].includes(phase)?'game_results':'game_running';
  state.app.gamePhase=g.phaseLabel;
  state.app.statusText=g.statusText;
  state.app.currentRound=g.round||0;
}
function sendOutsiderSecret(socket){
  const g=getOutsider();
  const pid=socket.data.playerId||'';
  const isOutsider=!!pid && pid===g.outsiderPlayerId;
  socket.emit('outsiderSecret',{
    ok:true,
    isOutsider,
    word: isOutsider ? '' : (g.word||''),
    category:g.category||'اكلات',
    phase:g.phase,
    roleLabel:isOutsider ? 'برا السالفة' : 'داخل السالفة',
    options:isOutsider ? (g.guessOptions||[]) : []
  });
}
function sendOutsiderAdminState(socket){
  const g=getOutsider();
  const outsider=state.players.find(p=>p.playerId===g.outsiderPlayerId);
  socket.emit('outsiderAdminState',{
    outsiderPlayerId:g.outsiderPlayerId,
    outsiderName:outsider?outsider.name:'',
    word:g.word||'',
    category:g.category||'اكلات',
    optionsCount:g.optionsCount||8,
    phase:g.phase,
    votes:g.votes||{},
    votedOutPlayerId:g.votedOutPlayerId||'',
    votedOutName:g.votedOutName||''
  });
}
function emitOutsiderSync(){
  for(const sid of io.sockets.adapter.rooms.get(roomCode)||[]){
    const s=io.sockets.sockets.get(sid);
    if(!s) continue;
    if(s.data && s.data.playerId) sendOutsiderSecret(s);
    if(s.data && s.data.isHost) sendOutsiderAdminState(s);
  }
}
function startOutsiderGame(){
  const g=getOutsider();
  if(state.players.length<3) return false;
  g.started=true;
  g.round=(g.round||0)+1;
  g.category=g.category||'اكلات';
  g.optionsCount=Math.max(3, Number(g.optionsCount)||8);
  g.word=pickOutsiderWord(g.category);
  const pool=shuffled(state.players);
  g.outsiderPlayerId=pool[0]?.playerId||'';
  g.outsiderRevealedName='';
  g.mandatoryPairs=buildOutsiderPairs(g.outsiderPlayerId);
  g.currentPairIndex=0;
  g.votes={};
  g.votedOutPlayerId='';
  g.votedOutName='';
  g.winnerText='';
  g.guessedCorrect=false;
  g.guessOptions=[];
  g.guessedWord='';
  g.canRevealOutsider=false;
  setOutsiderPhase('mandatory',`بدأت الجولة. التصنيف: ${g.category}. ابدأوا دور الأسئلة الإجباري.`);
  emitState(); emitOutsiderSync();
  return true;
}

function playerAlignment(role=''){
  return ['mafia','silentMafia'].includes(role)?'mafia':'citizens';
}
function playerRoleLabel(role=''){
  return {
    mafia:'مافيا',doctor:'دكتور',detective:'المحقق',mayor:'عمدة المواطنين',sniper:'قناص المواطنين',rope:'لاعب بالحبلين',silentMafia:'مافيا التسكيت',citizen:'مواطن'
  }[role]||role||'—';
}
function mafiaPhaseLabel(phase='setup'){
  return {
    setup:'التجهيز',roles_assigned:'توزيع الأدوار',night:'الليل',investigation:'مرحلة التحقيق',day:'النهار',voting:'التصويت',defense:'تبرير اللاعب المختار',results:'النتائج',ended:'انتهت اللعبة'
  }[phase]||phase;
}
function clearMafiaTimer(){
  if(mafiaTimerInterval){clearInterval(mafiaTimerInterval); mafiaTimerInterval=null;}
  const mafia=getMafia();
  mafia.timer={mode:'idle',secondsLeft:0,totalSeconds:0,label:''};
}
function startMafiaTimer(seconds,label,phase){
  clearMafiaTimer();
  const mafia=getMafia();
  const total=Math.max(0,Number(seconds)||0);
  mafia.timer={mode:phase||'custom',secondsLeft:total,totalSeconds:total,label:label||''};
  emitState();
  if(total<=0) return;
  mafiaTimerInterval=setInterval(()=>{
    mafia.timer.secondsLeft=Math.max(0,(mafia.timer.secondsLeft||0)-1);
    if(mafia.timer.secondsLeft<=0){clearInterval(mafiaTimerInterval); mafiaTimerInterval=null;}
    emitState();
  },1000);
}
function syncMafiaCounts(){
  const mafia=getMafia();
  mafia.aliveCount=alivePlayers().length;
  mafia.mafiaCount=alivePlayers().filter(p=>['mafia','silentMafia'].includes(p.role)).length;
}
function withRoom(url=''){ const safe = String(url||''); const sep = safe.includes('?') ? '&' : '?'; return `${safe}${sep}room=${encodeURIComponent(roomCode)}`; }
function setOverlay(type='none',url=''){state.app.overlayState={type,url:withRoom(url)};}
function hideOverlay(){setOverlay('none',''); io.to(roomCode).emit('hideOverlayOnScreen'); emitState();}
function showOverlay(type,url){setOverlay(type,url); if(type==='host') io.to(roomCode).emit('openHostQrOnScreen',{url}); if(type==='player') io.to(roomCode).emit('openPlayerQrOnScreen',{url}); emitState();}

function maybeShowMainHostQr(){
  return;
}


function clearColorTimers(){
  if(colorTimerInterval){clearInterval(colorTimerInterval); colorTimerInterval=null;}
  if(colorPhaseTimeout){clearTimeout(colorPhaseTimeout); colorPhaseTimeout=null;}
}
function resetColorGame(){
  clearColorTimers();
  state.games.color=defaultColorState();
}
function getRandomColor(recentColors=[]){
  const recent=Array.isArray(recentColors)?recentColors.filter(Boolean):[];
  const recentSet=new Set(recent);
  let pool=COLOR_POOL.filter(c=>!recentSet.has(c.name));
  if(!pool.length) pool=[...COLOR_POOL];
  return pool[Math.floor(Math.random()*pool.length)];
}
function updateColorSeconds(){
  const color=getColor();
  if(color.phase==='briefing' && color.prepEndsAt){ color.secondsLeft=Math.max(0, Math.ceil((color.prepEndsAt-Date.now())/1000)); }
  else if(color.phase==='playing' && color.roundEndsAt){ color.secondsLeft=Math.max(0, Math.ceil((color.roundEndsAt-Date.now())/1000)); }
  else color.secondsLeft=0;
}
function startColorTicker(){
  if(colorTimerInterval) clearInterval(colorTimerInterval);
  updateColorSeconds();
  emitState();
  colorTimerInterval=setInterval(()=>{ updateColorSeconds(); emitState(); }, 500);
}
function colorPhaseLabel(phase='setup'){
  return {setup:'التجهيز',briefing:'استعد',playing:'التصوير',reviewing:'مراجعة الصور',waiting_next_round:'بانتظار الجولة التالية',finished:'انتهت اللعبة'}[phase]||phase;
}
function updateColorSettings(config={}){
  const color=getColor();
  color.settings.rounds=Math.max(1, Number(config.rounds)||3);
  color.settings.prepSeconds=Math.max(3, Number(config.prepSeconds)||10);
  color.settings.playSeconds=Math.max(5, Number(config.playSeconds)||20);
  color.statusText='تم حفظ إعدادات صيد اللون';
}
function setColorPhase(phase,statusText=''){
  const color=getColor();
  color.phase=phase;
  color.phaseLabel=colorPhaseLabel(phase);
  color.statusText=statusText||color.phaseLabel;
  state.app.selectedGame='color';
  state.app.selectedGameLabel='صيد اللون';
  state.app.gamePhase=phase;
  state.app.currentRound=color.round;
  state.app.currentView=(phase==='finished' || phase==='waiting_next_round')?'game_results':'game_running';
  state.app.statusText=color.statusText;
}
function startColorNextRound(){
  const color=getColor();
  if(color.round >= color.settings.rounds){ finishColorGame(); return false; }
  clearColorTimers();
  state.app.selectedGame='color';
  state.app.selectedGameLabel='صيد اللون';
  color.started=true;
  color.round += 1;
  const chosen=getRandomColor(color.recentColors);
  color.targetColorName=chosen.name;
  color.targetColorHex=chosen.hex;
  color.recentColors=[...(color.recentColors||[]), chosen.name].slice(-8);
  color.prepEndsAt=Date.now() + color.settings.prepSeconds*1000;
  color.roundEndsAt=0;
  color.playStartedAt=0;
  color.submissions=[];
  color.lastRoundResult=null;
  setColorPhase('briefing', `استعدوا للجولة ${color.round}`);
  startColorTicker();
  io.to(roomCode).emit('colorRoundSetup',{targetColorName:color.targetColorName,targetColorHex:color.targetColorHex,prepEndsAt:color.prepEndsAt,prepSeconds:color.settings.prepSeconds});
  colorPhaseTimeout=setTimeout(()=>{
    color.playStartedAt=Date.now();
    color.roundEndsAt=Date.now() + color.settings.playSeconds*1000;
    setColorPhase('playing', `ابحثوا عن اللون ${color.targetColorName}`);
    startColorTicker();
    io.to(roomCode).emit('colorRoundStarted',{roundEndsAt:color.roundEndsAt,playSeconds:color.settings.playSeconds});
    colorPhaseTimeout=setTimeout(()=>{
      clearColorTimers();
      setColorPhase('reviewing','انتهى وقت التصوير - جاري المراجعة');
      emitState();
      io.to(roomCode).emit('colorRoundReview');
    }, color.settings.playSeconds*1000);
  }, color.settings.prepSeconds*1000);
  emitState();
  return true;
}
function submitColorPhoto({playerId,name,image}={}){
  const color=getColor();
  if(color.phase!=='playing') return {ok:false,message:'لا توجد جولة تصوير نشطة الآن'};
  const player=getPlayer(playerId) || state.players.find(p=>p.name===name);
  if(!player) return {ok:false,message:'اللاعب غير موجود'};
  if(color.submissions.find(s=>s.playerId===player.playerId)) return {ok:false,message:'تم الإرسال مسبقًا في هذه الجولة'};
  const safeImage=String(image||'');
  if(!safeImage.startsWith('data:image/jpeg;base64,')) return {ok:false,message:'صيغة الصورة غير مدعومة'};
  if(safeImage.length>COLOR_IMAGE_MAX_DATA_URL_LENGTH) return {ok:false,message:'الصورة كبيرة جدًا، حاول مرة أخرى بعد تقريب الكاميرا'};
  const id='sub_'+Date.now()+'_'+Math.random().toString(36).slice(2,8);
  color.submissions.push({id,playerId:player.playerId,name:player.name,team:player.team||'',image:safeImage,timestamp:Date.now(),elapsedMs:Date.now()-(color.playStartedAt||Date.now()),correct:null,points:0});
  emitState();
  return {ok:true};
}
function markColorSubmission({submissionId,correct}={}){
  const color=getColor();
  const sub=color.submissions.find(s=>s.id===submissionId);
  if(!sub) return;
  sub.correct=!!correct;
  emitState();
}
function finishColorReview(){
  const color=getColor();
  const correctSubs=color.submissions.filter(s=>s.correct===true).sort((a,b)=>a.elapsedMs-b.elapsedMs);
  const points=[5,3,2];
  correctSubs.forEach((s,idx)=>{ s.points=(idx<3 ? points[idx] : 1); state.playerScores[s.name]=(state.playerScores[s.name]||0)+s.points; if(s.team && state.teamScores[s.team]!==undefined) state.teamScores[s.team]+=s.points; });
  const roundTeamPoints={team1:0,team2:0};
  color.submissions.forEach(s=>{ if(s.team && roundTeamPoints[s.team]!==undefined) roundTeamPoints[s.team]+=s.points||0; });
  const teamEntries=[
    {key:'team1',name:state.teamNames.team1,points:roundTeamPoints.team1||0},
    {key:'team2',name:state.teamNames.team2,points:roundTeamPoints.team2||0}
  ].sort((a,b)=>b.points-a.points);
  const cumulativeBoard=[...state.players].map(p=>({name:p.name,team:p.team||'',points:state.playerScores[p.name]||0,roundPoints:(color.submissions.find(s=>s.playerId===p.playerId)||{}).points||0,elapsedMs:(color.submissions.find(s=>s.playerId===p.playerId)||{}).elapsedMs||0})).sort((a,b)=>(b.points||0)-(a.points||0) || (b.roundPoints||0)-(a.roundPoints||0) || a.elapsedMs-b.elapsedMs);
  color.lastRoundResult={
    fastestCorrect:correctSubs[0]||null,
    winnerTeamName:teamEntries[0]?.points>teamEntries[1]?.points?teamEntries[0].name:(teamEntries[0]?.points===teamEntries[1]?.points?'تعادل':teamEntries[0]?.name),
    winnerPoints:teamEntries[0]?.points||0,
    scoreboard:cumulativeBoard
  };
  if(color.round >= color.settings.rounds) finishColorGame();
  else { setColorPhase('waiting_next_round', `انتهت الجولة ${color.round}`); emitState(); }
}
function finishColorGame(){
  clearColorTimers();
  const color=getColor();
  color.started=true;
  const sortedPlayers=[...state.players].map(p=>({name:p.name,team:p.team||'',points:state.playerScores[p.name]||0}))
    .sort((a,b)=>b.points-a.points || a.name.localeCompare(b.name,'ar'));
  const sortedTeams=[
    {key:'team1',name:state.teamNames.team1,points:state.teamScores.team1||0},
    {key:'team2',name:state.teamNames.team2,points:state.teamScores.team2||0}
  ].sort((a,b)=>b.points-a.points);
  color.finalWinnerName=sortedPlayers[0]?.name||'';
  color.finalWinnerPoints=sortedPlayers[0]?.points||0;
  color.finalWinnerTeamName=sortedTeams[0]?.name||'';
  color.lastRoundResult={
    ...(color.lastRoundResult||{}),
    finalScoreboard:sortedPlayers
  };
  setColorPhase('finished','انتهت لعبة صيد اللون');
  emitState();
}

function clearLettersTimer(){
  if(lettersTimerInterval){ clearInterval(lettersTimerInterval); lettersTimerInterval=null; }
  const letters=getLetters();
  letters.timerSecondsLeft=0;
  letters.timerLabel='';
  letters.timerMaxSeconds=0;
}
function otherTeam(team=''){ return team==='team1' ? 'team2' : team==='team2' ? 'team1' : ''; }
function teamOnlyBuzzMode(team=''){ return team==='team1' ? 'team1_only' : team==='team2' ? 'team2_only' : 'open'; }
function updateLettersNotice(){
  const letters=getLetters();
  const teamName=(t)=>state.teamNames[t]||t||'بدون فريق';
  if(letters.winnerTeam){ letters.noticeText=`الفائز: ${teamName(letters.winnerTeam)}`; return; }
  if(letters.answerStage==='primary' && letters.currentResponderName){
    letters.noticeText=`${letters.currentResponderName} يجيب الآن مع ${letters.timerSecondsLeft} ث`;
    return;
  }
  if(letters.answerStage==='secondary'){
    if(letters.currentResponderName){ letters.noticeText=`${letters.currentResponderName} من ${teamName(letters.currentResponderTeam)} يجيب الآن مع ${letters.timerSecondsLeft} ث`; }
    else { letters.noticeText=`الفرصة الآن لـ ${teamName(letters.currentAnswerTeam)} لمدة ${letters.timerSecondsLeft} ث`; }
    return;
  }
  letters.noticeText = letters.phase==='running' ? 'الزر مفتوح للجميع' : 'بانتظار بداية اللعبة';
}
function startLettersCountdown(seconds,label,onDone){
  clearLettersTimer();
  const letters=getLetters();
  letters.timerSecondsLeft=Math.max(0, Number(seconds)||0);
  letters.timerMaxSeconds=letters.timerSecondsLeft;
  letters.timerLabel=label||'';
  updateLettersNotice();
  emitState();
  if(letters.timerSecondsLeft<=0){ if(typeof onDone==='function') onDone(); return; }
  lettersTimerInterval=setInterval(()=>{
    letters.timerSecondsLeft=Math.max(0,(letters.timerSecondsLeft||0)-1);
    updateLettersNotice();
    emitState();
    if(letters.timerSecondsLeft<=0){
      clearInterval(lettersTimerInterval); lettersTimerInterval=null;
      if(typeof onDone==='function') onDone();
    }
  },1000);
}
function reopenLettersBuzz(message='تم فتح الزر للجميع'){
  const letters=getLetters();
  clearLettersTimer();
  letters.currentResponderId='';
  letters.currentResponderName='';
  letters.currentResponderTeam='';
  letters.currentAnswerTeam='';
  letters.waitingTeam='';
  letters.answerStage='open';
  letters.buzzMode='open';
  letters.statusText=message;
  state.app.statusText=message;
  updateLettersNotice();
  emitState();
}
function sendLettersChanceToOtherTeam(message=''){
  const letters=getLetters();
  const nextTeam=letters.waitingTeam||otherTeam(letters.currentResponderTeam||letters.currentAnswerTeam);
  if(!nextTeam){ reopenLettersBuzz(message||'تم فتح الزر للجميع'); return; }
  clearLettersTimer();
  letters.currentResponderId='';
  letters.currentResponderName='';
  letters.currentResponderTeam='';
  letters.currentAnswerTeam=nextTeam;
  letters.waitingTeam='';
  letters.answerStage='secondary';
  letters.buzzMode=teamOnlyBuzzMode(nextTeam);
  const note=message||`انتهى وقت ${state.teamNames[otherTeam(nextTeam)]||'الفريق الأول'} - الفرصة الآن لـ ${state.teamNames[nextTeam]||nextTeam}`;
  letters.statusText=note;
  state.app.statusText=note;
  startLettersCountdown(letters.settings.otherTeamSeconds, 'فرصة الفريق الآخر', ()=>reopenLettersBuzz('انتهت فرصة الفريق الآخر - الزر مفتوح للجميع'));
}
function markLettersWrong(){
  const letters=getLetters();
  if(letters.phase!=='running' || letters.winnerTeam) return {ok:false,message:'اللعبة غير نشطة'};
  if(letters.answerStage==='primary'){
    sendLettersChanceToOtherTeam(`إجابة ${letters.currentResponderName||'اللاعب'} غير صحيحة - الفرصة للفريق الآخر`);
    return {ok:true};
  }
  reopenLettersBuzz(`إجابة ${letters.currentResponderName||'الفريق'} غير صحيحة - الزر مفتوح للجميع`);
  return {ok:true};
}
function lettersPhaseLabel(phase='setup'){
  return {setup:'التجهيز',running:'جارية الآن',finished:'انتهت اللعبة'}[phase]||phase;
}
function resetLettersGame(){
  clearLettersTimer();
  const prev=getLetters()||{};
  state.games.letters=defaultLettersState(prev.gridSize||5);
  state.games.letters.grid=generateLettersGrid(state.games.letters.gridSize||3);
  state.games.letters.owners=Array.from({length:state.games.letters.gridSize||3},()=>Array.from({length:state.games.letters.gridSize||3},()=>''));
  state.games.letters.settings={
    answerSeconds:prev.settings?.answerSeconds||10,
    otherTeamSeconds:prev.settings?.otherTeamSeconds||7,
    frameTopBottom:prev.settings?.frameTopBottom||'#62c924',
    frameSides:prev.settings?.frameSides||'#ff8a3d',
    team1Color:prev.settings?.team1Color||'#51c84d',
    team2Color:prev.settings?.team2Color||'#7a57d1'
  };
}
function updateLettersSettings(config={}){
  const letters=getLetters();
  letters.gridSize=Math.max(3, Math.min(5, Number(config.gridSize)||5));
  if(letters.phase==='setup'){
    letters.grid=generateLettersGrid(letters.gridSize);
    letters.owners=Array.from({length:letters.gridSize},()=>Array.from({length:letters.gridSize},()=>''));
  }
  letters.settings.answerSeconds=Math.max(3, Math.min(60, Number(config.answerSeconds)||letters.settings.answerSeconds||10));
  letters.settings.otherTeamSeconds=Math.max(3, Math.min(60, Number(config.otherTeamSeconds)||letters.settings.otherTeamSeconds||7));
  letters.settings.frameTopBottom=String(config.frameTopBottom||letters.settings.frameTopBottom||'#62c924');
  letters.settings.frameSides=String(config.frameSides||letters.settings.frameSides||'#ff8a3d');
  letters.settings.team1Color=String(config.team1Color||letters.settings.team1Color||'#51c84d');
  letters.settings.team2Color=String(config.team2Color||letters.settings.team2Color||'#7a57d1');
  letters.statusText='تم حفظ إعدادات لعبة الحروف';
  updateLettersNotice();
}
function setLettersPhase(phase,statusText=''){
  const letters=getLetters();
  letters.phase=phase;
  letters.phaseLabel=lettersPhaseLabel(phase);
  letters.statusText=statusText||letters.phaseLabel;
  state.app.selectedGame='letters';
  state.app.selectedGameLabel='لعبة الحروف';
  state.app.gamePhase=letters.phaseLabel;
  state.app.currentRound=letters.moveCount||0;
  state.app.currentView=phase==='finished'?'game_results':'game_running';
  state.app.statusText=letters.statusText;
}
let lettersPresentedQuestionTimeout=null;
function setLettersCurrentLetter(letter=''){
  const letters=getLetters();
  if(letters.phase!=='running' || letters.winnerTeam) return;
  letters.currentLetter=String(letter||'').trim().slice(0,1);
  emitState();
}
function presentLettersQuestion(payload={}){
  const letters=getLetters();
  const question=String(payload.question||'').trim();
  if(!question) return {ok:false,message:'السؤال فارغ'};
  if(lettersPresentedQuestionTimeout){ clearTimeout(lettersPresentedQuestionTimeout); lettersPresentedQuestionTimeout=null; }
  letters.presentedQuestion={
    letter:String(payload.letter||'').trim().slice(0,1),
    index:Number.isFinite(Number(payload.index)) ? Number(payload.index) : -1,
    question,
    answer:String(payload.answer||'').trim(),
    showAnswer:false,
    shownAt:Date.now(),
    answerShownAt:null,
    autoHideAt:null
  };
  emitState();
  return {ok:true};
}
function showPresentedLettersAnswer(durationMs=5000){
  const letters=getLetters();
  if(!letters.presentedQuestion) return {ok:false,message:'لا يوجد سؤال معروض'};
  const duration=Math.max(1000, Math.min(15000, Number(durationMs)||5000));
  if(lettersPresentedQuestionTimeout){ clearTimeout(lettersPresentedQuestionTimeout); lettersPresentedQuestionTimeout=null; }
  letters.presentedQuestion={
    ...letters.presentedQuestion,
    showAnswer:true,
    answerShownAt:Date.now(),
    autoHideAt:Date.now()+duration
  };
  emitState();
  lettersPresentedQuestionTimeout=setTimeout(()=>{
    const current=getLetters().presentedQuestion;
    if(current && current.showAnswer){
      getLetters().presentedQuestion=null;
      lettersPresentedQuestionTimeout=null;
      emitState();
    }
  }, duration);
  return {ok:true};
}
function clearPresentedLettersQuestion(){
  const letters=getLetters();
  if(lettersPresentedQuestionTimeout){ clearTimeout(lettersPresentedQuestionTimeout); lettersPresentedQuestionTimeout=null; }
  letters.presentedQuestion=null;
  emitState();
  return {ok:true};
}
function startLettersGame(){
  const letters=getLetters();
  clearLettersTimer();
  if(lettersPresentedQuestionTimeout){ clearTimeout(lettersPresentedQuestionTimeout); lettersPresentedQuestionTimeout=null; }
  const size=Math.max(3, Math.min(5, Number(letters.gridSize)||3));
  letters.started=true;
  letters.gridSize=size;
  letters.grid=generateLettersGrid(size);
  letters.owners=Array.from({length:size},()=>Array.from({length:size},()=>''));
  letters.currentResponderId='';
  letters.currentResponderName='';
  letters.currentResponderTeam='';
  letters.currentAnswerTeam='';
  letters.waitingTeam='';
  letters.answerStage='open';
  letters.buzzMode='open';
  letters.winnerTeam='';
  letters.winningPath=[];
  letters.moveCount=0;
  letters.currentLetter='';
  letters.noticeText='الزر مفتوح للجميع';
  letters.presentedQuestion=null;
  setLettersPhase('running','بدأت لعبة الحروف');
  emitState();
}
function clearLettersResponder(){
  reopenLettersBuzz('تم تصفير البازر الحالي وفتح الزر للجميع');
}
function lettersBuzz(playerId=''){
  const letters=getLetters();
  if(letters.phase!=='running' || letters.winnerTeam) return {ok:false,message:'اللعبة ليست في وضع البازر الآن'};
  const player=getPlayer(playerId);
  if(!player) return {ok:false,message:'اللاعب غير موجود'};
  const allowedTeam = letters.buzzMode==='team1_only' ? 'team1' : letters.buzzMode==='team2_only' ? 'team2' : '';
  if(allowedTeam && player.team!==allowedTeam) return {ok:false,message:'الزر متاح الآن للفريق الآخر فقط'};
  if(letters.answerStage==='primary' && letters.currentResponderId) return {ok:false,message:'يوجد لاعب يجيب الآن'};
  if(letters.answerStage==='secondary' && letters.currentResponderId && player.team===letters.currentAnswerTeam) return {ok:false,message:'تم تسجيل لاعب من فريقكم بالفعل'};

  letters.currentResponderId=player.playerId;
  letters.currentResponderName=player.name;
  letters.currentResponderTeam=player.team||'';
  if(letters.answerStage==='secondary'){
    letters.statusText=`${player.name} من ${state.teamNames[player.team]||player.team} استلم فرصة الإجابة`;
    state.app.statusText=letters.statusText;
    updateLettersNotice();
    emitState();
    return {ok:true};
  }

  letters.currentAnswerTeam=player.team||'';
  letters.waitingTeam=otherTeam(player.team||'');
  letters.answerStage='primary';
  letters.buzzMode='locked';
  letters.statusText=`${player.name} ضغط الزر أولًا - وقت الإجابة بدأ الآن`;
  state.app.statusText=letters.statusText;
  startLettersCountdown(letters.settings.answerSeconds, 'وقت الإجابة', ()=>sendLettersChanceToOtherTeam());
  return {ok:true};
}
function checkLettersWin(teamKey){
  const letters=getLetters();
  const size=letters.gridSize||0;
  const owners=letters.owners||[];
  const visited=new Set();
  const finalPath=[];
  const key=(r,c)=>`${r},${c}`;
  const starts=[];
  if(teamKey==='team1'){
    for(let c=0;c<size;c++) if(owners[0]?.[c]===teamKey) starts.push([0,c]);
  } else {
    for(let r=0;r<size;r++) if(owners[r]?.[0]===teamKey) starts.push([r,0]);
  }
  const neighbors=(r,c)=>{
    const dirsEven=[[0,-1],[0,1],[-1,0],[-1,-1],[1,0],[1,-1]];
    const dirsOdd=[[0,-1],[0,1],[-1,0],[-1,1],[1,0],[1,1]];
    const dirs=r%2===0?dirsEven:dirsOdd;
    return dirs.map(([dr,dc])=>[r+dr,c+dc]).filter(([nr,nc])=>nr>=0&&nr<size&&nc>=0&&nc<size);
  };
  function dfs(r,c,path){
    const k=key(r,c);
    if(visited.has(k)) return false;
    visited.add(k);
    path.push([r,c]);
    const reached=teamKey==='team1'?r===size-1:c===size-1;
    if(reached){ finalPath.splice(0,finalPath.length,...path); return true; }
    for(const [nr,nc] of neighbors(r,c)){
      if(owners[nr]?.[nc]===teamKey){
        if(dfs(nr,nc,path.slice())) return true;
      }
    }
    return false;
  }
  for(const [r,c] of starts){
    if(dfs(r,c,[])) return finalPath;
  }
  return null;
}

function recomputeLettersScores(){
  state.teamScores.team1=0;
  state.teamScores.team2=0;
  const fresh={};
  Object.keys(state.playerScores||{}).forEach(name=>fresh[name]=0);
  const letters=getLetters();
  (letters.owners||[]).forEach(row=>row.forEach(owner=>{
    if(owner==='team1' || owner==='team2') state.teamScores[owner]=(state.teamScores[owner]||0)+1;
  }));
  state.playerScores={...fresh};
}
function setLettersWinnerFromBoard(){
  const letters=getLetters();
  const win1=checkLettersWin('team1');
  const win2=checkLettersWin('team2');
  if(win1){
    letters.winnerTeam='team1';
    letters.winningPath=win1;
    clearLettersTimer();
    setLettersPhase('finished', `انتهت لعبة الحروف - الفائز ${state.teamNames.team1||'الفريق الأول'}`);
    return 'team1';
  }
  if(win2){
    letters.winnerTeam='team2';
    letters.winningPath=win2;
    clearLettersTimer();
    setLettersPhase('finished', `انتهت لعبة الحروف - الفائز ${state.teamNames.team2||'الفريق الثاني'}`);
    return 'team2';
  }
  letters.winnerTeam='';
  letters.winningPath=[];
  if(letters.phase==='finished') setLettersPhase('running', 'تم تعديل الشبكة - عادت اللعبة للتشغيل');
  return '';
}
function adjustLettersCellOwner({row,col,team}={}){
  const letters=getLetters();
  const r=Number(row), c=Number(col);
  const size=letters.gridSize||0;
  if(!Number.isInteger(r) || !Number.isInteger(c) || r<0 || c<0 || r>=size || c>=size) return {ok:false,message:'خلية غير صالحة'};
  const teamKey = team==='' ? '' : (['team1','team2'].includes(team)?team:null);
  if(teamKey===null) return {ok:false,message:'فريق غير صالح'};
  letters.owners[r][c]=teamKey;
  recomputeLettersScores();
  const winner=setLettersWinnerFromBoard();
  if(winner){
    letters.statusText=`تم تعديل الخلية - الفائز ${state.teamNames[winner]||winner}`;
  }else{
    letters.statusText=teamKey?`تم نقل الخلية إلى ${state.teamNames[teamKey]||teamKey}`:'تم تفريغ الخلية المحددة';
    state.app.statusText=letters.statusText;
  }
  emitState();
  return {ok:true};
}
function claimLettersCell({row,col,team}={}){
  const letters=getLetters();
  if(letters.phase!=='running' || letters.winnerTeam) return {ok:false,message:'اللعبة غير نشطة'};
  const r=Number(row), c=Number(col);
  const size=letters.gridSize||0;
  if(!Number.isInteger(r) || !Number.isInteger(c) || r<0 || c<0 || r>=size || c>=size) return {ok:false,message:'خلية غير صالحة'};
  if(letters.owners[r]?.[c]) return {ok:false,message:'هذه الخلية مأخوذة بالفعل'};
  const teamKey=['team1','team2'].includes(team)?team:(letters.currentResponderTeam||'');
  if(!teamKey) return {ok:false,message:'لا يوجد فريق محدد'};
  letters.owners[r][c]=teamKey;
  letters.moveCount=(letters.moveCount||0)+1;
  state.app.currentRound=letters.moveCount;
  if(letters.currentResponderName){
    state.playerScores[letters.currentResponderName]=(state.playerScores[letters.currentResponderName]||0)+1;
  }
  if(state.teamScores[teamKey]!==undefined){
    state.teamScores[teamKey]=(state.teamScores[teamKey]||0)+1;
  }
  const winPath=checkLettersWin(teamKey);
  if(winPath){
    letters.winnerTeam=teamKey;
    letters.winningPath=winPath;
    clearLettersTimer();
    setLettersPhase('finished', `انتهت لعبة الحروف - الفائز ${state.teamNames[teamKey]||teamKey}`);
  }else{
    letters.statusText=`تم حجز الخلية للفريق ${state.teamNames[teamKey]||teamKey}`;
    state.app.statusText=letters.statusText;
    reopenLettersBuzz(`تم حجز الخلية للفريق ${state.teamNames[teamKey]||teamKey} - الزر مفتوح للجميع`);
  }
  letters.currentLetter='';
  emitState();
  return {ok:true};
}
function resetScores(){state.teamScores={team1:0,team2:0}; state.playerScores={}; state.players.forEach(p=>{state.playerScores[p.name]=0;});}
function resetPlayersGameData(){state.players=state.players.map((p,index)=>({...p,role:'',isAlive:true,revealedRole:false,isSilenced:false,team:p.team||(index%2===0?'team1':'team2')})); syncMafiaCounts();}
function randomizeTeams(){const shuffled=[...state.players].sort(()=>Math.random()-0.5); shuffled.forEach((p,idx)=>{p.team=idx%2===0?'team1':'team2';}); state.players=shuffled;}

function registerPlayer({playerId,name}){
  const safeName=String(name||'').trim();
  let safePlayerId=String(playerId||'').trim();
  if(!safeName) return null;
  if(!safePlayerId) safePlayerId='p_'+Date.now()+'_'+Math.random().toString(36).slice(2);
  let existing=state.players.find(p=>p.playerId===safePlayerId);
  if(existing){existing.name=safeName; ensurePlayerScore(safeName); return existing;}
  existing=state.players.find(p=>p.name===safeName);
  if(existing){existing.playerId=safePlayerId; ensurePlayerScore(safeName); return existing;}
  const teamPick=state.players.length%2===0?'team1':'team2';
  const player={playerId:safePlayerId,name:safeName,team:teamPick,connectedAt:Date.now(),role:'',isAlive:true,revealedRole:false,isSilenced:false};
  state.players.push(player); ensurePlayerScore(player.name); syncMafiaCounts(); return player;
}

function resetMafiaGame(){
  clearMafiaTimer();
  state.games.mafia=defaultMafiaState(state.players.length);
  state.players=state.players.map(p=>({...p,role:'',isAlive:true,revealedRole:false,isSilenced:false}));
  syncMafiaCounts();
}

function updateMafiaSettings(config={}){
  const mafia=getMafia();
  mafia.settings.mafiaCount=Math.max(1,Number(config.mafiaCount ?? config.mafia)||1);
  mafia.settings.investigationSeconds=Math.max(5,Number(config.investigationSeconds)||45);
  mafia.settings.defenseSeconds=Math.max(5,Number(config.defenseSeconds)||30);
  mafia.settings.enableMayor=Boolean(config.enableMayor);
  mafia.settings.enableSniper=Boolean(config.enableSniper);
  mafia.settings.enableRopePlayer=Boolean(config.enableRopePlayer);
  mafia.settings.enableSilentMafia=Boolean(config.enableSilentMafia);
}

function assignMafiaRoles(){
  const mafia=getMafia();
  const players=[...state.players];
  if(players.length<1) return false;
  const shuffled=[...players].sort(()=>Math.random()-0.5);
  shuffled.forEach(p=>{p.role='citizen'; p.isAlive=true; p.revealedRole=false; p.isSilenced=false;});
  const mafiaCount=Math.min(Math.max(1,Number(mafia.settings.mafiaCount)||1), Math.max(1,shuffled.length-1));
  const mafiaIndexes=[];
  for(let i=0;i<mafiaCount;i++) mafiaIndexes.push(i);
  mafiaIndexes.forEach(i=>{shuffled[i].role='mafia';});
  if(mafia.settings.enableSilentMafia && mafiaIndexes.length){
    const chosen=mafiaIndexes[Math.floor(Math.random()*mafiaIndexes.length)];
    shuffled[chosen].role='silentMafia';
  }
  const citizenPool=shuffled.filter(p=>p.role==='citizen');
  const assignFromCitizens=(role)=>{
    const available=shuffled.filter(p=>p.role==='citizen');
    if(!available.length) return null;
    const selected=available[Math.floor(Math.random()*available.length)];
    selected.role=role; return selected;
  };
  assignFromCitizens('doctor');
  assignFromCitizens('detective');
  if(mafia.settings.enableMayor) assignFromCitizens('mayor');
  if(mafia.settings.enableSniper) assignFromCitizens('sniper');
  if(mafia.settings.enableRopePlayer) assignFromCitizens('rope');

  state.players=shuffled;
  mafia.phase='roles_assigned';
  mafia.phaseLabel=mafiaPhaseLabel('roles_assigned');
  mafia.started=false;
  mafia.round=1;
  mafia.statusText='تم توزيع الأدوار';
  mafia.winner='';
  mafia.revealRoles=false;
  mafia.selectedTargetId='';
  mafia.lastEliminatedId='';
  mafia.votes={};
  mafia.nightActions={mafiaKillId:'',silentTargetId:'',doctorSaveId:'',detectiveCheckId:'',sniperKillId:''};
  mafia.voteResult={selectedPlayerId:'',status:'pending',defenseOpen:false,ropeDecisionPending:false,ropePullTargetId:'',notes:'',revealedRole:'',revealedAlignment:''};
  mafia.daySummary={killedId:'',savedId:'',silencedId:'',checkedId:'',checkedRole:'',sniperKilledId:'',notes:'',ropeVictimId:''};
  mafia.sniperUsed=false;
  const counts={mafia:0,doctor:0,detective:0,mayor:0,sniper:0,rope:0,silentMafia:0,citizen:0};
  state.players.forEach(p=>{counts[p.role]=(counts[p.role]||0)+1;});
  mafia.roleSummary=counts;
  state.app.selectedGame='mafia';
  state.app.selectedGameLabel='لعبة المافيا';
  state.app.currentView='game_selected';
  state.app.statusText='تم توزيع أدوار المافيا';
  state.app.gamePhase='توزيع الأدوار';
  state.app.currentRound=1;
  syncMafiaCounts();
  emitState();
  return true;
}

function setMafiaPhase(phase){
  const mafia=getMafia();
  mafia.phase=phase;
  mafia.phaseLabel=mafiaPhaseLabel(phase);
  mafia.statusText=mafia.phaseLabel;
  state.app.gamePhase=mafia.phaseLabel;
  state.app.currentView='game_running';
  if(phase==='night') state.app.statusText=`ليلة ${mafia.round} بدأت`;
  else if(phase==='investigation') state.app.statusText='بدأ وقت التحقيق';
  else if(phase==='day') state.app.statusText=`نهار ${mafia.round} بدأ`;
  else if(phase==='voting') state.app.statusText='بدأ التصويت';
  else if(phase==='defense') state.app.statusText='بدأ وقت التبرير';
  else if(phase==='results') state.app.statusText='عرض النتائج';
  else if(phase==='ended') state.app.statusText='انتهت لعبة المافيا';
  emitState();
}

function checkMafiaWinner(){
  const mafia=getMafia();
  const alive=alivePlayers();
  const mafiaAlive=alive.filter(p=>['mafia','silentMafia'].includes(p.role)).length;
  const citizensAlive=alive.filter(p=>!['mafia','silentMafia'].includes(p.role)).length;
  const totalAlive=alive.length;
  if(mafiaAlive<=0){ mafia.winner='citizens'; mafia.phase='ended'; mafia.phaseLabel='فوز المواطنين'; state.app.gamePhase='فوز المواطنين'; state.app.statusText='انتهت اللعبة - فاز المواطنون'; return true; }
  if(mafiaAlive>=citizensAlive || mafiaAlive===totalAlive || totalAlive===mafiaAlive*2){ mafia.winner='mafia'; mafia.phase='ended'; mafia.phaseLabel='فوز المافيا'; state.app.gamePhase='فوز المافيا'; state.app.statusText='انتهت اللعبة - فازت المافيا'; return true; }
  return false;
}


function eliminatePlayer(playerId,reason=''){
  const target=getPlayer(playerId);
  if(!target || !target.isAlive) return false;
  target.isAlive=false; target.revealedRole=true; target.isSilenced=false;
  const mafia=getMafia();
  mafia.lastEliminatedId=playerId;
  if(reason) mafia.daySummary.notes=reason;
  syncMafiaCounts();
  checkMafiaWinner();
  emitState();
  return true;
}

function reviveAllMafiaPlayers(){state.players.forEach(p=>{p.isAlive=true; p.revealedRole=false; p.isSilenced=false;}); syncMafiaCounts(); emitState();}
function setPlayerVote(voterId,targetId){const mafia=getMafia(); mafia.votes[voterId]=targetId; emitState();}

function startNightPhase(){
  const mafia=getMafia();
  const hasRoles = state.players.some(p=>p.role);
  if(!hasRoles) assignMafiaRoles();
  mafia.started=true;
  state.app.selectedGame='mafia';
  state.app.selectedGameLabel='لعبة المافيا';
  state.app.currentView='game_running';
  state.app.currentRound=mafia.round||1;
  state.players.forEach(p=>{p.isSilenced=false;});
  mafia.nightActions={mafiaKillId:'',silentTargetId:'',doctorSaveId:'',detectiveCheckId:'',sniperKillId:''};
  mafia.voteResult={selectedPlayerId:'',status:'pending',defenseOpen:false,ropeDecisionPending:false,ropePullTargetId:'',notes:'',revealedRole:'',revealedAlignment:''};
  mafia.daySummary={killedId:'',savedId:'',silencedId:'',checkedId:'',checkedRole:'',sniperKilledId:'',notes:'',ropeVictimId:''};
  setMafiaPhase('night');
}
function startInvestigationPhase(){
  const mafia=getMafia();
  setMafiaPhase('investigation');
  startMafiaTimer(mafia.settings.investigationSeconds,'وقت التحقيق','investigation');
}
function startVotingPhase(){clearMafiaTimer(); setMafiaPhase('voting');}
function startDefensePhase(){
  const mafia=getMafia();
  mafia.voteResult.defenseOpen=true;
  setMafiaPhase('defense');
  startMafiaTimer(mafia.settings.defenseSeconds,'وقت تبرير اللاعب المختار','defense');
}
function nextMafiaRound(){const mafia=getMafia(); mafia.round=(mafia.round||0)+1; state.app.currentRound=mafia.round; state.app.statusText=`تم الانتقال إلى الجولة ${mafia.round}`; emitState();}

function setNightAction(actionKey,playerId=''){
  const mafia=getMafia();
  if(!(actionKey in mafia.nightActions)) return;
  if(actionKey==='sniperKillId' && mafia.sniperUsed && playerId) return;
  mafia.nightActions[actionKey]=playerId||'';
  emitState();
}

function resolveNightSummary(){
  const mafia=getMafia();
  const actions=mafia.nightActions;
  const summary={killedId:'',savedId:'',silencedId:'',checkedId:'',checkedRole:'',sniperKilledId:'',notes:'',ropeVictimId:''};
  if(actions.silentTargetId){
    const silenced=getPlayer(actions.silentTargetId);
    if(silenced && silenced.isAlive){silenced.isSilenced=true; summary.silencedId=silenced.playerId;}
  }
  if(actions.detectiveCheckId){
    const checked=getPlayer(actions.detectiveCheckId);
    if(checked){summary.checkedId=checked.playerId; summary.checkedRole=playerRoleLabel(checked.role);}
  }
  if(actions.mafiaKillId){
    const target=getPlayer(actions.mafiaKillId);
    if(target && target.isAlive){
      if(actions.doctorSaveId && actions.doctorSaveId===target.playerId){summary.savedId=target.playerId;}
      else {
        target.isAlive=false; target.revealedRole=true; summary.killedId=target.playerId; mafia.lastEliminatedId=target.playerId;
        if(target.role==='rope'){ mafia.voteResult.ropeDecisionPending=true; summary.ropeVictimId=target.playerId; }
      }
    }
  }
  if(actions.sniperKillId && !mafia.sniperUsed){
    const sniperTarget=getPlayer(actions.sniperKillId);
    if(sniperTarget && sniperTarget.isAlive){
      sniperTarget.isAlive=false; sniperTarget.revealedRole=true; summary.sniperKilledId=sniperTarget.playerId; mafia.lastEliminatedId=sniperTarget.playerId;
      mafia.sniperUsed=true;
      if(sniperTarget.role==='rope'){ mafia.voteResult.ropeDecisionPending=true; summary.ropeVictimId=sniperTarget.playerId; }
    }
  }
  mafia.daySummary=summary;
  syncMafiaCounts();
  checkMafiaWinner();
  emitState();
}

function setVoteSelectedPlayer(playerId=''){
  const mafia=getMafia();
  mafia.voteResult.selectedPlayerId=playerId;
  mafia.voteResult.status='selected';
  mafia.voteResult.defenseOpen=false;
  mafia.voteResult.ropeDecisionPending=false;
  mafia.voteResult.ropePullTargetId='';
  emitState();
}
function confirmVoteElimination(){
  const mafia=getMafia();
  const playerId=mafia.voteResult.selectedPlayerId;
  if(!playerId) return false;
  const target=getPlayer(playerId);
  if(!target || !target.isAlive) return false;
  const wasRope=target.role==='rope';
  mafia.voteResult.revealedRole=playerRoleLabel(target.role);
  mafia.voteResult.revealedAlignment=playerAlignment(target.role);
  eliminatePlayer(playerId,'تم إقصاؤه بالتصويت');
  mafia.voteResult.status='eliminated';
  mafia.voteResult.defenseOpen=false;
  mafia.voteResult.ropeDecisionPending=wasRope;
  if(wasRope) mafia.daySummary.ropeVictimId=playerId;
  emitState();
  return true;
}
function cancelVoteElimination(){
  const mafia=getMafia();
  mafia.voteResult.status='cancelled';
  mafia.voteResult.defenseOpen=false;
  clearMafiaTimer();
  emitState();
}
function setRopePullTarget(playerId=''){const mafia=getMafia(); mafia.voteResult.ropePullTargetId=playerId; emitState();}
function applyRopePull(){
  const mafia=getMafia();
  if(!mafia.voteResult.ropeDecisionPending || !mafia.voteResult.ropePullTargetId) return false;
  const target=getPlayer(mafia.voteResult.ropePullTargetId);
  if(!target || !target.isAlive) return false;
  eliminatePlayer(target.playerId,'تم سحبه مع لاعب الحبلين');
  mafia.daySummary.notes='تم سحب لاعب مع لاعب الحبلين';
  mafia.voteResult.ropeDecisionPending=false;
  emitState();
  return true;
}


function exitCurrentGameToTeams(){
  clearMafiaTimer();
  clearColorTimers();
  resetMafiaGame();
  resetColorGame();
  resetLettersGame();
  resetOutsiderGame();
  state.app.selectedGame='';
  state.app.selectedGameLabel='';
  state.app.currentView='lobby';
  state.app.statusText='تم الخروج من اللعبة';
  state.app.gamePhase='';
  state.app.currentRound=0;
  hideOverlay();
  io.to(roomCode).emit('gameEnded');
  emitState();
}


function attachSocket(socket){
socket.emit('stateUpdate',buildState());
  socket.on('registerPlayer',(payload={})=>{const player=registerPlayer(payload); if(!player) return; socket.data.playerId=player.playerId; socket.data.playerName=player.name; socket.emit('playerRegistered',{name:player.name,playerId:player.playerId}); emitState(); sendOutsiderSecret(socket);});
  socket.on('registerHost',(payload={})=>{ socket.data.isHost=true; state.hosts=state.hosts.filter(h=>h.socketId!==socket.id); state.hosts.push({socketId:socket.id,page:payload.page||'host',connectedAt:Date.now()}); state.app.introDismissed=true; if(!state.app.selectedGame){ state.app.currentView='lobby'; state.app.statusText='بانتظار دخول اللاعبين'; state.app.gamePhase=''; state.app.currentRound=0; } hideOverlay(); emitState(); emitOutsiderSync(); emitColorHostAdminState();});
  socket.on('screenReady',()=>{maybeShowMainHostQr(); socket.emit('stateUpdate',buildState());});
  socket.on('forceLobbyView',()=>{ state.app.selectedGame=''; state.app.selectedGameLabel=''; state.app.currentView='lobby'; state.app.statusText='بانتظار دخول اللاعبين'; state.app.gamePhase=''; state.app.currentRound=0; state.app.introDismissed=true; hideOverlay(); emitState(); });

  socket.on('selectGame',({gameKey,gameLabel}={})=>{state.app.selectedGame=gameKey||''; state.app.selectedGameLabel=gameLabel||''; state.app.currentView='game_selected'; state.app.statusText=gameLabel?`تم اختيار ${gameLabel}`:'تم اختيار اللعبة'; state.app.gamePhase=''; state.app.currentRound=0; state.app.introDismissed=true; hideOverlay(); resetPlayersGameData(); resetScores(); if(gameKey==='mafia') resetMafiaGame(); if(gameKey==='color') resetColorGame(); if(gameKey==='letters') resetLettersGame(); if(gameKey==='outsider') resetOutsiderGame(true); emitState();});
  socket.on('clearSelectedGame',()=>{state.app.selectedGame=''; state.app.selectedGameLabel=''; state.app.currentView='lobby'; state.app.statusText='بانتظار اختيار اللعبة'; state.app.gamePhase=''; state.app.currentRound=0; emitState();});
  socket.on('renameTeam',({teamKey,teamName}={})=>{if(!teamKey||!state.teamNames[teamKey]) return; const safeTeamName=String(teamName||'').trim(); if(!safeTeamName) return; state.teamNames[teamKey]=safeTeamName; emitState();});
  socket.on('assignPlayerTeam',({playerId,team}={})=>{const player=state.players.find(p=>p.playerId===playerId); if(!player) return; if(!['team1','team2',''].includes(team)) return; player.team=team||''; emitState();});
  socket.on('removePlayer',({playerId}={})=>{const target=state.players.find(p=>p.playerId===playerId); if(!target) return; delete state.playerScores[target.name]; state.players=state.players.filter(p=>p.playerId!==playerId); syncMafiaCounts(); emitState();});
  socket.on('randomizeTeams',()=>{randomizeTeams(); emitState();});
  socket.on('restartSetup',()=>{state.app.currentView='lobby'; state.app.statusText='تمت إعادة الإعدادات'; state.app.gamePhase=''; state.app.currentRound=0; state.app.selectedGame=''; state.app.selectedGameLabel=''; setOverlay('none',''); resetScores(); resetPlayersGameData(); resetMafiaGame(); resetColorGame(); resetLettersGame(); resetOutsiderGame(false); emitState();});
  socket.on('showHostQr',()=>showOverlay('host','/host.html'));
  socket.on('showPlayerQr',()=>showOverlay('player','/player.html'));
  socket.on('showMafiaHostQr',()=>showOverlay('host','/games/mafia/host'));
  socket.on('showMafiaPlayerQr',()=>showOverlay('player','/games/mafia/player'));
  socket.on('showColorHostQr',()=>showOverlay('host','/games/color/host'));
  socket.on('showColorPlayerQr',()=>showOverlay('player','/games/color/player'));
  socket.on('showLettersHostQr',()=>showOverlay('host','/games/letters/host'));
  socket.on('showLettersPlayerQr',()=>showOverlay('player','/games/letters/player'));
  socket.on('showOutsiderHostQr',()=>showOverlay('host','/games/outsider/host'));
  socket.on('showOutsiderPlayerQr',()=>showOverlay('player','/games/outsider/player'));
  socket.on('hideOverlay',()=>hideOverlay());
  socket.on('exitGameToTeams',()=>exitCurrentGameToTeams());

  socket.on('mafiaUpdateConfig',(config={})=>{updateMafiaSettings(config); emitState();});
  socket.on('mafiaAssignRoles',()=>assignMafiaRoles());
  socket.on('mafiaStartNight',()=>startNightPhase());
  socket.on('mafiaStartInvestigation',()=>startInvestigationPhase());
  socket.on('mafiaStartDay',()=>{clearMafiaTimer(); resolveNightSummary(); setMafiaPhase('day');});
  socket.on('mafiaStartVoting',()=>startVotingPhase());
  socket.on('mafiaOpenDefense',()=>startDefensePhase());
  socket.on('mafiaShowResults',()=>{clearMafiaTimer(); setMafiaPhase('results');});
  socket.on('mafiaEndGame',()=>{const mafia=getMafia(); mafia.revealRoles=true; checkMafiaWinner(); clearMafiaTimer(); setMafiaPhase('ended'); emitState();});
  socket.on('mafiaReset',()=>{resetMafiaGame(); state.app.selectedGame='mafia'; state.app.selectedGameLabel='لعبة المافيا'; state.app.currentView='game_selected'; state.app.statusText='تم تصفير المافيا'; emitState();});
  socket.on('mafiaSelectTarget',({playerId}={})=>{const mafia=getMafia(); mafia.selectedTargetId=playerId||''; emitState();});
  socket.on('mafiaEliminateSelected',()=>{const mafia=getMafia(); if(mafia.selectedTargetId) eliminatePlayer(mafia.selectedTargetId);});
  socket.on('mafiaEliminatePlayer',({playerId}={})=>{if(playerId) eliminatePlayer(playerId);});
  socket.on('mafiaReviveAll',()=>reviveAllMafiaPlayers());
  socket.on('mafiaToggleRevealRoles',()=>{const mafia=getMafia(); mafia.revealRoles=!mafia.revealRoles; emitState();});
  socket.on('mafiaNextRound',()=>nextMafiaRound());
  socket.on('mafiaSetVote',({voterId,targetId}={})=>{if(voterId && targetId) setPlayerVote(voterId,targetId);});
  socket.on('mafiaSetNightAction',({actionKey,playerId}={})=>setNightAction(actionKey,playerId));
  socket.on('mafiaSelectVoteTarget',({playerId}={})=>setVoteSelectedPlayer(playerId));
  socket.on('mafiaConfirmVoteElimination',()=>confirmVoteElimination());
  socket.on('mafiaCancelVoteElimination',()=>cancelVoteElimination());
  socket.on('mafiaSetRopePullTarget',({playerId}={})=>setRopePullTarget(playerId));
  socket.on('mafiaApplyRopePull',()=>applyRopePull());
  socket.on('mafiaStartTimer',({seconds,label,phase}={})=>startMafiaTimer(seconds,label,phase));
  socket.on('mafiaClearTimer',()=>{clearMafiaTimer(); emitState();});
  socket.on('colorUpdateConfig',(config={})=>{updateColorSettings(config); emitState();});
  socket.on('colorStartNextRound',()=>{startColorNextRound();});
  socket.on('colorSubmitPhoto',(payload={})=>{const result=submitColorPhoto(payload); if(result.ok) socket.emit('submissionAccepted'); else socket.emit('submissionRejected',{message:result.message});});
  socket.on('colorMarkSubmission',(payload={})=>{markColorSubmission(payload);});
  socket.on('colorFinishReview',()=>{finishColorReview();});
  socket.on('colorReset',()=>{resetScores(); resetPlayersGameData(); resetColorGame(); state.app.selectedGame='color'; state.app.selectedGameLabel='صيد اللون'; state.app.currentView='game_selected'; state.app.statusText='تم تصفير صيد اللون'; emitState();});
socket.on('lettersPrime',()=>{state.app.selectedGame='letters'; state.app.selectedGameLabel='لعبة الحروف'; if(!state.app.currentView||state.app.currentView==='lobby') state.app.currentView='game_selected'; emitState();});
  socket.on('lettersUpdateConfig',(config={})=>{updateLettersSettings(config); emitState();});
  socket.on('lettersStart',()=>{startLettersGame();});
  socket.on('lettersSetCurrentLetter',({letter}={})=>{setLettersCurrentLetter(letter);});
  socket.on('lettersPresentQuestion',(payload={})=>{presentLettersQuestion(payload);});
  socket.on('lettersShowQuestionAnswer',({durationMs}={})=>{showPresentedLettersAnswer(durationMs);});
  socket.on('lettersClearPresentedQuestion',()=>{clearPresentedLettersQuestion();});
  socket.on('lettersBuzz',({playerId}={})=>{const result=lettersBuzz(playerId); if(result.ok) socket.emit('lettersBuzzAccepted'); else socket.emit('lettersBuzzRejected',{message:result.message});});
  socket.on('lettersClearResponder',()=>{clearLettersResponder();});
  socket.on('lettersMarkWrong',()=>{const result=markLettersWrong(); if(!result.ok) socket.emit('lettersClaimRejected',{message:result.message});});
  socket.on('lettersClaimCell',(payload={})=>{const result=claimLettersCell(payload); if(!result.ok) socket.emit('lettersClaimRejected',{message:result.message});});
  socket.on('lettersAdjustCellOwner',(payload={})=>{const result=adjustLettersCellOwner(payload); if(!result.ok) socket.emit('lettersClaimRejected',{message:result.message});});
  socket.on('lettersReset',()=>{resetScores(); resetPlayersGameData(); resetLettersGame(); state.app.selectedGame='letters'; state.app.selectedGameLabel='لعبة الحروف'; state.app.currentView='game_selected'; state.app.statusText='تمت إعادة لعبة الحروف'; emitState();});

  socket.on('outsiderPrime',()=>{state.app.selectedGame='outsider'; state.app.selectedGameLabel='برا السالفة'; if(!state.app.currentView||state.app.currentView==='lobby') state.app.currentView='game_selected'; state.app.statusText='تم اختيار لعبة برا السالفة'; emitState(); sendOutsiderAdminState(socket);});
  socket.on('outsiderSetConfig',({category,optionsCount}={})=>{ const g=getOutsider(); if(category && OUTSIDER_WORD_BANK[category]) g.category=category; if(optionsCount) g.optionsCount=Math.max(4, Number(optionsCount)||8); emitState(); emitOutsiderSync(); });
  socket.on('outsiderStart',()=>{ if(startOutsiderGame()) io.to(roomCode).emit('gamefx:intro',{text:'برا السالفة'}); else socket.emit('outsiderError',{message:'تحتاج 3 لاعبين على الأقل'}); });
  socket.on('outsiderNextMandatory',()=>{ const g=getOutsider(); if(g.phase!=='mandatory') return; g.currentPairIndex=Math.min((g.currentPairIndex||0)+1, (g.mandatoryPairs||[]).length); if(g.currentPairIndex>=(g.mandatoryPairs||[]).length){ setOutsiderPhase('open','الأسئلة مفتوحة الآن على الجميع.'); } emitState(); emitOutsiderSync();});
  socket.on('outsiderStartVoting',()=>{ const g=getOutsider(); if(!g.started) return; setOutsiderPhase('voting','بدأ التصويت. اختروا الشخص المشكوك فيه.'); emitState(); emitOutsiderSync(); });
  socket.on('outsiderVote',({voterId,targetId}={})=>{ const g=getOutsider(); if(g.phase!=='voting' || !voterId || !targetId || voterId===targetId) return; g.votes[voterId]=targetId; emitState(); sendOutsiderSecret(socket); sendOutsiderAdminState(socket); });
  socket.on('outsiderFinishVoting',()=>{ const g=getOutsider(); if(g.phase!=='voting') return; const tally={}; Object.values(g.votes||{}).forEach(t=>{ if(t) tally[t]=(tally[t]||0)+1; }); const winner=Object.entries(tally).sort((a,b)=>b[1]-a[1])[0]; g.votedOutPlayerId=winner?winner[0]:''; const voted=state.players.find(p=>p.playerId===g.votedOutPlayerId); g.votedOutName=voted?voted.name:''; const outsiderPlayer=state.players.find(p=>p.playerId===g.outsiderPlayerId); g.outsiderRevealedName=outsiderPlayer?outsiderPlayer.name:''; Object.entries(g.votes||{}).forEach(([voterId,targetId])=>{ if(targetId===g.outsiderPlayerId){ const voter=state.players.find(p=>p.playerId===voterId); if(voter) state.playerScores[voter.name]=(state.playerScores[voter.name]||0)+1; } }); g.canRevealOutsider=!!g.votedOutPlayerId && g.votedOutPlayerId===g.outsiderPlayerId; const others=outsiderCategoryWords(g.category).filter(w=>w!==g.word); g.guessOptions=shuffled([g.word, ...shuffled(others).slice(0, Math.max(3,(g.optionsCount||8)-1))]); if(g.canRevealOutsider){ setOutsiderPhase('guessing',`تم كشف برا السالفة: ${g.votedOutName}. الآن يحاول تخمين الكلمة.`); } else { setOutsiderPhase('guessing',`لم يتم كشف برا السالفة. الآن يحصل ${g.outsiderRevealedName||'برا السالفة'} على فرصة أخيرة لتخمين الكلمة.`); } emitState(); emitOutsiderSync(); });
  socket.on('outsiderGuess',({playerId,word}={})=>{ const g=getOutsider(); if(g.phase!=='guessing' || playerId!==g.outsiderPlayerId) return; g.guessedWord=String(word||''); g.outsiderRevealedName=(state.players.find(p=>p.playerId===g.outsiderPlayerId)||{}).name||''; if(g.guessedWord===g.word){ const outsider=state.players.find(p=>p.playerId===g.outsiderPlayerId); if(outsider) state.playerScores[outsider.name]=(state.playerScores[outsider.name]||0)+1; g.guessedCorrect=true; g.winnerText=`${g.outsiderRevealedName} كان برا السالفة ونجح في معرفة الكلمة.`; } else { g.guessedCorrect=false; g.winnerText=g.canRevealOutsider ? 'تم كشف برا السالفة لكنه لم يعرف الكلمة. لا نقاط إضافية.' : `${g.outsiderRevealedName} كان برا السالفة لكنه لم يعرف الكلمة. لا نقاط إضافية.`; } setOutsiderPhase('finished', g.winnerText); emitState(); emitOutsiderSync(); });
  socket.on('outsiderReset',()=>{ resetPlayersGameData(); resetOutsiderGame(true); state.app.selectedGame='outsider'; state.app.selectedGameLabel='برا السالفة'; state.app.currentView='game_selected'; state.app.statusText='تمت إعادة لعبة برا السالفة'; emitState(); emitOutsiderSync();});
  socket.on('outsiderRequestSecret',()=>sendOutsiderSecret(socket));
  socket.on('outsiderRequestAdminState',()=>sendOutsiderAdminState(socket));
  socket.on('disconnect',()=>{state.hosts=state.hosts.filter(h=>h.socketId!==socket.id); state.lastActivityAt=Date.now(); if(state.hosts.length===0) maybeShowMainHostQr(); emitState();});
}
return { state, buildState, emitState, attachSocket };
}

const rooms=new Map();
function normalizeRoomCode(code=''){
  return String(code||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,8);
}

function generateRoomCode(){
  const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code='';
  do { code=Array.from({length:4},()=>chars[Math.floor(Math.random()*chars.length)]).join(''); } while(rooms.has(code) || roomDefinitions.has(code) || usersHasRoom(code));
  return code;
}
function getRoomContext(code='MAIN'){
  const roomCode=normalizeRoomCode(code) || 'MAIN';
  touchRoomDefinition(roomCode);
  if(!rooms.has(roomCode)) rooms.set(roomCode, createRoomContext(roomCode, getStoredRoomSnapshot(roomCode)));
  const ctx=rooms.get(roomCode);
  if(ctx?.state) ctx.state.lastActivityAt=Date.now();
  return ctx;
}
function getRoomCodeFromReq(req){
  return normalizeRoomCode((req.query&&req.query.room)||'');
}
function roomHasLiveConnections(roomCode=''){
  const sockets=io.sockets.adapter.rooms.get(roomCode);
  return !!(sockets && sockets.size);
}
function cleanupInactiveRooms(){
  const now=Date.now();
  for(const [code,ctx] of rooms.entries()) {
    if(code==='MAIN') continue;
    const hasConnections=roomHasLiveConnections(code);
    const isPermanent=roomDefinitions.get(code)?.isPermanent!==false;
    const lastActivity=Number(ctx?.state?.lastActivityAt||0) || 0;
    const idleMs=now-lastActivity;
    if(hasConnections) continue;
    if(idleMs<ROOM_IDLE_EVICT_MS) continue;
    persistRoomSnapshot(code, ctx.state);
    if(isPermanent || !hasConnections) rooms.delete(code);
  }
}
setInterval(cleanupInactiveRooms, ROOM_CLEANUP_INTERVAL_MS).unref();


app.post('/api/auth/register',(req,res)=>{
  const name=String(req.body?.name||'').trim();
  const email=normalizeEmail(req.body?.email||'');
  const password=String(req.body?.password||'');
  if(!name || !email || !password) return res.status(400).json({ok:false,message:'أكمل الاسم والإيميل وكلمة المرور'});
  if(!validatePasswordStrength(password)) return res.status(400).json({ok:false,message:'كلمة المرور يجب أن تكون 6 أحرف على الأقل'});
  if(users.has(email)) return res.status(409).json({ok:false,message:'هذا الإيميل مسجل مسبقاً'});
  const user={name,email,passwordHash:hashPassword(password),activated:false,roomId:'',activationCode:'',plan:'',isActive:true,createdAt:safeNow(),updatedAt:safeNow()};
  users.set(email,user);
  saveData();
  const token=issueUserSession(email);
  setAuthCookie(res, USER_COOKIE, token);
  res.json({ok:true,token,user:serializeUser(user)});
});

app.post('/api/auth/login',(req,res)=>{
  const email=normalizeEmail(req.body?.email||'');
  const password=String(req.body?.password||'');
  const user=users.get(email);
  if(!user || !verifyPassword(password, user.passwordHash||user.password||'')) return res.status(401).json({ok:false,message:'بيانات الدخول غير صحيحة'});
  if(user.isActive===false) return res.status(403).json({ok:false,message:'هذا الحساب غير مفعل من الإدارة'});
  const token=issueUserSession(email);
  setAuthCookie(res, USER_COOKIE, token);
  res.json({ok:true,token,user:serializeUser(user)});
});

app.get('/api/auth/me',(req,res)=>{
  const session=getUserSession(req);
  if(!session) return res.status(401).json({ok:false,message:'لا توجد جلسة'});
  res.json(buildSessionPayload(session.user));
});

app.get('/api/auth/my-room',(req,res)=>{
  const session=requireUser(req,res); if(!session) return;
  const roomId=ensureUserRoom(session.user);
  const def=touchRoomDefinition(roomId,{ownerEmail:session.email,label:session.user.name||roomId});
  res.json({ok:true,room:{roomId,ownerEmail:def?.ownerEmail||session.email,label:def?.label||roomId,isPermanent:true,lastOpenedAt:def?.lastOpenedAt||0}});
});

app.post('/api/auth/logout',(req,res)=>{
  const token=readAuthToken(req, USER_COOKIE);
  if(token) userSessions.delete(token);
  clearAuthCookie(res, USER_COOKIE);
  res.json({ok:true});
});

app.post('/api/auth/activate',(req,res)=>{
  const session=requireUser(req,res); if(!session) return;
  const code=String(req.body?.code||'').trim().toUpperCase();
  if(!code) return res.status(400).json({ok:false,message:'اكتب كود التفعيل'});
  const entry=activationCodes.get(code);
  if(!entry) return res.status(404).json({ok:false,message:'كود التفعيل غير موجود'});
  if(entry.used && entry.usedBy!==session.email) return res.status(409).json({ok:false,message:'تم استخدام هذا الكود مسبقاً'});
  entry.used=true; entry.usedBy=session.email; entry.usedAt=safeNow();
  const user=session.user;
  user.activated=true; user.activationCode=code; user.plan=entry.plan;
  ensureUserRoom(user);
  touchUser(user);
  saveData();
  res.json({ok:true,message:'تم تفعيل الحساب بنجاح',user:serializeUser(user)});
});

app.post('/api/owner/login',(req,res)=>{
  const username=String(req.body?.username||'').trim();
  const password=String(req.body?.password||'');
  const owner=ownerAccounts.find(o=>o.username===username && verifyPassword(password, o.passwordHash));
  if(!owner) return res.status(401).json({ok:false,message:'بيانات دخول المالك غير صحيحة'});
  const token=issueOwnerSession(owner.username);
  setAuthCookie(res, OWNER_COOKIE, token);
  res.json({ok:true,token,owner:{username:owner.username,displayName:owner.displayName}});
});

app.get('/api/owner/me',(req,res)=>{
  const session=getOwnerSession(req);
  if(!session) return res.status(401).json({ok:false,message:'لا توجد جلسة'});
  const owner=ownerAccounts.find(o=>o.username===session.username);
  res.json({ok:true,owner:{username:session.username,displayName:owner?.displayName||'المالك'}});
});

app.post('/api/owner/logout',(req,res)=>{
  const token=readAuthToken(req, OWNER_COOKIE);
  if(token) ownerSessions.delete(token);
  clearAuthCookie(res, OWNER_COOKIE);
  res.json({ok:true});
});

app.get('/api/owner/users',(req,res)=>{
  const session=requireOwner(req,res); if(!session) return;
  const list=Array.from(users.values()).map(serializeUser).sort((a,b)=>b.createdAt-a.createdAt);
  res.json({ok:true,users:list});
});

app.post('/api/owner/users',(req,res)=>{
  const session=requireOwner(req,res); if(!session) return;
  const name=String(req.body?.name||'').trim();
  const email=normalizeEmail(req.body?.email||'');
  const password=String(req.body?.password||'');
  const activateNow=!!req.body?.activateNow;
  const plan=String(req.body?.plan||'pro').toLowerCase();
  if(!name || !email || !password) return res.status(400).json({ok:false,message:'أكمل الاسم والإيميل وكلمة المرور'});
  if(!validatePasswordStrength(password)) return res.status(400).json({ok:false,message:'كلمة المرور يجب أن تكون 6 أحرف على الأقل'});
  if(users.has(email)) return res.status(409).json({ok:false,message:'هذا الإيميل موجود مسبقاً'});
  const user={name,email,passwordHash:hashPassword(password),activated:false,roomId:'',activationCode:'',plan:'',isActive:true,createdAt:safeNow(),updatedAt:safeNow()};
  if(activateNow){
    const code=createActivationCode(plan);
    code.used=true; code.usedBy=email; code.usedAt=safeNow();
    user.activated=true; user.activationCode=code.code; user.plan=code.plan; ensureUserRoom(user);
  }
  users.set(email,user);
  saveData();
  res.json({ok:true,user:serializeUser(user)});
});

app.post('/api/owner/users/toggle',(req,res)=>{
  const session=requireOwner(req,res); if(!session) return;
  const email=normalizeEmail(req.body?.email||'');
  const user=users.get(email);
  if(!user) return res.status(404).json({ok:false,message:'الحساب غير موجود'});
  user.isActive = user.isActive===false ? true : false;
  touchUser(user);
  res.json({ok:true,user:serializeUser(user)});
});

app.post('/api/owner/users/reset-password',(req,res)=>{
  const session=requireOwner(req,res); if(!session) return;
  const email=normalizeEmail(req.body?.email||'');
  const password=String(req.body?.password||'');
  const user=users.get(email);
  if(!user) return res.status(404).json({ok:false,message:'الحساب غير موجود'});
  if(!validatePasswordStrength(password)) return res.status(400).json({ok:false,message:'كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل'});
  user.passwordHash=hashPassword(password);
  touchUser(user);
  res.json({ok:true});
});

app.get('/api/owner/activation-codes',(req,res)=>{
  const session=requireOwner(req,res); if(!session) return;
  const codes=Array.from(activationCodes.values()).sort((a,b)=>b.createdAt-a.createdAt);
  res.json({ok:true,codes});
});

app.post('/api/owner/activation-codes',(req,res)=>{
  const session=requireOwner(req,res); if(!session) return;
  const count=Math.max(1, Math.min(20, Number(req.body?.count)||1));
  const plan=String(req.body?.plan||'pro').toLowerCase();
  const created=[];
  for(let i=0;i<count;i++) created.push(createActivationCode(plan));
  res.json({ok:true,codes:created});
});

app.get('/api/system/redis-status',(req,res)=>{
  res.json({
    ok:true,
    enabled:isRedisEnabled(),
    redisUrlConfigured: !!String(process.env.REDIS_URL||'').trim(),
    packagesInstalled: !!(createRedisClient && createAdapter)
  });
});

app.get('/api/owner/stats',(req,res)=>{
  const session=requireOwner(req,res); if(!session) return;
  const allUsers=Array.from(users.values());
  res.json({ok:true,stats:{users:allUsers.length,activeUsers:allUsers.filter(u=>u.isActive!==false).length,activatedUsers:allUsers.filter(u=>u.activated).length,codes:activationCodes.size,usedCodes:Array.from(activationCodes.values()).filter(c=>c.used).length}});
});



app.get('/api/owner/system-monitor',(req,res)=>{
  const session=requireOwner(req,res); if(!session) return;
  try{
    const roomsList=[];
    for(const [roomId, ctx] of rooms.entries()){
      const state=ctx?.state||{};
      const players=Array.isArray(state.players)?state.players:[];
      const hosts=Array.isArray(state.hosts)?state.hosts:[];
      const appState=state.app||{};
      const selectedGame=String(appState.selectedGameLabel||appState.selectedGame||'').trim();
      let roomState='offline';
      if(players.length>0 && selectedGame) roomState='playing';
      else if(players.length>0 || hosts.length>0 || roomHasLiveConnections(roomId)) roomState='lobby';
      roomsList.push({roomId,playersCount:players.length,state:roomState,lastActive:Number(state.lastActivityAt||0)||Date.now()});
    }
    const playersCount=roomsList.reduce((sum, room)=>sum+Number(room.playersCount||0),0);
    const playingCount=roomsList.filter(room=>String(room.state||'').toLowerCase().includes('play')).length;
    res.json({
      ok:true,
      roomsCount:roomsList.length,
      playersCount,
      playingCount,
      uptimeSeconds:process.uptime(),
      memory:process.memoryUsage(),
      redisEnabled:isRedisEnabled(),
      socketStatus:'online',
      port:process.env.PORT||3000,
      nodeEnv:process.env.NODE_ENV||'development'
    });
  }catch(error){
    res.status(500).json({ok:false,message:'تعذر تحميل بيانات المراقبة',error:error.message});
  }
});

app.get('/api/owner/rooms',(req,res)=>{
  const session=requireOwner(req,res); if(!session) return;
  try{
    const live=[];
    for(const [roomId, ctx] of rooms.entries()){
      const state=ctx?.state||{};
      const players=Array.isArray(state.players)?state.players:[];
      const hosts=Array.isArray(state.hosts)?state.hosts:[];
      const appState=state.app||{};
      const def=roomDefinitions.get(roomId)||{};
      const ownerEmail=normalizeEmail(def.ownerEmail||'');
      const ownerUser=ownerEmail ? users.get(ownerEmail) : null;
      const hasConnections=roomHasLiveConnections(roomId);
      const selectedGame=String(appState.selectedGameLabel||appState.selectedGame||'').trim();
      let roomState='offline';
      if(players.length>0 && selectedGame) roomState='playing';
      else if(players.length>0 || hosts.length>0 || hasConnections) roomState='lobby';
      live.push({
        roomId,
        ownerEmail: ownerEmail||'',
        ownerName: ownerUser?.name || def.label || roomId,
        playersCount: players.length,
        players: players.length,
        hostsCount: hosts.length,
        game: selectedGame || '—',
        state: roomState,
        currentView: appState.currentView||'lobby',
        statusText: appState.statusText||'',
        lastActive: Number(state.lastActivityAt||0)||Date.now()
      });
    }
    live.sort((a,b)=>Number(b.lastActive||0)-Number(a.lastActive||0));
    res.json({ok:true,rooms:live});
  }catch(error){
    res.status(500).json({ok:false,message:'تعذر تحميل الغرف',error:error.message});
  }
});

app.post('/api/owner/reset-room',(req,res)=>{
  const session=requireOwner(req,res); if(!session) return;
  try{
    const roomId=normalizeRoomCode(req.body?.roomId||'');
    if(!roomId) return res.status(400).json({ok:false,message:'roomId مطلوب'});
    const existing=rooms.get(roomId);
    if(!existing) return res.status(404).json({ok:false,message:'الغرفة غير موجودة'});
    const fresh=createRoomContext(roomId, getStoredRoomSnapshot(roomId));
    rooms.set(roomId, fresh);
    try{ io.to(roomId).emit('forceReload'); }catch(e){}
    saveData();
    res.json({ok:true,message:'تمت إعادة ضبط الغرفة'});
  }catch(error){
    res.status(500).json({ok:false,message:'تعذر إعادة ضبط الغرفة',error:error.message});
  }
});

app.post('/api/owner/delete-room',(req,res)=>{
  const session=requireOwner(req,res); if(!session) return;
  try{
    const roomId=normalizeRoomCode(req.body?.roomId||'');
    if(!roomId) return res.status(400).json({ok:false,message:'roomId مطلوب'});
    const existing=rooms.get(roomId);
    if(!existing) return res.status(404).json({ok:false,message:'الغرفة غير موجودة'});
    persistRoomSnapshot(roomId, existing.state||{});
    rooms.delete(roomId);
    saveData();
    res.json({ok:true,message:'تم حذف الجلسة الحالية'});
  }catch(error){
    res.status(500).json({ok:false,message:'تعذر حذف الجلسة الحالية',error:error.message});
  }
});

app.post('/api/rooms/create',(req,res)=>{
  const requestedOwner=normalizeEmail(req.body?.ownerEmail||'');
  const roomCode=generateRoomCode();
  upsertRoomDefinition(roomCode,{ownerEmail:requestedOwner,label:req.body?.label||roomCode,isPermanent:true,lastOpenedAt:safeNow()});
  if(!roomSnapshots.has(roomCode)) roomSnapshots.set(roomCode,{roomId:roomCode,savedAt:safeNow(),state:sanitizeRoomSnapshot({})});
  saveData();
  getRoomContext(roomCode);
  res.json({roomCode});
});
app.get('/api/rooms/:roomCode',(req,res)=>{
  const roomCode=normalizeRoomCode(req.params.roomCode);
  const exists = !!roomCode && (rooms.has(roomCode) || roomDefinitions.has(roomCode) || usersHasRoom(roomCode));
  if(exists) touchRoomDefinition(roomCode);
  res.json({roomCode, exists});
});

io.on('connection',(socket)=>{
  const roomCode=normalizeRoomCode(socket.handshake.query?.room || 'MAIN');
  const ctx=getRoomContext(roomCode);
  socket.join(roomCode);
  socket.data.roomCode=roomCode;
  socket.emit('roomInfo',{roomCode});
  ctx.attachSocket(socket);
});

async function startServer(){
  try {
    await setupRedisAdapter();
  } catch(error) {
    console.error('Redis setup failed:', error?.message||error);
    if(String(process.env.REDIS_REQUIRED||'').trim()==='1') process.exit(1);
  }
  server.listen(PORT,()=>console.log(`Server running on http://localhost:${PORT}`));
}

startServer();
