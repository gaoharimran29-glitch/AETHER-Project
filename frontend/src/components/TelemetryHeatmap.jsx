// src/components/TelemetryHeatmap.jsx
// PS §6.2 — Telemetry & Resource Heatmaps: fuel gauges, ΔV efficiency, uptime radar
import React, { useMemo, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, RadarChart, Radar, PolarGrid,
  PolarAngleAxis, PolarRadiusAxis, ScatterChart, Scatter, ZAxis, Cell,
} from 'recharts';

const INIT_FUEL = 50.0;  // kg PS §5.1

function fc(pct) {
  if (pct < 10) return '#ef4444';
  if (pct < 30) return '#f97316';
  if (pct < 60) return '#3b82f6';
  return '#10b981';
}

function FuelGauge({ sat }) {
  const fuel = sat.fuel_kg ?? sat.fuel ?? 0;
  const pct  = Math.max(0, Math.min(100, (fuel / INIT_FUEL) * 100));
  const col  = fc(pct);
  return (
    <div className="mb-2.5">
      <div className="flex justify-between items-center mb-1">
        <div className="flex items-center gap-2">
          <span style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:10, color:'#cbd5e1' }}>{sat.id}</span>
          <span className={`badge ${
            sat.status==='GRAVEYARD'?'badge-graveyard':
            pct<10?'badge-critical':pct<30?'badge-warning':'badge-active'
          }`}>{sat.status||'ACTIVE'}</span>
        </div>
        <span style={{ fontFamily:"'Orbitron',monospace", fontSize:12, color:col }}>{pct.toFixed(1)}%</span>
      </div>
      <div className="fuel-bar">
        <div className="fuel-bar-fill" style={{
          width:`${pct}%`,
          background:`linear-gradient(90deg,${col}80,${col})`,
          boxShadow:`0 0 8px ${col}55`,
        }} />
      </div>
      <div className="flex justify-between mt-0.5" style={{ fontSize:11, color:'var(--text-muted)', fontFamily:"'Share Tech Mono',monospace" }}>
        <span>{fuel.toFixed(1)} kg</span>
        <span>{(INIT_FUEL-fuel).toFixed(1)} kg used</span>
      </div>
    </div>
  );
}

const VIEWS = ['Fuel','Efficiency','Uptime','Score'];

const TT = {
  contentStyle:{ background:'#040f1f', border:'1px solid rgba(30,80,160,0.4)', borderRadius:3, fontFamily:"'Share Tech Mono',monospace", fontSize:10 },
  labelStyle:{ color:'#60a0d0' }, itemStyle:{ color:'#cbd5e1' },
};

