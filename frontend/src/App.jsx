// src/App.jsx — AETHER Mission Control Dashboard
// National Space Hackathon 2026, IIT Delhi
import React, { useEffect, useState, useCallback, useRef } from 'react';
import ThreeScene       from './components/ThreeScene';
import GroundTrackMap   from './components/GroundTrackMap';
import BullseyePlot     from './components/BullseyePlot';
import TelemetryHeatmap from './components/TelemetryHeatmap';
import ManeuverTimeline from './components/ManeuverTimeline';
import DataIngest       from './components/DataIngest';
import {
  fetchSnapshot, fetchStatus, fetchMetrics,
  fetchConjunctionForecast, fetchAlertHistory,
  simulateStep, startSimulation, stopSimulation, resetSimulation,
  checkBackendHealth,
} from './api/aetherApi';

function fmtTime(s) {
  if (!s || s < 0) return '0h 00m 00s';
  return `${Math.floor(s/3600)}h ${String(Math.floor((s%3600)/60)).padStart(2,'0')}m ${String(Math.floor(s%60)).padStart(2,'0')}s`;
}
function fuelColor(pct) {
  if (pct > 60) return '#34d399';
  if (pct > 30) return '#fbbf24';
  if (pct > 10) return '#fb923c';
  return '#f87171';
}

// ── Panel ──────────────────────────────────────────────────────────────────────
function Panel({ title, sub, color='#4d94ff', dot=true, children, style={} }) {
  return (
    <div className="panel" style={style}>
      <div className="panel-header">
        <div>
          <div className="panel-title" style={{ color }}>{title}</div>
          {sub && <div className="panel-sub">{sub}</div>}
        </div>
        {dot && <div className="panel-dot dot-blink" style={{ background:color, boxShadow:`0 0 6px ${color}` }} />}
      </div>
      <div style={{ flex:1, minHeight:0, overflow:'hidden' }}>{children}</div>
    </div>
  );
}

// ── Stat card ──────────────────────────────────────────────────────────────────
function StatCard({ label, value, color, icon }) {
  return (
    <div className="stat-card" style={{ color }}>
      <div style={{ fontSize:11, color:'var(--text-muted)', fontFamily:'var(--font-hud)', letterSpacing:'.1em', marginBottom:4 }}>{icon} {label}</div>
      <div className="stat-val">{value}</div>
    </div>
  );
}

