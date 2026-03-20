# AETHER — Autonomous Constellation Manager

**National Space Hackathon 2026 · IIT Delhi**  
*Orbital Debris Avoidance & Constellation Management System*

---

## Quick Start (Graders)

```bash
# 1. Clone the repository
git clone https://github.com/gaoharimran29-glitch/AETHER-Project
cd "AETHER PROJECT"

# 2. Build and run with Docker (single command)
docker build -t aether .
docker run -p 8000:8000 aether

# 3. Verify the API is live
curl http://localhost:8000/api/status

# 4. Open the dashboard (human judges)
open http://localhost:8000
```

Or with Docker Compose:

```bash
docker compose up --build
```

The grading scripts can immediately start POSTing telemetry to `http://localhost:8000/api/telemetry`.

---

## Repository Structure

```
AETHER/
├── Dockerfile              ← PS §8 — root-level, ubuntu:22.04, port 8000
├── docker-compose.yml      ← For local development
├── entrypoint.sh           ← Starts Redis then uvicorn
├── .dockerignore           ← Keeps image lean
├── README.md
│
├── backend/                ← Python physics engine + FastAPI
│   ├── main.py             ← FastAPI app — all REST endpoints
│   ├── requirements.txt    ← Python dependencies
│   ├── data/
│   │   └── ground_stations.csv   ← PS §5.5.1 network
│   ├── physics/
│   │   ├── propagator.py         ← J2-perturbed RK4 propagator (PS §3.2)
│   │   ├── rk4_integrator.py     ← 4th-order Runge-Kutta
│   │   └── fuel_model.py         ← Tsiolkovsky rocket equation (PS §5.1)
│   ├── conjunction/
│   │   ├── tca_solver.py         ← Time of Closest Approach solver
│   │   ├── collision_probability.py  ← Analytic 2-D Gaussian Pc
│   │   └── monte_carlo_collision.py  ← Monte Carlo Pc verification
│   ├── maneuver/
│   │   └── maneuver_planner.py   ← RTN frame + MAX_DV enforcement (PS §5.3)
│   ├── optimizer/
│   │   └── fleet_optimizer.py    ← 24-candidate brute-force RTN search
│   ├── spatial_algo/
│   │   └── kd_tree.py            ← O(N log M) cKDTree screening (PS §2)
│   ├── comms/
│   │   ├── los_checker.py        ← Earth-occlusion + elevation mask (PS §5.4)
│   │   └── pass_predictor.py     ← Next pass window estimator
│   └── navigation/
│       └── station_keeper.py     ← 10 km box drift detection (PS §5.2)
│
└── frontend/               ← React dashboard (PS §6)
    ├── package.json
    ├── public/
    │   └── index.html
    └── src/
        ├── App.jsx               ← Main dashboard with 7 tabs
        ├── index.js / index.css
        ├── api/
        │   └── aetherApi.js      ← All backend HTTP calls
        ├── components/
        │   ├── ThreeScene.jsx    ← WebGL 3D globe (PS §6.1)
        │   ├── GroundTrackMap.jsx  ← Mercator + terminator (PS §6.2)
        │   ├── BullseyePlot.jsx  ← Conjunction polar chart (PS §6.2)
        │   ├── TelemetryHeatmap.jsx  ← Fuel gauges + ΔV chart (PS §6.2)
        │   ├── ManeuverTimeline.jsx  ← Gantt scheduler (PS §6.2)
        │   └── DataIngest.jsx    ← System status panel
        └── utils/
            └── terminator.js     ← Day/night boundary calculator
```

---

## API Endpoints (PS §4)

| Method | Endpoint | PS Ref | Description |
|--------|----------|--------|-------------|
| `POST` | `/api/telemetry` | §4.1 | Ingest satellite + debris state vectors |
| `POST` | `/api/maneuver/schedule` | §4.2 | Schedule burn sequence for satellite |
| `POST` | `/api/simulate/step` | §4.3 | Advance simulation by `step_seconds` |
| `GET`  | `/api/visualization/snapshot` | §6.3 | Optimised frontend snapshot |
| `GET`  | `/api/conjunction/forecast` | §2 | 24-hour CDM forecast |
| `GET`  | `/api/system/metrics` | §7 | Uptime, fuel, maneuver statistics |
| `GET`  | `/api/status` | §8 | Health check (Docker healthcheck) |
| `GET`  | `/api/satellite/{id}/next_pass` | §5.4 | Next ground station pass |
| `GET`  | `/api/alerts/history` | §2 | All logged CDM events |
| `POST` | `/api/reset` | — | Reset simulation state |

