const { Pool } = require('pg');

// Banco local (Docker) não usa SSL; o Postgres do Render exige
const local = /@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: local ? false : { rejectUnauthorized: false }
});

module.exports = pool;
