/* GTA VI Clip Forge: editor local sin envíos ni tokens en el navegador. */
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const video = $("forge-video"), canvas = $("forge-canvas"), ctx = canvas?.getContext("2d");
  if (!video || !canvas || !ctx) return;

  const tool = {file:null,url:null,duration:0,scanning:false,recording:false,cancelled:false,recorder:null,audioContext:null,audioSource:null,frame:0};
  const out = (msg,kind="") => {$("forge-status").textContent=msg; $("forge-status").dataset.kind=kind;};
  const clock = t => {const s=Math.max(0,Math.floor(Number(t)||0));return `${String(Math.floor(s/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;};
  const clamp = (x,lo,hi) => Math.max(lo,Math.min(hi,Number(x)||0));

  const formats={"9:16":[540,960,"9:16 · vertical"],"1:1":[720,720,"1:1 · cuadrado"],"16:9":[960,540,"16:9 · horizontal"]};
  const logo = new Image();
  logo.src="icon.svg?logo=original-v6";
  logo.addEventListener("load",draw);

  function setFormat(){
    const [w,h,label]=formats[$("forge-ratio").value]||formats["9:16"];
    canvas.width=w;canvas.height=h;
    $("forge-frame").style.aspectRatio=`${w}/${h}`;
    $("forge-size").textContent=label;
    draw();
  }
  function draw(){
    const w=canvas.width,h=canvas.height;
    ctx.fillStyle="#0a0d1d";ctx.fillRect(0,0,w,h);
    if(!tool.file || !video.videoWidth || video.readyState<2)return;
    const vw=video.videoWidth,vh=video.videoHeight,ratio=Math.max(w/vw,h/vh),fill=$('forge-fit').value==='cover';
    if(!fill){
      // Un fondo del mismo video preserva toda la imagen en formato vertical.
      ctx.save();ctx.filter="blur(25px) brightness(0.4)";
      ctx.drawImage(video,-15,-15,w+30,h+30);
      ctx.restore();
    }
    const scale=fill?ratio:Math.min(w/vw,h/vh),dw=vw*scale,dh=vh*scale;
    const pan=clamp($("forge-pan").value,0,100)/100;
    const dx=(w-dw)*pan,dy=(h-dh)/2;
    ctx.drawImage(video,dx,dy,dw,dh);
    const text=$("forge-caption").value.trim();
    if(text){
      const fontSize=Number($("forge-caption-size").value)||36;
      const lines=[];let line="";
      ctx.font=`900 ${fontSize}px Arial,sans-serif`;
      for(const word of text.split(/\s+/)){
        const candidate=line?line+" "+word:word;
        if(ctx.measureText(candidate).width>w-58 && line){lines.push(line);line=word;} else line=candidate;
      }
      if(line)lines.push(line);
      const blockH=lines.length*fontSize*1.22+28;
      const position=$("forge-caption-position").value;
      const y=position==="center"?(h-blockH)/2:position==="bottom"?h-blockH-90:75;
      ctx.fillStyle="rgba(4,5,20,.72)";ctx.fillRect(0,y,w,blockH);
      ctx.textAlign="center";ctx.textBaseline="middle";
      for(const [i,l] of lines.entries()){
        ctx.lineWidth=4;ctx.strokeStyle="rgba(0,0,0,.8)";ctx.strokeText(l,w/2,y+18+fontSize*(i+.55)*1.22);
        ctx.fillStyle="#ffffff";ctx.fillText(l,w/2,y+18+fontSize*(i+.55)*1.22);
      }
    }
    if($("forge-watermark").checked){
      if(logo.complete&&logo.naturalWidth)ctx.drawImage(logo,w-91,22,65,65);
      ctx.font=`800 ${Math.round(w*.028)}px Arial,sans-serif`;
      ctx.textAlign="right";ctx.fillStyle="#fff";ctx.fillText("GTA VI CLIPS",w-23,103);
    }
  }
  function frameLoop(){
    cancelAnimationFrame(tool.frame);
    const frame=()=>{
      draw();
      if(!video.paused || tool.recording)tool.frame=requestAnimationFrame(frame);
    };
    tool.frame=requestAnimationFrame(frame);
  }
  function updateClock(){
    $("forge-clock").textContent=`${clock(video.currentTime)} / ${clock(tool.duration)}`;
    $("forge-seek").value=String(video.currentTime||0);
    $("forge-play").textContent=video.paused?"▶ Reproducir":"Ⅱ Pausar";
  }
  function selection(){
    const s=clamp($("forge-start").value,0,Math.max(0,tool.duration-.3));
    const e=clamp($("forge-end").value,s+.3,tool.duration);
    $("forge-start").value=s.toFixed(1);$("forge-end").value=e.toFixed(1);
    $("forge-length").textContent=`Duración del clip: ${(e-s).toFixed(1)} segundos`;
    return {start:s,end:e};
  }
  function setSelection(s,e){
    $("forge-start").value=Number(s).toFixed(1);
    $("forge-end").value=Number(e).toFixed(1);
    selection();
    seekVideo(s).catch(()=>{});
  }
  function seekVideo(time){
    return new Promise((resolve,reject)=>{
      const target=clamp(time,0,Math.max(0,tool.duration-.06));
      if(Math.abs(video.currentTime-target)<.045&&video.readyState>=2){draw();resolve();return;}
      const done=()=>{clearTimeout(timer);video.removeEventListener("seeked",done);draw();resolve();};
      const timer=setTimeout(()=>{video.removeEventListener("seeked",done);reject(new Error("No se pudo buscar ese segundo del video."));},4500);
      video.addEventListener("seeked",done,{once:true});
      try{video.currentTime=target;}catch(e){clearTimeout(timer);video.removeEventListener("seeked",done);reject(e);}
    });
  }
  function controls(enabled){
    for(const id of ["forge-play","forge-seek","forge-start","forge-end","forge-set-start","forge-set-end","forge-analyze","forge-export"])$(id).disabled=!enabled;
  }
  $("forge-file").addEventListener("change",e=>{
    if(tool.recording||tool.scanning){out("Espera a que termine el proceso actual.","error");return;}
    const file=e.target.files?.[0];if(!file)return;
    if(!(file.type.startsWith("video/")||/\.(mp4|mov|webm|m4v)$/i.test(file.name))){out("Selecciona un archivo de video válido.","error");return;}
    if(file.size>850*1024*1024){out("Este editor admite archivos de hasta 850 MB. Usa un video más corto.","error");return;}
    video.pause();
    if(tool.url)URL.revokeObjectURL(tool.url);
    tool.url=URL.createObjectURL(file);tool.file=file;tool.duration=0;
    $("forge-file-name").textContent=file.name;
    $("forge-empty").hidden=true;controls(false);
    $("forge-moments").innerHTML='<p class="studio-note">Pulsa «Detectar momentos» o ajusta los segundos manualmente.</p>';
    video.src=tool.url;video.load();
    out("Preparando tu video…");
  });
  video.addEventListener("loadedmetadata",()=>{
    const d=video.duration;
    if(!Number.isFinite(d)||d<.5){out("No se pudo leer la duración del video. Usa un MP4 o MOV compatible.","error");return;}
    tool.duration=d;
    $("forge-seek").max=String(d);
    $("forge-start").max=String(d);$("forge-end").max=String(d);
    setSelection(0,Math.min(d,30));
    controls(true);updateClock();setFormat();
    out("Video cargado. Puedes detectar momentos, editar y exportar.","success");
  });
  video.addEventListener("error",()=>out("No se pudo abrir el archivo. Prueba con MP4 H.264 o MOV compatible.","error"));
  video.addEventListener("timeupdate",()=>{
    if(!tool.recording&&!tool.scanning&&video.currentTime>=selection().end){video.pause();}
    if(tool.recording){
      const s=selection();$("forge-export-bar").style.width=`${Math.min(100,(video.currentTime-s.start)/(s.end-s.start)*100)}%`;
      if(video.currentTime>=s.end-.045)stopRecording();
    }
    updateClock();
  });
  video.addEventListener("pause",updateClock);video.addEventListener("play",frameLoop);
  video.addEventListener("seeked",draw);video.addEventListener("loadeddata",draw);
  video.addEventListener("ended",()=>{if(tool.recording)stopRecording();updateClock();});
  $("forge-play").addEventListener("click",async()=>{
    if(!tool.file||tool.recording||tool.scanning)return;
    if(video.paused){const s=selection();if(video.currentTime>=s.end-.08)await seekVideo(s.start);try{await video.play();}catch(e){out("Tu navegador no permitió reproducir este formato.","error");}}
    else video.pause();updateClock();
  });
  $("forge-seek").addEventListener("input",e=>{if(!tool.recording&&!tool.scanning)seekVideo(e.target.value).catch(()=>{});});
  for(const id of ["forge-start","forge-end"])$(id).addEventListener("change",()=>{if(tool.duration)selection();});
  $("forge-set-start").addEventListener("click",()=>{setSelection(video.currentTime,selection().end);});
  $("forge-set-end").addEventListener("click",()=>{setSelection(selection().start,video.currentTime);});
  for(const id of ["forge-ratio","forge-fit","forge-pan","forge-caption","forge-caption-position","forge-caption-size","forge-watermark"]){
    $(id).addEventListener("input",()=>{if(id==="forge-ratio")setFormat();else draw();});
  }

  // Detección visual sin servicios externos: muestrea fotogramas de bajo tamaño.
  $("forge-analyze").addEventListener("click",async()=>{
    if(!tool.file||tool.recording||tool.scanning)return;
    tool.scanning=true;video.pause();controls(false);$("forge-scan-progress").hidden=false;
    const previous=video.currentTime,seconds=Math.min(tool.duration,720);
    const step=Math.max(2.5,seconds/105),total=Math.max(1,Math.floor((seconds-.15)/step));
    const mini=document.createElement("canvas");mini.width=48;mini.height=27;const g=mini.getContext("2d",{willReadFrequently:true});
    const rows=[];let last=null;
    try{
      for(let i=0;i<=total;i++){
        const t=Math.min(seconds-.12,i*step);
        await seekVideo(t);
        g.drawImage(video,0,0,mini.width,mini.height);
        const cur=g.getImageData(0,0,mini.width,mini.height).data;
        let sum=0;
        if(last)for(let j=0;j<cur.length;j+=8)sum+=Math.abs(cur[j]-last[j])+Math.abs(cur[j+1]-last[j+1])+Math.abs(cur[j+2]-last[j+2]);
        const diff=last?sum/(cur.length/8)/3:0;
        rows.push({t,score:diff});last=new Uint8ClampedArray(cur);
        const pct=Math.round((i+1)/(total+1)*100);
        $("forge-scan-bar").style.width=pct+"%";$("forge-scan-label").textContent=pct+"% analizado";
        if(i%8===0)await new Promise(r=>setTimeout(r,0));
      }
      const length=Math.min(30,Math.max(8,Math.round(tool.duration*.15)));
      const ranked=rows.slice(1).sort((a,b)=>b.score-a.score);const selected=[];
      for(const r of ranked){
        const start=clamp(r.t-4,0,Math.max(0,seconds-length));
        if(selected.some(x=>Math.abs(x.start-start)<length*.8))continue;
        selected.push({start,end:Math.min(tool.duration,start+length),score:r.score});
        if(selected.length===5)break;
      }
      if(!selected.length)selected.push({start:0,end:Math.min(seconds,30),score:0});
      const maxScore=Math.max(1,...selected.map(x=>x.score));
      $("forge-moments").innerHTML=selected.map((m,i)=>{
        const confidence=Math.round(m.score/maxScore*100);
        return `<div class="forge-moment"><div><b>✦ Momento ${i+1} · ${clock(m.start)}–${clock(m.end)}</b><small>Movimiento o cambio visual · intensidad relativa ${confidence}%</small></div><button class="btn" type="button" data-moment="${i}">Usar corte</button></div>`;
      }).join("");
      $("forge-moments").querySelectorAll("[data-moment]").forEach(b=>b.addEventListener("click",()=>{const m=selected[Number(b.dataset.moment)];setSelection(m.start,m.end);out(`Momento ${Number(b.dataset.moment)+1} seleccionado. Puedes ajustar el principio y final.`,"success");}));
      $("forge-scan-label").textContent=`${selected.length} sugerencias listas`;
      out("Sugerencias visuales listas. Los clips con mejores escenas no siempre son los más interesantes por su diálogo.","success");
    }catch(err){out("No se pudo analizar este video. Puedes editarlo manualmente.","error");$("forge-scan-label").textContent="Análisis no disponible";}
    finally{tool.scanning=false;$("forge-scan-progress").hidden=true;controls(true);await seekVideo(previous).catch(()=>{});}
  });

  function preferredMime(){
    if(!window.MediaRecorder)return null;
    return ["video/mp4;codecs=avc1.42E01E,mp4a.40.2","video/mp4","video/webm;codecs=vp9,opus","video/webm;codecs=vp8,opus","video/webm"].find(s=>MediaRecorder.isTypeSupported(s))||null;
  }
  const mime=preferredMime();
  $("forge-format").textContent=mime?.includes("mp4")?"Exportación MP4 disponible":mime?"Exportación WebM disponible":"Exportación no compatible en este navegador";
  async function audioGraph(){
    const Audio=window.AudioContext||window.webkitAudioContext;
    if(!Audio)return null;
    if(!tool.audioContext){
      tool.audioContext=new Audio();
      tool.audioSource=tool.audioContext.createMediaElementSource(video);
      tool.audioSource.connect(tool.audioContext.destination);
    }
    await tool.audioContext.resume();
    const target=tool.audioContext.createMediaStreamDestination();
    tool.audioSource.connect(target);
    return target;
  }
  function stopRecording(){
    if(tool.recorder?.state==="recording")tool.recorder.stop();
    video.pause();
  }
  $("forge-cancel").addEventListener("click",()=>{tool.cancelled=true;stopRecording();out("Exportación cancelada.");});
  $("forge-export").addEventListener("click",async()=>{
    if(!tool.file||tool.recording||tool.scanning)return;
    const s=selection();
    if(s.end-s.start>180){out("Para proteger la memoria del navegador, exporta fragmentos de hasta 3 minutos.","error");return;}
    if(!mime||!canvas.captureStream){out("Tu navegador no permite grabar desde el editor. Prueba Chrome o Safari actualizado.","error");return;}
    tool.recording=true;tool.cancelled=false;video.pause();controls(false);
    $("forge-export-progress").hidden=false;$("forge-export-bar").style.width="0%";$("forge-cancel").hidden=false;
    let stream=null,destination=null,recorder=null;
    try{
      await seekVideo(s.start);draw();
      const captured=canvas.captureStream(30);
      destination=await audioGraph().catch(()=>null);
      stream=new MediaStream([...captured.getVideoTracks(),...(destination?.stream.getAudioTracks()||[])]);
      const pieces=[];
      recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:2500000});
      tool.recorder=recorder;
      recorder.addEventListener("dataavailable",e=>{if(e.data.size>0)pieces.push(e.data);});
      recorder.addEventListener("stop",()=>{
        if(destination)try{tool.audioSource.disconnect(destination);}catch(_){}
        for(const track of stream.getTracks())track.stop();
        tool.recording=false;tool.recorder=null;controls(true);$("forge-cancel").hidden=true;$("forge-export-progress").hidden=true;
        if(tool.cancelled)return;
        const blob=new Blob(pieces,{type:mime});
        if(blob.size<1024){out("La grabación quedó vacía. Prueba otro formato o navegador.","error");return;}
        const ext=mime.includes("mp4")?"mp4":"webm",url=URL.createObjectURL(blob),a=document.createElement("a");
        const name=(tool.file.name.replace(/\.[^.]+$/,"").replace(/[^a-zA-Z0-9_-]/g,"_").slice(0,55)||"gta6");
        a.href=url;a.download=`${name}_clip_${Math.round(s.start)}s.${ext}`;document.body.append(a);a.click();a.remove();
        setTimeout(()=>URL.revokeObjectURL(url),30000);
        out(`Clip exportado en ${ext.toUpperCase()} (${(blob.size/1048576).toFixed(1)} MB). Ya puedes revisarlo o compartirlo.`,"success");
      });
      recorder.start(250);frameLoop();
      await video.play();
      out(`Grabando clip de ${(s.end-s.start).toFixed(1)} s. No cierres esta pestaña.`);
    }catch(err){
      if(recorder?.state==="recording")recorder.stop();
      if(destination)try{tool.audioSource?.disconnect(destination);}catch(_){}
      if(stream)for(const track of stream.getTracks())track.stop();
      tool.recording=false;tool.recorder=null;controls(true);$("forge-cancel").hidden=true;$("forge-export-progress").hidden=true;
      out("No se pudo exportar con este navegador o códec. Intenta con un MP4 H.264 en Chrome actualizado.","error");
    }
  });

  // Sin token en la página pública: se abre el formulario GitHub del propietario.
  $("forge-github").addEventListener("click",()=>{
    const url=$("forge-url").value.trim();
    const status=$("forge-url-status");
    let parsed;
    try{parsed=new URL(url);}catch(_){status.textContent="Escribe un enlace HTTPS válido de un video.";return;}
    const allowed=["youtube.com","youtu.be","twitch.tv","clips.twitch.tv","kick.com","tiktok.com","instagram.com","vimeo.com","dailymotion.com"];
    const host=parsed.hostname.toLowerCase().replace(/\.$/,"");
    if(parsed.protocol!=="https:"||!allowed.some(d=>host===d||host.endsWith("."+d))){status.textContent="Enlace no compatible. Usa YouTube, Twitch, Kick, TikTok, Instagram, Vimeo o Dailymotion.";return;}
    if(!$("forge-authorized").checked){status.textContent="Confirma que el video es público y tienes permiso para reutilizarlo.";return;}
    const target="https://github.com/abcden/views/actions/workflows/crear-clips.yml";
    // Abre primero para evitar bloqueo por ventanas emergentes tras la copia.
    window.open(target,"_blank","noopener,noreferrer");
    status.textContent=`Abierto GitHub. Pega tu enlace en video_url, elige ${$("forge-job-length").value} segundos y marca authorized_public.`;
    if(navigator.clipboard?.writeText){navigator.clipboard.writeText(url).then(()=>{status.textContent+=" Enlace copiado al portapapeles ✓";}).catch(()=>{status.textContent+=" Copia manualmente el enlace para pegarlo en GitHub.";});}
  });
  setFormat();
  window.addEventListener("pagehide",()=>{if(tool.url)URL.revokeObjectURL(tool.url);});
})();
