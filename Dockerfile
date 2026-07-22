FROM node:20-alpine
WORKDIR /app
COPY server.js package.json ./
COPY public ./public
ENV PORT=3000 DATA_DIR=/app/data
VOLUME /app/data
EXPOSE 3000
CMD ["node", "server.js"]
