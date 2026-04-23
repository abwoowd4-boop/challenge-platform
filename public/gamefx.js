
(function(){
  const FX={};
  let ctx=null;
  function getCtx(){
    const C=window.AudioContext||window.webkitAudioContext;
    if(!C) return null;
    if(!ctx) ctx=new C();
    if(ctx.state==='suspended') ctx.resume().catch(()=>{});
    return ctx;
  }
  function tone(freq=440,dur=0.14,type='sine',gain=0.035,delay=0){
    const c=getCtx(); if(!c) return;
    const t=c.currentTime+delay;
    const o=c.createOscillator(); const g=c.createGain();
    o.type=type; o.frequency.setValueAtTime(freq,t);
    g.gain.setValueAtTime(0.0001,t);
    g.gain.exponentialRampToValueAtTime(gain,t+0.02);
    g.gain.exponentialRampToValueAtTime(0.0001,t+dur);
    o.connect(g).connect(c.destination); o.start(t); o.stop(t+dur+0.03);
  }
  FX.unlock=()=>getCtx();
  FX.click=()=>{tone(520,.06,'triangle',.025); tone(760,.08,'triangle',.018,.05);};
  FX.start=()=>{tone(440,.08,'triangle',.03); tone(660,.10,'triangle',.03,.08); tone(990,.16,'triangle',.03,.16);};
  FX.countdown=()=>{tone(720,.10,'square',.02);};
  FX.reveal=()=>{tone(320,.12,'sine',.028); tone(520,.14,'sine',.03,.10);};
  FX.success=()=>{tone(660,.08,'triangle',.028); tone(880,.10,'triangle',.03,.07); tone(1320,.18,'triangle',.03,.14);};
  FX.warning=()=>{tone(220,.08,'sawtooth',.02);};
  FX.win=()=>{tone(523,.11,'triangle',.03); tone(659,.11,'triangle',.03,.09); tone(784,.12,'triangle',.03,.18); tone(1046,.22,'triangle',.035,.28);};
  FX.phaseOverlay=function(text, opts={}){
    let root=document.getElementById('fxPhaseOverlay');
    if(!root){
      root=document.createElement('div');
      root.id='fxPhaseOverlay';
      root.style.cssText='position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:99999;background:rgba(4,10,22,.72);backdrop-filter:blur(6px);opacity:0;pointer-events:none;transition:opacity .22s ease';
      root.innerHTML='<div id="fxPhaseOverlayText" style="font-family:Tahoma,Segoe UI,sans-serif;font-size:min(12vw,96px);font-weight:900;color:#fff;text-align:center;text-shadow:0 16px 28px rgba(0,0,0,.3);transform:scale(.88);opacity:.08;transition:all .22s ease"></div>';
      document.body.appendChild(root);
    }
    const t=root.querySelector('#fxPhaseOverlayText');
    t.textContent=text||'';
    root.style.display='flex';
    requestAnimationFrame(()=>{root.style.opacity='1'; t.style.opacity='1'; t.style.transform='scale(1)';});
    const duration=opts.duration||1100;
    setTimeout(()=>{root.style.opacity='0'; t.style.opacity='.08'; t.style.transform='scale(.88)'; setTimeout(()=>{root.style.display='none';},220);}, duration);
  };
  FX.countdownOverlay=function(title='استعد', steps=['3','2','1','ابدأ']){
    FX.unlock();
    return new Promise(resolve=>{
      let root=document.getElementById('fxCountdownOverlay');
      if(!root){
        root=document.createElement('div');
        root.id='fxCountdownOverlay';
        root.style.cssText='position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:99999;background:rgba(4,10,22,.8);backdrop-filter:blur(6px)';
        root.innerHTML='<div style="text-align:center;color:#fff;font-family:Tahoma,Segoe UI,sans-serif"><div id="fxCountdownTitle" style="font-size:min(4vw,34px);font-weight:900;margin-bottom:18px"></div><div id="fxCountdownNum" style="font-size:min(22vw,180px);font-weight:900;line-height:1;transform:scale(.82);opacity:.06;transition:all .2s ease"></div></div>';
        document.body.appendChild(root);
      }
      const tt=root.querySelector('#fxCountdownTitle'); const nn=root.querySelector('#fxCountdownNum');
      tt.textContent=title; root.style.display='flex';
      let i=0; const stepDur=650;
      const next=()=>{
        nn.style.opacity='.06'; nn.style.transform='scale(.82)';
        requestAnimationFrame(()=>{ nn.textContent=steps[i]; nn.style.opacity='1'; nn.style.transform='scale(1)'; });
        if(i<steps.length-1){ if(String(steps[i]).match(/^\d+$/)) FX.countdown(); else FX.start(); i++; setTimeout(next, stepDur); }
        else { FX.start(); setTimeout(()=>{root.style.display='none'; resolve();}, 580); }
      };
      next();
    });
  };
  FX.celebrate=function(duration=1200){
    let wrap=document.getElementById('fxConfetti');
    if(wrap) wrap.remove();
    wrap=document.createElement('div');
    wrap.id='fxConfetti';
    wrap.style.cssText='pointer-events:none;position:fixed;inset:0;overflow:hidden;z-index:99997';
    const colors=['#ffd166','#47d98b','#63b3ff','#ff8da1','#c084fc'];
    for(let i=0;i<28;i++){
      const s=document.createElement('span');
      const left=(Math.random()*100).toFixed(2);
      const size=8+Math.random()*10;
      s.style.cssText=`position:absolute;top:-20px;left:${left}%;width:${size}px;height:${size*1.4}px;background:${colors[i%colors.length]};opacity:.95;transform:rotate(${Math.random()*180}deg);border-radius:2px;animation:fxFall ${0.9+Math.random()*0.9}s linear forwards`;
      wrap.appendChild(s);
    }
    if(!document.getElementById('fxConfettiStyle')){
      const st=document.createElement('style'); st.id='fxConfettiStyle'; st.textContent='@keyframes fxFall{to{transform:translateY(110vh) rotate(420deg);opacity:0}}'; document.head.appendChild(st);
    }
    document.body.appendChild(wrap); setTimeout(()=>wrap.remove(), duration);
  };
  window.GameFX=FX;
    FX.bump=function(el){ if(!el) return; el.classList.remove('fx-bump'); void el.offsetWidth; el.classList.add('fx-bump'); };
  FX.flash=function(el){ if(!el) return; el.classList.remove('fx-flash'); void el.offsetWidth; el.classList.add('fx-flash'); };
  if(!document.getElementById('fxSharedStyle')){
    const st=document.createElement('style'); st.id='fxSharedStyle'; st.textContent='@keyframes fxBump{0%{transform:scale(.96)}55%{transform:scale(1.03)}100%{transform:scale(1)}}@keyframes fxFlash{0%{box-shadow:0 0 0 rgba(255,255,255,0)}50%{box-shadow:0 0 0 1px rgba(255,255,255,.18),0 0 32px rgba(99,179,255,.22)}100%{box-shadow:0 0 0 rgba(255,255,255,0)}}.fx-bump{animation:fxBump .35s ease}.fx-flash{animation:fxFlash .5s ease}'; document.head.appendChild(st);
  }
  window.addEventListener('pointerdown',()=>FX.unlock(),{once:true});
})();
