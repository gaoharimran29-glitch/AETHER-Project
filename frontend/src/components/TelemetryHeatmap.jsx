// src/components/TelemetryHeatmap.jsx
// PS §6.2 — Telemetry & Resource Heatmaps
// FIXED: removed random/simulated data, all real from backend;
//        proper fuel gauge per satellite, ΔV cost vs collisions avoided chart

import React, { useMemo, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, AreaChart, Area, RadarChart, Radar,
  PolarGrid, PolarAngleAxis, PolarRadiusAxis, ScatterChart,
  Scatter, ZAxis, Cell, Legend,
} from 'recharts';

const INITIAL_FUEL = 50.0; // kg  PS §5.1

function fuelColor(pct) {
  if (pct < 10) return '#ef4444';
  if (pct < 30) return '#f59e0b';
  if (pct < 60) return '#3b82f6';
  return '#10b981';
}

function statusBadge(status) {
  const map = {
    NOMINAL:   'bg-green-900/40 text-green-400 border-green-700',
    GRAVEYARD: 'bg-gray-800 text-gray-500 border-gray-600',
    EVADING:   'bg-yellow-900/40 text-yellow-400 border-yellow-700',
    ACTIVE:    'bg-blue-900/40 text-blue-400 border-blue-700',
  };
  return `inline-flex px-1.5 py-0.5 rounded border text-xs font-mono ${map[status] || map.ACTIVE}`;
}

const FuelGauge = ({ sat }) => {
  const fuel = sat.fuel_kg ?? sat.fuel ?? 0;
  const pct  = Math.max(0, Math.min(100, (fuel / INITIAL_FUEL) * 100));
  const col  = fuelColor(pct);
  return (
    <div className="mb-3">
      <div className="flex justify-between items-center mb-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-gray-300 truncate max-w-[120px]">{sat.id}</span>
          <span className={statusBadge(sat.status)}>{sat.status}</span>
        </div>
        <span className="text-xs font-mono" style={{ color: col }}>{pct.toFixed(1)}%</span>
      </div>
      <div className="w-full h-2.5 bg-gray-800 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{
            width: `${pct}%`,
            background: `linear-gradient(90deg, ${col}88, ${col})`,
            boxShadow: `0 0 6px ${col}66`,
          }}
        />
      </div>
      <div className="flex justify-between text-xs text-gray-600 mt-0.5">
        <span>{fuel.toFixed(1)} kg</span>
        <span>{(INITIAL_FUEL - fuel).toFixed(1)} kg used</span>
      </div>
    </div>
  );
};

const VIEWS = ['fuel', 'efficiency', 'uptime', 'history'];

