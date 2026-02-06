/**
 * Channel Talk ChannelPlugin definition for OpenClaw.
 *
 * Implements the required adapters: config, outbound, gateway, messaging, security, status.
 */

import type { ChannelPlugin } from "openclaw/plugin-sdk";
import { getRuntime, getChannelTalkApi } from "./runtime.js";
import { sendMessage, getChannel, type ChannelTalkCredentials } from "./api.js";
import { registerWebhookTarget, unregisterWebhookTarget } from "./webhook.js";
import { registerFunctionTarget, unregisterFunctionTarget } from "./function.js";

// ── Account types ─────────────────────────────────────────────────

export interface ChannelTalkAccountConfig {
  enabled?: boolean;
  name?: string;
  accessKey?: string;
  accessSecret?: string;
  botName?: string;
  dmPolicy?: "open" | "pairing" | "allowlist" | "disabled";
  allowFrom?: string[];
  groupAllowFrom?: string[]; // Group IDs where the bot is allowed to respond
  triggerKeywords?: string[]; // Keywords that trigger the bot in group chat (default: [botName])
  mediaMaxMb?: number;
}

export interface ResolvedChannelTalkAccount {
  accountId: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  creds: ChannelTalkCredentials;
  botName?: string;
  config: ChannelTalkAccountConfig;
}

// ── Config helpers ────────────────────────────────────────────────

function getChannelSection(cfg: any): Record<string, any> | undefined {
  return cfg?.channels?.["channel-talk"];
}

function getAccountsMap(cfg: any): Record<string, ChannelTalkAccountConfig> {
  return getChannelSection(cfg)?.accounts ?? {};
}

function resolveAccount(cfg: any, accountId?: string | null): ResolvedChannelTalkAccount {
  const id = accountId ?? "default";
  const accounts = getAccountsMap(cfg);
  const raw = accounts[id] ?? {};
  const accessKey = raw.accessKey ?? "";
  const accessSecret = raw.accessSecret ?? "";

  return {
    accountId: id,
    name: raw.name ?? id,
    enabled: raw.enabled !== false,
    configured: Boolean(accessKey && accessSecret),
    creds: { accessKey, accessSecret },
    botName: raw.botName,
    config: raw,
  };
}

// ── ChannelPlugin ─────────────────────────────────────────────────

