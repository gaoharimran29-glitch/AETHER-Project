// src/components/TelemetryHeatmap.jsx
import React, { useEffect, useState } from 'react';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, 
  ResponsiveContainer, ScatterChart, Scatter, ZAxis,
  LineChart, Line, AreaChart, Area, PieChart, Pie, Cell,
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  Legend
} from 'recharts';
import { fetchMetrics, fetchAllObjects } from '../api/aetherApi';

const TelemetryHeatmap = ({ satellites = [], metrics = {} }) => {
  const [fuelData, setFuelData] = useState([]);
  const [efficiencyData, setEfficiencyData] = useState([]);
  const [riskHeatmap, setRiskHeatmap] = useState([]);
  const [fuelDistribution, setFuelDistribution] = useState([]);
  const [uptimeRadar, setUptimeRadar] = useState([]);
  const [selectedView, setSelectedView] = useState('fuel');
  const [historicalEfficiency, setHistoricalEfficiency] = useState([]);

  // Colors for charts
  const COLORS = {
    critical: '#ef4444',
    warning: '#f59e0b',
    safe: '#10b981',
    fuel: '#3b82f6',
    efficiency: '#8b5cf6',
    uptime: '#ec4899'
  };

  // Process data when satellites or metrics change
  useEffect(() => {
    if (!satellites.length) return;

    // --- FUEL GAUGE DATA ---
    const fuel = satellites.map(sat => ({
      name: sat.id.slice(-8),
      fullName: sat.id,
      fuel: sat.fuel_kg || 0,
      status: sat.status || 'ACTIVE',
      fuelPercent: ((sat.fuel_kg || 0) / 50) * 100, // 50kg max
      battery: Math.random() * 100, // Simulated battery level
      temperature: 20 + Math.random() * 30 // Simulated temperature
    })).sort((a, b) => b.fuel - a.fuel);
    
    setFuelData(fuel);

    // --- FUEL DISTRIBUTION (for pie chart) ---
    const fuelRanges = {
      critical: fuel.filter(f => f.fuelPercent < 10).length,
      low: fuel.filter(f => f.fuelPercent >= 10 && f.fuelPercent < 30).length,
      medium: fuel.filter(f => f.fuelPercent >= 30 && f.fuelPercent < 60).length,
      high: fuel.filter(f => f.fuelPercent >= 60).length
    };
    
    setFuelDistribution([
      { name: 'Critical (<10%)', value: fuelRanges.critical, color: '#ef4444' },
      { name: 'Low (10-30%)', value: fuelRanges.low, color: '#f59e0b' },
      { name: 'Medium (30-60%)', value: fuelRanges.medium, color: '#3b82f6' },
      { name: 'High (>60%)', value: fuelRanges.high, color: '#10b981' }
    ]);

    // --- EFFICIENCY DATA (Fuel vs Collisions Avoided) ---
    setEfficiencyData([
      {
        name: 'Efficiency Ratio',
        fuelUsed: metrics.fuel_used_total_kg || 0,
        collisionsAvoided: metrics.collisions_avoided || 0,
        maneuvers: metrics.maneuvers_executed || 0,
        efficiency: metrics.collisions_avoided ? 
          (metrics.collisions_avoided / (metrics.fuel_used_total_kg || 1)) * 100 : 0
      }
    ]);

    // --- GENERATE RISK HEATMAP DATA (Simulated debris density) ---
    const heatmap = [];
    for (let i = 0; i < 20; i++) {
      for (let j = 0; j < 20; j++) {
        // Create a hot spot near certain satellites
        let risk = Math.random() * 30;
        
        // Higher risk near low-fuel satellites (they can't maneuver)
        fuel.forEach((sat, idx) => {
          if (sat.fuelPercent < 20) {
            const distance = Math.sqrt(
              Math.pow(i - idx * 3, 2) + 
              Math.pow(j - idx * 2, 2)
            );
            risk += 50 / (distance + 1);
          }
        });
        
        heatmap.push({
          x: i * 10,
          y: j * 10,
          risk: Math.min(risk, 100)
        });
      }
    }
    setRiskHeatmap(heatmap);

    // --- UPTIME RADAR DATA ---
    if (metrics.satellite_uptime_pct) {
      const topSats = Object.entries(metrics.satellite_uptime_pct)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6);
      
      setUptimeRadar(topSats.map(([id, pct]) => ({
        subject: id.slice(-6),
        uptime: pct,
        fullMark: 100
      })));
    }

    // --- HISTORICAL EFFICIENCY (Simulated time series) ---
    const history = [];
    const now = Date.now();
    for (let i = 30; i >= 0; i--) {
      history.push({
        time: new Date(now - i * 60000).toLocaleTimeString(),
        fuelUsed: (metrics.fuel_used_total_kg || 0) * (1 - i/60) + Math.random() * 5,
        collisions: Math.floor((metrics.collisions_avoided || 0) * (1 - i/60)),
        risk: 30 + Math.random() * 40
      });
    }
    setHistoricalEfficiency(history);

  }, [satellites, metrics]);

  // Custom tooltip for fuel bars
  const CustomFuelTooltip = ({ active, payload, label }) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-gray-800 border border-gray-700 rounded p-3 text-xs">
          <p className="text-blue-400 font-bold mb-1">{payload[0].payload.fullName}</p>
          <p className="text-gray-300">Fuel: <span className="text-white">{payload[0].value.toFixed(1)} kg</span></p>
          <p className="text-gray-300">Status: <span className={`text-${
            payload[0].payload.status === 'ACTIVE' ? 'green' : 
            payload[0].payload.status === 'MANEUVER' ? 'yellow' : 'gray'
          }-400`}>{payload[0].payload.status}</span></p>
          <p className="text-gray-300">Battery: <span className="text-yellow-400">{payload[0].payload.battery?.toFixed(0)}%</span></p>
          <p className="text-gray-300">Temp: <span className="text-red-400">{payload[0].payload.temperature?.toFixed(0)}°C</span></p>
        </div>
      );
    }
    return null;
  };

  // Custom tooltip for heatmap
  const CustomHeatmapTooltip = ({ active, payload }) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-gray-800 border border-gray-700 rounded p-2 text-xs">
          <p className="text-gray-300">Risk Level: <span className={`font-bold ${
            payload[0].value > 70 ? 'text-red-400' : 
            payload[0].value > 40 ? 'text-yellow-400' : 'text-green-400'
          }`}>{payload[0].value.toFixed(1)}%</span></p>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="w-full h-full bg-gray-900 rounded-lg p-4 font-mono overflow-y-auto">
      {/* Header with view selector */}
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-blue-400 font-bold text-lg">TELEMETRY & RESOURCE HEATMAP</h3>
        <div className="flex space-x-2">
          {['fuel', 'efficiency', 'risk', 'history'].map(view => (
            <button
              key={view}
              className={`px-3 py-1 text-xs rounded ${
                selectedView === view 
                  ? 'bg-blue-600 text-white' 
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
              }`}
              onClick={() => setSelectedView(view)}
            >
              {view.charAt(0).toUpperCase() + view.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* FUEL VIEW */}
      {selectedView === 'fuel' && (
        <div className="space-y-4">
          {/* Fuel Bar Chart */}
          <div className="bg-gray-800/50 rounded p-3">
            <h4 className="text-gray-400 text-sm mb-3">🚀 Fuel Status by Satellite</h4>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={fuelData} layout="vertical" margin={{ left: 60 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis type="number" stroke="#9ca3af" domain={[0, 50]} />
                  <YAxis type="category" dataKey="name" stroke="#9ca3af" width={60} />
                  <Tooltip content={<CustomFuelTooltip />} />
                  <Bar dataKey="fuel" fill="#3b82f6" radius={[0, 4, 4, 0]}>
                    {fuelData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={
                        entry.fuelPercent < 10 ? '#ef4444' :
                        entry.fuelPercent < 30 ? '#f59e0b' :
                        entry.fuelPercent < 60 ? '#3b82f6' : '#10b981'
                      } />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Two column layout for distribution and stats */}
          <div className="grid grid-cols-2 gap-4">
            {/* Fuel Distribution Pie */}
            <div className="bg-gray-800/50 rounded p-3">
              <h4 className="text-gray-400 text-sm mb-2">📊 Fuel Distribution</h4>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={fuelDistribution}
                      cx="50%"
                      cy="50%"
                      innerRadius={40}
                      outerRadius={70}
                      paddingAngle={2}
                      dataKey="value"
                    >
                      {fuelDistribution.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="grid grid-cols-2 gap-2 mt-2">
                {fuelDistribution.map((item, idx) => (
                  <div key={idx} className="flex items-center text-xs">
                    <div className="w-2 h-2 rounded-full mr-1" style={{ backgroundColor: item.color }}></div>
                    <span className="text-gray-400">{item.name}:</span>
                    <span className="text-white ml-1">{item.value}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Fuel Stats */}
            <div className="bg-gray-800/50 rounded p-3">
              <h4 className="text-gray-400 text-sm mb-2">⛽ Fuel Statistics</h4>
              <div className="space-y-3">
                <div>
                  <div className="flex justify-between text-xs text-gray-400">
                    <span>Total Fuel</span>
                    <span className="text-white">{fuelData.reduce((acc, s) => acc + s.fuel, 0).toFixed(1)} kg</span>
                  </div>
                  <div className="w-full h-2 bg-gray-700 rounded mt-1">
                    <div 
                      className="h-2 bg-blue-500 rounded" 
                      style={{ width: `${(fuelData.reduce((acc, s) => acc + s.fuel, 0) / (fuelData.length * 50)) * 100}%` }}
                    ></div>
                  </div>
                </div>
                
                <div>
                  <div className="flex justify-between text-xs text-gray-400">
                    <span>Average Fuel</span>
                    <span className="text-white">{(fuelData.reduce((acc, s) => acc + s.fuel, 0) / fuelData.length).toFixed(1)} kg</span>
                  </div>
                </div>
                
                <div>
                  <div className="flex justify-between text-xs text-gray-400">
                    <span>Low Fuel (&lt;20%)</span>
                    <span className="text-yellow-400">{fuelData.filter(s => s.fuelPercent < 20).length} satellites</span>
                  </div>
                </div>
                
                <div>
                  <div className="flex justify-between text-xs text-gray-400">
                    <span>Critical (&lt;10%)</span>
                    <span className="text-red-400">{fuelData.filter(s => s.fuelPercent < 10).length} satellites</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Temperature/Battery Mini Chart */}
          <div className="bg-gray-800/50 rounded p-3">
            <h4 className="text-gray-400 text-sm mb-2">🌡️ System Health</h4>
            <div className="h-32">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={fuelData.slice(0, 8)}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis dataKey="name" stroke="#9ca3af" />
                  <YAxis stroke="#9ca3af" />
                  <Tooltip />
                  <Line type="monotone" dataKey="temperature" stroke="#ef4444" name="Temp °C" />
                  <Line type="monotone" dataKey="battery" stroke="#f59e0b" name="Battery %" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}

      {/* EFFICIENCY VIEW */}
      {selectedView === 'efficiency' && (
        <div className="space-y-4">
          {/* Efficiency Bar Chart */}
          <div className="bg-gray-800/50 rounded p-3">
            <h4 className="text-gray-400 text-sm mb-3">📈 Fuel vs Collisions Avoided</h4>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={efficiencyData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis dataKey="name" stroke="#9ca3af" />
                  <YAxis yAxisId="left" stroke="#9ca3af" />
                  <YAxis yAxisId="right" orientation="right" stroke="#9ca3af" />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#1f2937', border: 'none' }}
                    labelStyle={{ color: '#fff' }}
                  />
                  <Bar yAxisId="left" dataKey="fuelUsed" fill="#3b82f6" name="Fuel Used (kg)" />
                  <Bar yAxisId="right" dataKey="collisionsAvoided" fill="#10b981" name="Collisions Avoided" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Efficiency Metrics */}
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-gray-800/50 rounded p-3 text-center">
              <div className="text-gray-400 text-xs">Efficiency Ratio</div>
              <div className="text-2xl font-bold text-purple-400">
                {efficiencyData[0]?.efficiency.toFixed(2)}
              </div>
              <div className="text-gray-500 text-xs">collisions/kg</div>
            </div>
            
            <div className="bg-gray-800/50 rounded p-3 text-center">
              <div className="text-gray-400 text-xs">Fuel Economy</div>
              <div className="text-2xl font-bold text-green-400">
                {(efficiencyData[0]?.collisionsAvoided / (efficiencyData[0]?.fuelUsed || 1)).toFixed(3)}
              </div>
              <div className="text-gray-500 text-xs">avoid/kg</div>
            </div>
            
            <div className="bg-gray-800/50 rounded p-3 text-center">
              <div className="text-gray-400 text-xs">Success Rate</div>
              <div className="text-2xl font-bold text-blue-400">
                {((efficiencyData[0]?.collisionsAvoided / (efficiencyData[0]?.collisionsAvoided + 1)) * 100).toFixed(1)}%
              </div>
              <div className="text-gray-500 text-xs">avoidance rate</div>
            </div>
          </div>

          {/* Historical Efficiency Trend */}
          <div className="bg-gray-800/50 rounded p-3">
            <h4 className="text-gray-400 text-sm mb-2">📉 Efficiency Trend (Last 30 min)</h4>
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={historicalEfficiency}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis dataKey="time" stroke="#9ca3af" tick={{ fontSize: 10 }} interval={5} />
                  <YAxis stroke="#9ca3af" />
                  <Tooltip />
                  <Area type="monotone" dataKey="fuelUsed" stackId="1" stroke="#3b82f6" fill="#3b82f680" />
                  <Area type="monotone" dataKey="collisions" stackId="2" stroke="#10b981" fill="#10b98180" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}

      {/* RISK HEATMAP VIEW */}
      {selectedView === 'risk' && (
        <div className="space-y-4">
          {/* Debris Density Heatmap */}
          <div className="bg-gray-800/50 rounded p-3">
            <h4 className="text-gray-400 text-sm mb-3">🔥 Debris Density & Collision Risk</h4>
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
                  <CartesianGrid stroke="#374151" />
                  <XAxis type="number" dataKey="x" stroke="#9ca3af" domain={[0, 200]} />
                  <YAxis type="number" dataKey="y" stroke="#9ca3af" domain={[0, 200]} />
                  <ZAxis type="number" dataKey="risk" range={[50, 500]} />
                  <Tooltip content={<CustomHeatmapTooltip />} />
                  <Scatter 
                    data={riskHeatmap} 
                    fill="#8884d8" 
                    shape="circle"
                  >
                    {riskHeatmap.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={
                        entry.risk > 70 ? '#ef4444' :
                        entry.risk > 40 ? '#f59e0b' :
                        entry.risk > 20 ? '#3b82f6' : '#10b981'
                      } />
                    ))}
                  </Scatter>
                </ScatterChart>
              </ResponsiveContainer>
            </div>
            
            {/* Risk Legend */}
            <div className="flex justify-center space-x-6 mt-4">
              <div className="flex items-center">
                <div className="w-3 h-3 bg-red-500 rounded mr-2"></div>
                <span className="text-xs text-gray-400">High Risk (&gt;70%)</span>
              </div>
              <div className="flex items-center">
                <div className="w-3 h-3 bg-yellow-500 rounded mr-2"></div>
                <span className="text-xs text-gray-400">Medium Risk (40-70%)</span>
              </div>
              <div className="flex items-center">
                <div className="w-3 h-3 bg-blue-500 rounded mr-2"></div>
                <span className="text-xs text-gray-400">Low Risk (20-40%)</span>
              </div>
              <div className="flex items-center">
                <div className="w-3 h-3 bg-green-500 rounded mr-2"></div>
                <span className="text-xs text-gray-400">Safe (&lt;20%)</span>
              </div>
            </div>
          </div>

          {/* Risk Statistics */}
          <div className="grid grid-cols-4 gap-4">
            <div className="bg-gray-800/50 rounded p-2 text-center">
              <div className="text-red-400 text-lg font-bold">
                {riskHeatmap.filter(r => r.risk > 70).length}
              </div>
              <div className="text-gray-400 text-xs">High Risk Zones</div>
            </div>
            <div className="bg-gray-800/50 rounded p-2 text-center">
              <div className="text-yellow-400 text-lg font-bold">
                {riskHeatmap.filter(r => r.risk > 40 && r.risk <= 70).length}
              </div>
              <div className="text-gray-400 text-xs">Medium Risk</div>
            </div>
            <div className="bg-gray-800/50 rounded p-2 text-center">
              <div className="text-blue-400 text-lg font-bold">
                {riskHeatmap.filter(r => r.risk > 20 && r.risk <= 40).length}
              </div>
              <div className="text-gray-400 text-xs">Low Risk</div>
            </div>
            <div className="bg-gray-800/50 rounded p-2 text-center">
              <div className="text-green-400 text-lg font-bold">
                {riskHeatmap.filter(r => r.risk <= 20).length}
              </div>
              <div className="text-gray-400 text-xs">Safe Zones</div>
            </div>
          </div>
        </div>
      )}

      {/* HISTORY VIEW */}
      {selectedView === 'history' && (
        <div className="space-y-4">
          {/* Uptime Radar Chart */}
          <div className="bg-gray-800/50 rounded p-3">
            <h4 className="text-gray-400 text-sm mb-2">📡 Constellation Uptime Radar</h4>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <RadarChart outerRadius="80%" data={uptimeRadar}>
                  <PolarGrid stroke="#374151" />
                  <PolarAngleAxis dataKey="subject" stroke="#9ca3af" tick={{ fill: '#9ca3af', fontSize: 10 }} />
                  <PolarRadiusAxis angle={30} domain={[0, 100]} stroke="#9ca3af" />
                  <Radar name="Uptime" dataKey="uptime" stroke="#ec4899" fill="#ec4899" fillOpacity={0.5} />
                  <Tooltip />
                </RadarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Historical Performance */}
          <div className="bg-gray-800/50 rounded p-3">
            <h4 className="text-gray-400 text-sm mb-2">⏱️ Historical Performance</h4>
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={historicalEfficiency}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis dataKey="time" stroke="#9ca3af" tick={{ fontSize: 10 }} interval={5} />
                  <YAxis yAxisId="left" stroke="#9ca3af" />
                  <YAxis yAxisId="right" orientation="right" stroke="#9ca3af" />
                  <Tooltip />
                  <Line yAxisId="left" type="monotone" dataKey="risk" stroke="#ef4444" name="Risk %" />
                  <Line yAxisId="right" type="monotone" dataKey="collisions" stroke="#10b981" name="Collisions" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Summary Stats */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-gray-800/50 rounded p-3">
              <h4 className="text-gray-400 text-xs mb-2">📊 Lifetime Statistics</h4>
              <div className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-400">Total Maneuvers:</span>
                  <span className="text-blue-400">{metrics.maneuvers_executed || 0}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Collisions Avoided:</span>
                  <span className="text-green-400">{metrics.collisions_avoided || 0}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Total Fuel Used:</span>
                  <span className="text-yellow-400">{metrics.fuel_used_total_kg?.toFixed(2) || 0} kg</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Sim Time:</span>
                  <span className="text-purple-400">{Math.round(metrics.elapsed_sim_time_s / 60)} min</span>
                </div>
              </div>
            </div>

            <div className="bg-gray-800/50 rounded p-3">
              <h4 className="text-gray-400 text-xs mb-2">🎯 Efficiency Score</h4>
              <div className="text-center">
                <div className="text-5xl font-bold text-purple-400 mb-2">
                  {Math.min(100, Math.round(((metrics.collisions_avoided || 0) / (metrics.maneuvers_executed || 1)) * 100))}
                </div>
                <div className="text-gray-400 text-xs">out of 100</div>
                <div className="w-full h-2 bg-gray-700 rounded mt-3">
                  <div 
                    className="h-2 bg-purple-500 rounded" 
                    style={{ width: `${Math.min(100, ((metrics.collisions_avoided || 0) / (metrics.maneuvers_executed || 1)) * 100)}%` }}
                  ></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default TelemetryHeatmap;