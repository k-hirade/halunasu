FROM node:20-slim

ARG SERVICE_PATH

ENV NODE_ENV=production
ENV PORT=8080

WORKDIR /app

RUN apt-get update \
  && if [ "${SERVICE_PATH}" = "services/fee-api" ]; then \
       apt-get install -y --no-install-recommends python3 python3-pip; \
     else \
       apt-get install -y --no-install-recommends python3; \
     fi \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY packages ./packages
COPY services ./services
COPY python ./python

ENV PYTHONPATH=/app/python

RUN if [ "${SERVICE_PATH}" = "services/fee-api" ]; then \
      python3 -m pip install \
        --break-system-packages \
        --no-cache-dir \
        --requirement /app/python/requirements-fee-runtime.txt; \
    fi

WORKDIR /app/${SERVICE_PATH}

RUN npm install --omit=dev

CMD ["node", "src/server.js"]
