// Listas do mundo SAP usadas nos chamados (portal, sistema e Conector) e os servidores SAP habilitados para um cliente.
const pool = require('../db');

const TIPOS_DEMANDA = ['melhoria', 'erro', 'nova_funcionalidade', 'duvida'];
const MODULOS = ['FI', 'CO', 'SD', 'MM', 'PP', 'PM', 'QM', 'HR', 'BASIS', 'ABAP', 'CPI', 'FISCAL', 'OUTRO'];

// Servidores SAP (SIDs) que o cliente pode escolher ao abrir chamado. Fonte principal: as licenças do Conector
// ativas do cliente (tela Licenças — a chave da empresa vem primeiro, depois as licenças das pessoas, que copiam
// os sistemas do contrato). Complemento: os sistemas do contrato vigente que ainda não estão em nenhuma licença.
// Licença suspensa/vencida e contrato suspenso, cancelado ou vencido não habilitam servidor.
async function sistemasDoCliente(cliente_id, empresa_id = 1) {
  if (!cliente_id) return [];
  const licencas = (await pool.query(
    `SELECT sids, conexoes FROM licencas
     WHERE cliente_id = $1 AND COALESCE(empresa_id, 1) = $2 AND ativo AND status = 'ativa' AND data_fim >= CURRENT_DATE
     ORDER BY (vaga_id IS NULL) DESC, id`, [cliente_id, empresa_id])).rows;
  const contratos = (await pool.query(
    `SELECT NULL AS sids, conexoes FROM contratos_conector
     WHERE cliente_id = $1 AND empresa_id = $2 AND status = 'ativo'
       AND data_inicio <= CURRENT_DATE AND data_fim >= CURRENT_DATE
     ORDER BY id`, [cliente_id, empresa_id])).rows;
  const porSid = new Map();
  const incluir = (sid, c = {}) => {
    sid = String(sid || '').trim().toUpperCase();
    if (sid && !porSid.has(sid)) porSid.set(sid, { sid, descricao: c.descricao || '', mandante: c.mandante || '' });
  };
  for (const { sids, conexoes } of [...licencas, ...contratos]) {
    for (const c of Array.isArray(conexoes) ? conexoes : []) incluir(c.sid, c);
    for (const sid of String(sids || '').split(',')) incluir(sid); // SID na licença sem os dados de conexão
  }
  return [...porSid.values()].sort((a, b) => a.sid.localeCompare(b.sid));
}

module.exports = { TIPOS_DEMANDA, MODULOS, sistemasDoCliente };
