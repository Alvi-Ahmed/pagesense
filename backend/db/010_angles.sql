-- Caption variants: the angle (offer, urgency, answer_first, showcase) and the playbook pattern a draft was written
-- from. They move from the draft to the post when it is published, and the playbook compares angles by median engagement.
alter table post_drafts add column if not exists angle text;
alter table post_drafts add column if not exists pattern jsonb;
alter table posts add column if not exists angle text;
alter table posts add column if not exists pattern jsonb;
