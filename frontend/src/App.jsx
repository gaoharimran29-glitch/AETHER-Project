// src/App.jsx — AETHER Mission Control Dashboard
// National Space Hackathon 2026, IIT Delhi
// PS §6.2 — All 4 required modules: GroundTrackMap, BullseyePlot, TelemetryHeatmap, ManeuverTimeline
import React, { useEffect, useState, useCallback, useRef } from 'react';
import ThreeScene       from './components/ThreeScene';
import GroundTrackMap   from './components/GroundTrackMap';
import BullseyePlot     from './components/BullseyePlot';
import TelemetryHeatmap from './components/TelemetryHeatmap';
import ManeuverTimeline from './components/ManeuverTimeline';
import DataIngest       from './components/DataIngest';
import {
  fetchSnapshot, fetchStatus, fetchMetrics,
  fetchConjunctionForecast, fetchAlertHistory, fetchNextPass,
  simulateStep, startSimulation, stopSimulation, resetSimulation,
  checkBackendHealth,
} from './api/aetherApi';

// ── utilities ─────────────────────────────────────────────────────────────────
function fmtTime(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return `${h}h ${String(m).padStart(2,'0')}m ${String(sec).padStart(2,'0')}s`;
}

const MOCK = {
  snap: {
    timestamp: new Date().toISOString(),
    satellites: [
      {id:'SAT-A01',lat:28.5,lon:77.2,fuel_kg:48.5,status:'ACTIVE',alt_km:550},
      {id:'SAT-A02',lat:-53.1,lon:-70.9,fuel_kg:32.8,status:'ACTIVE',alt_km:550},
      {id:'SAT-B01',lat:78.2,lon:15.4,fuel_kg:15.2,status:'WARNING',alt_km:550},
    ],
    debris_cloud: [['DEB-001',12.4,-45.2,400],['DEB-002',-23.5,120.3,450]],
  },
  status: { simulation_running:false, satellites:0, debris_objects:0, alerts:{}, elapsed_sim_time_s:0 },
  metrics: { maneuvers_executed:0, collisions_avoided:0, fuel_used_total_kg:0, satellite_uptime_pct:{} },
  conj: [],
};

