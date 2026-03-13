FROM node:20-alpine
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json eslint.config.mjs ./
COPY apps ./apps
COPY packages ./packages

RUN npm ci --workspace=@platform/orchestrator --include-workspace-root
RUN npm run build -w @platform/contracts && npm run build -w @platform/serializers && npm run build -w @platform/orchestrator

EXPOSE 3000
CMD ["node", "apps/orchestrator/dist/index.js"]
