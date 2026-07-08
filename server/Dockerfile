# SermonIndex community chat — for Bunny Magic Containers (or any Docker host)
# Build & push (from the server/ folder):
#   docker build -t ghcr.io/<your-github-username>/si-chat:1 .
#   docker push ghcr.io/<your-github-username>/si-chat:1
FROM node:20-alpine
WORKDIR /app
COPY chat-server.mjs .
# Set your real admin key at deploy time via env var ADMIN_KEY
ENV CHAT_PORT=8787
EXPOSE 8787
CMD ["node", "chat-server.mjs"]
