-- Rental dates are fixed at first write.
--
-- persist-rental merge-upserts every number.online re-delivery with that
-- delivery's date, which moved already invoiced rentals into the next week's
-- invoice (165 TrustOTP rentals billed on invoice 1458 were re-dated to
-- 10-02..10-04). The trigger below keeps the first date.

-- Put the re-dated rentals back on their EST mint day (all minted before
-- invoice 1458 was created, so all already billed or in a closed week).
UPDATE rentals SET rental_date = (minted_at AT TIME ZONE 'America/New_York')::date
WHERE reseller_id = 3 AND rental_date >= '2026-10-02' AND minted_at < '2026-10-01 17:01:21.8+00';

CREATE OR REPLACE FUNCTION rentals_keep_rental_date() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.rental_date := OLD.rental_date;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_rentals_keep_rental_date ON rentals;
CREATE TRIGGER trg_rentals_keep_rental_date
  BEFORE UPDATE OF rental_date ON rentals
  FOR EACH ROW EXECUTE FUNCTION rentals_keep_rental_date();
