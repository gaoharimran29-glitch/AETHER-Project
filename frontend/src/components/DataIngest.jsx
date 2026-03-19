// src/components/DataIngest.jsx
// Judge/Demo control panel — ingest telemetry, run simulation, test all PS endpoints
// This is what hackathon judges use to load data and test your system
import React, { useState } from 'react';
import {
  ingestTelemetry, createTestTelemetry, resetSimulation,
  simulateStep, startSimulation, stopSimulation,
} from '../api/aetherApi';

const BTN = 'px-3 py-1.5 rounded text-xs font-bold tracking-widest transition border';

export default function DataIngest({ onDataLoaded, onNotify }) {
  const [numSats,    setNumSats]    = useState(6);
  const [numDebris,  setNumDebris]  = useState(50);
  const [stepSecs,   setStepSecs]   = useState(60);
  const [autoSteps,  setAutoSteps]  = useState(10);
  const [running,    setRunning]    = useState(false);
  const [log,        setLog]        = useState([]);
  const [customJson, setCustomJson] = useState('');
  const [jsonErr,    setJsonErr]    = useState('');

  const addLog = (msg, type = 'info') => {
    const time = new Date().toLocaleTimeString();
    setLog(p => [`[${time}] ${msg}`, ...p].slice(0, 30));
    if (onNotify) onNotify(type, msg);
  };

  // Load demo data
  const handleLoadDemo = async () => {
    try {
      setRunning(true);
      addLog(`Generating ${numSats} satellites + ${numDebris} debris objects…`);
      const data = createTestTelemetry(numSats, numDebris);
      const r    = await ingestTelemetry(data);
      addLog(`✓ Ingested: ${r.processed_count} objects. CDM warnings: ${r.active_cdm_warnings}`, 'ok');
      if (onDataLoaded) onDataLoaded();
    } catch (e) {
      addLog(`✗ Ingest failed: ${e.message}`, 'error');
    } finally { setRunning(false); }
  };

  // Ingest custom JSON
  const handleCustomIngest = async () => {
    setJsonErr('');
    let parsed;
    try { parsed = JSON.parse(customJson); }
    catch (e) { setJsonErr(`JSON parse error: ${e.message}`); return; }
    try {
      setRunning(true);
      const r = await ingestTelemetry(parsed);
      addLog(`✓ Custom data ingested: ${r.processed_count} objects`, 'ok');
      if (onDataLoaded) onDataLoaded();
    } catch (e) {
      addLog(`✗ Custom ingest failed: ${e.message}`, 'error');
    } finally { setRunning(false); }
  };

  // Single step
  const handleStep = async () => {
    try {
      const r = await simulateStep(stepSecs);
      addLog(`✓ Step +${stepSecs}s → collisions: ${r.collisions_detected}, maneuvers: ${r.maneuvers_executed}`, 'ok');
      if (onDataLoaded) onDataLoaded();
    } catch (e) { addLog(`✗ Step failed: ${e.message}`, 'error'); }
  };

  // Auto-step N times
  const handleAutoStep = async () => {
    setRunning(true);
    try {
      for (let i = 0; i < autoSteps; i++) {
        const r = await simulateStep(stepSecs);
        addLog(`Step ${i + 1}/${autoSteps} +${stepSecs}s → col:${r.collisions_detected} mnvr:${r.maneuvers_executed}`);
        if (onDataLoaded) onDataLoaded();
        await new Promise(res => setTimeout(res, 200));
      }
      addLog(`✓ Auto-step complete: ${autoSteps} × ${stepSecs}s = ${autoSteps * stepSecs}s sim time`, 'ok');
    } catch (e) { addLog(`✗ Auto-step failed: ${e.message}`, 'error'); }
    finally { setRunning(false); }
  };

  // Reset
  const handleReset = async () => {
    try {
      await resetSimulation();
      addLog('✓ Simulation reset — all data cleared', 'warn');
      if (onDataLoaded) onDataLoaded();
    } catch (e) { addLog(`✗ Reset failed: ${e.message}`, 'error'); }
  };

  // Close approach scenario — triggers avoidance
  const handleCollisionTest = async () => {
    try {
      setRunning(true);
      addLog('Ingesting CLOSE APPROACH scenario (50m separation)…');
      const data = {
        timestamp: new Date().toISOString(),
        objects: [
          { id:'SAT-DANGER', type:'SATELLITE', r:{x:6778.000,y:0,z:0}, v:{x:0,y:7.67,z:0}, fuel:50 },
          { id:'DEB-CLOSE',  type:'DEBRIS',    r:{x:6778.050,y:0,z:0}, v:{x:0,y:7.60,z:0} },
        ],
      };
      await ingestTelemetry(data);
      addLog('Ingested. Running step to trigger avoidance…');
      const r = await simulateStep(1);
      addLog(`✓ Avoidance test: col=${r.collisions_detected} mnvr=${r.maneuvers_executed}`, r.maneuvers_executed > 0 ? 'ok' : 'warn');
      if (onDataLoaded) onDataLoaded();
    } catch (e) { addLog(`✗ Collision test failed: ${e.message}`, 'error'); }
    finally { setRunning(false); }
  };

  const sampleJson = JSON.stringify({
    timestamp: new Date().toISOString(),
    objects: [
      { id:'SAT-X01', type:'SATELLITE', r:{x:6778,y:0,z:0}, v:{x:0,y:7.67,z:0}, fuel:50 },
      { id:'DEB-X01', type:'DEBRIS',    r:{x:6800,y:100,z:0}, v:{x:0,y:7.60,z:0} },
    ],
  }, null, 2);

  return (
    <div className="w-full h-full flex flex-col gap-3 overflow-y-auto p-1" style={{ fontFamily: 'monospace' }}>

      {/* ── Quick actions ── */}
      <div className="rounded border border-gray-800 p-3" style={{ background: 'rgba(5,15,30,.85)' }}>
        <div className="text-blue-400 text-xs font-bold tracking-widest mb-3">⚡ QUICK ACTIONS</div>

        <div className="grid grid-cols-2 gap-2 mb-3">
          <div>
            <label className="text-gray-500 text-xs block mb-1">Satellites</label>
            <input type="number" value={numSats} min={1} max={60} onChange={e => setNumSats(+e.target.value)}
              className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-white text-xs" />
          </div>
          <div>
            <label className="text-gray-500 text-xs block mb-1">Debris objects</label>
            <input type="number" value={numDebris} min={1} max={500} onChange={e => setNumDebris(+e.target.value)}
              className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-white text-xs" />
          </div>
        </div>

        <button onClick={handleLoadDemo} disabled={running}
          className={`w-full ${BTN} bg-blue-700/60 border-blue-600 text-blue-200 hover:bg-blue-600/80 mb-2 ${running ? 'opacity-50 cursor-not-allowed' : ''}`}>
          🚀 LOAD DEMO CONSTELLATION
        </button>

        <button onClick={handleCollisionTest} disabled={running}
          className={`w-full ${BTN} bg-red-800/50 border-red-700 text-red-200 hover:bg-red-700/70 ${running ? 'opacity-50 cursor-not-allowed' : ''}`}>
          ☄ TEST COLLISION AVOIDANCE (50m separation)
        </button>
      </div>

      {/* ── Simulation controls ── */}
      <div className="rounded border border-gray-800 p-3" style={{ background: 'rgba(5,15,30,.85)' }}>
        <div className="text-green-400 text-xs font-bold tracking-widest mb-3">▶ SIMULATION CONTROLS</div>

        <div className="grid grid-cols-2 gap-2 mb-2">
          <div>
            <label className="text-gray-500 text-xs block mb-1">Step seconds (dt)</label>
            <select value={stepSecs} onChange={e => setStepSecs(+e.target.value)}
              className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-white text-xs">
              {[1, 10, 60, 300, 600, 3600].map(v => <option key={v} value={v}>{v}s {v >= 3600 ? '(1hr)' : v >= 60 ? `(${v/60}min)` : ''}</option>)}
            </select>
          </div>
          <div>
            <label className="text-gray-500 text-xs block mb-1">Auto-step count</label>
            <input type="number" value={autoSteps} min={1} max={100} onChange={e => setAutoSteps(+e.target.value)}
              className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-white text-xs" />
          </div>
        </div>

        <div className="flex gap-2 mb-2">
          <button onClick={handleStep} disabled={running}
            className={`flex-1 ${BTN} bg-green-800/50 border-green-700 text-green-200 hover:bg-green-700/60 ${running ? 'opacity-50 cursor-not-allowed' : ''}`}>
            ⏯ STEP ({stepSecs}s)
          </button>
          <button onClick={handleAutoStep} disabled={running}
            className={`flex-1 ${BTN} bg-emerald-800/50 border-emerald-700 text-emerald-200 hover:bg-emerald-700/60 ${running ? 'opacity-50 cursor-not-allowed' : ''}`}>
            ⏩ AUTO ×{autoSteps}
          </button>
        </div>

        <button onClick={handleReset} disabled={running}
          className={`w-full ${BTN} bg-orange-900/40 border-orange-800 text-orange-300 hover:bg-orange-800/50 ${running ? 'opacity-50 cursor-not-allowed' : ''}`}>
          ↺ RESET SIMULATION
        </button>
      </div>

      {/* ── Custom JSON ingest ── */}
      <div className="rounded border border-gray-800 p-3" style={{ background: 'rgba(5,15,30,.85)' }}>
        <div className="text-yellow-400 text-xs font-bold tracking-widest mb-2">📥 CUSTOM JSON INGEST</div>
        <div className="text-gray-600 text-xs mb-2">Paste PS §4.1 format telemetry JSON:</div>
        <textarea
          value={customJson}
          onChange={e => { setCustomJson(e.target.value); setJsonErr(''); }}
          placeholder={sampleJson}
          rows={6}
          className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-gray-300 text-xs font-mono resize-none mb-1"
          style={{ fontSize: 10 }}
        />
        {jsonErr && <div className="text-red-400 text-xs mb-1">{jsonErr}</div>}
        <button onClick={handleCustomIngest} disabled={running || !customJson.trim()}
          className={`w-full ${BTN} bg-yellow-800/40 border-yellow-700 text-yellow-200 hover:bg-yellow-700/50 ${(!customJson.trim() || running) ? 'opacity-40 cursor-not-allowed' : ''}`}>
          📤 INGEST CUSTOM DATA
        </button>
      </div>

      {/* ── Activity log ── */}
      <div className="rounded border border-gray-800 p-3 flex-1 min-h-0" style={{ background: 'rgba(2,8,16,.9)' }}>
        <div className="text-gray-500 text-xs font-bold tracking-widest mb-2">📋 ACTIVITY LOG</div>
        <div className="overflow-y-auto space-y-0.5" style={{ maxHeight: 180 }}>
          {log.length === 0
            ? <div className="text-gray-700 text-xs text-center py-4">No activity yet — load demo data to start</div>
            : log.map((l, i) => (
              <div key={i} className={`text-xs font-mono ${
                l.includes('✓') ? 'text-green-400' :
                l.includes('✗') ? 'text-red-400' :
                l.includes('↺') ? 'text-yellow-400' : 'text-gray-400'
              }`}>{l}</div>
            ))
          }
        </div>
      </div>
    </div>
  );
}