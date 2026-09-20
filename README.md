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

## 主持人选角与身份发放

从左侧「选择剧本与角色」打开大弹窗。角色卡片包含图标和能力；「显示旅行者」默认关闭，开启后旅行者列在普通角色之后。

1. 按房间座位数点击「随机选择」，生成预选名单，再点卡片或已选标签进行调整。预选保存在当前主持页面，关闭弹窗不会丢失，刷新页面会重新读取已发放的角色。
2. 随机预选使用 5–15 位普通玩家的基础配置，扣除手动选入的旅行者。支持男爵的外来者 +2；酒鬼需要额外选择玩家实际看到的未入场镇民身份。其他修改开局配置的角色保留手动选择入口，由主持人校对，随机预选不自动处理它们。
3. 在「恶魔伪装」中选择三个未入场的善良角色，也可点「随机选择伪装」后手动调整。酒鬼看到的镇民身份不会出现在伪装候选中。七人及以上的恶魔局需要先选齐三个伪装；5–6 人局可留空。
4. 「分发角色」才会把预选名单打乱并正式安排到各座位。角色数量必须与座位数一致，身份、酒鬼显示身份和恶魔伪装在同一次更新中发放。单纯预选不会向玩家发布任何角色。
5. 玩家只能在已入座且身份已发放时看到自己的身份；恶魔还会看到主持人设置的三个伪装。HTTP 初始化、WebSocket 快照和广播、玩家导出均按同一权限过滤身份、伪装和主持人提醒。
6. 「收回身份显示」会隐藏玩家端身份及伪装，保留主持人的角色安排。更换剧本会清除旧角色并恢复未发放状态。没有发放标记的旧房间默认隐藏身份，需主持人重新发放。

规则参考：[官方开局流程](https://wiki.bloodontheclocktower.com/Setup)、[男爵](https://wiki.bloodontheclocktower.com/Baron)、[小恶魔与伪装](https://wiki.bloodontheclocktower.com/Imp)。本工具仍由主持人裁定特殊角色互动，非完整规则引擎。

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

运行数据统一位于项目根目录的 `data/`：`clocktower.sqlite` 保存房间，`content/catalog.runtime.json` 保存同步目录，`assets/` 保存本地素材。

`node_modules/` 是开发依赖，各工作区的 `dist/` 是构建产物；服务端运行会使用共享包的 `dist/`。需要重建时执行 `npm run build`。本地数据、缓存、环境配置和 Git 历史不进入 Docker 构建上下文；容器通过 Compose 挂载根目录 `data/`。

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

见 [.env.example](.env.example)。

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
