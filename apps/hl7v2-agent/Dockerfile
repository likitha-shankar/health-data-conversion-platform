FROM node:20-alpine
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json eslint.config.mjs ./
COPY apps ./apps
COPY packages ./packages

RUN npm ci --workspace=@platform/hl7v2-agent --include-workspace-root
RUN npm run build -w @platform/hl7v2-agent

EXPOSE 3001
CMD ["node", "apps/hl7v2-agent/dist/index.js"]
