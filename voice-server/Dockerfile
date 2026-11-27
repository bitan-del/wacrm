# wacrm voice server — Gemini Live agent on WhatsApp Business calls (WebRTC media).
#
# Media is UDP on RTC_PORT_MIN..RTC_PORT_MAX (default 40000-40100). Run it with host networking
# (recommended):
#   docker run -d --name voice --restart unless-stopped --network host --env-file voice.env wacrm-voice-server
# or publish the UDP range with the SAME port numbers inside and outside:
#   docker run -d -p 127.0.0.1:8080:8080 -p 40000-40100:40000-40100/udp --env-file voice.env wacrm-voice-server
# Either way set PUBLIC_IP to the VM's public IPv4 address.
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src

USER node
EXPOSE 8080/tcp
EXPOSE 40000-40100/udp

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# SIGTERM ends live calls cleanly (each gets its "ended" event) before exit.
STOPSIGNAL SIGTERM
CMD ["node", "src/index.js"]
