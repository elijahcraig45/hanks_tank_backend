require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const { exec } = require('child_process');
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


// Aggregated Team Data endpoint
app.get('/api/teamData', async (req, res) => {
  const teamAbbr = req.query.teamAbbr || 'ATL'; // Default to 'ATL' if no team abbreviation is provided
  const year = req.query.year || '2024'; // Default to 2024 if no year is provided
  const teamTableSuffix = `team_schedule_and_record_${teamAbbr}_${year}`;

  try {
      // Fetch team batting stats
      const teamBatting_2024 = await pool.query(`SELECT * FROM "teamBatting_2024" WHERE "Team" = '${teamAbbr}'`);
      // Fetch team pitching stats
      const teamPitching_2024 = await pool.query(`SELECT * FROM "teamPitching_2024" WHERE "Team" = '${teamAbbr}'`);

      // Fetch team batting stats
      const teamBatting_2023 = await pool.query(`SELECT * FROM "teamBatting_2023" WHERE "Team" = '${teamAbbr}'`);
      // Fetch team pitching stats
      const teamPitching_2023 = await pool.query(`SELECT * FROM "teamPitching_2023" WHERE "Team" = '${teamAbbr}'`);

      // Fetch team batting stats
      const teamBatting_2022 = await pool.query(`SELECT * FROM "teamBatting_2022" WHERE "Team" = '${teamAbbr}'`);
      // Fetch team pitching stats
      const teamPitching_2022 = await pool.query(`SELECT * FROM "teamPitching_2022" WHERE "Team" = '${teamAbbr}'`);

      // Fetch team batting stats
      const teamBatting_2021 = await pool.query(`SELECT * FROM "teamBatting_2021" WHERE "Team" = '${teamAbbr}'`);
      // Fetch team pitching stats
      const teamPitching_2021 = await pool.query(`SELECT * FROM "teamPitching_2021" WHERE "Team" = '${teamAbbr}'`);

      // Fetch team batting stats
      const teamBatting_2020 = await pool.query(`SELECT * FROM "teamBatting_2020" WHERE "Team" = '${teamAbbr}'`);
      // Fetch team pitching stats
      const teamPitching_2020 = await pool.query(`SELECT * FROM "teamPitching_2020" WHERE "Team" = '${teamAbbr}'`);

      // Fetch team batting stats
      const teamBatting_2019 = await pool.query(`SELECT * FROM "teamBatting_2019" WHERE "Team" = '${teamAbbr}'`);
      // Fetch team pitching stats
      const teamPitching_2019 = await pool.query(`SELECT * FROM "teamPitching_2019" WHERE "Team" = '${teamAbbr}'`);
      // Fetch top batters - this is an example, adjust according to your criteria
      const topBatters = await pool.query(`SELECT * FROM "playerBatting_2024" WHERE "Team" = '${teamAbbr}' ORDER BY "AVG" DESC;`);
      
      // Fetch top pitchers - this is an example, adjust according to your criteria
      const topPitchers = await pool.query(`SELECT * FROM "playerPitching_2024" WHERE "Team" = '${teamAbbr}' ORDER BY "ERA" ASC`);
      // Fetch team schedule and record
      const scheduleAndRecord = await pool.query(`SELECT * FROM "${teamTableSuffix}"`);

      // Aggregate data into one response
      const responseData = {
          teamBatting_2024: teamBatting_2024.rows,
          teamPitching_2024: teamPitching_2024.rows,
          teamBatting_2023: teamBatting_2023.rows,
          teamPitching_2023: teamPitching_2023.rows,
          teamBatting_2022: teamBatting_2022.rows,
          teamPitching_2022: teamPitching_2022.rows,
          teamBatting_2021: teamBatting_2021.rows,
          teamPitching_2021: teamPitching_2021.rows,
          teamBatting_2020: teamBatting_2020.rows,
          teamPitching_2020: teamPitching_2020.rows,
          teamBatting_2019: teamBatting_2019.rows,
          teamPitching_2019: teamPitching_2019.rows,
          topBatters: topBatters.rows,
          topPitchers: topPitchers.rows,
          scheduleAndRecord: scheduleAndRecord.rows
      };

      res.json(responseData);
  } catch (error) {
      console.error('Error executing query', error.stack);
      res.status(500).send('Internal Server Error');
  }
});

const pythonEnvPath = '/home/henrycraig/csvkit_env/bin/python3';


