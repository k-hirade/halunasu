FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV GATEWAY_PORT=8080

COPY package.json package-lock.json ./
COPY services/gateway/package.json services/gateway/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/core/package.json packages/core/package.json

RUN npm ci

COPY . .

EXPOSE 8080
CMD ["npm", "run", "start", "--workspace", "@medical/gateway"]
