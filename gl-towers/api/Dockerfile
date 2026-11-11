FROM node:22-alpine
WORKDIR /app
COPY api/package*.json ./api/
RUN cd api && npm ci --omit=dev
COPY api ./api
COPY web ./web
COPY db ./db
ENV WEB_DIR=/app/web
EXPOSE 3000
CMD ["sh", "-c", "cd api && node src/seed.js && node src/index.js"]
