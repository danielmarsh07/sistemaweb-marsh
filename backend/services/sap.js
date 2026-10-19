// Listas do mundo SAP usadas nos chamados (portal, sistema e Conector) e os servidores SAP habilitados para um cliente.
const pool = require('../db');

const TIPOS_DEMANDA = ['melhoria', 'erro', 'nova_funcionalidade', 'duvida'];
const MODULOS = ['FI', 'CO', 'SD', 'MM', 'PP', 'PM', 'QM', 'HR', 'BASIS', 'ABAP', 'CPI', 'FISCAL', 'OUTRO'];

// Servidores SAP (SIDs) que o cliente pode escolher ao abrir chamado: os sistemas cadastrados para o Conector nos
// contratos vigentes (ativo e dentro do período). Contrato suspenso, cancelado ou vencido não habilita servidor.
async function sistemasDoCliente(cliente_id, empresa_id = 1) {
  if (!cliente_id) return [];
  const r = await pool.query(
    `SELECT conexoes FROM contratos_conector
     WHERE cliente_id = $1 AND empresa_id = $2 AND status = 'ativo'
       AND data_inicio <= CURRENT_DATE AND data_fim >= CURRENT_DATE
     ORDER BY id`, [cliente_id, empresa_id]);
  const porSid = new Map();
  for (const { conexoes } of r.rows) {
    for (const c of Array.isArray(conexoes) ? conexoes : []) {
      const sid = String(c.sid || '').toUpperCase();
      if (sid && !porSid.has(sid)) porSid.set(sid, { sid, descricao: c.descricao || '', mandante: c.mandante || '' });
    }
  }
  return [...porSid.values()].sort((a, b) => a.sid.localeCompare(b.sid));
}

module.exports = { TIPOS_DEMANDA, MODULOS, sistemasDoCliente };
