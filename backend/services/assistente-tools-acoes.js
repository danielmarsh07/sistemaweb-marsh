// ============================================================================
// Ações por voz da Ivy (gravam no banco) + consultas de Treinamentos.
//
//   criar_oportunidade, mover_oportunidade, anotar_oportunidade  (comercial)
//   agendar_post, cancelar_post                                   (Instagram)
//   resumo_treinamentos, progresso_treinamento                    (cursos)
//
// Ações que gravam exigem usuario_confirmou=true: sem isso a tool NÃO grava e devolve
// { precisa_confirmar, resumo } para a Ivy ler o resumo e perguntar. Mesmas regras das telas:
// mudarEtapa/registrarHistorico (services/comercial) e lerData/erroParaAgendar (services/marketing).
// ============================================================================

const pool = require('../db');
const com = require('./comercial');
const mk = require('./marketing');

const NOME_CLIENTE = `COALESCE(NULLIF(c.nome_fantasia, ''), c.razao_social, c.nome)`;
const FUSO = mk.FUSO || 'America/Sao_Paulo';
const brl = n => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const quandoBr = d => new Date(d).toLocaleString('pt-BR', { timeZone: FUSO, weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const fn = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } }
});
const CONFIRMAR = { type: 'boolean', description: 'true só depois de ler o resumo ao usuário e ele confirmar ("sim", "pode", "confirma").' };
const precisaConfirmar = resumo => ({ precisa_confirmar: true, resumo, instrucao: 'Leia o resumo ao usuário e pergunte se confirma. Só chame de novo com usuario_confirmou=true depois do "sim".' });

// Acha UM registro pelo nome: exato primeiro, depois aproximado. { item } | { erro, opcoes }
async function acharUm(sql, params, termo, rotulo, campoNome = 'nome') {
  const r = await pool.query(sql, [...params, termo, `%${termo}%`]);
  const exatos = r.rows.filter(x => String(x[campoNome] || '').toLowerCase() === termo.toLowerCase());
  if (exatos.length === 1) return { item: exatos[0] };
  if (r.rows.length === 1) return { item: r.rows[0] };
  if (r.rows.length > 1) return { erro: `Há mais de ${rotulo} parecido com "${termo}". Pergunte qual.`, opcoes: r.rows.slice(0, 6).map(x => x[campoNome]) };
  return { erro: `Não encontrei ${rotulo.replace(/^uma? /, '')} "${termo}".` };
}

// ---------------------------------------------------------------------------
// COMERCIAL
// ---------------------------------------------------------------------------

const SQL_OPORTUNIDADE = `
  SELECT o.id, o.titulo AS nome, o.etapa, COALESCE(${NOME_CLIENTE}, o.empresa_nome) AS empresa, o.valor_mensal::float AS valor_mensal
  FROM oportunidades o LEFT JOIN clientes c ON c.id = o.cliente_id
  WHERE o.empresa_id = $1 AND (LOWER(o.titulo) = LOWER($2) OR o.titulo ILIKE $3 OR o.empresa_nome ILIKE $3 OR ${NOME_CLIENTE} ILIKE $3)
  ORDER BY (o.etapa IN ('lead','qualificacao','proposta','negociacao')) DESC, o.data_atualizacao DESC LIMIT 8`;

