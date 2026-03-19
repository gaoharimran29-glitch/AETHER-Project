// src/api/aetherApi.js — AETHER API layer
// National Space Hackathon 2026, IIT Delhi
import axios from 'axios';

// IMPORTANT: Use empty string base URL so CRA proxy (package.json "proxy")
// forwards all /api/* requests to http://localhost:8000.
// This avoids CORS errors entirely in development.
// In production Docker: set REACT_APP_API_URL=http://localhost:8000
const API_BASE = process.env.REACT_APP_API_URL || '';

const api = axios.create({
  baseURL: API_BASE,
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.response.use(r => r, err => {
  if (err.code === 'ECONNABORTED') throw new Error('Request timeout — backend not responding');
  if (!err.response) throw new Error('Network error — is the backend running on port 8000?');
  throw err.response?.data || err;
});

// ── PS §4.1 Telemetry ─────────────────────────────────────────────────────
export const ingestTelemetry = async (data) =>
  (await api.post('/api/telemetry', data)).data;

export const createTestTelemetry = (numSats = 6, numDebris = 20) => {
  const objects = [];
  // Generate satellites in a rough constellation spread
  for (let i = 0; i < numSats; i++) {
    const angle = (i / numSats) * Math.PI * 2;
    const incl  = (i % 3 === 0 ? 0.3 : i % 3 === 1 ? 0.8 : -0.5);
    const r     = 6778 + (i * 50);
    objects.push({
      id:   `SAT-A0${i + 1}`,
      type: 'SATELLITE',
      r: {
        x: r * Math.cos(angle),
        y: r * Math.sin(angle) * Math.cos(incl),
        z: r * Math.sin(angle) * Math.sin(incl),
      },
      v: { x: -7.67 * Math.sin(angle), y: 7.67 * Math.cos(angle), z: 0 },
      fuel: 50 - i * 2,
    });
  }
  // Generate debris in random LEO orbits
  for (let i = 0; i < numDebris; i++) {
    const angle = Math.random() * Math.PI * 2;
    const r     = 6600 + Math.random() * 800;
    const incl  = (Math.random() - 0.5) * 1.5;
    objects.push({
      id:   `DEB-${String(i + 1).padStart(3, '0')}`,
      type: 'DEBRIS',
      r: {
        x: r * Math.cos(angle),
        y: r * Math.sin(angle) * Math.cos(incl),
        z: r * Math.sin(angle) * Math.sin(incl),
      },
      v: {
        x: -(7.5 + Math.random() * 0.3) * Math.sin(angle),
        y:  (7.5 + Math.random() * 0.3) * Math.cos(angle),
        z: (Math.random() - 0.5) * 0.5,
      },
    });
  }
  return { timestamp: new Date().toISOString(), objects };
};

// ── PS §4.2 Maneuver ──────────────────────────────────────────────────────
export const scheduleManeuver = async (satelliteId, maneuver_sequence) =>
  (await api.post('/api/maneuver/schedule', { satelliteId, maneuver_sequence })).data;

export const executeManualManeuver = async (sat_id, dv_rtn) =>
  (await api.post('/api/maneuver', { sat_id, dv_rtn })).data;

export const createBurnCommand = (burn_id, burnTime, deltaV_vector) =>
  ({ burn_id, burnTime, deltaV_vector });

// ── PS §4.3 Simulation ────────────────────────────────────────────────────
export const simulateStep = async (stepSeconds = 1.0) =>
  (await api.post('/api/simulate/step', { step_seconds: stepSeconds })).data;

// dt is a FastAPI query param — must use params:{dt}, NOT body
export const startSimulation = async (dt = 5.0) =>
  (await api.post('/api/simulate/start', null, { params: { dt } })).data;

export const stopSimulation = async () =>
  (await api.post('/api/simulate/stop')).data;

// ── PS §6.3 Snapshot ─────────────────────────────────────────────────────
// Returns null on error — callers must null-check before using
export const fetchSnapshot = async () => {
  try {
    return (await api.get('/api/visualization/snapshot')).data;
  } catch (e) {
    console.error('fetchSnapshot failed:', e.message);
    return null;
  }
};

// ── Status & metrics ──────────────────────────────────────────────────────
export const fetchStatus = async () => {
  try { return (await api.get('/api/status')).data; }
  catch { return { simulation_running: false, satellites: 0, debris_objects: 0, alerts: {}, elapsed_sim_time_s: 0 }; }
};

export const fetchMetrics = async () => {
  try { return (await api.get('/api/system/metrics')).data; }
  catch { return { maneuvers_executed: 0, collisions_avoided: 0, fuel_used_total_kg: 0, satellite_uptime_pct: {} }; }
};

export const fetchAllObjects = async () => {
  try { return (await api.get('/api/objects')).data; }
  catch { return []; }
};

// ── Conjunction & safety (PS §2) ──────────────────────────────────────────
export const fetchConjunctionForecast = async () => {
  try { return (await api.get('/api/conjunction/forecast')).data; }
  catch { return { forecast: [], total_events: 0, lookahead_hours: 24 }; }
};

export const fetchAlertHistory = async () => {
  try { return (await api.get('/api/alerts/history')).data; }
  catch { return []; }
};

// ── Satellite-specific (PS §5.4) ──────────────────────────────────────────
export const fetchNextPass = async (satId) => {
  try { return (await api.get(`/api/satellite/${satId}/next_pass`)).data; }
  catch { return { sat_id: satId, upcoming_passes: [] }; }
};

// ── Queue & reset ─────────────────────────────────────────────────────────
export const fetchBurnQueue = async () => {
  try { return (await api.get('/api/scheduler/queue')).data; }
  catch { return []; }
};

export const resetSimulation = async () =>
  (await api.post('/api/reset')).data;

// ── Health check ──────────────────────────────────────────────────────────
export const checkBackendHealth = async () => {
  try {
    const r = await api.get('/api/status', { timeout: 4000 });
    return { healthy: true, data: r.data };
  } catch (e) {
    return { healthy: false, error: e.message };
  }
};

// ── Utilities ─────────────────────────────────────────────────────────────
export const eciToLatLon = (x, y, z) => {
  const r = Math.sqrt(x * x + y * y + z * z);
  return {
    lat: Math.asin(z / r) * 180 / Math.PI,
    lon: Math.atan2(y, x) * 180 / Math.PI,
    alt: r - 6378.137,
  };
};

export const uploadTestData = (numSats, numDebris) =>
  ingestTelemetry(createTestTelemetry(numSats, numDebris));

// NOTE: AetherWebSocket intentionally removed.
// Backend has no /ws endpoint. Use fetchSnapshot() polling at 1-2s intervals.

export default {
  ingestTelemetry, createTestTelemetry,
  scheduleManeuver, executeManualManeuver, createBurnCommand,
  simulateStep, startSimulation, stopSimulation,
  fetchSnapshot, fetchStatus, fetchMetrics, fetchAllObjects,
  fetchConjunctionForecast, fetchAlertHistory,
  fetchNextPass, fetchBurnQueue, resetSimulation,
  checkBackendHealth, eciToLatLon, uploadTestData,
};