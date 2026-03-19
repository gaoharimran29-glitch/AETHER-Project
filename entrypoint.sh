#!/bin/bash
# AETHER entrypoint — starts Redis daemon then uvicorn
# Used when running single-container (docker build + docker run)
set -e

echo ""
echo "======================================================"
echo "  AETHER — Autonomous Constellation Manager"
echo "  National Space Hackathon 2026  |  IIT Delhi"
echo "======================================================"
echo ""

# ── Step 1: Redis ─────────────────────────────────────────────────────────────
echo "[1/3] Starting Redis..."
redis-server \
    --daemonize yes \
    --bind 127.0.0.1 \
    --port 6379 \
    --save "" \
    --loglevel warning

# ── Step 2: Wait for Redis ────────────────────────────────────────────────────
echo "[2/3] Waiting for Redis..."
MAX=30; C=0
until redis-cli -h 127.0.0.1 ping 2>/dev/null | grep -q "PONG"; do
    C=$((C+1))
    [ $C -ge $MAX ] && echo "ERROR: Redis failed to start" && exit 1
    sleep 1
done
echo "      Redis ready (${C}s)"

# ── Step 3: FastAPI ───────────────────────────────────────────────────────────
echo "[3/3] Starting AETHER API on 0.0.0.0:8000 (PS §8)..."
echo ""
exec uvicorn main:app \
    --host 0.0.0.0 \
    --port 8000 \
    --workers 1 \
    --log-level info