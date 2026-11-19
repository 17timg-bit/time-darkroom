/* Personal reels stay in this browser. A saved print points to its immutable contact sheet. */
const Field = (() => {
  const maxFrames = 6, tileWidth = 1200, tileHeight = 675, day = 1440;
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const id = () => `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,11)}`;
  const parseTime = (text = "") => {
    const time = /(?:^|[T\s])([01]\d|2[0-3]):([0-5]\d)\b/.exec(text);
    return time ? Number(time[1]) * 60 + Number(time[2]) : null;
  };
  const formatTime = minute => Number.isFinite(minute) ? Optics.clock(minute) : "";
  const validMinute = value => Number.isInteger(value) && value >= 0 && value < day;
  const text = (value, length) => typeof value === "string" ? value.trim().slice(0, length) : "";
  const commonsURL = value => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname === "commons.wikimedia.org" &&
        url.pathname.startsWith("/wiki/File:") ? url.href : "";
    } catch { return ""; }
  };
  const licenses = new Map([
    ["CC0", "https://creativecommons.org/publicdomain/zero/1.0/"],
    ["Public domain", "https://creativecommons.org/publicdomain/mark/1.0/"],
    ...["2.0","2.5","3.0","4.0"].map(version => [`CC BY ${version}`, `https://creativecommons.org/licenses/by/${version}/`]),
    ["CC BY-SA 4.0", "https://creativecommons.org/licenses/by-sa/4.0/"]
  ]);
  function credit(raw) {
    const title = text(raw?.title, 240), by = text(raw?.by, 140), license = raw?.license;
    const url = commonsURL(raw?.url), terms = licenses.get(license);
    if (!title || !url || !terms || (!by && license.startsWith("CC BY"))) return null;
    return {title, by, license, url, terms};
  }

  function validate(value) {
    if (!value || !/^f-[a-z0-9-]{7,42}$/.test(value.id) || !Array.isArray(value.times) ||
        value.times.length < 1 || value.times.length > maxFrames || !["blend","cut"].includes(value.mix) ||
        !value.times.every((minute, i, list) => Number.isInteger(minute) && minute >= 0 && minute < day*2 &&
          (i===0 ? minute < day : minute > list[i-1] && minute < list[0]+day))) return null;
    const credits = Array.isArray(value.credits) ? value.credits.map(credit).filter(Boolean).slice(0,maxFrames) : [];
    return {id:value.id,title:text(value.title,52) || "自带景片", times:[...value.times], mix:value.mix, credits};
  }

  function arrange(rows) {
    if (!rows.length) return {error:"先加入一张照片。"};
    if (rows.length === 1) return {items:[{row:rows[0], minute:rows[0].minute ?? 720}]};
    if (!rows.every(row => validMinute(row.minute))) return {error:"为每张原片填写拍摄时刻。"};
    if (new Set(rows.map(row => row.minute)).size !== rows.length) return {error:"每张原片需要一个不同的拍摄时刻。"};
    const sorted = [...rows].sort((a,b)=>a.minute-b.minute);
    let largestGap = -1, start = 0;
    // The largest unsampled gap is outside the bounded exposure window.
    for (let i=0; i<sorted.length; i++) {
      const next = (i+1)%sorted.length;
      const gap = sorted[next].minute - sorted[i].minute + (next===0 ? day : 0);
      if (gap >= largestGap) { largestGap = gap; start = next; }
    }
    const ordered = [...sorted.slice(start),...sorted.slice(0,start)];
    return {items:ordered.map(row => ({row, minute:row.minute+(row.minute<ordered[0].minute?day:0)}))};
  }

  let dbPromise;
  function database() {
    if (!dbPromise) dbPromise = new Promise((resolve,reject) => {
      const open = indexedDB.open("time-darkroom-reels",1);
      open.onupgradeneeded = () => open.result.createObjectStore("reels");
      open.onsuccess = () => resolve(open.result);
      open.onerror = open.onblocked = () => reject(new Error("Private storage unavailable"));
    });
    return dbPromise;
  }
  async function record(key, mode, operation) {
    const db = await database();
    return new Promise((resolve,reject) => {
      const tx = db.transaction("reels",mode), req = operation(tx.objectStore("reels"), key);
      tx.oncomplete = () => resolve(req.result);
      tx.onabort = tx.onerror = () => reject(tx.error || new Error("Private storage transaction failed"));
    });
  }
  const load = key => record(key,"readonly",(store,k)=>store.get(k));
  const save = (key,value) => record(key,"readwrite",(store,k)=>store.put(value,k));

  function decode(blob) {
    const url = URL.createObjectURL(blob);
    return Optics.loadImage(url).finally(() => URL.revokeObjectURL(url));
  }
  const toJpeg = (canvas,quality) => new Promise((resolve,reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Unable to encode photo")), "image/jpeg", quality);
  });
  const photoImages = new WeakMap();
  const photoImage = row => {
    if (!photoImages.has(row)) photoImages.set(row,decode(row.blob));
    return photoImages.get(row);
  };
  async function shootingTime(file) {
    // Read DateTimeOriginal in JPEG EXIF. Generic file modification dates are not shooting times.
    const d = new DataView(await file.slice(0,262144).arrayBuffer());
    try {
      if (d.getUint16(0) !== 0xffd8) return null;
      for (let pos=2; pos+10<d.byteLength;) {
        const marker=d.getUint16(pos), length=d.getUint16(pos+2);
        if (length<2 || marker===0xffda || (marker&0xff00)!==0xff00) break;
        const end=pos+length+2;
        if (marker===0xffe1 && end<=d.byteLength && d.getUint32(pos+4)===0x45786966) {
          const base=pos+10, order=d.getUint16(base), le=order===0x4949;
          if (!le&&order!==0x4d4d || d.getUint16(base+2,le)!==42) return null;
          const tag = (pointer,key) => {
            if (pointer<base || pointer+2>end) return null;
            const n=d.getUint16(pointer,le);
            if (pointer+2+n*12>end) return null;
            for(let i=0;i<n;i++){
              const t=pointer+2+i*12;
              if(d.getUint16(t,le)===key) return t;
            }
            return null;
          };
          const link=tag(base+d.getUint32(base+4,le),0x8769);
          if(link===null) return null;
          const date=tag(base+d.getUint32(link+8,le),0x9003);
          if(date===null||d.getUint16(date+2,le)!==2||d.getUint32(date+4,le)<19) return null;
          const start=base+d.getUint32(date+8,le);
          if(start<base||start+19>end) return null;
          return parseTime(new TextDecoder().decode(new Uint8Array(d.buffer,start,19)));
        }
        pos=end;
      }
    } catch { return null; }
    return null;
  }

  async function normalize(blob,name,source,minute) {
    if (!blob.size || blob.size > 25*1024*1024) throw new Error("请选择不超过 25 MB 的原片。");
    if (blob.type && !["image/jpeg","image/png","image/webp","image/avif"].includes(blob.type)) {
      throw new Error("请选择 JPG、PNG、WebP 或 AVIF。");
    }
    const image = await decode(blob);
    const scale = Math.min(1,1800/Math.max(image.width,image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1,Math.round(image.width*scale));
    canvas.height = Math.max(1,Math.round(image.height*scale));
    const context = canvas.getContext("2d");
    context.fillStyle = "#151411";
    context.fillRect(0,0,canvas.width,canvas.height);
    context.drawImage(image,0,0,canvas.width,canvas.height);
    return {id:id(),name:text(name,150)||"照片",blob:await toJpeg(canvas,.92),
      minute:minute ?? await shootingTime(blob),x:0,y:0,zoom:1,source:credit(source)};
  }

  function framing(image,row,w,h) {
    const scale = Math.max(w/image.width,h/image.height)*row.zoom;
    const width=image.width*scale,height=image.height*scale;
    return [(w-width)*(.5+.5*row.x),(h-height)*(.5+.5*row.y),width,height];
  }
  function paint(context,image,row,w,h) {
    context.drawImage(image,...framing(image,row,w,h));
  }

  // At most three decoded reels are retained, including the active canvas reel.
  const ready = new Map();
  const pending = new Map();
  const session = new Map();
  let pinned;
  function remember(key,value) {
    ready.delete(key);
    ready.set(key,value);
    for(const id of ready.keys()){
      if(ready.size<=3) break;
      if(id!==pinned) ready.delete(id);
    }
    return value;
  }
  const get = key => ready.get(key)?.image;
  const select = manifest => { pinned=manifest?.id; };
  async function open(manifest) {
    const key=manifest.id;
    if(ready.has(key)) return remember(key,ready.get(key)).image;
    if(!pending.has(key)) pending.set(key,(async () => {
      const blob=session.get(key)||await load(key);
      if(!(blob instanceof Blob)) throw new Error("原片已不在当前浏览器。");
      return remember(key,{blob,image:await decode(blob),stored:!session.has(key)}).image;
    })().finally(()=>pending.delete(key)));
    return pending.get(key);
  }
  async function keep(manifest) {
    const item=ready.get(manifest.id);
    if(!item) return false;
    try {
      if(!item.stored) await save(manifest.id,item.blob);
      item.stored=true;
      return true;
    } catch { session.set(manifest.id,item.blob);return false; }
  }
  function forget(manifest) {
    session.delete(manifest.id);
    const item=ready.get(manifest.id);
    if(item) item.stored=false;
    return record(manifest.id,"readwrite",(store,key)=>store.delete(key));
  }

  async function compile(draft) {
    const {items,error}=arrange(draft.rows);
    if(error) throw new Error(error);
    const tiles=Math.min(3,items.length), height=Math.ceil(items.length/tiles);
    const canvas=document.createElement("canvas");
    canvas.width=tileWidth*tiles;
    canvas.height=tileHeight*height;
    const context=canvas.getContext("2d",{alpha:false});
    for(let i=0;i<items.length;i++){
      const {row}=items[i], image=await photoImage(row);
      context.save();
      context.translate(i%tiles*tileWidth,Math.floor(i/tiles)*tileHeight);
      context.beginPath();
      context.rect(0,0,tileWidth,tileHeight);
      context.clip();
      paint(context,image,row,tileWidth,tileHeight);
      context.restore();
    }
    const manifest=validate({id:id(),title:draft.title,times:items.map(item=>item.minute),
      mix:draft.mix,credits:items.map(item=>item.row.source)});
    const blob=await toJpeg(canvas,.93);
    remember(manifest.id,{blob,image:await decode(blob),stored:false});
    return manifest;
  }
  function initial(manifest) {
    const start=manifest.times[0], end=manifest.times.at(-1);
    return {...Optics.initial(),place:"field",field:manifest,
      minute:Optics.wrapDay((start+end)/2),span:manifest.times.length===1?1080:Math.max(30,end-start)};
  }
  function sampledMinute(manifest, minute) {
    if (manifest.times.length < 2) return minute;
    const start = manifest.times[0], end = manifest.times.at(-1);
    const unwrapped = Optics.wrapDay(minute - start) + start;
    if (unwrapped <= end) return unwrapped;
    return unwrapped - end > start + day - unwrapped ? start : end;
  }
  function caption(items) {
    return items.length===1 ? "单张推演 · 色调模拟" :
      `${items.length} 张原片 · ${formatTime(items[0])} → ${items.at(-1)>=day?"次日 ":""}${formatTime(items.at(-1))}`;
  }

  function attribution(credits, medium = "print") {
    const lines = credits.map(item => `${item.title} | ${item.by||"Author as credited on Commons"} | ${item.license} ${item.terms} | ${item.url}`);
    if (credits.some(item => item.license==="CC BY-SA 4.0")) lines.push(`Adapted ${medium}: CC BY-SA 4.0 https://creativecommons.org/licenses/by-sa/4.0/`);
    if (lines.length) lines.unshift("Time Darkroom: cropped and time-graded / blended source photographs.");
    return lines.join("\n");
  }
  async function writeCredit(blob,credits) {
    if(!credits.length) return blob;
    const bytes=new Uint8Array(await blob.arrayBuffer());
    const data=new TextEncoder().encode("Attribution\0\0\0\0\0"+attribution(credits));
    const chunk=new Uint8Array(data.length+12), view=new DataView(chunk.buffer);
    view.setUint32(0,data.length);
    chunk.set([105,84,88,116],4);
    chunk.set(data,8);
    let crc=0xffffffff;
    for(let i=4;i<data.length+8;i++){
      crc^=chunk[i];
      for(let j=0;j<8;j++) crc=(crc>>>1)^(0xedb88320&-(crc&1));
    }
    view.setUint32(data.length+8,(crc^0xffffffff)>>>0);
    return new Blob([bytes.subarray(0,-12),chunk,bytes.subarray(-12)],{type:"image/png"});
  }

  return {maxFrames,tileWidth,tileHeight,credit,validate,arrange,formatTime,parseTime,normalize,
    load,save,photoImage,framing,paint,compile,initial,sampledMinute,caption,select,get,open,keep,forget,attribution,writeCredit};
})();
