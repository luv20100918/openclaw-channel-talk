/**
 * Channel Talk Function (Command) handler.
 *
 * Receives PUT requests from Channel Talk App Store when commands are invoked,
 * processes them through OpenClaw agent pipeline, and returns responses.
 *
 * Function URL format: /functions/channel-talk/{accountId}
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getRuntime, getChannelTalkApi } from "./runtime.js";
import { sendMessage, type ChannelTalkCredentials } from "./api.js";
import { processWebhookEvent, type ChannelTalkWebhookEvent, type WebhookTarget } from "./webhook.js";

// ── Active account targets ────────────────────────────────────────

interface FunctionTarget {
  accountId: string;
  creds: ChannelTalkCredentials;
  botName?: string;
  cfg: unknown; // OpenClawConfig
  log?: { info: (msg: string) => void; error?: (msg: string) => void };
}

const functionTargets = new Map<string, FunctionTarget>();

export function registerFunctionTarget(accountId: string, target: FunctionTarget): void {
  functionTargets.set(accountId, target);
}

export function unregisterFunctionTarget(accountId: string): void {
  functionTargets.delete(accountId);
}

// ── HTTP handler ──────────────────────────────────────────────────

const FUNCTION_PREFIX = "/functions/channel-talk";

export async function handleChannelTalkFunction(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (!url.pathname.startsWith(FUNCTION_PREFIX)) {
    return false; // Not our request
  }

  if (req.method !== "PUT") {
    res.statusCode = 405;
    res.setHeader("Allow", "PUT");
    res.end("Method Not Allowed");
    return true;
  }

  // Extract account ID from path: /functions/channel-talk/{accountId}
  const pathParts = url.pathname.slice(FUNCTION_PREFIX.length).split("/").filter(Boolean);
  const accountId = pathParts[0] ?? "default";

  const target = functionTargets.get(accountId);
  if (!target) {
    res.statusCode = 404;
    res.end(`No active Channel Talk account: ${accountId}`);
    return true;
  }

  // Read JSON body
  const body = await readJsonBody(req, 5 * 1024 * 1024);
  if (!body.ok) {
    res.statusCode = body.error === "payload_too_large" ? 413 : 400;
    res.end(JSON.stringify({ result: { error: body.error ?? "Bad Request" } }));
    return true;
  }

  // Respond immediately to avoid blocking
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({
    result: {
      type: "text",
      value: "처리 중입니다..."
    }
  }));

  // Process function request in background
  processFunctionRequest(body.data, target).catch((err) => {
    target.log?.error?.(`[channel-talk:${accountId}] function error: ${String(err)}`);
  });

  return true;
}

// ── Function request processing ───────────────────────────────────

interface ChannelTalkFunctionRequest {
  method?: string; // Command name
  params?: {
    chatId?: string;
    chatType?: string; // "group" | "userChat" | "directChat"
    value?: string; // User input text
    language?: string;
    [key: string]: unknown;
  };
  context?: {
    channel?: { id?: string };
    caller?: {
      type?: string; // "manager" | "user"
      id?: string;
    };
  };
}

interface ChannelTalkFunctionResponse {
  result: {
    type?: string;
    value?: string;
    attributes?: unknown;
  } | {
    error: string;
  };
}

async function processFunctionRequest(
  request: ChannelTalkFunctionRequest,
  target: FunctionTarget,
): Promise<ChannelTalkFunctionResponse> {
  // Log incoming request for debugging
  target.log?.info?.(`[channel-talk:${target.accountId}] Function request: ${JSON.stringify(request)}`);

  const params = request.params ?? {};
  const context = request.context ?? {};

  // Extract chat information (Channel Talk uses chat.id and chat.type)
  const chatId = (params as any).chat?.id || params.chatId;
  const chatType = (params as any).chat?.type || params.chatType || "userChat";
  // Channel Talk uses input.message for command parameters
  const userInput = ((params as any).input?.message || params.value || "").trim();

  if (!chatId) {
    return { result: { error: "Missing chatId in params" } };
  }

  if (!userInput) {
    return { result: { error: "Missing user input" } };
  }

  // Extract caller information
  const callerId = context.caller?.id ?? "unknown";
  const callerType = context.caller?.type ?? "user";

  // Convert Function request to Webhook event format
  const webhookEvent: ChannelTalkWebhookEvent = {
    event: "push",
    type: "Message",
    entity: {
      id: `function-${Date.now()}`,
      chatId: chatId,
      chatType: chatType,
      personType: callerType,
      personId: callerId,
      plainText: userInput,
      createdAt: Date.now(),
    },
    refers: {
      manager: callerType === "manager" ? {
        id: callerId,
        name: "Manager",
      } : undefined,
      user: callerType === "user" ? {
        id: callerId,
        name: "User",
      } : undefined,
    },
  };

  // Create webhook target from function target
  const webhookTarget: WebhookTarget = {
    accountId: target.accountId,
    creds: target.creds,
    botName: target.botName,
    triggerKeywords: [], // No keyword filtering for commands
    cfg: target.cfg,
    log: target.log,
  };

  // Process through webhook handler (async, will appear in TUI)
  processWebhookEvent(webhookEvent, webhookTarget).catch((err) => {
    target.log?.error?.(`[channel-talk:${target.accountId}] webhook processing error: ${String(err)}`);
  });

  // Return immediate response
  return {
    result: {
      type: "text",
      value: "처리 중입니다...",
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────

async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ ok: true; data: ChannelTalkFunctionRequest } | { ok: false; error: string }> {
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
        const data = JSON.parse(raw) as ChannelTalkFunctionRequest;
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
