const express = require('express');
const router = express.Router();
const multer = require('multer');
const pool = require('../db');
const storage = require('../services/storage');

// Limite e tipos permitidos
const MAX_MB = parseInt(process.env.ANEXO_MAX_MB || '10', 10);
const TIPOS_PERMITIDOS = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml',
  'application/pdf',
  'application/zip', 'application/x-zip-compressed',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain', 'text/csv', 'text/x-log',
  'application/json'
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB * 1024 * 1024 }
});

// Middleware: valida que o chamado pertence à empresa (e ao cliente, se for cliente)
async function checarChamado(req, res, next) {
  const empresa_id = req.usuario.empresa_id || 1;
  const isCliente = req.usuario.tipo === 'cliente';
  let q = 'SELECT id, cliente_id FROM chamados WHERE id = $1 AND empresa_id = $2 AND ativo = TRUE';
  const params = [req.params.chamadoId, empresa_id];
  if (isCliente) {
    if (!req.usuario.cliente_id) return res.status(403).json({ erro: 'Usuário não vinculado a um cliente.' });
    q += ' AND cliente_id = $3';
    params.push(req.usuario.cliente_id);
  }
  const r = await pool.query(q, params);
  if (r.rows.length === 0) return res.status(404).json({ erro: 'Chamado não encontrado' });
  req.chamado = r.rows[0];
  next();
}

// POST /api/chamados/:chamadoId/anexos — upload de arquivo
router.post('/:chamadoId/anexos', checarChamado, (req, res) => {
  if (!storage.disponivel) {
    return res.status(503).json({ erro: 'Anexos ainda não configurados. Solicite ao administrador.' });
  }

  upload.single('arquivo')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ erro: `Arquivo maior que ${MAX_MB} MB` });
      }
      return res.status(400).json({ erro: 'Erro no upload', detalhe: err.message });
    }
    if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado.' });

    if (!TIPOS_PERMITIDOS.has(req.file.mimetype)) {
      return res.status(400).json({ erro: `Tipo de arquivo não permitido: ${req.file.mimetype}` });
    }

    try {
      const key = await storage.upload({
        chamadoId: req.params.chamadoId,
        nomeOriginal: req.file.originalname,
        buffer: req.file.buffer,
        mimeType: req.file.mimetype
      });

      const result = await pool.query(
        `INSERT INTO chamados_anexos (chamado_id, empresa_id, usuario_id, nome_original, storage_key, tamanho_bytes, mime_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, nome_original, tamanho_bytes, mime_type, data_upload`,
        [
          req.params.chamadoId, req.usuario.empresa_id || 1, req.usuario.id,
          req.file.originalname, key, req.file.size, req.file.mimetype
        ]
      );

      res.status(201).json({ mensagem: 'Anexo enviado!', anexo: result.rows[0] });
    } catch (e) {
      res.status(500).json({ erro: 'Falha ao salvar anexo', detalhe: e.message });
    }
  });
});

// GET /api/chamados/:chamadoId/anexos/:anexoId/download — gera URL temporária
router.get('/:chamadoId/anexos/:anexoId/download', checarChamado, async (req, res) => {
  if (!storage.disponivel) return res.status(503).json({ erro: 'Storage indisponível' });

  try {
    const r = await pool.query(
      `SELECT storage_key, nome_original FROM chamados_anexos
       WHERE id = $1 AND chamado_id = $2`,
      [req.params.anexoId, req.params.chamadoId]
    );
    if (r.rows.length === 0) return res.status(404).json({ erro: 'Anexo não encontrado' });

    const url = await storage.getDownloadUrl(r.rows[0].storage_key);
    res.json({ url, nome_original: r.rows[0].nome_original });
  } catch (e) {
    res.status(500).json({ erro: 'Erro ao gerar link', detalhe: e.message });
  }
});

// DELETE /api/chamados/:chamadoId/anexos/:anexoId — remove anexo (uploader ou admin)
router.delete('/:chamadoId/anexos/:anexoId', checarChamado, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT storage_key, usuario_id FROM chamados_anexos
       WHERE id = $1 AND chamado_id = $2`,
      [req.params.anexoId, req.params.chamadoId]
    );
    if (r.rows.length === 0) return res.status(404).json({ erro: 'Anexo não encontrado' });

    const isAdmin = req.usuario.tipo === 'admin_empresa' || req.usuario.tipo === 'admin_sistema';
    const isUploader = r.rows[0].usuario_id === req.usuario.id;
    if (!isAdmin && !isUploader) {
      return res.status(403).json({ erro: 'Apenas o autor ou um administrador pode remover.' });
    }

    if (storage.disponivel) {
      try { await storage.remove(r.rows[0].storage_key); } catch { /* segue mesmo se o S3 falhar */ }
    }
    await pool.query(`DELETE FROM chamados_anexos WHERE id = $1`, [req.params.anexoId]);
    res.json({ mensagem: 'Anexo removido.' });
  } catch (e) {
    res.status(500).json({ erro: 'Erro ao remover anexo', detalhe: e.message });
  }
});

module.exports = router;
