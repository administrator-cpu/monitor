# cc-docker-proxy (TRD 14.4): HAProxy with a fixed allowlist in front of the Docker socket.
# Built by .github/workflows/images.yml from the repository root:
#   docker build -f apps/docker-proxy/Dockerfile -t cc-docker-proxy .
# The allowlist is tested with the same HAProxy major version by apps/docker-proxy/test.
FROM haproxy:2.8-alpine

LABEL org.opencontainers.image.source="https://github.com/administrator-cpu/monitor" \
      org.opencontainers.image.description="Command Center Docker API proxy: read-only allowlist for the node agent" \
      org.opencontainers.image.licenses="UNLICENSED"

COPY apps/docker-proxy/haproxy.cfg /usr/local/etc/haproxy/haproxy.cfg

# The image's default user (haproxy) is kept. Reading the socket needs the host's docker group,
# which the compose file adds with group_add (DOCKER_GID). 0 removes the three POST routes.
ENV ALLOW_ACTIONS=0
EXPOSE 2375
