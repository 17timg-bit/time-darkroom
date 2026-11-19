const FieldDesk = (() => {
  const $ = id => document.getElementById(id);
  const desk=$("field-desk"), gallery=$("field-frames"), alignment=$("align-canvas");
  const tabs=[$("local-tab"),$("world-tab")];
  const draft={title:"",rows:[],mix:"blend",light:Field.lightHours()};
  let selected, busy=false, drawing=0, drag=null, onExpose;
  const current = () => draft.rows.find(row=>row.id===selected) || draft.rows[0];
  const bounds = value => Math.max(-1,Math.min(1,value));
  const status = message => { $("reel-status").textContent=message; };
  function persist() {
    Field.save("draft",draft).catch(()=>status("当前浏览器无法记住胶卷，本次打开期间仍可使用。"));
  }
  function selectTab(index,focus=false) {
    tabs.forEach((tab,i)=>{
      tab.setAttribute("aria-selected",i===index);
      tab.tabIndex=i===index?0:-1;
      $(tab.getAttribute("aria-controls")).hidden=i!==index;
    });
    if(focus) tabs[index].focus();
    desk.querySelector(".desk-body").scrollTop=0;
    if(index===0) drawAlignment();
  }
  tabs.forEach((tab,i)=>{
    tab.addEventListener("click",()=>selectTab(i));
    tab.addEventListener("keydown",event=>{
      if(!["ArrowLeft","ArrowRight","Home","End"].includes(event.key)) return;
      event.preventDefault();
      selectTab(event.key==="Home"?0:event.key==="End"?1:1-i,true);
    });
  });

  function updateStatus() {
    const arrange=Field.arrange(draft.rows);
    $("frame-count").textContent=`${draft.rows.length} / ${Field.maxFrames}`;
    $("local-photo").disabled=busy||draft.rows.length>=Field.maxFrames;
    $("expose-reel").disabled=busy||Boolean(arrange.error);
    $("field-mix").disabled=draft.rows.length<2;
    $("field-lighting").hidden=draft.rows.length!==1;
    $("field-dawn").disabled=$("field-dusk").disabled=busy;
    $("reel-window").textContent=arrange.items
      ? Field.caption(arrange.items.map(item=>item.minute)) : draft.rows.length?arrange.error:"";
    if(draft.rows.length===1&&draft.rows[0].minute===null) $("reel-window").textContent+=" · 原片锚点 12:00";
  }
  async function drawAlignment() {
    const seq=++drawing, row=current(), reference=draft.rows[0], g=alignment.getContext("2d");
    const w=alignment.width,h=alignment.height;
    $("field-zoom").value=Math.round((row?.zoom||1)*100);
    $("field-zoom").disabled=$("align-reset").disabled=!row;
    $("ghost").disabled=!row||row===reference;
    g.clearRect(0,0,w,h);
    if(!row) {
      g.fillStyle="#847062";
      g.font="18px sans-serif";
      g.textAlign="center";
      g.fillText("等一张景片入镜",w/2,h/2);
      return;
    }
    const compare=$("ghost").checked&&reference!==row;
    let image, first;
    try {
      [image,first]=await Promise.all([Field.photoImage(row),compare&&Field.photoImage(reference)]);
    } catch {
      if(seq===drawing) status("这张原片无法读取，可移除后重新导入。");
      return;
    }
    if(seq!==drawing) return;
    Field.paint(g,image,row,w,h);
    if(first){
      g.globalAlpha=.46;
      Field.paint(g,first,reference,w,h);
      g.globalAlpha=1;
    }
    g.strokeStyle="#fff2d18c";
    g.lineWidth=1;
    g.beginPath();
    g.moveTo(w/2-12,h/2);
    g.lineTo(w/2+12,h/2);
    g.moveTo(w/2,h/2-12);
    g.lineTo(w/2,h/2+12);
    g.stroke();
    $("align-hint").textContent=compare
      ?"拖动使固定地物重合。参考图为胶卷中的第一张。"
      :"拖动改变裁切。放大可增加平移余量。";
  }

  function rows() {
    const active=current();
    selected=active?.id;
    const elements=draft.rows.map((row,i)=>{
      const wrapper=document.createElement("div");
      wrapper.className="reel-row";
      const pick=document.createElement("button");
      pick.type="button";
      pick.className="frame-pick";
      pick.setAttribute("aria-pressed",row===active);
      pick.title=row.name;
      const thumb=document.createElement("canvas");
      thumb.width=96;
      thumb.height=60;
      thumb.setAttribute("aria-hidden","true");
      Field.photoImage(row).then(image=>Field.paint(thumb.getContext("2d"),image,row,96,60)).catch(()=>{});
      const filename=document.createElement("span");
      filename.textContent=row.name;
      pick.append(thumb,filename);
      pick.addEventListener("click",()=>{
        selected=row.id;
        for(const button of gallery.querySelectorAll(".frame-pick")) button.setAttribute("aria-pressed",button===pick);
        drawAlignment();
      });
      const time=document.createElement("input");
      time.type="time";
      time.value=Field.formatTime(row.minute);
      time.setAttribute("aria-label",`第 ${i+1} 张照片的拍摄时刻`);
      time.addEventListener("change",()=>{
        row.minute=Field.parseTime(time.value);
        persist();
        updateStatus();
      });
      const remove=document.createElement("button");
      remove.type="button";
      remove.className="quiet skin-remove";
      remove.textContent="×";
      remove.setAttribute("aria-label",`从胶卷移除第 ${i+1} 张照片`);
      remove.addEventListener("click",()=>{
        if(busy) return;
        draft.rows=draft.rows.filter(item=>item!==row);
        rows();
        persist();
        (gallery.querySelector(".frame-pick")||$("local-photo")).focus({preventScroll:true});
      });
      wrapper.append(pick,time,remove);
      if(row.source){
        const link=sourceLink(row.source,`${row.source.by||"Commons"} · ${row.source.license} ↗`);
        link.className="frame-credit";
        wrapper.append(link);
      }
      return wrapper;
    });
    gallery.replaceChildren(...elements);
    updateStatus();
    drawAlignment();
  }
  async function addFiles(files) {
    if(busy) return;
    const slots=Field.maxFrames-draft.rows.length;
    if(!slots) {status("这卷已满，请先移除一张。");return;}
    busy=true;
    updateStatus();
    status("正在装入照片…");
    let failures=0;
    for(const file of files.slice(0,slots)) {
      try {
        const row=await Field.normalize(file,file.name);
        draft.rows.push(row);
        selected=row.id;
      } catch { failures++; }
    }
    busy=false;
    rows();
    persist();
    if(failures) status(`有 ${failures} 张无法读取。支持 JPG、PNG、WebP、AVIF，每张最多 25 MB。`);
    else if(files.length>slots) status("这卷最多收 6 张，已装入剩余空位。");
    else status("原片留在当前浏览器。给每张照片标上时刻。");
  }

  $("local-photo").addEventListener("change",event=>{
    const files=[...event.target.files];
    event.target.value="";
    if(files.length) addFiles(files);
  });
  const drop=$("photo-drop");
  drop.addEventListener("dragover",event=>{
    event.preventDefault();
    drop.classList.add("drag-over");
  });
  drop.addEventListener("dragleave",()=>drop.classList.remove("drag-over"));
  drop.addEventListener("drop",event=>{
    event.preventDefault();
    drop.classList.remove("drag-over");
    const files=[...event.dataTransfer.files];
    if(files.length) addFiles(files);
  });
  $("reel-title").addEventListener("input",event=>{draft.title=event.target.value;});
  $("reel-title").addEventListener("change",persist);
  $("field-mix").addEventListener("change",event=>{draft.mix=event.target.value;persist();});
  const lightTimes = [$("field-dawn"), $("field-dusk")];
  for (const input of lightTimes) {
    input.addEventListener("change", () => {
      const light = lightTimes.map(control => Field.parseTime(control.value));
      if (!Field.validLight(light)) {
        lightTimes.forEach((control, i) => { control.value = Field.formatTime(draft.light[i]); });
        status("请填写两个不同的日出和日落时刻。");
        return;
      }
      draft.light = light;
      status("已设置当地晨昏时刻。");
      persist();
    });
  }
  $("ghost").addEventListener("change",drawAlignment);
  $("field-zoom").addEventListener("input",event=>{
    const row=current();
    if(row){row.zoom=Number(event.target.value)/100;drawAlignment();}
  });
  $("field-zoom").addEventListener("change",persist);
  $("align-reset").addEventListener("click",()=>{
    const row=current();
    if(row){row.x=row.y=0;row.zoom=1;drawAlignment();persist();}
  });
  alignment.addEventListener("pointerdown",async event=>{
    const row=current();
    if(!row||event.button!==0) return;
    alignment.setPointerCapture(event.pointerId);
    const image=await Field.photoImage(row);
    if(!alignment.hasPointerCapture(event.pointerId)) return;
    const [, ,w,h]=Field.framing(image,row,alignment.width,alignment.height);
    const box=alignment.getBoundingClientRect();
    drag={row,startX:event.clientX,startY:event.clientY,x:row.x,y:row.y,
      scaleX:2*alignment.width/(box.width*Math.min(-1,alignment.width-w)),
      scaleY:2*alignment.height/(box.height*Math.min(-1,alignment.height-h))};
    if(w-alignment.width<2) drag.scaleX=0;
    if(h-alignment.height<2) drag.scaleY=0;
  });
  alignment.addEventListener("pointermove",event=>{
    if(!drag||!alignment.hasPointerCapture(event.pointerId)) return;
    drag.row.x=bounds(drag.x+(event.clientX-drag.startX)*drag.scaleX);
    drag.row.y=bounds(drag.y+(event.clientY-drag.startY)*drag.scaleY);
    drawAlignment();
  });
  alignment.addEventListener("lostpointercapture",()=>{
    if(!drag) return;
    drag=null;
    persist();
  });
  alignment.addEventListener("keydown",event=>{
    const moves={ArrowLeft:[.06,0],ArrowRight:[-.06,0],ArrowUp:[0,.06],ArrowDown:[0,-.06]};
    const row=current(), step=moves[event.key];
    if(!row||!step) return;
    event.preventDefault();
    row.x=bounds(row.x+step[0]);row.y=bounds(row.y+step[1]);
    drawAlignment();
    persist();
  });
  $("expose-reel").addEventListener("click",async ()=>{
    if(busy) return;
    busy=true;
    updateStatus();
    status("正在对齐并编排胶卷…");
    try {
      // Snapshot framing/time in case controls change while thumbnails decode.
      const manifest=await Field.compile({...draft,rows:draft.rows.map(row=>({...row}))});
      persist();
      onExpose(manifest);
      desk.close();
      status("胶卷已带入暗房。");
    } catch(error) { status(error.message||"无法显影这卷照片。"); }
    finally { busy=false;updateStatus(); }
  });

  function sourceLink(source, label) {
    const link=document.createElement("a");
    link.href=source.url;
    link.target="_blank";
    link.rel="noopener noreferrer";
    link.textContent=label;
    return link;
  }
  function plain(value) {
    const node=document.createElement("template");
    node.innerHTML=value || "";
    return node.content.textContent.replace(/\s+/g," ").trim();
  }
  function mediaURL(value) {
    try {
      const url=new URL(value);
      if(url.protocol!=="https:"||!["upload.wikimedia.org","thumb.wikimedia.org"].includes(url.hostname)) return "";
      url.search="";
      return url.href;
    } catch { return ""; }
  }
  let queryController;
  const queryForm=$("world-form"), worldNote=$("world-note"), results=$("world-results");
  const worldButton=queryForm.querySelector("button[type=submit]");
  const metaTitle="搜索 Wikimedia Commons 的公开景片。";
  const previews=new Map();
  function resultCard(image,index) {
    const card=document.createElement("article");
    card.className="world-card";
    const frame=document.createElement("div");
    frame.className="world-frame";
    const photo=new Image();
    photo.referrerPolicy="no-referrer";
    photo.loading=index<6?"eager":"lazy";
    photo.decoding="async";
    photo.alt="";
    const fallback=document.createElement("span");
    fallback.textContent="正在接收景片";
    photo.addEventListener("load",()=>{fallback.hidden=true;});
    photo.addEventListener("error",()=>{photo.hidden=true;fallback.textContent="缩略图暂不可用";});
    photo.src=image.thumb;
    frame.append(photo,fallback);
    const title=document.createElement("h3");
    title.textContent=image.source.title;
    title.title=image.source.title;
    const description=document.createElement("p");
    description.textContent=`${image.source.by||"Commons"} · ${image.source.license} · ${image.minute===null?"待标时刻":Field.formatTime(image.minute)}`;
    const actions=document.createElement("div");
    actions.className="world-actions";
    const use=document.createElement("button");
    use.type="button";
    use.className="quiet";
    use.textContent="收入这卷 ＋";
    use.addEventListener("click",async ()=>{
      if(busy) return;
      if(draft.rows.some(row=>row.source?.url===image.source.url)){status("这张景片已经在胶卷里。");return;}
      if(draft.rows.length>=Field.maxFrames){status("这卷已满，请先移除一张。");return;}
      busy=true;
      use.disabled=true;
      updateStatus();
      status("正在从 Commons 取回景片…");
      try {
        let row;
        let larger=image.original;
        if(!larger) {
          try {
            const url=new URL("https://commons.wikimedia.org/w/api.php");
            url.search=new URLSearchParams({action:"query",formatversion:"2",format:"json",origin:"*",
              pageids:String(image.pageId),prop:"imageinfo",iiprop:"url",iiurlwidth:"1280"});
            const response=await fetch(url,{credentials:"omit",referrerPolicy:"no-referrer",signal:AbortSignal.timeout(10000)});
            if(response.ok) {
              const data=await response.json();
              larger=mediaURL(data.query?.pages?.[0]?.imageinfo?.[0]?.thumburl);
            }
          } catch { /* The search thumbnail can also be used as a source. */ }
        }
        for(const url of new Set([larger,image.thumb].filter(Boolean))) {
          try {
            const response=await fetch(url,{referrerPolicy:"no-referrer",credentials:"omit",signal:AbortSignal.timeout(12000)});
            if(!response.ok) continue;
            row=await Field.normalize(await response.blob(),image.source.title,image.source,image.minute);
            break;
          } catch { /* If the original is unavailable, try the listed thumbnail. */ }
        }
        if(!row) throw new Error("Image download failed");
        draft.rows.push(row);
        selected=row.id;
        if(!draft.title && $("world-query").value.trim()) {
          draft.title=$("world-query").value.trim().slice(0,52);
          $("reel-title").value=draft.title;
        }
        use.textContent="已入卷";
        persist();
        status(row.minute===null?"已入卷。到「本地胶卷」标拍摄时刻。":"已入卷。拍摄时刻可在胶卷中修改。");
      } catch {
        status("暂时无法取回景片。可从「来源」下载后导入。");
      } finally {busy=false;use.disabled=false;rows();}
    });
    actions.append(use,sourceLink(image.source,"来源 ↗"));
    card.append(frame,title,description,actions);
    return card;
  }
  async function search(query,light) {
    queryController?.abort();
    const controller=new AbortController();
    queryController=controller;
    const key=`${query}｜${light}`;
    worldButton.disabled=true;
    results.replaceChildren();
    worldNote.textContent="正在寻找有来源的景片…";
    try {
      let photos=previews.get(key);
      if(!photos){
        const url=new URL("https://commons.wikimedia.org/w/api.php");
        const params={action:"query",format:"json",formatversion:"2",origin:"*",generator:"search",
          gsrnamespace:"6",gsrlimit:"16",gsrsearch:[query,light,"filetype:bitmap"].filter(Boolean).join(" "),
          prop:"imageinfo",iiprop:"url|mime|size|extmetadata",iiurlwidth:"480",
          iiextmetadatafilter:"Artist|LicenseShortName|DateTimeOriginal"};
        url.search=new URLSearchParams(params);
        const response=await fetch(url,{credentials:"omit",referrerPolicy:"no-referrer",
          signal:AbortSignal.any([controller.signal,AbortSignal.timeout(16000)])});
        if(!response.ok) throw new Error("Search unavailable");
        const data=await response.json();
        if(data.error) throw new Error("Search unavailable");
        const found=(data.query?.pages||[]).sort((a,b)=>(a.index||0)-(b.index||0)).flatMap(page=>{
          const info=page.imageinfo?.[0], meta=info?.extmetadata||{};
          const title=page.title.replace(/^File:/,"").replace(/\.[^.]+$/,"").replace(/_/g," ");
          const source=Field.credit({title,by:plain(meta.Artist?.value),license:plain(meta.LicenseShortName?.value),url:info?.descriptionurl});
          const thumb=mediaURL(info?.thumburl||info?.url);
          if(!source||!thumb||!['image/jpeg','image/png','image/webp','image/avif'].includes(info.mime)) return [];
          const original=info.width<=2400&&info.size<=12*1024*1024?mediaURL(info.url):"";
          return [{source,thumb,original,pageId:page.pageid,minute:Field.parseTime(plain(meta.DateTimeOriginal?.value))}];
        });
        const groups=new Set(), alternates=[];
        photos=found.filter(image=>{
          const family=image.source.title.toLowerCase().replace(/\s*[-–]\s*\d{3,}$/,"");
          if(groups.has(family)){alternates.push(image);return false;}
          groups.add(family);return true;
        }).concat(alternates).slice(0,12);
        if(previews.size>=14)previews.delete(previews.keys().next().value);
        previews.set(key,photos);
      }
      if(controller.signal.aborted) return;
      results.replaceChildren(...photos.map(resultCard));
      worldNote.textContent=photos.length
        ? `找到 ${photos.length} 张。光线用于筛选，拍摄时刻以原片记录为准。`
        : "这一卷没找到可用景片，试试外文地名或换一种光线。";
    } catch {
      if(!controller.signal.aborted) worldNote.textContent="Commons 暂未返回结果。联网后可重试，也可直接导入本地照片。";
    } finally {
      if(queryController===controller) worldButton.disabled=false;
    }
  }
  queryForm.addEventListener("submit",event=>{
    event.preventDefault();
    const query=$("world-query").value.trim();
    if(query) search(query,$("world-light").value);
  });
  for(const button of desk.querySelectorAll("[data-route]")) button.addEventListener("click",()=>{
    $("world-query").value=button.dataset.route;
    $("world-light").value=button.dataset.light;
    search(button.dataset.route,button.dataset.light);
  });
  desk.addEventListener("close",()=>{
    queryController?.abort();
    worldButton.disabled=false;
    if(!results.children.length)worldNote.textContent=metaTitle;
  });

  async function mount(callback) {
    onExpose=callback;
    function open() {
      if(!desk.open) desk.showModal();
      rows();
    }
    function deepLink() {
      if(!["#field","#world"].includes(location.hash)) return;
      open();
      selectTab(location.hash==="#world"?1:0);
    }
    $("field-open").addEventListener("click",open);
    $("field-info").addEventListener("click",open);
    addEventListener("hashchange",deepLink);
    deepLink();
    try {
      const value=await Field.load("draft");
      if(value&&Array.isArray(value.rows)&&!draft.rows.length) {
        draft.rows=value.rows.filter(row=>row?.blob instanceof Blob&&typeof row.name==="string").slice(0,Field.maxFrames);
        draft.title=typeof value.title==="string"?value.title.slice(0,52):"";
        draft.mix=value.mix==="cut"?"cut":"blend";
        draft.light=Field.lightHours(value.light);
        lightTimes.forEach((control, i) => { control.value = Field.formatTime(draft.light[i]); });
        $("reel-title").value=draft.title;
        desk.querySelector('[name="field-mix"][value="'+draft.mix+'"]').checked=true;
      }
    } catch { status("原片只在本次打开期间可用。"); }
    rows();
  }
  return {mount};
})();
