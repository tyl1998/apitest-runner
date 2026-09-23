# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────────────────────
# apitest-runner 镜像
#
# runner 主动外连平台（长轮询领任务），clone 仓库、跑用户脚本、推日志、报终态。
# 运行时硬前置：
#   - git         每个 job 都要 clone（index.ts:34 启动即探测 git --version，缺则退出）
#   - POSIX shell  任务 steps 是 shell 脚本（镜像用 /bin/sh，bash 也在）
#   - ssh(可选)    仅 ssh_key 仓库需要；缺了不致命
#   - ca-certs     连平台 HTTPS
#
# 容器档（把测试跑进独立容器）注意事项，详见 DOCKER_DEPLOY.md：
#   - runner 在容器里时，挂宿主 /var/run/docker.sock → 测试容器是宿主上的「兄弟容器」，
#     隔离是共享宿主级别（假隔离），默认被 DIND 检测拦下，需 APITRACK_RUNNER_ALLOW_DIND=yes。
#   - cli 通道需要镜像内有 docker 可执行文件：用 --build-arg INSTALL_DOCKER_CLI=true 构建；
#     api 通道（APITRACK_RUNNER_DOCKER_TRANSPORT=api）只连 socket，无需 CLI。
#   - 挂载路径要两边对齐：APITRACK_RUNNER_DATA_DIR 必须是宿主真实路径，且以相同绝对
#     路径挂进本容器，否则宿主 daemon 解析 bind 源找不到 workspace，job 失败。
# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

# ── 全量依赖（含 devDeps：tsc 编译需要） ─────────────────────────────────────
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ── 编译 TypeScript → dist ────────────────────────────────────────────────────
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# ── 仅生产依赖（runner 无运行时依赖，这步基本为空，但保持一致的多阶段结构） ──
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod

# ── 运行镜像 ──────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production

# 运行时硬前置 + 干净的信号处理(tini)。ssh 供 ssh_key 仓库用；不用可自行精简。
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git openssh-client ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

# 可选：cli 通道需要 docker 可执行文件。api 通道无需，默认不装。
ARG INSTALL_DOCKER_CLI=false
RUN if [ "$INSTALL_DOCKER_CLI" = "true" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends curl gnupg \
      && install -m 0755 -d /etc/apt/keyrings \
      && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
      && chmod a+r /etc/apt/keyrings/docker.asc \
      && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
      && apt-get update \
      && apt-get install -y --no-install-recommends docker-ce-cli \
      && apt-get purge -y curl gnupg && apt-get autoremove -y \
      && rm -rf /var/lib/apt/lists/* ; \
    fi

WORKDIR /app

# dataDir：默认落到独立卷路径（而非 $HOME/.apitrack-runner），便于挂载对齐。
ENV APITRACK_RUNNER_DATA_DIR=/var/lib/apitrack-runner
RUN mkdir -p /var/lib/apitrack-runner && chown -R node:node /var/lib/apitrack-runner

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build     --chown=node:node /app/dist          ./dist
COPY --chown=node:node package.json ./

USER node
VOLUME ["/var/lib/apitrack-runner"]

# tini 作 PID 1：把 SIGTERM 正确转给 node，触发 runner 的优雅停机（丢租约/等在跑的 job）。
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
