FROM node:20-alpine
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json eslint.config.mjs ./
COPY apps ./apps
COPY packages ./packages

RUN npm ci --workspace=@platform/mllp-listener --include-workspace-root
RUN npm run build -w @platform/mllp-listener

EXPOSE 2575
CMD ["node", "apps/mllp-listener/dist/index.js"]
