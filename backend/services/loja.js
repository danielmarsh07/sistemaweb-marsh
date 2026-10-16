/**
 * loja.js — venda de cursos (fluxo novo, fase 4).
 *
 * Página da oferta → cadastro (nome, e-mail, CPF/CNPJ) → pedido → cobrança no Asaas (o comprador escolhe PIX, boleto ou
 * cartão) → webhook confirma → acesso ao curso (direitos_acesso origem 'compra') → e-mail com o link de acesso.
 * Oferta em modo 'teste' usa o sandbox do Asaas: nada é cobrado e não gera fatura; serve para homologar o fluxo.
 * Oferta tipo 'conector' (fase 4b): o comprador escolhe as licenças por perfil; preço = tabela de Preços Conector SAP (anual);
 * pago, nasce o contrato do Conector (origem 'loja', vigência de 12 meses a partir do pagamento), quem comprou vira o
 * administrador da empresa e, em produção, a cobrança anual (a 1ª anuidade já sai paga; as próximas, pela renovação).
 * Regras: um pedido pendente por pessoa e oferta; cupom com uso reservado no pedido (e devolvido se ele não for pago);
 * a confirmação é idempotente (webhook repetido não libera duas vezes); estorno e contestação tiram o acesso comprado.
 */
const crypto = require('crypto');
const pool = require('../db');
const asaas = require('./asaas');
const acessos = require('./acessos');
const auditoria = require('./auditoria');
const senhas = require('./senhas');
const email = require('./email');
const { validarDocumento, apenasDigitos } = require('./validacao');

class ErroLoja extends Error {}
const r2 = v => Math.round(Number(v) * 100) / 100;
const hojeBrasilia = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const emailValido = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 150;
const somaDias = (iso, dias) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + dias); return d.toISOString().slice(0, 10); };
const somaMeses = (iso, meses) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + meses); return d.toISOString().slice(0, 10); };
const BASE_URL = () => process.env.APP_URL || 'https://marshconsultoria.com.br';
const DIAS_PARA_PAGAR = 3;

/** Preço de agora: promocional dentro do período da promoção, senão o cheio. */
function precoAtual(o, hoje = hojeBrasilia()) {
  const promo = o.preco_promocional !== null && o.preco_promocional !== undefined
    && (!o.promo_inicio || String(o.promo_inicio).slice(0, 10) <= hoje) && (!o.promo_fim || String(o.promo_fim).slice(0, 10) >= hoje);
  return { preco: r2(promo ? o.preco_promocional : o.preco), cheio: r2(o.preco), promocional: promo };
}

function emVenda(o, hoje = hojeBrasilia()) {
  return o.ativa && (!o.venda_inicio || String(o.venda_inicio).slice(0, 10) <= hoje) && (!o.venda_fim || String(o.venda_fim).slice(0, 10) >= hoje);
}

async function ofertaPorSlug(slug) {
  return (await pool.query(
`SELECT o.*, c.titulo AS curso_titulo, c.status AS curso_status, (o.tipo = 'conector' OR c.ativo IS TRUE) AS curso_ativo, c.carga_horaria,
            (SELECT COUNT(*)::int FROM cursos_aulas a WHERE a.curso_id = c.id AND a.ativo) AS aulas
     FROM ofertas o LEFT JOIN cursos c ON c.id = o.curso_id WHERE o.slug = $1`, [String(slug || '').slice(0, 80)])).rows[0] || null;
}

