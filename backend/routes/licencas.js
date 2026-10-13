/**
 * /api/licencas — gestão das licenças do conector Claude <-> SAP (requer login).
 *
 * Admin (admin_empresa / admin_sistema): listar, criar, editar, nova chave, cancelar, uso.
 * Admin: máquinas ativadas pelo instalador (listar, revogar, reativar).
 * Cliente: GET /minhas — só as licenças do próprio cliente, sem dados de chave.
 * Logado com licença ativa (ou admin): GET /download — link do instalador do conector.
 * A chave em texto aparece UMA vez (criação / nova chave); no banco fica só o hash.
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const multer = require('multer');
const pool = require('../db');
const storage = require('../services/storage');
const { PLANOS, gerarChave, hashChave, prefixoChave, listaSids, validarConexoes } = require('../services/licenca');

// Instalador do conector (~30 MB com o Python embutido)
const INSTALADOR_MAX_MB = parseInt(process.env.CONECTOR_INSTALADOR_MAX_MB || '100', 10);
const uploadInstalador = multer({ storage: multer.memoryStorage(), limits: { fileSize: INSTALADOR_MAX_MB * 1024 * 1024 } });

const COLUNAS = `l.id, l.cliente_id, l.produto, l.plano, l.max_usuarios, l.sids, l.data_inicio, l.data_fim,
  l.status, l.chave_prefixo, l.ultima_validacao, l.versao_conector, l.observacoes, l.data_criacao,
  l.titular_nome, l.titular_email, l.max_maquinas, l.conexoes`;

const USO_30D = `
  (SELECT COUNT(DISTINCT u.usuario_hash) FROM licencas_uso u
    WHERE u.licenca_id = l.id AND u.data >= CURRENT_DATE - 30) AS usuarios_ativos,
  (SELECT COALESCE(SUM(u.chamadas), 0) FROM licencas_uso u
    WHERE u.licenca_id = l.id AND u.data >= CURRENT_DATE - 30) AS chamadas_30d`;

// Máquinas ativadas (não revogadas) e as que falaram com o servidor nas últimas 24h
const MAQUINAS = `
  (SELECT COUNT(*)::int FROM licencas_ativacoes a
    WHERE a.licenca_id = l.id AND a.revogada = FALSE) AS maquinas_ativas,
  (SELECT COUNT(*)::int FROM licencas_ativacoes a
    WHERE a.licenca_id = l.id AND a.revogada = FALSE
      AND a.ultima_validacao >= NOW() - INTERVAL '24 hours') AS maquinas_online_24h`;

const ehAdmin = tipo => tipo === 'admin_empresa' || tipo === 'admin_sistema';

function somenteAdmin(req, res, next) {
  if (!ehAdmin(req.usuario.tipo)) {
    return res.status(403).json({ erro: 'Apenas administradores podem gerenciar licenças.' });
  }
  next();
}

function validarCampos(body, parcial = false) {
  const { plano, data_fim, sids, max_usuarios, status, titular_nome, titular_email, max_maquinas } = body;
  if (!parcial || plano !== undefined) {
    if (!PLANOS[plano]) return 'Plano inválido (leitura, desenvolvimento ou empresa).';
  }
  if (!parcial || data_fim !== undefined) {
    if (!data_fim || isNaN(Date.parse(data_fim))) return 'Data de fim do contrato é obrigatória.';
  }
  if (sids !== undefined && listaSids(sids).some(s => !/^[A-Z0-9]{3}$/.test(s))) {
    return 'SIDs devem ter 3 letras/números, separados por vírgula (ex.: DEV, QAS).';
  }
  if (max_usuarios !== undefined && max_usuarios !== null && max_usuarios !== '' &&
      !(Number.isInteger(Number(max_usuarios)) && Number(max_usuarios) > 0)) {
    return 'Máximo de usuários deve ser um número inteiro positivo (vazio = ilimitado).';
  }
  if (max_maquinas !== undefined && max_maquinas !== null && max_maquinas !== '' &&
      !(Number.isInteger(Number(max_maquinas)) && Number(max_maquinas) > 0)) {
    return 'Máximo de máquinas deve ser um número inteiro positivo (vazio = ilimitado).';
  }
  if (titular_nome && String(titular_nome).trim().length > 150) {
    return 'Nome do titular deve ter até 150 caracteres.';
  }
  if (titular_email && String(titular_email).trim() &&
      !(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(titular_email).trim()) && String(titular_email).trim().length <= 150)) {
    return 'E-mail do titular inválido.';
  }
  if (status !== undefined && !['ativa', 'suspensa', 'cancelada'].includes(status)) {
    return 'Status inválido (ativa, suspensa ou cancelada).';
  }
  return null;
}

const maxOuNulo = v => (v === undefined || v === null || v === '' ? null : Number(v));
const textoOuNulo = v => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());

// GET /minhas — portal do cliente (antes de /:id)
router.get('/minhas', async (req, res) => {
  if (req.usuario.tipo !== 'cliente' || !req.usuario.cliente_id) return res.json([]);
  try {
    const r = await pool.query(
      `SELECT l.id, l.produto, l.plano, l.max_usuarios, l.sids, l.data_inicio, l.data_fim, l.status,
              l.ultima_validacao, l.titular_nome, l.max_maquinas, l.conexoes, ${USO_30D},
              (SELECT COUNT(*)::int FROM licencas_ativacoes a
                WHERE a.licenca_id = l.id AND a.revogada = FALSE) AS maquinas_ativas
       FROM licencas l
       WHERE l.cliente_id = $1 AND l.ativo = TRUE AND l.status <> 'cancelada'
       ORDER BY l.data_fim DESC`,
      [req.usuario.cliente_id]
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar licenças', detalhe: err.message });
  }
});

// GET /download — link do instalador do conector (admin sempre; cliente só com licença ativa)
router.get('/download', async (req, res) => {
  try {
    if (!ehAdmin(req.usuario.tipo)) {
      if (req.usuario.tipo !== 'cliente' || !req.usuario.cliente_id) {
        return res.status(403).json({ erro: 'Download disponível só para clientes com licença ativa.' });
      }
      const r = await pool.query(
        `SELECT 1 FROM licencas
         WHERE cliente_id = $1 AND ativo = TRUE AND status = 'ativa' AND data_fim >= CURRENT_DATE LIMIT 1`,
        [req.usuario.cliente_id]);
      if (!r.rows.length) return res.status(403).json({ erro: 'Nenhuma licença ativa do conector para esta empresa.' });
    }
    // Instalador publicado pelo painel (storage) tem prioridade: link assinado de poucos minutos,
    // gerado a cada clique. Sem publicação, vale o link fixo das variáveis de ambiente.
    const pub = await pool.query(
      'SELECT versao, storage_key, nome_arquivo FROM conector_instaladores ORDER BY id DESC LIMIT 1');
    if (pub.rows.length && storage.disponivel) {
      const i = pub.rows[0];
      return res.json({ url: await storage.getDownloadUrl(i.storage_key, i.nome_arquivo), versao: i.versao, temporario: true });
    }
    res.json({ url: process.env.CONECTOR_DOWNLOAD_URL || null, versao: process.env.CONECTOR_VERSAO || null });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar o instalador', detalhe: err.message });
  }
});

router.use(somenteAdmin);

// GET /instaladores — versões publicadas (a primeira é a que o portal entrega)
router.get('/instaladores', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, versao, nome_arquivo, tamanho_bytes, sha256, data_publicacao
       FROM conector_instaladores ORDER BY id DESC LIMIT 20`);
    res.json({ storage: storage.disponivel, instaladores: r.rows });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao listar instaladores', detalhe: err.message });
  }
});

// POST /instaladores — publica o zip montado por instalador/montar_pacote.ps1 (campo "arquivo")
router.post('/instaladores', (req, res) => {
  if (!storage.disponivel) {
    return res.status(503).json({ erro: 'Storage (S3/R2) não configurado no servidor: configure as variáveis S3_* no Render.' });
  }
  uploadInstalador.single('arquivo')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ erro: `Arquivo maior que ${INSTALADOR_MAX_MB} MB.` });
      return res.status(400).json({ erro: 'Erro no upload', detalhe: err.message });
    }
    const f = req.file;
    if (!f) return res.status(400).json({ erro: 'Nenhum arquivo enviado.' });
    // Nome gerado pelo montar_pacote.ps1: MarshSAP-Conector-<versão>.zip; conteúdo precisa ser zip (PK\3\4)
    const m = /^MarshSAP-Conector-(\d+\.\d+\.\d+)\.zip$/i.exec(f.originalname || '');
    if (!m) return res.status(400).json({ erro: 'Envie o zip gerado pelo montar_pacote.ps1 (MarshSAP-Conector-<versão>.zip).' });
    if (f.buffer.length < 4 || f.buffer.readUInt32LE(0) !== 0x04034b50) {
      return res.status(400).json({ erro: 'O arquivo não é um zip válido.' });
    }
    const versao = m[1];
    const nome = `MarshSAP-Conector-${versao}.zip`;
    try {
      const key = await storage.uploadNaKey({ key: `conector/${nome}`, buffer: f.buffer, mimeType: 'application/zip' });
      const sha256 = crypto.createHash('sha256').update(f.buffer).digest('hex');
      const r = await pool.query(
        `INSERT INTO conector_instaladores (versao, storage_key, nome_arquivo, tamanho_bytes, sha256, publicado_por_usuario_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, versao, nome_arquivo, tamanho_bytes, sha256, data_publicacao`,
        [versao, key, nome, f.buffer.length, sha256, req.usuario.id]);
      res.status(201).json({ mensagem: `Instalador ${versao} publicado: o portal dos clientes já entrega esta versão.`,
                             instalador: r.rows[0] });
    } catch (e) {
      res.status(500).json({ erro: 'Erro ao publicar o instalador', detalhe: e.message });
    }
  });
});

// GET / — lista
router.get('/', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  try {
    const r = await pool.query(
      `SELECT ${COLUNAS}, COALESCE(c.razao_social, c.nome) AS cliente_nome, ${USO_30D}, ${MAQUINAS}
       FROM licencas l
       JOIN clientes c ON c.id = l.cliente_id
       WHERE l.empresa_id = $1 AND l.ativo = TRUE
       ORDER BY l.status = 'ativa' DESC, l.data_fim ASC`,
      [empresa_id]
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar licenças', detalhe: err.message });
  }
});

// GET /:id/uso — contadores dos últimos 30 dias
router.get('/:id/uso', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  try {
    const lic = await pool.query('SELECT id FROM licencas WHERE id = $1 AND empresa_id = $2 AND ativo = TRUE',
      [req.params.id, empresa_id]);
    if (!lic.rows.length) return res.status(404).json({ erro: 'Licença não encontrada' });

    const porFerramenta = await pool.query(
      `SELECT ferramenta, SUM(chamadas)::int AS chamadas, SUM(recusas)::int AS recusas
       FROM licencas_uso WHERE licenca_id = $1 AND data >= CURRENT_DATE - 30
       GROUP BY ferramenta ORDER BY chamadas DESC`, [req.params.id]);
    const porDia = await pool.query(
      `SELECT data, SUM(chamadas)::int AS chamadas, COUNT(DISTINCT usuario_hash)::int AS usuarios
       FROM licencas_uso WHERE licenca_id = $1 AND data >= CURRENT_DATE - 30
       GROUP BY data ORDER BY data`, [req.params.id]);
    const porSid = await pool.query(
      `SELECT sid, SUM(chamadas)::int AS chamadas FROM licencas_uso
       WHERE licenca_id = $1 AND data >= CURRENT_DATE - 30 GROUP BY sid ORDER BY sid`, [req.params.id]);
    const usuarios = await pool.query(
      `SELECT COUNT(DISTINCT usuario_hash)::int AS n FROM licencas_uso
       WHERE licenca_id = $1 AND data >= CURRENT_DATE - 30`, [req.params.id]);

    res.json({
      por_ferramenta: porFerramenta.rows,
      por_dia: porDia.rows,
      por_sid: porSid.rows,
      usuarios_ativos: usuarios.rows[0].n
    });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar uso da licença', detalhe: err.message });
  }
});

// Licença da empresa logada (para as rotas de máquinas)
async function licencaDaEmpresa(req) {
  const r = await pool.query(
    'SELECT id, max_maquinas FROM licencas WHERE id = $1 AND empresa_id = $2 AND ativo = TRUE',
    [req.params.id, req.usuario.empresa_id || 1]);
  return r.rows[0] || null;
}

// GET /:id/maquinas — máquinas ativadas pelo instalador (revogadas por último)
router.get('/:id/maquinas', async (req, res) => {
  try {
    if (!(await licencaDaEmpresa(req))) return res.status(404).json({ erro: 'Licença não encontrada' });
    const r = await pool.query(
      `SELECT id, nome_maquina, usuario_windows, versao_conector, primeira_ativacao, ultima_validacao,
              revogada, revogada_em
       FROM licencas_ativacoes WHERE licenca_id = $1
       ORDER BY revogada ASC, ultima_validacao DESC NULLS LAST, id`, [req.params.id]);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar máquinas', detalhe: err.message });
  }
});

// POST /:id/maquinas/:mid/revogar — a máquina deixa de ativar/validar e libera a vaga no limite
router.post('/:id/maquinas/:mid/revogar', async (req, res) => {
  try {
    if (!(await licencaDaEmpresa(req))) return res.status(404).json({ erro: 'Licença não encontrada' });
    const r = await pool.query(
      `UPDATE licencas_ativacoes SET revogada = TRUE, revogada_em = NOW()
       WHERE id = $1 AND licenca_id = $2 RETURNING id`, [req.params.mid, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Máquina não encontrada' });
    res.json({ mensagem: 'Máquina revogada. O conector dela para de funcionar em até 7 dias.' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao revogar máquina', detalhe: err.message });
  }
});

// POST /:id/maquinas/:mid/reativar — devolve a máquina, desde que caiba no limite de máquinas
router.post('/:id/maquinas/:mid/reativar', async (req, res) => {
  try {
    const l = await licencaDaEmpresa(req);
    if (!l) return res.status(404).json({ erro: 'Licença não encontrada' });
    const m = await pool.query('SELECT revogada FROM licencas_ativacoes WHERE id = $1 AND licenca_id = $2',
      [req.params.mid, req.params.id]);
    if (!m.rows.length) return res.status(404).json({ erro: 'Máquina não encontrada' });
    if (m.rows[0].revogada && l.max_maquinas) {
      const n = (await pool.query(
        'SELECT COUNT(*)::int AS n FROM licencas_ativacoes WHERE licenca_id = $1 AND revogada = FALSE',
        [req.params.id])).rows[0].n;
      if (n >= l.max_maquinas) {
        return res.status(409).json({ erro: `Limite de ${l.max_maquinas} máquina(s) atingido. Revogue outra ou aumente o limite.` });
      }
    }
    await pool.query(
      'UPDATE licencas_ativacoes SET revogada = FALSE, revogada_em = NULL WHERE id = $1 AND licenca_id = $2',
      [req.params.mid, req.params.id]);
    res.json({ mensagem: 'Máquina reativada.' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao reativar máquina', detalhe: err.message });
  }
});

// POST / — cria licença e devolve a chave (única vez)
router.post('/', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  const erro = validarCampos(req.body);
  if (erro) return res.status(400).json({ erro });
  const { cliente_id, plano, max_usuarios, sids, data_inicio, data_fim, observacoes,
          titular_nome, titular_email, max_maquinas } = req.body;
  const cx = validarConexoes(req.body.conexoes ?? []);
  if (cx.erro) return res.status(400).json({ erro: cx.erro });

  try {
    const cli = await pool.query('SELECT id FROM clientes WHERE id = $1 AND empresa_id = $2 AND ativo = TRUE',
      [cliente_id, empresa_id]);
    if (!cli.rows.length) return res.status(400).json({ erro: 'Cliente inválido.' });

    const chave = gerarChave();
    const r = await pool.query(
      `INSERT INTO licencas (empresa_id, cliente_id, plano, max_usuarios, sids, data_inicio, data_fim,
         status, chave_hash, chave_prefixo, observacoes, criado_por_usuario_id,
         titular_nome, titular_email, max_maquinas, conexoes)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::date, CURRENT_DATE), $7, 'ativa', $8, $9, $10, $11,
         $12, $13, $14, $15::jsonb)
       RETURNING id`,
      [empresa_id, cliente_id, plano, maxOuNulo(max_usuarios), listaSids(sids || 'DEV').join(','),
       data_inicio || null, data_fim, hashChave(chave), prefixoChave(chave), observacoes || null, req.usuario.id,
       textoOuNulo(titular_nome), textoOuNulo(titular_email), maxOuNulo(max_maquinas), JSON.stringify(cx.lista)]
    );
    res.status(201).json({ mensagem: 'Licença criada! Copie a chave agora: ela não será exibida de novo.',
                           id: r.rows[0].id, chave });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao criar licença', detalhe: err.message });
  }
});

// PUT /:id — edita contrato (não mexe na chave)
router.put('/:id', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  const erro = validarCampos(req.body, true);
  if (erro) return res.status(400).json({ erro });
  const cx = req.body.conexoes !== undefined ? validarConexoes(req.body.conexoes) : null;
  if (cx?.erro) return res.status(400).json({ erro: cx.erro });

  try {
    const atual = await pool.query('SELECT * FROM licencas WHERE id = $1 AND empresa_id = $2 AND ativo = TRUE',
      [req.params.id, empresa_id]);
    if (!atual.rows.length) return res.status(404).json({ erro: 'Licença não encontrada' });
    const l = atual.rows[0];
    const b = req.body;

    await pool.query(
      `UPDATE licencas SET plano = $1, max_usuarios = $2, sids = $3, data_inicio = $4, data_fim = $5,
         status = $6, observacoes = $7, atualizado_por_usuario_id = $8, data_atualizacao = NOW(),
         titular_nome = $11, titular_email = $12, max_maquinas = $13, conexoes = $14::jsonb
       WHERE id = $9 AND empresa_id = $10`,
      [b.plano ?? l.plano,
       b.max_usuarios !== undefined ? maxOuNulo(b.max_usuarios) : l.max_usuarios,
       b.sids !== undefined ? listaSids(b.sids).join(',') : l.sids,
       b.data_inicio || l.data_inicio, b.data_fim || l.data_fim,
       b.status ?? l.status, b.observacoes ?? l.observacoes,
       req.usuario.id, req.params.id, empresa_id,
       b.titular_nome !== undefined ? textoOuNulo(b.titular_nome) : l.titular_nome,
       b.titular_email !== undefined ? textoOuNulo(b.titular_email) : l.titular_email,
       b.max_maquinas !== undefined ? maxOuNulo(b.max_maquinas) : l.max_maquinas,
       JSON.stringify(cx ? cx.lista : (l.conexoes || []))]
    );
    res.json({ mensagem: 'Licença atualizada!' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar licença', detalhe: err.message });
  }
});

// POST /:id/nova-chave — invalida a chave antiga e gera outra (única exibição)
router.post('/:id/nova-chave', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  try {
    const chave = gerarChave();
    const r = await pool.query(
      `UPDATE licencas SET chave_hash = $1, chave_prefixo = $2, atualizado_por_usuario_id = $3,
         data_atualizacao = NOW()
       WHERE id = $4 AND empresa_id = $5 AND ativo = TRUE RETURNING id`,
      [hashChave(chave), prefixoChave(chave), req.usuario.id, req.params.id, empresa_id]
    );
    if (!r.rows.length) return res.status(404).json({ erro: 'Licença não encontrada' });
    res.json({ mensagem: 'Nova chave gerada. A anterior deixou de funcionar.', chave });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao gerar nova chave', detalhe: err.message });
  }
});

// DELETE /:id — cancela (exclusão lógica; o histórico de uso é mantido)
router.delete('/:id', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  try {
    const r = await pool.query(
      `UPDATE licencas SET status = 'cancelada', ativo = FALSE, atualizado_por_usuario_id = $1,
         data_atualizacao = NOW()
       WHERE id = $2 AND empresa_id = $3 RETURNING id`,
      [req.usuario.id, req.params.id, empresa_id]
    );
    if (!r.rows.length) return res.status(404).json({ erro: 'Licença não encontrada' });
    res.json({ mensagem: 'Licença cancelada.' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao cancelar licença', detalhe: err.message });
  }
});

module.exports = router;
