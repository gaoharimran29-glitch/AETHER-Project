// src/components/BullseyePlot.jsx
// PS §6.2 — Conjunction Bullseye Plot (Polar Chart)
// Center = selected satellite; Radial = TCA; Angle = approach direction; Color = risk
import React, { useEffect, useRef, useState } from 'react';
import { fetchConjunctionForecast } from '../api/aetherApi';

export default function BullseyePlot({ satelliteId, conjunctions = [] }) {
  const canvasRef = useRef(null);
  const [local,    setLocal]    = useState([]);
  const [loading,  setLoading]  = useState(false);
  const [selected, setSelected] = useState(null);

  // Fetch if no external conjunctions passed
  useEffect(() => {
    if (conjunctions.length > 0) return;
    setLoading(true);
    fetchConjunctionForecast()
      .then(d => setLocal((d?.forecast || []).filter(c => !satelliteId || c.sat_id === satelliteId)))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [satelliteId, conjunctions.length]);

  const active = conjunctions.length > 0
    ? conjunctions.filter(c => !satelliteId || c.sat_id === satelliteId)
    : local;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2;
    const maxR = Math.min(W, H) * 0.39;

    ctx.clearRect(0, 0, W, H);

    // Background gradient
    const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR * 1.5);
    bg.addColorStop(0, '#030e22'); bg.addColorStop(1, '#010810');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

    // Normalise TCA radial axis
    const maxTCA = active.length > 0
      ? Math.max(...active.map(c => c.tca_offset_s || 3600), 3600)
      : 3600;

    // ── Rings ────────────────────────────────────────────────────────────────
    const ringFracs = [0.2, 0.4, 0.6, 0.8, 1.0];
    ringFracs.forEach((f, i) => {
      const r = f * maxR;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = i === 0 ? 'rgba(239,68,68,0.3)' : 'rgba(30,80,160,0.25)';
      ctx.lineWidth = i === 0 ? 1.5 : 0.7; ctx.stroke();
      // TCA label
      const tMin = Math.round(maxTCA * f / 60);
      ctx.fillStyle = 'rgba(70,100,150,0.7)';
      ctx.font = `11px 'Share Tech Mono',monospace`;
      ctx.fillText(`${tMin}m`, cx + r + 3, cy - 3);
    });

    // Crosshairs
    ctx.beginPath();
    ctx.moveTo(cx - maxR - 10, cy); ctx.lineTo(cx + maxR + 10, cy);
    ctx.moveTo(cx, cy - maxR - 10); ctx.lineTo(cx, cy + maxR + 10);
    ctx.strokeStyle = 'rgba(30,80,160,0.2)'; ctx.lineWidth = 0.6; ctx.stroke();

    // Degree ticks
    for (let deg = 0; deg < 360; deg += 30) {
      const rad = (deg - 90) * Math.PI / 180;
      const x1 = cx + (maxR + 5) * Math.cos(rad), y1 = cy + (maxR + 5) * Math.sin(rad);
      const x2 = cx + (maxR + 12) * Math.cos(rad), y2 = cy + (maxR + 12) * Math.sin(rad);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
      ctx.strokeStyle = 'rgba(40,80,140,0.5)'; ctx.lineWidth = 0.8; ctx.stroke();
      if (deg % 90 === 0) {
        ctx.fillStyle = 'rgba(60,110,190,0.8)';
        ctx.font = `11px 'Orbitron',monospace`;
        ctx.fillText(`${deg}°`, cx + (maxR + 18) * Math.cos(rad) - 8, cy + (maxR + 18) * Math.sin(rad) + 4);
      }
    }

    // Loading / empty state
    if (loading) {
      ctx.fillStyle = 'rgba(70,100,160,0.7)'; ctx.font = `12px 'Share Tech Mono',monospace`;
      ctx.textAlign = 'center'; ctx.fillText('LOADING…', cx, cy + 5); ctx.textAlign = 'left'; return;
    }
    if (!active.length) {
      ctx.fillStyle = 'rgba(16,185,129,0.6)'; ctx.font = `bold 11px 'Orbitron',monospace`;
      ctx.textAlign = 'center'; ctx.fillText('NO ACTIVE CONJUNCTIONS', cx, cy - 8);
      ctx.fillStyle = 'rgba(70,100,160,0.5)'; ctx.font = `9px 'Share Tech Mono',monospace`;
      ctx.fillText(satelliteId || 'SELECT A SATELLITE', cx, cy + 10);
      ctx.textAlign = 'left';
    }

    // ── Debris markers ────────────────────────────────────────────────────────
    active.forEach(conj => {
      const r = Math.min((conj.tca_offset_s || maxTCA) / maxTCA, 1) * maxR;
      // Stable angle hash (prime multiply — good distribution)
      const hash = conj.deb_id.split('').reduce((a, c, i) => a + c.charCodeAt(0) * (i + 7) * 31, 0);
      const ang = ((hash % 360) - 90) * Math.PI / 180;
      const x = cx + r * Math.cos(ang), y = cy + r * Math.sin(ang);
      const dist = conj.min_dist_km ?? 0;
      const isCrit = conj.severity === 'CRITICAL' || dist < 0.5;
      const isWarn = conj.severity === 'WARNING'  || (dist >= 0.5 && dist < 5);
      const col   = isCrit ? '#ef4444' : isWarn ? '#f59e0b' : '#10b981';
      const glow  = isCrit ? 'rgba(239,68,68,.45)' : isWarn ? 'rgba(245,158,11,.35)' : 'rgba(16,185,129,.3)';

      // Approach line
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y);
      ctx.strokeStyle = col + '33'; ctx.lineWidth = 0.8;
      ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]);

      // Glow + core
      ctx.shadowColor = glow; ctx.shadowBlur = 14;
      ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
      ctx.shadowBlur = 4;
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
      ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';

      // Selection ring
      if (selected === conj.deb_id) {
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(x, y, 14, 0, Math.PI * 2); ctx.stroke();
      }
      // Label
      ctx.fillStyle = '#ddd'; ctx.font = `bold 11px 'Share Tech Mono',monospace`;
      ctx.fillText(conj.deb_id.slice(-5), x + 11, y - 6);
      ctx.fillStyle = '#999'; ctx.font = `10px 'Share Tech Mono',monospace`;
      ctx.fillText(`${dist.toFixed(2)}km`, x + 11, y + 4);
    });

    // ── Centre satellite ──────────────────────────────────────────────────────
    ctx.shadowColor = '#3b82f6'; ctx.shadowBlur = 20;
    ctx.beginPath(); ctx.arc(cx, cy, 12, 0, Math.PI * 2); ctx.fillStyle = '#1d4ed8'; ctx.fill();
    ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2); ctx.fillStyle = '#93c5fd'; ctx.fill();
    ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
    ctx.fillStyle = '#dbeafe'; ctx.font = `bold 12px 'Orbitron',monospace`;
    ctx.textAlign = 'center';
    ctx.fillText((satelliteId || 'SAT').slice(-8), cx, cy - 18);
    ctx.textAlign = 'left';

    // Stats box
    const cr = active.filter(c => c.severity === 'CRITICAL' || (c.min_dist_km || 0) < 0.5).length;
    const wr = active.filter(c => c.severity === 'WARNING'  || ((c.min_dist_km || 0) >= 0.5 && (c.min_dist_km || 0) < 5)).length;
    const sf = active.filter(c => c.severity === 'SAFE'     || (c.min_dist_km || 0) >= 5).length;
    ctx.fillStyle = 'rgba(1,8,20,0.8)'; ctx.fillRect(W - 118, 8, 110, 80);
    ctx.strokeStyle = 'rgba(30,80,160,0.4)'; ctx.lineWidth = 0.8; ctx.strokeRect(W-118, 8, 110, 80);
    ctx.fillStyle = 'rgba(80,120,180,0.8)'; ctx.font = `bold 11px 'Orbitron',monospace`;
    ctx.fillText('CONJUNCTION DATA', W - 112, 24);
    [['CRITICAL', cr, '#ef4444'], ['WARNING', wr, '#f59e0b'], ['SAFE', sf, '#10b981']].forEach(([l, v, c], i) => {
      ctx.fillStyle = c; ctx.font = `9px 'Share Tech Mono',monospace`;
      ctx.fillText(`${l}: ${v}`, W - 112, 38 + i * 15);
    });

    // Legend
    const ly = H - 72;
    [['#ef4444','Critical (< 0.5km)'], ['#f59e0b','Warning (< 5km)'], ['#10b981','Safe (≥ 5km)']].forEach(([c, l], i) => {
      ctx.fillStyle = c; ctx.fillRect(10, ly + i * 17, 10, 10);
      ctx.fillStyle = 'rgba(180,200,230,0.7)'; ctx.font = `11px 'Share Tech Mono',monospace`;
      ctx.fillText(l, 25, ly + i * 17 + 9);
    });
    ctx.fillStyle = 'rgba(50,80,130,0.6)'; ctx.font = `10px 'Share Tech Mono',monospace`;
    ctx.fillText('Radius = Time To TCA (minutes)', W - 190, H - 10);
  }, [active, satelliteId, selected, loading]);

  // Click detection
  const handleClick = e => {
    const canvas = canvasRef.current;
    if (!canvas || !active.length) return;
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (canvas.width  / rect.width);
    const my = (e.clientY - rect.top)  * (canvas.height / rect.height);
    const cx = canvas.width / 2, cy = canvas.height / 2;
    const maxR = Math.min(canvas.width, canvas.height) * 0.39;
    const maxTCA = Math.max(...active.map(c => c.tca_offset_s || 3600), 3600);
    let found = null;
    active.forEach(conj => {
      const r   = Math.min((conj.tca_offset_s || maxTCA) / maxTCA, 1) * maxR;
      const hash = conj.deb_id.split('').reduce((a, c, i) => a + c.charCodeAt(0) * (i + 7) * 31, 0);
      const ang  = ((hash % 360) - 90) * Math.PI / 180;
      const x = cx + r * Math.cos(ang), y = cy + r * Math.sin(ang);
      if (Math.sqrt((mx - x) ** 2 + (my - y) ** 2) < 18) found = conj.deb_id;
    });
    setSelected(found);
  };

  return (
    <div className="relative w-full h-full">
      <canvas ref={canvasRef} width={480} height={480}
        className="w-full h-full cursor-crosshair" onClick={handleClick} />
      {selected && (
        <div className="absolute bottom-4 right-4 bg-gray-900/95 border border-blue-600/50 rounded p-3 text-xs z-10 min-w-36"
             style={{ fontFamily:"'Share Tech Mono',monospace" }}>
          <div className="text-blue-400 font-bold mb-2" style={{ fontFamily:"'Orbitron',sans-serif", fontSize:9 }}>DEBRIS DETAIL</div>
          {active.filter(c => c.deb_id === selected).map((c, i) => (
            <div key={i} className="space-y-1">
              <div><span className="text-gray-500">ID:</span>   <span className="text-white ml-1">{c.deb_id}</span></div>
              <div><span className="text-gray-500">Dist:</span> <span className="text-white ml-1">{c.min_dist_km?.toFixed(3)} km</span></div>
              <div><span className="text-gray-500">TCA:</span>  <span className="text-white ml-1">{c.tca_offset_s?.toFixed(0)} s</span></div>
              <div><span className="text-gray-500">Sev:</span>
                <span className={`ml-1 px-1.5 py-0.5 rounded text-xs ${c.severity==='CRITICAL'?'bg-red-800':c.severity==='WARNING'?'bg-yellow-800':'bg-green-800'}`}>{c.severity}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}