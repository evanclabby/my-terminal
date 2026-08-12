/* terminal.js — complete frontend */
'use strict';

const $ = id => document.getElementById(id);
const fmt = (n, d=2) => n==null ? '—' : Number(n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
const fmtM = n => n==null ? '—' : '$'+Math.abs(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const fmtCap = n => {if(!n)return'—';if(n>=1e12)return'$'+(n/1e12).toFixed(2)+'T';if(n>=1e9)return'$'+(n/1e9).toFixed(2)+'B';if(n>=1e6)return'$'+(n/1e6).toFixed(2)+'M';return'$'+n.toLocaleString();};
const fmtPct = (n,sign=false) => {if(n==null)return'—';const v=(n*100).toFixed(1)+'%';return sign?(n>=0?'+':'')+v:v;};
const fmtPctD = n => n==null?'—':(n>=0?'+':'')+n.toFixed(1)+'%';
const sgn = n => n>=0?'+':'';
const cls = n => n>=0?'up':'dn';
const sleep = ms => new Promise(r=>setTimeout(r,ms));

async function api(url){const r=await fetch(url);if(!r.ok)throw new Error(r.status);return r.json();}
async function post(url,body){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return r.json();}

/* ── Price cache (sessionStorage, 15min TTL) ─────────────────────────── */
const P_TTL = 15*60*1000;
const P52_TTL = 60*60*1000; // 52w data cached 1hr
function getP(sym){try{const r=sessionStorage.getItem('p_'+sym);if(!r)return null;const o=JSON.parse(r);if(Date.now()-o.ts>P_TTL){sessionStorage.removeItem('p_'+sym);return null;}return o.d;}catch{return null;}}
function setP(sym,d){try{sessionStorage.setItem('p_'+sym,JSON.stringify({ts:Date.now(),d}));}catch{}}
async function fetchP(sym){const c=getP(sym);if(c)return c;try{const d=await api('/api/price/'+sym);if(d.price)setP(sym,d);return d;}catch{return{sym,price:null};}}

/* ── Clock & market status ───────────────────────────────────────────── */
function tick(){
  const now=new Date();
  const d=now.toLocaleDateString('en-US',{month:'short',day:'2-digit',year:'numeric'}).toUpperCase();
  const t=now.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const c=$('clock');if(c)c.textContent=d+'  '+t;
}
setInterval(tick,1000);tick();

function mktStatus(){
  const est=new Date(Date.now()+new Date().getTimezoneOffset()*60000-5*3600000);
  const d=est.getDay(),h=est.getHours()+est.getMinutes()/60;
  const open=d>=1&&d<=5&&h>=9.5&&h<16;
  const b=$('mkt-badge');
  if(b){b.textContent=open?'MARKET OPEN':'MARKET CLOSED';b.className='mkt-badge '+(open?'open':'closed');}
  return open;
}
mktStatus();setInterval(mktStatus,60000);

/* ── Tab navigation ──────────────────────────────────────────────────── */
document.querySelectorAll('.nav-btn').forEach(btn=>{
  btn.addEventListener('click',()=>{
    const t=btn.dataset.tab;if(!t)return;
    document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
    btn.classList.add('active');
    const panel=$('tab-'+t);if(panel)panel.classList.add('active');
    if(t==='notes')loadNotes();
    if(t==='alerts')loadAlerts();
  });
});

/* ── Status ──────────────────────────────────────────────────────────── */
function setStatus(live){
  const d=$('status-dot'),l=$('status-label');
  if(d)d.className='status-dot'+(live?' live':'');
  if(l)l.textContent=live?'LIVE':'LOADING';
}
function setRefresh(){const e=$('refresh-label');if(e)e.textContent='Updated '+new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});}

/* ── Globals ─────────────────────────────────────────────────────────── */
let watchSyms=[];
let portData=[];
let priceMap={};
const COLORS=['#f5a623','#00c87a','#3b9eff','#ff6b6b','#a78bfa','#34d399','#fb923c','#60a5fa','#f472b6','#facc15','#94a3b8','#2dd4bf','#e879f9','#4ade80','#fbbf24'];
let _detailCache={};

