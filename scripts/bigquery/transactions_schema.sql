-- BigQuery Schema for MLB Transactions Historical Data
-- Create this table in your BigQuery dataset for storing historical transactions

CREATE TABLE IF NOT EXISTS `hanks_tank.transactions_historical` (
  year INT64 NOT NULL,
  transaction_id INT64,
  date STRING NOT NULL,
  type_code STRING,
  type_desc STRING,
  description STRING,
  from_team_id INT64,
  from_team_name STRING,
  from_team_abbreviation STRING,
  to_team_id INT64,
  to_team_name STRING,
  to_team_abbreviation STRING,
  person_id INT64 NOT NULL,
  person_full_name STRING NOT NULL,
  person_link STRING,
  resolution STRING,
  notes STRING,
  synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP()
)
PARTITION BY RANGE_BUCKET(year, GENERATE_ARRAY(2015, 2030, 1))
CLUSTER BY year, date, person_id
OPTIONS(
  description="MLB transactions historical data (2015-2025+)",
  labels=[("data_type", "transactions"), ("sport", "mlb")]
);

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_transactions_date 
ON `hanks_tank.transactions_historical`(date);

CREATE INDEX IF NOT EXISTS idx_transactions_person 
ON `hanks_tank.transactions_historical`(person_id);

CREATE INDEX IF NOT EXISTS idx_transactions_team_from 
ON `hanks_tank.transactions_historical`(from_team_id);

CREATE INDEX IF NOT EXISTS idx_transactions_team_to 
ON `hanks_tank.transactions_historical`(to_team_id);

-- Sample queries for testing

-- Get all transactions for Atlanta Braves (team_id = 144)
-- SELECT * FROM `hanks_tank.transactions_historical`
-- WHERE from_team_id = 144 OR to_team_id = 144
-- ORDER BY date DESC
-- LIMIT 100;

-- Get transactions by type
-- SELECT type_desc, COUNT(*) as count
-- FROM `hanks_tank.transactions_historical`
-- WHERE year = 2025
-- GROUP BY type_desc
-- ORDER BY count DESC;

-- Get player transaction history
-- SELECT date, type_desc, description, from_team_name, to_team_name
-- FROM `hanks_tank.transactions_historical`
-- WHERE person_id = 660271  -- Ronald Acuña Jr.
-- ORDER BY date DESC;
