-- QuickBooks Online integration tables

-- Customer mapping: link Supabase entities to QBO customers
CREATE TABLE qbo_customer_map (
  id SERIAL PRIMARY KEY,
  reseller_id INT REFERENCES resellers(id),
  customer_name TEXT,              -- local display name (for non-reseller customers)
  qbo_customer_id TEXT NOT NULL,   -- QBO Customer.Id
  qbo_display_name TEXT NOT NULL,  -- QBO DisplayName (cached for UI)
  daily_rate NUMERIC(8,4) NOT NULL DEFAULT 0.50,  -- $/SIM/day
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Track generated invoices
CREATE TABLE qbo_invoices (
  id SERIAL PRIMARY KEY,
  qbo_customer_map_id INT REFERENCES qbo_customer_map(id),
  qbo_invoice_id TEXT,            -- QBO Invoice.Id after creation
  week_start DATE NOT NULL,
  week_end DATE NOT NULL,
  sim_count INT NOT NULL,
  total NUMERIC(10,2) NOT NULL,
  status TEXT DEFAULT 'draft',     -- draft | sent | paid | error
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(qbo_customer_map_id, week_start)
);
