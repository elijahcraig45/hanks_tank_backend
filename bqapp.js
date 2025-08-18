require('dotenv').config();
const express = require('express');
const { BigQuery } = require('@google-cloud/bigquery');
const { Storage } = require('@google-cloud/storage');
const cors = require('cors');
const axios = require('axios');
const app = express();
const port = process.en// MLB News endpoint
app.get('/api/braves-news', (req, res) => {
  getJsonFromBucket('mlb_henry', '2025/braves_news.json')

app.use(cors());

const storage = new Storage();

const bigquery = new BigQuery();

app.get('/', (req, res) => {
    res.send('Express backend is running!');
});


// generic function for getting file from Gcloud storage bucket
async function getJsonFromBucket(bucketName, fileName) {
  try {
    // Reference to your bucket
    const bucket = storage.bucket(bucketName);

    // Reference to the JSON file
    const file = bucket.file(fileName);

    // Download the file contents as a string
    const fileContents = await file.download();

    // Parse the JSON string into an object
    const jsonData = JSON.parse(fileContents.toString());

    return jsonData;
  } catch (error) {
    console.error('Error fetching JSON file:', error);
    throw error;
  }
}

// Generic function to fetch data based on year and table name
async function fetchDataFromTable(req, res, tableNamePrefix, limit=100) {
  const year = req.query.year || '2025'; // Default to 2025 if no year is provided
  const stats = req.query.stats || '*';
  const direction = req.query.direction || 'asc';
  const orderBy = req.query.orderBy || null;
  encodedStats = stats.replace('/', '_');
  const tableName = `${year}_${tableNamePrefix}`; // Construct table name
    try {
        const query = `SELECT ${encodedStats} FROM \`mlb-414201.MLB_data.${tableName}\` ORDER BY ${orderBy} ${direction.toLowerCase()} LIMIT ${limit}`;
        const options = {
            query: query,
            location: 'us-east1',
        };
    const [job] = await bigquery.createQueryJob(options);
    console.log(`Job ${job.id} started.`);

    const [rows] = await job.getQueryResults();

    res.json(rows);
} catch (error) {
    console.error('Error executing query', error);
    res.status(500).send('Internal Server Error');
}
}

// Generic function for getting avaliable columns from a table
async function fetchColumnsFromTable(req, res, tableNamePrefix) {
  const year = req.query.year || '2025'; // Default to 2025 if no year is provided
    const tableName = `${year}_${tableNamePrefix}`; // Construct table name
    try {
        const query = `SELECT column_name FROM \`mlb-414201.MLB_data.INFORMATION_SCHEMA.COLUMNS\` WHERE table_name='${tableName}'`;
        const options = {
            query: query,
            location: 'us-east1',
        };
    const [job] = await bigquery.createQueryJob(options);
    console.log(`Job ${job.id} started.`);
    console.log(query);
    const [rows] = await job.getQueryResults();
    const columns = rows.map(row => row.column_name);
    res.json(columns);
} catch (error) {
    console.error('Error executing query', error);
    res.status(500).send('Internal Server Error');
}
}

// Modified endpoint to handle year query for Team Batting
app.get('/api/teamBatting', (req, res) => {
  fetchDataFromTable(req, res, 'teamBatting');
});

app.get('/api/teamBatting/avaliableStats', (req, res) => {
  fetchColumnsFromTable(req, res, 'teamBatting');
});

// Modified endpoint to handle year query for Team Pitching
app.get('/api/TeamPitching', (req, res) => {
  fetchDataFromTable(req, res, 'teamPitching');
});

app.get('/api/TeamPitching/avaliableStats', (req, res) => {
  fetchColumnsFromTable(req, res, 'teamPitching');
});

// Modified endpoint to handle year query for Player Batting
app.get('/api/PlayerBatting', (req, res) => {
  fetchDataFromTable(req, res, 'playerBatting');
});

app.get('/api/PlayerBatting/avaliableStats', (req, res) => {
  fetchColumnsFromTable(req, res, 'playerBatting');
});

// Modified endpoint to handle year query for Player Pitching
app.get('/api/PlayerPitching', (req, res) => {
  fetchDataFromTable(req, res, 'playerPitching');
});

app.get('/api/PlayerPitching/avaliableStats', (req, res) => {
  fetchColumnsFromTable(req, res, 'playerPitching');
});

// Modified endpoint to handle year query for Player Pitching
app.get('/api/Standings', (req, res) => {
  fetchDataFromTable(req, res, 'standings');
});


app.get('/api/teamData', async (req, res) => {
  const teamAbbr = req.query.teamAbbr || 'ATL'; // Default to 'ATL' if no team abbreviation is provided

  try {
      // Construct table names
      const tableNames = [
          `2025_teamBatting`,
          `2025_teamPitching`,
          `2024_teamBatting`,
          `2024_teamPitching`,
          `2022_teamBatting`,
          `2022_teamPitching`,
          `2021_teamBatting`,
          `2021_teamPitching`,
          `2020_teamBatting`,
          `2020_teamPitching`,
          `2019_teamBatting`,
          `2019_teamPitching`
      ];

      // Create an array to hold all the query promises
      const queryPromises = tableNames.map(async tableName => {
          const query = `SELECT * FROM \`mlb-414201.MLB_data.${tableName}\` WHERE Team = '${teamAbbr}'`;
          console.log(query);
          const options = {
              query: query,
              location: 'us-east1',
          };
          const [job] = await bigquery.createQueryJob(options);
          console.log(`Job ${job.id} started.`);
          const [rows] = await job.getQueryResults();
          return rows;
      });

      // Wait for all queries to finish
      const allData = await Promise.all(queryPromises);
      // Combine all the data into a single object
      const responseData = {
          teamBatting_2025: allData[0],
          teamPitching_2025: allData[1],
          teamBatting_2024: allData[2],
          teamPitching_2024: allData[3],
          teamBatting_2022: allData[4],
          teamPitching_2022: allData[5],
          teamBatting_2021: allData[6],
          teamPitching_2021: allData[7],
          teamBatting_2020: allData[8],
          teamPitching_2020: allData[9],
          teamBatting_2019: allData[10],
          teamPitching_2019: allData[11],
      };

      res.json(responseData);
  } catch (error) {
      console.error('Error executing query', error);
      res.status(500).send('Internal Server Error');
  }
});

app.get('/api/playerData', async (req, res) => {
  try {
    const playerId = req.query.playerId;
    const position = req.query.position || '';

    if (playerId.length < 1) {
      return res.status(400).json({ error: 'Player ID is required' });
    }

    const url = `https://www.fangraphs.com/api/players/stats?playerid=${playerId}&position=${position}`;

    const response = await axios.get(url);
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching player stats:', error);
    res.status(500).json({ error: 'An error occurred while fetching player stats' });
  }
});

app.get('/api/statcast', async (req, res) => {
const year = req.query.year || '2025';
const position = req.query.position || 'batter';
const playerId = req.query.playerId;
const p_throws = req.query.p_throws || '';
const stands = req.query.stands || '';
const pitch_type = req.query.pitch_type || '';
const events = req.query.events || '';
const orderBy = req.query.order || 'game_date'; // Renamed highest to orderByField
const limit = req.query.limit || '500'; // Renamed highest to orderByField

const requestedParams = ["game_date", "pitch_type", "release_speed", "batter", "pitcher", "events", "description", "spin_dir", "zone", "des", "stand", "p_throws", "home_team", "away_team", "hit_location", "bb_type", "balls", "strikes", "type", "plate_x", "plate_z", "on_3b", "on_2b", "on_1b", "outs_when_up", "inning", "hit_distance_sc", "launch_speed", "launch_angle", "release_spin_rate", "estimated_ba_using_speedangle", "estimated_woba_using_speedangle", "woba_value", "babip_value", "pitch_number", "home_score", "away_score", "bat_speed", "swing_length"];

let selectParams = requestedParams.join(', ');
const tableName = `${year}_statcast`;
let query = `SELECT ${selectParams} FROM \`mlb-414201.MLB_data.${tableName}\` WHERE 1 = 1`;

if (position === 'batter' || position === 'pitcher') {
  query += ` AND ${position} = ${playerId}`;
}

if (p_throws !== '') {
  query += ` AND p_throws = '${p_throws}'`;
}

if (stands !== '') {
  query += ` AND stand = '${stands}'`;
}

if (pitch_type !== '') {
  query += ` AND pitch_type = '${pitch_type}'`;
}

if (events !== '') {
  query += ` AND events = '${events}'`;
}

query += ` ORDER BY ${orderBy} DESC
  LIMIT ${limit};`;
try {
  console.log(query);
  const options = {
      query: query,
      location: 'us-east1',
  };
const [job] = await bigquery.createQueryJob(options);
console.log(`Job ${job.id} started.`);

const [rows] = await job.getQueryResults();

res.json(rows);
} catch (error) {
console.error('Error executing query', error);
res.status(500).send('Internal Server Error');
}
});



// MLB News endpoint
app.get('/api/mlb-news', (req, res) => {
  getJsonFromBucket('mlb_henry', '2025/mlb_news.json')
  .then(jsonData => {
    res.type('application/json');
    res.send(jsonData);
  })
  .catch(error => {
    res.status(500).send('Error reading MLB news data');
    return;
  });
});

// MLB News endpoint
app.get('/api/braves-news', (req, res) => {
  getJsonFromBucket('mlb_henry', '2024/braves_news.json')
  .then(jsonData => {
    res.type('application/json');
    res.send(jsonData);
  })
  .catch(error => {
    res.status(500).send('Error reading MLB news data');
    return;
  });
});


app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
});
