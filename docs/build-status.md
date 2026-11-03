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
   default to Baseten (meta-models/muse-spark-open-1026); post generation stays on the Meta API.
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
6. DONE: Catalog. Stage `catalog` of the analysis pipeline (after the playbook; waits for db/006_catalog.sql) reads
   the newest 800 tagged posts (CATALOG_POST_LIMIT) that no product covers yet, asks muse-spark-open (Baseten,
   falls back to muse-spark-1.3) for name, price, sizes, colors and pre-order, and verifies every answer against
   the caption in code: a price, size or color that is not literally written there is dropped, a delivery charge or
   a discount is never a price, pre-order only if the caption says it. Posts showing the same product merge
   (same type, same photo phrase INCLUDING colors with 2+ distinctive words, or a near-copy caption plus a matching
   phrase; differing stated prices keep them apart; boilerplate captions alone merge nothing); a group joins an
   existing product instead of duplicating it, and extraction never overwrites an edit. products + product_posts;
   GET /pages/:id/catalog (list, ?q, ?status), GET/PATCH /catalog/:productId, POST /catalog/:productId/status,
   POST /catalog/merge. 006 adds product_phrase, offer, stock, source (uploaded | extracted), photo_paths, analysis,
   caption_updates and the catalog stage record; until it is run everything still works on the original columns.
8. DONE: Sold-out updates (src/catalogUpdates.js). Marking a product sold out writes, for its newest linked posts
   (5 at a time, "write more" for the rest), a caption update with muse-spark-1.3: the original unchanged plus a
   SOLD OUT line and a pointer to a similar in-stock product from the catalog. Same grounding as generation:
   numbers only from the original or the similar product, no invented prices, no names, original text kept
   (50%+ of its words), a clear sold-out line required. Restock offers "back in stock" versions. The owner copies
   each one; "Update on Facebook" is disabled until item 11. POST/GET /pages/:id/catalog/:productId/updates.
7. DONE: Orders (src/orders.js). Stage `orders` of the pipeline (after classification): one card per comment the
   classifier called order_intent (an order) or interested (a lead), skipping the page's own comments and ones the
   page already answered; the customer's direct replies are attached. Linked to the catalog product through the post.
   Size, color, quantity and address are read from the comment and verified against its text (anything not literally
   stated is dropped, a number after "size" is never a quantity); phone numbers are found by pattern. Missing
   details are flagged (size, quantity, phone, address) and never filled in; quantity is never defaulted to 1. Facebook
   hides who commented, so a card says "Customer on <post>" and keeps the comment id plus a link that opens the
   comment on Facebook. Status to_review -> confirmed -> delivered, or cancelled, owner-controlled and validated
   (a lead must be marked as an order first). "Ask for details" writes a short reply in the customer's language
   (Bangla / Banglish / English, detected from the comment) that asks only for what is missing; checked in code, never
   sent. CSV export of confirmed orders (product, size, color, quantity, comment link, status, date, plus phone and
   address). GET/PATCH /pages/:id/orders, POST .../status, .../convert, .../reply, GET .../orders/export. Orders hold
   customers' details, so a real page proves who is asking on every call (x-access-token). The table keeps its own
   status words (pending/fulfilled) and an unknown quantity is stored as "missing" because orders.quantity is NOT
   NULL; db/007_stage_names.sql lets the pipeline remember the stage and relaxes that constraint. Until it is run the
   stage still works but is skipped on automatic runs after the first check per restart.
