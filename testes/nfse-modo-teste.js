require('./_ambiente-local');
// Modo teste (QAS) da NFS-e: aprovar dá a nota como emitida sem Asaas; e-mails automáticos só para a cópia.
const jwt = require('jsonwebtoken');
const pool = require('../backend/db');
const email = require('../backend/services/email');
const BASE = 'http://localhost:3000/api/financeiro';
const ok = (c, msg) => console.log(c ? 'OK  ' : 'FAIL', msg);

(async () => {
  const u = (await pool.query(`SELECT id FROM usuarios ORDER BY id LIMIT 1`)).rows[0];
  const token = jwt.sign({ id: u.id, tipo: 'admin_sistema', empresa_id: 1 }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const api = async (m, p, body) => {
    const r = await fetch(BASE + p, { method: m, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: r.status, ...(await r.json()) };
  };

  // Destino dos e-mails no modo teste
  const d1 = email.destinoTeste(['cliente@x.com'], { email_copia: 'eu@marsh.com' }, true);
  ok(d1.to.join() === 'eu@marsh.com' && !d1.cc && d1.prefixo === '[TESTE] ' && d1.aviso.includes('cliente@x.com'), 'modo teste: só para a cópia, avisando o destinatário original');
  ok(email.destinoTeste(['cliente@x.com'], { email_copia: null }, true) === null, 'modo teste sem cópia: não envia');
  const d2 = email.destinoTeste(['cliente@x.com'], { email_copia: 'eu@marsh.com' }, false);
  ok(d2.to.join() === 'cliente@x.com' && d2.cc[0] === 'eu@marsh.com', 'produção: cliente + cópia');

  // Liga o modo teste (guarda a configuração para voltar no fim)
  const antes = await api('GET', '/config');
  const salvar = extra => api('PUT', '/config', { ...antes, impostos: undefined, ...extra });
  const s = await salvar({ nfse_modo: 'teste' });
  ok(s.status === 200 && (await api('GET', '/config')).nfse_modo === 'teste', 'configuração salva em modo teste');
  ok((await api('GET', '/status')).nfse_modo === 'teste', 'status informa o modo');
  ok((await salvar({ nfse_modo: 'xyz' })).status === 400, 'modo inválido recusado');

  // Aprovar um rascunho: nota "emitida (teste)"
  const cli = (await pool.query(`SELECT id FROM clientes WHERE ativo = TRUE ORDER BY id LIMIT 1`)).rows[0];
  const hoje = new Date();
  const comp = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
  const nova = await api('POST', '/faturas', { cliente_id: cli.id, competencia: comp, descricao: 'TESTE QAS', valor: 1000,
    data_vencimento: `${comp}-28`, emitir_nfse: true, codigo_servico: '01.06' });
  const ap = await api('POST', '/faturas/aprovar', { ids: [nova.id] });
  const f = (await pool.query(`SELECT status, nfse_status, nfse_simulada, nfse_asaas_id FROM faturas WHERE id = $1`, [nova.id])).rows[0];
  ok(ap.resultados[0].nfse_status === 'emitida' && f.status === 'aberta' && f.nfse_status === 'emitida' && f.nfse_simulada && !f.nfse_asaas_id,
    'aprovada: nota emitida (teste), sem Asaas');

  // Nota em erro → "Emitir NFS-e" no modo teste resolve
  await pool.query(`UPDATE faturas SET nfse_status = 'erro', nfse_simulada = FALSE, nfse_erro = 'x' WHERE id = $1`, [nova.id]);
  const em = await api('POST', `/faturas/${nova.id}/nfse`);
  ok(em.nfse_status === 'emitida', 'nota com erro: emitir no modo teste marca como emitida');

  // Espelho da nota (botão "Ver a nota"): HTML com a tarja de teste, número TESTE-id e os valores
  const esp = await fetch(`${BASE}/faturas/${nova.id}/nfse/espelho`, { headers: { Authorization: `Bearer ${token}` } });
  const html = await esp.text();
  ok(esp.status === 200 && /text\/html/.test(esp.headers.get('content-type')) && html.includes('MODO TESTE') &&
    html.includes(`TESTE-${nova.id}`) && html.includes('1.000,00') && html.includes('Imprimir / salvar PDF'), 'espelho da nota de teste para imprimir/PDF');

  // Cancelar a fatura cancela a nota simulada sem ir ao Asaas
  const ca = await api('POST', `/faturas/${nova.id}/cancelar`);
  const fc = (await pool.query(`SELECT status, nfse_status FROM faturas WHERE id = $1`, [nova.id])).rows[0];
  ok(ca.status === 200 && fc.status === 'cancelada' && fc.nfse_status === 'cancelada', 'cancelar: fatura e nota simulada canceladas');

  // limpeza: volta a configuração e apaga a fatura
  await salvar({ nfse_modo: antes.nfse_modo || 'producao' });
  await pool.query(`DELETE FROM faturas WHERE id = $1`, [nova.id]);
  ok((await api('GET', '/config')).nfse_modo === (antes.nfse_modo || 'producao'), 'configuração restaurada');
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