/* ── Watchlist ───────────────────────────────────────────────────────── */
async function loadWatchlist(){
  const data=await api('/api/watchlist');
  watchSyms=data.map(d=>d.sym);
  renderWLSkeleton();
  fetchAllPrices();
}

function renderWLSkeleton(){
  ['ov-wl-body','wl-full-body'].forEach(id=>{
    const el=$(id);if(!el)return;el.innerHTML='';
    watchSyms.forEach(sym=>{
      const row=document.createElement('div');
      if(id==='ov-wl-body'){
        row.className='row grid-wl-sm';
        row.innerHTML=`<div class="sym-cell">${sym}</div><div class="r" id="wp-${sym}">…</div><div class="r" id="wc-${sym}">…</div>`;
      } else {
        row.className='row grid-wl-full';
        row.innerHTML=`<div class="sym-cell">${sym}</div><div class="name-cell" id="wn-${sym}">…</div><div class="sector-cell" id="ws-${sym}">—</div><div class="r" id="wpf-${sym}">…</div><div class="r" id="wchgf-${sym}">…</div><div class="r" id="wcf-${sym}">…</div><div class="r" id="w52h-${sym}">—</div><div class="r" id="w52l-${sym}">—</div><div class="rm-btn" data-sym="${sym}">✕</div>`;
        row.querySelector('.rm-btn').addEventListener('click',async e=>{e.stopPropagation();if(!confirm('Remove '+sym+'?'))return;await post('/api/watchlist/remove',{sym});loadWatchlist();});
      }
      row.addEventListener('click',e=>{if(e.target.classList.contains('rm-btn'))return;openDetail(sym);});
      el.appendChild(row);
    });
  });
}

async function fetchAllPrices(){
  setStatus(false);
  for(let i=0;i<watchSyms.length;i++){
    const sym=watchSyms[i];
    const p=await fetchP(sym);
    priceMap[sym]=p;
    updatePriceEl(sym,p);
    renderTicker();
    if(i<watchSyms.length-1)await sleep(320);
  }
  renderPortfolio();
  setStatus(true);
  setRefresh();
}

function updatePriceEl(sym,p){
  if(!p||!p.price)return;
  const c=cls(p.pct),pct=sgn(p.pct)+fmt(p.pct)+'%',chg=sgn(p.change)+fmt(p.change);
  // Overview wl
  let e=$('wp-'+sym);if(e)e.textContent=fmt(p.price);
  e=$('wc-'+sym);if(e){e.textContent=pct;e.className='r '+c;}
  // Full wl
  e=$('wn-'+sym);if(e)e.textContent=(p.name||sym).slice(0,24);
  e=$('ws-'+sym);if(e)e.textContent=(p.industry||'—').slice(0,20);
  e=$('wpf-'+sym);if(e)e.textContent=fmt(p.price);
  e=$('wchgf-'+sym);if(e){e.textContent=chg;e.className='r '+c;}
  e=$('wcf-'+sym);if(e){e.textContent=pct;e.className='r '+c;}
}

/* ── Ticker ──────────────────────────────────────────────────────────── */
function renderTicker(){
  const html=watchSyms.map(sym=>{
    const p=priceMap[sym];
    const pr=p&&p.price?fmt(p.price):'…';
    const pct=p&&p.pct!=null?sgn(p.pct)+fmt(p.pct)+'%':'';
    const c=p&&p.pct!=null?cls(p.pct):'';
    return`<div class="tick"><span class="tick-sym">${sym}</span><span class="tick-p">${pr}</span><span class="tick-c ${c}">${pct}</span></div>`;
  }).join('');
  const a=$('ticker-a'),b=$('ticker-b');
  if(a)a.innerHTML=html;if(b)b.innerHTML=html;
}

