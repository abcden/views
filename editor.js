/* GTA VI Clip Forge: editor local sin envíos ni tokens en el navegador. */
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const video = $("forge-video"), canvas = $("forge-canvas"), ctx = canvas?.getContext("2d");
  if (!video || !canvas || !ctx) return;

  const tool = {file:null,url:null,duration:0,scanning:false,recording:false,cancelled:false,recorder:null,audioContext:null,audioSource:null,frame:0,moments:[],exportRange:null,lastDownload:null,needsScan:false,loading:false,abort:null};
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
    $("forge-export-all").disabled=!enabled||!tool.moments.length||!preferredMime();
  }
  function loadFile(file,autoScan=true){
    if(tool.recording||tool.scanning){out("Espera a que termine el proceso actual.","error");return false;}
    if(!(file.type.startsWith("video/")||/\.(mp4|mov|webm|m4v)$/i.test(file.name))){out("Selecciona un archivo de video válido.","error");return;}
    if(file.size>850*1024*1024){out("Este editor admite archivos de hasta 850 MB. Usa un video más corto.","error");return;}
    video.pause();
    if(tool.url)URL.revokeObjectURL(tool.url);
    tool.url=URL.createObjectURL(file);tool.file=file;tool.duration=0;tool.moments=[];tool.needsScan=autoScan;
    $("forge-file-name").textContent=file.name;
    $("forge-remote-preview").hidden=true;$("forge-remote-frame").removeAttribute("src");
    $("forge-empty").hidden=true;controls(false);
    $("forge-moments").innerHTML='<p class="studio-note">Pulsa «Detectar momentos» o ajusta los segundos manualmente.</p>';
    $("forge-download-ready").hidden=true;
    video.src=tool.url;video.load();
    out("Preparando tu video…");
    return true;
  }
  $("forge-file").addEventListener("change",e=>{
    const file=e.target.files?.[0];if(!file)return;
    if(tool.loading&&tool.abort){tool.abort.abort();tool.loading=false;}
    loadFile(file);
    e.target.value="";
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
      const s=tool.exportRange||selection();$("forge-export-bar").style.width=`${Math.min(100,Math.max(0,(video.currentTime-s.start)/(s.end-s.start)*100))}%`;
      if(video.currentTime>=s.end-.045)stopRecording();
    }
    updateClock();
  });
  video.addEventListener("pause",updateClock);video.addEventListener("play",frameLoop);
  video.addEventListener("seeked",draw);video.addEventListener("loadeddata",draw);
  video.addEventListener("canplay",()=>{
    if(tool.needsScan&&tool.duration&&!tool.scanning){
      tool.needsScan=false;
      requestAnimationFrame(()=>{if(tool.file&&!tool.scanning&&!tool.recording)$("forge-analyze").click();});
    }
  });
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
      const length=Math.min(seconds,Number($("forge-job-length").value)||30);
      const ranked=rows.slice(1).sort((a,b)=>b.score-a.score);const selected=[];
      for(const r of ranked){
        const start=clamp(r.t-4,0,Math.max(0,seconds-length));
        if(selected.some(x=>Math.abs(x.start-start)<length*.8))continue;
        selected.push({start,end:Math.min(tool.duration,start+length),score:r.score});
        if(selected.length===5)break;
      }
      if(!selected.length)selected.push({start:0,end:Math.min(seconds,30),score:0});
      tool.moments=selected;
      const maxScore=Math.max(1,...selected.map(x=>x.score));
      $("forge-moments").innerHTML=selected.map((m,i)=>{
        const confidence=Math.round(m.score/maxScore*100);
        return `<div class="forge-moment"><div><b>✦ Momento ${i+1} · ${clock(m.start)}–${clock(m.end)}</b><small>Movimiento o cambio visual · intensidad relativa ${confidence}%</small></div><button class="btn" type="button" data-moment="${i}">Usar corte</button></div>`;
      }).join("");
      $("forge-moments").querySelectorAll("[data-moment]").forEach(b=>b.addEventListener("click",()=>{const m=selected[Number(b.dataset.moment)];setSelection(m.start,m.end);out(`Momento ${Number(b.dataset.moment)+1} seleccionado. Puedes ajustar el principio y final.`,"success");}));
      $("forge-scan-label").textContent=`${selected.length} sugerencias listas`;
      out("Sugerencias visuales listas. Los clips con mejores escenas no siempre son los más interesantes por su diálogo.","success");
    }catch(err){tool.moments=[];out("No se pudo analizar este video. Puedes editarlo manualmente.","error");$("forge-scan-label").textContent="Análisis no disponible";}
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
        const ext=mime.includes("mp4")?"mp4":"webm";
        const name=(tool.file.name.replace(/\.[^.]+$/,"").replace(/[^a-zA-Z0-9_-]/g,"_").slice(0,55)||"gta6");
        showDownload(blob,`${name}_clip_${Math.round(s.start)}s.${ext}`);
        out(`Clip listo en ${ext.toUpperCase()} (${(blob.size/1048576).toFixed(1)} MB). Pulsa «Descargar» abajo.`,"success");
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

  // Descarga explícita compatible con iPhone (Safari puede bloquear clics automáticos tardíos).
  function showDownload(blob,name){
    if(tool.lastDownload)URL.revokeObjectURL(tool.lastDownload);
    tool.lastDownload=URL.createObjectURL(blob);
    const a=$("forge-download-link");a.href=tool.lastDownload;a.download=name;
    a.textContent=`⬇ Descargar ${name}`;
    $("forge-download-ready").hidden=false;
  }
  function crc32(data){
    let c=-1;
    for(const b of data){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^(c&1?0xedb88320:0);}
    return (c^-1)>>>0;
  }
  async function zipClips(files){
    const enc=new TextEncoder(),entries=[],directory=[];
    let offset=0,dirSize=0;
    const now=new Date(),date=((Math.max(1980,now.getFullYear())-1980)<<9)|((now.getMonth()+1)<<5)|now.getDate();
    const time=(now.getHours()<<11)|(now.getMinutes()<<5)|(now.getSeconds()>>1);
    for(const file of files){
      const name=enc.encode(file.name),bytes=new Uint8Array(await file.blob.arrayBuffer());
      const size=bytes.byteLength,crc=crc32(bytes);
      const local=new Uint8Array(30+name.length),a=new DataView(local.buffer);
      a.setUint32(0,0x04034b50,true);a.setUint16(4,20,true);a.setUint16(10,time,true);a.setUint16(12,date,true);a.setUint32(14,crc,true);a.setUint32(18,size,true);a.setUint32(22,size,true);a.setUint16(26,name.length,true);local.set(name,30);
      const central=new Uint8Array(46+name.length),b=new DataView(central.buffer);
      b.setUint32(0,0x02014b50,true);b.setUint16(4,20,true);b.setUint16(6,20,true);b.setUint16(12,time,true);b.setUint16(14,date,true);b.setUint32(16,crc,true);b.setUint32(20,size,true);b.setUint32(24,size,true);b.setUint16(28,name.length,true);b.setUint32(42,offset,true);central.set(name,46);
      entries.push(local,file.blob);directory.push(central);offset+=local.length+size;dirSize+=central.length;
    }
    const footer=new Uint8Array(22),z=new DataView(footer.buffer);
    z.setUint32(0,0x06054b50,true);z.setUint16(8,files.length,true);z.setUint16(10,files.length,true);z.setUint32(12,dirSize,true);z.setUint32(16,offset,true);
    return new Blob([...entries,...directory,footer],{type:"application/zip"});
  }
  async function recordMoment(m){
    let stream=null,target=null,recorder=null;
    const pieces=[];
    tool.recording=true;tool.exportRange=m;
    try{
      video.pause();await seekVideo(m.start);draw();
      if(tool.cancelled)throw new Error("Cancelado");
      const capture=canvas.captureStream(30);
      target=await audioGraph().catch(()=>null);
      stream=new MediaStream([...capture.getVideoTracks(),...(target?.stream.getAudioTracks()||[])]);
      recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:2500000});tool.recorder=recorder;
      recorder.addEventListener("dataavailable",e=>{if(e.data.size)pieces.push(e.data);});
      const finished=new Promise((resolve,reject)=>{
        recorder.addEventListener("stop",resolve,{once:true});
        recorder.addEventListener("error",()=>reject(new Error("Fallo de grabación")),{once:true});
      });
      recorder.start(250);frameLoop();
      await video.play();
      await finished;
      if(tool.cancelled)throw new Error("Cancelado");
      const blob=new Blob(pieces,{type:mime});
      if(blob.size<1024)throw new Error("El archivo quedó vacío");
      return blob;
    }finally{
      if(recorder?.state==="recording")recorder.stop();
      video.pause();
      if(target)try{tool.audioSource?.disconnect(target);}catch(_){}
      if(stream)for(const t of stream.getTracks())t.stop();
      tool.recorder=null;tool.recording=false;tool.exportRange=null;
    }
  }
  $("forge-export-all").addEventListener("click",async()=>{
    if(!tool.file||tool.recording||tool.scanning)return;
    if(!tool.moments.length){out("Primero detecta los mejores momentos.","error");return;}
    if(!mime||!canvas.captureStream){out("Este navegador no permite exportar video; usa Safari o Chrome actualizado.","error");return;}
    tool.cancelled=false;controls(false);$("forge-export-progress").hidden=false;$("forge-cancel").hidden=false;$("forge-download-ready").hidden=true;
    const ext=mime.includes("mp4")?"mp4":"webm",parts=[],segments=tool.moments.slice(0,5);
    const base=(tool.file.name.replace(/\.[^.]+$/,"").replace(/[^a-zA-Z0-9_-]/g,"_").slice(0,55)||"gta6");
    try{
      for(const [i,m] of segments.entries()){
        if(tool.cancelled)throw new Error("Cancelado");
        $("forge-export-bar").style.width="0%";
        out(`Grabando clip ${i+1} de ${segments.length} (${(m.end-m.start).toFixed(0)} s). Mantén la página abierta…`);
        const blob=await recordMoment(m);
        parts.push({name:`${base}_clip_${i+1}.${ext}`,blob});
      }
      const timings=segments.map((m,i)=>`Clip ${i+1}: ${m.start.toFixed(1)}s a ${m.end.toFixed(1)}s`).join("\n");
      parts.push({name:"recortes.txt",blob:new Blob([timings],{type:"text/plain"})});
      out("Preparando ZIP con los clips…");
      const zip=await zipClips(parts);
      if(tool.cancelled)throw new Error("Cancelado");
      showDownload(zip,`${base}_${segments.length}_clips.zip`);
      out(`${segments.length} clips listos en ZIP (${(zip.size/1048576).toFixed(1)} MB). Pulsa Descargar.`,"success");
    }catch(err){out(tool.cancelled?"Exportación cancelada.":`No se pudo preparar el ZIP (${err.message}). Prueba un video MP4 compatible.`,"error");}
    finally{controls(true);$("forge-export-progress").hidden=true;$("forge-cancel").hidden=true;}
  });

  // Los enlaces de plataformas solo se muestran en sus reproductores oficiales.
  // Un iframe no entrega el video como archivo: nunca simulamos que puede exportarse.
  function embedsFrom(parsed){
    const host=parsed.hostname.toLowerCase().replace(/\.$/,"");
    const domain=d=>host===d||host.endsWith("."+d);
    const p=parsed.pathname;
    if(domain("youtube.com")||domain("youtu.be")){
      const id=domain("youtu.be")?p.split("/")[1]:p.match(/^\/(?:shorts|embed|live)\/([a-zA-Z0-9_-]{11})/)?.[1]||parsed.searchParams.get("v");
      if(!/^[a-zA-Z0-9_-]{11}$/.test(id||""))return {error:"Este enlace no identifica un video de YouTube reproducible. Usa su URL normal."};
      return {name:"YouTube",url:`https://www.youtube-nocookie.com/embed/${id}`};
    }
    if(domain("vimeo.com")){
      const id=p.match(/\/(\d+)(?:\/|$)/)?.[1];
      if(id)return {name:"Vimeo",url:`https://player.vimeo.com/video/${id}`};
    }
    if(domain("tiktok.com")){
      const id=p.match(/\/video\/(\d+)/)?.[1];
      if(id)return {name:"TikTok",url:`https://www.tiktok.com/embed/v2/${id}`,vertical:true};
    }
    if(domain("instagram.com")){
      const id=p.match(/^\/(?:reel|reels|p)\/([a-zA-Z0-9_-]+)/)?.[1];
      if(id)return {name:"Instagram",url:`https://www.instagram.com/reel/${id}/embed/`,vertical:true};
    }
    if(domain("dailymotion.com")||domain("dai.ly")){
      const id=domain("dai.ly")?p.split("/")[1]:p.match(/\/video\/([a-zA-Z0-9]+)/)?.[1];
      if(id&&/^[a-zA-Z0-9]+$/.test(id))return {name:"Dailymotion",url:`https://www.dailymotion.com/embed/video/${id}`};
    }
    if(domain("twitch.tv")){
      const clip=host==="clips.twitch.tv"?p.split("/")[1]:p.match(/\/clip\/([a-zA-Z0-9_-]+)/)?.[1];
      if(clip&&/^[a-zA-Z0-9_-]+$/.test(clip))return {name:"Twitch",url:`https://clips.twitch.tv/embed?clip=${clip}&parent=abcden.github.io`};
      const vod=p.match(/^\/videos\/(\d+)/)?.[1];
      if(vod)return {name:"Twitch",url:`https://player.twitch.tv/?video=v${vod}&parent=abcden.github.io&autoplay=false`};
    }
    if(domain("kick.com"))return {error:"Kick no facilita aquí un archivo directo. Guarda tu video autorizado y súbelo desde tu dispositivo para editarlo gratis."};
    return null;
  }
  function showRemotePreview(embed){
    const panel=$("forge-remote-preview"),frame=$("forge-remote-frame");
    frame.src=embed.url;
    $("forge-remote-label").textContent=`▶ Ver video de ${embed.name} sin salir`;
    panel.classList.toggle("vertical",!!embed.vertical);
    panel.hidden=false;
    panel.scrollIntoView({behavior:"smooth",block:"nearest"});
  }
  const MAX_REMOTE=350*1024*1024;
  $("forge-url-cancel").addEventListener("click",()=>tool.abort?.abort());
  $("forge-process").addEventListener("click",async()=>{
    const status=$("forge-url-status"),raw=$("forge-url").value.trim();
    if(tool.loading){status.textContent="Ya estoy cargando un video. Espera o cancela la descarga.";return;}
    if(tool.recording||tool.scanning){status.textContent="Espera a que finalice el análisis o la exportación.";return;}
    let parsed;
    try{parsed=new URL(raw);}catch(_){status.textContent="Pega un enlace HTTPS válido o pulsa «Elegir video de mi dispositivo».";return;}
    if(parsed.protocol!=="https:"||parsed.username||parsed.password||parsed.port||raw.length>500){status.textContent="Por seguridad, usa una URL HTTPS normal sin contraseñas ni puertos especiales.";return;}
    if(!$("forge-authorized").checked){status.textContent="Marca la casilla para confirmar que tienes permiso para reutilizar este video.";return;}
    const direct=/\.(mp4|webm|mov|m4v|ogv)$/i.test(parsed.pathname);
    const embed=direct?null:embedsFrom(parsed);
    if(embed){
      if(embed.error){status.textContent=embed.error;return;}
      showRemotePreview(embed);
      status.textContent=`${embed.name} se reproduce aquí mismo. Para generar MP4 editables desde este video necesitas cargar su archivo original autorizado. El reproductor no permite extraerlo.`;
      return;
    }
    if(!direct){status.textContent="El enlace no apunta a un MP4/WebM directo compatible. Si es tu video, guarda el archivo original y usa «Elegir video de mi dispositivo».";return;}
    const abort=new AbortController();tool.abort=abort;tool.loading=true;
    $("forge-process").disabled=true;$("forge-url-cancel").hidden=false;$("forge-url-progress").hidden=false;$("forge-url-bar").style.width="3%";
    try{
      status.textContent="Conectando con el archivo… No cierres esta pestaña.";
      const r=await fetch(parsed.href,{signal:abort.signal,credentials:"omit",mode:"cors",cache:"no-store"});
      if(!r.ok)throw new Error(`El servidor respondió ${r.status}.`);
      const size=Number(r.headers.get("content-length"))||0;
      if(size>MAX_REMOTE)throw new Error("El archivo supera 350 MB. Guárdalo primero y selecciónalo desde tu dispositivo.");
      const type=(r.headers.get("content-type")||"").split(";")[0].trim().toLowerCase();
      if(type&&!type.startsWith("video/")&&!/^(application\/octet-stream|binary\/octet-stream)$/.test(type))throw new Error("La URL devolvió una página o un archivo que no es video.");
      const parts=[];let read=0;
      if(r.body?.getReader){
        const reader=r.body.getReader();
        while(true){
          const {done,value}=await reader.read();if(done)break;
          read+=value.byteLength;if(read>MAX_REMOTE){await reader.cancel();throw new Error("El archivo supera el límite de 350 MB.");}
          parts.push(value);
          if(size)$("forge-url-bar").style.width=Math.min(100,Math.round(read/size*100))+"%";
          status.textContent=`Importando video directamente aquí: ${(read/1048576).toFixed(1)} MB${size?" de "+(size/1048576).toFixed(1)+" MB":""}…`;
        }
      }else{
        const b=await r.blob();read=b.size;if(read>MAX_REMOTE)throw new Error("El archivo supera 350 MB.");parts.push(b);
      }
      if(read<1024)throw new Error("El archivo está vacío o es incompatible.");
      const ext=parsed.pathname.match(/\.(mp4|webm|mov|m4v|ogv)$/i)?.[1].toLowerCase()||"mp4";
      const file=new File(parts,`video_importado.${ext}`,{type:type||({mp4:"video/mp4",webm:"video/webm",mov:"video/quicktime"}[ext]||"video/mp4")});
      if(loadFile(file)){status.textContent="Video importado en esta página. Detectando momentos automáticamente…";}
    }catch(err){
      status.textContent=err.name==="AbortError"?"Importación cancelada.":`No se pudo importar: ${err.message?.includes("fetch")?"el servidor bloquea el acceso desde otros sitios (CORS)":err.message}. Si es tu video, súbelo directamente desde Archivos.`;
    }finally{tool.loading=false;tool.abort=null;$("forge-process").disabled=false;$("forge-url-cancel").hidden=true;$("forge-url-progress").hidden=true;}
  });
  setFormat();
  window.addEventListener("pagehide",()=>{if(tool.url)URL.revokeObjectURL(tool.url);if(tool.lastDownload)URL.revokeObjectURL(tool.lastDownload);});
})();
