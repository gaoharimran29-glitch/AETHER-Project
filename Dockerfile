# ─────────────────────────────────────────────────────────────────────────────
# AETHER — Autonomous Constellation Manager
# National Space Hackathon 2026, IIT Delhi
#
# PS §8 HARD REQUIREMENTS (auto-grader checks these):
#   [1] Base image  = ubuntu:22.04   (prevents dependency conflicts)
#   [2] Port 8000   = EXPOSE 8000    (grader hits this port)
#   [3] Bind addr   = 0.0.0.0        (not localhost — grader is external)
#
# This Dockerfile is SELF-CONTAINED:
#   Redis starts inside the same container before uvicorn launches.
#   No docker-compose required for the grader to test your submission.
# ─────────────────────────────────────────────────────────────────────────────

FROM ubuntu:22.04

# ── Environment ───────────────────────────────────────────────────────────────
ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
# Tells Python where to find your packages (spatial_algo, physics, etc.)
ENV PYTHONPATH=/app

# ── System packages ───────────────────────────────────────────────────────────
# redis-server  — in-container Redis (single-container mode for grader)
# build-essential — needed to compile scipy/numpy C extensions
# curl          — used by Docker healthcheck
RUN apt-get update && apt-get install -y \
    python3.10 \
    python3-pip \
    python3.10-dev \
    build-essential \
    redis-server \
    curl \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Make python3 and python both point to 3.10
RUN ln -sf /usr/bin/python3.10 /usr/bin/python3 \
 && ln -sf /usr/bin/python3.10 /usr/bin/python

# ── Working directory ─────────────────────────────────────────────────────────
WORKDIR /app

# ── Install Python deps BEFORE copying source (Docker layer cache) ────────────
# Copy only requirements first — if source changes but requirements don't,
# Docker reuses the pip install layer (much faster rebuild)
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

# ── Copy all source code ──────────────────────────────────────────────────────
COPY . .

# ── Port (PS §8) ──────────────────────────────────────────────────────────────
EXPOSE 8000

# ── Healthcheck — grader can verify the container is alive ───────────────────
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -f http://localhost:8000/api/status || exit 1

# ── Startup ───────────────────────────────────────────────────────────────────
# entrypoint.sh:
#   1. Starts redis-server as a background daemon
#   2. Waits until Redis responds to PING
#   3. Launches uvicorn bound to 0.0.0.0:8000 (PS §8)
RUN chmod +x /app/entrypoint.sh
CMD ["/app/entrypoint.sh"]