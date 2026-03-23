/**
 * aetherApi.js — AETHER Mission Control API Client
 * National Space Hackathon 2026, IIT Delhi
 *
 * FIX 1 — Docker-compatible base URL:
 *   In Docker Compose the React dev server runs in one container and the
 *   backend in another.  "localhost:8000" from inside the browser still
 *   resolves correctly IF the browser is the host machine (not a container),
 *   BUT only when port 8000 is published.  We expose the backend via Nginx
 *   reverse-proxy on the same origin as the frontend (port 80), so the
 *   browser never has to know about port 8000.
 *
 *   Resolution strategy (in priority order):
 *     1. REACT_APP_API_URL env-var (set in docker-compose or .env)
 *     2. Same-origin empty string "" (works behind Nginx proxy)
 *     3. Falls back to explicit localhost:8000 for bare `npm start` dev mode
 *
 * FIX 2 — Health-check timeout:
 *   The original checkBackendHealth() had no timeout, so if the backend was
 *   slow (e.g. during a heavy simulate/step), the fetch would hang for 30 s+
 *   and the UI would show "OFFLINE" even though the backend was fine.
 *   All health/status calls now use a strict 4-second AbortController timeout.
 */

// ── Base URL resolution ────────────────────────────────────────────────────────
const _env = (typeof process !== 'undefined' && process.env?.REACT_APP_API_URL) || '';

// If running behind the Nginx proxy (Docker) or same-origin in production,
// REACT_APP_API_URL will be "" or "/api" and we use relative URLs.
// For bare `npm start` (dev, no proxy), fall back to localhost:8000.
function resolveBase() {
  if (_env) return _env.replace(/\/$/, '');            // explicit env override
  // Detect bare dev mode: page is served on :3000 or :5173 (Vite)
  if (typeof window !== 'undefined') {
    const port = window.location.port;
    if (port === '3000' || port === '5173') {
      return 'http://localhost:8000';                  // bare npm start / Vite dev
    }
  }
  return '';                                           // same-origin (Docker / production)
}

export const BASE_URL = resolveBase();

// ── Fetch helpers ──────────────────────────────────────────────────────────────

/**
 * GET with optional AbortController timeout.
 * Returns parsed JSON or null on any error.
 */
async function apiFetch(path, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}${path}`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/**
 * POST with JSON body and optional AbortController timeout.
 * Returns parsed JSON or throws on non-2xx.
 */
async function apiPost(path, body = {}, timeoutMs = 180_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`${res.status} ${text}`);
    }
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ── Health check (FIX 2: 4-second hard timeout) ───────────────────────────────
export async function checkBackendHealth() {
  const data = await apiFetch('/api/status', 4_000);   // 4 s timeout
  return { healthy: data !== null, data };
}

// ── Standard API calls ────────────────────────────────────────────────────────
export async function fetchStatus() {
  return (await apiFetch('/api/status', 4_000)) ?? {
    simulation_running: false, satellites: 0, debris_objects: 0,
    elapsed_sim_time_s: 0,
  };
}

export async function fetchSnapshot() {
  return apiFetch('/api/visualization/snapshot', 8_000);
}

export async function fetchMetrics() {
  return (await apiFetch('/api/system/metrics', 5_000)) ?? {
    maneuvers_executed: 0, collisions_avoided: 0,
    fuel_used_total_kg: 0, satellite_uptime_pct: {},
  };
}

export async function fetchConjunctionForecast() {
  return (await apiFetch('/api/conjunction/forecast', 10_000)) ?? { forecast: [] };
}

export async function fetchAlertHistory() {
  return (await apiFetch('/api/alerts/history', 5_000)) ?? [];
}

export async function fetchBurnQueue() {
  return (await apiFetch('/api/scheduler/queue', 5_000)) ?? [];
}

export async function fetchObjects() {
  return (await apiFetch('/api/objects', 10_000)) ?? [];
}

// ── Simulation controls ────────────────────────────────────────────────────────
export async function simulateStep(stepSeconds = 60) {
  // Long timeout — a 3600s step over 10k debris can take ~10 s
  return apiPost('/api/simulate/step', { step_seconds: stepSeconds }, 300_000);
}

export async function startSimulation(dt = 60) {
  return apiPost('/api/simulate/start', {}, 10_000).catch(() =>
    // Fallback: some backends accept dt as query param
    apiPost(`/api/simulate/start?dt=${dt}`, {}, 10_000)
  );
}

export async function stopSimulation() {
  return apiPost('/api/simulate/stop', {}, 10_000);
}

export async function resetSimulation() {
  return apiPost('/api/reset', {}, 15_000);
}

// ── Maneuver API ───────────────────────────────────────────────────────────────
export async function scheduleManeuver(satelliteId, maneuverSequence) {
  return apiPost('/api/maneuver/schedule', { satelliteId, maneuver_sequence: maneuverSequence });
}

export async function applyManualManeuver(satId, dvRtn) {
  return apiPost('/api/maneuver', { sat_id: satId, dv_rtn: dvRtn });
}

// ── Telemetry ingest ───────────────────────────────────────────────────────────
export async function ingestTelemetry(timestamp, objects) {
  return apiPost('/api/telemetry', { timestamp, objects }, 120_000);
}

// ── Satellite-level queries ───────────────────────────────────────────────────
export async function fetchNextPass(satId) {
  return apiFetch(`/api/satellite/${encodeURIComponent(satId)}/next_pass`, 8_000);
}