// ── App ────────────────────────────────────────────────────────────────────────
export default function App() {
  const [snapshot,     setSnapshot]     = useState(null);
  const [status,       setStatus]       = useState({ simulation_running:false, satellites:0, debris_objects:0, elapsed_sim_time_s:0 });
  const [metrics,      setMetrics]      = useState({ maneuvers_executed:0, collisions_avoided:0, fuel_used_total_kg:0, satellite_uptime_pct:{}, elapsed_sim_time_s:0 });
  const [conjunctions, setConjunctions] = useState([]);
  const [alerts,       setAlerts]       = useState([]);
  const [selectedSat,  setSelectedSat]  = useState(null);
  const [tab,          setTab]          = useState('ingest');
  const [healthy,      setHealthy]      = useState(null);
  const [loading,      setLoading]      = useState(true);
  const [notifs,       setNotifs]       = useState([]);
  const [simSpeed,     setSimSpeed]     = useState(60);
  const [simRunning,   setSimRunning]   = useState(false);
  const healthRef = useRef(null);

  const notify = useCallback((type, title, msg='') => {
    const id = Date.now() + Math.random();
    setNotifs(p => [{ id, type, title, msg }, ...p].slice(0,5));
    setTimeout(() => setNotifs(p => p.filter(n => n.id !== id)), 5000);
  }, []);

  const refresh = useCallback(async () => {
    const [snap, stat, met, conj, hist] = await Promise.all([
      fetchSnapshot(), fetchStatus(), fetchMetrics(),
      fetchConjunctionForecast(), fetchAlertHistory(),
    ]);
    if (snap) {
      setSnapshot(snap);
      if (!selectedSat && snap.satellites?.length > 0) setSelectedSat(snap.satellites[0].id);
    }
    setStatus(stat);
    setMetrics(met);
    setConjunctions(conj?.forecast || []);
    setAlerts(Array.isArray(hist) ? hist : []);
    setSimRunning(stat?.simulation_running || false);
  }, [selectedSat]);

  useEffect(() => {
    const init = async () => {
      let attempts = 0;
      const check = async () => {
        attempts++;
        const h = await checkBackendHealth();
        setHealthy(h.healthy);
        if (h.healthy) {
          notify('ok','Backend connected','Port 8000 responding');
          await refresh();
          const s = await fetchStatus();
          if ((s?.satellites||0) > 0) setTab('dashboard');
        } else if (attempts < 5) {
          healthRef.current = setTimeout(check, 2000);
        } else {
          notify('warn','Backend offline','Run: uvicorn main:app --port 8000');
        }
        setLoading(false);
      };
      await check();
    };
    init();
    const poll = setInterval(async () => {
      const h = await checkBackendHealth();
      setHealthy(h.healthy);
      if (h.healthy) await refresh();
    }, 3000);
    return () => { clearInterval(poll); if (healthRef.current) clearTimeout(healthRef.current); };
  }, []);

  const sats     = snapshot?.satellites || [];
  const deb      = snapshot?.debris_cloud || [];
  const critCnt  = conjunctions.filter(c => c.severity === 'CRITICAL').length;
  const warnCnt  = conjunctions.filter(c => c.severity === 'WARNING').length;

  const doStep  = async () => { try { const r=await simulateStep(simSpeed); notify('info',`Step +${simSpeed}s`,`Collisions: ${r.collisions_detected}  Maneuvers: ${r.maneuvers_executed}`); await refresh(); } catch(e){ notify('error','Step failed',e.message); } };
  const doStart = async () => { try { await startSimulation(simSpeed); setSimRunning(true); notify('ok','Simulation running',`dt = ${simSpeed}s`); } catch(e){ notify('error','Start failed',e.message); } };
  const doStop  = async () => { try { await stopSimulation(); setSimRunning(false); notify('info','Simulation stopped'); } catch(e){ notify('error','Stop failed',e.message); } };
  const doReset = async () => { try { await resetSimulation(); setSimRunning(false); await refresh(); notify('warn','Reset','All simulation data cleared'); } catch(e){ notify('error','Reset failed',e.message); } };

  // ── Loading screen ──────────────────────────────────────────────────────────
  if (loading) return (
    <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', background:'var(--bg-root)' }}>
      <div style={{ textAlign:'center' }}>
        <div style={{ position:'relative', width:130, height:130, margin:'0 auto 36px' }}>
          <div style={{ position:'absolute', inset:0, border:'1px solid rgba(77,148,255,.1)', borderRadius:'50%' }} className="ping-out" />
          <div style={{ position:'absolute', inset:12, border:'1px solid rgba(77,148,255,.2)', borderRadius:'50%' }} className="spin-cw" />
          <div style={{ position:'absolute', inset:24, border:'1px solid rgba(77,148,255,.4)', borderRadius:'50%' }} className="spin-ccw" />
          <div style={{ position:'absolute', inset:38, border:'1px solid rgba(77,148,255,.6)', borderRadius:'50%' }} />
          <div style={{ position:'absolute', inset:50, background:'rgba(77,148,255,.15)', borderRadius:'50%' }} />
        </div>
        <div style={{ fontFamily:'var(--font-hud)', fontSize:42, fontWeight:900, letterSpacing:'.3em', color:'var(--blue)', textShadow:'0 0 40px rgba(77,148,255,.6)', marginBottom:10 }}>AETHER</div>
        <div style={{ fontFamily:'var(--font-hud)', fontSize:11, letterSpacing:'.2em', color:'var(--text-muted)', marginBottom:28, textTransform:'uppercase' }}>Autonomous Constellation Manager</div>
        <div style={{ fontFamily:'var(--font-mono)', fontSize:12, color:'var(--text-faint,#1e3a5f)', marginBottom:28 }}>Connecting to backend on port 8000…</div>
        <div style={{ display:'flex', justifyContent:'center', gap:10 }}>
          {[0,.2,.4].map(d=>(
            <div key={d} style={{ width:8, height:8, borderRadius:'50%', background:'rgba(77,148,255,.45)', animation:`dot-blink 1.2s ${d}s ease-in-out infinite` }} />
          ))}
        </div>
        <div style={{ fontFamily:'var(--font-hud)', fontSize:10, letterSpacing:'.2em', color:'#0f1f38', marginTop:48, textTransform:'uppercase' }}>National Space Hackathon 2026 · IIT Delhi</div>
      </div>
    </div>
  );

  // ── Main render ─────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight:'100vh', display:'flex', flexDirection:'column', background:'var(--bg-root)', color:'var(--text-primary)' }}>

      {/* TOASTS */}
      <div style={{ position:'fixed', top:16, right:16, zIndex:9900, display:'flex', flexDirection:'column', gap:10, width:320, pointerEvents:'none' }}>
        {notifs.map(n => {
          const colors = { error:['rgba(50,5,5,.97)','rgba(248,113,113,.4)'], warn:['rgba(40,25,5,.97)','rgba(251,191,36,.4)'], ok:['rgba(5,25,15,.97)','rgba(52,211,153,.4)'], info:['rgba(5,12,35,.97)','rgba(77,148,255,.4)'] };
          const [bg, border] = colors[n.type] || colors.info;
          const icons = { error:'✗', warn:'⚠', ok:'✓', info:'ℹ' };
          return (
            <div key={n.id} className="toast" style={{ background:bg, border:`1px solid ${border}`, borderRadius:8, padding:'12px 14px', display:'flex', gap:10, pointerEvents:'auto', boxShadow:'0 8px 24px rgba(0,0,0,.5)' }}>
              <span style={{ fontSize:16, flexShrink:0 }}>{icons[n.type]||'ℹ'}</span>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontFamily:'var(--font-hud)', fontSize:11, color:'#fff', letterSpacing:'.05em', marginBottom:2 }}>{n.title}</div>
                {n.msg && <div style={{ fontFamily:'var(--font-mono)', fontSize:11, color:'var(--text-muted)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{n.msg}</div>}
              </div>
              <button onClick={()=>setNotifs(p=>p.filter(x=>x.id!==n.id))} style={{ color:'var(--text-muted)', background:'none', border:'none', cursor:'pointer', fontSize:14, flexShrink:0, lineHeight:1 }}>✕</button>
            </div>
          );
        })}
      </div>

      {/* HEADER */}
      <header style={{ background:'rgba(4,8,20,.98)', borderBottom:'1px solid var(--border)', backdropFilter:'blur(20px)', position:'sticky', top:0, zIndex:200, flexShrink:0 }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'0 20px', height:58 }}>

          {/* Logo + status */}
          <div style={{ display:'flex', alignItems:'center', gap:20 }}>
            <div style={{ display:'flex', alignItems:'center', gap:12 }}>
              <div style={{ width:40, height:40, borderRadius:8, background:'linear-gradient(135deg,#1d4ed8,#7c3aed)', display:'flex', alignItems:'center', justifyContent:'center', boxShadow:'0 0 20px rgba(77,148,255,.3)' }}>
                <span style={{ fontFamily:'var(--font-hud)', fontWeight:900, fontSize:18, color:'#fff' }}>A</span>
              </div>
              <div>
                <div style={{ fontFamily:'var(--font-hud)', fontWeight:900, fontSize:18, letterSpacing:'.22em', color:'var(--blue)', textShadow:'0 0 20px rgba(77,148,255,.4)' }}>AETHER</div>
                <div style={{ fontFamily:'var(--font-mono)', fontSize:10, color:'var(--text-muted)', letterSpacing:'.12em' }}>AUTONOMOUS CONSTELLATION MANAGER</div>
              </div>
            </div>

            {/* Backend status */}
            <div style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 12px', borderRadius:6, border:`1px solid ${healthy?'rgba(52,211,153,.3)':healthy===null?'rgba(251,191,36,.3)':'rgba(248,113,113,.3)'}`, background:healthy?'rgba(5,25,15,.5)':healthy===null?'rgba(40,25,5,.5)':'rgba(40,5,5,.5)' }}>
              <div style={{ width:8, height:8, borderRadius:'50%', background:healthy?'#34d399':healthy===null?'#fbbf24':'#f87171', boxShadow:`0 0 6px ${healthy?'#34d399':healthy===null?'#fbbf24':'#f87171'}` }} className="dot-blink" />
              <span style={{ fontFamily:'var(--font-hud)', fontSize:11, letterSpacing:'.08em', color:healthy?'#34d399':healthy===null?'#fbbf24':'#f87171', fontWeight:700 }}>
                {healthy===null?'CONNECTING…':healthy?'BACKEND LIVE':'OFFLINE'}
              </span>
            </div>

            {/* Critical alert */}
            {critCnt > 0 && (
              <div style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 12px', borderRadius:6, border:'1px solid rgba(248,113,113,.4)', background:'rgba(50,5,5,.6)' }} className="dot-blink">
                <span style={{ fontFamily:'var(--font-hud)', fontSize:11, letterSpacing:'.08em', color:'#f87171', fontWeight:700 }}>⚠ {critCnt} CRITICAL</span>
              </div>
            )}

            {/* Live counts */}
            {healthy && (
              <div style={{ display:'flex', gap:16, padding:'6px 14px', borderRadius:6, background:'rgba(10,22,50,.5)', border:'1px solid var(--border)' }}>
                {[['Sats',sats.length||status.satellites,'var(--blue)'],['Debris',deb.length||status.debris_objects,'var(--orange)'],['Maneuvers',metrics.maneuvers_executed||0,'var(--green)']].map(([l,v,c])=>(
                  <div key={l} style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:1 }}>
                    <span style={{ fontFamily:'var(--font-hud)', fontSize:16, fontWeight:800, color:c, lineHeight:1 }}>{v}</span>
                    <span style={{ fontFamily:'var(--font-hud)', fontSize:9, color:'var(--text-muted)', letterSpacing:'.08em', textTransform:'uppercase' }}>{l}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Sim controls */}
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <div style={{ display:'flex', gap:4, background:'rgba(10,22,50,.6)', border:'1px solid var(--border)', borderRadius:6, padding:5 }}>
              {[
                { l:'⏯ STEP',  fn:doStep,  col:'#93c5fd' },
                { l:'▶ START', fn:doStart, col:simRunning?'#34d399':'var(--text-muted)' },
                { l:'⏸ STOP',  fn:doStop,  col:'#fb923c' },
                { l:'↺ RESET', fn:doReset, col:'#f87171' },
              ].map(b=>(
                <button key={b.l} onClick={b.fn} className="btn btn-ghost"
                  style={{ color:b.col, fontFamily:'var(--font-hud)', fontSize:11, padding:'6px 13px', border:'none', background:'transparent' }}>
                  {b.l}
                </button>
              ))}
            </div>

            <select value={simSpeed} onChange={e=>setSimSpeed(+e.target.value)} className="field-input"
              style={{ width:'auto', padding:'7px 11px', fontSize:12 }}>
              {[1,10,60,300,3600].map(v=><option key={v} value={v}>dt = {v}s</option>)}
            </select>

            <div style={{ padding:'7px 14px', background:'rgba(10,22,50,.6)', border:'1px solid var(--border)', borderRadius:6, minWidth:130 }}>
              <span style={{ fontFamily:'var(--font-mono)', fontSize:11, color:'var(--text-muted)' }}>T+  </span>
              <span style={{ fontFamily:'var(--font-hud)', fontSize:12, color:'var(--green)', fontWeight:700 }}>{fmtTime(status.elapsed_sim_time_s||0)}</span>
            </div>
          </div>
        </div>

        {/* Tab bar */}
        <div style={{ display:'flex', padding:'0 20px', borderTop:'1px solid var(--border)', overflowX:'auto' }}>
          {[
            { id:'ingest',        icon:'📥', label:'Simulation Control',      badge:!healthy?'OFFLINE':null, badgeRed:!healthy },
            { id:'dashboard',     icon:'⬡',  label:'Dashboard' },
            { id:'satellites',    icon:'🛰',  label:'Satellites' },
            { id:'conjunctions',  icon:'⚠',  label:'Conjunctions',     badge:critCnt+warnCnt||null, badgeRed:critCnt>0 },
            { id:'maneuvers',     icon:'⚡',  label:'Maneuvers' },
            { id:'groundstations',icon:'📡',  label:'Ground Stations' },
            { id:'alerts',        icon:'📋',  label:'Alert Log',        badge:alerts.length||null },
          ].map(t => (
            <button key={t.id} onClick={()=>setTab(t.id)} className={`nav-tab ${tab===t.id?'active':''}`}>
              <span style={{ fontSize:13 }}>{t.icon}</span>
              {t.label}
              {t.badge && (
                <span className={`tab-badge ${t.badgeRed?'':'dim'}`} style={{ animation:t.badgeRed&&critCnt>0?'dot-blink 1.5s ease-in-out infinite':undefined }}>
                  {t.badge}
                </span>
              )}
            </button>
          ))}
        </div>
      </header>

      {/* MAIN */}
      <main style={{ flex:1, padding:16, overflow:'auto' }}>

        {/* ── Simulation ────────────────────────────────────────────────── */}
        {tab === 'ingest' && (
          <div style={{ display:'grid', gridTemplateColumns:'400px 1fr', gap:16, maxHeight:'calc(100vh - 140px)' }}>
            <Panel title="Simulation Control" sub="POST /api/telemetry · PS §4.1" style={{ height:'100%' }}>
              <DataIngest onDataLoaded={refresh} onNotify={(t,m)=>notify(t,m)} />
            </Panel>

            <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
              {/* Connection banner */}
              <div style={{ padding:20, borderRadius:8, background:'var(--bg-panel)', border:`1px solid ${healthy?'rgba(52,211,153,.2)':'rgba(248,113,113,.2)'}` }}>
                <div style={{ fontFamily:'var(--font-hud)', fontSize:14, fontWeight:700, color:healthy?'#34d399':'#f87171', marginBottom:14, letterSpacing:'.05em' }}>
                  {healthy ? '✓  Backend is running and healthy' : '✗  Backend is offline'}
                </div>
                {!healthy ? (
                  <div>
                    <div style={{ fontFamily:'var(--font-hud)', fontSize:11, color:' var(--yellow)', marginBottom:10, letterSpacing:'.1em', textTransform:'uppercase' }}>How to start:</div>
                    {[['Direct Python','cd backend/ && uvicorn main:app --host 0.0.0.0 --port 8000'],['Docker (PS §8)','docker build -t aether . && docker run -p 8000:8000 aether']].map(([t,c])=>(
                      <div key={t} style={{ borderRadius:6, padding:'10px 14px', marginBottom:8, background:'rgba(4,10,25,.8)', border:'1px solid var(--border)' }}>
                        <div style={{ fontFamily:'var(--font-mono)', fontSize:11, color:'var(--text-muted)', marginBottom:4 }}># {t}</div>
                        <div style={{ fontFamily:'var(--font-mono)', fontSize:12, color:'#4ade80' }}>{c}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div>
                    <div style={{ fontFamily:'var(--font-ui)', fontSize:13, color:'var(--text-secondary)', marginBottom:14 }}>
                    Backend is live. The left panel shows real-time simulation state and metrics.
                  </div>
                  </div>
                )}
              </div>

              {/* API reference */}
              <div style={{ padding:16, borderRadius:8, background:'var(--bg-panel)', border:'1px solid var(--border)', flex:1 }}>
                <div style={{ fontFamily:'var(--font-hud)', fontSize:11, color:'var(--text-muted)', letterSpacing:'.12em', textTransform:'uppercase', marginBottom:12 }}>API Endpoints (PS §4)</div>
                {[['POST','/api/telemetry','Ingest satellite + debris state vectors  (PS §4.1)'],['POST','/api/maneuver/schedule','Schedule burn sequence for satellite  (PS §4.2)'],['POST','/api/simulate/step','Advance simulation by step_seconds  (PS §4.3)'],['GET','/api/visualization/snapshot','Optimized frontend snapshot  (PS §6.3)'],['GET','/api/conjunction/forecast','24-hour CDM forecast  (PS §2)'],['GET','/api/system/metrics','Uptime, fuel, maneuver stats  (PS §7)'],['GET','/api/status','Health check endpoint  (PS §8 Docker)'],['POST','/api/reset','Reset simulation state']].map(([m,p,d])=>(
                  <div key={p} style={{ display:'flex', gap:10, alignItems:'flex-start', padding:'7px 0', borderBottom:'1px solid rgba(30,80,160,.08)', fontFamily:'var(--font-mono)', fontSize:12 }}>
                    <span style={{ color:m==='POST'?'#34d399':'#4d94ff', width:38, flexShrink:0, fontWeight:600 }}>{m}</span>
                    <span style={{ color:'#fbbf24', width:210, flexShrink:0 }}>{p}</span>
                    <span style={{ color:'var(--text-muted)' }}>{d}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── DASHBOARD ─────────────────────────────────────────────────── */}
        {tab === 'dashboard' && (
          <div style={{ display:'grid', gridTemplateColumns:'1fr 340px', gap:16 }}>
            {/* 3D Globe */}
            <Panel title="3D Orbital View" sub="WebGL · Three.js · 50+ sats · 10k+ debris · 60 FPS · Atmosphere · Terminator  (PS §6.1)" style={{ height:520 }}>
              <ThreeScene satellites={sats} debris={deb} selectedSat={selectedSat}
                onSatelliteClick={id=>{setSelectedSat(id);notify('info',`Selected  ${id}`);}} />
            </Panel>

            {/* Right column */}
            <div style={{ display:'flex', flexDirection:'column', gap:12, height:520 }}>
              {/* 4 stat cards */}
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, flexShrink:0 }}>
                <StatCard label="Satellites"  value={sats.length||status.satellites}    color="var(--blue)"   icon="🛰" />
                <StatCard label="Debris"      value={deb.length||status.debris_objects} color="var(--orange)" icon="☄" />
                <StatCard label="Maneuvers"   value={metrics.maneuvers_executed||0}      color="var(--green)"  icon="⚡" />
                <StatCard label="Avoided"     value={metrics.collisions_avoided||0}      color="var(--purple)" icon="🛡" />
              </div>

              {/* Conjunction alerts */}
              <div style={{ flex:1, borderRadius:8, background:'var(--bg-panel)', border:'1px solid rgba(248,113,113,.2)', display:'flex', flexDirection:'column', overflow:'hidden' }}>
                <div style={{ padding:'12px 14px', borderBottom:'1px solid rgba(248,113,113,.15)', fontFamily:'var(--font-hud)', fontSize:11, fontWeight:700, color:'#f87171', letterSpacing:'.1em', flexShrink:0 }}>
                  ⚠  CONJUNCTION ALERTS
                </div>
                <div style={{ flex:1, overflowY:'auto', padding:10 }}>
                  {conjunctions.filter(c=>c.severity!=='SAFE').length===0
                    ? <div style={{ fontFamily:'var(--font-mono)', fontSize:12, color:'var(--text-muted)', textAlign:'center', padding:'24px 0' }}>No active threats</div>
                    : conjunctions.filter(c=>c.severity!=='SAFE').map((c,i)=>(
                      <div key={i} onClick={()=>{setSelectedSat(c.sat_id);setTab('satellites');}}
                        style={{ padding:'9px 11px', borderRadius:5, marginBottom:6, cursor:'pointer', borderLeft:`3px solid ${c.severity==='CRITICAL'?'#f87171':'#fbbf24'}`, background:c.severity==='CRITICAL'?'rgba(50,5,5,.4)':'rgba(50,30,5,.3)' }}>
                        <div style={{ display:'flex', justifyContent:'space-between', marginBottom:3 }}>
                          <span style={{ fontFamily:'var(--font-hud)', fontSize:12, color:'#fff', fontWeight:700 }}>{c.sat_id} ↔ {c.deb_id}</span>
                          <span style={{ fontFamily:'var(--font-mono)', fontSize:11, color:'var(--text-muted)' }}>{c.tca_offset_s?.toFixed(0)}s</span>
                        </div>
                        <div style={{ fontFamily:'var(--font-mono)', fontSize:11, color:'var(--text-muted)' }}>
                          Miss: {c.min_dist_km?.toFixed(3)} km ·{' '}
                          <span style={{ color:c.severity==='CRITICAL'?'#f87171':'#fbbf24', fontWeight:600 }}>{c.severity}</span>
                        </div>
                      </div>
                    ))
                  }
                </div>
              </div>

              {/* Fleet fuel */}
              <div style={{ borderRadius:8, background:'var(--bg-panel)', border:'1px solid var(--border)', padding:'12px 14px', flexShrink:0 }}>
                <div style={{ fontFamily:'var(--font-hud)', fontSize:11, fontWeight:700, color:'var(--yellow)', letterSpacing:'.1em', marginBottom:10 }}>⛽  Fleet Fuel</div>
                {sats.length===0
                  ? <div style={{ fontFamily:'var(--font-mono)', fontSize:12, color:'var(--text-muted)', textAlign:'center' }}>No satellites loaded</div>
                  : sats.slice(0,6).map(sat => {
                    const pct = Math.max(0,Math.min(100,(sat.fuel_kg/50)*100));
                    const col = fuelColor(pct);
                    return (
                      <div key={sat.id} style={{ display:'flex', alignItems:'center', gap:10, marginBottom:7 }}>
                        <span style={{ fontFamily:'var(--font-mono)', fontSize:11, color:'var(--text-secondary)', width:60, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', flexShrink:0 }}>{sat.id.slice(-7)}</span>
                        <div className="fuel-bar" style={{ flex:1 }}>
                          <div className="fuel-bar-fill" style={{ width:`${pct}%`, background:col, boxShadow:`0 0 6px ${col}55` }} />
                        </div>
                        <span style={{ fontFamily:'var(--font-hud)', fontSize:11, color:col, width:34, textAlign:'right', flexShrink:0 }}>{pct.toFixed(0)}%</span>
                      </div>
                    );
                  })
                }
              </div>
            </div>

            {/* Ground Track Map — full width */}
            <div style={{ gridColumn:'1 / -1' }}>
              <Panel title="Ground Track Map" sub="Mercator Projection · 90-min trail · RK4 predicted trajectory · Terminator line · Debris cloud  (PS §6.2)" style={{ height:300 }}>
                <GroundTrackMap satellites={sats} debris={deb} selectedSat={selectedSat}
                  timestamp={snapshot?.timestamp} onSatClick={setSelectedSat} />
              </Panel>
            </div>
          </div>
        )}

        {/* ── SATELLITES ────────────────────────────────────────────────── */}
        {tab === 'satellites' && (
          <div style={{ display:'grid', gridTemplateColumns:'240px 1fr 1fr', gap:16 }}>
            {/* Fleet list */}
            <Panel title="Satellite Fleet" sub="Click to select" style={{ gridRow:'1/3', maxHeight:'calc(100vh - 140px)' }}>
              <div style={{ overflowY:'auto', padding:10, height:'100%' }}>
                {sats.length===0
                  ? <div style={{ fontFamily:'var(--font-mono)', fontSize:13, color:'var(--text-muted)', textAlign:'center', padding:'30px 0' }}>No satellites — load data first</div>
                  : sats.map(sat => {
                    const pct = (sat.fuel_kg/50)*100;
                    const col = fuelColor(pct);
                    const isSel = sat.id === selectedSat;
                    return (
                      <div key={sat.id} onClick={()=>setSelectedSat(sat.id)}
                        style={{ padding:'10px 12px', borderRadius:6, marginBottom:6, cursor:'pointer', border:`1px solid ${isSel?'rgba(77,148,255,.5)':'var(--border)'}`, background:isSel?'rgba(15,31,56,.7)':'var(--bg-card)', transition:'all .15s' }}>
                        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6 }}>
                          <span style={{ fontFamily:'var(--font-hud)', fontSize:12, color:'#fff', fontWeight:700 }}>{sat.id}</span>
                          <span className={`badge ${sat.status==='GRAVEYARD'?'badge-graveyard':pct<10?'badge-critical':pct<30?'badge-warning':'badge-active'}`}>{sat.status||'ACTIVE'}</span>
                        </div>
                        <div className="fuel-bar" style={{ marginBottom:5 }}>
                          <div className="fuel-bar-fill" style={{ width:`${pct}%`, background:col }} />
                        </div>
                        <div style={{ fontFamily:'var(--font-mono)', fontSize:10, color:'var(--text-muted)', display:'flex', justifyContent:'space-between' }}>
                          <span>{sat.fuel_kg?.toFixed(1)} kg</span>
                          <span>{sat.lat?.toFixed(1)}° {sat.lon?.toFixed(1)}°</span>
                        </div>
                      </div>
                    );
                  })
                }
              </div>
            </Panel>

            {/* Bullseye */}
            <Panel title={`Bullseye — ${selectedSat || 'Select a satellite'}`} sub="Conjunction Polar Chart · TCA radial distance · Risk color-coding  (PS §6.2)" color="var(--red)" style={{ height:460 }}>
              <BullseyePlot satelliteId={selectedSat} conjunctions={conjunctions} />
            </Panel>

            {/* Telemetry */}
            <Panel title="Telemetry & Resource Monitor" sub="Fuel gauges · ΔV efficiency · Uptime radar  (PS §6.2)" color="var(--green)" style={{ height:460 }}>
              <TelemetryHeatmap satellites={sats} metrics={metrics} />
            </Panel>

            {/* Timeline */}
            <Panel title="Maneuver Timeline" sub="Gantt Scheduler · Burn blocks · 600 s Cooldown · LOS Blackout zones  (PS §6.2)" color="var(--yellow)" style={{ gridColumn:'2/4', height:300 }}>
              <ManeuverTimeline satelliteId={selectedSat} onBurnClick={b=>notify('info','Burn selected',b.burn_id)} />
            </Panel>
          </div>
        )}

        {/* ── CONJUNCTIONS ──────────────────────────────────────────────── */}
        {tab === 'conjunctions' && (
          <div style={{ display:'grid', gridTemplateColumns:'1fr 380px', gap:16 }}>
            <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
              {/* Counts */}
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12 }}>
                {[['CRITICAL',conjunctions.filter(c=>c.severity==='CRITICAL').length,'var(--red)'],['WARNING',conjunctions.filter(c=>c.severity==='WARNING').length,'var(--yellow)'],['SAFE',conjunctions.filter(c=>c.severity==='SAFE').length,'var(--green)']].map(([s,v,c])=>(
                  <StatCard key={s} label={s} value={v} color={c} />
                ))}
              </div>
              {/* CDM table */}
              <Panel title="24-Hour CDM Forecast" sub="Predictive conjunction assessment · 24 h lookahead  (PS §2)" color="var(--red)" style={{ flex:1 }}>
                <div style={{ overflowY:'auto', maxHeight:500 }}>
                  {conjunctions.length===0
                    ? <div style={{ fontFamily:'var(--font-mono)', fontSize:13, color:'var(--text-muted)', textAlign:'center', padding:'50px 0' }}>No conjunctions forecast — ingest data and run simulation</div>
                    : (
                      <table className="data-table">
                        <thead><tr>{['Satellite','Debris','TCA','Miss Dist','Severity','Pc','Action'].map(h=><th key={h}>{h}</th>)}</tr></thead>
                        <tbody>
                          {conjunctions.map((c,i)=>(
                            <tr key={i} style={{ cursor:'pointer' }} onClick={()=>setSelectedSat(c.sat_id)}>
                              <td style={{ color:'var(--blue)', fontFamily:'var(--font-hud)', fontWeight:700, fontSize:12 }}>{c.sat_id}</td>
                              <td style={{ fontFamily:'var(--font-mono)' }}>{c.deb_id}</td>
                              <td style={{ fontFamily:'var(--font-mono)' }}>{c.tca_offset_s?.toFixed(0)} s</td>
                              <td style={{ fontFamily:'var(--font-mono)' }}>{c.min_dist_km?.toFixed(3)} km</td>
                              <td><span className={`badge ${c.severity==='CRITICAL'?'badge-critical':c.severity==='WARNING'?'badge-warning':'badge-active'}`}>{c.severity}</span></td>
                              <td style={{ fontFamily:'var(--font-mono)', color:'var(--text-secondary)' }}>{c.prob?.toFixed(4)||'—'}</td>
                              <td style={{ fontFamily:'var(--font-mono)', color:'var(--green)', fontSize:11 }}>{c.action||'MONITORING'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )
                  }
                </div>
              </Panel>
            </div>
            <Panel title={`Bullseye — ${selectedSat||'Select a satellite'}`} sub="(PS §6.2)" color="var(--red)" style={{ height:'calc(100vh - 160px)' }}>
              <BullseyePlot satelliteId={selectedSat} conjunctions={conjunctions} />
            </Panel>
          </div>
        )}

        {/* ── MANEUVERS ─────────────────────────────────────────────────── */}
        {tab === 'maneuvers' && (
          <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12 }}>
              <StatCard label="Total Maneuvers"    value={metrics.maneuvers_executed||0}                                                          color="var(--blue)" />
              <StatCard label="Collisions Avoided" value={metrics.collisions_avoided||0}                                                          color="var(--green)" />
              <StatCard label="Fuel Consumed"      value={`${(metrics.fuel_used_total_kg||0).toFixed(2)} kg`}                                    color="var(--yellow)" />
              <StatCard label="Avoid Rate"         value={`${Math.min(100,(((metrics.collisions_avoided||0)/Math.max(metrics.maneuvers_executed||1,1))*100)).toFixed(1)}%`} color="var(--purple)" />
            </div>
            <Panel title="Maneuver Timeline" sub="Gantt Scheduler · Burn blocks · 600 s Cooldown (PS §5.1) · LOS Blackout zones (PS §5.4)  (PS §6.2)" color="var(--yellow)" style={{ height:360 }}>
              <ManeuverTimeline satelliteId={selectedSat} onBurnClick={b=>notify('info','Burn',b.burn_id)} />
            </Panel>
            <Panel title="ΔV Efficiency Analysis" sub="Fuel vs Collisions Avoided · Uptime Radar · Mission Score  (PS §6.2 §7)" color="var(--purple)" style={{ height:440 }}>
              <TelemetryHeatmap satellites={sats} metrics={metrics} />
            </Panel>
          </div>
        )}

        {/* ── GROUND STATIONS ───────────────────────────────────────────── */}
        {tab === 'groundstations' && (
          <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:14 }}>
              {[
                { name:'ISTRAC Bengaluru',      lat:13.03,  lon:77.52,   alt:820,  minEl:5  },
                { name:'Svalbard Station',       lat:78.23,  lon:15.41,   alt:400,  minEl:5  },
                { name:'Goldstone Tracking',     lat:35.43,  lon:-116.89, alt:1000, minEl:10 },
                { name:'Punta Arenas',           lat:-53.15, lon:-70.92,  alt:30,   minEl:5  },
                { name:'IIT Delhi Ground Node',  lat:28.55,  lon:77.19,   alt:225,  minEl:15 },
                { name:'McMurdo Station',        lat:-77.85, lon:166.67,  alt:10,   minEl:5  },
              ].map((gs,i) => (
                <div key={gs.name} style={{ padding:18, borderRadius:8, background:'var(--bg-panel)', border:'1px solid var(--border)' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
                    <div style={{ fontFamily:'var(--font-hud)', fontSize:13, color:'var(--cyan)', fontWeight:700 }}>{gs.name}</div>
                    <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                      <div style={{ width:8, height:8, borderRadius:'50%', background:'#34d399', boxShadow:'0 0 8px #34d399' }} className="dot-blink" />
                      <span style={{ fontFamily:'var(--font-hud)', fontSize:10, color:'#34d399' }}>ONLINE</span>
                    </div>
                  </div>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
                    {[['Latitude',`${gs.lat}°`],['Longitude',`${gs.lon}°`],['Altitude',`${gs.alt} m`],['Min Elevation',`${gs.minEl}°`]].map(([l,v])=>(
                      <div key={l}>
                        <div style={{ fontFamily:'var(--font-hud)', fontSize:9, color:'var(--text-muted)', letterSpacing:'.1em', textTransform:'uppercase', marginBottom:3 }}>{l}</div>
                        <div style={{ fontFamily:'var(--font-mono)', fontSize:13, color:'var(--text-primary)', fontWeight:500 }}>{v}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ marginTop:12, paddingTop:10, borderTop:'1px solid var(--border)' }}>
                    <span style={{ fontFamily:'var(--font-hud)', fontSize:10, color:'var(--text-muted)', letterSpacing:'.1em' }}>GS-00{i+1}  ·  OPERATIONAL</span>
                  </div>
                </div>
              ))}
            </div>
            <Panel title="Ground Track Map" sub="Ground station coverage overlay  (PS §5.4 §5.5.1)" color="var(--cyan)" style={{ height:300 }}>
              <GroundTrackMap satellites={sats} debris={[]} selectedSat={selectedSat}
                timestamp={snapshot?.timestamp} onSatClick={setSelectedSat} />
            </Panel>
          </div>
        )}

        {/* ── ALERT LOG ─────────────────────────────────────────────────── */}
        {tab === 'alerts' && (
          <Panel title="CDM Alert History" sub="All conjunction data messages · Autonomous maneuver log" color="var(--red)" style={{ minHeight:'calc(100vh - 160px)' }}>
            <div style={{ overflowY:'auto', maxHeight:'calc(100vh - 200px)' }}>
              {alerts.length===0
                ? <div style={{ fontFamily:'var(--font-mono)', fontSize:13, color:'var(--text-muted)', textAlign:'center', padding:'80px 0' }}>No CDM alerts yet — run simulation to generate conjunction data</div>
                : (
                  <table className="data-table">
                    <thead><tr>{['Alert ID','Time','Satellite','Debris','Miss Dist','Severity','Pc','Action'].map(h=><th key={h}>{h}</th>)}</tr></thead>
                    <tbody>
                      {alerts.map((a,i)=>(
                        <tr key={i}>
                          <td style={{ fontFamily:'var(--font-mono)', color:'var(--text-muted)' }}>{a.alert_id?.slice(-10)}</td>
                          <td style={{ fontFamily:'var(--font-mono)' }}>{a.timestamp?.slice(11,19)}</td>
                          <td style={{ fontFamily:'var(--font-hud)', color:'var(--blue)', fontWeight:700, fontSize:12 }}>{a.sat_id}</td>
                          <td style={{ fontFamily:'var(--font-mono)' }}>{a.deb_id}</td>
                          <td style={{ fontFamily:'var(--font-mono)' }}>{a.distance?.toFixed(3)} km</td>
                          <td><span className={`badge ${a.severity==='CRITICAL'?'badge-critical':a.severity==='WARNING'?'badge-warning':'badge-active'}`}>{a.severity}</span></td>
                          <td style={{ fontFamily:'var(--font-mono)', color:'var(--text-secondary)' }}>{a.prob?.toFixed(4)}</td>
                          <td style={{ fontFamily:'var(--font-mono)', color:'var(--green)' }}>{a.action}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              }
            </div>
          </Panel>
        )}
      </main>

      {/* STATUS BAR */}
      <footer style={{ flexShrink:0, borderTop:'1px solid var(--border)', display:'flex', justifyContent:'space-between', alignItems:'center', padding:'0 20px', height:30, background:'rgba(3,6,16,.98)', fontFamily:'var(--font-mono)', fontSize:11, color:'var(--text-muted)' }}>
        <div style={{ display:'flex', gap:20 }}>
          <span>© 2026 AETHER · National Space Hackathon · IIT Delhi</span>
          <span>Backend: <span style={{ color:healthy?'#34d399':'#f87171', fontWeight:600 }}>{healthy?'ONLINE':'OFFLINE'}</span></span>
          <span>Sim: <span style={{ color:simRunning?'#34d399':'var(--text-muted)', fontWeight:600 }}>{simRunning?'RUNNING':'PAUSED'}</span></span>
        </div>
        <div style={{ display:'flex', gap:20 }}>
          <span>Sats: <span style={{ color:'var(--blue)', fontWeight:600 }}>{sats.length||status.satellites}</span></span>
          <span>Debris: <span style={{ color:'var(--orange)', fontWeight:600 }}>{deb.length||status.debris_objects}</span></span>
          <span>Elapsed: <span style={{ color:'var(--green)', fontWeight:600 }}>{fmtTime(status.elapsed_sim_time_s||0)}</span></span>
          <span>Poll: <span style={{ color:'var(--green)' }}>3 s</span></span>
        </div>
      </footer>
    </div>
  );
}