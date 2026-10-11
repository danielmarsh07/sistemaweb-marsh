require('./_ambiente-local');
// Senhas (convite, esqueci, definir, alterar, regra) e alertas (erro 500 vira alerta agrupado, saúde, rotas admin).
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pool = require('../backend/db');
const BASE = 'http://localhost:3000/api';

(async () => {
  const adm = (await pool.query(`SELECT id FROM usuarios WHERE tipo IN ('admin_sistema','admin_empresa') AND ativo ORDER BY id LIMIT 1`)).rows[0];
  const tokAdm = jwt.sign({ id: adm.id, tipo: 'admin_empresa', empresa_id: 1 }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const req = async (m, p, body, tok) => {
    const r = await fetch(BASE + p, { method: m, headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const ok = (c, msg) => console.log(c ? 'OK  ' : 'FAIL', msg);
  const email = `teste.senha.${Date.now()}@teste.local`;

  // Regra de senha
  const fraca = await req('POST', '/usuarios', { nome: 'TESTE Fraca', email: 'fraca@teste.local', senha: 'abcdefgh', tipo: 'tecnico' }, tokAdm);
  ok(fraca.status === 400 && /números/.test(fraca.body.erro), `senha sem número recusada (${fraca.body.erro})`);
  const curta = await req('POST', '/usuarios', { nome: 'TESTE Curta', email: 'curta@teste.local', senha: 'ab1', tipo: 'tecnico' }, tokAdm);
  ok(curta.status === 400, 'senha curta recusada');

  // Convite: cria sem senha; o token fica gravado (o e-mail está desligado no local)
  const conv = await req('POST', '/usuarios', { nome: 'TESTE Convidado', email, tipo: 'tecnico', enviar_convite: true }, tokAdm);
  ok(conv.status === 201 && conv.body.convite_enviado === false, `convite: usuário criado (${conv.body.mensagem})`);
  const uid = conv.body.usuario.id;
  const tk = (await pool.query(`SELECT tipo, expira_em > NOW() + INTERVAL '71 hours' AS prazo FROM usuarios_tokens WHERE usuario_id = $1 AND usado_em IS NULL`, [uid])).rows;
  ok(tk.length === 1 && tk[0].tipo === 'convite' && tk[0].prazo, 'token de convite gravado (72 h)');
  const login0 = await req('POST', '/auth/login', { email, senha: 'qualquer1' });
  ok(login0.status === 401, 'convidado ainda não entra');

  // Simula o link do e-mail: token conhecido gravado como hash
  const bruto = crypto.randomBytes(32).toString('hex');
  await pool.query(`UPDATE usuarios_tokens SET usado_em = NOW() WHERE usuario_id = $1`, [uid]);
  await pool.query(`INSERT INTO usuarios_tokens (usuario_id, tipo, token_hash, expira_em) VALUES ($1, 'convite', $2, NOW() + INTERVAL '1 hour')`,
    [uid, crypto.createHash('sha256').update(bruto).digest('hex')]);
  const link = await req('GET', `/auth/link/${bruto}`);
  ok(link.status === 200 && link.body.tipo === 'convite' && link.body.email === email, 'link válido mostra nome e e-mail');
  const ruim = await req('POST', '/auth/definir-senha', { token: bruto, senha: 'semnumero' });
  ok(ruim.status === 400, 'definir senha fraca pelo link recusado');
  const def = await req('POST', '/auth/definir-senha', { token: bruto, senha: 'NovaSenha123' });
  ok(def.status === 200, `senha criada pelo link (${def.body.mensagem})`);
  const reuso = await req('POST', '/auth/definir-senha', { token: bruto, senha: 'OutraSenha456' });
  ok(reuso.status === 400, 'link não vale duas vezes');
  const login1 = await req('POST', '/auth/login', { email: email.toUpperCase(), senha: 'NovaSenha123' });
  ok(login1.status === 200 && login1.body.token, 'login com a senha nova (e-mail em maiúsculas também)');

  // Esqueci minha senha: resposta igual para e-mail que existe e que não existe
  const e1 = await req('POST', '/auth/esqueci', { email });
  const e2 = await req('POST', '/auth/esqueci', { email: 'naoexiste@teste.local' });
  ok(e1.status === 200 && e2.status === 200 && e1.body.mensagem === e2.body.mensagem, 'esqueci: mesma resposta (não revela cadastro)');
  const tr = (await pool.query(`SELECT COUNT(*)::int n FROM usuarios_tokens WHERE usuario_id = $1 AND tipo = 'redefinir' AND usado_em IS NULL`, [uid])).rows[0].n;
  ok(tr === 1, 'esqueci: token de redefinição criado');

  // Alterar a própria senha
  const tokU = login1.body.token;
  const errada = await req('PUT', '/usuarios/me/senha', { senha_atual: 'errada', nova_senha: 'Trocada789' }, tokU);
  ok(errada.status === 400, 'alterar senha com a atual errada recusado');
  const troca = await req('PUT', '/usuarios/me/senha', { senha_atual: 'NovaSenha123', nova_senha: 'Trocada789' }, tokU);
  ok(troca.status === 200 && (await req('POST', '/auth/login', { email, senha: 'Trocada789' })).status === 200, 'alterar a própria senha funciona');

  // Reenviar convite (admin): e-mail desligado no local → 400 com explicação
  const reenv = await req('POST', `/usuarios/${uid}/convite`, null, tokAdm);
  ok(reenv.status === 400 && /e-mail/.test(reenv.body.erro), 'reenviar convite explica quando o e-mail está desligado');

  // Alertas: erro 500 vira alerta agrupado
  await pool.query(`DELETE FROM alertas_sistema WHERE chave LIKE 'teste:%' OR chave LIKE 'http:GET /api/financeiro/fluxo-caixa%'`);
  const { registrarAlerta } = require('../backend/services/alertas');
  await registrarAlerta({ chave: 'teste:x', titulo: 'TESTE alerta', detalhe: 'primeira' });
  await registrarAlerta({ chave: 'teste:x', titulo: 'TESTE alerta', detalhe: 'segunda' });
  const al = (await pool.query(`SELECT ocorrencias, detalhe FROM alertas_sistema WHERE chave = 'teste:x' AND NOT lido`)).rows;
  ok(al.length === 1 && al[0].ocorrencias === 2 && al[0].detalhe === 'segunda', 'mesma chave agrupa ocorrências');
  // provoca um 500 real: força erro de SQL num parâmetro (mês 13 passa pela regex? não — usamos rota inexistente com erro interno)
  const lista = await req('GET', '/alertas', null, tokAdm);
  ok(lista.status === 200 && lista.body.alertas.some(a => a.titulo === 'TESTE alerta') && lista.body.nao_lidos >= 1, 'GET /alertas lista para admin');
  ok((await req('GET', '/alertas', null, tokU)).status === 403, 'técnico não vê alertas');
  const alId = lista.body.alertas.find(a => a.titulo === 'TESTE alerta').id;
  await req('POST', `/alertas/${alId}/lido`, null, tokAdm);
  await registrarAlerta({ chave: 'teste:x', titulo: 'TESTE alerta', detalhe: 'voltou' });
  const reab = (await pool.query(`SELECT COUNT(*)::int n FROM alertas_sistema WHERE chave = 'teste:x'`)).rows[0].n;
  ok(reab === 2, 'depois de resolvido, se voltar abre alerta novo');

  // Erro 500 de verdade vira alerta (middleware)
  await pool.query(`ALTER TABLE contas_financeiras RENAME TO contas_financeiras_tmp`);
  const r500 = await req('GET', '/financeiro/contas-financeiras', null, tokAdm);
  await pool.query(`ALTER TABLE contas_financeiras_tmp RENAME TO contas_financeiras`);
  await new Promise(r => setTimeout(r, 500));
  const a500 = (await pool.query(`SELECT titulo, detalhe FROM alertas_sistema WHERE chave = 'http:GET /api/financeiro/contas-financeiras' AND NOT lido`)).rows[0];
  ok(r500.status === 500 && a500 && /contas_financeiras/.test(a500.detalhe), `erro 500 vira alerta (${a500 && a500.titulo})`);

  // Saúde
  const saude = await req('GET', '/saude');
  ok(saude.status === 200 && saude.body.banco === 'ok', 'GET /api/saude responde com o banco ok');

  // limpeza
  await pool.query(`DELETE FROM alertas_sistema WHERE chave LIKE 'teste:%' OR chave = 'http:GET /api/financeiro/contas-financeiras'`);
  await pool.query(`DELETE FROM usuarios WHERE id = $1`, [uid]);
  await pool.end();
})().catch(async e => { console.error(e); process.exit(1); });
