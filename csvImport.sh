#!/bin/bash

CSV_DIR="/home/henrycraig/mlb_pi/data/2024"
DB_NAME="mlb_2024"
DB_USER="mlb"
DB_PASSWORD="password"
source "$HOME/csvkit_env/bin/activate"

# Loop through each CSV file in the directory
for CSV_FILE in "$CSV_DIR"/*.csv; do
  # Extract the table name from the file name
  TABLE_NAME=$(basename "$CSV_FILE" .csv)

  # Preprocess the CSV to remove dollar signs in numeric fields
  sed -i 's/\$//g' "$CSV_FILE"
  
  # Replace "None" with "false" for boolean columns
  sed -i 's/,None,/,false,/g' "$CSV_FILE"

  # Drop the table if it exists to avoid duplicate data issues
  PGPASSWORD=$DB_PASSWORD psql -U "$DB_USER" -d "$DB_NAME" -c "DROP TABLE IF EXISTS \"$TABLE_NAME\";"

  # Use csvsql to generate a CREATE TABLE statement for this CSV file
  CREATE_TABLE_SQL=$(csvsql --dialect postgresql --table "$TABLE_NAME" --snifflimit 100000 "$CSV_FILE")

  # Execute the CREATE TABLE statement in PostgreSQL
  PGPASSWORD=$DB_PASSWORD psql -U "$DB_USER" -d "$DB_NAME" -c "$CREATE_TABLE_SQL"

  # Import the CSV file into the table
  PGPASSWORD=$DB_PASSWORD psql -U "$DB_USER" -d "$DB_NAME" -c "\copy \"$TABLE_NAME\" FROM '$CSV_FILE' WITH (FORMAT csv, HEADER true)"
done


deactivate