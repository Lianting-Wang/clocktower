FROM node:24-slim AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/content/package.json packages/content/package.json

RUN npm ci

COPY . .

RUN npm run build

FROM node:24-slim

WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app /app

EXPOSE 3100

CMD ["npm", "run", "start"]
