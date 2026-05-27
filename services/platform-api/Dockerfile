FROM node:20-slim

ENV NODE_ENV=production
ENV PLATFORM_API_PORT=8080

WORKDIR /app

COPY services/platform-api/package.json ./services/platform-api/package.json
COPY packages ./packages

WORKDIR /app/services/platform-api

RUN npm install --omit=dev

WORKDIR /app

COPY services/platform-api/src ./services/platform-api/src

WORKDIR /app/services/platform-api

CMD ["node", "src/server.js"]
