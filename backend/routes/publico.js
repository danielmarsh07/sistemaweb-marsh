/**
 * /api/publico — sem login.
 *  POST /lead                         formulário de contato do site → oportunidade em "Lead" + aviso aos admins
 *  GET  /proposta/:token              proposta para o cliente ver (link enviado pela Marsh)
 *  POST /proposta/:token/responder    cliente aceita ou recusa
 *  GET  /certificado/:codigo          valida um certificado do Conector (MC-XXXXXXXX)
 *  GET  /pacote/:token                instalador do Conector com a licença da pessoa (token curto do portal)
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const pool = require('../db');
const email = require('../services/email');
const com = require('../services/comercial');
const jwt = require('jsonwebtoken');
const storage = require('../services/storage');
const cifra = require('../services/cifra');
const pacote = require('../services/pacote-instalador');
const { PERFIS } = require('../services/contratos-conector');

const EMPRESA_SITE = 1; // o site institucional é da Marsh
const texto = (v, max) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim().slice(0, max));
const emailValido = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ''));

const limiteLead = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false,
  message: { erro: 'Muitas mensagens em pouco tempo. Tente de novo mais tarde.' } });
const limiteProposta = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { erro: 'Muitas requisições. Aguarde um instante.' } });

router.post('/lead', limiteLead, async (req, res) => {
  const b = req.body || {};
  if (texto(b.website, 10)) return res.json({ ok: true }); // honeypot: robô preencheu o campo escondido
  const nome = texto(b.nome, 255);
  const mail = texto(b.email, 255);
  const mensagem = texto(b.mensagem, 5000);
  if (!nome || !emailValido(mail) || !mensagem) return res.status(400).json({ erro: 'Preencha nome, e-mail e mensagem.' });
  const interesse = texto(b.interesse, 60);
  try {
    // Mesmo e-mail com lead ainda aberto: só acrescenta a mensagem ao histórico
    const existente = await pool.query(
      `SELECT id FROM oportunidades WHERE empresa_id = $1 AND LOWER(contato_email) = LOWER($2)
         AND etapa IN ('lead', 'qualificacao', 'proposta', 'negociacao') ORDER BY id DESC LIMIT 1`, [EMPRESA_SITE, mail]);
    let id;
    if (existente.rows.length) {
      id = existente.rows[0].id;
      await com.registrarHistorico(id, 'nota', `Nova mensagem pelo site${interesse ? ` (${interesse})` : ''}:\n${mensagem}`);
      await pool.query('UPDATE oportunidades SET data_atualizacao = NOW() WHERE id = $1', [id]);
    } else {
      const r = await pool.query(
        `INSERT INTO oportunidades (empresa_id, titulo, contato_nome, contato_email, contato_telefone, interesse,
           origem, etapa, probabilidade, mensagem_origem)
         VALUES ($1, $2, $3, $4, $5, $6, 'site', 'lead', $7, $8) RETURNING id`,
        [EMPRESA_SITE, `${interesse || 'Contato'} — ${nome}`.slice(0, 255), nome, mail, texto(b.telefone, 50),
         interesse, com.ETAPAS.lead.prob, mensagem]);
      id = r.rows[0].id;
      await com.registrarHistorico(id, 'sistema', 'Lead recebido pelo formulário do site.');
    }
    email.notificarAdminsComercial({
      empresa_id: EMPRESA_SITE, assunto: `Novo contato pelo site: ${nome}`, titulo: 'Novo contato pelo site',
      linhas: [['Nome', nome], ['E-mail', mail], ['Telefone', texto(b.telefone, 50)], ['Interesse', interesse], ['Mensagem', mensagem]],
      link: com.linkSistema()
    }).catch(() => {});
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('[publico] lead:', err.message);
    res.status(500).json({ erro: 'Não foi possível registrar a mensagem.' });
  }
});

const tokenValido = t => /^[a-f0-9]{48}$/.test(String(t || ''));

async function propostaPorToken(token) {
  // Rascunho nunca é exposto; versões substituídas aparecem com aviso
  return com.carregarProposta(`p.token = $1 AND p.status <> 'rascunho'`, [token]);
}

router.get('/proposta/:token', limiteProposta, async (req, res) => {
  if (!tokenValido(req.params.token)) return res.status(404).json({ erro: 'Proposta não encontrada.' });
  try {
    const p = await propostaPorToken(req.params.token);
    if (!p) return res.status(404).json({ erro: 'Proposta não encontrada.' });
    if (!p.data_visualizacao && p.status === 'enviada') {
      await pool.query('UPDATE propostas SET data_visualizacao = NOW() WHERE id = $1', [p.id]);
      await com.registrarHistorico(p.oportunidade_id, 'proposta', `Cliente abriu a proposta ${p.numero} pelo link.`);
    }
    const config = await com.configProposta(p.empresa_id);
    res.json({
      numero: p.numero, versao: p.versao, titulo: p.titulo, introducao: p.introducao, escopo: p.escopo,
      condicoes: p.condicoes, itens: p.itens, total_mensal: p.total_mensal, total_unico: p.total_unico,
      validade: p.validade, expirada: p.expirada, status: p.status, data_envio: p.data_envio,
      data_resposta: p.data_resposta, resposta_nome: p.resposta_nome,
      destinatario: p.destinatario, contato_nome: p.contato_nome, config,
      pode_responder: p.status === 'enviada' && !p.expirada
    });
  } catch (err) {
    console.error('[publico] proposta:', err.message);
    res.status(500).json({ erro: 'Erro ao carregar a proposta.' });
  }
});

router.post('/proposta/:token/responder', limiteProposta, async (req, res) => {
  const { acao } = req.body || {};
  const nome = texto((req.body || {}).nome, 255);
  const comentario = texto((req.body || {}).comentario, 2000);
  if (!tokenValido(req.params.token)) return res.status(404).json({ erro: 'Proposta não encontrada.' });
  if (!['aceitar', 'recusar'].includes(acao)) return res.status(400).json({ erro: 'Resposta inválida.' });
  if (!nome) return res.status(400).json({ erro: 'Informe seu nome.' });
  try {
    const p = await propostaPorToken(req.params.token);
    if (!p) return res.status(404).json({ erro: 'Proposta não encontrada.' });
    if (p.status !== 'enviada') return res.status(400).json({ erro: 'Esta proposta já foi respondida ou substituída.' });
    if (p.expirada) return res.status(400).json({ erro: 'Esta proposta está vencida. Fale com a Marsh para receber uma atualizada.' });
    const status = acao === 'aceitar' ? 'aceita' : 'recusada';
    const r = await pool.query(
      `UPDATE propostas SET status = $1, data_resposta = NOW(), resposta_nome = $2, resposta_comentario = $3,
         data_atualizacao = NOW() WHERE id = $4 AND status = 'enviada' RETURNING id`, [status, nome, comentario, p.id]);
    if (!r.rows.length) return res.status(400).json({ erro: 'Esta proposta já foi respondida.' });
    await com.registrarHistorico(p.oportunidade_id, 'proposta',
      `Cliente ${status === 'aceita' ? 'ACEITOU' : 'recusou'} a proposta ${p.numero} pelo link (${nome}).${comentario ? `\n"${comentario}"` : ''}`);
    if (status === 'aceita') await com.mudarEtapa(p.oportunidade_id, 'ganha', null);
    else await pool.query('UPDATE oportunidades SET data_atualizacao = NOW() WHERE id = $1', [p.oportunidade_id]);
    email.notificarAdminsComercial({
      empresa_id: p.empresa_id,
      assunto: `Proposta ${p.numero} ${status === 'aceita' ? 'ACEITA' : 'recusada'} — ${p.destinatario || ''}`,
      titulo: status === 'aceita' ? 'Proposta aceita!' : 'Proposta recusada',
      linhas: [['Proposta', `${p.numero} — ${p.titulo}`], ['Cliente', p.destinatario], ['Respondido por', nome], ['Comentário', comentario]],
      link: com.linkSistema()
    }).catch(() => {});
    res.json({ mensagem: status === 'aceita'
      ? 'Proposta aceita! Obrigado. Entraremos em contato para os próximos passos.'
      : 'Resposta registrada. Obrigado pelo retorno; vamos entrar em contato.' });
  } catch (err) {
    console.error('[publico] responder:', err.message);
    res.status(500).json({ erro: 'Não foi possível registrar a resposta.' });
  }
});

// ===== Certificado do Conector: validação pública pelo código (quem recebe o certificado confere aqui) =====
router.get('/certificado/:codigo', limiteProposta, async (req, res) => {
  const codigo = String(req.params.codigo || '').trim().toUpperCase();
  if (!/^MC-[A-Z0-9]{8}$/.test(codigo)) return res.status(404).json({ erro: 'Certificado não encontrado.' });
  try {
    const r = await pool.query(
      `SELECT codigo, nome, perfil, cursos, emitido_em FROM certificados WHERE codigo = $1`, [codigo]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Certificado não encontrado.' });
    const c = r.rows[0];
    res.json({ ...c, perfil_nome: PERFIS[c.perfil] ? PERFIS[c.perfil].nome : c.perfil });
  } catch (err) {
    console.error('[publico] certificado:', err.message);
    res.status(500).json({ erro: 'Erro ao consultar o certificado.' });
  }
});

// ===== Instalador do Conector já configurado (link curto gerado no portal: /contratos-conector/eu/vagas/:id/pacote) =====
// O zip publicado ganha um licenca.json com a chave da pessoa: o instalador a lê e pula a tela da chave.
router.get('/pacote/:token', limiteProposta, async (req, res) => {
  let dados;
  try { dados = jwt.verify(String(req.params.token || ''), process.env.JWT_SECRET); } catch { dados = null; }
  if (!dados || dados.uso !== 'pacote') return res.status(410).send('Link do instalador vencido. Volte ao portal e clique em "Baixar instalador" de novo.');
  try {
    const l = (await pool.query(
      `SELECT * FROM licencas WHERE id = $1 AND usuario_id = $2 AND ativo AND status = 'ativa' AND data_fim >= CURRENT_DATE`,
      [dados.licenca_id, dados.usuario_id])).rows[0];
    const inst = (await pool.query('SELECT versao, storage_key, nome_arquivo FROM conector_instaladores ORDER BY id DESC LIMIT 1')).rows[0];
    if (!l || !inst || !storage.disponivel) return res.status(404).send('Instalador indisponível. Fale com a Marsh.');
    let chave = null;
    if (l.chave_cifrada && cifra.configurada()) { try { chave = cifra.decifrar(l.chave_cifrada); } catch { chave = null; } }
    // Sem a chave guardada não há o que embutir: entrega o pacote normal (a pessoa digita a chave)
    if (!chave) return res.redirect(await storage.getDownloadUrl(inst.storage_key, inst.nome_arquivo));
    const licenca = JSON.stringify({
      chave, titular: l.titular_nome, plano: l.plano, sids: l.sids, gerado_em: new Date().toISOString()
    }, null, 2);
    await pacote.enviarPacote(res, {
      key: inst.storage_key, nomeDownload: inst.nome_arquivo, nomeArquivo: 'licenca.json', conteudo: licenca });
  } catch (err) {
    console.error('[publico] pacote:', err.message);
    if (!res.headersSent) res.status(500).send('Não foi possível montar o instalador. Tente de novo em instantes.');
    else res.destroy(err);
  }
});

module.exports = router;