8. DONE: Sold-out updates (src/catalogUpdates.js). Marking a product sold out writes, for its newest linked posts
   (5 at a time, "write more" for the rest), a caption update with muse-spark-1.3: the original unchanged plus a
   SOLD OUT line and a pointer to a similar in-stock product from the catalog. Same grounding as generation:
   numbers only from the original or the similar product, no invented prices, no names, original text kept
   (50%+ of its words), a clear sold-out line required. Restock offers "back in stock" versions. The owner copies
   each one; "Update on Facebook" is disabled until item 11. POST/GET /pages/:id/catalog/:productId/updates.
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
   AGENT LOOP (src/agent.js): all generation (existing product, new product, improve) runs as a tool-calling loop on
   muse-spark-1.3 (Meta API format: tools=[{type:function,function:{...}}], tool_choice auto, parallel_tool_calls
   false, full assistant message + role:tool results; response_format is not combined with tools). Read-only
   tools: analyze_photo, get_playbook_patterns, find_similar_products, get_customer_questions (counts only, never
   comment text or names), get_best_captions, check_draft. check_draft runs the same grounding checks as the
   single-call writer; the final caption must be the exact one check_draft passed and is verified again. Max 8
   tool calls per run; hitting the limit or any error falls back to the single-call writer. Every step is logged
   as a JSON line ("agent":true) and returned as `trace` (plain-language steps) with agent_mode agent | fallback.
   Costs about 3x the single call and takes 15-70 s. AGENT_MODE=off switches back to the single call.
   NEW PRODUCT FROM PHOTOS (the main way to create): POST /pages/:id/uploads (1 raw photo, 10 MB max; EXIF and
   location removed with sharp, stored privately in Supabase Storage bucket product-photos, shown through signed
   links), POST /pages/:id/products/analyze (1-5 photos -> muse-spark: product type and phrase, suggested name,
   colors with confidence, style, per-photo worn/flat, background and quality issues, judged like a strict photographer: clutter, collages, glare, cut-off products, and text in the background is never taken as the brand; material and brand are
   only ever "guesses" at low confidence and are stripped from the phrase and name; plus up to 2 photo tips
   computed in code from the playbook's worn/flat and background groups, only groups with 10+ posts and at
   most 10x typical, each with both median engagements and post counts), POST /pages/:id/posts/generate with
   { newProduct: { form, analysis } } (same grounding as above, plus: the owner's price must be written out,
   empty sizes/colors/stock must be placeholders, offers and availability claims only if given, a given
   offer's numbers must appear), POST /pages/:id/products (Save: product into the catalog, draft linked to it).
   Demo: photos go to the server only as base64 to be analysed, are never stored, drafts stay in the tab.
   db/005_new_products.sql adds stock, offer, photo_paths, analysis to products and product_id to post_drafts;
   until it is run, those details are kept in the draft's `why` json.
7b. DONE: Orders come from Messenger chats, not comments (correction to item 7). Customers order in Messenger, so cards are
    now made from chats: src/messages.js reads the page's conversations (Graph API, platform=messenger, newest 150, 30
    messages each; needs the pages_messaging permission, now in the login scopes, so the owner logs in again; in
    Live mode Meta also requires App Review for it). Muse Spark judges each chat (order / lead / none; a product from the
    catalog list, copied exactly or null) and every detail is checked against the CUSTOMER's own lines in code (size,
    color, quantity, address must be literally written; phone by pattern; the phone is taken out of the address; Bangla
    digits and "৩ টা" count). Quantity is still never defaulted. Only chats that are orders or leads are kept (with
    their messages); other chats are remembered by id and time only (conversation_checks) and read again only when they
    change. Chat card: "Customer on Messenger", the last lines of the chat, no comment link. "Check messages" button on
    Orders (POST /orders/sync, read only, nothing is ever sent; real pages only). "Ask for details" now writes a Messenger
    reply to copy. Comment orders are OFF unless ORDERS_FROM_COMMENTS=on (existing comment cards are kept). Orders stage
    version 2; it no longer reruns by itself, "Check messages" does. db/011_message_orders.sql (orders.source, kind,
    conversation_id, conversation; table conversation_checks). Demo: 9 made-up Demo Shop chats (demo/messages.json) go
    through the same reading (npm run demo:messages): 6 orders and 3 leads with missing details flagged; demo statuses
    and edits stay in the tab as before. NOT tested against live Facebook chats: the real page's token has no messaging
    permission yet, the reader reports "log in again and allow access to messages".
