# PageSense build checklist

Status: DONE / PARTIAL / MISSING. Update this file after each item.

## Backend
1. DONE: Sync: full post history (paging.next), photos, reactions, shares, all comments. Also records who wrote
   each comment (is_page), its parent and whether the page answered it. Needs db/003_comment_authors.sql
   run in Supabase and a re-sync; until then nothing is marked answered.
2. DONE: Analysis job, stage-aware. Stages: tagging, classification, playbook, each with a version in
   src/analysis.js and a row per page in analysis_stages (db/004_analysis_stages.sql). A stage runs when it has
   no record (on missing items only), is on an older version (on every item again), or new posts/comments arrived
   since it completed; the playbook is rebuilt whenever an earlier stage did work. Triggered when a page is
   opened (POST /pages/:id/analysis), when the backend starts, and after every sync. "Re-analyse" in the header
   menu sends { force: true }: every stage, every item. Job status in DB (queued/running/done/failed,
   processed/total across stages, error). Without migration 004 it falls back to "run whatever is missing".
   The demo is read-only: startAnalysis never creates a job for it. Real page "Mega Genie": synced in full
   (authors recorded), tagged, 2,625 of 11,928 customer comments classified, then stopped by the owner; the
   stage is recorded complete so only comments that arrive later are classified. Re-analyse does the rest.
3. DONE: Post tagging (muse-spark): product phrase, product type, worn/flat, background, price shown, offer type.
4. DONE: Comment classification (batched): intent (price_question, size_or_color_request,
   stock_or_restock, order_intent, interested, delivery_question, product_question, complaint,
   negotiation, praise, other), plus size and color. Runs as a stage of the analysis job.
   75 comments per request, structured output, lowest reasoning effort. Bulk tasks
   default to Baseten (meta-models/muse-spark-open); post generation stays on the Meta API.
   Provider layer: src/ai.js maps each task to a provider (BULK_PROVIDER, default baseten, or PROVIDER_<TASK>);
   a failing Baseten call falls back to muse-spark-1.3 and is logged.
   Demo snapshot carries tags, intents and the playbook (npm run demo:save-analysis refreshes it).
   The page's own comments are not classified. npm run test:compare compares providers on the demo comments.
5. DONE: Playbook: patterns computed in code from post_tags, engagement and comment intents
   (boosted excluded, groups of 3+ posts only, each labelled with its post count): offer type,
   worn vs flat, price shown, background style, weekday, time of day (Dhaka time). Groups are compared on
   MEDIAN engagement; the headline is the group with the best lift x sqrt(posts), needing 10+ posts.
   Price shown vs not is always computed; when over 20% of comments ask the price, the first
   "Do this next" action (written in code, with the numbers) is to show the price in every post.
   Muse Spark writes the headline, 2-4 supporting insights and the other actions from the computed numbers
   only; any number not in the data is rejected and retried. Cached in playbooks, rebuilt as the last
   analysis stage and whenever a post's boosted flag changes.
   GET /pages/:id/playbook, POST /pages/:id/posts/:postId/boosted, GET /pages/:id/replies.
   Also lists the 5 weakest recent posts (weakest_posts) for "Improve this post".
   Demo mode is read-only: boosted toggles stay in the visitor's tab and POST /pages/demo/playbook/preview
   computes the result in memory. Demo tag/analysis/boosted writes are refused.
   Sanity guard: a pattern needs 10+ posts and at most 10x the typical post to be the headline; anything
   stronger or thinner is listed as "unusual, worth checking". Lifts are written in plain words
   ("about twice the engagement of your typical post"), never as raw percentages or "105.8 times".
6. MISSING: Catalog: products from posts (name, sizes, colors, price if mentioned, linked posts),
   editable, status in stock / pre-order / sold out.
