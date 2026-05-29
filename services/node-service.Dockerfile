FROM node:20-slim

ARG SERVICE_PATH

ENV NODE_ENV=production
ENV PORT=8080

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY packages ./packages
COPY services ./services
COPY python ./python

ENV PYTHONPATH=/app/python

WORKDIR /app/${SERVICE_PATH}

RUN npm install --omit=dev

CMD ["node", "src/server.js"]
