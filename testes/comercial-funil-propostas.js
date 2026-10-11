require('./_ambiente-local');
const jwt = require('jsonwebtoken');
const pool = require('../backend/db');
const BASE = 'http://localhost:3000/api';

(async () => {
  const u = (await pool.query(`SELECT id FROM usuarios ORDER BY id LIMIT 1`)).rows[0];
  const token = jwt.sign({ id: u.id, tipo: 'admin_sistema', empresa_id: 1 }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const api = async (m, p, body, auth = true) => {
    const r = await fetch(BASE + p, { method: m, headers: { ...(auth ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) console.log('  !', m, p, r.status, j.erro || j);
    return { status: r.status, ...j };
  };
  const ok = (c, msg) => console.log(c ? 'OK  ' : 'FAIL', msg);
  const criados = { oport: [], cliente: null, contrato: null };

  // 1. Lead do site (público) + honeypot + duplicado
  const l1 = await api('POST', '/publico/lead', { nome: 'TESTE Fulano', email: 'teste.lead@exemplo.com', interesse: 'SAP', mensagem: 'Preciso de AMS' }, false);
  ok(l1.status === 201, 'lead criado');
  const hp = await api('POST', '/publico/lead', { nome: 'Bot', email: 'bot@x.com', mensagem: 'spam', website: 'http://spam' }, false);
  ok(hp.ok && hp.status === 200, 'honeypot ignorado');
  await api('POST', '/publico/lead', { nome: 'TESTE Fulano', email: 'TESTE.lead@exemplo.com', mensagem: 'Segunda mensagem' }, false);
  const leads = (await pool.query(`SELECT id FROM oportunidades WHERE contato_email ILIKE 'teste.lead@exemplo.com'`)).rows;
  ok(leads.length === 1, `lead duplicado vira nota (${leads.length} oportunidade)`);
  criados.oport.push(leads[0].id);
  const bots = (await pool.query(`SELECT COUNT(*)::int n FROM oportunidades WHERE contato_email = 'bot@x.com'`)).rows[0].n;
  ok(bots === 0, 'robô não gravou');

  // 2. Oportunidade prospect manual
  const o = await api('POST', '/comercial/oportunidades', { titulo: 'TESTE AMS SAP', empresa_nome: 'TESTE Empresa X', contato_nome: 'Maria',
    contato_email: 'maria@exemplo.com', origem: 'indicacao', valor_mensal: 8000, valor_unico: 5000 });
  ok(o.id, 'oportunidade criada');
  criados.oport.push(o.id);

  // 3. Proposta: cria, edita, envia (só link)
  const p = await api('POST', `/comercial/oportunidades/${o.id}/propostas`, {});
  const det = await api('GET', `/comercial/propostas/${p.id}`);
  ok(det.itens.length === 2 && /^\d{4}-\d{3}$/.test(det.numero), `proposta ${det.numero} com itens pré-preenchidos`);
  const ed = await api('PUT', `/comercial/propostas/${p.id}`, { titulo: 'TESTE AMS SAP', validade: det.validade, introducao: 'x', escopo: 'y', condicoes: 'z',
    itens: [{ descricao: 'AMS', tipo: 'mensal', quantidade: 1, valor_unitario: 7500 }, { descricao: 'Setup', tipo: 'unico', quantidade: 2, valor_unitario: 2000 }] });
  ok(ed.mensagem, 'proposta editada');
  const env = await api('POST', `/comercial/propostas/${p.id}/enviar`, { enviar_email: false });
  ok(env.link && !env.enviado, 'link gerado');
  const tok = env.link.split('t=')[1];
  const naoEdita = await api('PUT', `/comercial/propostas/${p.id}`, { titulo: 'x', validade: det.validade, itens: [{ descricao: 'a', tipo: 'mensal', valor_unitario: 1 }] });
  ok(naoEdita.status === 400, 'enviada não edita');
  const op1 = await api('GET', `/comercial/oportunidades/${o.id}`);
  ok(op1.etapa === 'proposta' && op1.valor_mensal === 7500 && op1.valor_unico === 4000, `etapa ${op1.etapa}, valores atualizados ${op1.valor_mensal}/${op1.valor_unico}`);

  // 4. Versão 2 substitui a 1 ao enviar
  const v2 = await api('POST', `/comercial/oportunidades/${o.id}/propostas`, { copiar_de: p.id });
  await api('POST', `/comercial/propostas/${v2.id}/enviar`, {});
  const p1 = await api('GET', `/comercial/propostas/${p.id}`);
  const p2 = await api('GET', `/comercial/propostas/${v2.id}`);
  ok(p1.status === 'substituida' && p2.versao === 2 && p2.numero === p1.numero, 'v2 substitui v1');
  const pub1 = await api('GET', `/publico/proposta/${tok}`, null, false);
  ok(pub1.status === 'substituida' && !pub1.pode_responder, 'link da v1 mostra substituída');

  // 5. Cliente aceita a v2 pelo link
  const tok2 = p2.token;
  const pub2 = await api('GET', `/publico/proposta/${tok2}`, null, false);
  ok(pub2.pode_responder && pub2.config.prop_cnpj, 'público vê v2 com cabeçalho');
  const resp = await api('POST', `/publico/proposta/${tok2}/responder`, { acao: 'aceitar', nome: 'Maria', comentario: 'Fechado' }, false);
  ok(/aceita/i.test(resp.mensagem), 'aceite pelo link');
  const dup = await api('POST', `/publico/proposta/${tok2}/responder`, { acao: 'recusar', nome: 'Maria' }, false);
  ok(dup.status === 400, 'não responde duas vezes');
  const op2 = await api('GET', `/comercial/oportunidades/${o.id}`);
  ok(op2.etapa === 'ganha' && op2.data_fechamento, 'oportunidade ganha');
  ok(op2.historico.some(h => /ACEITOU/.test(h.texto)) && op2.historico.some(h => /abriu/.test(h.texto)), 'histórico registra abertura e aceite');

  // 6. Gera contrato → cria cliente
  const gc = await api('POST', `/comercial/oportunidades/${o.id}/gerar-contrato`, { descricao: 'TESTE AMS', descricao_servico: 'AMS SAP', valor: 7500, dia_vencimento: 10, data_inicio: '2026-11-01' });
  ok(gc.cliente_novo && gc.contrato_id, 'contrato + cliente criados');
  criados.cliente = gc.cliente_id; criados.contrato = gc.contrato_id;
  const gc2 = await api('POST', `/comercial/oportunidades/${o.id}/gerar-contrato`, { descricao: 'x', descricao_servico: 'x', valor: 1, data_inicio: '2026-11-01' });
  ok(gc2.status === 400, 'não gera contrato duas vezes');
  const del = await api('DELETE', `/comercial/oportunidades/${o.id}`);
  ok(del.status === 400, 'não exclui oportunidade com contrato');

  // 7. Etapa perdida exige motivo; resumo
  const sem = await api('POST', `/comercial/oportunidades/${leads[0].id}/etapa`, { etapa: 'perdida' });
  ok(sem.status === 400, 'perdida exige motivo');
  await api('POST', `/comercial/oportunidades/${leads[0].id}/etapa`, { etapa: 'perdida', motivo_perda: 'preço' });
  const res = await api('GET', '/comercial/resumo');
  ok(res.ganhas_90 >= 1 && res.perdidas_90 >= 1, `resumo: ${JSON.stringify(res)}`);
  const lista = await (await fetch(`${BASE}/comercial/oportunidades?fechadas_dias=0`, { headers: { Authorization: `Bearer ${token}` } })).json();
  ok(!lista.some(x => x.id === o.id), 'filtro só abertas');
  const lista90 = await (await fetch(`${BASE}/comercial/oportunidades?fechadas_dias=90`, { headers: { Authorization: `Bearer ${token}` } })).json();
  ok(lista90.some(x => x.id === o.id), 'filtro 90 dias mostra a ganha');

  // limpeza
  await pool.query('DELETE FROM oportunidades WHERE id = ANY($1)', [criados.oport]);
  await pool.query('DELETE FROM contratos WHERE id = $1', [criados.contrato]);
  await pool.query('DELETE FROM clientes WHERE id = $1', [criados.cliente]);
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
