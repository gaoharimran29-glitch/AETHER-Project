// aetherApi.js - Complete API integration for AETHER Frontend
import axios from 'axios';

// Base URL configuration - change this to your backend URL
const API_BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:8000';
const WS_BASE_URL = process.env.REACT_APP_WS_URL || 'ws://localhost:8000';

// Create axios instance with default config
const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor for logging
api.interceptors.request.use(request => {
  console.log('🌐 API Request:', request.method.toUpperCase(), request.url);
  return request;
});

// Response interceptor for error handling
api.interceptors.response.use(
  response => {
    console.log('✅ API Response:', response.status, response.config.url);
    return response;
  },
  error => {
    console.error('❌ API Error:', error.response?.status || error.message, error.config?.url);
    
    // Enhanced error handling
    if (error.code === 'ECONNABORTED') {
      throw new Error('Request timeout - Backend not responding');
    }
    if (!error.response) {
      throw new Error('Network error - Is the backend server running?');
    }
    
    // Throw the error response data if available
    throw error.response?.data || error;
  }
);

// ============================================================================
// SECTION 4.1: TELEMETRY INGESTION
// ============================================================================

/**
 * POST /api/telemetry
 * Ingest satellite and debris telemetry data
 * 
 * @param {Object} telemetryData - Format: { timestamp: string, objects: Array }
 * @returns {Promise<Object>} { status, processed_count, active_cdm_warnings }
 */
export const ingestTelemetry = async (telemetryData) => {
  try {
    const response = await api.post('/api/telemetry', telemetryData);
    return response.data;
  } catch (error) {
    console.error('Telemetry ingestion failed:', error);
    throw error;
  }
};

// Helper function to create telemetry for testing
export const createTestTelemetry = () => ({
  timestamp: new Date().toISOString(),
  objects: [
    {
      id: "SAT-A01",
      type: "SATELLITE",
      r: { x: 6778.0, y: 0.0, z: 0.0 },
      v: { x: 0.0, y: 7.67, z: 0.0 },
      fuel: 50.0
    },
    {
      id: "SAT-A02",
      type: "SATELLITE",
      r: { x: 6778.0, y: 500.0, z: 0.0 },
      v: { x: 0.0, y: 7.67, z: 0.0 },
      fuel: 50.0
    },
    {
      id: "DEB-001",
      type: "DEBRIS",
      r: { x: 6800.0, y: 100.0, z: 0.0 },
      v: { x: 0.0, y: 7.60, z: 0.0 }
    }
  ]
});

// ============================================================================
// SECTION 4.2: MANEUVER SCHEDULING
// ============================================================================

/**
 * POST /api/maneuver/schedule
 * Schedule one or more burns for a satellite
 * 
 * @param {string} satelliteId - Satellite identifier
 * @param {Array} maneuverSequence - Array of burn commands
 * @returns {Promise<Object>} { status, validation }
 */
export const scheduleManeuver = async (satelliteId, maneuverSequence) => {
  try {
    const response = await api.post('/api/maneuver/schedule', {
      satelliteId,
      maneuver_sequence: maneuverSequence
    });
    return response.data;
  } catch (error) {
    console.error('Maneuver scheduling failed:', error);
    throw error;
  }
};

/**
 * POST /api/maneuver (immediate/legacy)
 * Execute a manual maneuver immediately (if LOS and constraints allow)
 * 
 * @param {string} sat_id - Satellite ID
 * @param {Array} dv_rtn - Delta-V in RTN frame [radial, tangential, normal]
 * @returns {Promise<Object>} { status, fuel_remaining_kg }
 */
export const executeManualManeuver = async (sat_id, dv_rtn) => {
  try {
    const response = await api.post('/api/maneuver', {
      sat_id,
      dv_rtn
    });
    return response.data;
  } catch (error) {
    console.error('Manual maneuver failed:', error);
    throw error;
  }
};

// Helper to create a burn command
export const createBurnCommand = (burnId, burnTimeISO, deltaVVector) => ({
  burn_id: burnId,
  burnTime: burnTimeISO,
  deltaV_vector: deltaVVector
});

// ============================================================================
// SECTION 4.3: SIMULATION CONTROL
// ============================================================================