export const channelTalkPlugin: ChannelPlugin<ResolvedChannelTalkAccount> = {
  id: "channel-talk",

  meta: {
    id: "channel-talk",
    label: "Channel Talk",
    selectionLabel: "Channel Talk (채널톡)",
    docsPath: "/channels/channel-talk",
    blurb: "Channel Talk team & customer messaging integration. Target format: @<groupName> (e.g., @AI테스트) or numeric group ID (e.g., 540639) for group chats. Use @<groupName> for convenience when referencing groups by name.",
  },

  capabilities: {
    chatTypes: ["direct", "group"],
    media: false, // Can add media support later
    reactions: false,
  },

  reload: { configPrefixes: ["channels.channel-talk"] },

  // ── Config adapter ──────────────────────────────────────────────

  config: {
    listAccountIds: (cfg) => Object.keys(getAccountsMap(cfg)),

    resolveAccount: (cfg, accountId) => resolveAccount(cfg, accountId),

    defaultAccountId: () => "default",

    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      const id = accountId ?? "default";
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          "channel-talk": {
            ...getChannelSection(cfg),
            accounts: {
              ...getAccountsMap(cfg),
              [id]: {
                ...getAccountsMap(cfg)[id],
                enabled,
              },
            },
          },
        },
      };
    },

    deleteAccount: ({ cfg, accountId }) => {
      const id = accountId ?? "default";
      const next = { ...getAccountsMap(cfg) };
      delete next[id];
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          "channel-talk": {
            ...getChannelSection(cfg),
            accounts: next,
          },
        },
      };
    },

    isConfigured: (account) => account.configured,

    isEnabled: (account) => account.enabled,

    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
    }),

    resolveAllowFrom: ({ cfg, accountId }) => {
      const account = resolveAccount(cfg, accountId);
      return (account.config.allowFrom ?? []).map(String);
    },

    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.map((e) => String(e).trim()).filter(Boolean),
  },

  // ── Security adapter ────────────────────────────────────────────

  // Pairing adapter (OpenClaw standard)
  pairing: {
    idLabel: "Channel Talk user ID",
    normalizeAllowEntry: (entry) => String(entry).trim(),
    notifyApproval: async ({ cfg, id, runtime }) => {
      // Optional: Send notification to user when approved
      // const account = resolveAccount(cfg);
      // await sendMessage(account.creds, id, "✅ OpenClaw access approved!");
    },
  },

  // Security adapter
  security: {
    resolveDmPolicy: ({ account, accountId }) => {
      const id = accountId ?? account.accountId ?? "default";
      const basePath = `channels.channel-talk.accounts.${id}.`;
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: `${basePath}allowFrom`,
        approveHint: "openclaw pairing approve channel-talk <code>",
        normalizeEntry: (raw) => String(raw).trim(),
      };
    },
  },

  // ── Messaging adapter ───────────────────────────────────────────

  messaging: {
    normalizeTarget: (raw) => {
      const cleaned = raw.replace(/^channel-talk:/i, "").trim();
      return cleaned || undefined;
    },
    targetResolver: {
      looksLikeId: (raw) => {
        const cleaned = raw.replace(/^channel-talk:/i, "").trim();
        // Support: numeric ID, group:ID, @groupName
        if (/^\d+$/.test(cleaned)) return true; // numeric ID
        if (/^group:\d+$/.test(cleaned)) return true; // group:ID
        if (/^@[\w가-힣_-]+$/.test(cleaned)) return true; // @groupName (alphanumeric, Korean, underscore, hyphen)
        return false;
      },
      hint: "@<groupName> (recommended, e.g. @AI테스트) or numeric <groupId> (e.g. 540639) or group:<groupId>",
    },
  },

  // ── Outbound adapter ───────────────────────────────────────────

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 5000,

    sendText: async ({ cfg, to, text, accountId }) => {
      const account = resolveAccount(cfg, accountId);
      if (!account.configured) {
        return { ok: false, error: "Channel Talk account not configured" };
      }

      // Detect target type: "group:xxx" → group, otherwise → userChat
      const raw = to.replace(/^channel-talk:/i, "");
      const isGroup = raw.startsWith("group:") || raw.startsWith("@");
      const chatId = raw.replace(/^group:/, "");

      const result = await sendMessage(account.creds, chatId, text, {
        botName: account.botName,
        chatType: isGroup ? "group" : "userChat",
      });

      if (!result.ok) return result;
      return { ok: true, messageId: result.messageId };
    },

    sendMedia: async ({ cfg, to, text, accountId }) => {
      // Channel Talk file upload requires a separate API — send text only for now
      const account = resolveAccount(cfg, accountId);
      if (!account.configured) {
        return { ok: false, error: "Channel Talk account not configured" };
      }

      const raw = to.replace(/^channel-talk:/i, "");
      const isGroup = raw.startsWith("group:") || raw.startsWith("@");
      const chatId = raw.replace(/^group:/, "");

      const result = await sendMessage(account.creds, chatId, text || "(media)", {
        botName: account.botName,
        chatType: isGroup ? "group" : "userChat",
      });

      if (!result.ok) return result;
      return { ok: true, messageId: result.messageId };
    },
  },

  // ── Gateway adapter (webhook lifecycle) ─────────────────────────

  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;

      if (!account.configured) {
        ctx.log?.info(`[channel-talk:${account.accountId}] skipping — not configured`);
        return;
      }

      ctx.log?.info(`[channel-talk:${account.accountId}] starting webhook listener`);

      // Register this account as a webhook target
      // Build trigger keywords: explicit config or fall back to bot name
      const triggerKeywords = account.config.triggerKeywords
        ?? (account.botName ? [account.botName] : []);

      registerWebhookTarget(account.accountId, {
        accountId: account.accountId,
        creds: account.creds,
        botName: account.botName,
        groupAllowFrom: account.config.groupAllowFrom,
        triggerKeywords,
        cfg: ctx.cfg,
        log: ctx.log ? { info: (m) => ctx.log!.info(m), error: (m) => ctx.log!.info(m) } : undefined,
      });

      // Register this account as a function target
      registerFunctionTarget(account.accountId, {
        accountId: account.accountId,
        creds: account.creds,
        botName: account.botName,
        cfg: ctx.cfg,
        log: ctx.log ? { info: (m) => ctx.log!.info(m), error: (m) => ctx.log!.info(m) } : undefined,
      });

      ctx.setStatus({
        accountId: account.accountId,
        name: account.name,
        enabled: true,
        configured: true,
        running: true,
        lastStartAt: Date.now(),
      });

      ctx.log?.info(
        `[channel-talk:${account.accountId}] ready — webhook: /webhooks/channel-talk/${account.accountId}, function: /functions/channel-talk/${account.accountId}`,
      );

      // Keep alive until abort
      return new Promise<void>((resolve) => {
        ctx.abortSignal.addEventListener("abort", () => {
          unregisterWebhookTarget(account.accountId);
          unregisterFunctionTarget(account.accountId);
          ctx.log?.info(`[channel-talk:${account.accountId}] stopped`);
          resolve();
        });
      });
    },
  },

  // ── Status adapter ──────────────────────────────────────────────

  status: {
    defaultRuntime: {
      accountId: "default",
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },

    probeAccount: async ({ account, timeoutMs }) => {
      if (!account.configured) return { ok: false, error: "not configured" };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs ?? 5000);
      try {
        const result = await getChannel(account.creds);
        clearTimeout(timer);
        return result;
      } catch (err) {
        clearTimeout(timer);
        return { ok: false, error: String(err) };
      }
    },

    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
    }),

    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
  },

  // ── Setup adapter ──────────────────────────────────────────────

  setup: {
    resolveAccountId: ({ accountId }) => accountId ?? "default",

    validateInput: ({ input }) => {
      if (!input.accessKey || !input.accessSecret) {
        return "Channel Talk requires --access-key and --access-secret. Get them from Channel Talk Settings > API Key.";
      }
      return null;
    },

    applyAccountConfig: ({ cfg, accountId, input }) => {
      const id = accountId ?? "default";
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          "channel-talk": {
            ...getChannelSection(cfg),
            enabled: true,
            accounts: {
              ...getAccountsMap(cfg),
              [id]: {
                ...getAccountsMap(cfg)[id],
                enabled: true,
                ...(input.accessKey ? { accessKey: input.accessKey } : {}),
                ...(input.accessSecret ? { accessSecret: input.accessSecret } : {}),
                ...(input.botName ? { botName: input.botName } : {}),
                ...(input.name ? { name: input.name } : {}),
              },
            },
          },
        },
      };
    },
  },
};
