// Carrega o .env.local e TRAVA se o banco não for o local (Docker).
// Os testes criam e apagam registros: nunca podem rodar contra o banco de produção do .env.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) {
  console.error('Abortado: DATABASE_URL não é o banco local. Os testes só rodam com o .env.local (npm run dev:local).');
  process.exit(1);
}