9b. DONE: Caption variants (extends 9 + 16; new product and catalog product, via POST /posts/generate, one generation).
    The same agent run writes up to 3 variants, each with an ANGLE (answer_first, showcase, offer, urgency) and a
    different playbook pattern. Angles come from the facts: offer only with a real offer, urgency only when the stock
    count is known and at or under the page's low-stock level (the stock number is then the only count the caption
    may state). Patterns: the playbook's top 5 with 10+ posts and a lift above 1, leaving out weekday and time of day
    (those become "Best time to post"); fewer than 3 qualifying patterns or angles gives fewer variants, none gives
    the usual single caption. Every variant passes check_draft on its own (caption, angle, pattern, reason), then
    the set is checked (distinct angles and patterns, not near-copies). Fallback: the standard writer asked for the
    same set. New checkCaption rules for ALL captions: no engagement bait (asking to comment, like, share or tag to
    get a reply, the price or a reward; English, Banglish and Bangla patterns) and no urgency or deadline claims
    unless stock is really low. Reasons may not promise results or quote percentages. Wording: "Based on what worked
    on your page (N posts)". Create screen: swipeable cards (angle, pattern, reason, caption), "Use this one" makes
    it the draft; best posting time shown when the playbook has one. The chosen variant's angle and pattern are
    stored on the draft (db/010_angles.sql: post_drafts and posts get angle + pattern; before it is run they stay in
    the draft's details). Choosing another variant PATCHes the draft (demo: the tab's draft). Publishing is item 11,
    which must copy angle + pattern from the draft to the post. Playbook screen: once 3+ organic posts carry an
    angle, "Your X posts outperform your Y posts, based on N posts" (median engagement). Existing posts have no
    angle, so this card appears only after posts are published through PageSense.
    Also fixed: saving a new product wrote products.source 'upload' but 006 allows 'uploaded'.
9c. DONE: Several images per post, and an optional link (extends 9 + 10 + 16).
    Before this: 1-5 photos could be uploaded and analysed together for a new product, but they had no order or cover, the
    draft kept only the first, branding handled one photo, there was no link field, and captions could not contain any URL.
    Images: 1-10 per new product (MAX 10 on server and screen). The Create screen lets the seller drag photos (or use the
    arrows), remove, and "Make cover" (the first photo is the cover). Reordering keeps the analysis; photo tips carry the
    image numbers they are about and the screen words them from the CURRENT order ("Image 3 is flat. Your flat photos get ...").
    Saving keeps the order on the draft (why.photos, signed in GET /drafts as photo_urls). Branding (BrandedGallery.jsx):
    POST /branding/detect-many finds the product in EVERY image with Muse Spark + SAM 3.1 (3 at a time, counts as ONE
    generation), each image is rendered on its own boxes with the same settings (logo, format, move logo), so the logo
    never covers the product in any image; the price badge is on the cover only unless "badge on all". "Download all
    (zip)" builds a zip in the browser (src/zip.js, no library), demo included. POST /drafts/:id/branded-many stores
    every branded image in order (draft.branded_url = cover, branding.images = all; GET /drafts returns branded_urls).
    Render limit raised to 1500/hour (every toggle redraws up to 10 images). JSON body limit 24 MB for demo uploads.
    Link: optional "Link" field (new-product form and catalog posts). parseLink: must be a proper https URL (no
    credentials, a dot in the host, no spaces, max 300 chars), stored exactly as entered. "Add Messenger order link"
    fills https://m.me/<page username> (GET /pages/:id/messenger-link, falls back to the page id; demo returns a
    placeholder). The writer is told to put it once in a natural spot ("Order here: <link>"); checkCaption now rejects any
    URL (https, www, m.me) that is not exactly the entered one, a missing or repeated link, and any URL when none was
    given; the link is cut out of the text before numbers, colors and words are checked. The UI says Facebook shows the
    photos, not a link preview, when a post has photos. Variants pass through the same rule. The link is kept on the draft
    (why.link). Not covered: reordering images of an already saved draft; free-text and "improve" posts take no link.
    Publishing (item 11, still MISSING as a feature): facebook.js publishPhotoPost() is written to the Graph API docs
    (each photo POSTed to /{page-id}/photos with published=false, then ONE POST /{page-id}/feed with message and
    attached_media[i]={"media_fbid":"<id>"}; JPEG up to 10 MB; the docs give no photo-count limit, we cap at 10; needs
    pages_manage_posts). It is NOT called from any route and was NOT run against a live page.
