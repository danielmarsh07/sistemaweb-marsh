const { Pool, types } = require('pg');

// TIMESTAMP (sem fuso) é gravado em UTC (o banco roda em UTC). O pg leria no fuso do processo Node: no Windows
// (horário de Brasília) os horários ficariam 3 h adiantados e chamados abertos à noite iriam para o dia seguinte.
types.setTypeParser(1114, s => new Date(s.replace(' ', 'T') + 'Z'));

// Banco local (Docker) não usa SSL; o Postgres do Render exige
const local = /@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: local ? false : { rejectUnauthorized: false }
});

module.exports = pool;