/* ── Add watchlist ───────────────────────────────────────────────────── */
function setupAddSym(btnId,rowId,inputId,submitId){
  const btn=$(btnId),row=$(rowId),inp=$(inputId),sub=$(submitId);if(!btn)return;
  btn.addEventListener('click',()=>row.style.display=row.style.display==='none'?'flex':'none');
  sub.addEventListener('click',async()=>{
    const sym=inp.value.trim().toUpperCase();if(!sym)return;
    await post('/api/watchlist/add',{sym});inp.value='';row.style.display='none';loadWatchlist();
  });
  inp.addEventListener('keydown',e=>{if(e.key==='Enter')sub.click();});
}
setupAddSym('ov-add-btn','ov-add-row','ov-add-input','ov-add-submit');
setupAddSym('wl-add-btn','wl-add-row','wl-add-input','wl-add-submit');

/* ── Portfolio ───────────────────────────────────────────────────────── */
async function loadPortfolio(){
  portData=await api('/api/portfolio');
  for(let i=0;i<portData.length;i++){
    const sym=portData[i].sym;
    if(!priceMap[sym]){priceMap[sym]=await fetchP(sym);await sleep(320);}
  }
  renderPortfolio();
}

function renderPortfolio(){
  const holdings=[]; let tv=0,tc=0,dg=0;
  portData.forEach(h=>{
    const p=priceMap[h.sym];
    const prc=(p&&p.price)||h.avg_cost;
    const prev=(p&&p.prev)||h.avg_cost;
    const val=Math.round(prc*h.shares*100)/100;
    const cost=Math.round(h.avg_cost*h.shares*100)/100;
    const day=Math.round((prc-prev)*h.shares*100)/100;
    tv+=val;tc+=cost;dg+=day;
    holdings.push({...h,price:prc,value:val,cost,gain:Math.round((val-cost)*100)/100,
      gain_pct:cost?Math.round((val-cost)/cost*10000)/100:0,
      day_gain:day,day_pct:prev?Math.round((prc-prev)/prev*10000)/100:0,
      name:(p&&p.name)||h.sym,industry:(p&&p.industry)||''});
  });
  const tg=Math.round((tv-tc)*100)/100;

  // KPIs
  [['ov-kpis',4],['port-kpis',4]].forEach(([id])=>{
    const el=$(id);if(!el)return;
    const dc=cls(dg),gc=cls(tg);
    el.innerHTML=`
      <div class="kpi ${dc==='up'?'green':'red'}"><div class="kpi-label">Total Value</div><div class="kpi-val">${fmtM(tv)}</div><div class="kpi-sub ${dc}">${sgn(dg)}${fmtM(dg)} today</div></div>
      <div class="kpi ${dc==='up'?'green':'red'}"><div class="kpi-label">Day P&L</div><div class="kpi-val ${dc}">${sgn(dg)}${fmtM(dg)}</div><div class="kpi-sub ${dc}">${sgn(dg/tv*100)}${fmt(dg/(tv||1)*100)}%</div></div>
      <div class="kpi ${gc==='up'?'green':'red'}"><div class="kpi-label">Total Return</div><div class="kpi-val ${gc}">${sgn(tg)}${fmtM(tg)}</div><div class="kpi-sub ${gc}">${sgn(tg/tc*100)}${fmt(tg/(tc||1)*100)}%</div></div>
      <div class="kpi gold"><div class="kpi-label">Cost Basis</div><div class="kpi-val">${fmtM(tc)}</div><div class="kpi-sub muted">${holdings.length} positions</div></div>`;
  });

  // Overview holdings
  const ovb=$('ov-port-body');if(ovb){ovb.innerHTML='';
    holdings.forEach(h=>{
      const alloc=tv>0?Math.round(h.value/tv*100):0;
      const row=document.createElement('div');row.className='row grid-port-sm';row.style.cursor='pointer';
      row.innerHTML=`<div><div class="sym-cell">${h.sym}</div><div class="alloc-bar-wrap"><div class="alloc-bar-fill" style="width:${Math.min(alloc*2,100)}%"></div></div></div><div class="r">${fmtM(h.value)}</div><div class="r ${cls(h.day_gain)}">${sgn(h.day_pct)}${fmt(h.day_pct)}%</div><div class="r ${cls(h.gain)}">${sgn(h.gain_pct)}${fmt(h.gain_pct)}%</div>`;
      row.addEventListener('click',()=>openDetail(h.sym));ovb.appendChild(row);
    });
  }

  // Full holdings table
  const phb=$('port-holdings-body');if(phb){phb.innerHTML='';
    holdings.forEach((h,i)=>{
      const alloc=tv>0?(h.value/tv*100).toFixed(1):0;
      const d=_detailCache[h.sym];
      const sector=d&&d.sector?d.sector.slice(0,16):h.industry?h.industry.slice(0,16):'—';
      const row=document.createElement('div');row.className='row grid-port-full';row.style.cursor='pointer';
      row.innerHTML=`
        <div class="name-cell">${h.name.slice(0,20)}</div>
        <div class="sym-cell">${h.sym}</div>
        <div class="sector-cell">${sector}</div>
        <div class="r muted">${h.shares}</div>
        <div class="r">$${fmt(h.price)}</div>
        <div class="r ${cls(h.day_gain)}">${sgn(h.day_gain)}${fmtM(h.day_gain)}</div>
        <div class="r ${cls(h.gain_pct)}">${sgn(h.gain_pct)}${fmt(h.gain_pct)}%</div>
        <div class="r">${fmtM(h.value)}</div>
        <div class="r muted">${alloc}%</div>
        <div class="rm-btn" data-sym="${h.sym}">✕</div>`;
      row.querySelector('.rm-btn').addEventListener('click',async e=>{e.stopPropagation();if(!confirm('Remove '+h.sym+'?'))return;await post('/api/portfolio/remove',{sym:h.sym});portData=portData.filter(x=>x.sym!==h.sym);renderPortfolio();});
      row.addEventListener('click',e=>{if(e.target.classList.contains('rm-btn'))return;openDetail(h.sym);});
      phb.appendChild(row);
    });
  }

  renderPie(holdings,tv);
  renderDividends(holdings);
}

