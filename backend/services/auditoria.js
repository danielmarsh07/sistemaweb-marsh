// Auditoria geral: quem fez o quê, em qual registro, com o retrato de antes e depois.
// Tabela auditoria (server.js, seção 30). Falha ao gravar nunca derruba a operação principal:
// vira alerta em Sistema → Alertas. Dentro de transação, passe o client para gravar junto (e desfazer junto).
const pool = require('../db');

async function registrar({ empresa_id = 1, usuario_id = null, acao, entidade, entidade_id = null, antes = null, depois = null, detalhe = null }, client) {
  const sql = `INSERT INTO auditoria (empresa_id, usuario_id, acao, entidade, entidade_id, antes, depois, detalhe)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;
  const params = [empresa_id, usuario_id, acao, entidade, entidade_id,
    antes && JSON.stringify(antes), depois && JSON.stringify(depois), detalhe];
  if (client) return client.query(sql, params); // em transação: erro aqui desfaz tudo, de propósito
  try {
    await pool.query(sql, params);
  } catch (err) {
    console.error('[auditoria]', acao, err.message);
    require('./alertas').registrarAlerta({ chave: 'auditoria', nivel: 'aviso', titulo: 'Falha ao gravar auditoria', detalhe: `${acao}: ${err.message}` });
  }
}

module.exports = { registrar };
