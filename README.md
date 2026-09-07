# GemRouter

A lightweight, high-throughput backend router for Gemini API traffic. GemRouter exposes OpenAI-, DeepSeek-, and Ollama-compatible endpoints, pooling multiple Gemini API keys with automatic fallback, project-level quota tracking, rate limit management, and multi-tenant key isolation.

## Features

- **Multi-Account Pooling & Load Balancing**: Aggregates multiple Gemini API keys to maximize available free-tier and Tier 1 quota.
- **Ordered Fallback Cascade**: Graceful degradation across models (`gemini-3.8-flash` → `gemini-3.7-flash` → `gemini-3.6-flash` → `gemini-3.5-flash` → `gemini-3.5-flash-lite`).
- **Quota & Cooldown Ledger**: Tracks RPM, TPM, and RPD locally per project/quota group, with Pacific midnight resets and automatic 429/503 cooldown handling.
- **Tenant Isolation**: Secure user accounts with personal Gemini key pools separate from system/admin keys.
- **Admin Dashboard**: Web UI at `/admin` for live quota monitoring, account management, interaction logs, and key generation.

## Quick Start

```bash
# Install dependencies
pnpm install

# Configure environment
cp .env.example .env

# Build and start
pnpm build
pnpm start
```

Default port is `4024`. Check health:
```bash
curl -fsS http://127.0.0.1:4024/health
```

## Credits & Acknowledgments

Originally created by [0xfunboy (funboy)](https://github.com/0xfunboy/GemRouterFE).
