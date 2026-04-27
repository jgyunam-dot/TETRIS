const http = require('http');
const fs   = require('fs');
const path = require('path');
const WebSocket = require('ws');
const os   = require('os');

/* ── 네트워크 ── */
function getLocalIP(){const i=os.networkInterfaces();for(const n of Object.keys(i))for(const x of i[n])if(x.family==='IPv4'&&!x.internal)return x.address;return'localhost';}
const PORT     = process.env.PORT || 3001;
const LOCAL_IP = getLocalIP();
const JB_KEY   = process.env.JSONBIN_KEY || '';
const JB_BIN   = process.env.JSONBIN_ID  || '';
const JB_URL   = `https://api.jsonbin.io/v3/b/${JB_BIN}`;
const LOCAL_FILE = path.join(__dirname,'scores.json');

/* ════════════════════════════════
   JSONBin 점수 저장
════════════════════════════════ */
async function loadScores(){
  if(JB_KEY&&JB_BIN){
    try{const r=await fetch(`${JB_URL}/latest`,{headers:{'X-Master-Key':JB_KEY}});if(!r.ok)throw 0;const d=await r.json();if(Array.isArray(d?.record?.scores))return d.record.scores;}catch(e){console.error('[JSONBin] load fail:',e?.message||e);}
  }
  try{return JSON.parse(fs.readFileSync(LOCAL_FILE,'utf8'));}catch{return[];}
}
async function saveScores(arr){
  if(JB_KEY&&JB_BIN){
    try{const r=await fetch(JB_URL,{method:'PUT',headers:{'Content-Type':'application/json','X-Master-Key':JB_KEY},body:JSON.stringify({scores:arr})});if(!r.ok)throw 0;return;}catch(e){console.error('[JSONBin] save fail:',e?.message||e);}
  }
  try{fs.writeFileSync(LOCAL_FILE,JSON.stringify(arr));}catch{}
}

/* ════════════════════════════════
   방 관리
════════════════════════════════ */
const rooms      = {};   // code -> room
const clients    = {};   // id   -> ws
const clientRoom = {};   // id   -> code
let   idCount    = 0;
function newId(){return`p${++idCount}`;}

const CODE_CHARS='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode(){let c;do{c=Array.from({length:6},()=>CODE_CHARS[0|Math.random()*CODE_CHARS.length]).join('');}while(rooms[c]);return c;}

const MODE_MIN={ffa:2,'1v1':2,'2v2':4,'4v4':8};
const MODE_MAX={ffa:8,'1v1':2,'2v2':4,'4v4':8};

function newRoom(code){
  rooms[code]={
    code, phase:'lobby', mode:'ffa', hostId:null,
    players:{},
    settings:{startLevel:1, garbageMult:1},
    chat:[],
  };
  return rooms[code];
}

/* ── 통신 헬퍼 ── */
function sendTo(id,msg){const ws=clients[id];if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify(msg));}
function broadcastRoom(room,msg){const s=JSON.stringify(msg);Object.keys(room.players).forEach(id=>{const ws=clients[id];if(ws?.readyState===WebSocket.OPEN)ws.send(s);});}
function broadcastExcept(room,skip,msg){const s=JSON.stringify(msg);Object.keys(room.players).forEach(id=>{if(id!==skip){const ws=clients[id];if(ws?.readyState===WebSocket.OPEN)ws.send(s);}});}

function playerList(room){
  return Object.entries(room.players).map(([id,p])=>({
    id, name:p.name, ready:p.ready, alive:p.alive,
    team:p.team, isHost:id===room.hostId,
    score:p.score, lines:p.lines, level:p.level, dead:p.dead,
  }));
}
function broadcastLobby(room){
  broadcastRoom(room,{type:'lobby', code:room.code, players:playerList(room),
    hostId:room.hostId, mode:room.mode, phase:room.phase, settings:room.settings});
}

