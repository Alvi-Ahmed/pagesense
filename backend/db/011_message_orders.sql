-- 011: orders come from Messenger chats, not from comments. An order or lead found in a chat keeps the chat's messages
-- (only chats that are orders or leads are kept) and the chat id; conversation_checks remembers which chats were already
-- read (ids and times only, no text) so the same chat is not read again until it changes. Safe to re-run.
alter table orders add column if not exists source text not null default 'comment';
alter table orders add column if not exists kind text;                -- 'order' | 'lead' for chat orders (comment orders take it from the comment)
alter table orders add column if not exists conversation_id text;
alter table orders add column if not exists conversation jsonb;       -- [{ from: 'customer' | 'page', text, at }]
create unique index if not exists orders_conversation_idx on orders (page_id, conversation_id) where conversation_id is not null;

create table if not exists conversation_checks (
  page_id         text not null references pages(id) on delete cascade,
  conversation_id text not null,
  updated_time    timestamptz,
  primary key (page_id, conversation_id)
);
alter table conversation_checks enable row level security;
