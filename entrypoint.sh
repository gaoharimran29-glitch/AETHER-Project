#!/bin/bash
# =============================================================================
# AETHER entrypoint — starts Redis then uvicorn
# National Space Hackathon 2026, IIT Delhi
#
# NOTE: This file is embedded directly in the Dockerfile via RUN printf.
#       It is included here as a readable reference copy.
#       Place it at the ROOT of your repository alongside the Dockerfile.
# =============================================================================
set -e

echo "=== AETHER Autonomous Constellation Manager ==="
echo "=== National Space Hackathon 2026 — IIT Delhi ==="
echo ""

# Configure Redis — minimal, no persistence (state is ephemeral per grader run)
redis-server \
    --daemonize yes \
    --bind 127.0.0.1 \
    --port 6379 \
    --loglevel warning \
    --save "" \
    --appendonly no \
    --maxmemory 256mb \
    --maxmemory-policy allkeys-lru

# Poll until Redis accepts connections
echo "Starting Redis..."
for i in $(seq 1 15); do
    redis-cli ping >/dev/null 2>&1 && echo "Redis ready." && break
    echo "Waiting for Redis ($i/15)..."
    sleep 1
done

echo "Starting AETHER API on 0.0.0.0:8000..."
echo "Grader API: http://0.0.0.0:8000/api/status"
echo "Dashboard:  http://0.0.0.0:8000/"
echo ""

# PS §8: must bind to 0.0.0.0, port 8000
exec uvicorn backend.main:app \
    --host 0.0.0.0 \
    --port 8000 \
    --workers 1 \
    --timeout-keep-alive 300 \
    --log-level info