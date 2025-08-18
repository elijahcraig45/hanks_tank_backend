# MLB Analytics Backend API

A comprehensive Node.js backend server providing MLB baseball data through REST APIs. This server integrates with PostgreSQL databases, Google Cloud BigQuery, and Google Cloud Storage to deliver real-time and historical baseball analytics.

## 🚀 Features

- **Multi-Year Data Support**: Serves baseball data from 2020-2025 seasons
- **Dual Database Integration**: PostgreSQL for relational data, BigQuery for analytics
- **Cloud Storage**: Google Cloud Storage for file assets and data backup
- **Real-time Data**: Live game data and statistics
- **News Aggregation**: MLB and team-specific news feeds
- **Automated Data Collection**: Python scripts for data gathering and processing
- **Flexible APIs**: Query parameters for customizable data retrieval

## 🛠 Tech Stack

- **Node.js & Express.js** - RESTful API server
- **PostgreSQL** - Primary relational database
- **Google Cloud BigQuery** - Analytics and data warehousing
- **Google Cloud Storage** - File storage and data backup
- **Python & pybaseball** - Data collection and processing
- **CORS enabled** - Cross-origin resource sharing for frontend integration

## 📊 API Endpoints

### Core Data Endpoints

#### Player Statistics
- `GET /api/PlayerBatting?year=2025` - Player batting statistics
- `GET /api/PlayerPitching?year=2025` - Player pitching statistics

#### Team Statistics  
- `GET /api/teamBatting?year=2025` - Team batting performance
- `GET /api/TeamPitching?year=2025` - Team pitching performance

#### Game Data
- `GET /api/games-today` - Today's game schedule and scores
- `GET /api/game/:gameId` - Specific game details and box score
- `GET /api/strike-zone/:gameId` - Strike zone data for a game

#### Advanced Analytics
- `GET /api/statcast?year=2025` - Statcast pitch-by-pitch data
- `GET /api/standings?year=2025` - Division standings and records

#### News & Information
- `GET /api/mlb-news` - General MLB news feed
- `GET /api/braves-news` - Atlanta Braves specific news

### Query Parameters

- `year` - Specify data year (2020-2025, defaults to 2025)
- `stats` - Select specific columns (defaults to all)
- `orderBy` - Sort by specific field
- `direction` - Sort direction (asc/desc)
- `limit` - Limit number of results (defaults to 100)

### Example Requests

```bash
# Get 2025 player batting stats
curl "http://localhost:3000/api/PlayerBatting?year=2025&limit=50"

# Get team pitching sorted by ERA
curl "http://localhost:3000/api/TeamPitching?year=2025&orderBy=ERA&direction=asc"

# Get today's games
curl "http://localhost:3000/api/games-today"

# Get specific game box score
curl "http://localhost:3000/api/game/634567"
```

## 🏗 Architecture

### Server Applications

#### `app.js` - PostgreSQL Server
- Primary API server using PostgreSQL database
- Handles player/team statistics and core data
- Year-based table routing (`playerBatting_2025`, `teamPitching_2025`, etc.)

#### `bqapp.js` - BigQuery Server  
- Analytics server using Google Cloud BigQuery
- Advanced queries and large dataset processing
- Integration with Google Cloud Storage for data files

### Data Collection Scripts

#### `pybaseballGather.py`
- Python script for automated data collection
- Uses pybaseball library for MLB data APIs
- Fetches player stats, team stats, schedules, and Statcast data

#### `newsFetch.py`
- News aggregation from MLB sources
- Team-specific news filtering (Atlanta Braves focus)
- JSON output for API consumption

#### `csvImport.sh` & `dailyRun.sh`
- Shell scripts for data processing automation
- CSV import to PostgreSQL
- Daily data update routines

## 🚀 Getting Started

### Prerequisites
- Node.js (v14 or higher)
- PostgreSQL database
- Google Cloud Platform account with BigQuery and Storage
- Python 3.8+ (for data collection scripts)