10. DONE: Photo branding. Brand settings (header menu): shop name, brand color, logo upload (PNG, or SVG which is
    checked then rasterised; a logo on a white box gets the white keyed out) or "Generate a logo" (muse-image-1.0,
    wordmark or icon + name, 3 options, each read back by Muse Spark to confirm the spelling). Stored in the
    `brand-assets` bucket (created on demand), brand details in pages.brand (db/009_brand.sql, also adds
    post_drafts.branded_url / branding).
    Engine (backend/src/branding.js): Muse Spark gives the product phrase (+ worn or flat) → SAM 3.1 boxes
    (/v1/responses; phrase → "person" → "product"; worn photos add "person"; cached per photo) → in code, boxes
    inflated 2.5%, 3% safe margin, candidate regions = largest empty rectangle at each of 4 corners + top/bottom
    bands → logo 12–15% of width, light/dark/original version by background contrast → sharp composite, price badge
    (price + offer, text drawn as paths from bundled Inter Bold, no server fonts) in the next free region. No room →
    8% logo in the quietest corner and a note to the user. Square 1080×1080 / portrait 1080×1350, padded with a
    blurred copy of the photo (never cropped). Product pixels are only resized, never redrawn.
    API: GET/PUT /pages/:id/brand, POST brand/logo/{process,generate,save}, POST branding/{detect,render},
    POST drafts/:draftId/branded (stores the image, links it to the draft; drafts list returns branded_url).
    Create screens: branded preview with Logo on/off, Price badge on/off, Square/Portrait, Move logo, Download image,
    "Keep with this draft"; no logo yet shows a prompt to open Brand settings.
    Demo: brand and result stay in the tab (sessionStorage), nothing is written, generation calls are rate limited
    (20/hour) and renders 400/hour. Demo can brand an uploaded photo (New product), not existing page posts.
    Known limits: when the product fills a square frame the logo drops to the small fallback with a note (portrait
    has padding room); busy collages leave no room for the badge; SAM boxes vary a little between runs; the
    panel/preview UI was checked by lint + build, the API flows against a real page and the demo endpoints.
11. MISSING: Publishing approved posts through the Graph API.
12. PARTIAL: API endpoints for all of the above (done through item 9).

## Frontend (match docs/design/*.png)
13. DONE: App shell, 5-tab bottom nav, analysis progress banner with retry.
14. DONE: Home: "Post this today" card from the playbook (with "Create this post"), "Continue your draft" card for the
    latest draft, counts from comment intents that match their lists (possible orders opens Orders; price questions and
    complaints filter the "Needs your reply" list, with "Show all" to clear), each reply links to its comment on
    Facebook, and the list shows comments the page has not answered. The demo has no Facebook ids, so no links there.
15. DONE: Playbook screen: headline, strongest pattern with bar comparison, more findings, what
    customers ask before buying, Do this next, "Was this boosted?" toggles, all other patterns.
    Built from the written spec: docs/design/playbook.png is not in the repo, so check it against the mockup.
16. DONE: Create screen. Primary flow: upload 1-5 photos of a NEW product -> what we see + photo tips -> short
    details form prefilled with AI guesses (only price required) -> caption -> Save product and draft.
    Secondary: "post about a product you already sell": product picker (from tags) or describe it yourself, language toggle that regenerates,
    editable caption, placeholders highlighted with inline fields to fill them, why-this-works chips, Regenerate,
    Copy caption, Schedule / Post to page disabled with a coming-soon note (item 11). "Improve this post" on the
    Playbook's weakest recent posts; collapsible "How this post was made" shows the agent's steps; Home's "Create this post" prefills the playbook suggestion; drafts on Home.
    Built from the written spec: docs/design/create.png is not in the repo. The branded photo preview is item 10.
