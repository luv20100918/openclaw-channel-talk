# OpenClaw Channel Talk Extension

[![npm version](https://img.shields.io/npm/v/@luv20100918/openclaw-channel-talk.svg)](https://www.npmjs.com/package/@luv20100918/openclaw-channel-talk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Channel Talk (채널톡) integration for OpenClaw - Connect your AI assistant to Channel Talk team chats and customer conversations.

## Features

- ✅ Receive and respond to Channel Talk messages
- ✅ Support for both team chat (group) and customer chat (userChat)
- ✅ Keyword-based bot triggering in group chats
- ✅ Built-in pairing system for access control
- ✅ Function (Command) endpoint support
- ✅ Webhook endpoint support
- ✅ Full TypeScript support

## Installation

```bash
cd ~/.openclaw/extensions
git clone https://github.com/luv20100918/openclaw-channel-talk channel-talk
cd channel-talk
npm install
```

Or install via npm:

```bash
npm install @luv20100918/openclaw-channel-talk
```

## Configuration

### 1. Get Channel Talk API Credentials

1. Go to Channel Talk Settings → API
2. Create a new API Key
3. Copy your Access Key and Access Secret

### 2. Configure OpenClaw

Add to `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "channel-talk": {
      "enabled": true,
      "accounts": {
        "default": {
          "enabled": true,
          "accessKey": "YOUR_ACCESS_KEY",
          "accessSecret": "YOUR_ACCESS_SECRET",
          "botName": "Your Bot Name",
          "dmPolicy": "pairing",
          "allowFrom": [],
          "triggerKeywords": ["봇", "AI"]
        }
      }
    }
  }
}
```

Or use the CLI:

```bash
openclaw config set channels.channel-talk.enabled true
openclaw config set channels.channel-talk.accounts.default.accessKey "YOUR_KEY"
openclaw config set channels.channel-talk.accounts.default.accessSecret "YOUR_SECRET"
openclaw config set channels.channel-talk.accounts.default.botName "Your Bot Name"
```

### 3. Set up Channel Talk Webhooks

#### Webhook Endpoint (for messages)
- URL: `http://YOUR_SERVER:18789/webhooks/channel-talk/default`
- Method: POST

> ⚠️ **Note:** The Channel Talk Webhook method may not work reliably in many cases. It appears to be primarily designed for customer support scenarios. **For team internal chat bot usage, we recommend using the Function (Command) method below.**

#### Function Endpoint (for commands) - Recommended
1. Go to Channel Talk → App Store → Custom Function
2. Create a new function
3. Function URL: `http://YOUR_SERVER:18789/functions/channel-talk/default`
4. Method: PUT

**For production:** Use Tailscale or ngrok to expose your local OpenClaw gateway securely.

## Usage

### Pairing System

The extension uses OpenClaw's built-in pairing system for access control:

1. User sends a message → Receives pairing code
2. Bot owner approves: `openclaw pairing approve channel-talk <code>`
3. User can now interact with the bot

```bash
# List pending pairing requests
openclaw pairing list channel-talk

# Approve a request
openclaw pairing approve channel-talk ABC123XY
```

### Group Chat (Team Chat)

By default, the bot only responds in group chats when triggered by keywords:

```json
{
  "triggerKeywords": ["봇", "AI", "@assistant"]
}
```

To respond to all messages in specific groups:

```json
{
  "groupAllowFrom": ["540639", "123456"]
}
```

### Sending Messages

From OpenClaw CLI or skills:

```bash
# Send to group chat
openclaw message channel-talk:@GroupName "Hello team!"
openclaw message channel-talk:540639 "Hello team!"

# Send to user chat
openclaw message channel-talk:userChatId "Hello!"
```

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable/disable the extension |
| `accessKey` | string | - | Channel Talk API access key |
| `accessSecret` | string | - | Channel Talk API access secret |
| `botName` | string | - | Bot display name in Channel Talk |
| `dmPolicy` | string | `"pairing"` | Access control: `"open"`, `"pairing"`, `"allowlist"`, `"disabled"` |
| `allowFrom` | string[] | `[]` | List of allowed user IDs (for allowlist mode) |
| `groupAllowFrom` | string[] | `[]` | Group IDs where bot can respond to all messages |
| `triggerKeywords` | string[] | `[botName]` | Keywords that trigger bot in group chats |

## Development

```bash
# Clone the repository
git clone https://github.com/luv20100918/openclaw-channel-talk
cd openclaw-channel-talk

# Install dependencies
npm install

# The extension will be automatically loaded by OpenClaw
# Restart OpenClaw gateway to reload changes
pkill openclaw-gateway
```

## Architecture

```
channel-talk/
├── src/
│   ├── api.ts          # Channel Talk REST API client
│   ├── channel.ts      # OpenClaw ChannelPlugin implementation
│   ├── webhook.ts      # Webhook handler for incoming messages
│   ├── function.ts     # Function/Command handler
│   ├── runtime.ts      # Runtime context management
│   └── pairing.ts      # (deprecated, using OpenClaw SDK)
├── index.ts            # Entry point
└── package.json
```

## Troubleshooting

### Messages not received

1. Check webhook URL is accessible from Channel Talk servers
2. Verify API credentials are correct
3. Check OpenClaw gateway logs: `tail -f /tmp/openclaw/openclaw-*.log`

### Pairing not working

1. Ensure `dmPolicy` is set to `"pairing"`
2. Check pairing requests: `openclaw pairing list channel-talk`
3. Approve requests: `openclaw pairing approve channel-talk <code>`

### Bot not responding in group chat

1. Check `triggerKeywords` configuration
2. Verify user is approved (pairing system still applies to group chats)
3. Check if group ID is in `groupAllowFrom` (if specified)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

MIT License - see [LICENSE](LICENSE) file for details

## Links

- [OpenClaw Documentation](https://docs.openclaw.ai)
- [Channel Talk API Documentation](https://developers.channel.io)
- [Issues](https://github.com/luv20100918/openclaw-channel-talk/issues)

## Author

Created by [luv20100918](https://github.com/luv20100918)

---

Made with 🦞 for OpenClaw
