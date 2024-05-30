require('dotenv').config();
const express = require('express');
const { BigQuery } = require('@google-cloud/bigquery');
const { Storage } = require('@google-cloud/storage');
const cors = require('cors');
const fs = require('fs');
const { log } = require('console');
const app = express();
const port = process.env.PORT || 8080;

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
  const year = req.query.year || '2024'; // Default to 2024 if no year is provided
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
  const year = req.query.year || '2024'; // Default to 2024 if no year is provided
    const tableName = `${year}_${tableNamePrefix}`; // Construct table name
    try {
        const query = `SELECT column_name FROM \`mlb-414201.MLB_data.INFORMATION_SCHEMA.COLUMNS\` WHERE table_name='${tableName}'`;
        const options = {
            query: query,
            location: 'us-east1',
        };
    const [job] = await bigquery.createQueryJob(options);
    console.log(`Job ${job.id} started.`);

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
          `2024_teamBatting`,
          `2024_teamPitching`,
          `2023_teamBatting`,
          `2023_teamPitching`,
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
          teamBatting_2024: allData[0],
          teamPitching_2024: allData[1],
          teamBatting_2023: allData[2],
          teamPitching_2023: allData[3],
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

app.get('/api/playerStats/', async (req, res) => {
  const { name } = req.query;

  try {
      // Construct table names
      const tableNames = [
          `2024_playerBatting`,
          `2024_playerPitching`,
          `2023_playerBatting`,
          `2023_playerPitching`,
          `2022_playerBatting`,
          `2022_PlayerPitching`,
          `2021_playerBatting`,
          `2021_PlayerPitching`,
          `2020_playerBatting`,
          `2020_PlayerPitching`,
          `2019_playerBatting`,
          `2019_PlayerPitching`
      ];

      // Create an array to hold all the query promises
      const queryPromises = tableNames.map(async tableName => {
          const query = `SELECT * FROM \`mlb-414201.MLB_data.${tableName}\` WHERE Name = '${name}'`;
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
          playerBatting_2024: allData[0],
          playerPitching_2024: allData[1],
          playerBatting_2023: allData[2],
          playerPitching_2023: allData[3],
          playerBatting_2022: allData[4],
          playerPitching_2022: allData[5],
          playerBatting_2021: allData[6],
          playerPitching_2021: allData[7],
          playerBatting_2020: allData[8],
          playerPitching_2020: allData[9],
          playerBatting_2019: allData[10],
          playerPitching_2019: allData[11],
      };

      res.json(responseData);
  } catch (error) {
      console.error('Error executing query', error);
      res.status(500).send('Internal Server Error');
  }
});


// const pythonEnvPath = '/home/henrycraig/csvkit_env/bin/python3';


// app.get('/api/player-statcast/:firstName/:lastName', async (req, res) => {
//   const { firstName, lastName } = req.params;

//   // Use the Python executable from the virtual environment
//   const scriptPath = '/home/henrycraig/mlb_pi/getPlayerID.py'; // Make sure to use the correct path
//   exec(`${pythonEnvPath} ${scriptPath} "${firstName}" "${lastName}"`, async (error, stdout, stderr) => {
//     if (error) {
//       console.error(`exec error: ${error}`);
//       return res.status(500).send('Internal Server Error');
//     }
//     if (stderr) {
//       console.error(`stderr: ${stderr}`);
//       return res.status(404).send('Player not found');
//     }
//     const playerId = stdout.trim();
//     try {
//       // Query your database using the player ID
//       // This is a placeholder query; modify it according to your schema
//       const statcast_batting = await pool.query('SELECT * FROM "statcast_2024" WHERE "batter" = $1', [playerId]);
//       const statcast_pitching = await pool.query('SELECT * FROM "statcast_2024" WHERE "pitcher" = $1', [playerId]);
//         // Aggregate data into one response
//   const responseData = {
//     statcastBatting: statcast_batting.rows,
//     statcastPitching: statcast_pitching.rows
// };

// res.json(responseData);
//     } catch (dbError) {
//       console.error(`Database error: ${dbError}`);
//       res.status(500).send('Database query failed');
//     }
//   });
// });


// MLB News endpoint
app.get('/api/mlb-news', (req, res) => {
  getJsonFromBucket('mlb_henry', '2024/mlb_news.json')
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
