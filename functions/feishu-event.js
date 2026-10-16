// 飞书应用事件回调: URL验证 + 群指令路由 + Tailscale API
const TS_API = "https://api.tailscale.com/api/v2";

function tailnet(env) {
  return (env.TAILNET || "-").trim() || "-";
}

const HELP_TEXT =
  "[Tailscale 管理] 指令（直接发群里）：\n" +
  "设备 - 设备列表\n" +
  "批准 <id> - 批准待审批设备\n" +
  "删除设备 <id> - 删除设备（需二次确认）\n" +
  "改名 <id> <新名字> - 修改设备名\n" +
  "路由 - 子网路由状态\n" +
  "开路由 <id> <网段> - 启用子网路由\n" +
  "关路由 <id> <网段> - 关闭子网路由\n" +
  "出口 - 出口节点列表\n" +
  "建key [天数] - 生成 auth key（默认30天，最长90天）\n" +
  "key列表 - auth key 列表\n" +
  "删key <keyId> - 吊销 key（需二次确认）";

async function tsFetch(env, path, opts) {
  opts = opts || {};
  const resp = await fetch(TS_API + path, {
    method: opts.method || "GET",
    headers: {
      Authorization: "Bearer " + env.TS_API_KEY,
      "Content-Type": "application/json",
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const raw = await resp.text();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch (e) {}
  return { ok: resp.ok, status: resp.status, data: data, raw: raw };
}

function parseCommand(text) {
  const clean = text.replace(/^@[^\s]+\s*/, "").trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  return { cmd: parts[0] || "", args: parts.slice(1) };
}

async function feishuSay(env, text) {
  await fetch(env.FEISHU_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msg_type: "text", content: { text: text } }),
  });
}

// ---------- 设备 ----------

async function handleDevices(env) {
  const r = await tsFetch(env, "/tailnet/" + tailnet(env) + "/devices");
  if (!r.ok) return "[设备] 查询失败：" + r.status;
  const list = (r.data && r.data.devices) || [];
  if (!list.length) return "[设备] 暂无设备";
  const lines = list.slice(0, 30).map(function (d) {
    const ip = ((d.addresses || [])[0] || "-").split("/")[0];
    const id = d.nodeId || d.id || "?";
    // 优先显示 MagicDNS 短名（改名改的就是这个），回退到 hostname
    const dnsName = (d.name || "").split(".")[0];
    const display = dnsName || d.hostname || "?";
    return "- " + display + " " + ip + " [" + id + "]";
  });
  let out = "[设备] 共 " + list.length + " 台：\n" + lines.join("\n");
  if (list.length > 30) out += "\n(仅显示前30台)";
  return out;
}

async function handleApprove(env, deviceId) {
  const r = await tsFetch(env, "/device/" + deviceId + "/authorized", {
    method: "POST",
    body: { authorized: true },
  });
  if (r.ok) return "[已批准] 设备 " + deviceId + " 已通过审批";
  if (r.status === 404) {
    return (
      "[审批失败] 设备 " +
      deviceId +
      "：Tailscale 找不到这个设备。请检查 ID 是否复制完整（应与待审批通知里的完全一致）。"
    );
  }
  return "[审批失败] 设备 " + deviceId + "：" + r.status + " " + r.raw.slice(0, 150);
}

async function handleDeleteDevice(env, deviceId) {
  const r = await tsFetch(env, "/device/" + deviceId, { method: "DELETE" });
  if (r.ok) return "[已删除] 设备 " + deviceId;
  if (r.status === 404) return "[删除失败] 找不到设备 " + deviceId + "，请检查 ID";
  return "[删除失败] " + r.status + " " + r.raw.slice(0, 150);
}

// ---------- 路由与出口 ----------

async function getRoutes(env, deviceId) {
  return tsFetch(env, "/device/" + deviceId + "/routes");
}

async function handleRoutes(env) {
  const dr = await tsFetch(env, "/tailnet/" + tailnet(env) + "/devices");
  if (!dr.ok) return "[路由] 查询设备失败：" + dr.status;
  const devices = (dr.data && dr.data.devices) || [];
  const results = await Promise.all(
    devices.map(async function (d) {
      const id = d.nodeId || d.id;
      const rr = await getRoutes(env, id);
      if (!rr.ok) return null;
      const adv = (rr.data && rr.data.advertisedRoutes) || [];
      if (!adv.length) return null;
      const ena = (rr.data && rr.data.enabledRoutes) || [];
      const marked = adv.map(function (rt) {
        return (ena.indexOf(rt) >= 0 ? "[开]" : "[关]") + rt;
      });
      return "- " + (d.hostname || id) + ": " + marked.join(" ");
    })
  );
  const lines = results.filter(Boolean);
  if (!lines.length) return "[路由] 没有设备通告子网路由";
  return "[路由]\n" + lines.join("\n");
}

