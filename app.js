require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

app.get('/', (req, res) => res.send('Hello world'));

app.listen(port, () => {
    console.log(`MLB port listening at ${port}`);
});