/**
 * POST /api/simulate/step
 * Advance simulation by specified seconds
 * 
 * @param {number} stepSeconds - Time step in seconds
 * @returns {Promise<Object>} { status, new_timestamp, collisions_detected, maneuvers_executed }
 */
export const simulateStep = async (stepSeconds = 1.0) => {
  try {
    const response = await api.post('/api/simulate/step', {
      step_seconds: stepSeconds
    });
    return response.data;
  } catch (error) {
    console.error('Simulation step failed:', error);
    throw error;
  }
};

/**
 * POST /api/simulate/start
 * Start continuous simulation with given time step
 * 
 * @param {number} dt - Time step in seconds (default: 5.0)
 * @returns {Promise<Object>} { status, dt }
 */
export const startSimulation = async (dt = 5.0) => {
  try {
    const response = await api.post(`/api/simulate/start?dt=${dt}`);
    return response.data;
  } catch (error) {
    console.error('Failed to start simulation:', error);
    throw error;
  }
};

/**
 * POST /api/simulate/stop
 * Stop continuous simulation
 */
export const stopSimulation = async () => {
  try {
    const response = await api.post('/api/simulate/stop');
    return response.data;
  } catch (error) {
    console.error('Failed to stop simulation:', error);
    throw error;
  }
};

// ============================================================================
// SECTION 6.3: VISUALIZATION SNAPSHOT (CRITICAL FOR FRONTEND)
// ============================================================================

/**
 * GET /api/visualization/snapshot
 * Optimized snapshot for frontend rendering
 * 
 * @returns {Promise<Object>} {
 *   timestamp: string,
 *   satellites: Array[{ id, lat, lon, fuel_kg, status }],
 *   debris_cloud: Array[[id, lat, lon, alt]]
 * }
 */
export const fetchSnapshot = async () => {
  try {
    const response = await api.get('/api/visualization/snapshot');
    return response.data;
  } catch (error) {
    console.error('Failed to fetch snapshot:', error);
    // Return empty structure on error to prevent UI crashes
    return {
      timestamp: new Date().toISOString(),
      satellites: [],
      debris_cloud: []
    };
  }
};

// ============================================================================
// SYSTEM STATUS & METRICS
// ============================================================================

/**
 * GET /api/status
 * Get current system status
 */
export const fetchStatus = async () => {
  try {
    const response = await api.get('/api/status');
    return response.data;
  } catch (error) {
    console.error('Failed to fetch status:', error);
    return {
      simulation_running: false,
      satellites: 0,
      debris_objects: 0,
      alerts: {},
      elapsed_sim_time_s: 0
    };
  }
};

/**
 * GET /api/system/metrics
 * Get system performance metrics (PS §7)
 */
export const fetchMetrics = async () => {
  try {
    const response = await api.get('/api/system/metrics');
    return response.data;
  } catch (error) {
    console.error('Failed to fetch metrics:', error);
    return {
      maneuvers_executed: 0,
      collisions_avoided: 0,
      fuel_used_total_kg: 0,
      satellite_uptime_pct: {}
    };
  }
};

/**
 * GET /api/objects
 * Get all space objects (satellites and debris)
 */
export const fetchAllObjects = async () => {
  try {
    const response = await api.get('/api/objects');
    return response.data;
  } catch (error) {
    console.error('Failed to fetch objects:', error);
    return [];
  }
};

// ============================================================================
// CONJUNCTION & SAFETY
// ============================================================================

/**
 * GET /api/conjunction/forecast
 * Get 24-hour conjunction forecast (PS §2)
 */
export const fetchConjunctionForecast = async () => {
  try {
    const response = await api.get('/api/conjunction/forecast');
    return response.data;
  } catch (error) {
    console.error('Failed to fetch conjunction forecast:', error);
    return { forecast: [], total_events: 0 };
  }
};

/**
 * GET /api/alerts/history
 * Get CDM alert history
 */
export const fetchAlertHistory = async () => {
  try {
    const response = await api.get('/api/alerts/history');
    return response.data;
  } catch (error) {
    console.error('Failed to fetch alerts:', error);
    return [];
  }
};

// ============================================================================
// SATELLITE-SPECIFIC ENDPOINTS
// ============================================================================

