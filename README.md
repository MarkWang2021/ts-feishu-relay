# ts-feishu-relay

Tailscale → 飞书中继：在飞书群里直接管理 Tailscale 设备。

## 功能

- **Tailscale 事件推送**：新设备待审批时，自动推送通知到飞书群
- **飞书指令管理**：在群里发指令即可管理 Tailscale

### 可用指令

| 指令 | 说明 |
|------|------|
| `帮助` | 查看全部指令 |
| `设备` | 设备列表（MagicDNS 短名、IP、设备 ID） |
| `批准 <id>` | 批准待审批设备 |
| `删除设备 <id>` | 删除设备（需二次确认） |
| `改名 <id> <新名字>` | 修改设备 MagicDNS 名字 |
| `路由` | 查看子网路由状态 |
| `开路由 <id> <网段>` / `关路由 <id> <网段>` | 启用/关闭子网路由 |
| `出口` | 查看出口节点列表 |
| `建key [天数]` | 生成 auth key（默认 30 天，最长 90 天） |
| `key列表` | 查看 auth key（仅 ID 前缀） |
| `删key <keyId>` | 吊销 key（需二次确认） |

所有指令仅管理员可用（飞书 open_id 白名单）。删除设备、吊销 key 等不可逆操作需要二次确认。

注意：改 IP 目前 Tailscale API 不支持，需去 Tailscale 后台手动修改。

## 架构

Cloudflare Pages Functions：

- `functions/ts-hook.js` — 接收 Tailscale webhook（HMAC 验签），转发到飞书群自定义机器人
- `functions/feishu-event.js` — 接收飞书应用事件回调，解析群指令，调用 Tailscale API

## 部署

### 环境变量（Cloudflare Pages → 设置 → 环境变量，全部设为加密）

| 变量 | 说明 |
|------|------|
| `FEISHU_URL` | 飞书群自定义机器人 webhook 地址 |
| `TS_API_KEY` | Tailscale API key |
| `TS_SECRET` | Tailscale webhook 签名密钥（HMAC 验签用） |
| `FEISHU_VERIFY_TOKEN` | 飞书应用 Verification Token |
| `FEISHU_ADMINS` | 管理员 open_id，逗号分隔 |
| `TAILNET` | 可选，tailnet 名，默认 `-` |

### 飞书应用配置

1. 创建飞书应用，订阅 `im.message.receive_v1` 事件
2. 事件回调 URL 填 `https://<你的域名>/feishu-event`
3. 发布应用并将机器人拉入群

### 部署命令

```bash
npx wrangler pages deploy . --project-name ts-feishu-relay
```

## 安全

- 所有密钥只放 Cloudflare 加密环境变量，不要写进代码
- Auth key 生成后直接发在群里，注意群消息所有人可见
- 飞书机器人签名校验已关闭（改直连），webhook URL 本身即密钥，请妥善保管
