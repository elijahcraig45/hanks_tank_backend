require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

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

app.listen(port, () => {
    console.log(`MLB port listening at ${port}`);
});