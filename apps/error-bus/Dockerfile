FROM node:20-alpine
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json eslint.config.mjs ./
COPY apps ./apps
COPY packages ./packages

RUN npm ci --workspace=@platform/error-bus --include-workspace-root
RUN npm run build -w @platform/error-bus

EXPOSE 3004
CMD ["node", "apps/error-bus/dist/index.js"]
