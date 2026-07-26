FROM node:22-alpine
WORKDIR /app
COPY server.js package.json ./
COPY public ./public
COPY scripts ./scripts
ENV PORT=3000 DATA_DIR=/app/data
VOLUME /app/data
EXPOSE 3000
CMD ["node", "server.js"]
