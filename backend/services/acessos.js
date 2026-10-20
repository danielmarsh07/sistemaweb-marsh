/**
 * acessos.js — direitos de acesso aos cursos, com origem identificável (fluxo novo, fase 3).
 *
 * Quem pode abrir um curso é decidido AO VIVO por contratos-conector.sqlCursoLiberado (licença ativa + contrato
 * vigente + benefício; liberação da empresa; ou direito próprio de compra/manual). Este serviço mantém o rastro:
 *   - direitos_acesso: uma linha por (pessoa, curso, origem, referência), com status ativo | revogado | expirado,
 *     quando começou, até quando vale e o motivo do fim;
 *   - matriculas: o histórico acadêmico (nunca apagado quando o acesso acaba);
 *   - auditoria: cada concessão, revogação e restabelecimento.
 * Benefício e liberação são sincronizados a partir das regras vivas (sincronizarUsuario), depois de cada mudança e
 * na rotina horária (expirações por data). Compra e concessão manual são gravadas aqui (conceder / revogarDireito).
 */
const pool = require('../db');
const cc = require('./contratos-conector');
const auditoria = require('./auditoria');

/** Origens válidas agora de benefício e liberação: [{ curso_id, origem, origem_id, descricao, fim }] */
async function origensVivas(usuarioId) {
  const u = (await pool.query('SELECT id, cliente_id, portal_papel FROM usuarios WHERE id = $1', [usuarioId])).rows[0];
  if (!u) return [];
  const beneficio = (await pool.query(
    `SELECT c.id AS curso_id, 'beneficio' AS origem, v.id AS origem_id, to_char(k.data_fim, 'YYYY-MM-DD') AS fim,
            'Licença do Conector ' || v.perfil || ' — contrato nº ' || k.id AS descricao
     FROM contratos_conector_vagas v
     JOIN contratos_conector k ON k.id = v.contrato_id
     JOIN cursos c ON c.ativo AND c.status = 'publicado'
     WHERE v.usuario_id = $1 AND ${cc.VAGA_VIGENTE} AND ${cc.PERFIL_COBRE_CURSO}`, [usuarioId])).rows;
  // Liberação avulsa para a empresa: não vale para quem só usa licença (aluno)
  const liberacao = u.cliente_id ? (await pool.query(
    `SELECT lb.curso_id, 'liberacao' AS origem, lb.cliente_id AS origem_id, to_char(lb.data_fim, 'YYYY-MM-DD') AS fim,
            'Liberado para a empresa' AS descricao
     FROM cursos_liberacoes lb JOIN cursos c ON c.id = lb.curso_id
     WHERE lb.cliente_id = $1 AND c.ativo AND c.status = 'publicado' AND (lb.data_fim IS NULL OR lb.data_fim >= CURRENT_DATE)
       AND lb.contrato_cursos_id IS NULL AND $2 <> 'aluno'`,
    [u.cliente_id, u.portal_papel || ''])).rows : [];
  // Vaga ocupada num contrato de cursos: só a pessoa da vaga
  const contrato = (await pool.query(
    `SELECT c.id AS curso_id, 'contrato' AS origem, cv.id AS origem_id, to_char(kc.data_fim, 'YYYY-MM-DD') AS fim,
            'Contrato de cursos nº ' || kc.id AS descricao
     FROM contratos_cursos_vagas cv JOIN contratos_cursos kc ON kc.id = cv.contrato_id
     JOIN contratos_cursos_itens it ON it.contrato_id = kc.id
     JOIN cursos c ON c.id = it.curso_id AND c.ativo AND c.status = 'publicado'
     WHERE cv.usuario_id = $1 AND ${cc.VAGA_CURSOS_VIGENTE}`, [usuarioId])).rows;
  return [...beneficio, ...liberacao, ...contrato];
}

