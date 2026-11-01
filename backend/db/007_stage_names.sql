-- 007: let the pipeline record any stage name (the orders stage needs "orders"). Additive in effect: it only removes a
-- restriction. Safe to re-run. Run in the Supabase SQL editor.
-- Until it is run the orders stage still works; the backend just cannot remember that it ran, so it skips that stage
-- on automatic runs after noticing this once per restart.
alter table analysis_stages drop constraint if exists analysis_stages_stage_check;

-- An order whose quantity the customer never stated is stored as unknown, not as 1.
alter table orders alter column quantity drop not null;