/** Desconto do cupom para a oferta (não reserva). Devolve { cupom, desconto } ou lança ErroLoja. */
async function avaliarCupom(db, codigo, oferta, preco, hoje = hojeBrasilia()) {
  const c = (await db.query(`SELECT * FROM cupons WHERE UPPER(codigo) = UPPER($1) AND empresa_id = $2`, [String(codigo).trim(), oferta.empresa_id])).rows[0];
  const valido = c && c.ativo && (!c.oferta_id || c.oferta_id === oferta.id)
    && (!c.inicio || String(c.inicio).slice(0, 10) <= hoje) && (!c.fim || String(c.fim).slice(0, 10) >= hoje)
    && (!c.usos_max || c.usos < c.usos_max);
  if (!valido) throw new ErroLoja('Cupom inválido, esgotado ou fora do prazo.');
  const desconto = c.tipo === 'percentual' ? r2(preco * Math.min(100, Number(c.valor)) / 100) : Math.min(preco, r2(c.valor));
  return { cupom: c, desconto };
}

/** Cliente (quem paga) pelo documento: acha o ativo com os mesmos dígitos ou cria (PF ou PJ). */
async function acharOuCriarCliente(db, { empresaId, nome, documento, mail, telefone }) {
  const dig = apenasDigitos(documento);
  const ex = (await db.query(
    `SELECT * FROM clientes WHERE empresa_id = $1 AND ativo AND regexp_replace(COALESCE(cpf_cnpj, ''), '[^0-9]', '', 'g') = $2 LIMIT 1`,
    [empresaId, dig])).rows[0];
  if (ex) return ex;
  const fmt = dig.length === 11 ? dig.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4') : dig.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return (await db.query(
    `INSERT INTO clientes (empresa_id, nome, razao_social, cpf_cnpj, email, email_financeiro, telefone, status, ativo, observacoes)
     VALUES ($1, $2, $2, $3, $4, $4, $5, 'ativo', TRUE, 'Cadastrado pela loja de cursos.') RETURNING *`,
    [empresaId, nome, fmt, mail, telefone || null])).rows[0];
}

/**
 * Pessoa que vai estudar, pelo e-mail. Quem já tem conta no portal continua com ela (mesmo sendo de outra empresa:
 * um usuário pode ser corporativo e aluno individual). Conta nova = usuário do portal com papel "aluno".
 */
async function acharOuCriarAluno(db, { empresaId, nome, mail, clienteId }) {
  const ex = (await db.query('SELECT * FROM usuarios WHERE LOWER(email) = LOWER($1)', [mail])).rows[0];
  if (ex) {
    if (ex.tipo !== 'cliente') throw new ErroLoja('Este e-mail é de um usuário da equipe. Use outro e-mail para comprar.');
    if (!ex.ativo) await db.query('UPDATE usuarios SET ativo = TRUE WHERE id = $1', [ex.id]);
    return { usuario: ex, novo: false };
  }
  const u = (await db.query(
    `INSERT INTO usuarios (nome, email, senha, empresa_id, tipo, cliente_id, ativo, portal_papel)
     VALUES ($1, $2, $3, $4, 'cliente', $5, TRUE, 'aluno') RETURNING *`,
    [nome, mail, await senhas.senhaProvisoria(), empresaId, clienteId])).rows[0];
  return { usuario: u, novo: true };
}

/**
 * Quem compra licenças do Conector administra o contrato no portal: a conta precisa ser do mesmo cliente (CPF/CNPJ do pedido).
 * Conta nova = usuário do portal com papel "gestor".
 */
async function acharOuCriarAdministrador(db, { empresaId, nome, mail, clienteId }) {
  const ex = (await db.query('SELECT * FROM usuarios WHERE LOWER(email) = LOWER($1)', [mail])).rows[0];
  if (ex) {
    if (ex.tipo !== 'cliente') throw new ErroLoja('Este e-mail é de um usuário da equipe. Use outro e-mail para comprar.');
    if (Number(ex.cliente_id) !== Number(clienteId)) {
      throw new ErroLoja('Este e-mail já está ligado a outra empresa no portal. Use outro e-mail ou o CPF/CNPJ dessa empresa.');
    }
    if (!ex.ativo) await db.query('UPDATE usuarios SET ativo = TRUE WHERE id = $1', [ex.id]);
    return { usuario: ex, novo: false };
  }
  const u = (await db.query(
    `INSERT INTO usuarios (nome, email, senha, empresa_id, tipo, cliente_id, ativo, portal_papel)
     VALUES ($1, $2, $3, $4, 'cliente', $5, TRUE, 'gestor') RETURNING *`,
    [nome, mail, await senhas.senhaProvisoria(), empresaId, clienteId])).rows[0];
  return { usuario: u, novo: true };
}

