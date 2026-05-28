FROM node:20-slim

ARG SERVICE_PATH

ENV NODE_ENV=production
ENV PORT=8080

WORKDIR /app

COPY package.json ./
COPY packages ./packages
COPY services ./services

WORKDIR /app/${SERVICE_PATH}

RUN npm install --omit=dev

CMD ["node", "src/server.js"]
