FROM node:20-alpine
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json eslint.config.mjs ./
COPY apps ./apps
COPY packages ./packages

RUN npm ci --workspace=@platform/audit-service --include-workspace-root
RUN npm run build -w @platform/audit-service

EXPOSE 3003
CMD ["node", "apps/audit-service/dist/index.js"]