app.get('/api/player-statcast/:firstName/:lastName', async (req, res) => {
  const { firstName, lastName } = req.params;

  // Use the Python executable from the virtual environment
  const scriptPath = '/home/henrycraig/mlb_pi/getPlayerID.py'; // Make sure to use the correct path
  exec(`${pythonEnvPath} ${scriptPath} "${firstName}" "${lastName}"`, async (error, stdout, stderr) => {
    if (error) {
      console.error(`exec error: ${error}`);
      return res.status(500).send('Internal Server Error');
    }
    if (stderr) {
      console.error(`stderr: ${stderr}`);
      return res.status(404).send('Player not found');
    }
    const playerId = stdout.trim();
    try {
      // Query your database using the player ID
      // This is a placeholder query; modify it according to your schema
      const statcast_batting = await pool.query('SELECT * FROM "statcast_2024" WHERE "batter" = $1', [playerId]);
      const statcast_pitching = await pool.query('SELECT * FROM "statcast_2024" WHERE "pitcher" = $1', [playerId]);
        // Aggregate data into one response
  const responseData = {
    statcastBatting: statcast_batting.rows,
    statcastPitching: statcast_pitching.rows
};

res.json(responseData);
    } catch (dbError) {
      console.error(`Database error: ${dbError}`);
      res.status(500).send('Database query failed');
    }
  });
});


app.get('/api/player-stats/:firstName/:lastName', async (req, res) => {
  const { firstName, lastName } = req.params;

  
    try {
      // Query your database using the player ID
      // This is a placeholder query; modify it according to your schema
      const playerBatting_2024 = await pool.query(`SELECT * FROM "playerBatting_2024" WHERE "Name" = \'${firstName} ${lastName}\'`);
      const playerPitching_2024 = await pool.query(`SELECT * FROM "playerPitching_2024" WHERE "Name" = \'${firstName} ${lastName}\'`);
      const playerBatting_2023 = await pool.query(`SELECT * FROM "playerBatting_2023" WHERE "Name" = \'${firstName} ${lastName}\'`);
      const playerPitching_2023 = await pool.query(`SELECT * FROM "playerPitching_2023" WHERE "Name" = \'${firstName} ${lastName}\'`);
      const playerBatting_2022 = await pool.query(`SELECT * FROM "playerBatting_2022" WHERE "Name" = \'${firstName} ${lastName}\'`);
      const playerPitching_2022 = await pool.query(`SELECT * FROM "playerPitching_2022" WHERE "Name" = \'${firstName} ${lastName}\'`);
      const playerBatting_2021 = await pool.query(`SELECT * FROM "playerBatting_2021" WHERE "Name" = \'${firstName} ${lastName}\'`);
      const playerPitching_2021 = await pool.query(`SELECT * FROM "playerPitching_2021" WHERE "Name" = \'${firstName} ${lastName}\'`);
      const playerBatting_2020 = await pool.query(`SELECT * FROM "playerBatting_2020" WHERE "Name" = \'${firstName} ${lastName}\'`);
      const playerPitching_2020 = await pool.query(`SELECT * FROM "playerPitching_2020" WHERE "Name" = \'${firstName} ${lastName}\'`);
      const playerBatting_2019 = await pool.query(`SELECT * FROM "playerBatting_2019" WHERE "Name" = \'${firstName} ${lastName}\'`);
      const playerPitching_2019 = await pool.query(`SELECT * FROM "playerPitching_2019" WHERE "Name" = \'${firstName} ${lastName}\'`);


        // Aggregate data into one response
  const responseData = {
    playerBatting_2024: playerBatting_2024.rows,
    playerPitching_2024: playerPitching_2024.rows,
    playerBatting_2023: playerBatting_2023.rows,
    playerPitching_2023: playerPitching_2023.rows,
    playerBatting_2022: playerBatting_2022.rows,
    playerPitching_2022: playerPitching_2022.rows,
    playerBatting_2021: playerBatting_2021.rows,
    playerPitching_2021: playerPitching_2021.rows,
    playerBatting_2020: playerBatting_2020.rows,
    playerPitching_2020: playerPitching_2020.rows,
    playerBatting_2019: playerBatting_2019.rows,
    playerPitching_2019: playerPitching_2019.rows,
};

res.json(responseData);
    } catch (dbError) {
      console.error(`Database error: ${dbError}`);
      res.status(500).send('Database query failed');
    }
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