### Example — Ingest Telemetry (PS §4.1)

```bash
curl -X POST http://localhost:8000/api/telemetry \
  -H "Content-Type: application/json" \
  -d '{
    "timestamp": "2026-03-19T10:00:00.000Z",
    "objects": [
      {
        "id": "SAT-Alpha-01",
        "type": "SATELLITE",
        "r": {"x": 6778.0, "y": 0.0, "z": 0.0},
        "v": {"x": 0.0,   "y": 7.67, "z": 0.0},
        "fuel": 50.0
      },
      {
        "id": "DEB-99421",
        "type": "DEBRIS",
        "r": {"x": 6800.0, "y": 100.0, "z": 0.0},
        "v": {"x": 0.0,   "y": 7.60,  "z": 0.0}
      }
    ]
  }'
```

### Example — Advance Simulation (PS §4.3)

```bash
curl -X POST http://localhost:8000/api/simulate/step \
  -H "Content-Type: application/json" \
  -d '{"step_seconds": 3600}'
```

---

## Run the Test Suite

After starting Docker:

```bash
pip install requests
python test_system.py
```

This runs 10 automated tests covering every PS §4 endpoint — the same way the hackathon grading scripts work.

---

## Physics Engine

| Component | Algorithm | Reference |
|-----------|-----------|-----------|
| Orbital propagation | J2-perturbed Runge-Kutta 4th order | PS §3.2 |
| Conjunction screening | scipy cKDTree, O(N log M) | PS §2 |
| TCA solver | Adaptive scan + 30-iteration bisection | PS §2 |
| Collision probability | 2-D Gaussian Pc + Monte Carlo (5 000 samples) | PS §3.3 |
| Maneuver planning | RTN frame, 24-candidate brute-force optimizer | PS §5.3 |
| Fuel model | Tsiolkovsky rocket equation | PS §5.1 |
| Station-keeping | RTN proportional recovery ΔV | PS §5.2 |
| LOS checking | Ray-sphere occlusion + elevation mask | PS §5.4 |

### Physical Constants (PS §3.2, §5.1)

| Constant | Value |
|----------|-------|
| μ (Earth) | 398 600.4418 km³/s² |
| RE | 6 378.137 km |
| J2 | 1.08263 × 10⁻³ |
| Isp | 300.0 s |
| Dry mass | 500.0 kg |
| Initial fuel | 50.0 kg (wet mass 550.0 kg) |
| MAX ΔV/burn | 15.0 m/s |
| Cooldown | 600 s |
| Command latency | 10 s |
| Station-keeping box | 10 km radius |
| EOL threshold | 5% fuel |

---

## Docker Compliance (PS §8)

```dockerfile
FROM ubuntu:22.04          # ✓ Mandatory base image
EXPOSE 8000                # ✓ Grader port
# Binds to 0.0.0.0:8000   # ✓ Not localhost
```

- Redis starts inside the same container (no external dependency)
- Multi-stage build: Node builds React → only the static output is copied to final image
- Final image contains only runtime dependencies — no Node.js, no build tools
- Health check at `/api/status` confirms readiness before grader sends data

---

## Ground Station Network (PS §5.5.1)

| ID | Station | Lat | Lon | Min El |
|----|---------|-----|-----|--------|
| GS-001 | ISTRAC Bengaluru | 13.03°N | 77.52°E | 5° |
| GS-002 | Svalbard Station | 78.23°N | 15.41°E | 5° |
| GS-003 | Goldstone Tracking | 35.43°N | 116.89°W | 10° |
| GS-004 | Punta Arenas | 53.15°S | 70.92°W | 5° |
| GS-005 | IIT Delhi Ground Node | 28.55°N | 77.19°E | 15° |
| GS-006 | McMurdo Station | 77.85°S | 166.67°E | 5° |

---

*AETHER — National Space Hackathon 2026 · IIT Delhi*