/**
 * Quick test of Statcast API
 */

const https = require('https');

// Test single day of data
const url = 'https://baseballsavant.mlb.com/statcast_search/csv?all=true&hfPT=&hfAB=&hfGT=R%7C&hfPR=&hfZ=&hfStadium=&hfBBL=&hfNewZones=&hfPull=&hfC=&hfSea=2024%7C&hfSit=&player_type=pitcher&hfOuts=&hfOpponent=&pitcher_throws=&batter_stands=&hfSA=&game_date_gt=2024-04-01&game_date_lt=2024-04-02&hfMo=&hfTeam=&home_road=&hfRO=&position=&hfInfield=&hfOutfield=&hfInn=&hfBBT=&hfFlag=&metric_1=&group_by=name&min_pitches=0&min_results=0&min_pas=0&sort_col=pitches&player_event_sort=api_p_release_speed&sort_order=desc#results';

https.get(url, (res) => {
  let data = '';
  
  res.on('data', (chunk) => {
    data += chunk;
  });
  
  res.on('end', () => {
    const lines = data.split('\n');
    console.log(`\nTotal lines: ${lines.length}`);
    console.log(`\nFirst line (headers):\n${lines[0]}`);
    console.log(`\nSecond line (sample data):\n${lines[1]}`);
    
    // Count fields
    const fields = lines[0].split(',');
    console.log(`\nTotal fields: ${fields.length}`);
  });
}).on('error', (err) => {
  console.error('Error:', err.message);
});
