# =============================================================================
# AETHER — Autonomous Constellation Manager
# National Space Hackathon 2026, IIT Delhi
#
# PS §8 MANDATORY REQUIREMENTS — ALL SATISFIED:
#   [1] Base image  = ubuntu:22.04                        ✓
#   [2] EXPOSE 8000 (grading scripts hit this port)       ✓
#   [3] Bind addr   = 0.0.0.0 (not localhost)             ✓
#
# Architecture:
#   Stage 1 (node-builder) — builds React frontend into static files
#   Stage 2 (final)        — ubuntu:22.04 runs Python API + Redis
#                            and serves the built frontend via FastAPI
#
# The grader only needs port 8000. The frontend is served at GET /
# as a bonus for human judges — zero extra ports required.
# =============================================================================

# ── Stage 1: Build React frontend ─────────────────────────────────────────────
FROM node:18-slim AS node-builder

WORKDIR /build

# Copy only package files first for better layer caching
COPY frontend/package.json frontend/package-lock.json* ./

# Install dependencies (ci is faster and reproducible)
RUN npm ci --prefer-offline --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund

# Copy frontend source and build
COPY frontend/ .

# Set production API URL — FastAPI serves on same port 8000
ENV REACT_APP_API_URL=""
ENV NODE_ENV=production
ENV CI=false

RUN npm run build

# ── Stage 2: Final image (PS §8 — ubuntu:22.04) ───────────────────────────────
FROM ubuntu:22.04

LABEL maintainer="AETHER Team — National Space Hackathon 2026, IIT Delhi"
LABEL description="Autonomous Constellation Manager — Orbital Debris Avoidance System"

# Prevent interactive prompts during apt installs
ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
# Backend modules resolve from /app/backend
ENV PYTHONPATH=/app/backend

# ── System packages (minimal — only what's needed) ────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3.10 \
        python3-pip \
        python3.10-dev \
        build-essential \
        redis-server \
        curl \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Canonical python/pip symlinks
RUN ln -sf /usr/bin/python3.10 /usr/bin/python3 \
 && ln -sf /usr/bin/python3.10 /usr/bin/python \
 && ln -sf /usr/bin/pip3       /usr/bin/pip

WORKDIR /app

# ── Python dependencies (separate layer — only rebuilt when requirements change)
COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r requirements.txt \
 && pip install --no-cache-dir uvloop httptools \
 && rm -rf /root/.cache/pip

# ── Backend source ────────────────────────────────────────────────────────────
COPY backend/ ./backend/

# ── Built frontend static files from Stage 1 ─────────────────────────────────
# FastAPI will serve these at GET / for human judges
COPY --from=node-builder /build/build ./frontend/build

# ── Entrypoint script (embedded — no external file dependency) ────────────────
RUN printf '#!/bin/bash\n\
set -e\n\
\n\
echo "=== AETHER Autonomous Constellation Manager ==="\n\
echo "=== National Space Hackathon 2026 — IIT Delhi ==="\n\
echo ""\n\
\n\
# Configure Redis for minimal memory footprint\n\
redis-server \\\n\
    --daemonize yes \\\n\
    --bind 127.0.0.1 \\\n\
    --port 6379 \\\n\
    --loglevel warning \\\n\
    --save "" \\\n\
    --appendonly no \\\n\
    --maxmemory 256mb \\\n\
    --maxmemory-policy allkeys-lru\n\
\n\
# Wait for Redis to be ready\n\
echo "Starting Redis..."\n\
for i in $(seq 1 15); do\n\
    redis-cli ping >/dev/null 2>&1 && echo "Redis ready." && break\n\
    echo "Waiting for Redis ($i/15)..."\n\
    sleep 1\n\
done\n\
\n\
echo "Starting AETHER API on 0.0.0.0:8000..."\n\
echo "Grader API: http://0.0.0.0:8000/api/status"\n\
echo "Dashboard:  http://0.0.0.0:8000/"\n\
echo ""\n\
\n\
exec uvicorn backend.main:app \\\n\
    --host 0.0.0.0 \\\n\
    --port 8000 \\\n\
    --workers 1 \\\n\
    --loop uvloop \\\n\
    --http httptools \\\n\
    --timeout-keep-alive 120 \\\n\
    --log-level info\n\
' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# ── PS §8: grader connects on port 8000 ───────────────────────────────────────
EXPOSE 8000

# Health check — grader verifies container is up before sending telemetry
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=3 \
    CMD curl -fsS http://localhost:8000/api/status || exit 1

CMD ["/app/entrypoint.sh"]