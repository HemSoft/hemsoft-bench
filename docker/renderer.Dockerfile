# Dedicated offline renderer. Candidate tools and hidden graders still use the
# separately pinned python:3.12-slim image recorded in .local/runtime.json.
FROM python:3.12-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends librsvg2-bin \
    && rm -rf /var/lib/apt/lists/*