/* ── Add holding ─────────────────────────────────────────────────────── */
const pab=$('port-add-btn'),par=$('port-add-row'),pas=$('port-add-submit');
if(pab){
  pab.addEventListener('click',()=>par.style.display=par.style.display==='none'?'flex':'none');
  pas.addEventListener('click',async()=>{
    const sym=$('port-sym').value.trim().toUpperCase();
    const shares=parseFloat($('port-shares').value);
    const cost=parseFloat($('port-cost').value);
    if(!sym||isNaN(shares)||isNaN(cost)){alert('Fill in all fields');return;}
    await post('/api/portfolio/update',{sym,shares,avg_cost:cost});
    $('port-sym').value=$('port-shares').value=$('port-cost').value='';
    par.style.display='none';
    portData=await api('/api/portfolio');renderPortfolio();
  });
}

/* ── Pie chart ───────────────────────────────────────────────────────── */
function renderPie(holdings,tv){
  const c=$('pie-canvas'),leg=$('pie-legend');if(!c||!tv)return;
  const ctx=c.getContext('2d');
  const W=200,H=200,cx=W/2,cy=H/2,r=85,ir=48;
  ctx.clearRect(0,0,W,H);
  let start=-Math.PI/2;
  holdings.forEach((h,i)=>{
    const slice=(h.value/tv)*2*Math.PI;
    ctx.beginPath();ctx.moveTo(cx,cy);ctx.arc(cx,cy,r,start,start+slice);ctx.closePath();
    ctx.fillStyle=COLORS[i%COLORS.length];ctx.fill();
    ctx.beginPath();ctx.arc(cx,cy,ir,0,2*Math.PI);ctx.fillStyle='#0d1117';ctx.fill();
    start+=slice;
  });
  ctx.fillStyle='#dde3ed';ctx.font='bold 11px Courier New';ctx.textAlign='center';ctx.textBaseline='middle';
  ctx.fillText(holdings.length+' positions',cx,cy);
  if(leg){leg.innerHTML='';holdings.forEach((h,i)=>{
    const alloc=tv>0?(h.value/tv*100).toFixed(1):0;
    const item=document.createElement('div');item.className='pie-item';
    item.innerHTML=`<div class="pie-dot" style="background:${COLORS[i%COLORS.length]}"></div><span>${h.sym} ${alloc}%</span>`;
    leg.appendChild(item);
  });}
}