export default function TelemetryHeatmap({ satellites=[], metrics={} }) {
  const [view, setView] = useState('Fuel');

  const fuelData = useMemo(() =>
    satellites.map(s => ({ name:s.id.slice(-7), fuel:s.fuel_kg??s.fuel??0, pct:((s.fuel_kg??s.fuel??0)/INIT_FUEL)*100, status:s.status, fullId:s.id }))
    .sort((a,b)=>b.fuel-a.fuel), [satellites]);

  const uptimeData = useMemo(() =>
    Object.entries(metrics.satellite_uptime_pct||{}).sort((a,b)=>b[1]-a[1]).slice(0,8)
    .map(([id,pct])=>({ subject:id.slice(-6), uptime:pct, fullMark:100 })), [metrics]);

  const scatterData = useMemo(() =>
    satellites.map(s=>({ satId:s.id, fuelUsed:INIT_FUEL-(s.fuel_kg??s.fuel??INIT_FUEL), uptime:metrics.satellite_uptime_pct?.[s.id]??100 })), [satellites,metrics]);

  const avoidRate = (metrics.maneuvers_executed??0) > 0
    ? Math.min(100,(((metrics.collisions_avoided??0)/metrics.maneuvers_executed)*100)).toFixed(1)
    : '—';

  const avgUptime = uptimeData.length > 0
    ? (uptimeData.reduce((s,d)=>s+d.uptime,0)/uptimeData.length).toFixed(1)
    : '—';

  return (
    <div className="w-full h-full flex flex-col gap-3 p-3 overflow-y-auto" style={{ background:'rgba(2,8,18,.95)' }}>
      {/* Header + view selector */}
      <div className="flex justify-between items-center flex-shrink-0">
        <div>
          <div style={{ fontFamily:"'Orbitron',sans-serif", fontSize:10, letterSpacing:'0.15em', color:'#3b82f6' }}>TELEMETRY & RESOURCE MONITOR</div>
          <div style={{ fontSize:8, color:'#475569', fontFamily:"'Share Tech Mono',monospace", marginTop:2 }}>Fleet-wide health · PS §6.2</div>
        </div>
        <div className="flex gap-1">
          {VIEWS.map(v => (
            <button key={v} onClick={()=>setView(v)} className="btn"
              style={{ background:view===v?'rgba(59,130,246,0.25)':'rgba(10,25,55,0.6)', borderColor:view===v?'rgba(59,130,246,0.6)':'rgba(30,80,160,0.3)', color:view===v?'#93c5fd':'#475569' }}>
              {v}
            </button>
          ))}
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-4 gap-2 flex-shrink-0">
        {[
          { l:'MANEUVERS',   v:metrics.maneuvers_executed??0,                          col:'#3b82f6' },
          { l:'AVOIDED',     v:metrics.collisions_avoided??0,                          col:'#10b981' },
          { l:'FUEL USED',   v:`${(metrics.fuel_used_total_kg??0).toFixed(1)} kg`,     col:'#f59e0b' },
          { l:'AVG UPTIME',  v:avgUptime !== '—' ? `${avgUptime}%` : '—',              col:'#8b5cf6' },
        ].map(s => (
          <div key={s.l} className="stat-card" style={{ color:s.col }}>
            <div className="stat-val">{s.v}</div>
            <div className="stat-label">{s.l}</div>
          </div>
        ))}
      </div>

      {/* ── FUEL VIEW ─────────────────────────────────────────────────────── */}
      {view === 'Fuel' && (
        <div className="space-y-3">
          <div className="panel p-3">
            <div className="panel-header" style={{ margin:'-12px -12px 12px', borderRadius:'4px 4px 0 0' }}>
              <div className="panel-title" style={{ color:'#f59e0b' }}>⛽ PROPELLANT BUDGET · PS §5.1</div>
              <div style={{ fontSize:8, color:'#475569', fontFamily:"'Share Tech Mono',monospace" }}>Isp=300s · g₀=9.807 m/s² · Tsiolkovsky</div>
            </div>
            {satellites.length === 0
              ? <div style={{ color:'#334155', fontSize:11, textAlign:'center', padding:'20px 0', fontFamily:"'Share Tech Mono',monospace" }}>No satellite data — ingest telemetry first</div>
              : satellites.map(s => <FuelGauge key={s.id} sat={s} />)
            }
          </div>
          {fuelData.length > 0 && (
            <div className="panel p-3">
              <div style={{ fontSize:11, color:'var(--text-muted)', fontFamily:"'Orbitron',sans-serif", letterSpacing:'0.12em', marginBottom:8 }}>FUEL COMPARISON CHART</div>
              <div style={{ height:160 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={fuelData} margin={{ top:4, right:4, left:0, bottom:4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(30,80,160,0.15)" />
                    <XAxis dataKey="name" stroke="#334155" tick={{ fontSize:8, fill:'#475569', fontFamily:"'Share Tech Mono',monospace" }} />
                    <YAxis stroke="#334155" tick={{ fontSize:8, fill:'#475569' }} domain={[0,50]} />
                    <Tooltip {...TT} formatter={(v)=>[`${v.toFixed(2)} kg`,'Fuel']} />
                    <Bar dataKey="fuel" radius={[2,2,0,0]}>
                      {fuelData.map((d,i) => <Cell key={i} fill={fc(d.pct)} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── EFFICIENCY VIEW ────────────────────────────────────────────────── */}
      {view === 'Efficiency' && (
        <div className="panel p-3 space-y-4">
          <div style={{ fontSize:12, color:'var(--yellow)', fontFamily:"'Orbitron',sans-serif", letterSpacing:'0.12em' }}>ΔV COST vs COLLISIONS AVOIDED</div>
          <div className="grid grid-cols-3 gap-2">
            {[
              { l:'Fuel Used',   v:`${(metrics.fuel_used_total_kg??0).toFixed(2)} kg`, col:'#f59e0b' },
              { l:'Avoided',     v:metrics.collisions_avoided??0,                       col:'#10b981' },
              { l:'Avoid Rate',  v:`${avoidRate}%`,                                     col:'#8b5cf6' },
            ].map(s => (
              <div key={s.l} className="stat-card" style={{ color:s.col }}>
                <div className="stat-val" style={{ fontSize:24 }}>{s.v}</div>
                <div className="stat-label">{s.l}</div>
              </div>
            ))}
          </div>
          {scatterData.length > 0 && (
            <>
              <div style={{ fontSize:11, color:'var(--text-muted)', fontFamily:"'Share Tech Mono',monospace" }}>Fuel Consumed vs Station-Keeping Uptime per Satellite</div>
              <div style={{ height:160 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <ScatterChart margin={{ top:8, right:8, bottom:8, left:8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(30,80,160,0.15)" />
                    <XAxis dataKey="fuelUsed" name="Fuel Used (kg)" stroke="#334155" tick={{ fontSize:8, fill:'#475569' }} label={{ value:'Fuel Used (kg)', position:'bottom', fill:'#334155', fontSize:8 }} />
                    <YAxis dataKey="uptime" name="Uptime %" stroke="#334155" tick={{ fontSize:8, fill:'#475569' }} domain={[0,100]} label={{ value:'Uptime%', angle:-90, position:'insideLeft', fill:'#334155', fontSize:8 }} />
                    <ZAxis range={[40,120]} />
                    <Tooltip {...TT} formatter={(v,n)=>[typeof v==='number'?v.toFixed(2):v, n]} />
                    <Scatter data={scatterData} fill="#3b82f6" opacity={0.8} />
                  </ScatterChart>
                </ResponsiveContainer>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── UPTIME VIEW ────────────────────────────────────────────────────── */}
      {view === 'Uptime' && (
        <div className="panel p-3 space-y-3">
          <div style={{ fontSize:12, color:'var(--cyan)', fontFamily:"'Orbitron',sans-serif", letterSpacing:'0.12em' }}>CONSTELLATION UPTIME RADAR</div>
          {uptimeData.length > 0 ? (
            <div style={{ height:220 }}>
              <ResponsiveContainer width="100%" height="100%">
                <RadarChart data={uptimeData} outerRadius="80%">
                  <PolarGrid stroke="rgba(30,80,160,0.2)" />
                  <PolarAngleAxis dataKey="subject" stroke="#334155" tick={{ fill:'#6b7280', fontSize:9, fontFamily:"'Share Tech Mono',monospace" }} />
                  <PolarRadiusAxis angle={30} domain={[0,100]} stroke="#334155" tick={{ fill:'#4b5563', fontSize:8 }} />
                  <Radar name="Uptime %" dataKey="uptime" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.3} />
                  <Tooltip {...TT} formatter={v=>[`${v.toFixed(1)}%`,'Uptime']} />
                </RadarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div style={{ color:'#334155', fontSize:11, textAlign:'center', padding:'20px 0', fontFamily:"'Share Tech Mono',monospace" }}>Run simulation to generate uptime data</div>
          )}
          {Object.keys(metrics.satellite_uptime_pct||{}).length > 0 && (
            <div style={{ maxHeight:180, overflowY:'auto' }}>
              {Object.entries(metrics.satellite_uptime_pct).map(([id,pct])=>(
                <div key={id} className="hud-row">
                  <span className="hud-label">{id}</span>
                  <div className="flex items-center gap-2">
                    <div style={{ width:60, height:4, background:'rgba(30,80,160,0.2)', borderRadius:2, overflow:'hidden' }}>
                      <div style={{ width:`${pct}%`, height:'100%', background:pct>90?'#10b981':pct>70?'#f59e0b':'#ef4444', borderRadius:2 }} />
                    </div>
                    <span style={{ color:pct>90?'#10b981':pct>70?'#f59e0b':'#ef4444', fontSize:10, fontFamily:"'Orbitron',monospace" }}>{pct.toFixed(1)}%</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── SCORE VIEW ─────────────────────────────────────────────────────── */}
      {view === 'Score' && (
        <div className="panel p-4 space-y-3">
          <div style={{ fontSize:12, color:'var(--purple)', fontFamily:"'Orbitron',sans-serif", letterSpacing:'0.12em' }}>MISSION EVALUATION</div>
          {[
            { l:'Safety Score (25%)',      v:`${metrics.collisions_avoided??0} conjunctions avoided`,            col:'#10b981' },
            { l:'Fuel Efficiency (20%)',   v:`${(metrics.fuel_used_total_kg??0).toFixed(2)} kg ΔV consumed`,     col:'#f59e0b' },
            { l:'Constellation Uptime (15%)', v:avgUptime!=='—'?`${avgUptime}% fleet average`:'Run simulation', col:'#3b82f6' },
            { l:'Algorithmic Speed (15%)', v:`${metrics.maneuvers_executed??0} maneuvers executed`,             col:'#06b6d4' },
          ].map(row => (
            <div key={row.l} className="hud-row" style={{ padding:'8px 0' }}>
              <div>
                <div style={{ fontSize:10, color:'#cbd5e1', fontFamily:"'Share Tech Mono',monospace" }}>{row.l}</div>
              </div>
              <div style={{ fontSize:11, fontWeight:'bold', color:row.col, fontFamily:"'Orbitron',monospace" }}>{row.v}</div>
            </div>
          ))}
          <div style={{ textAlign:'center', paddingTop:12 }}>
            {(() => {
              const score = Math.min(100, Math.round(((metrics.collisions_avoided??0)/Math.max(metrics.maneuvers_executed??1,1))*100));
              return (
                <>
                  <div style={{ fontSize:52, fontWeight:900, color:'#8b5cf6', fontFamily:"'Orbitron',sans-serif", textShadow:'0 0 30px rgba(139,92,246,0.5)' }}>{score}</div>
                  <div style={{ fontSize:11, color:'var(--text-muted)', fontFamily:"'Orbitron',monospace", letterSpacing:'0.2em' }}>EFFICIENCY SCORE / 100</div>
                  <div style={{ width:'100%', height:6, background:'rgba(30,50,100,0.4)', borderRadius:3, marginTop:8, overflow:'hidden' }}>
                    <div style={{ width:`${score}%`, height:'100%', background:'linear-gradient(90deg,#6d28d9,#8b5cf6)', borderRadius:3, transition:'width 0.8s ease', boxShadow:'0 0 10px rgba(139,92,246,0.5)' }} />
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}