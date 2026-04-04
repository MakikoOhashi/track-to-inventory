FROM node:20-alpine
RUN apk add --no-cache openssl graphicsmagick ghostscript

EXPOSE 4001

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./
COPY apps/ocr-api/package.json ./apps/ocr-api/package.json

RUN npm ci --omit=dev --workspace @track-to-inventory/ocr-api && npm cache clean --force

COPY . .

CMD ["npm", "run", "start:ocr"]
