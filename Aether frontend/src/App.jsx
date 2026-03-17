// src/App.jsx
import React, { useEffect, useState, useCallback } from 'react';
import GroundTrackMap from './components/GroundTrackMap';
import BullseyePlot from './components/BullseyePlot';
import TelemetryHeatmap from './components/TelemetryHeatmap';
import ManeuverTimeline from './components/ManeuverTimeline';
import ThreeScene from './components/ThreeScene';
import { 
  fetchSnapshot, 
  fetchStatus, 
  fetchMetrics, 
  fetchConjunctionForecast,
  simulateStep,
  startSimulation,
  stopSimulation,
  resetSimulation,
  checkBackendHealth,
  AetherWebSocket
} from './api/aetherApi';

function App() {
  // ==========================================================================
  // STATE
  // ==========================================================================
  const [selectedSat, setSelectedSat] = useState('SAT-A01');
  const [snapshot, setSnapshot] = useState({ satellites: [], debris_cloud: [] });
  const [status, setStatus] = useState({});
  const [metrics, setMetrics] = useState({});
  const [conjunctions, setConjunctions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [simulationSpeed, setSimulationSpeed] = useState(5);
  const [backendHealthy, setBackendHealthy] = useState(true);
  const [notifications, setNotifications] = useState([]);
  const [showSettings, setShowSettings] = useState(false);
  const [darkMode, setDarkMode] = useState(true);

  // ==========================================================================
  // INITIAL DATA LOAD
  // ==========================================================================
  useEffect(() => {
    const loadInitialData = async () => {
      try {
        // Check backend health first
        const health = await checkBackendHealth();
        setBackendHealthy(health.healthy);
        
        if (!health.healthy) {
          addNotification('error', 'Backend connection failed', 'Using mock data');
        }

        // Load all data in parallel
        const [snap, stat, met, conj] = await Promise.all([
          fetchSnapshot(),
          fetchStatus(),
          fetchMetrics(),
          fetchConjunctionForecast()
        ]);
        
        setSnapshot(snap);
        setStatus(stat);
        setMetrics(met);
        setConjunctions(conj.forecast || []);
        
        // Set first satellite as selected if none selected
        if (snap.satellites?.length > 0 && !selectedSat) {
          setSelectedSat(snap.satellites[0].id);
        }

        addNotification('success', 'Data loaded', `Loaded ${snap.satellites?.length || 0} satellites`);
      } catch (error) {
        console.error('Failed to load initial data:', error);
        addNotification('error', 'Failed to load data', error.message);
        
        // Use mock data for development
        setSnapshot(getMockSnapshot());
        setStatus(getMockStatus());
        setMetrics(getMockMetrics());
        setConjunctions(getMockConjunctions());
      } finally {
        setLoading(false);
      }
    };
    
    loadInitialData();
    
    // Set up auto-refresh every 5 seconds
    const interval = setInterval(refreshData, 5000);
    return () => clearInterval(interval);
  }, []);

  // ==========================================================================
  // WEBSOCKET CONNECTION
  // ==========================================================================
  useEffect(() => {
    const ws = new AetherWebSocket(
      // onMessage
      (data) => {
        if (data.type === 'snapshot') {
          setSnapshot(data.payload);
        } else if (data.type === 'conjunction') {
          setConjunctions(prev => [data.payload, ...prev].slice(0, 100));
          addNotification('warning', 'New Conjunction Alert', 
            `${data.payload.sat_id} - ${data.payload.severity}`);
        } else if (data.type === 'maneuver') {
          refreshData();
        }
      },
      // onError
      (error) => {
        console.error('WebSocket error:', error);
      },
      // onClose
      () => {
        console.log('WebSocket closed');
      }
    );
    
    ws.connect();
    return () => ws.disconnect();
  }, []);

  // ==========================================================================
  // REFRESH DATA
  // ==========================================================================
  const refreshData = useCallback(async () => {
    try {
      const [snap, stat, met, conj] = await Promise.all([
        fetchSnapshot(),
        fetchStatus(),
        fetchMetrics(),
        fetchConjunctionForecast()
      ]);
      
      setSnapshot(snap);
      setStatus(stat);
      setMetrics(met);
      setConjunctions(conj.forecast || []);
    } catch (error) {
      console.error('Refresh failed:', error);
    }
  }, []);

  // ==========================================================================
  // NOTIFICATIONS
  // ==========================================================================
  const addNotification = (type, title, message) => {
    const id = Date.now();
    setNotifications(prev => [...prev, { id, type, title, message }]);
    
    // Auto-remove after 5 seconds
    setTimeout(() => {
      setNotifications(prev => prev.filter(n => n.id !== id));
    }, 5000);
  };

  const removeNotification = (id) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
  };

  // ==========================================================================
  // SIMULATION CONTROLS
  // ==========================================================================
  const handleStep = async () => {
    try {
      const result = await simulateStep(simulationSpeed);
      addNotification('info', 'Simulation Step', `Advanced ${simulationSpeed}s`);
      await refreshData();
    } catch (error) {
      addNotification('error', 'Step Failed', error.message);
    }
  };

  const handleStart = async () => {
    try {
      await startSimulation(simulationSpeed);
      addNotification('success', 'Simulation Started', `Running at ${simulationSpeed}s steps`);
    } catch (error) {
      addNotification('error', 'Start Failed', error.message);
    }
  };

  const handleStop = async () => {
    try {
      await stopSimulation();
      addNotification('info', 'Simulation Stopped', 'Manual control resumed');
    } catch (error) {
      addNotification('error', 'Stop Failed', error.message);
    }
  };

  const handleReset = async () => {
    try {
      await resetSimulation();
      await refreshData();
      addNotification('warning', 'Simulation Reset', 'All data cleared');
    } catch (error) {
      addNotification('error', 'Reset Failed', error.message);
    }
  };

  // ==========================================================================
  // MOCK DATA FOR DEVELOPMENT
  // ==========================================================================
  const getMockSnapshot = () => ({
    timestamp: new Date().toISOString(),
    satellites: [
      { id: 'SAT-A01', lat: 28.5, lon: 77.2, fuel_kg: 48.5, status: 'ACTIVE', alt_km: 550 },
      { id: 'SAT-A02', lat: -53.1, lon: -70.9, fuel_kg: 32.8, status: 'ACTIVE', alt_km: 550 },
      { id: 'SAT-B01', lat: 78.2, lon: 15.4, fuel_kg: 15.2, status: 'WARNING', alt_km: 550 },
      { id: 'SAT-B02', lat: 35.4, lon: -116.9, fuel_kg: 8.4, status: 'CRITICAL', alt_km: 550 },
      { id: 'SAT-C01', lat: -77.8, lon: 166.7, fuel_kg: 42.1, status: 'ACTIVE', alt_km: 550 },
      { id: 'SAT-C02', lat: 13.0, lon: 77.5, fuel_kg: 0.0, status: 'GRAVEYARD', alt_km: 800 },
    ],
    debris_cloud: [
      ['DEB-001', 12.4, -45.2, 400.5],
      ['DEB-002', 12.6, -45.1, 401.2],
      ['DEB-003', -23.5, 120.3, 450.8],
      ['DEB-004', 45.8, -93.2, 380.3],
      ['DEB-005', 67.2, -150.5, 520.1],
    ]
  });

  const getMockStatus = () => ({
    simulation_running: false,
    satellites: 6,
    debris_objects: 15000,
    alerts: { collisions: 2, avoidances_executed: 15 },
    elapsed_sim_time_s: 36000,
    sim_timestamp: new Date().toISOString()
  });

  const getMockMetrics = () => ({
    maneuvers_executed: 47,
    collisions_avoided: 12,
    fuel_used_total_kg: 156.3,
    elapsed_sim_time_s: 36000,
    satellite_uptime_pct: {
      'SAT-A01': 98.5,
      'SAT-A02': 95.2,
      'SAT-B01': 87.3,
      'SAT-B02': 62.8,
      'SAT-C01': 99.1,
      'SAT-C02': 0.0
    }
  });

  const getMockConjunctions = () => ([
    { 
      sat_id: 'SAT-B02', 
      deb_id: 'DEB-004', 
      tca_offset_s: 15, 
      min_dist_km: 0.8, 
      severity: 'CRITICAL' 
    },
    { 
      sat_id: 'SAT-A02', 
      deb_id: 'DEB-002', 
      tca_offset_s: 45, 
      min_dist_km: 3.2, 
      severity: 'WARNING' 
    },
    { 
      sat_id: 'SAT-C01', 
      deb_id: 'DEB-005', 
      tca_offset_s: 120, 
      min_dist_km: 8.5, 
      severity: 'SAFE' 
    }
  ]);

  // ==========================================================================
  // RENDER LOADING STATE
  // ==========================================================================
  if (loading) {
    return (
      <div className="min-h-screen bg-space-black flex items-center justify-center">
        <div className="text-center">
          <div className="relative">
            {/* Animated satellite */}
            <div className="w-24 h-24 mx-auto mb-8 relative">
              <div className="absolute inset-0 border-4 border-blue-500 rounded-full animate-ping opacity-25"></div>
              <div className="absolute inset-2 border-4 border-blue-400 rounded-full animate-spin"></div>
              <div className="absolute inset-4 bg-blue-500 rounded-full animate-pulse"></div>
            </div>
          </div>
          <h1 className="text-4xl font-bold text-blue-400 mb-4 animate-pulse">AETHER</h1>
          <p className="text-gray-400 text-xl mb-8">Autonomous Constellation Manager</p>
          <div className="flex justify-center space-x-2">
            <div className="w-3 h-3 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '0s' }}></div>
            <div className="w-3 h-3 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
            <div className="w-3 h-3 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '0.4s' }}></div>
          </div>
          <p className="text-gray-500 text-sm mt-8">National Space Hackathon 2026 - IIT Delhi</p>
        </div>
      </div>
    );
  }

  // ==========================================================================
  // MAIN RENDER
  // ==========================================================================
  return (
    <div className={`min-h-screen ${darkMode ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-900'}`}>
      {/* ===== NOTIFICATIONS ===== */}
      <div className="fixed top-4 right-4 z-50 space-y-2 w-80">
        {notifications.map(notif => (
          <div
            key={notif.id}
            className={`p-4 rounded-lg shadow-lg flex items-start transform transition-all duration-500 animate-slideIn ${
              notif.type === 'success' ? 'bg-green-600' :
              notif.type === 'error' ? 'bg-red-600' :
              notif.type === 'warning' ? 'bg-yellow-600' :
              'bg-blue-600'
            }`}
          >
            <div className="flex-1">
              <h4 className="font-bold text-white">{notif.title}</h4>
              <p className="text-white text-sm opacity-90">{notif.message}</p>
            </div>
            <button
              onClick={() => removeNotification(notif.id)}
              className="ml-4 text-white hover:text-gray-200"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {/* ===== HEADER ===== */}
      <header className={`${darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'} border-b sticky top-0 z-40`}>
        <div className="container mx-auto px-4">
          <div className="flex justify-between items-center h-16">
            {/* Logo and Title */}
            <div className="flex items-center space-x-4">
              <div className="flex items-center">
                <div className="w-10 h-10 bg-blue-600 rounded-lg flex items-center justify-center mr-3">
                  <span className="text-white font-bold text-xl">A</span>
                </div>
                <div>
                  <h1 className="text-2xl font-bold text-blue-400">AETHER</h1>
                  <p className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>Autonomous Constellation Manager</p>
                </div>
              </div>
              
              {/* Connection Status */}
              <div className={`ml-6 flex items-center ${backendHealthy ? 'text-green-400' : 'text-red-400'}`}>
                <div className={`w-2 h-2 rounded-full mr-2 ${backendHealthy ? 'bg-green-400 animate-pulse' : 'bg-red-400'}`}></div>
                <span className="text-sm">{backendHealthy ? 'Connected' : 'Offline'}</span>
              </div>
            </div>

            {/* Simulation Controls */}
            <div className="flex items-center space-x-4">
              <div className={`flex items-center space-x-2 ${darkMode ? 'bg-gray-700' : 'bg-gray-200'} rounded-lg p-1`}>
                <button
                  onClick={handleStep}
                  className="px-3 py-1 rounded hover:bg-blue-600 hover:text-white transition"
                  title="Step once"
                >
                  ⏯️ Step
                </button>
                <button
                  onClick={handleStart}
                  className="px-3 py-1 rounded hover:bg-green-600 hover:text-white transition"
                  title="Start simulation"
                >
                  ▶️ Start
                </button>
                <button
                  onClick={handleStop}
                  className="px-3 py-1 rounded hover:bg-red-600 hover:text-white transition"
                  title="Stop simulation"
                >
                  ⏸️ Stop
                </button>
                <button
                  onClick={handleReset}
                  className="px-3 py-1 rounded hover:bg-yellow-600 hover:text-white transition"
                  title="Reset simulation"
                >
                  🔄 Reset
                </button>
              </div>

              {/* Speed Control */}
              <div className="flex items-center space-x-2">
                <span className="text-sm text-gray-400">Speed:</span>
                <select
                  value={simulationSpeed}
                  onChange={(e) => setSimulationSpeed(Number(e.target.value))}
                  className={`${darkMode ? 'bg-gray-700 text-white' : 'bg-white text-gray-900'} rounded px-2 py-1 text-sm`}
                >
                  <option value="1">1x</option>
                  <option value="5">5x</option>
                  <option value="10">10x</option>
                  <option value="60">60x</option>
                  <option value="300">300x</option>
                </select>
              </div>

              {/* Time Display */}
              <div className={`${darkMode ? 'bg-gray-700' : 'bg-gray-200'} px-3 py-1 rounded text-sm font-mono`}>
                <span className="text-gray-400">T+ </span>
                <span className="text-green-400">{Math.floor(status.elapsed_sim_time_s / 3600)}h</span>
                <span className="text-gray-400"> </span>
                <span className="text-blue-400">{Math.floor((status.elapsed_sim_time_s % 3600) / 60)}m</span>
              </div>

              {/* Settings Toggle */}
              <button
                onClick={() => setShowSettings(!showSettings)}
                className={`p-2 rounded ${darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-200'}`}
              >
                ⚙️
              </button>
            </div>
          </div>

          {/* Settings Panel */}
          {showSettings && (
            <div className={`py-4 border-t ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
              <div className="flex items-center space-x-6">
                <label className="flex items-center space-x-2">
                  <span className="text-sm text-gray-400">Dark Mode</span>
                  <input
                    type="checkbox"
                    checked={darkMode}
                    onChange={(e) => setDarkMode(e.target.checked)}
                    className="toggle"
                  />
                </label>
                <label className="flex items-center space-x-2">
                  <span className="text-sm text-gray-400">Auto-refresh</span>
                  <input type="checkbox" checked className="toggle" />
                </label>
                <label className="flex items-center space-x-2">
                  <span className="text-sm text-gray-400">Show Labels</span>
                  <input type="checkbox" checked className="toggle" />
                </label>
              </div>
            </div>
          )}
        </div>
      </header>

      {/* ===== TAB NAVIGATION ===== */}
      <nav className={`${darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'} border-b sticky top-16 z-30`}>
        <div className="container mx-auto px-4">
          <div className="flex space-x-1">
            {[
              { id: 'dashboard', label: 'Dashboard', icon: '📊' },
              { id: 'satellites', label: 'Satellites', icon: '🛰️' },
              { id: 'conjunctions', label: 'Conjunctions', icon: '⚠️' },
              { id: 'maneuvers', label: 'Maneuvers', icon: '🚀' },
              { id: 'groundstations', label: 'Ground Stations', icon: '📡' },
              { id: 'analytics', label: 'Analytics', icon: '📈' }
            ].map(tab => (
              <button
                key={tab.id}
                className={`py-3 px-4 flex items-center space-x-2 border-b-2 transition ${
                  activeTab === tab.id 
                    ? 'border-blue-500 text-blue-400' 
                    : 'border-transparent text-gray-400 hover:text-white'
                }`}
                onClick={() => setActiveTab(tab.id)}
              >
                <span>{tab.icon}</span>
                <span className="text-sm font-medium">{tab.label}</span>
                {tab.id === 'conjunctions' && conjunctions.filter(c => c.severity === 'CRITICAL').length > 0 && (
                  <span className="bg-red-600 text-white text-xs px-2 py-0.5 rounded-full animate-pulse">
                    {conjunctions.filter(c => c.severity === 'CRITICAL').length}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      </nav>

      {/* ===== MAIN CONTENT ===== */}
      <main className="container mx-auto p-4">
        {/* DASHBOARD VIEW */}
        {activeTab === 'dashboard' && (
          <div className="grid grid-cols-12 gap-4">
            {/* 3D View */}
            <div className="col-span-12 lg:col-span-8">
              <div className={`${darkMode ? 'bg-gray-800' : 'bg-white'} rounded-lg p-2 h-[600px] shadow-lg`}>
                <ThreeScene 
                  satellites={snapshot.satellites || []}
                  debris={snapshot.debris_cloud || []}
                  selectedSat={selectedSat}
                  onSatelliteClick={setSelectedSat}
                />
              </div>
            </div>

            {/* Right Panel */}
            <div className="col-span-12 lg:col-span-4 space-y-4">
              {/* Quick Stats */}
              <div className={`${darkMode ? 'bg-gray-800' : 'bg-white'} rounded-lg p-4 shadow-lg`}>
                <h3 className="text-lg font-semibold mb-3 flex items-center">
                  <span className="text-blue-400 mr-2">📊</span> Quick Stats
                </h3>
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-gray-700/30 p-3 rounded">
                    <div className="text-gray-400 text-xs">Satellites</div>
                    <div className="text-2xl font-bold text-blue-400">{snapshot.satellites?.length || 0}</div>
                  </div>
                  <div className="bg-gray-700/30 p-3 rounded">
                    <div className="text-gray-400 text-xs">Debris</div>
                    <div className="text-2xl font-bold text-red-400">{snapshot.debris_cloud?.length || 0}</div>
                  </div>
                  <div className="bg-gray-700/30 p-3 rounded">
                    <div className="text-gray-400 text-xs">Maneuvers</div>
                    <div className="text-2xl font-bold text-green-400">{metrics.maneuvers_executed || 0}</div>
                  </div>
                  <div className="bg-gray-700/30 p-3 rounded">
                    <div className="text-gray-400 text-xs">Fuel Used</div>
                    <div className="text-2xl font-bold text-yellow-400">{metrics.fuel_used_total_kg?.toFixed(1) || 0} kg</div>
                  </div>
                </div>
              </div>

              {/* Active Conjunctions */}
              <div className={`${darkMode ? 'bg-gray-800' : 'bg-white'} rounded-lg p-4 shadow-lg`}>
                <h3 className="text-lg font-semibold mb-3 flex items-center">
                  <span className="text-red-400 mr-2">⚠️</span> Active Conjunctions
                </h3>
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {conjunctions.filter(c => c.severity !== 'SAFE').map((conj, i) => (
                    <div
                      key={i}
                      className={`p-2 rounded text-sm cursor-pointer hover:bg-gray-700 transition ${
                        conj.severity === 'CRITICAL' ? 'bg-red-900/30 border-l-4 border-red-500' :
                        'bg-yellow-900/30 border-l-4 border-yellow-500'
                      }`}
                      onClick={() => setSelectedSat(conj.sat_id)}
                    >
                      <div className="flex justify-between">
                        <span className="font-mono">{conj.sat_id} ⚔️ {conj.deb_id}</span>
                        <span className="text-xs">{conj.tca_offset_s}s</span>
                      </div>
                      <div className="text-xs text-gray-400">
                        Dist: {conj.min_dist_km?.toFixed(3)} km
                      </div>
                    </div>
                  ))}
                  {conjunctions.filter(c => c.severity !== 'SAFE').length === 0 && (
                    <div className="text-gray-500 text-sm text-center py-4">
                      No active conjunctions
                    </div>
                  )}
                </div>
              </div>

              {/* Fuel Status */}
              <div className={`${darkMode ? 'bg-gray-800' : 'bg-white'} rounded-lg p-4 shadow-lg`}>
                <h3 className="text-lg font-semibold mb-3 flex items-center">
                  <span className="text-yellow-400 mr-2">⛽</span> Fuel Status
                </h3>
                <div className="space-y-2">
                  {snapshot.satellites?.slice(0, 5).map(sat => {
                    const fuelPercent = (sat.fuel_kg / 50) * 100;
                    return (
                      <div key={sat.id} className="flex items-center">
                        <span className="text-xs w-16 truncate">{sat.id}</span>
                        <div className="flex-1 h-2 bg-gray-700 rounded mx-2">
                          <div
                            className={`h-2 rounded ${
                              fuelPercent > 60 ? 'bg-green-500' :
                              fuelPercent > 30 ? 'bg-yellow-500' :
                              'bg-red-500'
                            }`}
                            style={{ width: `${Math.min(fuelPercent, 100)}%` }}
                          ></div>
                        </div>
                        <span className="text-xs w-12 text-right">{sat.fuel_kg}kg</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Ground Track Map */}
            <div className="col-span-12">
              <div className={`${darkMode ? 'bg-gray-800' : 'bg-white'} rounded-lg p-4 h-80 shadow-lg`}>
                <GroundTrackMap
                  satellites={snapshot.satellites || []}
                  selectedSat={selectedSat}
                  timestamp={snapshot.timestamp}
                />
              </div>
            </div>
          </div>
        )}

        {/* SATELLITES VIEW */}
        {activeTab === 'satellites' && (
          <div className="grid grid-cols-12 gap-4">
            {/* Bullseye Plot */}
            <div className="col-span-6">
              <div className={`${darkMode ? 'bg-gray-800' : 'bg-white'} rounded-lg p-4 h-[500px] shadow-lg`}>
                <h3 className="text-lg font-semibold mb-3 text-blue-400">🎯 Conjunction Bullseye - {selectedSat}</h3>
                <BullseyePlot
                  satelliteId={selectedSat}
                  conjunctions={conjunctions}
                />
              </div>
            </div>

            {/* Telemetry Heatmap */}
            <div className="col-span-6">
              <div className={`${darkMode ? 'bg-gray-800' : 'bg-white'} rounded-lg p-4 h-[500px] shadow-lg overflow-y-auto`}>
                <h3 className="text-lg font-semibold mb-3 text-green-400">🔥 Telemetry Heatmap</h3>
                <TelemetryHeatmap
                  satellites={snapshot.satellites || []}
                  metrics={metrics}
                />
              </div>
            </div>

            {/* Maneuver Timeline */}
            <div className="col-span-12">
              <div className={`${darkMode ? 'bg-gray-800' : 'bg-white'} rounded-lg p-4 h-64 shadow-lg`}>
                <h3 className="text-lg font-semibold mb-3 text-yellow-400">📅 Maneuver Timeline</h3>
                <ManeuverTimeline
                  satelliteId={selectedSat}
                  onBurnClick={(burn) => addNotification('info', 'Burn Selected', burn.burn_id)}
                />
              </div>
            </div>
          </div>
        )}

        {/* CONJUNCTIONS VIEW */}
        {activeTab === 'conjunctions' && (
          <div className="grid grid-cols-1 gap-4">
            <div className={`${darkMode ? 'bg-gray-800' : 'bg-white'} rounded-lg p-4 shadow-lg`}>
              <h3 className="text-xl font-bold mb-4 text-red-400">⚠️ Conjunction Summary</h3>
              <div className="grid grid-cols-3 gap-4 mb-6">
                <div className="bg-red-900/30 p-4 rounded text-center">
                  <div className="text-3xl font-bold text-red-400">
                    {conjunctions.filter(c => c.severity === 'CRITICAL').length}
                  </div>
                  <div className="text-gray-400 text-sm">Critical</div>
                </div>
                <div className="bg-yellow-900/30 p-4 rounded text-center">
                  <div className="text-3xl font-bold text-yellow-400">
                    {conjunctions.filter(c => c.severity === 'WARNING').length}
                  </div>
                  <div className="text-gray-400 text-sm">Warning</div>
                </div>
                <div className="bg-green-900/30 p-4 rounded text-center">
                  <div className="text-3xl font-bold text-green-400">
                    {conjunctions.filter(c => c.severity === 'SAFE').length}
                  </div>
                  <div className="text-gray-400 text-sm">Safe</div>
                </div>
              </div>
              
              <table className="w-full">
                <thead className="text-gray-400 text-sm border-b border-gray-700">
                  <tr>
                    <th className="text-left py-2">Satellite</th>
                    <th className="text-left py-2">Debris</th>
                    <th className="text-left py-2">TCA</th>
                    <th className="text-left py-2">Distance</th>
                    <th className="text-left py-2">Severity</th>
                    <th className="text-left py-2">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {conjunctions.map((conj, i) => (
                    <tr key={i} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                      <td className="py-2 font-mono">{conj.sat_id}</td>
                      <td className="py-2 font-mono">{conj.deb_id}</td>
                      <td className="py-2">{conj.tca_offset_s}s</td>
                      <td className="py-2">{conj.min_dist_km?.toFixed(3)} km</td>
                      <td className="py-2">
                        <span className={`px-2 py-1 rounded text-xs ${
                          conj.severity === 'CRITICAL' ? 'bg-red-600' :
                          conj.severity === 'WARNING' ? 'bg-yellow-600' : 'bg-green-600'
                        }`}>
                          {conj.severity}
                        </span>
                      </td>
                      <td className="py-2">
                        <button
                          onClick={() => setSelectedSat(conj.sat_id)}
                          className="text-blue-400 hover:text-blue-300 text-sm"
                        >
                          View
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* MANEUVERS VIEW */}
        {activeTab === 'maneuvers' && (
          <div className="grid grid-cols-1 gap-4">
            <div className={`${darkMode ? 'bg-gray-800' : 'bg-white'} rounded-lg p-4 shadow-lg`}>
              <h3 className="text-xl font-bold mb-4 text-yellow-400">🚀 Maneuver History</h3>
              <div className="grid grid-cols-4 gap-4 mb-6">
                <div className="bg-blue-900/30 p-4 rounded">
                  <div className="text-3xl font-bold text-blue-400">{metrics.maneuvers_executed || 0}</div>
                  <div className="text-gray-400 text-sm">Total Maneuvers</div>
                </div>
                <div className="bg-green-900/30 p-4 rounded">
                  <div className="text-3xl font-bold text-green-400">{metrics.collisions_avoided || 0}</div>
                  <div className="text-gray-400 text-sm">Collisions Avoided</div>
                </div>
                <div className="bg-yellow-900/30 p-4 rounded">
                  <div className="text-3xl font-bold text-yellow-400">{metrics.fuel_used_total_kg?.toFixed(1) || 0}</div>
                  <div className="text-gray-400 text-sm">Fuel Used (kg)</div>
                </div>
                <div className="bg-purple-900/30 p-4 rounded">
                  <div className="text-3xl font-bold text-purple-400">
                    {((metrics.collisions_avoided || 0) / (metrics.maneuvers_executed || 1) * 100).toFixed(1)}%
                  </div>
                  <div className="text-gray-400 text-sm">Success Rate</div>
                </div>
              </div>
              
              <ManeuverTimeline
                satelliteId={selectedSat}
                onBurnClick={(burn) => addNotification('info', 'Burn Selected', JSON.stringify(burn))}
              />
            </div>
          </div>
        )}

        {/* GROUND STATIONS VIEW */}
        {activeTab === 'groundstations' && (
          <div className="grid grid-cols-1 gap-4">
            <div className={`${darkMode ? 'bg-gray-800' : 'bg-white'} rounded-lg p-4 shadow-lg`}>
              <h3 className="text-xl font-bold mb-4 text-blue-400">📡 Ground Station Network</h3>
              <div className="grid grid-cols-3 gap-4">
                {[
                  { name: 'ISTRAC Bengaluru', lat: 13.0333, lon: 77.5167, alt: 820, minEl: 5, status: 'ACTIVE' },
                  { name: 'Svalbard Sat Station', lat: 78.2297, lon: 15.4077, alt: 400, minEl: 5, status: 'ACTIVE' },
                  { name: 'Goldstone Tracking', lat: 35.4266, lon: -116.8900, alt: 1000, minEl: 10, status: 'ACTIVE' },
                  { name: 'Punta Arenas', lat: -53.1500, lon: -70.9167, alt: 30, minEl: 5, status: 'ACTIVE' },
                  { name: 'IIT Delhi Ground Node', lat: 28.5450, lon: 77.1926, alt: 225, minEl: 15, status: 'ACTIVE' },
                  { name: 'McMurdo Station', lat: -77.8463, lon: 166.6682, alt: 10, minEl: 5, status: 'ACTIVE' }
                ].map((station, i) => (
                  <div key={i} className="bg-gray-700/30 p-4 rounded">
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="font-bold text-blue-400">{station.name}</h4>
                      <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></span>
                    </div>
                    <div className="space-y-1 text-sm">
                      <p className="text-gray-400">Lat: <span className="text-white">{station.lat}°</span></p>
                      <p className="text-gray-400">Lon: <span className="text-white">{station.lon}°</span></p>
                      <p className="text-gray-400">Alt: <span className="text-white">{station.alt}m</span></p>
                      <p className="text-gray-400">Min El: <span className="text-white">{station.minEl}°</span></p>
                    </div>
                    <div className="mt-3 pt-2 border-t border-gray-600">
                      <div className="flex justify-between text-xs">
                        <span className="text-gray-400">Next Pass:</span>
                        <span className="text-green-400">{Math.floor(Math.random() * 60)} min</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ANALYTICS VIEW */}
        {activeTab === 'analytics' && (
          <div className="grid grid-cols-1 gap-4">
            <div className={`${darkMode ? 'bg-gray-800' : 'bg-white'} rounded-lg p-4 shadow-lg`}>
              <h3 className="text-xl font-bold mb-4 text-purple-400">📈 System Analytics</h3>
              <TelemetryHeatmap
                satellites={snapshot.satellites || []}
                metrics={metrics}
              />
            </div>
          </div>
        )}
      </main>

      {/* ===== STATUS BAR ===== */}
      <footer className={`${darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'} border-t fixed bottom-0 w-full z-40`}>
        <div className="container mx-auto px-4">
          <div className="flex justify-between items-center h-8 text-xs">
            <div className="flex space-x-4">
              <span className="text-gray-400">© 2026 AETHER - National Space Hackathon IIT Delhi</span>
              <span className="text-gray-600">|</span>
              <span className="text-gray-400">Version 1.0.0</span>
            </div>
            <div className="flex space-x-4">
              <span className="text-gray-400">Uptime: <span className="text-green-400">99.8%</span></span>
              <span className="text-gray-400">Last Update: <span className="text-blue-400">{new Date().toLocaleTimeString()}</span></span>
            </div>
          </div>
        </div>
      </footer>

      {/* Padding for fixed footer */}
      <div className="h-8"></div>
    </div>
  );
}

export default App;