/* ── 팀 배정 ── */
function assignTeams(room){
  if(room.mode==='ffa'){
    Object.values(room.players).forEach(p=>{p.team=-1;});
  } else {
    // 이미 팀이 배정된 경우 유지, 오류 값만 보정
    Object.values(room.players).forEach(p=>{
      if (p.team !== 0 && p.team !== 1) p.team = 0;
    });
  }
}

/* ── 적 목록 ── */
function getEnemies(room,fromId){
  const from=room.players[fromId];if(!from)return[];
  if(room.mode==='ffa'||room.mode==='1v1')return Object.keys(room.players).filter(id=>id!==fromId&&room.players[id]?.alive);
  return Object.keys(room.players).filter(id=>id!==fromId&&room.players[id]?.alive&&room.players[id]?.team!==from.team);
}

/* ── 승리 판정 ── */
function checkWin(room){
  if(room.phase!=='playing')return;
  const alive=Object.entries(room.players).filter(([,p])=>p.alive);
  if(room.mode==='ffa'||room.mode==='1v1'){
    if(alive.length<=1){room.phase='ended';const w=alive[0];broadcastRoom(room,{type:'game_over',winnerId:w?.[0],winnerName:w?.[1]?.name,winnerTeam:-1,scores:playerList(room)});}
  }else{
    const a0=alive.filter(([,p])=>p.team===0).length;const a1=alive.filter(([,p])=>p.team===1).length;
    if(a0===0||a1===0){room.phase='ended';broadcastRoom(room,{type:'game_over',winnerId:null,winnerName:null,winnerTeam:a0>0?0:1,scores:playerList(room)});}
  }
}

