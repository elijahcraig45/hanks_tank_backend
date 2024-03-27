require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const fs = require('fs');
const app = express();
const port = process.env.PORT || 3000;
app.use(cors()); // This will enable CORS for all routes and origins
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

// Test endpoint
app.get('/', (req, res) => {
    res.send('Express backend is running!');
  });

// Express server setup (in your server.js or app.js file)
app.get('/api/teamBatting', async (req, res) => {
    try {
      const queryResult = await pool.query('SELECT * FROM "teamBatting_2023"');
      res.json(queryResult.rows); // Send the result as JSON
    } catch (error) {
      console.error('Error executing query', error.stack);
      res.status(500).send('Internal Server Error');
    }
  });
  
  app.get('/api/TeamPitching', async (req, res) => {
    try {
      const queryResult = await pool.query('SELECT * FROM "teamPitching_2023"');
      res.json(queryResult.rows); // Send the result as JSON
    } catch (error) {
      console.error('Error executing query', error.stack);
      res.status(500).send('Internal Server Error');
    }
  });
  
  app.get('/api/PlayerBatting', async (req, res) => {
    try {
      const queryResult = await pool.query('SELECT * FROM "playerBatting_2023"');
      res.json(queryResult.rows); // Send the result as JSON
    } catch (error) {
      console.error('Error executing query', error.stack);
      res.status(500).send('Internal Server Error');
    }
  });
  
  app.get('/api/PlayerPitching', async (req, res) => {
    try {
      const queryResult = await pool.query('SELECT * FROM "playerPitching_2023"');
      res.json(queryResult.rows); // Send the result as JSON
    } catch (error) {
      console.error('Error executing query', error.stack);
      res.status(500).send('Internal Server Error');
    }
  });

  app.get('/api/mlb-news', (req, res) => {
    const newsFile = 'mlb_news_mlb.json'; // Path to your MLB news file
    fs.readFile(newsFile, (err, data) => {
        if (err) {
            res.status(500).send('Error reading MLB news data');
            return;
        }
        res.type('application/json');
        res.send(data);
    });
});

app.get('/api/braves-news', (req, res) => {
    const newsFile = 'mlb_news_atlanta_braves.json'; // Path to your Braves news file
    fs.readFile(newsFile, (err, data) => {
        if (err) {
            res.status(500).send('Error reading Braves news data');
            return;
        }
        res.type('application/json');
        res.send(data);
    });
});

app.listen(port, () => {
    console.log(`MLB port listening at ${port}`);
});