FROM node:22-alpine
WORKDIR /app
COPY server.js package.json ./
COPY public ./public
COPY scripts ./scripts
# The server itself needs nothing. The optional packages are what the scanner
# index, outgoing mail and the two-factor QR are built on — absent, each of
# those quietly does not happen, which is a worse failure than a loud one.
RUN npm install --omit=dev --no-audit --no-fund || true
ENV PORT=3000 DATA_DIR=/app/data
VOLUME /app/data
EXPOSE 3000
CMD ["node", "server.js"]
