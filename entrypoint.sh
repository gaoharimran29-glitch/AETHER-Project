#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# AETHER entrypoint — starts Redis then FastAPI
# Called by Dockerfile CMD ["/app/entrypoint.sh"]
# ─────────────────────────────────────────────────────────────────────────────
set -e

echo ""
echo "======================================================"
echo "  AETHER — Autonomous Constellation Manager"
echo "  National Space Hackathon 2026  |  IIT Delhi"
echo "======================================================"
echo ""

# ── Step 1: Start Redis as a background daemon ────────────────────────────────
echo "[1/3] Starting Redis server..."
redis-server \
    --daemonize yes \
    --bind 127.0.0.1 \
    --port 6379 \
    --save "" \
    --loglevel warning

# ── Step 2: Wait until Redis is ready to accept connections ───────────────────
echo "[2/3] Waiting for Redis to be ready..."
MAX_TRIES=30
COUNT=0
until redis-cli -h 127.0.0.1 ping 2>/dev/null | grep -q "PONG"; do
    COUNT=$((COUNT + 1))
    if [ $COUNT -ge $MAX_TRIES ]; then
        echo "ERROR: Redis did not start within ${MAX_TRIES} seconds. Exiting."
        exit 1
    fi
    sleep 1
done
echo "      Redis is ready (took ${COUNT}s)."

# ── Step 3: Start AETHER backend ──────────────────────────────────────────────
echo "[3/3] Starting AETHER backend on 0.0.0.0:8000..."
echo ""

# PS §8: must bind to 0.0.0.0 (not localhost) so grader can reach port 8000
exec uvicorn main:app \
    --host 0.0.0.0 \
    --port 8000 \
    --workers 1 \
    --log-level info