const criar_oportunidade = {
  definition: fn('criar_oportunidade',
    'Cria uma oportunidade no funil de vendas. Para um cliente já cadastrado, passe "cliente" (nome); para um prospect, "empresa" e, se souber, "contato". Sem usuario_confirmou=true não grava: devolve o resumo para confirmar.',
    {
      titulo: { type: 'string', description: 'Ex.: "AMS SAP para a Empresa X". Se o usuário não disser, monte a partir do interesse e da empresa.' },
      cliente: { type: 'string', description: 'Nome de um cliente já cadastrado.' },
      empresa: { type: 'string', description: 'Empresa do prospect (quando não é cliente cadastrado).' },
      contato: { type: 'string' }, contato_email: { type: 'string' }, contato_telefone: { type: 'string' },
      interesse: { type: 'string', description: 'Ex.: Conector SAP, AMS, fábrica ABAP, curso.' },
      origem: { type: 'string', enum: Object.keys(com.ORIGENS) },
      etapa: { type: 'string', enum: com.ETAPAS_ABERTAS, description: 'Padrão: lead.' },
      valor_mensal: { type: 'number' }, valor_unico: { type: 'number' },
      previsao_fechamento: { type: 'string', description: 'AAAA-MM-DD' },
      observacoes: { type: 'string' },
      usuario_confirmou: CONFIRMAR
    }, ['titulo']),
  run: async (ctx, a) => {
    let cliente = null;
    if (a.cliente) {
      const r = await acharUm(
        `SELECT c.id, ${NOME_CLIENTE} AS nome FROM clientes c WHERE c.empresa_id = $1 AND c.ativo = TRUE
           AND (LOWER(${NOME_CLIENTE}) = LOWER($2) OR ${NOME_CLIENTE} ILIKE $3 OR c.nome ILIKE $3) ORDER BY 2 LIMIT 8`,
        [ctx.empresa_id], a.cliente, 'um cliente');
      if (r.erro) return { ...r, dica: 'Se for um prospect (ainda não é cliente), use "empresa" em vez de "cliente".' };
      cliente = r.item;
    }
    if (!cliente && !a.empresa) return { erro: 'Diga de qual cliente ou empresa é a oportunidade.' };
    const etapa = com.ETAPAS_ABERTAS.includes(a.etapa) ? a.etapa : 'lead';
    if (a.origem && !com.ORIGENS[a.origem]) return { erro: 'Origem inválida.' };
    if (a.previsao_fechamento && !/^\d{4}-\d{2}-\d{2}$/.test(a.previsao_fechamento)) return { erro: 'Previsão no formato AAAA-MM-DD.' };
    if ([a.valor_mensal, a.valor_unico].some(v => v !== undefined && !(Number(v) >= 0))) return { erro: 'Valores não podem ser negativos.' };
    const resumo = `Criar a oportunidade "${a.titulo}" para ${cliente ? cliente.nome + ' (cliente)' : a.empresa + ' (prospect)'}` +
      ` na etapa ${com.ETAPAS[etapa].nome}` +
      (a.valor_mensal ? `, ${brl(a.valor_mensal)} por mês` : '') + (a.valor_unico ? `, ${brl(a.valor_unico)} de valor único` : '') +
      (a.previsao_fechamento ? `, previsão de fechamento ${a.previsao_fechamento.split('-').reverse().join('/')}` : '') + '.';
    if (!a.usuario_confirmou) return precisaConfirmar(resumo);
    const r = await pool.query(
      `INSERT INTO oportunidades (cliente_id, titulo, empresa_nome, contato_nome, contato_email, contato_telefone,
         interesse, origem, valor_mensal, valor_unico, probabilidade, previsao_fechamento, observacoes,
         etapa, empresa_id, criado_por_usuario_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [cliente ? cliente.id : null, String(a.titulo).slice(0, 255), cliente ? null : String(a.empresa).slice(0, 255),
       a.contato || null, a.contato_email || null, a.contato_telefone || null, a.interesse ? String(a.interesse).slice(0, 60) : null,
       a.origem || 'outro', Number(a.valor_mensal || 0), Number(a.valor_unico || 0), com.ETAPAS[etapa].prob,
       a.previsao_fechamento || null, a.observacoes || null, etapa, ctx.empresa_id, ctx.usuario_id]);
    await com.registrarHistorico(r.rows[0].id, 'sistema', `Oportunidade criada em ${com.ETAPAS[etapa].nome} (pela Ivy).`, ctx.usuario_id);
    return { sucesso: true, mensagem: `Oportunidade criada: ${resumo.replace(/^Criar a oportunidade /, '')}`, _ui_refresh: ['funil'] };
  }
};

const mover_oportunidade = {
  definition: fn('mover_oportunidade',
    'Muda a etapa de uma oportunidade do funil (lead, qualificação, proposta, negociação, ganha ou perdida), achando-a pelo título ou pela empresa. "perdida" exige o motivo. Sem usuario_confirmou=true não grava. Para "ganha", lembre que o contrato é gerado pela tela do funil.',
    {
      oportunidade: { type: 'string', description: 'Título ou empresa da oportunidade.' },
      etapa: { type: 'string', enum: Object.keys(com.ETAPAS) },
      motivo_perda: { type: 'string' },
      usuario_confirmou: CONFIRMAR
    }, ['oportunidade', 'etapa']),
  run: async (ctx, a) => {
    if (!com.ETAPAS[a.etapa]) return { erro: 'Etapa inválida.' };
    if (a.etapa === 'perdida' && !a.motivo_perda) return { erro: 'Pergunte o motivo da perda antes de mover.' };
    const r = await acharUm(SQL_OPORTUNIDADE, [ctx.empresa_id], a.oportunidade, 'uma oportunidade');
    if (r.erro) return r;
    const o = r.item;
    if (o.etapa === a.etapa) return { erro: `"${o.nome}" já está em ${com.ETAPAS[a.etapa].nome}.` };
    const resumo = `Mover "${o.nome}" (${o.empresa}) de ${com.ETAPAS[o.etapa].nome} para ${com.ETAPAS[a.etapa].nome}` +
      (a.etapa === 'perdida' ? `, motivo: ${a.motivo_perda}` : '') + '.';
    if (!a.usuario_confirmou) return precisaConfirmar(resumo);
    await com.mudarEtapa(o.id, a.etapa, ctx.usuario_id, { motivo_perda: a.motivo_perda ? String(a.motivo_perda).slice(0, 255) : null });
    return {
      sucesso: true, mensagem: resumo.replace(/^Mover/, 'Movida'),
      lembrete: a.etapa === 'ganha' ? 'Para gerar o contrato recorrente, use o botão Gerar contrato na oportunidade (tela Funil de vendas).' : undefined,
      _ui_refresh: ['funil']
    };
  }
};

const anotar_oportunidade = {
  definition: fn('anotar_oportunidade',
    'Registra uma nota no histórico de uma oportunidade (ex.: "liguei para o João, pediu proposta até sexta"). Leia a nota de volta antes de gravar: sem usuario_confirmou=true não grava.',
    {
      oportunidade: { type: 'string', description: 'Título ou empresa da oportunidade.' },
      nota: { type: 'string' },
      usuario_confirmou: CONFIRMAR
    }, ['oportunidade', 'nota']),
  run: async (ctx, a) => {
    const texto = String(a.nota || '').trim().slice(0, 5000);
    if (!texto) return { erro: 'Qual é a nota?' };
    const r = await acharUm(SQL_OPORTUNIDADE, [ctx.empresa_id], a.oportunidade, 'uma oportunidade');
    if (r.erro) return r;
    const resumo = `Anotar em "${r.item.nome}" (${r.item.empresa}): ${texto}`;
    if (!a.usuario_confirmou) return precisaConfirmar(resumo);
    await com.registrarHistorico(r.item.id, 'nota', texto, ctx.usuario_id);
    await pool.query('UPDATE oportunidades SET data_atualizacao = NOW() WHERE id = $1', [r.item.id]);
    return { sucesso: true, mensagem: `Nota registrada em "${r.item.nome}".`, _ui_refresh: ['funil'] };
  }
};

// ---------------------------------------------------------------------------
// INSTAGRAM
// ---------------------------------------------------------------------------

const SQL_POST = `
  SELECT p.id, COALESCE(p.titulo, LEFT(p.legenda, 60)) AS nome, p.status, p.data_agendada,
         (SELECT COUNT(*)::int FROM marketing_midias m WHERE m.post_id = p.id) AS imagens
  FROM marketing_posts p
  WHERE p.empresa_id = $1 AND p.status IN ('rascunho','agendado','erro','cancelado')
    AND (LOWER(p.titulo) = LOWER($2) OR p.titulo ILIKE $3 OR p.legenda ILIKE $3)
  ORDER BY (p.status = 'agendado') DESC, p.data_agendada NULLS LAST LIMIT 8`;

const agendar_post = {
  definition: fn('agendar_post',
    'Agenda ou reagenda um post do Instagram que já existe (rascunho, agendado, com erro ou cancelado), achando-o pelo título. O post precisa ter imagem; criar post novo com imagens é pela tela Marketing → Calendário. Data e hora em horário de Brasília. Sem usuario_confirmou=true não grava.',
    {
      post: { type: 'string', description: 'Título (ou trecho) do post.' },
      data_hora: { type: 'string', description: 'AAAA-MM-DDTHH:MM em horário de Brasília (ex.: 2026-10-20T12:30). Resolva "quinta ao meio-dia" com data_hoje.' },
      usuario_confirmou: CONFIRMAR
    }, ['post', 'data_hora']),
  run: async (ctx, a) => {
    const quando = mk.lerData(a.data_hora);
    if (!quando || quando === 'invalida') return { erro: 'Data/hora inválida: use AAAA-MM-DDTHH:MM.' };
    const r = await acharUm(SQL_POST, [ctx.empresa_id], a.post, 'um post');
    if (r.erro) return r;
    const p = r.item;
    const motivo = await mk.erroParaAgendar(p.id, quando);
    if (motivo) return { erro: motivo };
    const resumo = `${p.status === 'agendado' ? 'Reagendar' : 'Agendar'} o post "${p.nome}" para ${quandoBr(quando)}` +
      (p.status === 'agendado' && p.data_agendada ? ` (estava para ${quandoBr(p.data_agendada)})` : '') + '.';
    if (!a.usuario_confirmou) return precisaConfirmar(resumo);
    // Mesma regra do PUT /posts/:id: ao (re)agendar, zera as tentativas e o último erro
    const u = await pool.query(
      `UPDATE marketing_posts SET data_agendada = $2, status = 'agendado', tentativas = 0, ultimo_erro = NULL, data_atualizacao = NOW()
       WHERE id = $1 AND empresa_id = $3 AND status IN ('rascunho','agendado','erro','cancelado') RETURNING id`,
      [p.id, quando, ctx.empresa_id]);
    if (!u.rows.length) return { erro: 'O post mudou de status (pode estar publicando agora). Confira no calendário.' };
    return { sucesso: true, mensagem: resumo.replace(/^Reagendar/, 'Reagendado').replace(/^Agendar/, 'Agendado'), _ui_refresh: ['marketing-calendario'] };
  }
};

const cancelar_post = {
  definition: fn('cancelar_post',
    'Cancela um post do Instagram (rascunho, agendado ou com erro): ele não é mais publicado e fica no calendário como cancelado. Sem usuario_confirmou=true não grava.',
    { post: { type: 'string', description: 'Título (ou trecho) do post.' }, usuario_confirmou: CONFIRMAR }, ['post']),
  run: async (ctx, a) => {
    const r = await acharUm(SQL_POST.replace(`'rascunho','agendado','erro','cancelado'`, `'rascunho','agendado','erro'`), [ctx.empresa_id], a.post, 'um post');
    if (r.erro) return r;
    const p = r.item;
    const resumo = `Cancelar o post "${p.nome}"${p.status === 'agendado' && p.data_agendada ? `, que estava agendado para ${quandoBr(p.data_agendada)}` : ''}.`;
    if (!a.usuario_confirmou) return precisaConfirmar(resumo);
    const u = await pool.query(
      `UPDATE marketing_posts SET status = 'cancelado', data_atualizacao = NOW()
       WHERE id = $1 AND empresa_id = $2 AND status IN ('rascunho','agendado','erro') RETURNING id`, [p.id, ctx.empresa_id]);
    if (!u.rows.length) return { erro: 'O post mudou de status e não pôde ser cancelado. Confira no calendário.' };
    return { sucesso: true, mensagem: `Post "${p.nome}" cancelado.`, _ui_refresh: ['marketing-calendario'] };
  }
};

// ---------------------------------------------------------------------------
// TREINAMENTOS (consultas)
// ---------------------------------------------------------------------------

const resumo_treinamentos = {
  definition: fn('resumo_treinamentos',
    'Cursos da plataforma de treinamentos: status (rascunho/publicado), quantas aulas, quantas já têm vídeo (e quais faltam), duração total e quantos clientes têm acesso. Use para "como estão os cursos?", "quais aulas ainda estão sem vídeo?".',
    { curso: { type: 'string', description: 'Nome (ou parte) de um curso para ver as aulas dele.' } }),
  run: async (ctx, a) => {
    const cursos = (await pool.query(
      `SELECT c.id, c.titulo, c.status, c.carga_horaria,
              COUNT(au.id)::int AS aulas,
              COUNT(au.id) FILTER (WHERE au.video_url IS NOT NULL)::int AS aulas_com_video,
              COALESCE(SUM(au.duracao_min), 0)::int AS minutos,
              (SELECT COUNT(*)::int FROM cursos_liberacoes l WHERE l.curso_id = c.id AND (l.data_fim IS NULL OR l.data_fim >= CURRENT_DATE)) AS clientes_com_acesso
       FROM cursos c LEFT JOIN cursos_aulas au ON au.curso_id = c.id AND au.ativo
       WHERE c.empresa_id = $1 AND c.ativo = TRUE
       GROUP BY c.id ORDER BY c.ordem, c.titulo`, [ctx.empresa_id])).rows;
    const res = { total_cursos: cursos.length, cursos };
    if (a.curso) {
      const alvo = cursos.find(c => c.titulo.toLowerCase().includes(String(a.curso).toLowerCase()));
      if (!alvo) return { ...res, erro: `Não achei curso com "${a.curso}".` };
      res.aulas_do_curso = (await pool.query(
        `SELECT modulo, titulo, duracao_min, (video_url IS NOT NULL) AS tem_video
         FROM cursos_aulas WHERE curso_id = $1 AND ativo ORDER BY ordem, id`, [alvo.id])).rows;
    }
    return res;
  }
};

const progresso_treinamento = {
  definition: fn('progresso_treinamento',
    'Progresso dos alunos (usuários dos clientes) num curso: quantas aulas cada um concluiu e quando foi a última. Use para "quem já terminou o curso de ABAP?", "como está o cliente X no treinamento?".',
    {
      curso: { type: 'string', description: 'Nome (ou parte) do curso.' },
      cliente: { type: 'string', description: 'Filtra por cliente (opcional).' }
    }, ['curso']),
  run: async (ctx, a) => {
    const c = (await pool.query(
      `SELECT id, titulo, (SELECT COUNT(*)::int FROM cursos_aulas WHERE curso_id = cursos.id AND ativo) AS total_aulas
       FROM cursos WHERE empresa_id = $1 AND ativo = TRUE AND titulo ILIKE $2 ORDER BY ordem LIMIT 1`,
      [ctx.empresa_id, `%${a.curso}%`])).rows[0];
    if (!c) return { erro: `Não achei curso com "${a.curso}".` };
    const params = [c.id];
    let filtroCliente = '';
    if (a.cliente) { params.push(`%${a.cliente}%`); filtroCliente = `AND ${NOME_CLIENTE} ILIKE $2`; }
    const alunos = (await pool.query(
      `SELECT u.nome AS aluno, ${NOME_CLIENTE} AS cliente,
              COUNT(p.aula_id)::int AS concluidas,
              to_char(MAX(p.concluida_em), 'YYYY-MM-DD') AS ultima_aula_em
       FROM cursos_progresso p
       JOIN cursos_aulas au ON au.id = p.aula_id AND au.curso_id = $1 AND au.ativo
       JOIN usuarios u ON u.id = p.usuario_id
       LEFT JOIN clientes c ON c.id = u.cliente_id
       WHERE TRUE ${filtroCliente}
       GROUP BY u.id, u.nome, 2 ORDER BY concluidas DESC, u.nome LIMIT 30`, params)).rows;
    return {
      curso: c.titulo, total_aulas: c.total_aulas,
      alunos: alunos.map(x => ({ ...x, concluiu_o_curso: c.total_aulas > 0 && x.concluidas >= c.total_aulas })),
      obs: alunos.length ? undefined : 'Ninguém concluiu aulas deste curso ainda.'
    };
  }
};

const TOOLS_ACOES = {
  criar_oportunidade, mover_oportunidade, anotar_oportunidade,
  agendar_post, cancelar_post,
  resumo_treinamentos, progresso_treinamento
};

module.exports = { TOOLS_ACOES };