/* ── Dividends ───────────────────────────────────────────────────────── */
function renderDividends(holdings){
  const te=$('div-total'),me=$('div-monthly'),be=$('div-breakdown');if(!te)return;
  let total=0;const rows=[];
  holdings.forEach(h=>{
    const d=_detailCache[h.sym];
    let ann=null;
    if(d&&d.div_rate)ann=d.div_rate*h.shares;
    else if(d&&d.div_yield&&h.price)ann=d.div_yield*h.price*h.shares;
    if(ann&&ann>0){total+=ann;rows.push({sym:h.sym,ann,yld:d&&d.div_yield?(d.div_yield*100).toFixed(2)+'%':'—'});}
  });
  if(total>0){
    te.textContent='$'+total.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
    if(me)me.textContent='$'+(total/12).toFixed(2)+' / month';
  } else {
    te.textContent='Click stocks to load';te.style.color='var(--muted)';te.style.fontSize='14px';
    if(me)me.textContent='Dividend data loads when you view a stock';
  }
  if(be){
    if(!rows.length){be.innerHTML='<div style="font-size:11px;color:var(--muted);padding:4px 0">Open a stock\'s detail panel to load dividend data.</div>';}
    else{
      rows.sort((a,b)=>b.ann-a.ann);
      be.innerHTML=rows.map(r=>`<div class="div-card"><div class="div-card-sym">${r.sym}</div><div class="div-card-amt">$${r.ann.toFixed(2)}/yr</div><div class="div-card-yld">Yield: ${r.yld}</div></div>`).join('');
    }
  }
}

/* ── News ────────────────────────────────────────────────────────────── */
async function loadNews(src,tgtId){
  src=src||'ALL';tgtId=tgtId||'ov-news-body';
  try{renderNews(await api(src!=='ALL'?'/api/news?source='+src:'/api/news'),tgtId);}
  catch(e){console.error('News:',e);}
}
function renderNews(articles,tgtId){
  const el=$(tgtId);if(!el)return;el.innerHTML='';
  if(!articles.length){el.innerHTML='<div style="padding:16px;color:var(--muted);font-size:11px">No articles found</div>';return;}
  articles.forEach(a=>{
    const item=document.createElement('a');item.className='news-item';item.href=a.link;item.target='_blank';item.rel='noopener';
    item.innerHTML=`<div><div class="news-badge badge-${a.source}">${a.source}</div><div class="news-age">${a.age}</div></div><div class="news-hl">${a.headline}</div>`;
    el.appendChild(item);
  });
}
document.querySelectorAll('.chip').forEach(chip=>{
  chip.addEventListener('click',()=>{
    const g=chip.closest('.filter-row'),tgt=chip.dataset.tgt||'ov-news-body';
    g.querySelectorAll('.chip').forEach(c=>c.classList.remove('active'));
    chip.classList.add('active');
    loadNews(chip.dataset.src,tgt);
  });
});

/* ── Indices ─────────────────────────────────────────────────────────── */
async function loadIndices(){
  try{
    const data=await api('/api/indices'),el=$('index-strip');if(!el)return;
    el.innerHTML=data.map(i=>`<div class="idx-item"><span class="idx-label">${i.label}</span><span class="idx-price">${fmt(i.price)}</span><span class="idx-chg ${cls(i.pct)}">${sgn(i.pct)}${fmt(i.pct)}%</span></div>`).join('');
  }catch{}
}

/* ── Screener ────────────────────────────────────────────────────────── */
$('sc-use-watchlist')&&$('sc-use-watchlist').addEventListener('click',()=>{$('sc-input').value=watchSyms.join(', ');});
$('sc-use-portfolio')&&$('sc-use-portfolio').addEventListener('click',()=>{$('sc-input').value=portData.map(h=>h.sym).join(', ');});

