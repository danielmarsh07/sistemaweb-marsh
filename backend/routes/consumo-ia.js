/**
 * /api/consumo-ia — Financeiro → Consumo de IA (só administradores).
 *   GET    /                          resumo por provedor (gasto, série de 30 dias, itens do mês, recargas, saldo estimado)
 *   POST   /sincronizar               busca agora o gasto nas APIs de custos (a rotina faz isso a cada 6 horas)
 *   PUT    /:provedor                 { admin_chave?, limite_alerta_usd? }  admin_chave '' remove a chave
 *   POST   /:provedor/recargas        { data, valor_usd, observacao? }
 *   DELETE /recargas/:id
 * A chave de administrador fica cifrada no banco e nunca volta para o navegador (só o prefixo).
 */
const express = require('express');
const router = express.Router();
const pool = require('../db');
const cifra = require('../services/cifra');
const ia = require('../services/consumo-ia');

const ehAdmin = t => t === 'admin_empresa' || t === 'admin_sistema';
const emp = req => req.usuario.empresa_id || 1;

router.use((req, res, next) => {
  if (!ehAdmin(req.usuario.tipo)) return res.status(403).json({ erro: 'Apenas administradores veem o consumo de IA.' });
  next();
});

const provedorValido = (req, res) => {
  if (!ia.PROVEDORES[req.params.provedor]) { res.status(404).json({ erro: 'Provedor desconhecido (openai ou anthropic).' }); return false; }
  return true;
};

router.get('/', async (req, res) => {
  try { res.json({ provedores: await ia.resumo(emp(req)), cifra: cifra.configurada() }); }
  catch (err) { res.status(500).json({ erro: 'Erro ao montar o consumo de IA', detalhe: err.message }); }
});

router.post('/sincronizar', async (req, res) => {
  try {
    const r = await ia.sincronizar(emp(req));
    await ia.avisarSaldoBaixo(emp(req)).catch(() => {});
    res.json({ resultado: r });
  } catch (err) { res.status(500).json({ erro: 'Erro ao sincronizar', detalhe: err.message }); }
});

router.put('/:provedor', async (req, res) => {
  if (!provedorValido(req, res)) return;
  const { provedor } = req.params;
  const b = req.body || {};
  try {
    const sets = [];
    const vals = [emp(req), provedor];
    if (b.admin_chave !== undefined) {
      const chave = String(b.admin_chave || '').trim();
      if (chave) {
        if (!ia.PROVEDORES[provedor].prefixo.test(chave)) {
          return res.status(400).json({ erro: provedor === 'openai'
            ? 'Use a chave de ADMINISTRADOR da OpenAI (começa com sk-admin-), criada em Organization → Admin keys.'
            : 'Use a chave de ADMINISTRADOR da Anthropic (começa com sk-ant-admin), criada em Settings → Admin keys.' });
        }
        if (!cifra.configurada()) return res.status(503).json({ erro: 'Cifra não configurada no servidor (SISTEMA_CHAVE_CIFRA).' });
        vals.push(cifra.cifrar(chave), `${chave.slice(0, 14)}…`);
        sets.push(`admin_chave_cifrada = $${vals.length - 1}`, `chave_prefixo = $${vals.length}`, 'ultimo_erro = NULL', 'ultima_sincronizacao = NULL');
      } else {
        sets.push('admin_chave_cifrada = NULL', 'chave_prefixo = NULL');
      }
    }
    if (b.limite_alerta_usd !== undefined) {
      const lim = b.limite_alerta_usd === '' || b.limite_alerta_usd === null ? null : Number(b.limite_alerta_usd);
      if (lim !== null && !(lim >= 0 && lim <= 100000)) return res.status(400).json({ erro: 'Limite de alerta inválido.' });
      vals.push(lim);
      sets.push(`limite_alerta_usd = $${vals.length}`, 'alerta_enviado_em = NULL');
    }
    if (!sets.length) return res.status(400).json({ erro: 'Nada para salvar.' });
    await pool.query(`INSERT INTO ia_provedores (empresa_id, provedor) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [emp(req), provedor]);
    await pool.query(`UPDATE ia_provedores SET ${sets.join(', ')}, atualizado_em = NOW() WHERE empresa_id = $1 AND provedor = $2`, vals);
    res.json({ mensagem: 'Salvo.' });
  } catch (err) { res.status(500).json({ erro: 'Erro ao salvar', detalhe: err.message }); }
});

router.post('/:provedor/recargas', async (req, res) => {
  if (!provedorValido(req, res)) return;
  const b = req.body || {};
  const data = String(b.data || '').slice(0, 10);
  const valor = Number(b.valor_usd);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || Number.isNaN(Date.parse(data))) return res.status(400).json({ erro: 'Data da recarga inválida.' });
  if (!(valor > 0 && valor <= 1000000)) return res.status(400).json({ erro: 'Valor da recarga inválido (US$).' });
  try {
    await pool.query(
      `INSERT INTO ia_recargas (empresa_id, provedor, data, valor_usd, observacao, criado_por_usuario_id) VALUES ($1, $2, $3, $4, $5, $6)`,
      [emp(req), req.params.provedor, data, valor.toFixed(2), String(b.observacao || '').trim().slice(0, 200) || null, req.usuario.id]);
    res.status(201).json({ mensagem: 'Recarga lançada.' });
  } catch (err) { res.status(500).json({ erro: 'Erro ao lançar a recarga', detalhe: err.message }); }
});

router.delete('/recargas/:id', async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM ia_recargas WHERE id = $1 AND empresa_id = $2 RETURNING id', [req.params.id, emp(req)]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Recarga não encontrada.' });
    res.json({ mensagem: 'Recarga removida.' });
  } catch (err) { res.status(500).json({ erro: 'Erro ao remover a recarga', detalhe: err.message }); }
});

module.exports = router;
