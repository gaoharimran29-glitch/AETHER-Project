// src/components/ManeuverTimeline.jsx
// PS §6.2 — Maneuver Timeline Gantt: burns, cooldown blocks, real blackout zones
// Fixed: real blackout from fetchNextPass(), all 5 nav buttons wired, z-30 not z-25
import React, { useEffect, useState, useCallback } from 'react';
import { format, addSeconds, differenceInSeconds, parseISO } from 'date-fns';
import { fetchBurnQueue, fetchStatus, fetchNextPass } from '../api/aetherApi';

export default function ManeuverTimeline({satelliteId, onBurnClick}){
  const [burns,setBurns]=useState([]);
  const [cooldowns,setCooldowns]=useState([]);
  const [blackouts,setBlackouts]=useState([]);
  const [now,setNow]=useState(new Date());
  const [sel,setSel]=useState(null);
  const [range,setRange]=useState({start:new Date(),end:addSeconds(new Date(),7200)});
  const [loading,setLoading]=useState(true);

  useEffect(()=>{
    const load=async()=>{
      try{
        const [queue,status,pass]=await Promise.all([
          fetchBurnQueue(),
          fetchStatus(),
          satelliteId?fetchNextPass(satelliteId):Promise.resolve(null),
        ]);
        if(status?.sim_timestamp) setNow(parseISO(status.sim_timestamp));
        const satBurns=queue.filter(b=>b.sat_id===satelliteId).sort((a,b)=>new Date(a.burn_time_iso)-new Date(b.burn_time_iso));
        setBurns(satBurns);
        setCooldowns(satBurns.map(b=>({id:`cd-${b.burn_id}`,start:new Date(b.burn_time_iso),end:addSeconds(new Date(b.burn_time_iso),600),burnId:b.burn_id})));
        // Real blackouts from backend pass predictor (PS §5.4)
        if(pass?.upcoming_passes){
          const bp=[]; let cursor=now;
          pass.upcoming_passes.forEach(p=>{
            const wait=p.estimated_wait_seconds||0;
            if(wait>120) bp.push({id:`bo-${p.station}`,start:addSeconds(cursor,30),end:addSeconds(cursor,wait-30),station:p.station});
            cursor=addSeconds(cursor,wait+600);
          });
          setBlackouts(bp.slice(0,6));
        }
      }catch(e){console.error(e);}finally{setLoading(false);}
    };
    load();
    const id=setInterval(load,2000);
    return()=>clearInterval(id);
  },[satelliteId]);

  useEffect(()=>{setRange({start:addSeconds(now,-1800),end:addSeconds(now,5400)});},[now]);

  const totalS=differenceInSeconds(range.end,range.start);
  const pct=useCallback(d=>Math.max(0,Math.min(100,(differenceInSeconds(d,range.start)/totalS)*100)),[range,totalS]);
  const inRange=useCallback(d=>d>=range.start&&d<=range.end,[range]);
  const shift=useCallback(delta=>setRange(r=>({start:addSeconds(r.start,delta),end:addSeconds(r.end,delta)})),[]);
  const jumpNow=useCallback(()=>setRange({start:addSeconds(now,-1800),end:addSeconds(now,5400)}),[now]);
  const handleBurnClick=useCallback(b=>{setSel(p=>p===b.burn_id?null:b.burn_id); if(onBurnClick) onBurnClick(b);},[onBurnClick]);

  const conflict=burns.some((b,i)=>i>0&&differenceInSeconds(new Date(b.burn_time_iso),new Date(burns[i-1].burn_time_iso))<600);

  if(loading) return <div className="w-full h-full flex items-center justify-center bg-gray-900 rounded"><span className="text-gray-500 text-sm font-mono animate-pulse">Loading timeline…</span></div>;

  return(
    <div className="w-full h-full bg-gray-900 rounded-lg p-4 font-mono flex flex-col gap-3 overflow-hidden">
      {/* Header */}
      <div className="flex justify-between items-center flex-shrink-0">
        <div>
          <h3 className="text-blue-400 font-bold text-sm tracking-widest">MANEUVER TIMELINE</h3>
          <p className="text-gray-600 text-xs">{satelliteId} · PS §6.2 Gantt</p>
        </div>
        <div className="text-green-400 text-sm">{format(now,'HH:mm:ss')} UTC</div>
      </div>
      {/* Ruler */}
      <div className="relative h-7 border-b border-gray-700 flex-shrink-0">
        {[-30,-15,0,15,30,45,60,75,90].map(min=>{
          const t=addSeconds(now,min*60); const left=pct(t);
          if(left<0||left>100) return null;
          return(<div key={min} className="absolute bottom-0 -translate-x-1/2" style={{left:`${left}%`}}><div className="w-px h-2 bg-gray-600"/><div className="text-gray-600 text-xs mt-0.5 whitespace-nowrap">{min===0?'NOW':`${min>0?'+':''}${min}m`}</div></div>);
        })}
        <div className="absolute top-0 bottom-0 w-px bg-green-500 z-20" style={{left:`${pct(now)}%`}}><div className="w-2 h-2 bg-green-500 rounded-full -translate-x-1/2"/></div>
      </div>
      {/* Timeline */}
      <div className="relative flex-1 min-h-0 bg-gray-950 rounded border border-gray-800 overflow-hidden">
        {[0,25,50,75,100].map(p=><div key={p} className="absolute top-0 bottom-0 w-px bg-gray-800/50" style={{left:`${p}%`}}/>)}
        {/* Blackout zones */}
        {blackouts.map(bp=>{
          const s=Math.max(pct(bp.start),0),e=Math.min(pct(bp.end),100);
          if(e<=s) return null;
          return(<div key={bp.id} className="absolute top-0 bottom-0 bg-red-900/25 border-l border-r border-red-700/60" style={{left:`${s}%`,width:`${e-s}%`}}><div className="absolute top-1 left-1 text-red-400 text-xs">NO LOS</div><div className="absolute bottom-1 right-1 text-red-700 text-xs">{bp.station}</div></div>);
        })}
        {/* Cooldown zones */}
        {cooldowns.map(cd=>{
          const s=Math.max(pct(cd.start),0),e=Math.min(pct(cd.end),100);
          if(e<=s) return null;
          return(<div key={cd.id} className="absolute top-0 bottom-0 bg-yellow-900/30 border-l border-r border-yellow-600/60" style={{left:`${s}%`,width:`${e-s}%`}}><div className="absolute top-1 left-1 text-yellow-400 text-xs">COOLDOWN</div><div className="absolute bottom-1 right-1 text-yellow-700 text-xs">600s</div></div>);
        })}
        {/* Burns */}
        {burns.map(burn=>{
          const bt=new Date(burn.burn_time_iso); if(!inRange(bt)) return null;
          const left=pct(bt); const isSel=sel===burn.burn_id;
          const dv=Math.sqrt((burn.dv_x||0)**2+(burn.dv_y||0)**2+(burn.dv_z||0)**2);
          return(<div key={burn.burn_id} className="absolute top-0 bottom-0 cursor-pointer" style={{left:`${left}%`,zIndex:isSel?30:20}} onClick={()=>handleBurnClick(burn)}>
            <div className={`absolute top-0 bottom-0 w-0.5 ${isSel?'bg-blue-300':'bg-blue-500'}`}/>
            <div className={`absolute -top-1 left-1 px-1.5 py-0.5 rounded text-xs font-bold whitespace-nowrap ${isSel?'bg-blue-400 text-white ring-1 ring-white':'bg-blue-600 text-white'}`}>{burn.burn_id?.slice(-6)||'BURN'}</div>
            {isSel&&<div className="absolute top-6 left-1 bg-gray-800 border border-blue-500 rounded p-2 text-xs z-40 w-44">
              <div className="text-blue-400 font-bold mb-1">Burn Details</div>
              <div className="text-gray-400">Time: <span className="text-white">{format(bt,'HH:mm:ss')}</span></div>
              <div className="text-gray-400">ΔV: <span className="text-white">[{burn.dv_x?.toFixed(3)},{burn.dv_y?.toFixed(3)},{burn.dv_z?.toFixed(3)}]</span></div>
              <div className="text-gray-400">|ΔV|: <span className="text-yellow-400">{dv.toFixed(4)} km/s</span></div>
            </div>}
          </div>);
        })}
        {/* Now line */}
        <div className="absolute top-0 bottom-0 w-px bg-green-500 z-10" style={{left:`${pct(now)}%`}}><div className="text-green-400 text-xs absolute top-1 left-1 bg-gray-950 px-0.5">NOW</div></div>
      </div>
      {/* Nav buttons — ALL WIRED */}
      <div className="flex justify-between items-center flex-shrink-0">
        <div className="flex gap-1">
          {[{l:'⏪ 1h',d:-3600},{l:'◀ 15m',d:-900},{l:'NOW',d:null},{l:'15m ▶',d:900},{l:'1h ▶▶',d:3600}].map(btn=>(
            <button key={btn.l} onClick={btn.d===null?jumpNow:()=>shift(btn.d)} className={`px-2 py-1 text-xs rounded border transition ${btn.d===null?'bg-blue-600 border-blue-500 text-white hover:bg-blue-500':'bg-gray-800 border-gray-700 text-gray-300 hover:bg-gray-700'}`}>{btn.l}</button>
          ))}
        </div>
        <div className="text-gray-600 text-xs">{format(range.start,'HH:mm')} – {format(range.end,'HH:mm')}</div>
      </div>
      {/* Legend */}
      <div className="flex gap-4 text-xs flex-shrink-0">
        {[['bg-blue-600','Burn'],['bg-yellow-900/60 border border-yellow-600','Cooldown 600s'],['bg-red-900/50 border border-red-700','Blackout (No LOS'],['bg-green-500','Now']].map(([cl,lbl])=>(
          <div key={lbl} className="flex items-center gap-1"><div className={`w-3 h-3 rounded ${cl}`}/><span className="text-gray-600">{lbl}</span></div>
        ))}
      </div>
      {/* Burns list */}
      <div className="flex-shrink-0 max-h-28 overflow-y-auto bg-gray-950 rounded p-2">
        <div className="text-gray-600 text-xs mb-1 tracking-widest">SCHEDULED BURNS</div>
        {burns.length===0?<div className="text-gray-700 text-xs text-center py-2">No scheduled burns</div>:burns.map(burn=>{
          const bt=new Date(burn.burn_time_iso); const secs=differenceInSeconds(bt,now); const past=secs<0;
          const dv=Math.sqrt((burn.dv_x||0)**2+(burn.dv_y||0)**2+(burn.dv_z||0)**2);
          return(<div key={burn.burn_id} onClick={()=>handleBurnClick(burn)} className={`flex justify-between items-center p-1.5 rounded mb-0.5 cursor-pointer text-xs ${past?'bg-gray-800/40':'bg-blue-900/20'} ${sel===burn.burn_id?'ring-1 ring-blue-500':''}`}>
            <span className={`font-bold ${past?'text-gray-600':'text-blue-400'}`}>{burn.burn_id}</span>
            <span className={past?'text-gray-600':secs<300?'text-yellow-400':'text-green-400'}>{past?`${Math.abs(secs)}s ago`:`in ${secs}s`}</span>
            <span className="text-gray-600">|ΔV|:{dv.toFixed(3)}</span>
          </div>);
        })}
      </div>
      {conflict&&<div className="bg-red-900/30 border border-red-700 rounded p-2 text-xs text-red-400 flex-shrink-0">⚠ Burns within 600s cooldown — PS §5.1 violation</div>}
    </div>
  );
}