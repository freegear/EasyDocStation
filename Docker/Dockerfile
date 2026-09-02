# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS build
WORKDIR /build
COPY package*.json ./
RUN npm ci
COPY index.html vite.config.js postcss.config.js tailwind.config.js UpdateHistory.json ./
COPY public public
COPY template template
COPY src src
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=3001 SERVE_FRONTEND_DIST=1 PYTHONUNBUFFERED=1 PYTHON_BIN=/opt/easydocstation/venv/bin/python3 EASYDOC_STATION_FOLDER=/opt/easydocstation EASYDOC_DB_BASE=/data
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends build-essential ca-certificates curl python3 python3-dev python3-pip python3-venv ffmpeg libsndfile1 libgl1 libglib2.0-0 poppler-utils libreoffice libreoffice-impress tesseract-ocr tesseract-ocr-eng tesseract-ocr-kor cups-client && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/easydocstation
COPY server/requirements.txt server/requirements.txt
RUN python3 -m venv venv && venv/bin/pip install --no-cache-dir --upgrade pip setuptools wheel && venv/bin/pip install --no-cache-dir -r server/requirements.txt
COPY server/package*.json server/
RUN npm ci --omit=dev --prefix server && npm cache clean --force
COPY server server
COPY template template
COPY UpdateHistory.json config.json.example ./
COPY --from=build /build/dist dist
COPY Docker/entrypoint.sh /usr/local/bin/easydocstation-entrypoint
RUN chmod 0755 /usr/local/bin/easydocstation-entrypoint
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=5 CMD curl -fsS http://127.0.0.1:3001/api/health || exit 1
ENTRYPOINT ["/usr/local/bin/easydocstation-entrypoint"]
CMD ["node","server/index.js"]