async function handleRouteSet(env, deviceId, cidr, enable) {
  const r = await getRoutes(env, deviceId);
  if (!r.ok) return "[路由] 查询失败：" + r.status;
  let enabled = (r.data && r.data.enabledRoutes) || [];
  if (enable) {
    if (enabled.indexOf(cidr) < 0) enabled.push(cidr);
  } else {
    enabled = enabled.filter(function (x) {
      return x !== cidr;
    });
  }
  const w = await tsFetch(env, "/device/" + deviceId + "/routes", {
    method: "POST",
    body: { routes: enabled },
  });
  if (w.ok) return "[路由] 已" + (enable ? "启用 " : "关闭 ") + cidr;
  return "[路由] 操作失败：" + w.status + " " + w.raw.slice(0, 150);
}

async function handleExitNodes(env) {
  const dr = await tsFetch(env, "/tailnet/" + tailnet(env) + "/devices");
  if (!dr.ok) return "[出口] 查询设备失败：" + dr.status;
  const devices = (dr.data && dr.data.devices) || [];
  const results = await Promise.all(
    devices.map(async function (d) {
      const id = d.nodeId || d.id;
      const rr = await getRoutes(env, id);
      if (!rr.ok) return null;
      const adv = (rr.data && rr.data.advertisedRoutes) || [];
      const ena = (rr.data && rr.data.enabledRoutes) || [];
      const isExit = adv.some(function (rt) {
        return rt === "0.0.0.0/0" || rt === "::/0";
      });
      if (!isExit) return null;
      const on = ena.some(function (rt) {
        return rt === "0.0.0.0/0" || rt === "::/0";
      });
      return "- " + (d.hostname || id) + (on ? " [已启用]" : " [未启用]");
    })
  );
  const lines = results.filter(Boolean);
  if (!lines.length) return "[出口] 没有出口节点";
  return "[出口节点]\n" + lines.join("\n");
}

// ---------- 改名与改 IP ----------

async function handleRename(env, deviceId, newName) {
  const r = await tsFetch(env, "/device/" + deviceId + "/name", {
    method: "POST",
    body: { name: newName },
  });
  if (r.ok) return "[已改名] 设备 " + deviceId + " 现为 " + newName;
  if (r.status === 404) return "[改名失败] 找不到设备 " + deviceId;
  return "[改名失败] " + r.status + " " + r.raw.slice(0, 150);
}

// ---------- auth key ----------

async function handleCreateKey(env, daysArg) {
  let days = parseInt(daysArg || "30", 10);
  if (isNaN(days) || days < 1) days = 30;
  if (days > 90) days = 90;
  const r = await tsFetch(env, "/tailnet/" + tailnet(env) + "/keys", {
    method: "POST",
    body: {
      capabilities: {
        devices: {
          create: { reusable: true, ephemeral: false, preauthorized: true },
        },
      },
      expirySeconds: days * 86400,
      description: "feishu-bot " + new Date().toISOString().slice(0, 10),
    },
  });
  if (!r.ok) return "[建key] 失败：" + r.status + " " + r.raw.slice(0, 150);
  return (
    "[建key] 成功，有效期 " + days + " 天，可复用，已预授权（新设备免审批直接进网）。\n" +
    "key: " + r.data.key + "\n" +
    "注意：群消息所有人可见，请尽快使用或吊销。"
  );
}

async function handleListKeys(env) {
  const r = await tsFetch(env, "/tailnet/" + tailnet(env) + "/keys");
  if (!r.ok) return "[key列表] 查询失败：" + r.status;
  const keys = (r.data && r.data.keys) || [];
  if (!keys.length) return "[key列表] 暂无";
  const lines = keys.map(function (k) {
    const id = String(k.id || "?");
    const exp = k.expires || k.expiry || "-";
    const desc = k.description || "";
    return (
      "- " + id.slice(0, 16) + (id.length > 16 ? "..." : "") +
      " 过期:" + exp + (desc ? " " + desc : "")
    );
  });
  return "[key列表] 共 " + keys.length + " 个（仅显示ID前缀）：\n" + lines.join("\n");
}

