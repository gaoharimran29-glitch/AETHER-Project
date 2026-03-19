// src/components/BullseyePlot.jsx
// PS §6.2 — Conjunction Bullseye Plot (Polar Chart)
// Fixed: TCA normalized against dataset max, prime-multiply angle hash, loading state
import React, { useEffect, useRef, useState } from 'react';
import { fetchConjunctionForecast } from '../api/aetherApi';

export default function BullseyePlot({satelliteId, conjunctions=[]}){
  const canvasRef=useRef(null);
  const [local,setLocal]=useState([]);
  const [loading,setLoading]=useState(false);
  const [selected,setSelected]=useState(null);

  useEffect(()=>{
    if(conjunctions.length>0) return;
    setLoading(true);
    fetchConjunctionForecast()
      .then(d=>setLocal((d?.forecast||[]).filter(c=>c.sat_id===satelliteId)))
      .catch(()=>{})
      .finally(()=>setLoading(false));
  },[satelliteId,conjunctions.length]);

  const active=conjunctions.length>0?conjunctions.filter(c=>!c.sat_id||c.sat_id===satelliteId):local;

  useEffect(()=>{
    const canvas=canvasRef.current; if(!canvas) return;
    const ctx=canvas.getContext('2d');
    const W=canvas.width,H=canvas.height,cx=W/2,cy=H/2,maxR=Math.min(W,H)*.38;
    ctx.clearRect(0,0,W,H);
    ctx.fillStyle='#050d1a'; ctx.fillRect(0,0,W,H);
    // Normalize TCA against actual max in dataset
    const maxTCA=active.length>0?Math.max(...active.map(c=>c.tca_offset_s||3600),3600):3600;
    // Rings
    [.2,.4,.6,.8,1].forEach((f,i)=>{
      const r=f*maxR;
      ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2);
      ctx.strokeStyle=i===0?'#ef444444':'#1a3a5a'; ctx.lineWidth=i===0?1.4:.7; ctx.stroke();
      ctx.fillStyle='#4a6a8a'; ctx.font='9px monospace';
      ctx.fillText(`${Math.round(maxTCA*f/60)}m`,cx+r+3,cy-3);
    });
    // Crosshairs
    ctx.beginPath(); ctx.moveTo(cx-maxR-8,cy); ctx.lineTo(cx+maxR+8,cy); ctx.moveTo(cx,cy-maxR-8); ctx.lineTo(cx,cy+maxR+8);
    ctx.strokeStyle='#1a3a5a'; ctx.lineWidth=.6; ctx.stroke();
    // Degree ticks
    for(let deg=0;deg<360;deg+=30){
      const rad=(deg-90)*Math.PI/180;
      ctx.beginPath(); ctx.moveTo(cx+(maxR+6)*Math.cos(rad),cy+(maxR+6)*Math.sin(rad)); ctx.lineTo(cx+(maxR+14)*Math.cos(rad),cy+(maxR+14)*Math.sin(rad));
      ctx.strokeStyle='#2a4a6a'; ctx.lineWidth=.8; ctx.stroke();
      if(deg%90===0){ctx.fillStyle='#3a6a9a'; ctx.font='9px monospace'; ctx.fillText(`${deg}°`,cx+(maxR+18)*Math.cos(rad)-8,cy+(maxR+18)*Math.sin(rad)+4);}
    }
    if(loading){ctx.fillStyle='#4a6a8a'; ctx.font='13px monospace'; ctx.textAlign='center'; ctx.fillText('LOADING…',cx,cy+6); ctx.textAlign='left'; return;}
    if(!active.length){ctx.fillStyle='#1a4a2a'; ctx.font='13px monospace'; ctx.textAlign='center'; ctx.fillText('NO ACTIVE CONJUNCTIONS',cx,cy-6); ctx.fillStyle='#2a5a3a'; ctx.font='10px monospace'; ctx.fillText(satelliteId||'',cx,cy+12); ctx.textAlign='left';}
    // Debris markers
    active.forEach(conj=>{
      const r=Math.min((conj.tca_offset_s||maxTCA)/maxTCA,1)*maxR;
      // Better angle hash — prime multiply for good distribution
      const hash=conj.deb_id.split('').reduce((a,c,i)=>a+c.charCodeAt(0)*(i+7)*31,0);
      const ang=((hash%360)-90)*Math.PI/180;
      const x=cx+r*Math.cos(ang),y=cy+r*Math.sin(ang);
      const dist=conj.min_dist_km??0;
      const crit=conj.severity==='CRITICAL'||dist<1;
      const warn=conj.severity==='WARNING'||(dist>=1&&dist<5);
      const col=crit?'#ef4444':warn?'#f59e0b':'#10b981';
      const glowCol=crit?'rgba(239,68,68,.4)':warn?'rgba(245,158,11,.4)':'rgba(16,185,129,.3)';
      // Approach line
      ctx.beginPath(); ctx.moveTo(cx,cy); ctx.lineTo(x,y);
      ctx.strokeStyle=col+'44'; ctx.lineWidth=.8; ctx.setLineDash([3,3]); ctx.stroke(); ctx.setLineDash([]);
      // Glow + marker
      ctx.shadowColor=glowCol; ctx.shadowBlur=12;
      ctx.beginPath(); ctx.arc(x,y,7,0,Math.PI*2); ctx.fillStyle=col; ctx.fill();
      ctx.shadowBlur=4;
      ctx.beginPath(); ctx.arc(x,y,3,0,Math.PI*2); ctx.fillStyle='#fff'; ctx.fill();
      // IMPORTANT: reset shadow after each marker
      ctx.shadowBlur=0; ctx.shadowColor='transparent';
      if(selected===conj.deb_id){ctx.strokeStyle='#fff'; ctx.lineWidth=1.5; ctx.beginPath(); ctx.arc(x,y,12,0,Math.PI*2); ctx.stroke();}
      ctx.fillStyle='#fff'; ctx.font='bold 8px monospace'; ctx.fillText(conj.deb_id.slice(-4),x+10,y-8);
      ctx.fillStyle='#aaa'; ctx.font='8px monospace'; ctx.fillText(`${dist.toFixed(2)}km`,x+10,y+2);
    });
    // Center satellite
    ctx.shadowColor='#3b82f6'; ctx.shadowBlur=18;
    ctx.beginPath(); ctx.arc(cx,cy,10,0,Math.PI*2); ctx.fillStyle='#3b82f6'; ctx.fill();
    ctx.shadowBlur=8;
    ctx.beginPath(); ctx.arc(cx,cy,5,0,Math.PI*2); ctx.fillStyle='#fff'; ctx.fill();
    ctx.shadowBlur=0; ctx.shadowColor='transparent';
    ctx.fillStyle='#fff'; ctx.font='bold 10px monospace'; ctx.textAlign='center';
    ctx.fillText((satelliteId||'SAT').slice(-6),cx,cy-16); ctx.textAlign='left';
    // Stats box
    const cr=active.filter(c=>c.severity==='CRITICAL'||(c.min_dist_km||0)<1).length;
    const wr=active.filter(c=>c.severity==='WARNING'||((c.min_dist_km||0)>=1&&(c.min_dist_km||0)<5)).length;
    const sf=active.filter(c=>c.severity==='SAFE'||(c.min_dist_km||0)>=5).length;
    ctx.fillStyle='rgba(0,0,0,.6)'; ctx.fillRect(W-112,8,104,72); ctx.strokeStyle='#2a4a6a'; ctx.lineWidth=.8; ctx.strokeRect(W-112,8,104,72);
    ctx.fillStyle='#5a8aaa'; ctx.font='bold 9px monospace'; ctx.fillText('CONJUNCTION STATS',W-106,24);
    [['CRITICAL',cr,'#ef4444'],['WARNING',wr,'#f59e0b'],['SAFE',sf,'#10b981']].forEach(([l,v,c],i)=>{ctx.fillStyle=c; ctx.font='10px monospace'; ctx.fillText(`${l}: ${v}`,W-106,38+i*14);});
    // Legend
    const ly=H-68;
    [['#ef4444','Critical (<1km)'],['#f59e0b','Warning (<5km)'],['#10b981','Safe (≥5km)']].forEach(([c,l],i)=>{
      ctx.fillStyle=c; ctx.fillRect(10,ly+i*16,10,10);
      ctx.fillStyle='#ccc'; ctx.font='9px monospace'; ctx.fillText(l,24,ly+i*16+9);
    });
    ctx.fillStyle='#4a6a8a'; ctx.font='8px monospace'; ctx.fillText('Radius = Time to TCA',W-155,H-10);
  },[active,satelliteId,selected,loading]);

  const handleClick=e=>{
    const canvas=canvasRef.current; if(!canvas||!active.length) return;
    const rect=canvas.getBoundingClientRect();
    const mx=(e.clientX-rect.left)*(canvas.width/rect.width);
    const my=(e.clientY-rect.top)*(canvas.height/rect.height);
    const cx=canvas.width/2,cy=canvas.height/2,maxR=Math.min(canvas.width,canvas.height)*.38;
    const maxTCA=Math.max(...active.map(c=>c.tca_offset_s||3600),3600);
    let found=null;
    active.forEach(conj=>{
      const r=Math.min((conj.tca_offset_s||maxTCA)/maxTCA,1)*maxR;
      const hash=conj.deb_id.split('').reduce((a,c,i)=>a+c.charCodeAt(0)*(i+7)*31,0);
      const ang=((hash%360)-90)*Math.PI/180;
      const x=cx+r*Math.cos(ang),y=cy+r*Math.sin(ang);
      if(Math.sqrt((mx-x)**2+(my-y)**2)<16) found=conj.deb_id;
    });
    setSelected(found);
  };

  return(
    <div className="relative w-full h-full">
      <canvas ref={canvasRef} width={500} height={500} className="w-full h-full cursor-crosshair" onClick={handleClick}/>
      {selected&&(
        <div className="absolute bottom-4 right-4 bg-gray-900/90 border border-blue-500 rounded-lg p-3 text-xs font-mono z-10">
          <h4 className="text-blue-400 font-bold mb-2">DEBRIS DETAIL</h4>
          {active.filter(c=>c.deb_id===selected).map((c,i)=>(
            <div key={i} className="space-y-1">
              <div><span className="text-gray-500">ID:</span> <span className="text-white">{c.deb_id}</span></div>
              <div><span className="text-gray-500">Dist:</span> <span className="text-white">{c.min_dist_km?.toFixed(3)} km</span></div>
              <div><span className="text-gray-500">TCA:</span> <span className="text-white">{c.tca_offset_s?.toFixed(0)}s</span></div>
              <div><span className="text-gray-500">Prob:</span> <span className="text-white">{c.prob?.toFixed(4)}</span></div>
              <div><span className="text-gray-500">Severity:</span>
                <span className={`ml-1 px-1.5 py-0.5 rounded text-xs ${c.severity==='CRITICAL'?'bg-red-700':c.severity==='WARNING'?'bg-yellow-700':'bg-green-700'}`}>{c.severity}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}