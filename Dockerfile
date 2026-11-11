# For hosts other than Render (any Docker host / VPS).
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production DB_FILE=/data/shuttle.db
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
VOLUME /data
EXPOSE 3000
CMD ["node", "src/server.js"]