/* ════════════════════════════════
   HTTP (REST + HTML 서빙)
════════════════════════════════ */
const server=http.createServer((req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}

  if(req.method==='GET'&&req.url.startsWith('/scores')){
    const qs=new URL(req.url,'http://localhost').searchParams;
    const mode=qs.get('mode')||'all';
    loadScores().then(all=>{
      let s=mode==='all'?[...all]:all.filter(x=>x.mode===mode);
      if(mode==='sprint')s.sort((a,b)=>(a.time??9999)-(b.time??9999));
      else s.sort((a,b)=>(b.score||0)-(a.score||0));
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(s.slice(0,50)));
    }).catch(()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end('[]');});
    return;
  }

  if(req.method==='POST'&&req.url==='/scores'){
    let body='';req.on('data',c=>body+=c);req.on('end',async()=>{
      try{
        const e=JSON.parse(body);
        const name=String(e.name||'익명').slice(0,12);
        const score=Math.min(Math.max(0,parseInt(e.score)||0),9999999);
        const lines=Math.min(Math.max(0,parseInt(e.lines)||0),9999);
        const level=Math.min(Math.max(1,parseInt(e.level)||1),100);
        const mode=(['sprint','blitz','score','marathon'].includes(e.mode)?e.mode:'marathon');
        const time=mode==='sprint'&&e.time!=null?Math.max(0,parseInt(e.time)||0):null;
        const now=new Date();const date=`${now.getFullYear()}.${now.getMonth()+1}.${now.getDate()}`;
        const uid=`${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const scores=await loadScores();
        scores.push({name,score,lines,level,mode,time,date,uid});
        const top=scores.slice(0,400); 
        await saveScores(top);
        let modeScores=scores.filter(s=>s.mode===mode);
        if(mode==='sprint')modeScores.sort((a,b)=>(a.time??9999)-(b.time??9999));
        else modeScores.sort((a,b)=>(b.score||0)-(a.score||0));
        const rank=modeScores.findIndex(s=>s.uid===uid)+1;
        res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,rank,mode}));
      }catch(e){console.error('점수 오류:',e.message);res.writeHead(400,{'Content-Type':'application/json'});res.end('{"ok":false}');}
    });
    return;
  }

  fs.readFile(path.join(__dirname,'tetris.html'),(err,data)=>{
    if(err){res.writeHead(404);res.end('tetris.html not found');return;}
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(data);
  });
});

/* ════════════════════════════════
   WebSocket
════════════════════════════════ */
const wss=new WebSocket.Server({server});

wss.on('connection',ws=>{
  const id=newId();clients[id]=ws;
  sendTo(id,{type:'connected',id});

  ws.on('message',raw=>{
    let msg;try{msg=JSON.parse(raw);}catch{return;}
    const code=clientRoom[id];
    const room=code?rooms[code]:null;
    const p=room?.players[id];

    switch(msg.type){

      /* ── 방 입장 ── */
      case 'create_room':{
        if(clientRoom[id])break;
        const name=String(msg.name||'플레이어').slice(0,12);
        const c=genCode();const rm=newRoom(c);
        clientRoom[id]=c;
        rm.players[id]={name,ready:false,alive:false,dead:false,team:-1,score:0,lines:0,level:1,target:null};
        rm.hostId=id;
        sendTo(id,{type:'room_joined',code:c,isHost:true,id,players:playerList(rm),hostId:id,mode:rm.mode,phase:rm.phase,settings:rm.settings,chat:[]});
        break;
      }

      case 'join_room':{
        if(clientRoom[id])break;
        const name=String(msg.name||'플레이어').slice(0,12);
        const c=String(msg.code||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6);
        const rm=rooms[c];
        if(!rm){sendTo(id,{type:'error',msg:'방을 찾을 수 없어요! 코드를 확인해주세요.'});break;}
        if(rm.phase==='playing'){sendTo(id,{type:'error',msg:'이미 게임 중인 방이에요!'});break;}
        if(Object.keys(rm.players).length>=8){sendTo(id,{type:'error',msg:'방이 꽉 찼어요! (최대 8명)'});break;}
        clientRoom[id]=c;
        
        let targetTeam = -1;
        if(rm.mode!=='ffa'){
          const t0=Object.values(rm.players).filter(pl=>pl.team===0).length;
          const t1=Object.values(rm.players).filter(pl=>pl.team===1).length;
          targetTeam = t0<=t1 ? 0 : 1;
        }

        rm.players[id]={name,ready:false,alive:false,dead:false,team:targetTeam,score:0,lines:0,level:1,target:null};
        sendTo(id,{type:'room_joined',code:c,isHost:false,id,players:playerList(rm),hostId:rm.hostId,mode:rm.mode,phase:rm.phase,settings:rm.settings,chat:rm.chat.slice(-30)});
        broadcastLobby(rm);
        break;
      }

      /* ── 로비 ── */
      case 'set_name':
        if(!p)break;p.name=String(msg.name).slice(0,12);broadcastLobby(room);break;

      case 'set_mode':
        if(!p||id!==room.hostId||room.phase==='playing')break;
        if(room.phase==='ended')room.phase='lobby';
        if(MODE_MIN[msg.mode]){
          room.mode=msg.mode;
          if(room.mode==='ffa'){
            Object.values(room.players).forEach(pl=>{pl.team=-1;});
          } else {
            let tCnt=0;
            Object.values(room.players).forEach(pl=>{
              if(pl.team!==0 && pl.team!==1){
                pl.team = tCnt%2;
                tCnt++;
              }
            });
          }
          broadcastLobby(room);
        }
        break;

      case 'set_settings':{
        if(!p||id!==room.hostId||room.phase==='playing')break;
        if(msg.startLevel!==undefined)room.settings.startLevel=Math.max(1,Math.min(20,parseInt(msg.startLevel)||1));
        if(msg.garbageMult!==undefined){const v=parseFloat(msg.garbageMult);if([0.5,1,1.5,2].includes(v))room.settings.garbageMult=v;}
        broadcastLobby(room);break;
      }

      case 'swap_team':
        if(!p||room.phase==='playing'||room.mode==='ffa')break;
        if(room.phase==='ended')room.phase='lobby';
        p.team = p.team === 0 ? 1 : 0;
        broadcastLobby(room);break;

      case 'set_ready':
        if(!p||room.phase==='playing')break;
        if(room.phase==='ended')room.phase='lobby';
        p.ready=!!msg.ready;broadcastLobby(room);break;

      case 'start_game':{
        if(!p||id!==room.hostId||room.phase==='playing')break;
        if(room.phase==='ended')room.phase='lobby';
        const cnt=Object.keys(room.players).length;
        const min=MODE_MIN[room.mode]||2,max=MODE_MAX[room.mode]||8;
        if(cnt<min){sendTo(id,{type:'error',msg:`최소 ${min}명 필요해요!`});break;}
        if(cnt>max){sendTo(id,{type:'error',msg:`이 모드는 최대 ${max}명이에요!`});break;}
        assignTeams(room);room.phase='playing';
        Object.values(room.players).forEach(p=>{p.alive=true;p.dead=false;p.score=0;p.lines=0;p.level=1;p.target=null;});
        broadcastRoom(room,{type:'game_start',mode:room.mode,players:playerList(room),settings:room.settings});
        break;
      }

      /* ── 게임 ── */
      case 'board_update':
        if(!p)break;
        p.score=msg.score||0;p.lines=msg.lines||0;p.level=msg.level||1;
        broadcastExcept(room,id,{type:'player_board',id,board:msg.board,score:p.score,lines:p.lines,level:p.level,name:p.name,team:p.team});
        break;

      case 'set_target':
        if(!p)break;p.target=msg.targetId||null;break;

      case 'attack':{
        if(!p||room.phase!=='playing'||!p.alive)break;
        let lines=Math.max(0,Math.min(20,msg.lines||0));
        lines=Math.max(0,Math.round(lines*room.settings.garbageMult));
        if(!lines)break;
        const enemies=getEnemies(room,id);if(!enemies.length)break;
        let targetId=p.target;
        if(!targetId||!enemies.includes(targetId))targetId=enemies[0|Math.random()*enemies.length];
        sendTo(targetId,{type:'garbage',lines,fromName:p.name,fromId:id});
        sendTo(id,{type:'attack_sent',lines,toName:room.players[targetId]?.name,toId:targetId});
        break;
      }

      case 'player_dead':
        if(!p||!p.alive)break;
        p.alive=false;p.dead=true;p.score=msg.score||p.score;
        broadcastRoom(room,{type:'player_died',id,name:p.name,score:p.score});
        broadcastLobby(room);checkWin(room);break;

      /* ── 채팅 ── */
      case 'chat':{
        if(!p)break;
        const text=String(msg.text||'').trim().slice(0,100);if(!text)break;
        const chatMsg={name:p.name,text,ts:Date.now()};
        room.chat.push(chatMsg);if(room.chat.length>100)room.chat.shift();
        broadcastRoom(room,{type:'chat',...chatMsg});
        break;
      }

      case 'restart':
        if(!p||id!==room.hostId)break;
        room.phase='lobby';
        Object.values(room.players).forEach(p=>{p.ready=false;p.alive=false;p.dead=false;p.target=null;});
        broadcastRoom(room,{type:'restart'});broadcastLobby(room);break;
    }
  });

  ws.on('close',()=>{
    const code=clientRoom[id];delete clients[id];delete clientRoom[id];
    if(!code||!rooms[code])return;
    const room=rooms[code];const lp=room.players[id];delete room.players[id];
    if(room.phase==='playing'&&lp?.alive)broadcastRoom(room,{type:'player_died',id,name:lp.name,score:lp.score});
    if(room.hostId===id){const rem=Object.keys(room.players);room.hostId=rem[0]||null;if(room.hostId)sendTo(room.hostId,{type:'you_are_host'});}
    if(Object.keys(room.players).length===0){delete rooms[code];}
    else{if(room.phase==='playing')checkWin(room);broadcastLobby(room);}
  });
});

server.listen(PORT,'0.0.0.0',()=>{
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║      🎮  테트리스 멀티게임 서버 실행중       ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  로컬:    http://localhost:${PORT}            ║`);
  console.log(`║  네트워크: http://${LOCAL_IP}:${PORT}   ║`);
  console.log('╚══════════════════════════════════════════╝\n');
  console.log(JB_KEY&&JB_BIN?'  ✅ JSONBin 연동 → 점수 영구 저장':'  ⚠️  JSONBin 미설정 → 로컬 파일');
  console.log('  종료: Ctrl+C\n');
});
