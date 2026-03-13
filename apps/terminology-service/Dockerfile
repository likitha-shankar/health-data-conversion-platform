FROM node:20-alpine
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json eslint.config.mjs ./
COPY apps ./apps
COPY packages ./packages

RUN npm ci --workspace=@platform/terminology-service --include-workspace-root
RUN npm run build -w @platform/terminology-service

EXPOSE 3002
CMD ["node", "apps/terminology-service/dist/index.js"]
