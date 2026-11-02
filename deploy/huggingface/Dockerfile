# Copy this file into your Hugging Face Space (as "Dockerfile").
# It downloads the latest tracker code from GitHub and starts it.
# To update the Space after the code changes: Space settings -> "Factory rebuild".
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN git clone --depth 1 https://github.com/bpderidder/race-of-the-classics-tracker.git . \
 && npm ci --omit=dev \
 && chown -R node:node /app
USER node
ENV PORT=7860
EXPOSE 7860
CMD ["node", "server.js"]
