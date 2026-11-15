FROM node:24-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production \
    STORED_SETTINGS_FILE=/data/settings.json

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force \
    && install -d -o node -g node /data

COPY *.ts ./
COPY public/ ./public/

USER node
EXPOSE 3000

CMD ["node", "server.ts"]
