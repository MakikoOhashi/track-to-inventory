FROM node:20-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./
COPY apps/web/package.json ./apps/web/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY apps/web/prisma ./apps/web/prisma

RUN npm ci --omit=dev --workspace @track-to-inventory/web && npm cache clean --force
# Remove CLI packages since we don't need them in production by default.
# Remove this line if you want to run CLI commands in your container.
RUN npm remove -w @track-to-inventory/web @shopify/cli

COPY . .

RUN npm run build

CMD ["npm", "run", "docker-start", "-w", "@track-to-inventory/web"]
