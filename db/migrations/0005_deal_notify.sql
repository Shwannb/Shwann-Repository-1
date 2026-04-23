-- Postgres LISTEN/NOTIFY channel for live deal pushes.
-- Fires on every insert into deals with a compact JSON payload — the WS
-- server (workers/ws.ts) LISTENs and fans the payload out to connected
-- browser clients.
--
-- NOTIFY payload size limit is 8000 bytes; we send only the deal id + a few
-- tags for the terminal's filter match. Full detail is fetched via
-- /api/deals when a client wants it.

CREATE OR REPLACE FUNCTION safyr_notify_new_deal() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    'deals_new',
    json_build_object(
      'id',            NEW.id,
      'headline',      NEW.headline,
      'sector',        NEW.sector,
      'geography',     NEW.geography,
      'deal_type',     NEW.deal_type,
      'deal_size_usd', NEW.deal_size_usd,
      'announced_at',  NEW.announced_at
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS safyr_notify_new_deal_trg ON deals;
CREATE TRIGGER safyr_notify_new_deal_trg
  AFTER INSERT ON deals
  FOR EACH ROW
  EXECUTE FUNCTION safyr_notify_new_deal();