### Installation

1. Clone the repository:
```bash
git clone https://github.com/elijahcraig45/mlb_pi.git
cd mlb_pi
```

2. Install Node.js dependencies:
```bash
npm install
```

3. Install Python dependencies:
```bash
pip install pybaseball pandas psycopg2-binary google-cloud-bigquery google-cloud-storage
```

4. Set up environment variables:
```bash
# Create .env file with:
DATABASE_URL=postgresql://username:password@localhost:5432/mlb_db
GOOGLE_APPLICATION_CREDENTIALS=path/to/service-account-key.json
PORT=3000
```

### Running the Server

#### PostgreSQL Server (Primary)
```bash
node app.js
# Server runs at http://localhost:3000
```

#### BigQuery Server (Analytics)
```bash
node bqapp.js
# Alternative analytics server
```

### Data Collection

#### Fetch Current Season Data
```bash
python pybaseballGather.py 2025
```

#### Update News Feeds
```bash
python newsFetch.py
```

#### Import CSV Data
```bash
./csvImport.sh 2025
```

## 📁 Project Structure

```
mlb_pi/
├── app.js                    # PostgreSQL API server
├── bqapp.js                  # BigQuery API server
├── package.json              # Node.js dependencies
├── app.yaml                  # Google App Engine config
├── pybaseballGather.py       # Data collection script
├── newsFetch.py              # News aggregation script
├── csvImport.sh              # CSV import automation
├── dailyRun.sh               # Daily update routine
├── data/                     # Local data storage
│   ├── 2024/                # 2024 season data
│   └── 2025/                # 2025 season data
└── .env                      # Environment variables
```

## 🗄 Database Schema

### PostgreSQL Tables
- `playerBatting_YYYY` - Player batting statistics by year
- `playerPitching_YYYY` - Player pitching statistics by year  
- `teamBatting_YYYY` - Team batting performance by year
- `teamPitching_YYYY` - Team pitching performance by year
- `statcast_YYYY` - Pitch-by-pitch Statcast data by year
- `standings_YYYY` - Division standings by year

### BigQuery Datasets
- Analytics queries for large dataset processing
- Historical data warehousing
- Advanced statistical computations

## ☁️ Google Cloud Integration

### BigQuery
- Large-scale analytics queries
- Historical data analysis
- Custom aggregations and metrics

### Cloud Storage
- Data file backup and versioning
- News feed JSON storage
- CSV data archival

### App Engine
- Production deployment configuration
- Scalable server hosting

## 🔧 Development

### Adding New Endpoints
1. Add route in `app.js` or `bqapp.js`
2. Create corresponding database table/view
3. Update data collection scripts if needed
4. Test with sample queries

### Data Updates
1. Run Python collection scripts
2. Process and import CSV data
3. Update cloud storage files
4. Restart API servers

## 🚀 Deployment

### Google App Engine
```bash
gcloud app deploy app.yaml
```

### Docker (Optional)
```bash
docker build -t mlb-api .
docker run -p 3000:3000 mlb-api
```

## 🔗 Frontend Integration

This backend serves the [Hank's Tank 2025 Frontend](https://github.com/elijahcraig45/2024_mlb):
- React application consuming these APIs
- Real-time data visualization
- Interactive baseball analytics dashboard

## 📈 Performance

- **Optimized Queries**: Indexed database tables for fast retrieval
- **Caching**: Cloud storage caching for frequently accessed data
- **Pagination**: Configurable result limits to manage response sizes
- **Error Handling**: Comprehensive error responses and logging

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the ISC License.

## 🏆 About

**MLB Analytics Backend** - Powering comprehensive baseball analytics for the modern game. Built to serve real-time and historical MLB data through scalable, cloud-integrated APIs.

---

⚾ *Data-Driven Baseball Analytics* ⚾