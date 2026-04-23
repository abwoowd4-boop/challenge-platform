(function(){
  function normalizeRoomCode(value){
    return String(value||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,8);
  }
  function getRoomCode(){
    try {
      const queryCode = normalizeRoomCode(new URLSearchParams(window.location.search).get('room') || '');
      const savedCode = normalizeRoomCode(localStorage.getItem('challenge_last_room') || '');
      const code = queryCode || savedCode;
      if(code) localStorage.setItem('challenge_last_room', code);
      return code;
    } catch(e){ return ''; }
  }
  function withRoom(url, explicitRoom){
    const room = normalizeRoomCode(explicitRoom || getRoomCode());
    if(!room) return url;
    try {
      const u = new URL(url, window.location.origin);
      if(!u.searchParams.get('room')) u.searchParams.set('room', room);
      return u.pathname + u.search + u.hash;
    } catch(e){
      const sep = String(url).includes('?') ? '&' : '?';
      return url + sep + 'room=' + encodeURIComponent(room);
    }
  }
  function createRoomSocket(){
    const room = getRoomCode() || 'MAIN';
    return io({query:{room}});
  }
  function patchLinks(){
    document.querySelectorAll('a[href^="/"]').forEach(a=>{ a.href = withRoom(a.getAttribute('href')); });
  }
  function patchRoomLabels(){
    const room = getRoomCode();
    document.querySelectorAll('[data-room-code]').forEach(el=>{ el.textContent = room || '----'; });
  }
  function redirectToSavedRoomIfNeeded(){
    const path = window.location.pathname || '/';
    const hasRoom = !!normalizeRoomCode(new URLSearchParams(window.location.search).get('room') || '');
    const room = getRoomCode();
    if(hasRoom || !room) return;
    if(path === '/' || path === '/player' || path === '/host' || path === '/team-settings' || path === '/games' || /\/games\/.+\/(host|setup|player|screen)$/.test(path)){
      window.location.replace(withRoom(path, room));
    }
  }
  function buildLoginRedirect(){
    return '/login?redirect=' + encodeURIComponent(window.location.pathname + window.location.search + window.location.hash);
  }
  async function ensureProtectedAccess(){
    const path = window.location.pathname || '';
    const room = getRoomCode();
    const protectedPath = path === '/host' || path === '/team-settings' || path === '/games' || /\/games\/.+\/(host|setup)$/.test(path);
    if(!protectedPath) return;

    const ownerToken = localStorage.getItem('challenge_owner_token') || '';
    const userToken = localStorage.getItem('challenge_user_token') || '';

    if(ownerToken){
      try {
        const res = await fetch('/api/owner/me',{headers:{Authorization:'Bearer '+ownerToken}});
        if(res.ok) return;
      } catch(e){}
    }

    if(userToken){
      try {
        const res = await fetch('/api/auth/me',{headers:{Authorization:'Bearer '+userToken}});
        if(res.ok){
          const data = await res.json();
          const userRoom = normalizeRoomCode(data?.user?.roomId || '');
          if(data && data.user && data.user.activated){
            if(userRoom) localStorage.setItem('challenge_last_room', userRoom);
            if(!room || (userRoom && userRoom !== room)){
              window.location.replace(withRoom(path, userRoom) + (window.location.hash||''));
              return;
            }
            return;
          }
        } else {
          localStorage.removeItem('challenge_user_token');
        }
      } catch(e){}
    }

    window.location.replace(buildLoginRedirect());
  }
  window.getRoomCode = getRoomCode;
  window.withRoom = withRoom;
  window.goRoom = function(url){ window.location.href = withRoom(url); };
  window.createRoomSocket = createRoomSocket;
  document.addEventListener('DOMContentLoaded', async ()=>{
    redirectToSavedRoomIfNeeded();
    patchLinks();
    patchRoomLabels();
    await ensureProtectedAccess();
  });
})();
