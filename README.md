# ArtI · The Thaislator — API

Backend for **ArtI**, a trilingual (Spanish / English / Thai) travel companion PWA for Thailand.
It runs translation, menu reading, sign reading and text-to-speech behind a beta invite system with
a credit budget.

**Frontend:** [thaislator-pwa](https://github.com/jmfernandezcof/thaislator-pwa) ·
**Live app:** https://eurthai.nomadprompters.es (the AI features are invite-only)

> This is a portfolio project by [Nomad Prompters](https://nomadprompters.es). It is a sanitized
> snapshot of a private repository. Secrets, operational notes and commit history have been removed.

## Endpoints

| Method | Route | Purpose |
|---|---|---|
| POST | `/translate` | Thai ↔ Spanish/English text translation with transliteration and back-translation |
| POST | `/verify` | Blind check of a translation (RTGS transliteration + back-translation + match). It runs separately so it never delays the answer |
| POST | `/translate-image` | Photo of Thai text → OCR → translation |
| POST | `/menu` | Photo of a Thai menu → structured dishes: protein, allergens, spice level, vegan/vegetarian, price and warnings |
| POST | `/vision` | Sign photo → OCR with bounding boxes (Google Vision) → Thai text erased (LaMa inpainting) → translation drawn back onto the image |
| POST | `/tts` · GET `/tts/audio/:file` | Thai speech synthesis, cached by content hash |
| GET | `/rate` | EUR/USD/GBP/THB exchange rates (ECB via Frankfurter), with a 1 h cache and a stale fallback |
| GET | `/weather` | Thai Meteorological Department forecast, cached to respect the upstream rate limit |
| POST | `/invite/status` | Remaining credits for an invite |
| GET | `/health` | Liveness check |

## Design decisions

- **Invite-only AI with a credit ledger.** Each tester gets a personal code with a daily credit
  allowance and an expiry date. A translation costs 1 credit, a menu 3 and a sign 8, and a global
  daily cap limits spending. Codes are shown once; the ledger stores only their hash.
- **Every paid route has layered guards:** a per-route rate limit, an access check (`guardAI`)
  and the budget check (`spendGuard`).
- **GDPR by design:** request logs truncate client IPs to /24. Text for speech travels in the body,
  never in the URL.
- **The right model for each task:** Claude Haiku 4.5 for structured extraction (menus), Typhoon
  (a Thai-specialized LLM) for translation, Google Vision for pixel-accurate OCR boxes, LaMa via
  Replicate for inpainting, and edge-tts for natural Thai voices.
- **Resilience:** external APIs (rates, weather) are cached and fall back to the last known good
  value.

## Stack

Node 24 LTS · Express (ESM) · Anthropic SDK · Typhoon · Google Vision · Replicate · Docker (pinned base image) · Traefik · Cloudflare

## Running locally

```bash
# .env: ANTHROPIC_API_KEY, TYPHOON_API_KEY, GOOGLE_VISION_API_KEY,
#       REPLICATE_API_TOKEN, TMD_API_TOKEN (optional limits: INVITE_DAILY_CREDITS, GLOBAL_DAILY_CREDITS)
docker compose up -d --build
npm test                  # invite store tests (node:test)
```

Invites are managed with `npm run invites -- create "alias" <days> <credits>`, `list` and `revoke <id>`.

## License

© Nomad Prompters. All rights reserved. Shared for portfolio review only.