// ── PanelBox ──────────────────────────────────────────────────────────────────
function PanelBox({ title, sub, accent = 'blue', children, className = '' }) {
  const cc = { blue:'#1e3a5f', red:'#4a1818', green:'#0f3020', yellow:'#3a2a08', purple:'#2a1a4a', cyan:'#0a2a35' };
  const tc = { blue:'#3b82f6', red:'#ef4444', green:'#10b981', yellow:'#f59e0b', purple:'#8b5cf6', cyan:'#06b6d4' };
  return (
    <div className={`rounded border border-gray-800/70 flex flex-col overflow-hidden ${className}`}
         style={{ background: 'rgba(3,10,20,.88)' }}>
      <div className="flex items-center justify-between px-3 py-2 flex-shrink-0 border-b border-gray-800/50"
           style={{ background: `${cc[accent]}55` }}>
        <div>
          <div className="font-bold tracking-widest" style={{ fontSize:10, color:tc[accent] }}>{title}</div>
          {sub && <div className="text-gray-600" style={{ fontSize:8, marginTop:1 }}>{sub}</div>}
        </div>
        <div className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background:tc[accent] }} />
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [snapshot,     setSnapshot]     = useState(MOCK.snap);
  const [status,       setStatus]       = useState(MOCK.status);
  const [metrics,      setMetrics]      = useState(MOCK.metrics);
  const [conjunctions, setConjunctions] = useState(MOCK.conj);
  const [alerts,       setAlerts]       = useState([]);
  const [nextPasses,   setNextPasses]   = useState({});
  const [selectedSat,  setSelectedSat]  = useState('SAT-A01');
  const [tab,          setTab]          = useState('ingest');  // start on ingest so judges see it first
  const [healthy,      setHealthy]      = useState(null);      // null = checking
  const [loading,      setLoading]      = useState(true);
  const [notifications,setNotifications]= useState([]);
  const [simSpeed,     setSimSpeed]     = useState(60);
  const [simRunning,   setSimRunning]   = useState(false);
  const healthCheckRef = useRef(null);

  // ── notifications ─────────────────────────────────────────────────────────
  const addNotif = useCallback((type, title, msg = '') => {
    const id = Date.now();
    setNotifications(p => [{ id, type, title, msg }, ...p].slice(0, 5));
    setTimeout(() => setNotifications(p => p.filter(n => n.id !== id)), 5000);
  }, []);

  // ── refresh all data ──────────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    const [snap, stat, met, conj, hist] = await Promise.all([
      fetchSnapshot(),
      fetchStatus(),
      fetchMetrics(),
      fetchConjunctionForecast(),
      fetchAlertHistory(),
    ]);
    if (snap) setSnapshot(snap);
    setStatus(stat);
    setMetrics(met);
    setConjunctions(conj?.forecast || []);
    setAlerts(Array.isArray(hist) ? hist : []);
    setSimRunning(stat?.simulation_running || false);
  }, []);

  // ── initial load + health check ───────────────────────────────────────────
  useEffect(() => {
    const init = async () => {
      // Health check with retries
      let attempts = 0;
      const checkHealth = async () => {
        attempts++;
        const h = await checkBackendHealth();
        setHealthy(h.healthy);
        if (h.healthy) {
          addNotif('ok', 'Backend connected', `Port 8000 responding`);
          await refresh();
          // Switch to dashboard if data is already loaded
          const s = await fetchStatus();
          if ((s?.satellites || 0) > 0) setTab('dashboard');
        } else if (attempts < 5) {
          // Retry up to 5 times with 2s delay
          healthCheckRef.current = setTimeout(checkHealth, 2000);
        } else {
          addNotif('warn', 'Backend offline', 'Start your backend: uvicorn main:app --port 8000');
        }
        setLoading(false);
      };
      await checkHealth();
    };
    init();
    const pollId = setInterval(async () => {
      const h = await checkBackendHealth();
      setHealthy(h.healthy);
      if (h.healthy) await refresh();
    }, 3000);
    return () => {
      clearInterval(pollId);
      if (healthCheckRef.current) clearTimeout(healthCheckRef.current);
    };
  }, []);

  // ── fetch next passes for selected satellite ───────────────────────────────
  useEffect(() => {
    if (!selectedSat || !healthy) return;
    fetchNextPass(selectedSat).then(data => {
      if (data?.upcoming_passes)
        setNextPasses(p => ({ ...p, [selectedSat]: data.upcoming_passes }));
    });
  }, [selectedSat, healthy]);

  // ── sim controls ──────────────────────────────────────────────────────────
  const handleStep = async () => {
    try {
      const r = await simulateStep(simSpeed);
      addNotif('info', `Step +${simSpeed}s`, `Col:${r.collisions_detected} Mnvr:${r.maneuvers_executed}`);
      await refresh();
    } catch (e) { addNotif('error', 'Step failed', e.message); }
  };
  const handleStart = async () => {
    try { await startSimulation(simSpeed); setSimRunning(true); addNotif('ok', 'Simulation started', `dt=${simSpeed}s`); }
    catch (e) { addNotif('error', 'Start failed', e.message); }
  };
  const handleStop = async () => {
    try { await stopSimulation(); setSimRunning(false); addNotif('info', 'Simulation stopped', ''); }
    catch (e) { addNotif('error', 'Stop failed', e.message); }
  };
  const handleReset = async () => {
    try { await resetSimulation(); setSimRunning(false); await refresh(); addNotif('warn', 'Reset', 'All data cleared'); }
    catch (e) { addNotif('error', 'Reset failed', e.message); }
  };

  const sats    = snapshot?.satellites || [];
  const deb     = snapshot?.debris_cloud || [];
  const critCnt = conjunctions.filter(c => c.severity === 'CRITICAL').length;

  // ── loading splash ────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background:'#020810', fontFamily:'monospace' }}>
        <div className="text-center">
          <div className="relative w-28 h-28 mx-auto mb-8">
            <div className="absolute inset-0 border-2 border-blue-500/20 rounded-full animate-ping" />
            <div className="absolute inset-2 border-2 border-blue-400/40 rounded-full animate-spin" />
            <div className="absolute inset-4 border-2 border-blue-300/60 rounded-full" style={{animation:'spin 3s linear infinite reverse'}} />
            <div className="absolute inset-6 bg-blue-600/20 rounded-full animate-pulse" />
            <div className="absolute inset-8 bg-blue-500/30 rounded-full" />
          </div>
          <div className="text-blue-400 font-bold tracking-[0.35em] text-5xl mb-2" style={{ textShadow:'0 0 40px #3b82f6' }}>AETHER</div>
          <div className="text-gray-500 text-xs tracking-[0.25em] mb-6">AUTONOMOUS CONSTELLATION MANAGER</div>
          <div className="text-gray-600 text-xs mb-8">Connecting to backend on port 8000…</div>
          <div className="flex justify-center gap-2">
            {[0, 0.15, 0.3].map(d => <div key={d} className="w-2 h-2 bg-blue-500/60 rounded-full animate-bounce" style={{ animationDelay:`${d}s` }} />)}
          </div>
          <div className="text-gray-800 text-xs mt-10 tracking-widest">NATIONAL SPACE HACKATHON 2026 · IIT DELHI</div>
        </div>
      </div>
    );
  }

  // ── main render ───────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen flex flex-col" style={{ background:'#030a14', color:'#e2e8f0', fontFamily:'monospace' }}>

      {/* ── NOTIFICATIONS ─────────────────────────────────────────────────── */}
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 w-80 pointer-events-none">
        {notifications.map(n => (
          <div key={n.id} className={`flex items-start gap-3 p-3 rounded-lg border animate-slideIn pointer-events-auto ${
            n.type==='error' ? 'bg-red-950/95 border-red-700/80' :
            n.type==='warn'  ? 'bg-yellow-950/95 border-yellow-700/80' :
            n.type==='ok'    ? 'bg-green-950/95 border-green-700/80' :
            'bg-blue-950/95 border-blue-700/80'}`}
            style={{ boxShadow:'0 4px 20px rgba(0,0,0,.5)' }}>
            <span className="text-base mt-0.5">{n.type==='error'?'✗':n.type==='warn'?'⚠':n.type==='ok'?'✓':'ℹ'}</span>
            <div className="flex-1 min-w-0">
              <div className="font-bold text-xs text-white">{n.title}</div>
              {n.msg && <div className="text-xs text-gray-400 truncate mt-0.5">{n.msg}</div>}
            </div>
            <button onClick={() => setNotifications(p => p.filter(x => x.id !== n.id))} className="text-gray-600 hover:text-white text-xs">✕</button>
          </div>
        ))}
      </div>

      {/* ── HEADER ───────────────────────────────────────────────────────── */}
      <header className="flex-shrink-0 sticky top-0 z-40 border-b border-gray-800/50"
              style={{ background:'rgba(2,8,18,0.97)', backdropFilter:'blur(16px)' }}>
        <div className="flex items-center justify-between px-4 h-14">
          {/* Logo */}
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg flex items-center justify-center"
                   style={{ background:'linear-gradient(135deg,#1d4ed8,#7c3aed)', boxShadow:'0 0 20px rgba(59,130,246,.35)' }}>
                <span className="text-white font-bold text-sm">A</span>
              </div>
              <div>
                <div className="text-blue-400 font-bold tracking-[0.25em] text-sm" style={{ textShadow:'0 0 15px rgba(59,130,246,.4)' }}>AETHER</div>
                <div className="text-gray-700 tracking-widest" style={{ fontSize:8 }}>AUTONOMOUS CONSTELLATION MGR · NSH 2026</div>
              </div>
            </div>

            {/* Backend status badge */}
            <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded border text-xs ${
              healthy === null ? 'border-yellow-800 text-yellow-400 bg-yellow-950/30' :
              healthy ? 'border-green-800 text-green-400 bg-green-950/30' :
              'border-red-800 text-red-400 bg-red-950/30'}`}>
              <div className={`w-1.5 h-1.5 rounded-full ${
                healthy === null ? 'bg-yellow-400 animate-pulse' :
                healthy ? 'bg-green-400 animate-pulse' : 'bg-red-400'}`} />
              {healthy === null ? 'CONNECTING…' : healthy ? 'BACKEND LIVE' : 'BACKEND OFFLINE'}
            </div>

            {/* Critical alert badge */}
            {critCnt > 0 && (
              <div className="flex items-center gap-1 px-2.5 py-1 rounded border border-red-700/80 bg-red-950/40 text-red-400 text-xs animate-pulse">
                ⚠ {critCnt} CRITICAL
              </div>
            )}

            {/* Live data counts */}
            {healthy && (
              <div className="flex gap-3 text-xs">
                <span className="text-gray-600">Sats: <span className="text-blue-400 font-bold">{sats.length || status.satellites}</span></span>
                <span className="text-gray-600">Debris: <span className="text-orange-400 font-bold">{deb.length || status.debris_objects}</span></span>
              </div>
            )}
          </div>

          {/* Sim controls */}
          <div className="flex items-center gap-2">
            <div className="flex gap-1 rounded border border-gray-700/50 p-1"
                 style={{ background:'rgba(8,18,35,.6)' }}>
              {[
                { l:'⏯ STEP',  fn: handleStep,  cls:'text-blue-300 hover:bg-blue-700/50' },
                { l:'▶ START', fn: handleStart, cls:`hover:bg-green-700/50 ${simRunning?'text-green-400':'text-gray-500'}` },
                { l:'⏸ STOP',  fn: handleStop,  cls:'text-orange-300 hover:bg-orange-700/50' },
                { l:'↺ RESET', fn: handleReset, cls:'text-red-300 hover:bg-red-700/40' },
              ].map(b => (
                <button key={b.l} onClick={b.fn}
                  className={`px-3 py-1 rounded text-xs font-bold tracking-widest transition ${b.cls}`}
                  style={{ fontSize:10 }}>{b.l}</button>
              ))}
            </div>
            <select value={simSpeed} onChange={e => setSimSpeed(+e.target.value)}
              className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-white">
              {[1,10,60,300,3600].map(v => <option key={v} value={v}>dt={v}s</option>)}
            </select>
            {/* Sim clock */}
            <div className="px-3 py-1 rounded border border-gray-700/50 text-xs" style={{ background:'rgba(8,18,35,.6)', minWidth:100 }}>
              <span className="text-gray-600">T+ </span>
              <span className="text-green-400 font-bold">{fmtTime(status.elapsed_sim_time_s || 0)}</span>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex px-4 border-t border-gray-800/40" style={{ background:'rgba(2,8,16,.5)' }}>
          {[
            { id:'ingest',       icon:'📥', label:'DATA INGEST',      badge:!healthy?'OFFLINE':null,   badgeRed:!healthy },
            { id:'dashboard',    icon:'⬡',  label:'DASHBOARD'  },
            { id:'satellites',   icon:'🛰', label:'SATELLITES'  },
            { id:'conjunctions', icon:'⚠', label:'CONJUNCTIONS', badge: critCnt || null, badgeRed:true },
            { id:'maneuvers',    icon:'⚡', label:'MANEUVERS'   },
            { id:'groundstations',icon:'📡',label:'GROUND STATIONS' },
            { id:'alerts',       icon:'📋', label:'ALERT LOG',  badge: alerts.length || null },
          ].map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-4 py-2.5 border-b-2 text-xs font-bold tracking-widest transition ${
                tab === t.id ? 'border-blue-500 text-blue-400' : 'border-transparent text-gray-600 hover:text-gray-300'}`}
              style={{ fontSize:10 }}>
              <span>{t.icon}</span>
              {t.label}
              {t.badge && (
                <span className={`px-1.5 py-0.5 rounded-full text-white text-xs font-bold ${t.badgeRed ? 'bg-red-600 animate-pulse' : 'bg-gray-700'}`}>
                  {t.badge}
                </span>
              )}
            </button>
          ))}
        </div>
      </header>

      {/* ── MAIN ─────────────────────────────────────────────────────────── */}
      <main className="flex-1 p-3 overflow-auto" style={{ minHeight:0 }}>

        {/* DATA INGEST TAB — first thing judges see */}
        {tab === 'ingest' && (
          <div className="grid grid-cols-12 gap-3 h-full">
            <div className="col-span-12 lg:col-span-5" style={{ minHeight:600 }}>
              <PanelBox title="DATA INGEST & SIMULATION CONTROL" sub="Load test data · Run simulation · Ingest custom telemetry (PS §4.1)" accent="blue" className="h-full">
                <DataIngest
                  onDataLoaded={() => { refresh(); }}
                  onNotify={(type, msg) => addNotif(type, msg)}
                />
              </PanelBox>
            </div>
            <div className="col-span-12 lg:col-span-7 flex flex-col gap-3">
              {/* Connection status */}
              <div className="rounded border p-4 text-xs" style={{
                background:'rgba(5,15,30,.85)',
                borderColor: healthy ? '#1a4a2a' : '#4a1818',
              }}>
                <div className={`font-bold text-sm mb-3 ${healthy ? 'text-green-400' : 'text-red-400'}`}>
                  {healthy ? '✓ Backend is running and healthy' : '✗ Backend is offline'}
                </div>
                {!healthy && (
                  <div className="space-y-2 text-gray-400">
                    <div className="text-yellow-400 font-bold mb-2">HOW TO START THE BACKEND:</div>
                    <div className="bg-gray-900 rounded p-2 font-mono text-xs text-green-300">
                      # Option 1 — Direct Python<br/>
                      cd backend/<br/>
                      uvicorn main:app --host 0.0.0.0 --port 8000 --reload
                    </div>
                    <div className="bg-gray-900 rounded p-2 font-mono text-xs text-green-300">
                      # Option 2 — Docker (PS §8)<br/>
                      docker build -t aether .<br/>
                      docker run -p 8000:8000 aether
                    </div>
                    <div className="bg-gray-900 rounded p-2 font-mono text-xs text-green-300">
                      # Option 3 — Docker Compose<br/>
                      docker compose up --build
                    </div>
                    <div className="text-gray-600 mt-2">The frontend will auto-detect when backend comes online.</div>
                  </div>
                )}
                {healthy && (
                  <div className="space-y-2">
                    <div className="text-gray-400">Backend is running on port 8000. Use the panel on the left to:</div>
                    <div className="grid grid-cols-2 gap-2 mt-2">
                      {[
                        ['🚀 Load Demo Data', 'Generates realistic satellites + debris and ingests via POST /api/telemetry'],
                        ['☄ Test Avoidance', 'Places debris 50m from satellite to trigger full collision avoidance chain'],
                        ['⏯ Run Simulation', 'Step forward in simulated time — each step runs RK4 + conjunction detection'],
                        ['📥 Custom JSON', 'Paste any PS §4.1 compliant telemetry JSON directly'],
                      ].map(([title, desc]) => (
                        <div key={title} className="rounded border border-gray-800 p-2" style={{ background:'rgba(8,18,35,.6)' }}>
                          <div className="text-blue-400 font-bold text-xs mb-1">{title}</div>
                          <div className="text-gray-600 text-xs">{desc}</div>
                        </div>
                      ))}
                    </div>
                    <div className="mt-3 pt-2 border-t border-gray-800 text-gray-500">
                      After loading data → switch to <span className="text-blue-400">DASHBOARD</span> tab to see the 3D visualization.
                    </div>
                  </div>
                )}
              </div>
              {/* API reference */}
              <div className="rounded border border-gray-800 p-3 text-xs" style={{ background:'rgba(5,15,30,.85)' }}>
                <div className="text-gray-400 font-bold tracking-widest mb-2">API ENDPOINTS (PS §4)</div>
                <div className="space-y-1 font-mono" style={{ fontSize:10 }}>
                  {[
                    ['POST', '/api/telemetry',           'Ingest satellite + debris state vectors'],
                    ['POST', '/api/maneuver/schedule',   'Schedule burn sequence for satellite'],
                    ['POST', '/api/simulate/step',       'Advance simulation by step_seconds'],
                    ['GET',  '/api/visualization/snapshot', 'Optimized frontend snapshot (PS §6.3)'],
                    ['GET',  '/api/conjunction/forecast', '24-hour CDM forecast (PS §2)'],
                    ['GET',  '/api/system/metrics',      'Uptime, fuel, maneuver stats (PS §7)'],
                    ['GET',  '/api/status',              'Health check endpoint (PS §8)'],
                    ['POST', '/api/reset',               'Reset simulation state'],
                  ].map(([method, path, desc]) => (
                    <div key={path} className="flex gap-2 items-start py-0.5 border-b border-gray-800/50">
                      <span className={`w-10 font-bold ${method==='POST'?'text-green-400':'text-blue-400'}`}>{method}</span>
                      <span className="text-yellow-300 w-56">{path}</span>
                      <span className="text-gray-500">{desc}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* DASHBOARD TAB */}
        {tab === 'dashboard' && (
          <div className="grid grid-cols-12 gap-3">
            {/* 3D Globe */}
            <div className="col-span-12 lg:col-span-8" style={{ height:540 }}>
              <PanelBox title="3D ORBITAL VIEW" sub="WebGL Three.js · Atmosphere · Terminator · Debris Cloud · PS §6.1" accent="blue" className="h-full">
                <ThreeScene satellites={sats} debris={deb} selectedSat={selectedSat} onSatelliteClick={id => { setSelectedSat(id); addNotif('info', `Selected ${id}`); }} />
              </PanelBox>
            </div>

            {/* Right column */}
            <div className="col-span-12 lg:col-span-4 flex flex-col gap-3" style={{ height:540 }}>
              {/* Quick stats */}
              <div className="grid grid-cols-2 gap-2">
                {[
                  { label:'SATELLITES', val:sats.length || status.satellites, col:'#3b82f6', icon:'🛰' },
                  { label:'DEBRIS',     val:deb.length || status.debris_objects, col:'#f97316', icon:'☄' },
                  { label:'MANEUVERS',  val:metrics.maneuvers_executed || 0, col:'#10b981', icon:'⚡' },
                  { label:'AVOIDED',    val:metrics.collisions_avoided  || 0, col:'#8b5cf6', icon:'🛡' },
                ].map(s => (
                  <div key={s.label} className="rounded border border-gray-800/60 p-3"
                       style={{ background:'rgba(5,15,30,.85)' }}>
                    <div className="text-gray-600 text-xs tracking-widest">{s.icon} {s.label}</div>
                    <div className="text-2xl font-bold mt-1" style={{ color:s.col }}>{s.val}</div>
                  </div>
                ))}
              </div>

              {/* Conjunction alerts */}
              <div className="flex-1 rounded border border-gray-800/60 flex flex-col overflow-hidden"
                   style={{ background:'rgba(5,15,30,.85)' }}>
                <div className="px-3 py-2 border-b border-gray-800/50 text-xs font-bold tracking-widest text-red-400">⚠ CONJUNCTION ALERTS</div>
                <div className="flex-1 overflow-y-auto p-2 space-y-1">
                  {conjunctions.filter(c => c.severity !== 'SAFE').length === 0
                    ? <div className="text-gray-700 text-xs text-center py-4">No active threats</div>
                    : conjunctions.filter(c => c.severity !== 'SAFE').map((c, i) => (
                      <div key={i} onClick={() => { setSelectedSat(c.sat_id); setTab('satellites'); }}
                        className={`p-2 rounded cursor-pointer border-l-2 hover:opacity-80 transition ${
                          c.severity === 'CRITICAL' ? 'bg-red-950/40 border-red-500' : 'bg-yellow-950/30 border-yellow-500'}`}>
                        <div className="flex justify-between text-xs">
                          <span className="text-white font-bold">{c.sat_id} ↔ {c.deb_id}</span>
                          <span className="text-gray-500">{c.tca_offset_s?.toFixed(0)}s</span>
                        </div>
                        <div className="text-gray-500 text-xs mt-0.5">
                          {c.min_dist_km?.toFixed(3)} km · <span className={c.severity==='CRITICAL'?'text-red-400':'text-yellow-400'}>{c.severity}</span>
                        </div>
                      </div>
                    ))
                  }
                </div>
              </div>

              {/* Fuel bars */}
              <div className="rounded border border-gray-800/60 p-3" style={{ background:'rgba(5,15,30,.85)' }}>
                <div className="text-yellow-400 text-xs font-bold tracking-widest mb-2">⛽ FLEET FUEL</div>
                {sats.length === 0
                  ? <div className="text-gray-700 text-xs text-center py-2">No satellites loaded</div>
                  : sats.slice(0, 5).map(sat => {
                    const pct = Math.max(0, Math.min(100, (sat.fuel_kg / 50) * 100));
                    const col = pct > 60 ? '#10b981' : pct > 30 ? '#f59e0b' : '#ef4444';
                    return (
                      <div key={sat.id} className="flex items-center gap-2 mb-1">
                        <span className="text-xs text-gray-500 w-14 truncate">{sat.id.slice(-6)}</span>
                        <div className="flex-1 h-1.5 bg-gray-800 rounded overflow-hidden">
                          <div className="h-full rounded transition-all" style={{ width:`${pct}%`, background:col }} />
                        </div>
                        <span className="text-xs w-10 text-right" style={{ color:col }}>{pct.toFixed(0)}%</span>
                      </div>
                    );
                  })
                }
              </div>
            </div>

            {/* Ground Track Map */}
            <div className="col-span-12" style={{ height:280 }}>
              <PanelBox title="GROUND TRACK MAP" sub="Mercator · 90-min trail · RK4 prediction · Terminator · Debris cloud · PS §6.2" accent="blue" className="h-full">
                <GroundTrackMap satellites={sats} debris={deb} selectedSat={selectedSat}
                  timestamp={snapshot?.timestamp} onSatClick={setSelectedSat} />
              </PanelBox>
            </div>
          </div>
        )}

        {/* SATELLITES TAB */}
        {tab === 'satellites' && (
          <div className="grid grid-cols-12 gap-3">
            {/* Satellite list */}
            <div className="col-span-12 lg:col-span-3">
              <PanelBox title="SATELLITE FLEET" sub="Click to select" accent="blue" className="h-full" style={{ minHeight:200 }}>
                <div className="overflow-y-auto p-2 space-y-1">
                  {sats.length === 0
                    ? <div className="text-gray-600 text-xs text-center py-6">No satellites — go to Data Ingest tab</div>
                    : sats.map(sat => {
                      const pct = (sat.fuel_kg / 50) * 100;
                      const col = pct > 60 ? '#10b981' : pct > 30 ? '#f59e0b' : '#ef4444';
                      return (
                        <div key={sat.id} onClick={() => setSelectedSat(sat.id)}
                          className={`p-2 rounded cursor-pointer border text-xs transition ${selectedSat === sat.id ? 'border-blue-500 bg-blue-950/40' : 'border-gray-800 hover:border-gray-600'}`}>
                          <div className="flex justify-between">
                            <span className="font-bold text-white">{sat.id}</span>
                            <span className="text-xs px-1.5 py-0.5 rounded font-bold" style={{ background: sat.status==='GRAVEYARD'?'#374151':sat.status==='ACTIVE'?'#064e3b':'#7f1d1d', color:'#fff', fontSize:8 }}>{sat.status}</span>
                          </div>
                          <div className="mt-1 h-1 bg-gray-800 rounded overflow-hidden">
                            <div className="h-full rounded" style={{ width:`${pct}%`, background:col }} />
                          </div>
                          <div className="text-gray-600 mt-0.5">{sat.fuel_kg?.toFixed(1)}kg · {sat.lat?.toFixed(1)}°N {sat.lon?.toFixed(1)}°E</div>
                        </div>
                      );
                    })
                  }
                </div>
              </PanelBox>
            </div>
            <div className="col-span-12 lg:col-span-5" style={{ height:500 }}>
              <PanelBox title={`BULLSEYE — ${selectedSat}`} sub="Conjunction Polar Chart · TCA radial distance · Risk color coding · PS §6.2" accent="red" className="h-full">
                <BullseyePlot satelliteId={selectedSat} conjunctions={conjunctions} />
              </PanelBox>
            </div>
            <div className="col-span-12 lg:col-span-4" style={{ height:500 }}>
              <PanelBox title="TELEMETRY HEATMAP" sub="Fuel gauges · ΔV efficiency · Uptime radar · PS §6.2" accent="green" className="h-full">
                <TelemetryHeatmap satellites={sats} metrics={metrics} />
              </PanelBox>
            </div>
            <div className="col-span-12" style={{ height:300 }}>
              <PanelBox title="MANEUVER TIMELINE" sub="Gantt · Burn blocks · 600s Cooldown · Blackout zones · PS §6.2" accent="yellow" className="h-full">
                <ManeuverTimeline satelliteId={selectedSat} onBurnClick={b => addNotif('info', 'Burn selected', b.burn_id)} />
              </PanelBox>
            </div>
          </div>
        )}

        {/* CONJUNCTIONS TAB */}
        {tab === 'conjunctions' && (
          <div className="grid grid-cols-12 gap-3">
            <div className="col-span-12 grid grid-cols-3 gap-3">
              {[['CRITICAL', '#ef4444'], ['WARNING', '#f59e0b'], ['SAFE', '#10b981']].map(([sev, col]) => (
                <div key={sev} className="rounded border border-gray-800 p-4 text-center" style={{ background:'rgba(5,15,30,.85)' }}>
                  <div className="text-4xl font-bold mb-1" style={{ color:col }}>
                    {conjunctions.filter(c => c.severity === sev).length}
                  </div>
                  <div className="text-gray-500 text-xs tracking-widest">{sev}</div>
                </div>
              ))}
            </div>
            <div className="col-span-8" style={{ height:450 }}>
              <PanelBox title="24-HOUR CDM FORECAST" sub="All predicted conjunctions · PS §2 requirement" accent="red" className="h-full">
                <div className="overflow-y-auto h-full">
                  {conjunctions.length === 0
                    ? <div className="text-gray-600 text-xs text-center py-12">No conjunctions forecast — ingest data and run simulation</div>
                    : <table className="w-full text-xs">
                        <thead className="sticky top-0" style={{ background:'rgba(3,10,20,.95)' }}>
                          <tr className="text-gray-500 border-b border-gray-800">
                            {['Satellite','Debris','TCA (s)','Distance','Severity','Prob','Action'].map(h =>
                              <th key={h} className="text-left py-2 px-3 font-bold tracking-widest" style={{ fontSize:9 }}>{h}</th>
                            )}
                          </tr>
                        </thead>
                        <tbody>
                          {conjunctions.map((c, i) => (
                            <tr key={i} className="border-b border-gray-800/40 hover:bg-gray-800/20 cursor-pointer" onClick={() => setSelectedSat(c.sat_id)}>
                              <td className="py-2 px-3 text-blue-400 font-bold">{c.sat_id}</td>
                              <td className="py-2 px-3 text-gray-300">{c.deb_id}</td>
                              <td className="py-2 px-3 text-gray-300">{c.tca_offset_s?.toFixed(0)}</td>
                              <td className="py-2 px-3 text-gray-300">{c.min_dist_km?.toFixed(3)} km</td>
                              <td className="py-2 px-3">
                                <span className={`px-2 py-0.5 rounded text-xs font-bold ${c.severity==='CRITICAL'?'bg-red-700':c.severity==='WARNING'?'bg-yellow-700':'bg-green-800'}`}>{c.severity}</span>
                              </td>
                              <td className="py-2 px-3 text-gray-400">{c.prob?.toFixed(4) || '—'}</td>
                              <td className="py-2 px-3 text-green-400 text-xs">{c.action || 'MONITORING'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                  }
                </div>
              </PanelBox>
            </div>
            <div className="col-span-4" style={{ height:450 }}>
              <PanelBox title={`BULLSEYE — ${selectedSat}`} sub="PS §6.2" accent="red" className="h-full">
                <BullseyePlot satelliteId={selectedSat} conjunctions={conjunctions} />
              </PanelBox>
            </div>
          </div>
        )}

        {/* MANEUVERS TAB */}
        {tab === 'maneuvers' && (
          <div className="grid grid-cols-12 gap-3">
            <div className="col-span-12 grid grid-cols-4 gap-3">
              {[
                { l:'Total Maneuvers', v:metrics.maneuvers_executed||0, col:'#3b82f6' },
                { l:'Collisions Avoided', v:metrics.collisions_avoided||0, col:'#10b981' },
                { l:'Fuel Used', v:`${(metrics.fuel_used_total_kg||0).toFixed(2)} kg`, col:'#f59e0b' },
                { l:'Success Rate', v:`${Math.min(100,(((metrics.collisions_avoided||0)/Math.max(metrics.maneuvers_executed||1,1))*100)).toFixed(1)}%`, col:'#8b5cf6' },
              ].map(s => (
                <div key={s.l} className="rounded border border-gray-800 p-4" style={{ background:'rgba(5,15,30,.85)' }}>
                  <div className="text-gray-600 text-xs tracking-widest mb-1">{s.l.toUpperCase()}</div>
                  <div className="text-3xl font-bold" style={{ color:s.col }}>{s.v}</div>
                </div>
              ))}
            </div>
            <div className="col-span-12" style={{ height:360 }}>
              <PanelBox title="MANEUVER TIMELINE" sub="Gantt Scheduler · Burns · Cooldown blocks · LOS blackout · PS §6.2" accent="yellow" className="h-full">
                <ManeuverTimeline satelliteId={selectedSat} onBurnClick={b => addNotif('info', 'Burn', b.burn_id)} />
              </PanelBox>
            </div>
            <div className="col-span-12" style={{ height:340 }}>
              <PanelBox title="ΔV EFFICIENCY ANALYSIS" sub="Fuel vs Collisions Avoided · PS §6.2 §7" accent="purple" className="h-full">
                <TelemetryHeatmap satellites={sats} metrics={metrics} />
              </PanelBox>
            </div>
          </div>
        )}

        {/* GROUND STATIONS TAB */}
        {tab === 'groundstations' && (
          <div className="grid grid-cols-3 gap-3">
            {[
              { name:'ISTRAC Bengaluru',      lat:13.0333, lon:77.5167,   alt:820,  minEl:5 },
              { name:'Svalbard Sat Station',  lat:78.2297, lon:15.4077,   alt:400,  minEl:5 },
              { name:'Goldstone Tracking',    lat:35.4266, lon:-116.89,   alt:1000, minEl:10 },
              { name:'Punta Arenas',          lat:-53.15,  lon:-70.9167,  alt:30,   minEl:5 },
              { name:'IIT Delhi Ground Node', lat:28.545,  lon:77.1926,   alt:225,  minEl:15 },
              { name:'McMurdo Station',       lat:-77.8463,lon:166.6682,  alt:10,   minEl:5 },
            ].map((gs, i) => {
              const passes = nextPasses[selectedSat] || [];
              const pass   = passes[i];
              const wait   = pass?.estimated_wait_seconds;
              return (
                <div key={gs.name} className="rounded border border-gray-800 p-4" style={{ background:'rgba(5,15,30,.85)' }}>
                  <div className="flex justify-between items-start mb-3">
                    <div className="text-blue-400 font-bold text-xs">{gs.name}</div>
                    <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                  </div>
                  <div className="space-y-1 text-xs text-gray-400">
                    <div>Lat: <span className="text-white">{gs.lat}°</span></div>
                    <div>Lon: <span className="text-white">{gs.lon}°</span></div>
                    <div>Alt: <span className="text-white">{gs.alt} m</span></div>
                    <div>Min El: <span className="text-white">{gs.minEl}°</span></div>
                  </div>
                  <div className="mt-3 pt-2 border-t border-gray-800 text-xs">
                    <div className="flex justify-between">
                      <span className="text-gray-600">Next pass for {selectedSat?.slice(-4)}:</span>
                      <span className={wait != null ? 'text-green-400 font-bold' : 'text-gray-700'}>
                        {wait != null ? `${Math.floor(wait/60)}m ${wait%60}s` : '—'}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ALERT LOG TAB */}
        {tab === 'alerts' && (
          <PanelBox title="CDM ALERT HISTORY" sub="All conjunction data messages logged · PS §2" accent="red" className="h-full" style={{ minHeight:500 }}>
            <div className="overflow-y-auto" style={{ maxHeight:'calc(100vh - 200px)' }}>
              {alerts.length === 0
                ? <div className="text-gray-600 text-xs text-center py-16">No CDM alerts yet — run simulation to generate conjunction data</div>
                : <table className="w-full text-xs">
                    <thead className="sticky top-0" style={{ background:'rgba(3,10,20,.95)' }}>
                      <tr className="text-gray-500 border-b border-gray-800">
                        {['Alert ID','Time','Satellite','Debris','Distance','Severity','Prob','Action'].map(h =>
                          <th key={h} className="text-left py-2 px-3 font-bold" style={{ fontSize:9 }}>{h}</th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {alerts.map((a, i) => (
                        <tr key={i} className="border-b border-gray-800/40 hover:bg-gray-800/20">
                          <td className="py-2 px-3 text-gray-600 font-mono text-xs">{a.alert_id?.slice(-10)}</td>
                          <td className="py-2 px-3 text-gray-400">{a.timestamp?.slice(11,19)}</td>
                          <td className="py-2 px-3 text-blue-400 font-bold">{a.sat_id}</td>
                          <td className="py-2 px-3 text-gray-300">{a.deb_id}</td>
                          <td className="py-2 px-3 text-gray-300">{a.distance?.toFixed(3)} km</td>
                          <td className="py-2 px-3"><span className={`px-1.5 py-0.5 rounded text-xs font-bold ${a.severity==='CRITICAL'?'bg-red-800':a.severity==='WARNING'?'bg-yellow-800':'bg-green-800'}`}>{a.severity}</span></td>
                          <td className="py-2 px-3 text-gray-400">{a.prob?.toFixed(4)}</td>
                          <td className="py-2 px-3 text-green-400">{a.action}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
              }
            </div>
          </PanelBox>
        )}
      </main>

      {/* ── STATUS BAR ────────────────────────────────────────────────────── */}
      <footer className="flex-shrink-0 border-t border-gray-800/40 flex justify-between items-center px-4 h-7 text-xs"
              style={{ background:'rgba(2,8,16,.95)', color:'#374151' }}>
        <div className="flex gap-4">
          <span>© 2026 AETHER · National Space Hackathon · IIT Delhi</span>
          <span>|</span>
          <span>Backend: <span className={healthy?'text-green-500':'text-red-500'}>{healthy?'ONLINE':'OFFLINE'}</span></span>
        </div>
        <div className="flex gap-4">
          <span>Sats: <span className="text-blue-400">{sats.length||status.satellites}</span></span>
          <span>Debris: <span className="text-orange-400">{deb.length||status.debris_objects}</span></span>
          <span>Sim: <span className={simRunning?'text-green-400':'text-gray-600'}>{simRunning?'RUNNING':'PAUSED'}</span></span>
          <span>Elapsed: <span className="text-blue-400">{fmtTime(status.elapsed_sim_time_s||0)}</span></span>
        </div>
      </footer>
    </div>
  );
}