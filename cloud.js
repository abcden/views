/* Cloud Clip Engine V18. Recuerdo opcional cifrado en el dispositivo; nunca en el repositorio. */
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  if (!$('forge-cloud-start')) return;

  const API = 'https://api.github.com/repos/abcden/views';
  const STATUS_KEY = 'clip-forge-last-job-v14';
  const REMEMBER_KEY = 'clip-forge-admin-encrypted-v1';
  const DEVICE_DB = 'clip-forge-device-v1';
  const REMEMBER_MS = 7 * 24 * 60 * 60 * 1000;
  const ALLOWED = ['youtube.com','youtu.be','twitch.tv','clips.twitch.tv','kick.com','tiktok.com','instagram.com','vimeo.com','dailymotion.com'];
  const DIRECT = ['archive.org','upload.wikimedia.org','github.com','storage.googleapis.com','r2.dev'];
  const MAX_WAIT_MS = 42 * 60 * 1000;
  let token = '', job = '', polling = null, working = false, jobStartedAt = 0, authRevision = 0, failureSeenAt = 0;

  const status = (message, kind='') => {
    $('forge-cloud-status').textContent = message;
    $('forge-cloud-status').dataset.kind = kind;
  };
  const setConnected = connected => {
    $('forge-cloud-start').disabled = !connected || working;
    $('forge-cloud-connect').hidden = connected;
    $('forge-cloud-token').parentElement.hidden = connected;
    $('forge-cloud-disconnect').hidden = !connected;
  };
  const headers = authenticated => ({
    'Accept':'application/vnd.github+json',
    'X-GitHub-Api-Version':'2022-11-28',
    ...(authenticated && token ? {'Authorization':'Bearer '+token} : {})
  });
  async function request(path,options={}){
    const r=await fetch(path.startsWith('https:')?path:API+path,{
      cache:'no-store',credentials:'omit',mode:'cors',
      ...options,headers:{...headers(true),...(options.headers||{})}
    });
    if(r.status===204)return {ok:true};
    const data=await r.json().catch(()=>({}));
    if(!r.ok){const e=new Error(String(data.message||`GitHub devolvió ${r.status}`).slice(0,160));e.code=r.status;throw e;}
    return data;
  }
  function allowedUrl(raw){
    let u;
    try{u=new URL(raw);}catch{return null;}
    const host=u.hostname.toLowerCase().replace(/\.$/,'');
    if(raw.length>500||u.protocol!=='https:'||u.username||u.password||u.port||!u.pathname||u.pathname==='/')return null;
    const plataforma=ALLOWED.some(d=>host===d||host.endsWith('.'+d));
    const directo=DIRECT.some(d=>host===d||host.endsWith('.'+d)) && /\.(mp4|webm|mov|m4v)$/i.test(u.pathname);
    if(directo && /(?:token|signature|x-amz-[^=]*|x-goog-[^=]*|apikey|api_key|auth)=/i.test(u.search))return null;
    return (plataforma||directo)?u.href:null;
  }
  function jobKey(){
    const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);
    return Array.from(bytes,n=>n.toString(16).padStart(2,'0')).join('');
  }
  function clearPolling(){if(polling){clearInterval(polling);polling=null;}}


  // La clave AES no es exportable. Cifrado y clave residen únicamente en este origen/dispositivo.
  // No protege frente a JavaScript malicioso que se ejecute con acceso a este mismo origen.
  function deviceDB(){
    return new Promise((resolve,reject)=>{
      if(!window.indexedDB || !crypto.subtle) return reject(new Error('Almacenamiento cifrado no disponible'));
      const req=indexedDB.open(DEVICE_DB,1);
      req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains('keys')) req.result.createObjectStore('keys');};
      req.onsuccess=()=>resolve(req.result);
      req.onerror=()=>reject(req.error);
    });
  }
  async function storedKey(create=false){
    const db=await deviceDB();
    try{
      let key=await new Promise((resolve,reject)=>{
        const req=db.transaction('keys','readonly').objectStore('keys').get('device');
        req.onsuccess=()=>resolve(req.result);
        req.onerror=()=>reject(req.error);
      });
      if(!key && create){
        key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
        await new Promise((resolve,reject)=>{
          const tx=db.transaction('keys','readwrite');
          tx.objectStore('keys').put(key,'device');
          tx.oncomplete=resolve;
          tx.onerror=()=>reject(tx.error);
        });
      }
      return key;
    }finally{db.close();}
  }
  async function forgetSaved(){
    localStorage.removeItem(REMEMBER_KEY);
    try{
      const db=await deviceDB();
      await new Promise((resolve,reject)=>{
        const tx=db.transaction('keys','readwrite');
        tx.objectStore('keys').delete('device');
        tx.oncomplete=resolve;
        tx.onerror=()=>reject(tx.error);
      });
      db.close();
    }catch(_){/* El dato cifrado ya fue eliminado. */}
  }
  async function saveToken(value){
    const key=await storedKey(true);
    const iv=crypto.getRandomValues(new Uint8Array(12));
    const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(value));
    localStorage.setItem(REMEMBER_KEY,JSON.stringify({
      v:1,until:Date.now()+REMEMBER_MS,iv:Array.from(iv),cipher:Array.from(new Uint8Array(cipher))
    }));
  }
  async function restoreToken(){
    const raw=localStorage.getItem(REMEMBER_KEY);
    if(!raw)return null;
    const saved=JSON.parse(raw);
    if(saved.v!==1 || !Number.isFinite(saved.until) || Date.now()>saved.until ||
       !Array.isArray(saved.iv) || saved.iv.length!==12 || !Array.isArray(saved.cipher))
      throw new Error('Guardado inválido o caducado');
    const key=await storedKey(false);
    if(!key)throw new Error('No existe la clave local');
    const clear=await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(saved.iv)},
      key,new Uint8Array(saved.cipher));
    return new TextDecoder().decode(clear);
  }
  async function verifyAdmin(value){
    const r=await fetch('https://api.github.com/user',{
      cache:'no-store',credentials:'omit',
      headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+value}
    });
    if(!r.ok)throw new Error('GitHub rechazó el token. Comprueba su caducidad y permisos.');
    const who=await r.json();
    if(who.login!=='abcden')throw new Error('Esta cuenta no es el administrador autorizado (abcden).');
  }

  $('forge-cloud-connect').addEventListener('click',async()=>{
    authRevision++;
    const value=$('forge-cloud-token').value.trim();
    if(!value){status('Introduce un token de GitHub limitado al repositorio abcden/views con Actions: escritura.','error');return;}
    $('forge-cloud-connect').disabled=true;
    status('Verificando que seas el administrador de GitHub…');
    try{
      await verifyAdmin(value);
      token=value;
      $('forge-cloud-token').value='';
      setConnected(true);
      if($('forge-cloud-remember').checked){
        try{await saveToken(token);}
        catch(_){$('forge-cloud-remember').checked=false;status('Conectado, pero este navegador no permite recordar la clave.','error');return;}
      }
      status('✓ Administrador conectado. Marca la autorización y pulsa «Crear 5 clips online».','success');
    }catch(e){token='';status(e.message,'error');}
    finally{$('forge-cloud-token').value='';$('forge-cloud-connect').disabled=false;}
  });
  $('forge-cloud-remember').addEventListener('change',async()=>{
    if($('forge-cloud-remember').checked){
      if(!token)return;
      try{await saveToken(token);status('✓ Guardado cifrado en este dispositivo por 7 días.','success');}
      catch(_){$('forge-cloud-remember').checked=false;status('El navegador no permite guardar la sesión cifrada.','error');}
    }else{
      await forgetSaved();
      status(token?'✓ Sesión guardada eliminada. Sigues conectado hasta salir.':'Guardado desactivado.');
    }
  });
  $('forge-cloud-disconnect').addEventListener('click',async()=>{
    authRevision++;
    token='';$('forge-cloud-remember').checked=false;
    await forgetSaved();setConnected(false);
    status('Sesión desconectada. El token guardado se eliminó de este dispositivo.');
  });
  (async()=>{
    if(!localStorage.getItem(REMEMBER_KEY))return;
    const revision=authRevision;
    status('Restaurando tu acceso cifrado de este dispositivo…');
    try{
      const saved=await restoreToken();
      if(!saved)return;
      await verifyAdmin(saved);
      if(revision!==authRevision)return;
      token=saved;
      $('forge-cloud-remember').checked=true;
      setConnected(true);
      status('✓ Administrador conectado automáticamente en este dispositivo.','success');
    }catch(_){
      if(revision!==authRevision)return;
      await forgetSaved();
      token='';$('forge-cloud-remember').checked=false;setConnected(false);
      status('La sesión guardada caducó o ya no es válida. Conecta otra vez con un token actualizado.');
    }
  })();

  function showResults(release){
    const code = (release.body || '').match(/CLIP_FORGE_ERROR:([A-Z_]+)/)?.[1];
    if(code){
      const mensajes = {
        YOUTUBE_VERIFICATION: 'YouTube pidió una verificación antibots al servidor. No es un problema de tu token. Prueba un video propio desde una fuente compatible que permita la descarga automática.',
        SOURCE_UNAVAILABLE: 'El video no está disponible para el procesador (privado, restringido o enlace incompatible). Prueba otro enlace público y autorizado.',
        DOWNLOAD_FAILED: 'La plataforma no permitió descargar este video. Puedes probar otro enlace autorizado compatible.',
        FFMPEG_MISSING: 'El servidor no encontró FFmpeg; avisa al administrador para revisar la instalación.',
        TOOLS_INSTALL_FAILED: 'La instalación de FFmpeg o del procesador tardó demasiado o falló. No se procesó ningún video. Puedes iniciar un trabajo nuevo más tarde.',
        PROCESSING_FAILED: 'El servidor no pudo procesar el video. Revisa la ejecución de GitHub Actions para más detalles.',
        DIRECT_LINK_INVALID: 'El enlace directo no devolvió un MP4/WebM público válido o el servidor lo rechazó por seguridad. Comprueba la URL y el dominio permitido.',
        DIRECT_DOWNLOAD_FAILED: 'El servidor no pudo descargar el archivo directo. Comprueba que sea público y accesible sin iniciar sesión.',
        DIRECT_TOO_LARGE: 'El archivo supera 750 MB. Elige un video autorizado más pequeño.'
      };
      status('✕ ' + (mensajes[code] || mensajes.PROCESSING_FAILED), 'error');
      clearPolling();working=false;setConnected(!!token);return;
    }
    const box=$('forge-cloud-results');box.replaceChildren();
    const files=(release.assets||[]).filter(a=>/^clip_\d{2}_vertical\.mp4$/.test(a.name||'') && /^https:\/\/github\.com\//.test(a.browser_download_url||''));
    if(!files.length){status('✕ Este trabajo terminó sin archivos MP4. Revisa el diagnóstico del servidor o prueba otro video público compatible.','error');clearPolling();working=false;setConnected(!!token);return;}
    for(const [i,asset] of files.entries()){
      const card=document.createElement('article');
      const video=document.createElement('video');
      video.controls=true;video.playsInline=true;video.preload='none';video.src=asset.browser_download_url;
      const heading=document.createElement('h4');heading.textContent=`Clip ${i+1} · vertical 9:16`;
      const actions=document.createElement('div');actions.className='forge-inline-action';
      const a=document.createElement('a');a.className='btn primary';a.href=asset.browser_download_url;a.target='_blank';a.rel='noopener noreferrer';a.textContent='⬇ MP4';
      const edit=document.createElement('button');edit.className='btn';edit.type='button';edit.textContent='✂️ Editar aquí';
      edit.addEventListener('click',async()=>{
        edit.disabled=true;status('Cargando solo este clip en la memoria temporal del editor…');
        try{
          const resp=await fetch(asset.browser_download_url,{mode:'cors',credentials:'omit'});
          if(!resp.ok)throw new Error('El servidor no permite leer el clip desde esta página.');
          const blob=await resp.blob();
          if(blob.size>125*1024*1024)throw new Error('El clip supera el límite de edición en móvil (125 MB).');
          const file=new File([blob],asset.name,{type:'video/mp4'});
          window.dispatchEvent(new CustomEvent('forge-load-cloud-file',{detail:{file}}));
          $('forge-frame').scrollIntoView({behavior:'smooth',block:'center'});
          status('Clip cargado para editar en la página. No se ha guardado en Archivos.','success');
        }catch(e){status(`El MP4 está listo para ver o descargar, pero no se pudo abrir en el editor: ${e.message}`,'error');}
        finally{edit.disabled=false;}
      });
      actions.append(a,edit);card.append(video,heading,actions);box.append(card);
    }
    status(`✓ ${files.length} clips creados en la nube. Puedes verlos aquí y descargarlos. Los enlaces públicos caducan tras la limpieza de 24–30 horas.`,'success');
    clearPolling();
    working=false;setConnected(!!token);
  }

  function nombreEtapa(nombre,segundos=0){
    const n=(nombre||'').toLowerCase();
    if(n.includes('instalar ffmpeg')){
      return segundos>240
        ? '⏳ Preparando FFmpeg y herramientas. La instalación tarda más de lo habitual; el servidor tiene un límite de 6 minutos para este paso.'
        : '⏳ Preparando FFmpeg y herramientas del servidor (todavía no se analiza el video)…';
    }
    if(n.includes('preparar python') || n.includes('preparar javascript') || n.includes('obtener el generador'))
      return '⏳ Preparando el servidor para procesar el video…';
    if(n.includes('detectar momentos'))return '🎬 Analizando audio y escenas, seleccionando momentos y exportando los MP4…';
    if(n.includes('publicar clips'))return '📦 Subiendo los clips generados para verlos en tu panel…';
    if(n.includes('publicar diagnóstico'))return '⚠️ El servidor detectó un problema. Preparando una explicación dentro del panel…';
    if(n.includes('respaldo temporal'))return '✅ Clips exportados. Preparando copia temporal…';
    return nombre ? ('⏳ Etapa del servidor: '+nombre+'…') : '⏳ Esperando que GitHub asigne el servidor…';
  }

  async function checkResult(){
    if(!job)return;
    $('forge-cloud-check').disabled=true;
    try{
      const release=await request('/releases/tags/clip-'+job);
      showResults(release);
    }catch(e){
      if(e.code!==404){status('No se pudo comprobar el resultado: '+e.message,'error');return;}
      if(jobStartedAt && Date.now()-jobStartedAt>MAX_WAIT_MS){
        status('✕ El servidor no terminó dentro del tiempo máximo. Puedes iniciar otro trabajo si el enlace sigue siendo compatible.','error');
        clearPolling();working=false;setConnected(!!token);return;
      }
      try{
        const data=await request('/actions/workflows/crear-clips.yml/runs?event=workflow_dispatch&per_page=40');
        const run=(data.workflow_runs||[]).find(x=>(x.display_title||'').includes(job));
        if(!run){status('⏳ Esperando que aparezca el trabajo en GitHub Actions…');return;}
        if(run.status==='completed'){
          if(run.conclusion!=='success'){
            if(!failureSeenAt)failureSeenAt=Date.now();
            status('⚠️ El servidor terminó con un error. Buscando el diagnóstico detallado para mostrarlo aquí…','error');
            if(Date.now()-failureSeenAt>100000){
              status('✕ El trabajo falló y no se publicó un diagnóstico. Inténtalo con otro enlace público compatible.','error');
              clearPolling();working=false;setConnected(!!token);
            }
          }else status('✅ Procesamiento completo. Esperando que GitHub publique los archivos MP4…');
          return;
        }
        if(run.status!=='in_progress'){
          status('⏳ Trabajo en cola. Aún no ha empezado la instalación ni el análisis del video…');
          return;
        }
        try{
          const jobs=await request('/actions/runs/'+run.id+'/jobs?per_page=30');
          const crear=(jobs.jobs||[]).find(x=>x.name==='crear');
          const paso=(crear?.steps||[]).find(x=>x.status==='in_progress');
          const inicio=paso?.started_at?Date.parse(paso.started_at):0;
          const elapsed=inicio?Math.max(0,Math.floor((Date.now()-inicio)/1000)):0;
          status(nombreEtapa(paso?.name,elapsed));
        }catch(_){status('⏳ GitHub está ejecutando el trabajo. Volveré a consultar su etapa…');}
      }catch(_){status('⏳ Esperando respuesta de GitHub. Se revisará el resultado automáticamente.');}
    }finally{$('forge-cloud-check').disabled=false;}
  }

  $('forge-cloud-start').addEventListener('click',async()=>{
    if(!token||working)return;
    const url=allowedUrl($('forge-url').value.trim());
    if(!url){status('Pega un video público de YouTube/TikTok/Vimeo/Twitch/Kick o un enlace directo MP4/WebM de Archive.org, Wikimedia, GitHub Releases, Google Cloud Storage o Cloudflare R2.','error');return;}
    if(!$('forge-authorized').checked){status('Confirma que tienes permiso y aceptas que los clips sean públicos temporalmente.','error');return;}
    working=true;setConnected(true);$('forge-cloud-results').replaceChildren();
    status('Preparando el trabajo remoto…');
    try{
      const repo=await request('');
      if(repo.default_branch!=='studio-pro')throw new Error('Falta un ajuste único: cambia la rama predeterminada del repositorio a studio-pro para activar el generador (GitHub → Settings → General → Default branch).');
      const id=jobKey();
      await request('/actions/workflows/crear-clips.yml/dispatches',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({ref:'studio-pro',inputs:{job_key:id,video_url:url,clip_seconds:$('forge-job-length').value,authorized_public:'true'}})
      });
      job=id;jobStartedAt=Date.now();failureSeenAt=0;
      try{localStorage.setItem(STATUS_KEY,JSON.stringify({id:job,started:jobStartedAt}));}catch(_){}
      $('forge-cloud-check').hidden=false;
      status('✓ Enlace enviado a la nube. El servidor descargará el original autorizado y creará los clips; no uses el almacenamiento del iPhone.','success');
      clearPolling();polling=setInterval(checkResult,20000);
      setTimeout(checkResult,8000);
    }catch(e){
      status('No se pudo iniciar: '+e.message,'error');
      working=false;setConnected(!!token);
    }
  });
  $('forge-cloud-check').addEventListener('click',checkResult);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden && job && working)checkResult();});
  try{
    const last=JSON.parse(localStorage.getItem(STATUS_KEY)||'null');
    if(/^[a-f0-9]{32}$/.test(last?.id||'')&&Date.now()-last.started<32*60*60*1000){
      job=last.id;jobStartedAt=last.started;
      $('forge-cloud-check').hidden=false;
      status('Encontré un trabajo anterior. Pulsa «Revisar resultado» para consultar los clips sin volver a procesar.');
    }
  }catch(_){}
  // Acceso de invitados: usa el Gateway cuando esté configurado, nunca solicita un PAT.
  // GitHub Pages continúa ofreciendo el editor local aunque el Gateway esté desconectado.
  const GATEWAY='https://clip-forge-gateway.sarmientopaul714.chatgpt.site';
  const guestArea=document.createElement('section');
  guestArea.className='studio-card';
  guestArea.style.cssText='margin:18px 0;padding:18px;border:1px solid rgba(116,214,255,.25);border-radius:18px;background:rgba(13,21,46,.88);color:#edf4ff';
  const guestTitle=document.createElement('h3');
  guestTitle.textContent='✦ Crear clips online · Invitados';
  guestTitle.style.margin='0 0 8px';
  const guestInfo=document.createElement('p');
  guestInfo.textContent='Sin token y sin subir archivos desde el teléfono. Máximo global provisional: 6 solicitudes al día. Solo videos propios o autorizados; YouTube puede rechazar la descarga.';
  guestInfo.style.cssText='font-size:13px;line-height:1.6;opacity:.86';
  const guestBtn=document.createElement('button');
  guestBtn.className='btn primary';
  guestBtn.type='button';
  guestBtn.textContent='Comprobar servidor gratuito';
  const guestMsg=document.createElement('p');
  guestMsg.setAttribute('role','status');
  guestMsg.style.cssText='font-size:13px;margin:12px 0 0;line-height:1.5';
  const guestCheck=document.createElement('button');
  guestCheck.type='button';
  guestCheck.className='btn';
  guestCheck.textContent='Revisar mis clips';
  guestCheck.hidden=true;
  guestArea.append(guestTitle,guestInfo,guestBtn,guestCheck,guestMsg);
  $('forge-cloud-start').parentElement.append(guestArea);
  let gatewayReady=false,guestJob='',guestBusy=false,guestPoll=null;
  const guestStatus=msg=>guestMsg.textContent=msg;
  async function gatewayRequest(path,options={}){
    const response=await fetch(GATEWAY+path,{mode:'cors',credentials:'omit',cache:'no-store',...options});
    if(!response.headers.get('content-type')?.includes('application/json'))
      throw Error('El servicio requiere acceso o no está disponible públicamente.');
    const data=await response.json();
    if(!response.ok)throw Error(data.error||'Error del servidor');
    return data;
  }
  async function checkGateway(){
    try{
      const state=await gatewayRequest('/health');
      gatewayReady=!!state.configured;
      guestBtn.textContent=gatewayReady?'✦ Generar hasta 5 clips gratis':'Comprobar servidor gratuito';
      guestStatus(gatewayReady?'✓ Motor de clips disponible. Pega un enlace, confirma la autorización y pulsa el botón.':'⏳ El procesador gratuito aún no está activado. Puedes usar el editor local con enlaces MP4 directos compatibles.');
    }catch(_){
      gatewayReady=false;
      guestBtn.textContent='Comprobar servidor gratuito';
      guestStatus('⏳ El Gateway no responde como servicio público. La edición local sigue disponible.');
    }
  }
  async function checkGuestJob(){
    if(!guestJob)return;
    try{
      const result=await gatewayRequest('/api/jobs/'+guestJob);
      if(result.status==='complete'&&result.clips?.length){
        clearInterval(guestPoll);guestPoll=null;guestBusy=false;
        showResults({body:'',assets:result.clips.map(c=>({name:c.name,browser_download_url:c.url}))});
        guestStatus('✓ ¡Clips listos! Puedes verlos y descargarlos en el panel.');
      }else if(result.status==='failed'){
        clearInterval(guestPoll);guestPoll=null;guestBusy=false;
        const reason=result.error==='YOUTUBE_VERIFICATION'
          ?'YouTube exigió una verificación antibots. Usa otra fuente autorizada que admita edición.'
          :'El servidor no pudo procesar este video: '+(result.error||'error desconocido');
        guestStatus('✕ '+reason);
      }else guestStatus('⏳ Estado: '+(result.status||'esperando')+'. La página consultará el resultado automáticamente.');
    }catch(e){guestStatus('No se pudo revisar el trabajo: '+e.message);}
  }
  guestCheck.addEventListener('click',checkGuestJob);
  guestBtn.addEventListener('click',async()=>{
    if(!gatewayReady){await checkGateway();return;}
    if(guestBusy)return;
    const url=allowedUrl($('forge-url').value.trim());
    if(!url){guestStatus('Pega un enlace compatible en el campo de video del editor.');return;}
    if(!$('forge-authorized').checked){guestStatus('Confirma que tienes autorización para utilizar el video.');return;}
    guestBusy=true;guestBtn.disabled=true;
    guestStatus('Enviando solicitud al servidor gratuito…');
    try{
      const result=await gatewayRequest('/api/jobs',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({video_url:url,clip_seconds:Number($('forge-job-length').value),authorized_public:true})});
      guestJob=result.id;
      guestCheck.hidden=false;
      guestStatus('✓ Solicitud recibida. Esperando que GitHub Actions genere los clips…');
      clearInterval(guestPoll);guestPoll=setInterval(checkGuestJob,20000);
      setTimeout(checkGuestJob,4000);
    }catch(e){
      guestStatus('No se pudo iniciar: '+(e.message==='DAILY_LIMIT'?'se alcanzó el límite gratuito diario.':e.message));
      guestBusy=false;
    }finally{guestBtn.disabled=false;}
  });
  checkGateway();
  window.addEventListener('pagehide',()=>{if(guestPoll)clearInterval(guestPoll);});
  window.addEventListener('pagehide',()=>{token='';clearPolling();});
})();
