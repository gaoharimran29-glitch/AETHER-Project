// src/components/DataIngest.jsx
// System Status & API Reference panel
// The grading scripts POST data directly to the API — no demo data generation needed
import React, { useState, useEffect } from 'react';
import { fetchStatus, fetchMetrics, fetchAlertHistory, simulateStep, resetSimulation } from '../api/aetherApi';

export default function DataIngest({ onDataLoaded, onNotify }) {
  const [status,  setStatus]  = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [alerts,  setAlerts]  = useState([]);
  const [stepSecs,setStepSecs]= useState(60);
  const [busy,    setBusy]    = useState(false);

  useEffect(() => {
    const load = async () => {
      const [s, m, a] = await Promise.all([fetchStatus(), fetchMetrics(), fetchAlertHistory()]);
      setStatus(s); setMetrics(m); setAlerts(Array.isArray(a) ? a : []);
    };
    load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, []);

  const doStep = async () => {
    setBusy(true);
    try {
      const r = await simulateStep(stepSecs);
      if (onNotify) onNotify('ok', `Step +${stepSecs}s`, `col:${r.collisions_detected} mnvr:${r.maneuvers_executed}`);
      if (onDataLoaded) onDataLoaded();
    } catch (e) {
      if (onNotify) onNotify('error', 'Step failed', e.message);
    } finally { setBusy(false); }
  };

  const doReset = async () => {
    setBusy(true);
    try {
      await resetSimulation();
      if (onNotify) onNotify('warn', 'Reset', 'All simulation data cleared');
      if (onDataLoaded) onDataLoaded();
    } catch (e) {
      if (onNotify) onNotify('error', 'Reset failed', e.message);
    } finally { setBusy(false); }
  };

  const S = (label, value, color = '#94a3b8') => (
    <div key={label} style={{ display:'flex', justifyContent:'space-between', padding:'7px 0', borderBottom:'1px solid rgba(30,58,95,.3)' }}>
      <span style={{ fontSize:12, color:'#475569' }}>{label}</span>
      <span style={{ fontSize:12, fontFamily:'var(--font-mono,monospace)', color, fontWeight:600 }}>{value ?? '—'}</span>
    </div>
  );

  return (
    <div style={{ padding:16, height:'100%', overflowY:'auto', display:'flex', flexDirection:'column', gap:16 }}>

      {/* Simulation state */}
      <div style={{ borderRadius:6, border:'1px solid rgba(77,148,255,.2)', padding:14, background:'rgba(10,22,50,.5)' }}>
        <div style={{ fontFamily:'var(--font-hud,monospace)', fontSize:11, color:'#4d94ff', letterSpacing:'.12em', marginBottom:12, textTransform:'uppercase' }}>
          Simulation State
        </div>
        {status ? (
          <div>
            {S('Status',        status.simulation_running ? 'RUNNING' : 'PAUSED',   status.simulation_running ? '#34d399' : '#fbbf24')}
            {S('Sim Time',      `T + ${Math.floor((status.elapsed_sim_time_s||0)/3600)}h ${Math.floor(((status.elapsed_sim_time_s||0)%3600)/60)}m`, '#34d399')}
            {S('Satellites',    status.satellites,    '#4d94ff')}
            {S('Debris Objects',status.debris_objects,'#fb923c')}
            {S('CDM Warnings',  alerts.length,        alerts.length > 0 ? '#f87171' : '#34d399')}
          </div>
        ) : (
          <div style={{ fontSize:12, color:'#334155', textAlign:'center', padding:'12px 0' }}>Loading…</div>
        )}
      </div>

      {/* Performance metrics */}
      <div style={{ borderRadius:6, border:'1px solid rgba(52,211,153,.2)', padding:14, background:'rgba(5,20,15,.4)' }}>
        <div style={{ fontFamily:'var(--font-hud,monospace)', fontSize:11, color:'#34d399', letterSpacing:'.12em', marginBottom:12, textTransform:'uppercase' }}>
          Performance Metrics
        </div>
        {metrics ? (
          <div>
            {S('Maneuvers Executed',  metrics.maneuvers_executed,                               '#4d94ff')}
            {S('Collisions Avoided',  metrics.collisions_avoided,                               '#34d399')}
            {S('Fuel Used (total)',   `${(metrics.fuel_used_total_kg||0).toFixed(3)} kg`,        '#fbbf24')}
            {S('Avoid Rate',         metrics.maneuvers_executed > 0
                ? `${((metrics.collisions_avoided/metrics.maneuvers_executed)*100).toFixed(1)}%`
                : '—',                                                                          '#a78bfa')}
          </div>
        ) : (
          <div style={{ fontSize:12, color:'#334155', textAlign:'center', padding:'12px 0' }}>Loading…</div>
        )}
      </div>

      {/* Simulation controls */}
      <div style={{ borderRadius:6, border:'1px solid rgba(251,191,36,.2)', padding:14, background:'rgba(20,15,5,.4)' }}>
        <div style={{ fontFamily:'var(--font-hud,monospace)', fontSize:11, color:'#fbbf24', letterSpacing:'.12em', marginBottom:12, textTransform:'uppercase' }}>
          Simulation Controls
        </div>
        <div style={{ display:'flex', gap:8, marginBottom:8 }}>
          <div style={{ flex:1 }}>
            <label style={{ display:'block', fontSize:10, color:'#475569', marginBottom:4, fontFamily:'var(--font-hud,monospace)', letterSpacing:'.08em', textTransform:'uppercase' }}>Step Size</label>
            <select value={stepSecs} onChange={e => setStepSecs(+e.target.value)} style={{ width:'100%', background:'rgba(4,12,28,.9)', border:'1px solid rgba(251,191,36,.25)', borderRadius:4, padding:'7px 10px', color:'#e2e8f0', fontSize:12, fontFamily:'var(--font-mono,monospace)' }}>
              {[1,10,60,300,600,3600].map(v => <option key={v} value={v}>{v}s{v>=3600?' (1hr)':v>=60?` (${v/60}min)`:''}</option>)}
            </select>
          </div>
          <div style={{ display:'flex', alignItems:'flex-end', gap:6 }}>
            <button onClick={doStep} disabled={busy} style={{ padding:'8px 14px', borderRadius:4, border:'1px solid rgba(52,211,153,.3)', background:'rgba(52,211,153,.1)', color:'#6ee7b7', fontFamily:'var(--font-hud,monospace)', fontSize:11, cursor:busy?'not-allowed':'pointer', opacity:busy?.5:1, letterSpacing:'.06em', textTransform:'uppercase' }}>
              ⏯ Step
            </button>
            <button onClick={doReset} disabled={busy} style={{ padding:'8px 14px', borderRadius:4, border:'1px solid rgba(248,113,113,.3)', background:'rgba(248,113,113,.1)', color:'#fca5a5', fontFamily:'var(--font-hud,monospace)', fontSize:11, cursor:busy?'not-allowed':'pointer', opacity:busy?.5:1, letterSpacing:'.06em', textTransform:'uppercase' }}>
              ↺ Reset
            </button>
          </div>
        </div>
        <div style={{ fontSize:11, color:'#334155', fontFamily:'var(--font-mono,monospace)', lineHeight:1.6 }}>
          Use the Step button to manually advance simulation time.<br/>
          The grading system sends telemetry and steps automatically.
        </div>
      </div>

      {/* API reference */}
      <div style={{ borderRadius:6, border:'1px solid rgba(30,58,95,.5)', padding:14, background:'rgba(4,10,22,.7)' }}>
        <div style={{ fontFamily:'var(--font-hud,monospace)', fontSize:11, color:'#475569', letterSpacing:'.12em', marginBottom:12, textTransform:'uppercase' }}>
          API Endpoints (PS §4)
        </div>
        {[
          ['POST', '/api/telemetry',              '#34d399', 'Ingest satellite + debris state vectors'],
          ['POST', '/api/maneuver/schedule',       '#34d399', 'Schedule burn sequence for satellite'],
          ['POST', '/api/simulate/step',           '#34d399', 'Advance simulation by step_seconds'],
          ['GET',  '/api/visualization/snapshot',  '#4d94ff', 'Frontend snapshot (PS §6.3)'],
          ['GET',  '/api/conjunction/forecast',    '#4d94ff', '24-hour CDM forecast (PS §2)'],
          ['GET',  '/api/system/metrics',          '#4d94ff', 'Uptime, fuel, maneuver stats (PS §7)'],
          ['GET',  '/api/status',                  '#4d94ff', 'Health check (PS §8 Docker)'],
          ['POST', '/api/reset',                   '#fbbf24', 'Reset simulation state'],
        ].map(([method, path, color, desc]) => (
          <div key={path} style={{ display:'flex', gap:8, padding:'5px 0', borderBottom:'1px solid rgba(30,58,95,.2)', fontFamily:'var(--font-mono,monospace)', fontSize:11 }}>
            <span style={{ color, width:36, flexShrink:0, fontWeight:700 }}>{method}</span>
            <span style={{ color:'#fbbf24', width:220, flexShrink:0 }}>{path}</span>
            <span style={{ color:'#334155' }}>{desc}</span>
          </div>
        ))}
        <div style={{ marginTop:12, padding:'10px 12px', borderRadius:4, background:'rgba(10,22,50,.6)', border:'1px solid rgba(30,58,95,.4)' }}>
        </div>
      </div>

    </div>
  );
}