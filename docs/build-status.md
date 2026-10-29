# PageSense build checklist

Status: DONE / PARTIAL / MISSING. Update this file after each item.

## Backend
1. DONE: Sync: full post history (paging.next), photos, reactions, shares, all comments.
2. DONE: Analysis job: runs after sync; status in DB (queued/running/done/failed, processed, total, error).
3. DONE: Post tagging (muse-spark): product phrase, product type, worn/flat, background, price shown, offer type.
4. DONE: Comment classification (batched): intent (price_question, size_or_color_request,
   stock_or_restock, order_intent, interested, delivery_question, product_question, complaint,
   negotiation, praise, other), plus size and color. Runs as a stage of the analysis job.
   75 comments per request, structured output, lowest reasoning effort. Bulk calls go to Baseten
   (muse-spark-open-1026) when BASETEN_API_KEY is set, else muse-spark-1.3 on the Meta API.
   Demo snapshot now carries intents (npm run demo:save-intents refreshes it from the DB).
5. DONE: Playbook: patterns computed in code from post_tags, engagement and comment intents
   (boosted excluded, groups of 3+ posts only, each labelled with its post count): offer type,
   worn vs flat, price shown, background style, weekday, time of day (Dhaka time). Muse Spark writes
   a headline, 2-4 supporting insights and 3 "Do this next" actions from the computed numbers only;
   any number not in the data is rejected and retried. Cached in playbooks, rebuilt as the last
   analysis stage and whenever a post's boosted flag changes.
   GET /pages/:id/playbook, POST /pages/:id/posts/:postId/boosted, GET /pages/:id/replies.
6. MISSING: Catalog: products from posts (name, sizes, colors, price if mentioned, linked posts),
   editable, status in stock / pre-order / sold out.
7. MISSING: Orders: orders and leads from comments, missing details flagged, owner confirmation.
8. MISSING: Sold-out updates: suggested caption updates for posts featuring a sold-out product.
9. MISSING: Post generation: POST /pages/:id/posts/generate (Bangla/English/Banglish, styled on
   best captions, "why this works", placeholders like [PRICE] for missing facts) and
   POST /pages/:id/posts/improve.
10. MISSING: Branding: product phrase from muse-spark → SAM 3.1 box (fallback "person", then
    "product") → logo and price badge composited with sharp; product pixels never altered.
11. MISSING: Publishing approved posts through the Graph API.
12. PARTIAL: API endpoints for all of the above.

## Frontend (match docs/design/*.png)
13. DONE: App shell, 5-tab bottom nav, analysis progress banner with retry.
14. DONE: Home: "Post this today" card from the playbook, counts from comment intents, "Needs your
    reply" list (complaints and orders first). Replies the seller already sent are not tracked yet.
15. DONE: Playbook screen: headline, strongest pattern with bar comparison, more findings, what
    customers ask before buying, Do this next, "Was this boosted?" toggles, all other patterns.
    Built from the written spec: docs/design/playbook.png is not in the repo, so check it against the mockup.
16. MISSING: Create post screen.
17. MISSING: Orders screen.
18. MISSING: Catalog screen.
19. DONE: Demo mode (anonymized snapshot, same endpoints as real mode).
20. PARTIAL: Loading, empty and error states everywhere.

## Build order for what's left
4 → 5 + 15 → 14 → 9 + 16 → 6 + 18 → 8 → 7 + 17 → 10 → 11 → 20