# PageSense

An AI marketing analyst for Facebook sellers that learns what works on your own page and creates posts that sell, in your language.

Built for the Meta Global AI Developer Hackathon (Oct 27 – Nov 4, 2026). All code in this repository was written during the hackathon.

## Stack

- **Frontend:** React + Vite + Tailwind (`/web`)
- **Backend:** Node.js + Express (`/backend`)
- **AI:** Meta Model API — Muse Spark 1.3, SAM 3.1, Muse Image
- **Data:** Facebook Graph API

## Setup

```bash
cd backend
cp .env.example .env   # fill in your keys
npm install
npm run dev            # http://localhost:4000/health
```

## Day-1 feasibility tests

```bash
npm run test:banglish                                  # Muse Spark on Banglish comments
npm run test:graph                                     # read posts + comments from your page
npm run test:sam -- tests/images/product.jpg "dress"   # SAM 3.1 finds the product
```