17. DONE: Orders screen: tabs To review / Confirmed / Delivered with counts (Cancelled shown when there are any); order
    cards with product, size, quantity, color, phone, address, the original comment and the customer's replies, the
    missing-details warning, Open comment, Ask for details (suggested reply with Copy), Edit, Confirm / Undo, Mark
    delivered, Cancel. Leads are dashed and blue with "Mark as order". Export button on the Confirmed tab. Built from
    the written spec: docs/design/orders.png is not in the repo. Demo: read-only on the server; status changes, edits
    and "mark as order" stay in the tab, the CSV is built in the browser, suggested replies still come from the model
    (rate limited). The demo data has no comments that ask to buy, so its Orders screen is empty.
18. DONE: Catalog screen: search, status filters (All / In stock / Pre-order / Sold out / No price), rows with the
    linked post's photo, status chip and post count, the missing-price warning ("X products have no price. Add a
    price once and every new post uses it."), a product panel to edit details, mark sold out / restock, switch
    pre-order, merge a duplicate and review caption updates. Create's "existing product" picker now uses the catalog
    (a known price must be written, empty facts become placeholders). Built from the written spec: docs/design/
    catalog.png is not in the repo. Demo: the catalog is read-only on the server; a visitor's edits, status changes,
    merges and suggestions stay in the tab (sessionStorage); suggestions are still written by the model, rate limited.
19. DONE: Demo mode (anonymized snapshot, same endpoints as real mode, read-only). Snapshot: newest 150
    posts, names replaced by "Customer N" (npm run demo:scan checks for leftovers), author/parent fields so
    answered comments are left out of "Needs your reply". Refresh: demo:export, demo:seed -- --reset,
    demo:analyze, demo:save-analysis.
20. PARTIAL: Loading, empty and error states everywhere.

21. DONE: Excel stock import (src/stock.js). Upload .xlsx or .csv (5 MB, parsed with SheetJS 0.20.3 installed from
    cdn.sheetjs.com because the npm "xlsx" 0.18.5 has known vulnerabilities when reading crafted files), sheet picker,
    title rows, blank rows, totals rows and merged cells handled. muse-spark-1.3 maps the header row and 5 sample rows
    to name / size / color / quantity / price / SKU (Bangla, Banglish or English headers; a blank merged header is read
    from the data) and the answer is checked against the data; the owner fixes the mapping with dropdowns. Products
    are matched to the catalog by name (letter-pair similarity), by code, and, for close calls and Bangla names, by
    muse-spark-open on Baseten choosing only among candidates shown to it; confident matches apply, "probably" ones
    show their %, doubtful ones must be confirmed, unmatched rows can create new products. Nothing is saved until the
    owner confirms. Stock per variant (product + size + color) in stock_variants (db/008_stock.sql); an import sets
    quantities, never overwrites an owner's price, and fills the product's stock total. Confirming an order takes its
    quantity from the matching variant (unknown quantity or ambiguous size: nothing is guessed, the owner is told),
    undoing or cancelling puts back exactly what was taken (stock_moves). Stock 0 marks the product sold_out (item 8
    suggestions are then available), stock coming back restocks it. Low stock (default 3, set per page) shows on Home
    with a "few left" post that may say "limited stock" only because the count is known. Stock can be edited per
    variant on the Catalog screen. "Download as Excel" returns current stock in the owner's own headers and column
    order (saved from the last import). Demo: the sample file public/sample-stock.xlsx (Banglish headers); preview and
    download run on the server but the confirmed import and every edit stay in the visitor's tab; Home stock alerts
    and order-driven stock changes are real-page only.

## Build order for what's left
4 → 5 + 15 → 14 → 9 + 16 → 6 + 18 → 8 → 7 + 17 → 10 → 11 → 20

Known: the hackathon Baseten key only works with the model id meta-models/muse-spark-open-1026 (the plain
muse-spark-open id returns 403); the default is set to it. Demo post photos are Facebook image links and some show the real shop's name, phone number and website
printed in the image itself. demo:scan checks text only.

Login: Facebook's own login token lasts about an hour, so after the owner proves they manage a page the backend issues
its own signed page session (src/session.js: HMAC with a key derived from FB_APP_SECRET, one page, 24 hours, checked
without calling Facebook). The app sends that instead. When a login does expire (our session, or Facebook error 190 on an
older tab) the API answers 401 code session_expired and the app returns to the login screen with an explanation.
