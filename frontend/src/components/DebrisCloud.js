// src/components/DebrisCloud.js
// PS §6.1 — Canvas 2D renderer for 10,000+ debris at 60 FPS
// Complete rewrite — previous DOM version would crash browser at 500+ objects
import React, { useEffect, useRef, useCallback } from 'react';
import { fetchSnapshot } from '../api/aetherApi';

const CW=800, CH=400;
const ll=(lat,lon)=>({x:((lon+180)/360)*CW,y:((90-lat)/180)*CH});

export default function DebrisCloud({externalDebris=null, externalSatellites=null}){
  const cvs=useRef(null);
  const dataRef=useRef({debris:[],satellites:[]});
  const animRef=useRef(null);

  const draw=useCallback(()=>{
    const c=cvs.current; if(!c) return;
    const ctx=c.getContext('2d');
    const{debris,satellites}=dataRef.current;
    ctx.fillStyle='#040e1a'; ctx.fillRect(0,0,CW,CH);
    // Grid
    ctx.strokeStyle='rgba(20,65,125,.2)'; ctx.lineWidth=.5;
    for(let la=-80;la<=80;la+=20){const y=((90-la)/180)*CH; ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(CW,y); ctx.stroke();}
    for(let lo=-180;lo<=180;lo+=30){const x=((lo+180)/360)*CW; ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,CH); ctx.stroke();}
    ctx.strokeStyle='rgba(40,110,210,.4)'; ctx.lineWidth=.9;
    ctx.beginPath(); ctx.moveTo(0,CH/2); ctx.lineTo(CW,CH/2); ctx.stroke();
    // Debris — batch fillRect (no loops with complex ops)
    ctx.fillStyle='rgba(255,110,50,.55)';
    for(let i=0;i<debris.length;i++){
      const d=debris[i];
      const lat=Array.isArray(d)?d[1]:d.lat;
      const lon=Array.isArray(d)?d[2]:d.lon;
      const{x,y}=ll(lat,lon);
      ctx.fillRect(x-.8,y-.8,1.6,1.6);
    }
    // Satellites
    satellites.forEach(sat=>{
      if(sat.lat===undefined) return;
      const{x,y}=ll(sat.lat,sat.lon);
      const pct=(sat.fuel_kg??50)/50;
      const col=pct>.6?'#10b981':pct>.3?'#f59e0b':'#ef4444';
      const grd=ctx.createRadialGradient(x,y,0,x,y,7);
      grd.addColorStop(0,col+'cc'); grd.addColorStop(1,'transparent');
      ctx.fillStyle=grd; ctx.beginPath(); ctx.arc(x,y,7,0,Math.PI*2); ctx.fill();
      ctx.fillStyle=col; ctx.beginPath(); ctx.arc(x,y,3,0,Math.PI*2); ctx.fill();
      ctx.fillStyle='#fff'; ctx.font='9px monospace';
      ctx.fillText(sat.id.slice(-6),x+5,y-4);
    });
    // Stats HUD
    ctx.fillStyle='rgba(0,0,0,.6)'; ctx.fillRect(4,4,155,38);
    ctx.fillStyle='#ef4444'; ctx.font='bold 11px monospace'; ctx.fillText(`Debris: ${debris.length}`,9,18);
    ctx.fillStyle='#10b981'; ctx.fillText(`Satellites: ${satellites.length}`,9,34);
    ctx.fillStyle='rgba(255,110,50,.55)'; ctx.fillRect(CW-108,4,10,10);
    ctx.fillStyle='#9ca3af'; ctx.font='9px monospace'; ctx.fillText('Debris',CW-94,13);
    ctx.fillStyle='#10b981'; ctx.beginPath(); ctx.arc(CW-103,25,4,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#9ca3af'; ctx.fillText('Satellite',CW-94,28);
  },[]);

  // Poll backend if no external data
  useEffect(()=>{
    if(externalDebris!==null||externalSatellites!==null) return;
    const load=async()=>{const snap=await fetchSnapshot(); if(!snap) return; dataRef.current={debris:snap.debris_cloud||[],satellites:snap.satellites||[]};};
    load(); const id=setInterval(load,2000); return()=>clearInterval(id);
  },[externalDebris,externalSatellites]);

  // Sync external data
  useEffect(()=>{
    if(externalDebris===null&&externalSatellites===null) return;
    dataRef.current={debris:externalDebris||[],satellites:externalSatellites||[]};
  },[externalDebris,externalSatellites]);

  // 60 FPS loop
  useEffect(()=>{
    const loop=()=>{draw(); animRef.current=requestAnimationFrame(loop);};
    animRef.current=requestAnimationFrame(loop);
    return()=>cancelAnimationFrame(animRef.current);
  },[draw]);

  return(<canvas ref={cvs} width={CW} height={CH} style={{width:'100%',height:'100%',display:'block'}}/>);
}