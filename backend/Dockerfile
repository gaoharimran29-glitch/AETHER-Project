# ─────────────────────────────────────────────────────────────────────────────
# AETHER — Autonomous Constellation Manager
# National Space Hackathon 2026, IIT Delhi
#
# PS §8 HARD REQUIREMENTS:
#   [1] Base image = ubuntu:22.04
#   [2] Port 8000  = EXPOSE 8000  (backend API)
#   [3] Bind addr  = 0.0.0.0
#
# Self-contained: Redis starts inside container before uvicorn.
# ─────────────────────────────────────────────────────────────────────────────

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app

RUN apt-get update && apt-get install -y \
    python3.10 \
    python3-pip \
    python3.10-dev \
    build-essential \
    redis-server \
    curl \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

RUN ln -sf /usr/bin/python3.10 /usr/bin/python3 \
 && ln -sf /usr/bin/python3.10 /usr/bin/python

WORKDIR /app

# Install deps first (better layer caching)
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

# Copy source
COPY . .

# PS §8: grader hits port 8000
EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=5s --start-period=25s --retries=3 \
    CMD curl -f http://localhost:8000/api/status || exit 1

RUN chmod +x /app/entrypoint.sh
CMD ["/app/entrypoint.sh"]