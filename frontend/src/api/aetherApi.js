// src/api/aetherApi.js — AETHER API layer
import axios from 'axios';

const API_BASE = process.env.REACT_APP_API_URL || '';

const api = axios.create({
  baseURL: API_BASE,
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.response.use(
  r => r,
  err => {
    if (err.code === 'ECONNABORTED') throw new Error('Request timeout');
    if (!err.response) throw new Error('Network error — is the backend running on port 8000?');
    throw err.response?.data || err;
  }
);

// PS §4.1
export const ingestTelemetry = async (data) =>
  (await api.post('/api/telemetry', data)).data;

// PS §4.2
export const scheduleManeuver = async (satelliteId, maneuver_sequence) =>
  (await api.post('/api/maneuver/schedule', { satelliteId, maneuver_sequence })).data;

export const executeManualManeuver = async (sat_id, dv_rtn) =>
  (await api.post('/api/maneuver', { sat_id, dv_rtn })).data;

// PS §4.3
export const simulateStep = async (stepSeconds = 1.0) =>
  (await api.post('/api/simulate/step', { step_seconds: stepSeconds })).data;

export const startSimulation = async (dt = 5.0) =>
  (await api.post('/api/simulate/start', null, { params: { dt } })).data;

export const stopSimulation = async () =>
  (await api.post('/api/simulate/stop')).data;

// PS §6.3
export const fetchSnapshot = async () => {
  try { return (await api.get('/api/visualization/snapshot')).data; }
  catch { return null; }
};

export const fetchStatus = async () => {
  try { return (await api.get('/api/status')).data; }
  catch { return { simulation_running:false, satellites:0, debris_objects:0, alerts:{}, elapsed_sim_time_s:0 }; }
};

export const fetchMetrics = async () => {
  try { return (await api.get('/api/system/metrics')).data; }
  catch { return { maneuvers_executed:0, collisions_avoided:0, fuel_used_total_kg:0, satellite_uptime_pct:{}, elapsed_sim_time_s:0 }; }
};

export const fetchAllObjects = async () => {
  try { return (await api.get('/api/objects')).data; }
  catch { return []; }
};

export const fetchConjunctionForecast = async () => {
  try { return (await api.get('/api/conjunction/forecast')).data; }
  catch { return { forecast:[], total_events:0, lookahead_hours:24 }; }
};

export const fetchAlertHistory = async () => {
  try { return (await api.get('/api/alerts/history')).data; }
  catch { return []; }
};

export const fetchNextPass = async (satId) => {
  try { return (await api.get(`/api/satellite/${satId}/next_pass`)).data; }
  catch { return { sat_id:satId, upcoming_passes:[] }; }
};

export const fetchBurnQueue = async () => {
  try { return (await api.get('/api/scheduler/queue')).data; }
  catch { return []; }
};

export const resetSimulation = async () =>
  (await api.post('/api/reset')).data;

export const checkBackendHealth = async () => {
  try {
    const r = await api.get('/api/status', { timeout:5000 });
    return { healthy:true, data:r.data };
  } catch (e) {
    return { healthy:false, error:e.message };
  }
};

export default {
  ingestTelemetry, scheduleManeuver, executeManualManeuver,
  simulateStep, startSimulation, stopSimulation,
  fetchSnapshot, fetchStatus, fetchMetrics, fetchAllObjects,
  fetchConjunctionForecast, fetchAlertHistory,
  fetchNextPass, fetchBurnQueue, resetSimulation, checkBackendHealth,
};