async function handleDeleteKey(env, keyId) {
  const r = await tsFetch(env, "/tailnet/" + tailnet(env) + "/keys/" + keyId, {
    method: "DELETE",
  });
  if (r.ok) return "[已吊销] key " + keyId;
  if (r.status === 404) return "[吊销失败] 找不到 key " + keyId;
  return "[吊销失败] " + r.status + " " + r.raw.slice(0, 150);
}

// ---------- 主入口 ----------

export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }

  // 1. 飞书 URL 有效性验证(配置 Request URL 时触发)
  if (
    body.type === "url_verification" ||
    body.header?.event_type === "url_verification"
  ) {
    const challenge = body.challenge || body.event?.challenge;
    return Response.json({ challenge });
  }

  // 2. 事件 token 校验
  const token = body.header?.token;
  if (env.FEISHU_VERIFY_TOKEN && token !== env.FEISHU_VERIFY_TOKEN) {
    return new Response("bad token", { status: 401 });
  }

  const eventType = body.header?.event_type;
  if (eventType !== "im.message.receive_v1") {
    return new Response("ignored");
  }

  const msg = body.event?.message || {};
  const openId = body.event?.sender?.sender_id?.open_id || "";
  let text = "";
  try {
    text = JSON.parse(msg.content || "{}").text || "";
  } catch {
    text = "";
  }
  text = text.trim();

  const admins = (env.FEISHU_ADMINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // 自举: 未配置管理员时, 回复发送者他的 open_id
  if (admins.length === 0) {
    await feishuSay(
      env,
      "[Tailscale审批] 尚未配置管理员。你的 open_id 是 " +
        openId +
        "，把它发给配置者即可开通审批权限。"
    );
    return new Response("ok");
  }
  if (!openId || !admins.includes(openId)) {
    return new Response("not admin");
  }

  // 3. 指令路由
  const { cmd, args } = parseCommand(text);
  console.log("feishu command", { openId, cmd, argsLen: args.length });

  const validCmds = ["帮助", "help", "设备", "批准", "删除设备", "确认删除", "路由", "开路由", "关路由", "出口", "建key", "key列表", "删key", "确认删key", "改名"];
  if (!validCmds.includes(cmd)) {
    return new Response("no command");
  }

  // 立即返回 ok，避免飞书超时重试导致重复回复；实际处理放后台
  context.waitUntil(processCommand(env, cmd, args));
  return new Response("ok");
}

async function processCommand(env, cmd, args) {
  let reply = "";

  switch (cmd) {
    case "帮助":
    case "help":
      reply = HELP_TEXT;
      break;

    case "设备":
      reply = await handleDevices(env);
      break;

    case "批准":
      if (!args[0]) reply = "用法：批准 <设备id>";
      else reply = await handleApprove(env, args[0]);
      break;

    case "删除设备":
      if (!args[0]) reply = "用法：删除设备 <设备id>";
      else
        reply =
          "[请确认] 确定删除设备 " + args[0] + " 吗？此操作不可恢复。\n" +
          "请回复：确认删除 " + args[0];
      break;

    case "确认删除":
      if (!args[0]) reply = "用法：确认删除 <设备id>";
      else reply = await handleDeleteDevice(env, args[0]);
      break;

    case "路由":
      reply = await handleRoutes(env);
      break;

    case "开路由":
      if (args.length < 2)
        reply = "用法：开路由 <设备id> <网段>，例如：开路由 nz4WmanmmK11CNTRL 10.0.0.0/24";
      else reply = await handleRouteSet(env, args[0], args[1], true);
      break;

    case "关路由":
      if (args.length < 2) reply = "用法：关路由 <设备id> <网段>";
      else reply = await handleRouteSet(env, args[0], args[1], false);
      break;

    case "出口":
      reply = await handleExitNodes(env);
      break;

    case "建key":
      reply = await handleCreateKey(env, args[0]);
      break;

    case "key列表":
      reply = await handleListKeys(env);
      break;

    case "删key":
      if (!args[0]) reply = "用法：删key <keyId>";
      else
        reply =
          "[请确认] 确定吊销 key " + args[0] + " 吗？用此 key 的新设备将无法加入。\n" +
          "请回复：确认删key " + args[0];
      break;

    case "确认删key":
      if (!args[0]) reply = "用法：确认删key <keyId>";
      else reply = await handleDeleteKey(env, args[0]);
      break;

    case "改名":
      if (args.length < 2) reply = "用法：改名 <设备id> <新名字>";
      else reply = await handleRename(env, args[0], args[1]);
      break;

    default:
      break;
  }

  if (reply) await feishuSay(env, reply);
}
