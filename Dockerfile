FROM node:22.23-alpine3.24 AS builder
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
# Codegen only: prisma.config.ts resolves DIRECT_DATABASE_URL at load time and the
# build context has no .env, so give it a placeholder. No connection is made.
RUN DIRECT_DATABASE_URL=postgresql://build:build@localhost:5432/build DATABASE_URL=postgresql://build:build@localhost:5432/build npx prisma generate
RUN npm run build

FROM node:22.23-alpine3.24
RUN apk add --no-cache openssl
EXPOSE 3000
WORKDIR /app
ENV NODE_ENV=production
ENV PATH="/app/node_modules/.bin:${PATH}"
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --workspaces=false && npm cache clean --force
COPY --from=builder /app/build ./build
COPY prisma ./prisma
COPY prisma.config.ts ./
CMD ["sh", "-c", "prisma migrate deploy && exec react-router-serve ./build/server/index.js"]
