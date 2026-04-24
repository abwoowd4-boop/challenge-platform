(function(){
  if(window.GameProFX) return;
  const state={enabled:false,ctx:null,last:{},prev:null};
  function ctx(){ if(!state.ctx){ const C=window.AudioContext||window.webkitAudioContext; if(C) state.ctx=new C(); } return state.ctx; }
  function enable(){ const c=ctx(); if(c&&c.state==='suspended') c.resume(); state.enabled=true; const b=document.getElementById('proAudioBtn'); if(b){b.textContent='🔊 الصوت مفعل';b.classList.add('enabled')} play('enable'); }
  function tone(freq=440,dur=.12,type='sine',gain=.055,delay=0){ if(!state.enabled) return; const c=ctx(); if(!c) return; const o=c.createOscillator(),g=c.createGain(); o.type=type;o.frequency.setValueAtTime(freq,c.currentTime+delay);g.gain.setValueAtTime(0.0001,c.currentTime+delay);g.gain.exponentialRampToValueAtTime(gain,c.currentTime+delay+.012);g.gain.exponentialRampToValueAtTime(0.0001,c.currentTime+delay+dur);o.connect(g);g.connect(c.destination);o.start(c.currentTime+delay);o.stop(c.currentTime+delay+dur+.02); }
  function play(name){ if(name==='wrong'||name==='strike'){tone(170,.22,'sawtooth',.09);tone(105,.28,'square',.05,.05);bigX();shake();return;} if(name==='correct'||name==='reveal'){tone(520,.11,'triangle',.055);tone(780,.13,'triangle',.05,.09);return;} if(name==='start'||name==='round'){tone(392,.12,'triangle',.045);tone(523,.12,'triangle',.05,.12);tone(659,.18,'triangle',.055,.24);banner('بدأت الجولة');return;} if(name==='award'||name==='score'){tone(440,.10,'sine',.045);tone(660,.11,'sine',.05,.09);tone(880,.15,'sine',.055,.18);scorePop();return;} if(name==='win'||name==='winner'){for(let i=0;i<7;i++) tone([523,659,784,1046][i%4],.13,'triangle',.045,i*.08);confetti();return;} if(name==='enable'){tone(660,.08,'sine',.035);tone(880,.10,'sine',.035,.08);return;} }
  function toast(text){ let el=document.querySelector('.pro-toast'); if(!el){el=document.createElement('div');el.className='pro-toast';document.body.appendChild(el);} el.textContent=text; el.classList.add('show'); clearTimeout(el._t); el._t=setTimeout(()=>el.classList.remove('show'),1700); }
  function bigX(){ const el=document.createElement('div'); el.className='pro-big-x'; el.textContent='✕'; document.body.appendChild(el); setTimeout(()=>el.remove(),1000); }
  function shake(){ document.body.classList.remove('pro-shake'); void document.body.offsetWidth; document.body.classList.add('pro-shake'); setTimeout(()=>document.body.classList.remove('pro-shake'),650); }
  function banner(text){ const el=document.createElement('div'); el.className='pro-round-banner'; el.textContent=text||'بدأت الجولة'; document.body.appendChild(el); setTimeout(()=>el.remove(),1450); }
  function confetti(){ const wrap=document.createElement('div'); wrap.className='pro-confetti'; for(let i=0;i<42;i++){const p=document.createElement('i'); p.style.left=(Math.random()*100)+'%'; p.style.animationDelay=(Math.random()*.45)+'s'; p.style.transform='rotate('+(Math.random()*180)+'deg)'; wrap.appendChild(p);} document.body.appendChild(wrap); setTimeout(()=>wrap.remove(),2300); }
  function scorePop(){ document.querySelectorAll('[id*=Score],.score,.points,.val,.bank').forEach(el=>{el.classList.remove('pro-score-pop'); void el.offsetWidth; el.classList.add('pro-score-pop')}); }
  function flashSelector(sel){ document.querySelectorAll(sel).forEach(el=>{el.classList.remove('pro-flash'); void el.offsetWidth; el.classList.add('pro-flash')}); }
  function inferGameFromPath(){ const p=location.pathname; return (p.match(/\/games\/([^/]+)/)||[])[1]||''; }
  function handleState(s){ try{ const game=inferGameFromPath(); const g=s?.games?.[game]; const prev=state.prev?.games?.[game]; if(!g){state.prev=s;return;} if(!prev && (g.started||g.phase)){banner(g.phaseLabel||g.statusText||'جاهز');}
      if(prev){ if((g.round||0)>(prev.round||0)) play('round'); if((g.bank||0)>(prev.bank||0)) play('score'); const strikeNow=JSON.stringify(g.strikes||{}), strikePrev=JSON.stringify(prev.strikes||{}); if(strikeNow!==strikePrev) play('wrong'); const revNow=JSON.stringify(g.revealed||{}), revPrev=JSON.stringify(prev.revealed||{}); if(revNow!==revPrev) play('reveal'); if((g.winnerTeam||g.winnerText||g.finalWinnerName) && JSON.stringify(g)!==JSON.stringify(prev)) play('win'); }
      state.prev=s;
    }catch(e){ state.prev=s; }
  }
  function positionMenuPanel(trigger){
    const panel=document.querySelector(".menuPanel");
    if(!panel) return;
    const btn=trigger?.closest?.(".iconBtn,.menu-btn,[onclick*=\"toggleMenu\"]") || document.querySelector(".top .iconBtn,.topbar .iconBtn,.appbar .iconBtn,.header .iconBtn,.game-header .iconBtn,.menu-btn,[onclick*=\"toggleMenu\"]");
    const bar=document.querySelector(".top,.topbar,.appbar,.header,.game-header");
    const rect=(btn||bar)?.getBoundingClientRect?.();
    const barRect=bar?.getBoundingClientRect?.();
    const top=Math.max(8, Math.round(((barRect?.bottom) || (rect?.bottom) || 64) + 8));
    let right=18;
    if(rect){ right=Math.max(10, Math.round(window.innerWidth - rect.right)); }
    panel.style.setProperty("--menu-top", top+"px");
    panel.style.setProperty("--menu-right", right+"px");
  }
  function installSmartMenu(){
    const triggers='.iconBtn,.menu-btn,.back,[onclick*="toggleMenu"],[data-menu-toggle]';
    const reposition=(target)=>requestAnimationFrame(()=>positionMenuPanel(target));
    document.addEventListener('click',e=>{ if(e.target.closest(triggers)) reposition(e.target); }, true);
    window.addEventListener('scroll',()=>positionMenuPanel(),{passive:true});
    window.addEventListener('resize',()=>positionMenuPanel(),{passive:true});
    setTimeout(()=>{
      if(typeof window.toggleMenu==='function' && !window.toggleMenu.__proWrapped){
        const original=window.toggleMenu;
        window.toggleMenu=function(){ const r=original.apply(this,arguments); reposition(document.activeElement); return r; };
        window.toggleMenu.__proWrapped=true;
      }
    },0);
    setInterval(()=>{ const p=document.querySelector('.menuPanel:not(.hidden),#menuPanel:not(.hidden)'); if(p) positionMenuPanel(); },350);
  }

  function installAudioButton(){ if(document.getElementById('proAudioBtn')) return; const b=document.createElement('button'); b.id='proAudioBtn'; b.className='pro-audio-btn'; b.type='button'; b.textContent='🔇 تفعيل الصوت'; b.addEventListener('click',enable); document.body.appendChild(b); }
  function boot(){ document.body.classList.add('pro-page-enter'); installAudioButton(); installSmartMenu(); setTimeout(()=>flashSelector('.card,.glass,.panel,.team,.game-card'),250); if(window.io){ const oldOne=window.Socket&&window.Socket.prototype; }
    // Hook the common socket variable when pages define it globally. Also monkey-patch emit/listen safely through createRoomSocket.
    if(window.createRoomSocket && !window.createRoomSocket.__proWrapped){ const original=window.createRoomSocket; window.createRoomSocket=function(){ const sock=original.apply(this,arguments); attach(sock); return sock; }; window.createRoomSocket.__proWrapped=true; }
    if(window.socket) attach(window.socket);
  }
  function attach(sock){ if(!sock||sock.__proFxAttached) return; sock.__proFxAttached=true; sock.on('stateUpdate',handleState); sock.on('familyStrikeFlash',()=>play('wrong')); sock.on('feud:strike',()=>play('wrong')); sock.on('colorStartRound',()=>play('round')); sock.on('lettersBuzz',()=>play('start')); sock.on('gameEnded',()=>play('win')); sock.on('connect',()=>toast('متصل')) }
  window.GameProFX={enable,play,toast,banner,confetti,attach,positionMenuPanel};
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot); else boot();
})();