7. MISSING: Orders: orders and leads from comments, missing details flagged, owner confirmation.
8. MISSING: Sold-out updates: suggested caption updates for posts featuring a sold-out product.
9. DONE: Post generation. POST /pages/:id/posts/generate (product from post_tags or free text; bangla |
   english | banglish) and POST /pages/:id/posts/improve (existing post or pasted caption), muse-spark-1.3.
   The model gets the playbook's patterns and actions, 5 of the page's best captions as style (top 2% viral
   posts skipped, boosted excluded, contacts and person names removed) and only the product facts the photo tags
   give. Returns caption, "why this works" (each reason cites a playbook pattern and must mention it) or
   "what changed and why", and the patterns used. Enforced in code, rejected and retried up to 3 times:
   unknown facts only as [PRICE] [SIZES] [COLORS] [DELIVERY CHARGE] [STOCK]; every number must come from the
   product facts; no invented sizes, colors, free delivery, refund/exchange policies; price or [PRICE] when 20%+
   of comments ask the price; no links, @mentions, markdown or person names; right script for the language.
   No comment text is ever sent to the model (only aggregate counts from the playbook).
   Drafts: real pages store them in post_drafts (details in its `why` jsonb, no new migration);
   GET /pages/:id/drafts, PATCH /pages/:id/drafts/:id. Demo: generation allowed, 20 per visitor per hour
   (429 after that), drafts stay in the visitor's tab, nothing is written to the database.
   NEW PRODUCT FROM PHOTOS (the main way to create): POST /pages/:id/uploads (1 raw photo, 10 MB max; EXIF and
   location removed with sharp, stored privately in Supabase Storage bucket product-photos, shown through signed
   links), POST /pages/:id/products/analyze (1-5 photos -> muse-spark: product type and phrase, suggested name,
   colors with confidence, style, per-photo worn/flat, background and quality issues; material and brand are
   only ever "guesses" at low confidence and are stripped from the phrase and name; plus up to 2 photo tips
   computed in code from the playbook's worn/flat and background groups, only groups with 10+ posts and at
   most 10x typical, each with both median engagements and post counts), POST /pages/:id/posts/generate with
   { newProduct: { form, analysis } } (same grounding as above, plus: the owner's price must be written out,
   empty sizes/colors/stock must be placeholders, offers and availability claims only if given, a given
   offer's numbers must appear), POST /pages/:id/products (Save: product into the catalog, draft linked to it).
   Demo: photos go to the server only as base64 to be analysed, are never stored, drafts stay in the tab.
   db/005_new_products.sql adds stock, offer, photo_paths, analysis to products and product_id to post_drafts;
   until it is run, those details are kept in the draft's `why` json.
10. MISSING: Branding: product phrase from muse-spark → SAM 3.1 box (fallback "person", then
    "product") → logo and price badge composited with sharp; product pixels never altered.
11. MISSING: Publishing approved posts through the Graph API.
12. PARTIAL: API endpoints for all of the above (done through item 9).

## Frontend (match docs/design/*.png)
13. DONE: App shell, 5-tab bottom nav, analysis progress banner with retry.
14. DONE: Home: "Post this today" card from the playbook (with "Create this post"), drafts, counts from comment intents, "Needs your
    reply" list (complaints and orders first; comments the page already answered are left out once the
    sync has recorded authors, see item 1). The demo has no author data, so it cannot mark answered.
15. DONE: Playbook screen: headline, strongest pattern with bar comparison, more findings, what
    customers ask before buying, Do this next, "Was this boosted?" toggles, all other patterns.
    Built from the written spec: docs/design/playbook.png is not in the repo, so check it against the mockup.
16. DONE: Create screen. Primary flow: upload 1-5 photos of a NEW product -> what we see + photo tips -> short
    details form prefilled with AI guesses (only price required) -> caption -> Save product and draft.
    Secondary: "post about a product you already sell": product picker (from tags) or describe it yourself, language toggle that regenerates,
    editable caption, placeholders highlighted with inline fields to fill them, why-this-works chips, Regenerate,
    Copy caption, Schedule / Post to page disabled with a coming-soon note (item 11). "Improve this post" on the
    Playbook's weakest recent posts; Home's "Create this post" prefills the playbook suggestion; drafts on Home.
    Built from the written spec: docs/design/create.png is not in the repo. Branded photo comes with item 10.
17. MISSING: Orders screen.
18. MISSING: Catalog screen.
19. DONE: Demo mode (anonymized snapshot, same endpoints as real mode, read-only). Snapshot: newest 150
    posts, names replaced by "Customer N" (npm run demo:scan checks for leftovers), author/parent fields so
    answered comments are left out of "Needs your reply". Refresh: demo:export, demo:seed -- --reset,
    demo:analyze, demo:save-analysis.
20. PARTIAL: Loading, empty and error states everywhere.

## Build order for what's left
4 → 5 + 15 → 14 → 9 + 16 → 6 + 18 → 8 → 7 + 17 → 10 → 11 → 20

Known: demo post photos are Facebook image links and some show the real shop's name, phone number and website
printed in the image itself. demo:scan checks text only.