async function garantirMatricula(usuarioId, cursoId) {
  await pool.query('INSERT INTO matriculas (usuario_id, curso_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [usuarioId, cursoId]);
}

/** Grava (ou reativa) um direito ativo. Registra na auditoria quando é novo ou volta a valer. */
async function gravarAtivo({ usuarioId, cursoId, origem, origemId = 0, descricao = null, fim = null, atorId = null, empresaId = 1 }) {
  const novo = await pool.query(
    `INSERT INTO direitos_acesso (empresa_id, usuario_id, curso_id, origem, origem_id, origem_descricao, fim)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (usuario_id, curso_id, origem, origem_id) DO NOTHING RETURNING id`,
    [empresaId, usuarioId, cursoId, origem, origemId, descricao, fim]);
  let acao = null, id;
  if (novo.rowCount) { acao = 'acesso.concedido'; id = novo.rows[0].id; }
  else {
    const volta = await pool.query(
      `UPDATE direitos_acesso SET status = 'ativo', revogado_em = NULL, motivo = NULL, inicio = NOW(), fim = $5,
         origem_descricao = COALESCE($6, origem_descricao), atualizado_em = NOW()
       WHERE usuario_id = $1 AND curso_id = $2 AND origem = $3 AND origem_id = $4 AND status <> 'ativo' RETURNING id`,
      [usuarioId, cursoId, origem, origemId, fim, descricao]);
    if (volta.rowCount) { acao = 'acesso.restabelecido'; id = volta.rows[0].id; }
    else {
      // Já ativo: só acompanha a validade (ex.: contrato renovado)
      await pool.query(
        `UPDATE direitos_acesso SET fim = $5, origem_descricao = COALESCE($6, origem_descricao), atualizado_em = NOW()
         WHERE usuario_id = $1 AND curso_id = $2 AND origem = $3 AND origem_id = $4 AND fim IS DISTINCT FROM $5::date`,
        [usuarioId, cursoId, origem, origemId, fim, descricao]);
    }
  }
  await garantirMatricula(usuarioId, cursoId);
  if (acao) {
    await auditoria.registrar({ empresa_id: empresaId, usuario_id: atorId, acao, entidade: 'direito_acesso', entidade_id: id,
      depois: { usuario_id: usuarioId, curso_id: cursoId, origem, origem_id: origemId, fim } });
  }
  return acao;
}

async function encerrar(d, status, motivo, atorId = null) {
  const r = await pool.query(
    `UPDATE direitos_acesso SET status = $2, revogado_em = NOW(), motivo = $3, atualizado_em = NOW()
     WHERE id = $1 AND status = 'ativo' RETURNING id`, [d.id, status, motivo]);
  if (r.rowCount) {
    await auditoria.registrar({ empresa_id: d.empresa_id, usuario_id: atorId, acao: status === 'expirado' ? 'acesso.expirado' : 'acesso.revogado',
      entidade: 'direito_acesso', entidade_id: d.id,
      antes: { usuario_id: d.usuario_id, curso_id: d.curso_id, origem: d.origem, origem_id: d.origem_id }, detalhe: motivo });
  }
}

/** Por que um benefício deixou de valer (para o motivo e para diferenciar revogado × expirado). */
async function motivoFimBeneficio(d) {
  const r = (await pool.query(
    `SELECT v.usuario_id, v.estado, v.ativo AS vaga_ativa, k.status, k.data_fim < CURRENT_DATE AS vencido, k.data_inicio > CURRENT_DATE AS futuro,
            EXISTS (SELECT 1 FROM beneficios b WHERE b.produto = 'conector' AND b.perfil = v.perfil AND b.curso_id = $2 AND b.ativo) AS no_beneficio,
            EXISTS (SELECT 1 FROM cursos c WHERE c.id = $2 AND c.ativo AND c.status = 'publicado') AS curso_ok
     FROM contratos_conector_vagas v JOIN contratos_conector k ON k.id = v.contrato_id WHERE v.id = $1`, [d.origem_id, d.curso_id])).rows[0];
  if (!r || !r.vaga_ativa || Number(r.usuario_id) !== Number(d.usuario_id)) return ['revogado', 'Licença do Conector revogada'];
  if (r.estado !== 'ativa') return ['revogado', 'Convite da licença não aceito'];
  if (r.status === 'suspenso') return ['revogado', 'Contrato do Conector suspenso'];
  if (r.status === 'cancelado') return ['revogado', 'Contrato do Conector cancelado'];
  if (r.vencido) return ['expirado', 'Contrato do Conector vencido'];
  if (!r.curso_ok) return ['revogado', 'Curso despublicado'];
  if (!r.no_beneficio) return ['revogado', 'Curso retirado do benefício da licença'];
  return ['revogado', 'Benefício encerrado'];
}

/** Por que o acesso pela vaga de um contrato de cursos acabou. */
async function motivoFimContrato(d) {
  const r = (await pool.query(
    `SELECT v.usuario_id, v.ativo AS vaga_ativa, k.status, (k.data_fim < CURRENT_DATE) AS vencido,
            EXISTS (SELECT 1 FROM contratos_cursos_itens it WHERE it.contrato_id = k.id AND it.curso_id = $2) AS no_contrato
     FROM contratos_cursos_vagas v JOIN contratos_cursos k ON k.id = v.contrato_id WHERE v.id = $1`, [d.origem_id, d.curso_id])).rows[0];
  if (!r || !r.vaga_ativa || Number(r.usuario_id) !== Number(d.usuario_id)) return ['revogado', 'Vaga do contrato de cursos liberada'];
  if (r.status !== 'ativo') return ['revogado', 'Contrato de cursos encerrado'];
  if (r.vencido) return ['expirado', 'Contrato de cursos venceu'];
  if (!r.no_contrato) return ['revogado', 'Curso retirado do contrato de cursos'];
  return ['revogado', 'Acesso pelo contrato de cursos encerrado'];
}

/**
 * Alinha o rastro de benefício/liberação do usuário com as regras vivas: concede o que passou a valer,
 * restabelece o que voltou (ex.: licença renovada) e encerra o que deixou de valer, com o motivo.
 */
async function sincronizarUsuario(usuarioId, { atorId = null } = {}) {
  const vivas = await origensVivas(usuarioId);
  const chave = x => `${x.curso_id}|${x.origem}|${x.origem_id}`;
  const validas = new Set(vivas.map(chave));
  for (const v of vivas) {
    await gravarAtivo({ usuarioId, cursoId: v.curso_id, origem: v.origem, origemId: v.origem_id, descricao: v.descricao, fim: v.fim, atorId });
  }
  const ativos = (await pool.query(
    `SELECT * FROM direitos_acesso WHERE usuario_id = $1 AND status = 'ativo' AND origem IN ('beneficio', 'liberacao', 'contrato')`, [usuarioId])).rows;
  for (const d of ativos) {
    if (validas.has(chave(d))) continue;
    if (d.origem === 'beneficio') {
      const [status, motivo] = await motivoFimBeneficio(d);
      await encerrar(d, status, motivo, atorId);
    } else if (d.origem === 'contrato') {
      const [status, motivo] = await motivoFimContrato(d);
      await encerrar(d, status, motivo, atorId);
    } else {
      const venceu = d.fim && String(d.fim instanceof Date ? d.fim.toISOString() : d.fim).slice(0, 10) < new Date().toISOString().slice(0, 10);
      await encerrar(d, venceu ? 'expirado' : 'revogado', venceu ? 'Liberação para a empresa venceu' : 'Liberação para a empresa encerrada', atorId);
    }
  }
}

/** Sincroniza todos os afetados (rotina horária e mudanças amplas: benefícios, liberações, contrato). */
async function sincronizarTodos({ contratoId = null } = {}) {
  const sql = contratoId
    // Um contrato do Conector: quem está nas vagas e quem tinha benefício por elas
    ? `SELECT usuario_id AS id FROM contratos_conector_vagas WHERE contrato_id = $1 AND usuario_id IS NOT NULL
       UNION
       SELECT d.usuario_id FROM direitos_acesso d JOIN contratos_conector_vagas v ON v.id = d.origem_id
       WHERE d.origem = 'beneficio' AND d.status = 'ativo' AND v.contrato_id = $1`
    // Todos: ocupantes de vaga, usuários de empresas com curso liberado e quem tem benefício/liberação ativos
    : `SELECT usuario_id AS id FROM contratos_conector_vagas WHERE usuario_id IS NOT NULL AND ativo
       UNION
       SELECT u.id FROM usuarios u JOIN cursos_liberacoes lb ON lb.cliente_id = u.cliente_id WHERE u.tipo = 'cliente' AND u.ativo
       UNION
       SELECT usuario_id FROM contratos_cursos_vagas WHERE usuario_id IS NOT NULL AND ativo
       UNION
       SELECT usuario_id FROM direitos_acesso WHERE status = 'ativo' AND origem IN ('beneficio', 'liberacao', 'contrato')`;
  const r = await pool.query(sql, contratoId ? [contratoId] : []);
  for (const { id } of r.rows) await sincronizarUsuario(id);
  return r.rows.length;
}

/** Direito próprio (compra individual ou concessão manual): vale mesmo sem licença do Conector. */
async function conceder({ usuarioId, cursoId, origem = 'manual', origemId = 0, descricao = null, fim = null, atorId = null, empresaId = 1 }) {
  if (!['compra', 'manual'].includes(origem)) throw new Error('Origem inválida para concessão.');
  return gravarAtivo({ usuarioId, cursoId, origem, origemId, descricao, fim, atorId, empresaId });
}

/** Encerra um direito próprio (ex.: estorno da compra). Benefícios de licença acabam pela licença, não por aqui. */
async function revogarDireito({ usuarioId, cursoId, origem, origemId = 0, motivo, atorId = null }) {
  const d = (await pool.query(
    `SELECT * FROM direitos_acesso WHERE usuario_id = $1 AND curso_id = $2 AND origem = $3 AND origem_id = $4`,
    [usuarioId, cursoId, origem, origemId])).rows[0];
  if (d) await encerrar(d, 'revogado', motivo || 'Acesso revogado', atorId);
  return !!d;
}

/** Conclusão do curso no histórico acadêmico (todas as aulas ativas feitas). */
async function atualizarConclusao(usuarioId, cursoId) {
  await garantirMatricula(usuarioId, cursoId);
  await pool.query(
    `UPDATE matriculas m SET concluido_em = CASE WHEN x.total > 0 AND x.feitas >= x.total THEN COALESCE(m.concluido_em, NOW()) END
     FROM (SELECT (SELECT COUNT(*) FROM cursos_aulas a WHERE a.curso_id = $2 AND a.ativo) AS total,
                  (SELECT COUNT(*) FROM cursos_progresso p JOIN cursos_aulas a ON a.id = p.aula_id
                    WHERE a.curso_id = $2 AND a.ativo AND p.usuario_id = $1) AS feitas) x
     WHERE m.usuario_id = $1 AND m.curso_id = $2`, [usuarioId, cursoId]);
}

/** Inclui o curso nos perfis cuja trilha o contém (curso novo ou que mudou de trilha); o cadastro pode ajustar depois. */
async function incluirNoBeneficioPelaTrilha(cursoId, trilha, empresaId = 1) {
  if (!trilha) return 0;
  let n = 0;
  for (const [perfil, d] of Object.entries(cc.PERFIS)) {
    if (!d.trilhas.includes(trilha)) continue;
    const r = await pool.query(
      `INSERT INTO beneficios (empresa_id, produto, perfil, curso_id) VALUES ($1, 'conector', $2, $3) ON CONFLICT DO NOTHING`,
      [empresaId, perfil, cursoId]);
    n += r.rowCount;
  }
  return n;
}

/** Cursos que a pessoa vê agora no portal ("Meus cursos"), com a origem do acesso e o progresso.
 *  Mesma consulta do portal e da ficha do usuário no sistema. */
async function cursosDoUsuario(usuarioId, clienteId) {
  const r = await pool.query(
    `SELECT c.id, c.titulo, c.descricao, c.capa, c.carga_horaria, c.trilha,
       ${cc.sqlViaLiberacao('$1', '$2')} AS via_liberacao,
       ${cc.sqlViaContratoCursos('$2')} AS via_contrato,
       ${cc.sqlViaBeneficio('$2')} AS via_beneficio,
       ${cc.sqlViaCompra('$2')} AS via_compra,
       (SELECT to_char(MAX(d.fim), 'YYYY-MM-DD') FROM direitos_acesso d WHERE d.usuario_id = $2 AND d.curso_id = c.id
         AND d.origem IN ('compra', 'manual') AND d.status = 'ativo') AS compra_fim,
       (SELECT bool_or(d.fim IS NULL) FROM direitos_acesso d WHERE d.usuario_id = $2 AND d.curso_id = c.id
         AND d.origem IN ('compra', 'manual') AND d.status = 'ativo') AS compra_sem_fim,
       (SELECT COUNT(*)::int FROM cursos_aulas a WHERE a.curso_id = c.id AND a.ativo) AS total_aulas,
       (SELECT COUNT(*)::int FROM cursos_progresso p JOIN cursos_aulas a ON a.id = p.aula_id
         WHERE a.curso_id = c.id AND a.ativo AND p.usuario_id = $2) AS concluidas,
       (SELECT MAX(p.concluida_em) FROM cursos_progresso p JOIN cursos_aulas a ON a.id = p.aula_id
         WHERE a.curso_id = c.id AND a.ativo AND p.usuario_id = $2) AS ultima_conclusao
     FROM cursos c WHERE ${cc.sqlCursoLiberado('$1', '$2')}
     ORDER BY c.ordem, c.titulo`,
    [clienteId || null, usuarioId]);
  return r.rows;
}

module.exports = {
  cursosDoUsuario, origensVivas, sincronizarUsuario, sincronizarTodos, conceder, revogarDireito, atualizarConclusao,
  incluirNoBeneficioPelaTrilha, garantirMatricula
};
