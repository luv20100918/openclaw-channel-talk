/**
 * OpenClaw Channel Talk (채널톡) channel plugin.
 *
 * Integrates Channel Talk customer messaging with OpenClaw's AI agent.
 *
 * Setup:
 *   1. Get API credentials from Channel Talk: Settings > API Key > Create
 *   2. Configure in ~/.openclaw/openclaw.json:
 *      channels.channel-talk.accounts.default.accessKey = "YOUR_KEY"
 *      channels.channel-talk.accounts.default.accessSecret = "YOUR_SECRET"
 *   3. Set webhook URL in Channel Talk dashboard:
 *      http://your-host:18789/webhooks/channel-talk/default
 *   4. Restart OpenClaw gateway
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { channelTalkPlugin } from "./src/channel.js";
import { setChannelTalkApi } from "./src/runtime.js";
import { handleChannelTalkWebhook } from "./src/webhook.js";
import { handleChannelTalkFunction } from "./src/function.js";

const plugin = {
  id: "channel-talk",
  name: "Channel Talk",
  description: "Channel Talk (채널톡) customer messaging channel plugin",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    setChannelTalkApi(api);
    api.registerChannel({ plugin: channelTalkPlugin });
    api.registerHttpHandler(handleChannelTalkWebhook);
    api.registerHttpHandler(handleChannelTalkFunction);
  },
};

export default plugin;
