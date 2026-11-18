/* Cloud Clip Engine V14. Credenciales solo en memoria; nunca en el repositorio. */
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  if (!$('forge-cloud-start')) return;

  const API = 'https://api.github.com/repos/abcden/views';
  const STATUS_KEY = 'clip-forge-last-job-v14';
  const ALLOWED = ['youtube.com','youtu.be','twitch.tv','clips.twitch.tv','kick.com','tiktok.com','instagram.com','vimeo.com','dailymotion.com'];
  const MAX_WAIT_MS = 42 * 60 * 1000;
  let token = '', job = '', polling = null, working = false, jobStartedAt = 0;

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
    return ALLOWED.some(d=>host===d||host.endsWith('.'+d))?u.href:null;
  }
  function jobKey(){
    const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);
    return Array.from(bytes,n=>n.toString(16).padStart(2,'0')).join('');
  }
  function clearPolling(){if(polling){clearInterval(polling);polling=null;}}

  $('forge-cloud-connect').addEventListener('click',async()=>{
    const value=$('forge-cloud-token').value.trim();
    if(!value){status('Introduce un token de GitHub limitado al repositorio abcden/views con Actions: escritura.','error');return;}
    $('forge-cloud-connect').disabled=true;
    status('Verificando que seas el administrador de GitHub…');
    try{
      const r=await fetch('https://api.github.com/user',{cache:'no-store',credentials:'omit',headers:{'Accept':'application/vnd.github+json','Authorization':'Bearer '+value}});
      if(!r.ok)throw new Error('GitHub rechazó el token. Comprueba su caducidad y permisos.');
      const who=await r.json();
      if(who.login!=='abcden')throw new Error('Esta cuenta no es el administrador autorizado (abcden).');
      token=value;
      $('forge-cloud-token').value='';
      setConnected(true);
      status('✓ Administrador conectado. Marca la autorización y pulsa «Crear 5 clips online».','success');
    }catch(e){token='';status(e.message,'error');}
    finally{$('forge-cloud-token').value='';$('forge-cloud-connect').disabled=false;}
  });
  $('forge-cloud-disconnect').addEventListener('click',()=>{
    token='';setConnected(false);status('Sesión desconectada. No se conserva ningún token en el dispositivo.');
  });

  function showResults(release){
    const code = (release.body || '').match(/CLIP_FORGE_ERROR:([A-Z_]+)/)?.[1];
    if(code){
      const mensajes = {
        YOUTUBE_VERIFICATION: 'YouTube pidió una verificación antibots al servidor. No es un problema de tu token. Prueba un video propio desde una fuente compatible que permita la descarga automática.',
        SOURCE_UNAVAILABLE: 'El video no está disponible para el procesador (privado, restringido o enlace incompatible). Prueba otro enlace público y autorizado.',
        DOWNLOAD_FAILED: 'La plataforma no permitió descargar este video. Puedes probar otro enlace autorizado compatible.',
        FFMPEG_MISSING: 'El servidor no encontró FFmpeg; avisa al administrador para revisar la instalación.',
        PROCESSING_FAILED: 'El servidor no pudo procesar el video. Revisa la ejecución de GitHub Actions para más detalles.'
      };
      status('✕ ' + (mensajes[code] || mensajes.PROCESSING_FAILED), 'error');
      clearPolling();working=false;setConnected(!!token);return;
    }
    const box=$('forge-cloud-results');box.replaceChildren();
    const files=(release.assets||[]).filter(a=>/^clip_\d{2}_vertical\.mp4$/.test(a.name||'') && /^https:\/\/github\.com\//.test(a.browser_download_url||''));
    if(!files.length){status('El trabajo terminó, pero aún no hay MP4 en la publicación. Vuelve a revisar en un momento.');return;}
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

  async function checkResult(){
    if(!job)return;
    $('forge-cloud-check').disabled=true;
    try{
      const release=await request(`/releases/tags/clip-${job}`);
      showResults(release);
    }catch(e){
      if(e.code!==404){status('No se pudo comprobar el resultado: '+e.message,'error');return;}
      if(jobStartedAt && Date.now()-jobStartedAt>MAX_WAIT_MS){
        status('El trabajo no terminó en 42 minutos. Revisa si GitHub Actions informó de una restricción del enlace.','error');
        clearPolling();working=false;setConnected(!!token);return;
      }
      try{
        const data=await request('/actions/workflows/crear-clips.yml/runs?event=workflow_dispatch&per_page=30');
        const run=(data.workflow_runs||[]).find(x=>(x.display_title||'').includes(job));
        if(run?.status==='completed'&&run.conclusion!=='success'){
          status('✕ El procesamiento falló. Pulsa «Revisar resultado» en unos segundos para ver el diagnóstico específico; si aún no aparece, consulta la ejecución en GitHub Actions.','error');
          clearPolling();working=false;setConnected(!!token);
        }else status(run?.status==='in_progress'?'⏳ Analizando video, seleccionando escenas y exportando MP4 en la nube…': '⏳ Trabajo enviado. Esperando que GitHub inicie el procesamiento…');
      }catch(_){status('⏳ Esperando clips. Se revisará el resultado automáticamente.');}
    }finally{$('forge-cloud-check').disabled=false;}
  }

  $('forge-cloud-start').addEventListener('click',async()=>{
    if(!token||working)return;
    const url=allowedUrl($('forge-url').value.trim());
    if(!url){status('Pega un enlace público compatible: YouTube, TikTok, Instagram, Vimeo, Twitch o Kick.','error');return;}
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
      job=id;jobStartedAt=Date.now();
      try{localStorage.setItem(STATUS_KEY,JSON.stringify({id:job,started:jobStartedAt}));}catch(_){}
      $('forge-cloud-check').hidden=false;
      status('✓ Enlace enviado a la nube. El servidor descargará el original autorizado y creará los clips; no uses el almacenamiento del iPhone.','success');
      clearPolling();polling=setInterval(checkResult,45000);
      setTimeout(checkResult,12000);
    }catch(e){
      status('No se pudo iniciar: '+e.message,'error');
      working=false;setConnected(!!token);
    }
  });
  $('forge-cloud-check').addEventListener('click',checkResult);
  try{
    const last=JSON.parse(localStorage.getItem(STATUS_KEY)||'null');
    if(/^[a-f0-9]{32}$/.test(last?.id||'')&&Date.now()-last.started<32*60*60*1000){
      job=last.id;jobStartedAt=last.started;
      $('forge-cloud-check').hidden=false;
      status('Encontré un trabajo anterior. Pulsa «Revisar resultado» para consultar los clips sin volver a procesar.');
    }
  }catch(_){}
  window.addEventListener('pagehide',()=>{token='';clearPolling();});
})();
