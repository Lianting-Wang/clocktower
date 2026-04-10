# Clocktower Local

本项目是一个本地自托管的血染钟楼网页端重写版本，目标是把官方网页端拆成可维护的 `domain + protocol + content + server + web` 五层，并把实时同步和内容镜像都收回本地。

## 当前实现

- `packages/domain`
  - 房间状态、座位、角色分发、提名投票、投票历史、待处决标记、提醒标记、JSON 导入导出
- `packages/protocol`
  - HTTP / WebSocket schema 与类型
- `packages/content`
  - 本地 catalog 读写、官方 `POST` 同步、资源镜像、本地路径重写
- `apps/server`
  - Fastify API、WebSocket 房间总线、SQLite 快照持久化、静态内容服务
- `apps/web`
  - React 响应式前端，支持房间创建/加入、座位认领、主持面板、投票面板、角色与奇遇选择、自定义剧本导入

## 目录

```text
apps/
  server/
  web/
packages/
  domain/
  protocol/
  content/
data/
  content/
  assets/
```

## 本地开发

```bash
npm install
npm run sync:content
npm run dev
```

默认前端 Vite 跑在 `5173`，服务端跑在 `3100`。开发模式下，Vite 会把 `/api/*` 和 `/content/assets/*` 代理到 `VITE_DEV_API_TARGET`，默认也是 `http://127.0.0.1:3100`。如果你只想跑编译产物：

```bash
npm run build
npm run start
```

## 内容同步

第一次建议先执行：

```bash
npm run sync:content
```

它会：

- 从官方 `POST /ct/grimoireRoleJson/` 拉角色与奇遇
- 从官方 `POST /ct/grimoire_edition_list/` 拉在线剧本目录
- 将资源镜像到 `data/assets/`
- 将本地内容快照写到 `data/content/catalog.runtime.json`

同步完成后，浏览器访问的是本地 `/api/content/catalog` 和本地 `/content/assets/*`。

## 环境变量

见 [.env.example](/Users/wlt/Project/test/clocktower/.env.example)。

- `CONTENT_MODE`
  - `local`
  - `mirror_official`
  - `remote_proxy`
  - `import_only`
- `OFFICIAL_SYNC_ENABLED`
  - 是否允许后台检查并镜像官方内容
- `OFFICIAL_SYNC_ON_BOOT`
  - 服务启动时是否自动检查更新
- `OFFICIAL_SYNC_INTERVAL`
  - 后台检查间隔，单位毫秒
- `ROOM_TTL_HOURS`
  - 房间过期时间
- `SQLITE_PATH`
  - SQLite 文件路径
- `PUBLIC_BASE_URL`
  - 对外访问根地址，会用于生成玩家链接和主持链接
- `ASSET_MIRROR_ENABLED`
  - 是否镜像远程资源到本地

## Docker

```bash
cp .env.example .env
docker compose build
docker compose up -d
```

首次启动后可以进入容器或在宿主机执行一次：

```bash
npm run sync:content
```

然后通过 `PUBLIC_BASE_URL` 对应地址访问。

## 验证

```bash
npm test
npm run build
```

## 当前边界

- Cloudflare Workers / Durable Objects 还没有接入，只保留了 `RoomStore` / `RealtimeAdapter` 扩展位
- 微信小程序端未开始实现，但共享层已经拆出，二期可直接复用
- 官方数据镜像已经本地化，但具体的房规自动裁决仍保持“主持端主导”的工具形态，不强行把所有血染钟楼规则写死在引擎里
