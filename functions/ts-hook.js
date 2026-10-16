const NAMES = {
  nodeCreated: "新设备加入",
  nodeNeedsApproval: "设备待审批",
  nodeApproved: "设备已审批",
  nodeKeyExpiringInOneDay: "节点密钥明天过期",
  nodeKeyExpired: "节点密钥已过期",
  nodeDeleted: "设备被删除",
  nodeSigned: "节点已签名",
  nodeNeedsSignature: "节点待签名",
  policyUpdate: "ACL 策略变更",
  userCreated: "新用户加入",
  userNeedsApproval: "用户待审批",
  userApproved: "用户已审批",
  userSuspended: "用户被停用",
  userRestored: "用户已恢复",
  userDeleted: "用户被删除",
  userRoleUpdated: "用户角色变更",
  subnetIPForwardingNotEnabled: "子网转发未启用",
  exitNodeIPForwardingNotEnabled: "出口节点转发未启用",
  test: "测试事件",
};

export async function onRequestPost({ request, env }) {
  const body = await request.text();

  // Tailscale 签名校验: t=<epoch>,v1=<hex>, HMAC-SHA256(secret, "t.body")
  const sigHeader = request.headers.get("Tailscale-Webhook-Signature") || "";
  const parts = Object.fromEntries(
    sigHeader.split(",").map((p) => p.trim().split("="))
  );
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1 || Math.abs(Date.now() / 1000 - Number(t)) > 300) {
    return new Response("stale or missing signature", { status: 401 });
  }
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.TS_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const mac = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(t + "." + body)
      )
    );
    const hex = Array.from(mac)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    if (hex !== v1.toLowerCase()) {
      return new Response("bad signature", { status: 401 });
    }
  } catch (e) {
    return new Response("worker error: " + (e && e.message), { status: 500 });
  }

  try {
    let events;
    try {
      events = JSON.parse(body);
    } catch (e) {
      return new Response("bad json", { status: 400 });
    }
    const text = events
      .map((ev) => {
        let line = "[" + (NAMES[ev.type] || ev.type) + "]" + (ev.message || "");
        // 待审批通知带上 nodeId, 方便群里直接回复审批
        if (ev.type === "nodeNeedsApproval") {
          const nodeId = (ev.data && (ev.data.nodeId || ev.data.nodeID)) || "";
          if (nodeId) {
            line += '\n@MuseNetwork 批准 ' + nodeId + ' 即可通过';
          }
        }
        return line;
      })
      .join("\n");

    // 飞书群机器人（未开签名校验，直接推送）
    const resp = await fetch(env.FEISHU_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msg_type: "text", content: { text: text } }),
    });
    const fbody = await resp.text();
    if (!resp.ok) {
      return new Response("feishu forward failed: " + fbody, { status: 502 });
    }
    return new Response("ok");
  } catch (e) {
    return new Response("worker error: " + (e && e.message), { status: 500 });
  }
}
