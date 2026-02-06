/**
 * Channel Talk REST API client.
 * Docs: https://developers.channel.io
 * Base: https://api.channel.io/open/v5
 */

const BASE_URL = "https://api.channel.io/open/v5";

export interface ChannelTalkCredentials {
  accessKey: string;
  accessSecret: string;
}

// ── Message blocks ────────────────────────────────────────────────

export interface TextBlock {
  type: "text";
  value: string;
}

export interface CodeBlock {
  type: "code";
  value: string;
  language?: string;
}

export interface BulletsBlock {
  type: "bullets";
  blocks: TextBlock[];
}

export type MessageBlock = TextBlock | CodeBlock | BulletsBlock;

export type SendMessageOption =
  | "actAsManager"
  | "doNotPost"
  | "doNotSearch"
  | "doNotSendApp"
  | "immutable"
  | "private"
  | "silent";

// ── API helpers ───────────────────────────────────────────────────

async function apiRequest<T = unknown>(
  creds: ChannelTalkCredentials,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-access-key": creds.accessKey,
      "x-access-secret": creds.accessSecret,
    },
    ...(body != null ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "unknown error");
    return { ok: false, error: `Channel Talk API ${res.status}: ${errText}` };
  }

  const data = (await res.json()) as T;
  return { ok: true, data };
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Send a message to an existing UserChat.
 * POST /user-chats/{userChatId}/messages
 */
export async function sendUserChatMessage(
  creds: ChannelTalkCredentials,
  userChatId: string,
  text: string,
  opts?: { botName?: string; options?: SendMessageOption[] },
): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> {
  const blocks = markdownToBlocks(text);
  const path = `/user-chats/${encodeURIComponent(userChatId)}/messages${
    opts?.botName ? `?botName=${encodeURIComponent(opts.botName)}` : ""
  }`;

  const result = await apiRequest<{ id?: string }>(creds, "POST", path, {
    blocks,
    ...(opts?.options?.length ? { options: opts.options } : {}),
  });

  if (!result.ok) return result;
  return { ok: true, messageId: result.data.id ?? "" };
}

/**
 * Send a message to a Group (team chat).
 * POST /groups/{groupId}/messages      (by ID)
 * POST /groups/@{groupName}/messages   (by name)
 */
export async function sendGroupMessage(
  creds: ChannelTalkCredentials,
  groupId: string,
  text: string,
  opts?: { botName?: string; options?: SendMessageOption[] },
): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> {
  const blocks = markdownToBlocks(text);
  const groupRef = groupId.startsWith("@") ? groupId : encodeURIComponent(groupId);
  const path = `/groups/${groupRef}/messages${
    opts?.botName ? `?botName=${encodeURIComponent(opts.botName)}` : ""
  }`;

  const result = await apiRequest<{ id?: string }>(creds, "POST", path, {
    blocks,
    ...(opts?.options?.length ? { options: opts.options } : {}),
  });

  if (!result.ok) return result;
  return { ok: true, messageId: result.data.id ?? "" };
}

/**
 * Send a message — auto-dispatches to group or userChat based on chatType.
 */
export async function sendMessage(
  creds: ChannelTalkCredentials,
  chatId: string,
  text: string,
  opts?: { botName?: string; options?: SendMessageOption[]; chatType?: "group" | "userChat" },
): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> {
  if (opts?.chatType === "group") {
    return sendGroupMessage(creds, chatId, text, opts);
  }
  return sendUserChatMessage(creds, chatId, text, opts);
}

/**
 * Get channel info (useful for health check / probe).
 * GET /channel
 */
export async function getChannel(
  creds: ChannelTalkCredentials,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  return apiRequest(creds, "GET", "/channel");
}

/**
 * Get messages from a UserChat.
 * GET /user-chats/{userChatId}/messages
 */
export async function getMessages(
  creds: ChannelTalkCredentials,
  userChatId: string,
  opts?: { limit?: number; sortOrder?: "asc" | "desc" },
): Promise<{ ok: true; data: { messages: unknown[] } } | { ok: false; error: string }> {
  const params = new URLSearchParams();
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.sortOrder) params.set("sortOrder", opts.sortOrder);
  const qs = params.toString();
  return apiRequest(creds, "GET", `/user-chats/${encodeURIComponent(userChatId)}/messages${qs ? `?${qs}` : ""}`);
}

/**
 * Get manager information.
 * GET /managers/{managerId}
 */
export async function getManager(
  creds: ChannelTalkCredentials,
  managerId: string,
): Promise<{ ok: true; data: { id: string; name?: string; email?: string } } | { ok: false; error: string }> {
  return apiRequest(creds, "GET", `/managers/${encodeURIComponent(managerId)}`);
}

/**
 * Get user information.
 * GET /users/{userId}
 */
export async function getUser(
  creds: ChannelTalkCredentials,
  userId: string,
): Promise<{ ok: true; data: { id: string; name?: string; profile?: { name?: string; email?: string } } } | { ok: false; error: string }> {
  return apiRequest(creds, "GET", `/users/${encodeURIComponent(userId)}`);
}

// ── Markdown → Channel Talk blocks ───────────────────────────────

/**
 * Convert markdown text to Channel Talk block format.
 * Keeps it simple: code fences → code blocks, rest → text blocks.
 */
export function markdownToBlocks(text: string): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  const lines = text.split("\n");
  let inCode = false;
  let codeLang = "";
  let codeLines: string[] = [];
  let textLines: string[] = [];

  const flushText = () => {
    if (textLines.length > 0) {
      const value = textLines.join("\n").trim();
      if (value) blocks.push({ type: "text", value });
      textLines = [];
    }
  };

  const flushCode = () => {
    if (codeLines.length > 0) {
      const block: CodeBlock = { type: "code", value: codeLines.join("\n") };
      if (codeLang) block.language = codeLang;
      blocks.push(block);
      codeLines = [];
      codeLang = "";
    }
  };

  for (const line of lines) {
    const fenceMatch = line.match(/^```(\w*)$/);
    if (fenceMatch) {
      if (!inCode) {
        flushText();
        inCode = true;
        codeLang = fenceMatch[1] ?? "";
      } else {
        flushCode();
        inCode = false;
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
    } else {
      textLines.push(line);
    }
  }

  // Flush remaining
  if (inCode) flushCode();
  flushText();

  return blocks.length > 0 ? blocks : [{ type: "text", value: text }];
}

/**
 * Convert Channel Talk blocks back to plain text.
 */
export function blocksToText(blocks: Array<{ type: string; value?: string; blocks?: unknown[] }>): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text" && block.value) {
      // Strip simple HTML tags that Channel Talk uses
      parts.push(block.value.replace(/<[^>]+>/g, ""));
    } else if (block.type === "code" && block.value) {
      parts.push("```\n" + block.value + "\n```");
    } else if (block.type === "bullets" && Array.isArray(block.blocks)) {
      for (const sub of block.blocks as Array<{ value?: string }>) {
        if (sub.value) parts.push("- " + sub.value.replace(/<[^>]+>/g, ""));
      }
    }
  }
  return parts.join("\n");
}