$('sc-run')&&$('sc-run').addEventListener('click',async()=>{
  const raw=$('sc-input').value;
  const syms=[...new Set(raw.split(/[,\s]+/).map(s=>s.trim().toUpperCase()).filter(Boolean))];
  if(!syms.length){alert('Enter at least one ticker');return;}
  const st=$('sc-status'),res=$('sc-results'),ch=$('sc-col-head');
  st.textContent=`Screening ${syms.length} stocks… (this may take a minute)`;
  res.innerHTML='';ch.style.display='none';
  const results=[];
  for(let i=0;i<syms.length;i++){
    const sym=syms[i];st.textContent=`Fetching ${sym} (${i+1}/${syms.length})…`;
    try{
      let d=_detailCache[sym];
      if(!d){d=await api('/api/stock/'+sym);if(!d.error)_detailCache[sym]=d;}
      if(d&&!d.error){
        let p=priceMap[sym];if(!p){p=await fetchP(sym);priceMap[sym]=p;}
        results.push({...d,price:p&&p.price?p.price:d.price});
      }
    }catch{}
    if(i<syms.length-1)await sleep(400);
  }
  st.textContent=`Screened ${results.length} of ${syms.length} stocks.`;
  if(!results.length)return;
  ch.style.display='grid';
  results.forEach(d=>{
    const row=document.createElement('div');row.className='row grid-screener';row.style.cursor='pointer';
    const up=d.analyst_target&&d.price?((d.analyst_target-d.price)/d.price*100):null;
    row.innerHTML=`
      <div class="sym-cell">${d.sym}</div>
      <div class="name-cell">${(d.name||'').slice(0,20)}</div>
      <div class="sector-cell">${(d.sector||'—').slice(0,16)}</div>
      <div class="r">$${fmt(d.price)}</div>
      <div class="r">${d.pe_ratio!=null?fmt(d.pe_ratio,1):'—'}</div>
      <div class="r">${d.forward_pe!=null?fmt(d.forward_pe,1):'—'}</div>
      <div class="r">${fmtCap(d.market_cap)}</div>
      <div class="r">${d.beta!=null?fmt(d.beta,2):'—'}</div>
      <div class="r ${d.gross_margin!=null?cls(d.gross_margin):''}">${d.gross_margin!=null?fmtPct(d.gross_margin):'—'}</div>
      <div class="r ${d.roe!=null?cls(d.roe):''}">${d.roe!=null?fmtPct(d.roe):'—'}</div>
      <div class="r ${d.div_yield!=null&&d.div_yield>0?'up':''}">${d.div_yield!=null&&d.div_yield>0?fmtPct(d.div_yield):'—'}</div>
      <div class="r ${up!=null?cls(up):''}">${d.analyst_target?'$'+fmt(d.analyst_target)+(up!=null?'  ('+sgn(up)+up.toFixed(0)+'%)':''):'—'}</div>`;
    row.addEventListener('click',()=>openDetail(d.sym));
    res.appendChild(row);
  });
});

/* ── Notes ───────────────────────────────────────────────────────────── */
async function loadNotes(){
  try{const d=await api('/api/notes');const a=$('notes-area');if(a&&d.content)a.value=d.content;}catch{}
}
let notesSaveTimer=null;
$('notes-area')&&$('notes-area').addEventListener('input',()=>{
  clearTimeout(notesSaveTimer);
  notesSaveTimer=setTimeout(async()=>{
    await post('/api/notes',{content:$('notes-area').value});
    const s=$('notes-saved');if(s){s.textContent='Saved';setTimeout(()=>s.textContent='',2000);}
  },1500);
});
$('notes-save-btn')&&$('notes-save-btn').addEventListener('click',async()=>{
  await post('/api/notes',{content:$('notes-area').value});
  const s=$('notes-saved');if(s){s.textContent='Saved ✓';setTimeout(()=>s.textContent='',2000);}
});