const TelemetryHeatmap = ({ satellites = [], metrics = {} }) => {
  const [view, setView] = useState('fuel');

  // ── Derived chart data (all from real props, no Math.random) ───────────────

  const fuelBarData = useMemo(() =>
    satellites
      .map(s => ({
        name:    s.id.slice(-8),
        fullId:  s.id,
        fuel:    s.fuel_kg ?? s.fuel ?? 0,
        pct:     Math.max(0, ((s.fuel_kg ?? s.fuel ?? 0) / INITIAL_FUEL) * 100),
        status:  s.status,
      }))
      .sort((a, b) => b.fuel - a.fuel),
    [satellites]
  );

  const efficiencyData = useMemo(() => [{
    name:             'Mission',
    fuelUsed:         metrics.fuel_used_total_kg ?? 0,
    collisionsAvoided: metrics.collisions_avoided  ?? 0,
    maneuvers:        metrics.maneuvers_executed   ?? 0,
    efficiency:       (metrics.maneuvers_executed ?? 0) > 0
                        ? Math.min(100, ((metrics.collisions_avoided ?? 0) / metrics.maneuvers_executed) * 100)
                        : 0,
  }], [metrics]);

  const uptimeData = useMemo(() =>
    Object.entries(metrics.satellite_uptime_pct || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([id, pct]) => ({ subject: id.slice(-6), uptime: pct, fullMark: 100 })),
    [metrics]
  );

  const dvScatterData = useMemo(() =>
    satellites.map(s => ({
      satId:   s.id,
      fuelUsed: INITIAL_FUEL - (s.fuel_kg ?? s.fuel ?? INITIAL_FUEL),
      uptime:   metrics.satellite_uptime_pct?.[s.id] ?? 100,
    })),
    [satellites, metrics]
  );

  const CustomFuelTooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const d = payload[0].payload;
    return (
      <div className="bg-gray-900 border border-gray-700 rounded p-2 text-xs font-mono">
        <div className="text-blue-400 font-bold mb-1">{d.fullId}</div>
        <div className="text-gray-300">Fuel: <span className="text-white">{d.fuel.toFixed(2)} kg</span></div>
        <div className="text-gray-300">Remaining: <span style={{ color: fuelColor(d.pct) }}>{d.pct.toFixed(1)}%</span></div>
        <div className="text-gray-300">Status: <span className="text-white">{d.status}</span></div>
      </div>
    );
  };

  const summaryStats = [
    { label: 'Total Maneuvers',    value: metrics.maneuvers_executed  ?? 0, color: '#3b82f6' },
    { label: 'Collisions Avoided', value: metrics.collisions_avoided  ?? 0, color: '#10b981' },
    { label: 'Fuel Used (kg)',     value: (metrics.fuel_used_total_kg ?? 0).toFixed(2), color: '#f59e0b' },
    { label: 'Sim Time (min)',     value: Math.round((metrics.elapsed_sim_time_s ?? 0) / 60), color: '#8b5cf6' },
  ];

  return (
    <div className="w-full h-full bg-gray-900 rounded-lg p-4 font-mono overflow-y-auto flex flex-col gap-4">

      {/* Header + view selector */}
      <div className="flex justify-between items-center flex-shrink-0">
        <div>
          <h3 className="text-blue-400 font-bold tracking-widest text-sm">TELEMETRY & RESOURCE HEATMAP</h3>
          <p className="text-gray-600 text-xs mt-0.5">Fleet-wide health monitoring  ·  PS §6.2</p>
        </div>
        <div className="flex gap-1">
          {VIEWS.map(v => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-2 py-1 text-xs rounded transition-colors ${
                view === v ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
              }`}
            >
              {v.charAt(0).toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Summary stats strip */}
      <div className="grid grid-cols-4 gap-2 flex-shrink-0">
        {summaryStats.map(s => (
          <div key={s.label} className="bg-gray-800/50 rounded p-2 text-center border border-gray-700/50">
            <div className="text-lg font-bold" style={{ color: s.color }}>{s.value}</div>
            <div className="text-gray-500 text-xs mt-0.5">{s.label}</div>
          </div>
        ))}
      </div>

      {/* ── FUEL VIEW ─────────────────────────────────────────────────────────── */}
      {view === 'fuel' && (
        <div className="space-y-4">
          {/* Per-satellite fuel gauges */}
          <div className="bg-gray-800/40 rounded p-3 border border-gray-700/50">
            <h4 className="text-gray-400 text-xs mb-3 tracking-widest">⛽ PROPELLANT BUDGET  (PS §5.1)</h4>
            {satellites.length === 0
              ? <div className="text-gray-600 text-xs text-center py-4">No satellite data — ingest telemetry first</div>
              : satellites.map(s => <FuelGauge key={s.id} sat={s} />)
            }
          </div>

          {/* Fuel bar chart */}
          {fuelBarData.length > 0 && (
            <div className="bg-gray-800/40 rounded p-3 border border-gray-700/50">
              <h4 className="text-gray-400 text-xs mb-3 tracking-widest">📊 FUEL COMPARISON</h4>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={fuelBarData} margin={{ top: 4, right: 4, left: 4, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                    <XAxis dataKey="name" stroke="#4b5563" tick={{ fontSize: 9, fill: '#9ca3af' }} />
                    <YAxis stroke="#4b5563" tick={{ fontSize: 9, fill: '#9ca3af' }} domain={[0, 50]} label={{ value: 'kg', angle: -90, position: 'insideLeft', fill: '#4b5563', fontSize: 9 }} />
                    <Tooltip content={<CustomFuelTooltip />} />
                    <Bar dataKey="fuel" radius={[2, 2, 0, 0]}>
                      {fuelBarData.map((d, i) => (
                        <Cell key={i} fill={fuelColor(d.pct)} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── EFFICIENCY VIEW ───────────────────────────────────────────────────── */}
      {view === 'efficiency' && (
        <div className="space-y-4">
          <div className="bg-gray-800/40 rounded p-3 border border-gray-700/50">
            <h4 className="text-gray-400 text-xs mb-3 tracking-widest">🎯 ΔV COST vs COLLISIONS AVOIDED  (PS §6.2)</h4>
            <div className="grid grid-cols-3 gap-3 mb-4">
              {[
                { label: 'Fuel Used', value: `${(metrics.fuel_used_total_kg ?? 0).toFixed(2)} kg`, col: '#f59e0b' },
                { label: 'Avoided',   value: metrics.collisions_avoided ?? 0, col: '#10b981' },
                { label: 'Efficiency', value: `${efficiencyData[0].efficiency.toFixed(1)}%`, col: '#8b5cf6' },
              ].map(s => (
                <div key={s.label} className="bg-gray-900 rounded p-3 text-center border border-gray-700/40">
                  <div className="text-xl font-bold" style={{ color: s.col }}>{s.value}</div>
                  <div className="text-gray-500 text-xs mt-1">{s.label}</div>
                </div>
              ))}
            </div>

            {/* ΔV efficiency scatter: fuel used vs uptime per satellite */}
            {dvScatterData.length > 0 && (
              <>
                <h4 className="text-gray-400 text-xs mb-2">Fuel Used vs Uptime per Satellite</h4>
                <div className="h-48">
                  <ResponsiveContainer width="100%" height="100%">
                    <ScatterChart margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                      <XAxis dataKey="fuelUsed" name="Fuel Used (kg)" stroke="#4b5563" tick={{ fontSize: 9, fill: '#9ca3af' }} label={{ value: 'Fuel Used (kg)', position: 'bottom', fill: '#4b5563', fontSize: 9 }} />
                      <YAxis dataKey="uptime"   name="Uptime %" stroke="#4b5563" tick={{ fontSize: 9, fill: '#9ca3af' }} domain={[0, 100]} label={{ value: 'Uptime %', angle: -90, position: 'insideLeft', fill: '#4b5563', fontSize: 9 }} />
                      <ZAxis range={[40, 120]} />
                      <Tooltip cursor={{ strokeDasharray: '3 3' }} formatter={(v, n) => [typeof v === 'number' ? v.toFixed(2) : v, n]} />
                      <Scatter data={dvScatterData} fill="#3b82f6" opacity={0.8} />
                    </ScatterChart>
                  </ResponsiveContainer>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── UPTIME VIEW ───────────────────────────────────────────────────────── */}
      {view === 'uptime' && (
        <div className="space-y-4">
          <div className="bg-gray-800/40 rounded p-3 border border-gray-700/50">
            <h4 className="text-gray-400 text-xs mb-3 tracking-widest">📡 CONSTELLATION UPTIME RADAR  (PS §5.2)</h4>
            {uptimeData.length > 0 ? (
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <RadarChart data={uptimeData} outerRadius="80%">
                    <PolarGrid stroke="#1f2937" />
                    <PolarAngleAxis dataKey="subject" stroke="#4b5563" tick={{ fill: '#9ca3af', fontSize: 10 }} />
                    <PolarRadiusAxis angle={30} domain={[0, 100]} stroke="#4b5563" tick={{ fill: '#6b7280', fontSize: 8 }} />
                    <Radar name="Uptime %" dataKey="uptime" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.35} />
                    <Tooltip formatter={v => [`${v.toFixed(1)}%`, 'Uptime']} />
                  </RadarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="text-gray-600 text-xs text-center py-8">Run simulation to generate uptime data</div>
            )}
          </div>

          {/* Uptime table */}
          {Object.keys(metrics.satellite_uptime_pct || {}).length > 0 && (
            <div className="bg-gray-800/40 rounded p-3 border border-gray-700/50 max-h-48 overflow-y-auto">
              <h4 className="text-gray-400 text-xs mb-2 tracking-widest">UPTIME TABLE</h4>
              {Object.entries(metrics.satellite_uptime_pct).map(([id, pct]) => (
                <div key={id} className="flex justify-between items-center py-1 border-b border-gray-800">
                  <span className="text-xs font-mono text-gray-300">{id}</span>
                  <div className="flex items-center gap-2">
                    <div className="w-20 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: pct > 90 ? '#10b981' : pct > 70 ? '#f59e0b' : '#ef4444' }} />
                    </div>
                    <span className="text-xs font-mono" style={{ color: pct > 90 ? '#10b981' : pct > 70 ? '#f59e0b' : '#ef4444' }}>{pct.toFixed(1)}%</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── HISTORY VIEW ──────────────────────────────────────────────────────── */}
      {view === 'history' && (
        <div className="space-y-4">
          <div className="bg-gray-800/40 rounded p-3 border border-gray-700/50">
            <h4 className="text-gray-400 text-xs mb-1 tracking-widest">📊 MISSION SUMMARY</h4>
            <div className="space-y-2 mt-3">
              {[
                { label: 'Safety Score',      value: `${(metrics.collisions_avoided ?? 0)} avoided`, note: 'PS §7 — 25% weight', col: '#10b981' },
                { label: 'Fuel Efficiency',   value: `${(metrics.fuel_used_total_kg ?? 0).toFixed(2)} kg used`, note: 'PS §7 — 20% weight', col: '#f59e0b' },
                { label: 'Uptime',            value: uptimeData.length > 0 ? `${(uptimeData.reduce((s, d) => s + d.uptime, 0) / uptimeData.length).toFixed(1)}% avg` : '—', note: 'PS §7 — 15% weight', col: '#3b82f6' },
                { label: 'Maneuvers Executed',value: metrics.maneuvers_executed ?? 0, note: 'PS §7 — Algo Speed', col: '#8b5cf6' },
              ].map(row => (
                <div key={row.label} className="flex justify-between items-center py-2 border-b border-gray-800/60">
                  <div>
                    <div className="text-xs text-gray-300 font-bold">{row.label}</div>
                    <div className="text-gray-600 text-xs">{row.note}</div>
                  </div>
                  <div className="text-sm font-bold font-mono" style={{ color: row.col }}>{row.value}</div>
                </div>
              ))}
            </div>

            {/* Efficiency score */}
            <div className="mt-4 text-center">
              <div className="text-5xl font-bold text-purple-400">
                {Math.min(100, Math.round(((metrics.collisions_avoided ?? 0) / Math.max(metrics.maneuvers_executed ?? 1, 1)) * 100))}
              </div>
              <div className="text-gray-500 text-xs mt-1">EFFICIENCY SCORE / 100</div>
              <div className="w-full h-2.5 bg-gray-800 rounded-full mt-2 overflow-hidden">
                <div
                  className="h-full bg-purple-500 rounded-full transition-all duration-700"
                  style={{ width: `${Math.min(100, ((metrics.collisions_avoided ?? 0) / Math.max(metrics.maneuvers_executed ?? 1, 1)) * 100)}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default TelemetryHeatmap;