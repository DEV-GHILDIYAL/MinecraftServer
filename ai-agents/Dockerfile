# CraftPanel AI agents image: minecraft-agent-harness (pinned) upgraded to Minecraft 26.1 + a shared rate-limit gate.
# Build on the EC2 host:  docker compose --profile ai build ai-agents
FROM node:22-bookworm

# Pinned commit so a new upstream push can never change what runs in your world without a rebuild.
ARG HARNESS_REPO=https://github.com/yc-software/minecraft-agent-harness.git
ARG HARNESS_REF=775d558689f5e4eaa0f1d0d7a320035190b1fce6

WORKDIR /harness
RUN git init -q . \
 && git remote add origin "$HARNESS_REPO" \
 && git fetch -q --depth 1 origin "$HARNESS_REF" \
 && git checkout -q FETCH_HEAD \
 && rm -rf .git

# 26.1 upgrade (see harness/README.md): mineflayer 4.33 -> 4.39 and minecraft-data 3.116 -> 3.119 with a locked
# dependency tree, and the harness's mineflayer patch ported to 4.39. The other patches apply unchanged.
COPY harness/package.json harness/package-lock.json ./
COPY harness/patches/ ./patches/
RUN rm -f patches/mineflayer+4.33.0.patch \
 && npm ci --omit=dev \
 && npm cache clean --force \
 && node -e "const v=require('mineflayer/lib/version');if(!v.testedVersions.includes('26.1'))throw new Error('mineflayer without 26.1');console.log('mineflayer supports',v.latestSupportedVersion)"

WORKDIR /app
COPY runner.mjs throttle.mjs ./

RUN mkdir -p /data && chown node:node /data
USER node
ENV AGENT_STATE_DIR=/data \
    AGENT_SANDBOX=none \
    NODE_OPTIONS="--disable-warning=ExperimentalWarning --import=/app/throttle.mjs"
VOLUME /data

ENTRYPOINT ["node", "/app/runner.mjs"]
