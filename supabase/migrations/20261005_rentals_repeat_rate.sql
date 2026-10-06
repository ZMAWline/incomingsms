-- Repeat rentals: a number the reseller has held before.
--
-- When we send number.online for a number the reseller already had, the
-- reseller's system answers with the rentalId it gave that number the first
-- time instead of minting a new one. Those rentals are billed at a separate,
-- lower rate when one is configured (TrustOTP agreed $1.00 for T-Mobile
-- repeats from 2026-09-11, against $1.55 for new numbers).
--
-- rentals.is_repeat: true when an earlier-minted rental for the same reseller
-- already carries this reseller_rental_id. Set by trigger on every write path
-- (upsertRental insert, persist-rental merge-upsert), ordered by
-- (minted_at, id) so the first lifetime stays the original even when a later
-- write re-sends the same id.
--
-- reseller_rental_rates.repeat_only: the rate applies only to repeat rentals.
-- Repeat rentals with no repeat_only rate for their carrier/date are priced
-- like new rentals.

ALTER TABLE rentals ADD COLUMN IF NOT EXISTS is_repeat BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_rentals_reseller_rental_id ON rentals (reseller_id, reseller_rental_id);

CREATE OR REPLACE FUNCTION rentals_set_is_repeat() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.is_repeat := NEW.reseller_rental_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM rentals r
    WHERE r.reseller_id = NEW.reseller_id
      AND r.reseller_rental_id = NEW.reseller_rental_id
      AND r.id <> NEW.id
      AND (r.minted_at, r.id) < (NEW.minted_at, NEW.id)
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_rentals_is_repeat ON rentals;
CREATE TRIGGER trg_rentals_is_repeat
  BEFORE INSERT OR UPDATE OF reseller_rental_id, minted_at ON rentals
  FOR EACH ROW EXECUTE FUNCTION rentals_set_is_repeat();

UPDATE rentals r SET is_repeat = true
FROM (
  SELECT id, row_number() OVER (PARTITION BY reseller_id, reseller_rental_id ORDER BY minted_at, id) AS n
  FROM rentals WHERE reseller_rental_id IS NOT NULL
) o
WHERE r.id = o.id AND o.n > 1 AND r.is_repeat = false;

ALTER TABLE reseller_rental_rates ADD COLUMN IF NOT EXISTS repeat_only BOOLEAN NOT NULL DEFAULT false;

-- TrustOTP (reseller 3): T-Mobile repeats at $1.00 from 2026-09-11 (owner + TrustOTP agreed 2026-10-05).
INSERT INTO reseller_rental_rates (reseller_id, carrier, effective_from, rate, repeat_only, notes)
SELECT 3, 'tmobile', '2026-09-11', 1.00, true, 'Repeat numbers (held before), agreed with TrustOTP 2026-10-05'
WHERE NOT EXISTS (
  SELECT 1 FROM reseller_rental_rates WHERE reseller_id = 3 AND carrier = 'tmobile' AND repeat_only
);
