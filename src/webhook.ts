/**
 * Channel Talk webhook handler.
 *
 * Receives POST webhooks from Channel Talk, extracts inbound messages,
 * and dispatches them through the OpenClaw agent pipeline.
 *
 * Supports both:
 *   - Team chat (group): chatType "group", personType "manager"
 *   - User chat (customer): chatType "userChat", personType "user"
 *
 * Webhook URL format: /webhooks/channel-talk/{accountId}
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getRuntime, getChannelTalkApi } from "./runtime.js";
import { sendMessage, blocksToText, type ChannelTalkCredentials } from "./api.js";

// ── Active account targets ────────────────────────────────────────

export interface WebhookTarget {
  accountId: string;
  creds: ChannelTalkCredentials;
  botName?: string;
  groupAllowFrom?: string[]; // Only respond in these group IDs (empty = all)
  triggerKeywords: string[]; // Keywords that trigger the bot in group chat
  cfg: unknown; // OpenClawConfig
  log?: { info: (msg: string) => void; error?: (msg: string) => void };
}

const webhookTargets = new Map<string, WebhookTarget>();

export function registerWebhookTarget(accountId: string, target: WebhookTarget): void {
  webhookTargets.set(accountId, target);
}

export function unregisterWebhookTarget(accountId: string): void {
  webhookTargets.delete(accountId);
}

// ── HTTP handler ──────────────────────────────────────────────────

const WEBHOOK_PREFIX = "/webhooks/channel-talk";

export async function handleChannelTalkWebhook(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (!url.pathname.startsWith(WEBHOOK_PREFIX)) {
    return false; // Not our request
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
    return true;
  }

  // Extract account ID from path: /webhooks/channel-talk/{accountId}
  const pathParts = url.pathname.slice(WEBHOOK_PREFIX.length).split("/").filter(Boolean);
  const accountId = pathParts[0] ?? "default";

  const target = webhookTargets.get(accountId);
  if (!target) {
    res.statusCode = 404;
    res.end(`No active Channel Talk account: ${accountId}`);
    return true;
  }

  // Read JSON body
  const body = await readJsonBody(req, 5 * 1024 * 1024);
  if (!body.ok) {
    res.statusCode = body.error === "payload_too_large" ? 413 : 400;
    res.end(body.error ?? "Bad Request");
    return true;
  }

  // Respond immediately — process asynchronously
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end("{}");

  // Process in background
  processWebhookEvent(body.data, target).catch((err) => {
    target.log?.error?.(`[channel-talk:${accountId}] webhook error: ${String(err)}`);
  });

  return true;
}

// ── Webhook event processing ──────────────────────────────────────

export interface ChannelTalkWebhookEvent {
  event?: string; // "upsert" | "update" | "push"
  type?: string; // "Message" | "UserChat" | "User"
  entity?: {
    id?: string;
    chatId?: string;
    chatType?: string; // "group" (team chat) | "userChat" (customer chat)
    personType?: string; // "user" | "manager" | "bot"
    personId?: string;
    plainText?: string;
    blocks?: Array<{ type: string; value?: string; blocks?: unknown[] }>;
    createdAt?: number;
    updatedAt?: number;
    files?: unknown[];
  };
  refers?: {
    userChat?: {
      id?: string;
      userId?: string;
      name?: string;
      state?: string;
    };
    user?: {
      id?: string;
      name?: string;
      profile?: {
        email?: string;
        mobileNumber?: string;
        name?: string;
      };
    };
    manager?: {
      id?: string;
      name?: string;
      email?: string;
    };
  };
}

export async function processWebhookEvent(
  event: ChannelTalkWebhookEvent,
  target: WebhookTarget,
): Promise<void> {
  // Only process message events
  if (event.type !== "Message") return;

  const message = event.entity;
  if (!message) return;

  // Skip bot messages (avoid infinite loops)
  if (message.personType === "bot") return;

  // Determine chat type: "group" (team chat) or "userChat" (customer chat)
  const chatType = message.chatType ?? "userChat";
  const isGroupChat = chatType === "group";

  // Resolve chat ID
  const chatId = message.chatId ?? event.refers?.userChat?.id;
  if (!chatId) return;

  // Extract message text
  const rawBody = message.plainText?.trim()
    ?? (message.blocks ? blocksToText(message.blocks) : "").trim();
  if (!rawBody) return;

  // Keyword trigger: in group chats, only respond when a trigger keyword is present
  if (isGroupChat && target.triggerKeywords.length > 0) {
    const lower = rawBody.toLowerCase();
    const triggered = target.triggerKeywords.some((kw) => lower.includes(kw.toLowerCase()));
    if (!triggered) return;
  }

  // Resolve sender info — manager for team chat, user for customer chat
  let senderId: string;
  let senderName: string;
  let senderEmail: string | undefined;

  if (message.personType === "manager" && event.refers?.manager) {
    const mgr = event.refers.manager;
    senderId = message.personId ?? mgr.id ?? "unknown";
    senderName = mgr.name ?? "Manager";
    senderEmail = mgr.email;
  } else {
    senderId = message.personId ?? event.refers?.user?.id ?? "unknown";
    senderName =
      event.refers?.user?.profile?.name
      ?? event.refers?.user?.name
      ?? event.refers?.userChat?.name
      ?? "User";
    senderEmail = event.refers?.user?.profile?.email;
  }

  const messageId = message.id ?? "";

  const runtime = getRuntime();
  const api = getChannelTalkApi();
  const cfg = api.config;

  // Check pairing status - try to use runtime pairing system
  const account = cfg.channels?.["channel-talk"]?.accounts?.[target.accountId] ?? {};
  const dmPolicy = account.dmPolicy ?? "pairing";
  const configAllowFrom = account.allowFrom ?? [];

  if (dmPolicy === "pairing") {
    target.log?.info?.(`[channel-talk] Checking pairing for senderId: ${senderId}`);

    // Read allowFrom store through runtime
    const storeAllowFrom = await runtime.channel.pairing.readAllowFromStore("channel-talk");
    const combinedAllowFrom = [...configAllowFrom, ...storeAllowFrom];
    const isAllowed = combinedAllowFrom.includes(senderId) || combinedAllowFrom.includes("*");

    target.log?.info?.(`[channel-talk] allowFrom check: isAllowed=${isAllowed}, combined=${JSON.stringify(combinedAllowFrom)}`);

    if (!isAllowed) {
      // Create/update pairing request
      const { code, created } = await runtime.channel.pairing.upsertPairingRequest({
        channel: "channel-talk",
        id: senderId,
        meta: { name: senderName },
      });

      target.log?.info?.(`[channel-talk] Pairing request: code=${code}, created=${created}`);

      // Only send pairing message if newly created
      if (created) {
        const personType = message.personType === "manager" ? "manager" : "user";

        // Build pairing reply using runtime helper
        let replyText = runtime.channel.pairing.buildPairingReply({
          channel: "channel-talk",
          idLine: `Channel Talk ${personType} ID: ${senderId}`,
          code,
        });

        // Replace <code> placeholder with actual code
        replyText = replyText.replace(/<code>/g, code);

        target.log?.info?.(`[channel-talk] Pairing message text: ${JSON.stringify(replyText)}`);
        target.log?.info?.(`[channel-talk] Sending pairing message to chatId=${chatId}, chatType=${isGroupChat ? "group" : "userChat"}`);

        const result = await sendMessage(target.creds, chatId, replyText, {
          botName: target.botName,
          chatType: isGroupChat ? "group" : "userChat",
        });

        target.log?.info?.(`[channel-talk] Pairing message send result: ${JSON.stringify(result)}`);
      }

      return; // Don't process message until paired
    }
  }

  // Resolve agent route
  const route = runtime.channel.routing.resolveAgentRoute({
    cfg,
    channel: "channel-talk",
    accountId: target.accountId,
    peer: {
      kind: isGroupChat ? ("group" as const) : ("dm" as const),
      id: chatId,
    },
  });

  // Build inbound message context
  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: rawBody,
    RawBody: rawBody,
    CommandBody: rawBody,
    BodyForAgent: rawBody,
    BodyForCommands: rawBody,
    From: `channel-talk:${senderId}`,
    To: `channel-talk:${chatId}`,
    SessionKey: route.sessionKey,
    AccountId: target.accountId,
    ChatType: isGroupChat ? "channel" : "direct",
    ConversationLabel: senderName,
    SenderName: senderName,
    SenderId: senderId,
    SenderUsername: senderEmail ?? senderId,
    Provider: "channel-talk",
    Surface: "channel-talk",
    MessageSid: messageId,
    MessageSidFull: messageId,
    Timestamp: message.createdAt ?? Date.now(),
    OriginatingChannel: "channel-talk",
    OriginatingTo: `channel-talk:${chatId}`,
    ...(isGroupChat ? { GroupSubject: `team-chat:${chatId}` } : {}),
  });

  // Dispatch through agent pipeline, delivering reply via Channel Talk API
  await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      deliver: async (payload: { text?: string; mediaUrl?: string }) => {
        const text = payload.text?.trim();
        if (!text) return;

        const result = await sendMessage(target.creds, chatId, text, {
          botName: target.botName,
          chatType: isGroupChat ? "group" : "userChat",
        });

        if (!result.ok) {
          target.log?.error?.(`[channel-talk:${target.accountId}] send failed: ${result.error}`);
        }
      },
      onError: (err: unknown) => {
        target.log?.error?.(
          `[channel-talk:${target.accountId}] agent error: ${String(err)}`,
        );
      },
    },
  });
}

// ── Helpers ───────────────────────────────────────────────────────

async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ ok: true; data: ChannelTalkWebhookEvent } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        req.destroy();
        resolve({ ok: false, error: "payload_too_large" });
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        const data = JSON.parse(raw) as ChannelTalkWebhookEvent;
        resolve({ ok: true, data });
      } catch {
        resolve({ ok: false, error: "invalid_json" });
      }
    });

    req.on("error", () => {
      resolve({ ok: false, error: "read_error" });
    });
  });
}
