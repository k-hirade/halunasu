FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV FINALIZE_PORT=8080

COPY package.json package-lock.json ./
COPY services/finalize/package.json services/finalize/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/core/package.json packages/core/package.json

RUN npm ci

COPY . .

EXPOSE 8080
CMD ["npm", "run", "start", "--workspace", "@medical/finalize"]
