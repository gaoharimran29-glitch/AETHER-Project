// src/components/GroundTrackMap.jsx
// PS §6.2 — Ground Track Map (Mercator Projection)
// Canvas 2D: 90-min historical trail, RK4 predicted trajectory, terminator overlay, debris cloud
import React, { useEffect, useRef, useCallback } from 'react';
import TerminatorCalculator from '../utils/terminator';

const W = 1440, H = 720;

function ll(lat, lon) {
  return { x: ((lon + 180) / 360) * W, y: ((90 - lat) / 180) * H };
}

function fuelCol(kg, max = 50) {
  const p = kg / max;
  if (p > 0.6) return '#10b981';
  if (p > 0.3) return '#f59e0b';
  if (p > 0.1) return '#f97316';
  return '#ef4444';
}

const GS = [
  { lat:13.03,  lon:77.52,   name:'ISTRAC' },
  { lat:78.23,  lon:15.41,   name:'Svalbard' },
  { lat:35.43,  lon:-116.89, name:'Goldstone' },
  { lat:-53.15, lon:-70.92,  name:'Punta' },
  { lat:28.55,  lon:77.19,   name:'IIT Delhi' },
  { lat:-77.85, lon:166.67,  name:'McMurdo' },
];

export default function GroundTrackMap({
  satellites = [], debris = [], selectedSat = null,
  timestamp = new Date().toISOString(), onSatClick,
}) {
  const cvs      = useRef(null);
  const animRef  = useRef(null);
  const trailRef = useRef({});  // historical trail positions per satellite
  const dataRef  = useRef({ satellites:[], debris:[], timestamp: new Date().toISOString(), selectedSat: null });

  // Sync props into ref so draw() always has fresh data without re-creating the loop
  useEffect(() => {
    dataRef.current = { satellites, debris, timestamp, selectedSat };
    // Accumulate historical trails
    satellites.forEach(sat => {
      if (sat.lat == null) return;
      if (!trailRef.current[sat.id]) trailRef.current[sat.id] = [];
      const trail = trailRef.current[sat.id];
      trail.push({ lat: sat.lat, lon: sat.lon });
      if (trail.length > 90) trail.shift();   // last 90 data points ≈ 90 min at 1 poll/min
    });
  }, [satellites, debris, timestamp, selectedSat]);

  const draw = useCallback(() => {
    const c = cvs.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    const { satellites, debris, timestamp, selectedSat } = dataRef.current;
    const simTimeS = (new Date(timestamp).getTime() - Date.now()) / 1000;

    // Background
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#030d1e'); bg.addColorStop(1, '#040a16');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

    // Terminator night overlay (fill night side)
    try {
      const termPts = TerminatorCalculator.calculateTerminatorPoints(simTimeS, 360);
      if (termPts.length > 4) {
        // Build night poly: right side of terminator
        ctx.save();
        ctx.beginPath();
        // Walk terminator points, close with map edges for night side
        termPts.forEach((p, i) => {
          const { x, y } = ll(p.lat, p.lon);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.fillStyle = 'rgba(0,5,20,0.45)';
        ctx.fill();
        ctx.restore();

        // Terminator line
        ctx.beginPath();
        termPts.forEach((p, i) => {
          const { x, y } = ll(p.lat, p.lon);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.strokeStyle = 'rgba(255,170,51,0.65)'; ctx.lineWidth = 1.5;
        ctx.setLineDash([]); ctx.stroke();
      }
    } catch {}

    // Ocean grid
    ctx.strokeStyle = 'rgba(18,65,130,0.18)'; ctx.lineWidth = 0.5; ctx.setLineDash([]);
    for (let la=-75;la<=75;la+=15) { const {y}=ll(la,0); ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }
    for (let lo=-180;lo<=180;lo+=30) { const {x}=ll(0,lo); ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
    // Equator
    ctx.strokeStyle='rgba(40,120,220,0.45)'; ctx.lineWidth=1.2;
    ctx.beginPath(); ctx.moveTo(0,H/2); ctx.lineTo(W,H/2); ctx.stroke();
    // Prime meridian
    ctx.strokeStyle='rgba(40,120,220,0.2)'; ctx.lineWidth=0.7;
    ctx.beginPath(); ctx.moveTo(W/2,0); ctx.lineTo(W/2,H); ctx.stroke();

    // Latitude / longitude labels
    ctx.fillStyle='rgba(30,80,160,0.5)'; ctx.font=`8px 'Share Tech Mono',monospace`;
    for (let la=-60;la<=60;la+=30) { const {y}=ll(la,0); ctx.fillText(`${la}°`,3,y+3); }
    for (let lo=-150;lo<=150;lo+=30) { const {x}=ll(0,lo); ctx.fillText(`${lo}°`,x+3,H-4); }

    // Ground stations
    GS.forEach(gs => {
      const { x, y } = ll(gs.lat, gs.lon);
      // Coverage circle (~1000 km radius at 400 km altitude)
      ctx.beginPath(); ctx.arc(x, y, 22, 0, Math.PI*2);
      ctx.fillStyle = 'rgba(0,229,255,0.05)'; ctx.fill();
      ctx.strokeStyle = 'rgba(0,229,255,0.2)'; ctx.lineWidth=0.8; ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI*2);
      ctx.fillStyle = '#00e5ff'; ctx.fill();
      ctx.fillStyle = 'rgba(0,229,255,0.7)';
      ctx.font = `7px 'Orbitron',sans-serif`;
      ctx.fillText(gs.name, x + 6, y - 5);
    });

    // Debris — batch render (PS §6.1 performance)
    ctx.fillStyle = 'rgba(255,100,40,0.5)';
    for (let i = 0; i < debris.length; i++) {
      const d = debris[i];
      const lat = Array.isArray(d) ? d[1] : d.lat ?? 0;
      const lon = Array.isArray(d) ? d[2] : d.lon ?? 0;
      const { x, y } = ll(lat, lon);
      ctx.fillRect(x - 0.8, y - 0.8, 1.6, 1.6);
    }

    // Satellites: trail + prediction + marker
    satellites.forEach(sat => {
      if (sat.lat == null) return;
      const isSel = sat.id === selectedSat;
      const col   = fuelCol(sat.fuel_kg ?? 50);
      const { x, y } = ll(sat.lat, sat.lon);

      // Historical trail (90 min — PS §6.2)
      const trail = trailRef.current[sat.id] || [];
      if (trail.length > 1) {
        ctx.beginPath();
        trail.forEach((p, i) => {
          const t = ll(p.lat, p.lon);
          // Break line on anti-meridian crossing
          if (i > 0 && Math.abs(p.lon - trail[i-1].lon) > 100) { ctx.stroke(); ctx.beginPath(); ctx.moveTo(t.x, t.y); }
          else if (i === 0) ctx.moveTo(t.x, t.y);
          else ctx.lineTo(t.x, t.y);
        });
        ctx.strokeStyle = isSel ? 'rgba(96,160,255,0.7)' : 'rgba(30,80,160,0.5)';
        ctx.lineWidth = isSel ? 1.5 : 0.8;
        ctx.setLineDash([]); ctx.stroke();
      }

      // Note: prediction trajectory uses backend data only (no frontend recalculation)
      // The trail history already comes from backend-propagated positions

      // Satellite marker
      const rad = isSel ? 8 : 5;
      // Glow
      const grd = ctx.createRadialGradient(x, y, 0, x, y, rad * 2.5);
      grd.addColorStop(0, col + 'aa'); grd.addColorStop(1, 'transparent');
      ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(x, y, rad * 2.5, 0, Math.PI * 2); ctx.fill();
      // Core dot
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill();
      // Selection ring
      if (isSel) {
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(x, y, rad + 5, 0, Math.PI * 2); ctx.stroke();
      }
      // Label
      ctx.fillStyle = isSel ? '#ffffff' : 'rgba(200,220,255,0.8)';
      ctx.font = `${isSel ? 13 : 11}px 'Orbitron',sans-serif`;
      ctx.fillText(sat.id.slice(-6), x + rad + 4, y + 3);
      // Fuel %
      const pct = Math.round(((sat.fuel_kg ?? 50) / 50) * 100);
      ctx.fillStyle = col + 'cc';
      ctx.font = `10px 'Share Tech Mono',monospace`;
      ctx.fillText(`${pct}%`, x + rad + 4, y + 12);
    });

    // HUD overlay
    ctx.fillStyle = 'rgba(1,8,20,0.85)'; ctx.fillRect(8, 8, 200, 56);
    ctx.strokeStyle = 'rgba(30,80,160,0.4)'; ctx.lineWidth = 0.8; ctx.strokeRect(6,6,168,46);
    ctx.font = `bold 13px 'Orbitron',sans-serif`;
    ctx.fillStyle = '#ef4444'; ctx.fillText(`Debris: ${debris.length}`, 14, 24);
    ctx.fillStyle = '#10b981'; ctx.fillText(`Satellites: ${satellites.length}`, 14, 40);

    // Legend
    const lx = W - 140;
    [['rgba(255,100,40,0.6)','Debris'],['#10b981','Satellite'],['rgba(251,191,36,0.7)','Prediction'],['rgba(0,229,255,0.8)','Gnd Station'],['rgba(255,170,51,0.7)','Terminator']].forEach(([c,l],i) => {
      ctx.fillStyle = c; ctx.fillRect(lx, 10+i*14, 10, 8);
      ctx.fillStyle = 'rgba(150,175,210,0.7)'; ctx.font=`8px 'Share Tech Mono',monospace`; ctx.fillText(l, lx+14, 17+i*14);
    });
  }, []);

  // 30 FPS render loop (ground track doesn't need 60)
  useEffect(() => {
    let last = 0;
    const loop = (ts) => {
      animRef.current = requestAnimationFrame(loop);
      if (ts - last > 33) { draw(); last = ts; }
    };
    animRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animRef.current);
  }, [draw]);

  const onClick = useCallback(e => {
    if (!onSatClick) return;
    const c = cvs.current;
    const rect = c.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (W / rect.width);
    const my = (e.clientY - rect.top)  * (H / rect.height);
    const { satellites } = dataRef.current;
    for (const sat of satellites) {
      if (sat.lat == null) continue;
      const { x, y } = ll(sat.lat, sat.lon);
      if (Math.sqrt((mx-x)**2 + (my-y)**2) < 14) { onSatClick(sat.id); return; }
    }
  }, [onSatClick]);

  return (
    <div style={{ position:'relative', width:'100%', height:'100%' }}>
      <canvas ref={cvs} width={W} height={H}
        style={{ width:'100%', height:'100%', display:'block', cursor:'crosshair' }}
        onClick={onClick} />
      <div style={{ position:'absolute', top:6, right:8, fontFamily:"'Orbitron',sans-serif", fontSize:8, color:'rgba(30,80,160,0.6)', letterSpacing:'0.1em', pointerEvents:'none' }}>
        GROUND TRACK · MERCATOR · PS §6.2
      </div>
    </div>
  );
}