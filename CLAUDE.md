# PageSense — Meta Global AI Developer Hackathon (Oct 27 – Nov 4, 2026)

AI marketing analyst for small businesses that sell through Facebook pages.
Learns what sells from a page's posts, photos and comments; builds a product
catalog; captures orders from comments; brands photos; writes new posts in the
seller's voice and language (Bangla, English, Banglish).

## Stack
- web/: React + Vite + Tailwind, mobile-first (deployed on Vercel)
- backend/: Node 22 + Express, ES modules (deployed on Render)
- Database: Supabase Postgres
- AI: Meta Model API via OpenAI SDK, baseURL https://api.meta.ai/v1
  - muse-spark-1.3: tagging, classification, analysis, post writing
  - sam-3.1: product boxes for logo placement (parse <|box;...|> tokens)
  - muse-image-1.0: logo generation only — never redraw product photos
- Facebook Graph API v26.0 for page data and publishing

## Hard rules
- All AI features in the product must use Meta models only. No other AI providers.
- Repo is public: never commit secrets. All keys live in .env files.
- Owner approves everything before it reaches customers or spends money.
  No auto-replies, no auto-boosting.
- Product pixels are never altered; branding is composited with sharp.
- Keep it simple and working over clever. Small commits with clear messages.

## Learnings
- SAM 3.1 needs a good noun phrase; get it from Muse Spark first, fall back to "person", then "product".
- Muse Spark classification is accurate but reasoning-heavy: batch 50–100 items, use structured output, use the lowest reasoning effort.
- Comments are sparse on some pages; always paginate the full history.