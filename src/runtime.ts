import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

let pluginApi: OpenClawPluginApi | null = null;

export function setChannelTalkApi(api: OpenClawPluginApi): void {
  pluginApi = api;
}

export function getChannelTalkApi(): OpenClawPluginApi {
  if (!pluginApi) {
    throw new Error("Channel Talk plugin not initialized");
  }
  return pluginApi;
}

export function getRuntime() {
  return getChannelTalkApi().runtime;
}