/* ── Alerts ──────────────────────────────────────────────────────────── */
async function loadAlerts(){
  try{
    const alerts=await api('/api/alerts');
    const body=$('alerts-body');if(!body)return;body.innerHTML='';
    if(!alerts.length){body.innerHTML='<div style="padding:16px;color:var(--muted);font-size:11px">No alerts set. Add a price alert above.</div>';return;}
    alerts.forEach(a=>{
      const p=priceMap[a.sym];const cur=p&&p.price?p.price:null;
      const triggered=cur&&((a.condition==='above'&&cur>=a.price)||(a.condition==='below'&&cur<=a.price));
      const row=document.createElement('div');row.className='row grid-alerts';
      row.innerHTML=`
        <div class="sym-cell ${triggered?'alert-triggered':''}">${a.sym}</div>
        <div>${a.condition==='above'?'Above':'Below'}</div>
        <div class="r">$${fmt(a.price)}</div>
        <div class="r">${cur?'$'+fmt(cur):'—'}</div>
        <div class="r ${triggered?'up':''}">${triggered?'⚡ TRIGGERED':'Watching'}</div>
        <div class="rm-btn" data-id="${a.id}">✕</div>`;
      row.querySelector('.rm-btn').addEventListener('click',async e=>{e.stopPropagation();await post('/api/alerts/remove',{id:a.id});loadAlerts();});
      body.appendChild(row);
    });
  }catch(e){console.error('Alerts:',e);}
}
$('alert-add-btn')&&$('alert-add-btn').addEventListener('click',async()=>{
  const sym=$('alert-sym').value.trim().toUpperCase();
  const cond=$('alert-cond').value;
  const price=parseFloat($('alert-price').value);
  if(!sym||isNaN(price)){alert('Fill in symbol and price');return;}
  await post('/api/alerts/add',{sym,condition:cond,price});
  $('alert-sym').value=$('alert-price').value='';
  loadAlerts();
});

/* ── Modal ───────────────────────────────────────────────────────────── */
const modalBg=$('modal-bg'),modalClose=$('modal-close');
function openModal(){if(modalBg){modalBg.style.display='block';document.body.style.overflow='hidden';}}
function closeModal(){if(modalBg){modalBg.style.display='none';document.body.style.overflow='';}}
modalClose&&modalClose.addEventListener('click',closeModal);
modalBg&&modalBg.addEventListener('click',e=>{if(e.target===modalBg)closeModal();});
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeModal();});

function setV(id,txt,cls){const el=$(id);if(!el)return;el.textContent=txt||'—';el.className='mcard-v'+(cls?' '+cls:'');}