/** Licenças pedidas: { q: { abap, funcional, ambos }, total } — de 1 a 200 no total. */
function lerVagasPedido(vagas) {
  const cc = require('./contratos-conector');
  let r;
  try { r = cc.lerQuantidades(vagas || {}); } catch (err) { throw new ErroLoja(err.message); }
  if (r.total < 1) throw new ErroLoja('Escolha ao menos 1 licença.');
  if (r.total > 200) throw new ErroLoja('Para mais de 200 licenças, fale com a Marsh.');
  return r;
}

/** Preço anual das licenças pela tabela de Preços Conector SAP. */
async function precoLicencas(oferta, q) {
  return require('./contratos-conector').precoAnualSugerido(pool, oferta.empresa_id, q);
}

/**
 * Cria o pedido (ou devolve o pendente que já existe para a mesma pessoa e oferta) e a cobrança no Asaas.
 * Devolve { pedido, link } — link = página de pagamento do Asaas (ou da confirmação, se for gratuito).
 */
async function criarPedido({ slug, nome, email: mail, documento, telefone, cupom: codigoCupom, origem, vagas, eu_perfil: euPerfil }) {
  nome = String(nome || '').trim().slice(0, 150);
  mail = String(mail || '').trim().toLowerCase();
  if (!nome) throw new ErroLoja('Informe o seu nome.');
  if (!emailValido(mail)) throw new ErroLoja('E-mail inválido.');
  if (!validarDocumento(documento)) throw new ErroLoja('CPF ou CNPJ inválido.');
  const oferta = await ofertaPorSlug(slug);
  if (!oferta || !emVenda(oferta) || !oferta.curso_ativo) throw new ErroLoja('Esta oferta não está disponível.');
  if (oferta.modo === 'producao' && !asaas.modoConfigurado('producao')) throw new ErroLoja('Pagamento indisponível no momento. Tente mais tarde.');
  if (oferta.modo === 'teste' && !asaas.modoConfigurado('teste')) throw new ErroLoja('Ambiente de teste do pagamento não configurado.');
  const conector = oferta.tipo === 'conector';
  const lic = conector ? lerVagasPedido(vagas) : null;
  if (conector && euPerfil && !(lic.q[euPerfil] > 0)) throw new ErroLoja('Para usar uma licença você mesmo, inclua ao menos uma do perfil escolhido.');

  const db = await pool.connect();
  let pedido, aluno, existente = false;
  try {
    await db.query('BEGIN');
    const cliente = await acharOuCriarCliente(db, { empresaId: oferta.empresa_id, nome, documento, mail, telefone });
    aluno = conector
      ? await acharOuCriarAdministrador(db, { empresaId: oferta.empresa_id, nome, mail, clienteId: cliente.id })
      : await acharOuCriarAluno(db, { empresaId: oferta.empresa_id, nome, mail, clienteId: cliente.id });
    // Já tem este curso comprado valendo por mais de 30 dias: não vende de novo
    const jaTem = conector ? null : (await db.query(
      `SELECT to_char(fim, 'DD/MM/YYYY') AS fim FROM direitos_acesso WHERE usuario_id = $1 AND curso_id = $2 AND origem = 'compra'
         AND status = 'ativo' AND (fim IS NULL OR fim > CURRENT_DATE + 30) LIMIT 1`, [aluno.usuario.id, oferta.curso_id])).rows[0];
    if (jaTem) throw new ErroLoja(`Você já tem este curso${jaTem.fim ? ` até ${jaTem.fim}` : ''}. Entre no portal para estudar.`);
    // Pedido pendente da mesma pessoa para a mesma oferta: devolve o mesmo (sem criar outro nem outra cobrança)
    let pend = (await db.query(`SELECT * FROM pedidos WHERE usuario_id = $1 AND oferta_id = $2 AND status = 'pendente' FOR UPDATE`,
      [aluno.usuario.id, oferta.id])).rows[0];
    // Licenças: se mudou a quantidade, o pendente antigo é cancelado e sai um novo com o valor certo
    if (pend && conector && (JSON.stringify(pend.itens) !== JSON.stringify(lic.q) || (pend.eu_perfil || null) !== (euPerfil || null))) {
      await db.query(`UPDATE pedidos SET status = 'cancelado', erro = 'Substituído por um pedido com outras licenças', atualizado_em = NOW() WHERE id = $1`, [pend.id]);
      if (pend.cupom_id) await db.query('UPDATE cupons SET usos = GREATEST(usos - 1, 0) WHERE id = $1', [pend.cupom_id]);
      if (pend.asaas_payment_id) {
        const antigo = pend;
        setImmediate(() => asaas.cancelarCobrancaModo(antigo.asaas_payment_id, antigo.modo).catch(() => {}));
      }
      pend = null;
    }
    if (pend && pend.link_pagamento) {
      await db.query('COMMIT');
      return { pedido: pend, link: pend.link_pagamento, existente: true };
    }
    const preco = conector ? await precoLicencas(oferta, lic.q) : precoAtual(oferta).preco;
    let desconto = 0, cupom = null;
    if (codigoCupom && String(codigoCupom).trim()) {
      ({ cupom, desconto } = await avaliarCupom(db, codigoCupom, oferta, preco));
      // Reserva o uso; dois pedidos ao mesmo tempo não passam do limite
      const res = await db.query(`UPDATE cupons SET usos = usos + 1 WHERE id = $1 AND (usos_max IS NULL OR usos < usos_max) RETURNING id`, [cupom.id]);
      if (!res.rowCount) throw new ErroLoja('Este cupom acabou de esgotar.');
    }
    const valor = r2(Math.max(0, preco - desconto));
    if (pend) {
      // Pendente sem cobrança (falha anterior no Asaas): reaproveita o pedido
      pedido = (await db.query(
        `UPDATE pedidos SET valor_original = $2, desconto = $3, valor = $4, cupom_id = $5, cliente_id = $6, erro = NULL, atualizado_em = NOW()
         WHERE id = $1 RETURNING *`, [pend.id, preco, desconto, valor, cupom && cupom.id, cliente.id])).rows[0];
      existente = true;
    } else {
      pedido = (await db.query(
        `INSERT INTO pedidos (empresa_id, oferta_id, curso_id, usuario_id, cliente_id, cupom_id, valor_original, desconto, valor, modo, origem, token, vencimento,
           itens, eu_perfil)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
        [oferta.empresa_id, oferta.id, oferta.curso_id, aluno.usuario.id, cliente.id, cupom && cupom.id, preco, desconto, valor,
         oferta.modo, origem ? String(origem).slice(0, 80) : null, crypto.randomBytes(24).toString('hex'), somaDias(hojeBrasilia(), DIAS_PARA_PAGAR),
         lic && JSON.stringify(lic.q), conector ? (euPerfil || null) : null])).rows[0];
    }
    await auditoria.registrar({ empresa_id: oferta.empresa_id, usuario_id: aluno.usuario.id, acao: 'pedido.criado', entidade: 'pedido',
      entidade_id: pedido.id, depois: { oferta: oferta.slug, valor, desconto, cupom: cupom && cupom.codigo, modo: oferta.modo } }, db);
    await db.query('COMMIT');
    pedido._cliente = cliente;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    if (err.code === '23505' && err.constraint === 'uq_pedidos_pendente') throw new ErroLoja('Seu pedido já está sendo criado. Aguarde um instante e tente de novo.');
    throw err;
  } finally {
    db.release();
  }

  const retorno = `${BASE_URL()}/curso.html?o=${encodeURIComponent(oferta.slug)}&pedido=${pedido.token}`;
  // Oferta gratuita: sem cobrança, o acesso sai na hora
  if (Number(pedido.valor) === 0) {
    await confirmarPagamento(pedido.id, { forma: 'gratuito' });
    return { pedido, link: retorno, existente };
  }
  try {
    const cobranca = await asaas.criarCobrancaPedido({
      pedido, cliente: pedido._cliente, vencimento: pedido.vencimento instanceof Date ? pedido.vencimento.toISOString().slice(0, 10) : String(pedido.vencimento).slice(0, 10),
      descricao: `${oferta.titulo} — pedido #${pedido.id}`
    });
    const link = cobranca.invoiceUrl || cobranca.bankSlipUrl;
    await pool.query(`UPDATE pedidos SET asaas_payment_id = $2, link_pagamento = $3, atualizado_em = NOW() WHERE id = $1`, [pedido.id, cobranca.id, link]);
    return { pedido: { ...pedido, asaas_payment_id: cobranca.id, link_pagamento: link }, link, existente };
  } catch (err) {
    await pool.query(`UPDATE pedidos SET erro = $2, atualizado_em = NOW() WHERE id = $1`, [pedido.id, err.message.slice(0, 500)]);
    require('./alertas').registrarAlerta({ chave: 'loja:cobranca', titulo: 'Loja: falha ao criar a cobrança no Asaas', detalhe: `pedido ${pedido.id}: ${err.message}` });
    throw new ErroLoja('Não conseguimos gerar o pagamento agora. Tente de novo em alguns minutos.');
  }
}

/** Devolve o uso do cupom de um pedido que não foi pago. */
async function devolverCupom(pedido) {
  if (pedido.cupom_id) await pool.query('UPDATE cupons SET usos = GREATEST(usos - 1, 0) WHERE id = $1', [pedido.cupom_id]);
}

/**
 * Pagamento confirmado: libera o curso (compra, com validade da oferta), registra a receita (produção) e avisa a pessoa.
 * Idempotente: só o primeiro aviso de pagamento faz efeito.
 */
async function confirmarPagamento(pedidoId, { forma = null, valorPago = null } = {}) {
  const r = await pool.query(
    `UPDATE pedidos SET status = 'pago', pago_em = NOW(), forma_pagamento = COALESCE($2, forma_pagamento), atualizado_em = NOW()
     WHERE id = $1 AND status IN ('pendente', 'vencido') RETURNING *`, [pedidoId, forma]);
  if (!r.rowCount) return false;
  const p = r.rows[0];
  const o = (await pool.query('SELECT * FROM ofertas WHERE id = $1', [p.oferta_id])).rows[0];
  if (o.tipo === 'conector') return confirmarLicencas(p, o, { forma, valorPago });
  const fim = o.duracao_meses ? somaMeses(hojeBrasilia(), o.duracao_meses) : null;
  await pool.query('UPDATE pedidos SET acesso_fim = $2 WHERE id = $1', [p.id, fim]);
  await acessos.conceder({ usuarioId: p.usuario_id, cursoId: p.curso_id, origem: 'compra', origemId: p.id,
    descricao: `Compra — pedido #${p.id}${p.modo === 'teste' ? ' (teste)' : ''}`, fim, empresaId: p.empresa_id });
  // Receita no financeiro (só produção): fatura avulsa já paga, sem nota automática (emitir pelo botão quando quiser)
  if (p.modo === 'producao' && Number(p.valor) > 0) {
    const f = await pool.query(
      `INSERT INTO faturas (empresa_id, cliente_id, competencia, descricao, valor, data_vencimento, status, data_pagamento, valor_pago,
         forma_pagamento, emitir_nfse, observacoes)
       VALUES ($1, $2, date_trunc('month', CURRENT_DATE)::date, $3, $4, CURRENT_DATE, 'paga', CURRENT_DATE, $5, $6, FALSE, $7) RETURNING id`,
      [p.empresa_id, p.cliente_id, `${o.titulo} (curso online)`, p.valor, valorPago || p.valor, forma || 'asaas', `Pedido #${p.id} da loja.`]);
    await pool.query('UPDATE pedidos SET fatura_id = $2 WHERE id = $1', [p.id, f.rows[0].id]);
  }
  await auditoria.registrar({ empresa_id: p.empresa_id, acao: 'pedido.pago', entidade: 'pedido', entidade_id: p.id,
    depois: { valor: Number(p.valor), forma, acesso_fim: fim } });
  // E-mail: quem ainda não criou a senha recebe o link para criar; quem já tem, o aviso de curso liberado
  try {
    const u = (await pool.query('SELECT id, nome, email FROM usuarios WHERE id = $1', [p.usuario_id])).rows[0];
    const precisaSenha = (await pool.query(
      `SELECT NOT EXISTS (SELECT 1 FROM usuarios_tokens WHERE usuario_id = $1 AND usado_em IS NOT NULL AND tipo IN ('convite', 'redefinir'))
              AND NOT EXISTS (SELECT 1 FROM auditoria WHERE entidade = 'usuario' AND entidade_id = $1 AND acao LIKE 'usuario.senha_definida%') AS precisa`,
      [u.id])).rows[0].precisa;
    const link = precisaSenha ? (await senhas.enviarLink(u, 'convite').catch(() => ({}))).link : null;
    await email.enviarCursoLiberado({ nome: u.nome, email: u.email, curso: o.titulo, fim, linkSenha: link, teste: p.modo === 'teste' });
  } catch (err) { console.error('[loja] e-mail:', err.message); }
  return true;
}

/**
 * Licenças pagas: contrato do Conector (vagas por perfil, 12 meses a partir de hoje), quem comprou vira administrador,
 * (produção) cobrança anual com a 1ª anuidade já paga, e — se pediu — uma licença para o próprio comprador.
 */
async function confirmarLicencas(p, o, { forma, valorPago }) {
  const cc = require('./contratos-conector');
  const q = p.itens || {};
  const inicio = hojeBrasilia();
  const fim = somaMeses(inicio, o.duracao_meses || 12);
  const db = await pool.connect();
  let k, financeiro = null;
  try {
    await db.query('BEGIN');
    k = (await db.query(
      `INSERT INTO contratos_conector (empresa_id, cliente_id, gestor_usuario_id, data_inicio, data_fim, max_sids, observacoes, origem)
       VALUES ($1, $2, $3, $4, $5, 3, $6, 'loja') RETURNING *`,
      [p.empresa_id, p.cliente_id, p.usuario_id, inicio, fim, `Compra pela loja — pedido #${p.id}${p.modo === 'teste' ? ' (TESTE: sem cobrança)' : ''}.`])).rows[0];
    await cc.criarVagas(db, k.id, q);
    await db.query(`INSERT INTO clientes_admins (cliente_id, usuario_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [p.cliente_id, p.usuario_id]);
    await db.query(`UPDATE usuarios SET portal_papel = 'gestor' WHERE id = $1 AND COALESCE(portal_papel, 'aluno') = 'aluno'`, [p.usuario_id]);
    if (p.modo === 'producao') {
      financeiro = await cc.criarCobrancaAnual(db, k, { valor: p.valor, dia_vencimento: 10, usuarioId: null });
      // 1ª anuidade: já paga pela loja. Fica ligada ao contrato na competência do início, então o faturamento não cobra de novo.
      const fat = await db.query(
        `INSERT INTO faturas (empresa_id, cliente_id, contrato_id, competencia, descricao, valor, data_vencimento, status, data_pagamento, valor_pago,
           forma_pagamento, emitir_nfse, observacoes)
         VALUES ($1, $2, $3, date_trunc('month', $4::date)::date, $5, $6, $4::date, 'paga', $4::date, $7, $8, FALSE, $9) RETURNING id`,
        [p.empresa_id, p.cliente_id, financeiro.id, inicio, `Licenciamento anual do Conector SAP Marsh (${o.titulo})`, p.valor,
         valorPago || p.valor, forma || 'asaas', `Pedido #${p.id} da loja.`]);
      await db.query('UPDATE pedidos SET fatura_id = $2 WHERE id = $1', [p.id, fat.rows[0].id]);
    }
    await db.query('UPDATE pedidos SET contrato_conector_id = $2, acesso_fim = $3 WHERE id = $1', [p.id, k.id, fim]);
    await auditoria.registrar({ empresa_id: p.empresa_id, acao: 'pedido.pago', entidade: 'pedido', entidade_id: p.id,
      depois: { valor: Number(p.valor), forma, contrato_conector_id: k.id, licencas: q } }, db);
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    // O pagamento já entrou: volta o pedido para "pago sem contrato" visível e avisa para resolver à mão
    await pool.query(`UPDATE pedidos SET erro = $2 WHERE id = $1`, [p.id, `Pago, mas o contrato não foi criado: ${err.message}`.slice(0, 500)]);
    require('./alertas').registrarAlerta({ chave: `loja:licencas:${p.id}`, titulo: 'Loja: licenças pagas sem contrato criado', detalhe: `pedido ${p.id}: ${err.message}` });
    return true;
  } finally { db.release(); }
  // O comprador quis usar uma licença também
  if (p.eu_perfil) {
    await cc.ocuparVaga(k, { perfil: p.eu_perfil }, { eu: true }, p.usuario_id, p.usuario_id)
      .then(() => require('./acessos').sincronizarUsuario(p.usuario_id))
      .catch(err => console.error('[loja] licença do comprador:', err.message));
  }
  try {
    const u = (await pool.query('SELECT id, nome, email FROM usuarios WHERE id = $1', [p.usuario_id])).rows[0];
    const jaTemSenha = (await pool.query(
      `SELECT EXISTS (SELECT 1 FROM auditoria WHERE entidade = 'usuario' AND entidade_id = $1 AND acao LIKE 'usuario.senha_definida%')
              OR EXISTS (SELECT 1 FROM usuarios_tokens WHERE usuario_id = $1 AND usado_em IS NOT NULL) AS tem`, [u.id])).rows[0].tem;
    const link = jaTemSenha ? null : (await senhas.enviarLink(u, 'convite').catch(() => ({}))).link;
    await email.enviarLicencasLiberadas({ nome: u.nome, email: u.email, q, fim, linkSenha: link, teste: p.modo === 'teste' });
  } catch (err) { console.error('[loja] e-mail licenças:', err.message); }
  return true;
}

/** Fim do acesso comprado (estorno/contestação) ou do pedido (cancelado/vencido/recusado). */
async function mudarStatus(pedidoId, status, motivo) {
  const p = (await pool.query('SELECT * FROM pedidos WHERE id = $1', [pedidoId])).rows[0];
  if (!p || p.status === status) return false;
  const permitido = {
    estornado: ['pago', 'contestado'], contestado: ['pago'], vencido: ['pendente'],
    cancelado: ['pendente', 'vencido'], expirado: ['pendente', 'vencido'], recusado: ['pendente', 'vencido']
  }[status] || [];
  if (!permitido.includes(p.status)) return false;
  const r = await pool.query(`UPDATE pedidos SET status = $2, erro = COALESCE($3, erro), atualizado_em = NOW() WHERE id = $1 AND status = $4 RETURNING id`,
    [p.id, status, motivo || null, p.status]);
  if (!r.rowCount) return false;
  if (['estornado', 'contestado'].includes(status) && p.contrato_conector_id) {
    const novo = status === 'estornado' ? 'cancelado' : 'suspenso';
    await pool.query(`UPDATE contratos_conector SET status = $2, data_atualizacao = NOW() WHERE id = $1`, [p.contrato_conector_id, novo]);
    await pool.query(`UPDATE contratos SET status = $2, data_atualizacao = NOW() WHERE contrato_conector_id = $1`,
      [p.contrato_conector_id, status === 'estornado' ? 'encerrado' : 'suspenso']);
    await require('./certificacao').sincronizarContrato(p.contrato_conector_id).catch(() => {});
    await acessos.sincronizarTodos({ contratoId: p.contrato_conector_id }).catch(() => {});
  }
  if (['estornado', 'contestado'].includes(status) && p.curso_id) {
    await acessos.revogarDireito({ usuarioId: p.usuario_id, cursoId: p.curso_id, origem: 'compra', origemId: p.id,
      motivo: status === 'estornado' ? 'Pagamento estornado' : 'Pagamento contestado' });
    if (p.fatura_id) await pool.query(`UPDATE faturas SET observacoes = COALESCE(observacoes, '') || $2 WHERE id = $1`, [p.fatura_id, `\nPedido ${status} em ${hojeBrasilia()}.`]);
  }
  if (['cancelado', 'expirado', 'recusado'].includes(status)) await devolverCupom(p);
  await auditoria.registrar({ empresa_id: p.empresa_id, acao: `pedido.${status}`, entidade: 'pedido', entidade_id: p.id, antes: { status: p.status }, detalhe: motivo || null });
  return true;
}

/** Evento de cobrança do Asaas para um pedido. modo = do token do webhook (teste não mexe em pedido real e vice-versa). */
async function aplicarEvento(evento, payment, modo) {
  const ref = /^pedido-(\d+)$/.exec(payment.externalReference || '');
  const p = (await pool.query('SELECT * FROM pedidos WHERE asaas_payment_id = $1 OR id = $2 LIMIT 1', [payment.id, ref ? Number(ref[1]) : 0])).rows[0];
  if (!p) return 'ignorado';
  if (p.modo !== modo) return 'modo_diferente';
  if (evento === 'PAYMENT_REPROVED_BY_RISK_ANALYSIS') return (await mudarStatus(p.id, 'recusado', 'Pagamento recusado na análise do Asaas')) ? 'recusado' : 'sem_mudanca';
  const st = evento === 'PAYMENT_DELETED' ? 'cancelado' : asaas.STATUS_PEDIDO[payment.status];
  if (st === 'pago') return (await confirmarPagamento(p.id, { forma: (payment.billingType || '').toLowerCase() || null, valorPago: payment.value })) ? 'pago' : 'sem_mudanca';
  if (st && st !== 'pendente') return (await mudarStatus(p.id, st, null)) ? st : 'sem_mudanca';
  return 'sem_mudanca';
}

/** Rotina: pedido não pago 7 dias depois do vencimento expira (cobrança cancelada no Asaas, cupom devolvido). */
async function expirarPedidos() {
  const r = await pool.query(
    `SELECT id, asaas_payment_id, modo FROM pedidos WHERE status IN ('pendente', 'vencido') AND vencimento < CURRENT_DATE - 7 LIMIT 100`);
  for (const p of r.rows) {
    if (p.asaas_payment_id) await asaas.cancelarCobrancaModo(p.asaas_payment_id, p.modo).catch(() => {});
    await mudarStatus(p.id, 'expirado', 'Prazo para pagamento encerrado');
  }
  return r.rows.length;
}

module.exports = {
  lerVagasPedido, precoLicencas,
  ErroLoja, precoAtual, emVenda, ofertaPorSlug, avaliarCupom, criarPedido, confirmarPagamento, mudarStatus,
  aplicarEvento, expirarPedidos, devolverCupom, DIAS_PARA_PAGAR
};