/**
 * GET /api/satellite/{sat_id}/next_pass
 * Get next pass predictions for a satellite (PS §5.4)
 * 
 * @param {string} satId - Satellite ID
 * @returns {Promise<Object>} { sat_id, upcoming_passes: [{ station, estimated_wait_seconds }] }
 */
export const fetchNextPass = async (satId) => {
  try {
    const response = await api.get(`/api/satellite/${satId}/next_pass`);
    return response.data;
  } catch (error) {
    console.error(`Failed to fetch next pass for ${satId}:`, error);
    return { sat_id: satId, upcoming_passes: [] };
  }
};

// ============================================================================
// SCHEDULER & QUEUE MANAGEMENT
// ============================================================================

/**
 * GET /api/scheduler/queue
 * Get current burn queue
 */
export const fetchBurnQueue = async () => {
  try {
    const response = await api.get('/api/scheduler/queue');
    return response.data;
  } catch (error) {
    console.error('Failed to fetch burn queue:', error);
    return [];
  }
};

// ============================================================================
// SYSTEM RESET
// ============================================================================

/**
 * POST /api/reset
 * Reset simulation to initial state
 */
export const resetSimulation = async () => {
  try {
    const response = await api.post('/api/reset');
    return response.data;
  } catch (error) {
    console.error('Failed to reset simulation:', error);
    throw error;
  }
};

// ============================================================================
// WEBSOCKET CONNECTION FOR REAL-TIME UPDATES
// ============================================================================

/**
 * WebSocket connection manager
 */
export class AetherWebSocket {
  constructor(onMessage, onError, onClose) {
    this.ws = null;
    this.onMessage = onMessage;
    this.onError = onError;
    this.onClose = onClose;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
  }

  connect() {
    try {
      this.ws = new WebSocket(`${WS_BASE_URL}/ws`);
      
      this.ws.onopen = () => {
        console.log('🔌 WebSocket connected');
        this.reconnectAttempts = 0;
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (this.onMessage) this.onMessage(data);
        } catch (e) {
          console.error('WebSocket parse error:', e);
        }
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        if (this.onError) this.onError(error);
      };

      this.ws.onclose = () => {
        console.log('🔌 WebSocket disconnected');
        if (this.onClose) this.onClose();
        
        // Attempt reconnection
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
          setTimeout(() => this.connect(), 2000 * this.reconnectAttempts);
        }
      };
    } catch (error) {
      console.error('WebSocket connection failed:', error);
    }
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    } else {
      console.warn('WebSocket not connected');
    }
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Check if backend is healthy
 */
export const checkBackendHealth = async () => {
  try {
    const response = await api.get('/api/status', { timeout: 3000 });
    return { healthy: true, data: response.data };
  } catch (error) {
    return { healthy: false, error: error.message };
  }
};

/**
 * Bulk upload test data (for development)
 */
export const uploadTestData = async () => {
  const testData = createTestTelemetry();
  return await ingestTelemetry(testData);
};

/**
 * Format ECI coordinates to lat/lon (for debugging)
 */
export const eciToLatLon = (x, y, z) => {
  const r = Math.sqrt(x*x + y*y + z*z);
  const lat = Math.asin(z / r) * 180 / Math.PI;
  const lon = Math.atan2(y, x) * 180 / Math.PI;
  return { lat, lon, alt: r - 6378.137 };
};

// Export all functions as a single object for convenience
const AetherAPI = {
  // Telemetry
  ingestTelemetry,
  createTestTelemetry,
  
  // Maneuvers
  scheduleManeuver,
  executeManualManeuver,
  createBurnCommand,
  
  // Simulation
  simulateStep,
  startSimulation,
  stopSimulation,
  
  // Visualization
  fetchSnapshot,
  
  // Status & Metrics
  fetchStatus,
  fetchMetrics,
  fetchAllObjects,
  
  // Safety
  fetchConjunctionForecast,
  fetchAlertHistory,
  
  // Satellite
  fetchNextPass,
  
  // Queue
  fetchBurnQueue,
  
  // System
  resetSimulation,
  checkBackendHealth,
  uploadTestData,
  
  // WebSocket
  AetherWebSocket,
  
  // Utilities
  eciToLatLon
};

export default AetherAPI;