async function openDetail(sym){
  if(!sym)return;
  $('m-sym').textContent=sym;$('m-name').textContent='';$('m-sector').textContent='';
  $('m-price').textContent='';$('m-chg').textContent='';$('m-range').textContent='';
  $('modal-loading').style.display='block';$('modal-content').style.display='none';
  openModal();

  const p=priceMap[sym];
  if(p&&p.price){
    $('m-price').textContent='$'+fmt(p.price);
    if(p.pct!=null){$('m-chg').textContent=sgn(p.pct)+fmt(p.pct)+'%  ('+sgn(p.change)+fmt(p.change)+')';$('m-chg').className='modal-chg '+cls(p.pct);}
  }

  try{
    let d=_detailCache[sym];
    if(!d){d=await api('/api/stock/'+sym);if(!d.error)_detailCache[sym]=d;}
    if(d.error)throw new Error(d.error);

    $('m-name').textContent=d.name||sym;
    $('m-sector').textContent=[d.sector,d.exchange,d.currency].filter(Boolean).join(' · ');
    if(d.day_high&&d.day_low)$('m-range').textContent=`Day: $${fmt(d.day_low)} – $${fmt(d.day_high)}`;

    setV('md-pe',   d.pe_ratio   !=null?fmt(d.pe_ratio,1):'—');
    setV('md-fpe',  d.forward_pe !=null?fmt(d.forward_pe,1):'—');
    setV('md-mcap', fmtCap(d.market_cap));
    setV('md-eps',  d.eps        !=null?'$'+fmt(d.eps):'—');
    setV('md-feps', d.forward_eps!=null?'$'+fmt(d.forward_eps):'—');
    setV('md-peg',  d.peg_ratio  !=null?fmt(d.peg_ratio,2):'—');
    setV('md-pb',   d.price_book !=null?fmt(d.price_book,2):'—');
    setV('md-evebitda',d.ev_ebitda!=null?fmt(d.ev_ebitda,1):'—');

    const up=d.analyst_target&&d.price?((d.analyst_target-d.price)/d.price*100):null;
    setV('md-target',d.analyst_target?'$'+fmt(d.analyst_target)+(up!=null?' ('+sgn(up)+up.toFixed(1)+'%)':''):'—',up!=null?cls(up):'');
    const rmap={strong_buy:'STRONG BUY',buy:'BUY',hold:'HOLD',underperform:'UNDERPERFORM',sell:'SELL'};
    const rcls={strong_buy:'buy',buy:'buy',hold:'hold',underperform:'sell',sell:'sell'};
    setV('md-rec',d.recommendation?(rmap[d.recommendation]||d.recommendation.toUpperCase()):'—',d.recommendation?rcls[d.recommendation]:'');
    setV('md-nanalysts',d.num_analysts!=null?String(d.num_analysts):'—');
    setV('md-beta',d.beta!=null?fmt(d.beta,2):'—');
    setV('md-52h', d.week52_high!=null?'$'+fmt(d.week52_high):'—');
    setV('md-52l', d.week52_low !=null?'$'+fmt(d.week52_low):'—');
    setV('md-dh',  d.day_high   !=null?'$'+fmt(d.day_high):'—');
    setV('md-dl',  d.day_low    !=null?'$'+fmt(d.day_low):'—');

    setV('md-gm',   d.gross_margin   !=null?fmtPct(d.gross_margin):'—',   d.gross_margin   !=null?(d.gross_margin   >0?'up':'dn'):'');
    setV('md-om',   d.op_margin      !=null?fmtPct(d.op_margin):'—',      d.op_margin      !=null?(d.op_margin      >0?'up':'dn'):'');
    setV('md-nm',   d.net_margin     !=null?fmtPct(d.net_margin):'—',     d.net_margin     !=null?(d.net_margin     >0?'up':'dn'):'');
    setV('md-roe',  d.roe            !=null?fmtPct(d.roe):'—',            d.roe            !=null?(d.roe            >0?'up':'dn'):'');
    setV('md-roa',  d.roa            !=null?fmtPct(d.roa):'—',            d.roa            !=null?(d.roa            >0?'up':'dn'):'');
    setV('md-revg', d.revenue_growth !=null?fmtPct(d.revenue_growth,true):'—', d.revenue_growth !=null?cls(d.revenue_growth):'');
    setV('md-earng',d.earnings_growth!=null?fmtPct(d.earnings_growth,true):'—',d.earnings_growth!=null?cls(d.earnings_growth):'');

    setV('md-de',d.debt_equity   !=null?fmt(d.debt_equity,2):'—');
    setV('md-cr',d.current_ratio !=null?fmt(d.current_ratio,2):'—');
    setV('md-qr',d.quick_ratio   !=null?fmt(d.quick_ratio,2):'—');

    setV('md-divrate', d.div_rate    !=null?'$'+fmt(d.div_rate,2):'No dividend');
    setV('md-divyield',d.div_yield   !=null?fmtPct(d.div_yield):'—',d.div_yield!=null&&d.div_yield>0?'up':'');
    setV('md-payout',  d.payout_ratio!=null?fmtPct(d.payout_ratio):'—');
    setV('md-dg5',     d.div_growth_5y!=null?fmtPctD(d.div_growth_5y*100):'—',d.div_growth_5y!=null?cls(d.div_growth_5y):'');

    $('modal-loading').style.display='none';$('modal-content').style.display='block';

    // Refresh dividends with new data
    if(portData.length){
      const hs=portData.map(h=>{const p=priceMap[h.sym];return{...h,price:(p&&p.price)||h.avg_cost,value:Math.round(((p&&p.price)||h.avg_cost)*h.shares*100)/100};});
      renderDividends(hs);
    }
    // Refresh portfolio sector column
    renderPortfolio();

  }catch(e){
    $('modal-loading').textContent='Error loading data. Please try again.';
    console.error('Detail:',e);
  }
}

/* ── Init ────────────────────────────────────────────────────────────── */
async function init(){
  setStatus(false);
  await loadWatchlist();
  await loadPortfolio();
  loadNews('ALL','ov-news-body');
  loadNews('ALL','news-full-body');
  loadIndices();
}
init();
