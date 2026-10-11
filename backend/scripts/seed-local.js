#!/usr/bin/env node
/**
 * Dados iniciais do banco LOCAL (Docker): admin de teste, um cliente e o login do portal desse cliente.
 * Uso: npm run seed:local   (rode depois de subir o app uma vez com npm run dev:local, que cria as tabelas)
 * Recusa rodar se o DATABASE_URL não for localhost — nunca toca a produção.
 */
require('dotenv').config({ path: '.env.local' });
const bcrypt = require('bcrypt');
const pool = require('../db');

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) {
  console.error('❌ seed-local só roda contra banco local (DATABASE_URL precisa ser localhost).');
  process.exit(1);
}

async function main() {
  const senha = await bcrypt.hash('marsh123', 10);

  await pool.query(
    `INSERT INTO usuarios (nome, email, senha, empresa_id, tipo, ativo)
     VALUES ('Admin Local', 'admin@marsh.local', $1, 1, 'admin_empresa', TRUE)
     ON CONFLICT (email) DO NOTHING`, [senha]);

  let cli = await pool.query(`SELECT id FROM clientes WHERE cpf_cnpj = '11.222.333/0001-81'`);
  if (!cli.rows.length) {
    cli = await pool.query(
      `INSERT INTO clientes (nome, razao_social, nome_fantasia, cpf_cnpj, inscricao_municipal, email,
         responsavel_nome, responsavel_email, cep, logradouro, numero, bairro, cidade, uf, status, empresa_id, criado_por_usuario_id)
       VALUES ('Cliente Exemplo', 'Cliente Exemplo Indústria Ltda', 'Cliente Exemplo', '11.222.333/0001-81', '12345',
         'financeiro@cliente-exemplo.local', 'Maria Teste', 'maria@cliente-exemplo.local',
         '01310-100', 'Av. Paulista', '1000', 'Bela Vista', 'São Paulo', 'SP', 'ativo', 1, 1)
       RETURNING id`);
  }

  await pool.query(
    `INSERT INTO usuarios (nome, email, senha, empresa_id, tipo, ativo, cliente_id)
     VALUES ('Maria Teste', 'cliente@marsh.local', $1, 1, 'cliente', TRUE, $2)
     ON CONFLICT (email) DO NOTHING`, [senha, cli.rows[0].id]);

  console.log('✅ Seed local ok');
  console.log('   Admin:   admin@marsh.local   / marsh123');
  console.log('   Cliente: cliente@marsh.local / marsh123 (portal)');
  await pool.end();
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
