require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const fs = require('fs');
const app = express();
const port = process.env.PORT || 3000;

app.use(cors()); // Enable CORS for all routes and origins

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

// Test endpoint
app.get('/', (req, res) => {
    res.send('Express backend is running!');
});

// Generic function to fetch data based on year and table name
async function fetchDataFromTable(req, res, tableNamePrefix) {
  const year = req.query.year || '2024'; // Default to 2023 if no year is provided
  const tableName = `"${tableNamePrefix}_${year}"`; // Construct table name
  try {
    const queryResult = await pool.query(`SELECT * FROM ${tableName}`);
    res.json(queryResult.rows); // Send the result as JSON
  } catch (error) {
    console.error('Error executing query', error.stack);
    res.status(500).send('Internal Server Error');
  }
}

// Modified endpoint to handle year query for Team Batting
app.get('/api/teamBatting', (req, res) => {
  fetchDataFromTable(req, res, 'teamBatting');
});

// Modified endpoint to handle year query for Team Pitching
app.get('/api/TeamPitching', (req, res) => {
  fetchDataFromTable(req, res, 'teamPitching');
});

// Modified endpoint to handle year query for Player Batting
app.get('/api/PlayerBatting', (req, res) => {
  fetchDataFromTable(req, res, 'playerBatting');
});

// Modified endpoint to handle year query for Player Pitching
app.get('/api/PlayerPitching', (req, res) => {
  fetchDataFromTable(req, res, 'playerPitching');
});

// Modified endpoint to handle year query for Player Pitching
app.get('/api/Standings', (req, res) => {
  fetchDataFromTable(req, res, 'standings');
});

// MLB News endpoint
app.get('/api/mlb-news', (req, res) => {
    fs.readFile('mlb_news_mlb.json', (err, data) => {
        if (err) {
            res.status(500).send('Error reading MLB news data');
            return;
        }
        res.type('application/json');
        res.send(data);
    });
});



// Braves News endpoint
app.get('/api/braves-news', (req, res) => {
    fs.readFile('mlb_news_atlanta_braves.json', (err, data) => {
        if (err) {
            res.status(500).send('Error reading Braves news data');
            return;
        }
        res.type('application/json');
        res.send(data);
    });
});

app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
});
