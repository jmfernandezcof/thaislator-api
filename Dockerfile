FROM node:24.18.0-alpine3.23@sha256:595398b0081eacda8e1c4c5b97b76cd1020e4d58a8ebcb4843b9bca1e79e7436
WORKDIR /app

# Voz de servidor fijada a una versión conocida; compiladores eliminados de la imagen final.
RUN apk add --no-cache python3 py3-pip \
 && apk add --no-cache --virtual .build gcc musl-dev python3-dev \
 && pip3 install --no-cache-dir --break-system-packages edge-tts==7.2.8 \
 && apk del .build \
 && addgroup -S -g 10001 arti \
 && adduser -S -D -H -u 10001 -G arti arti

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
 && npm cache clean --force
COPY --chown=10001:10001 server.js ./
COPY --chown=10001:10001 lib ./lib
COPY --chown=10001:10001 scripts ./scripts

ENV NODE_ENV=production
ENV PORT=3010
EXPOSE 3010
USER 10001:10001
CMD ["node", "server.js"]
