// ============================================================================
// Catálogo de tools do assistente de voz.
//
// Cada tool tem:
//   - definition: schema JSON no formato OpenAI function tool
//   - run(ctx, args): implementação. ctx = { empresa_id, usuario_id, tipo, nome }
//                     vem SEMPRE do JWT — o LLM nunca passa empresa_id.
//
// Regras de segurança aplicadas em todas as tools:
//   1. Queries parametrizadas (nunca interpolação)
//   2. empresa_id e usuario_id vêm do ctx (JWT), nunca dos args
//   3. Resultados truncados pra não estourar contexto/custo do LLM
// ============================================================================

const crypto = require('crypto');
const pool = require('../db');
const { validarDocumento, validarCNPJ } = require('./validacao');

// Gera datas de repetição (mesmo algoritmo de routes/transacoes.js)
function gerarDatasRepeticao(dataBaseStr, periodicidade, dataFinalStr) {
  const datas = [];
  const base = new Date(dataBaseStr + 'T00:00:00');
  const limite = new Date(dataFinalStr + 'T00:00:00');
  if (isNaN(base) || isNaN(limite)) return null;
  if (limite < base) return null;

  const fmt = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  };

  if (periodicidade === 'diaria') {
    const cur = new Date(base);
    while (cur <= limite) {
      datas.push(fmt(cur));
      cur.setDate(cur.getDate() + 1);
      if (datas.length > 3650) break;
    }
    return datas;
  }

  if (periodicidade === 'mensal') {
    const diaOriginal = base.getDate();
    let i = 0;
    while (true) {
      const d = new Date(base.getFullYear(), base.getMonth() + i, 1);
      const ultimoDiaMes = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(diaOriginal, ultimoDiaMes));
      if (d > limite) break;
      datas.push(fmt(d));
      i += 1;
      if (i > 600) break;
    }
    return datas;
  }

  return null;
}

const MAX_LIST_ROWS = 30;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtData(d) {
  if (!d) return null;
  const dt = new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// Normaliza tipo: "saida" → "saída", "entrada" → "entrada"
function normalizarTipoTransacao(t) {
  if (!t) return null;
  const s = String(t).toLowerCase().trim();
  if (s === 'entrada' || s === 'receita' || s === 'recebimento') return 'entrada';
  if (s === 'saida' || s === 'saída' || s === 'despesa' || s === 'pagamento' || s === 'gasto') return 'saída';
  return null;
}

// ---------------------------------------------------------------------------
// TOOL: data_hoje — helper pro modelo entender datas relativas
// ---------------------------------------------------------------------------

const data_hoje = {
  definition: {
    type: 'function',
    function: {
      name: 'data_hoje',
      description: 'Retorna a data atual do servidor (formato YYYY-MM-DD) e o nome do dia da semana. Use sempre que precisar resolver expressões como "hoje", "ontem", "esse mês", "no dia 5".',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  },
  run: async () => {
    const hoje = new Date();
    const dias = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
    return {
      data: fmtData(hoje),
      dia_semana: dias[hoje.getDay()],
      mes: hoje.getMonth() + 1,
      ano: hoje.getFullYear()
    };
  }
};

// ---------------------------------------------------------------------------
// TOOLS: transações
// ---------------------------------------------------------------------------

const criar_transacao = {
  definition: {
    type: 'function',
    function: {
      name: 'criar_transacao',
      description: 'Cria uma transação financeira (entrada ou saída). Categoria precisa estar cadastrada no sistema. Para lançamentos recorrentes (ex: aluguel mensal, salário fixo), use o campo "repetir" — uma transação será criada para cada data no intervalo.',
      parameters: {
        type: 'object',
        properties: {
          tipo: { type: 'string', enum: ['entrada', 'saída'], description: 'Tipo da transação' },
          valor: { type: 'number', description: 'Valor em reais (positivo, ex: 350.50)' },
          categoria: { type: 'string', description: 'Nome exato da categoria já cadastrada (ex: "Alimentação", "Salário")' },
          descricao: { type: 'string', description: 'Descrição livre. Opcional.' },
          data: { type: 'string', description: 'Data no formato YYYY-MM-DD. Se omitido, usa hoje. Quando há repetição, é a data do PRIMEIRO lançamento.' },
          repetir: {
            type: 'object',
            description: 'Opcional. Se informado, cria uma cópia da transação para cada data até "data_final" (inclusive). Exemplo: aluguel mensal de janeiro a dezembro = data="2026-01-05", repetir={ periodicidade: "mensal", data_final: "2026-12-05" }.',
            properties: {
              periodicidade: { type: 'string', enum: ['mensal', 'diaria'] },
              data_final: { type: 'string', description: 'YYYY-MM-DD (último lançamento incluído)' }
            },
            required: ['periodicidade', 'data_final'],
            additionalProperties: false
          }
        },
        required: ['tipo', 'valor', 'categoria'],
        additionalProperties: false
      }
    }
  },
  run: async (ctx, args) => {
    const tipo = normalizarTipoTransacao(args.tipo);
    if (!tipo) return { erro: 'Tipo inválido. Use "entrada" ou "saída".' };
    const valor = Number(args.valor);
    if (!Number.isFinite(valor) || valor <= 0) return { erro: 'Valor deve ser um número positivo.' };

    const cat = await pool.query(
      `SELECT nome FROM categorias_transacao
       WHERE empresa_id = $1 AND LOWER(nome) = LOWER($2) AND tipo = $3 AND ativo = TRUE`,
      [ctx.empresa_id, args.categoria, tipo]
    );
    if (cat.rows.length === 0) {
      const sugestoes = await pool.query(
        `SELECT nome FROM categorias_transacao
         WHERE empresa_id = $1 AND tipo = $2 AND ativo = TRUE ORDER BY nome`,
        [ctx.empresa_id, tipo]
      );
      return {
        erro: `Categoria "${args.categoria}" não está cadastrada para ${tipo}.`,
        categorias_disponiveis: sugestoes.rows.map(r => r.nome)
      };
    }

    const categoriaCanonica = cat.rows[0].nome;
    const dataInicial = args.data || new Date().toISOString().slice(0, 10);

    // Caso simples: sem repetição
    if (!args.repetir || !args.repetir.periodicidade || !args.repetir.data_final) {
      const result = await pool.query(
        `INSERT INTO transacoes (tipo, valor, categoria, descricao, data, empresa_id, usuario_id, criado_por_usuario_id)
         VALUES ($1, $2, $3, $4, COALESCE($5::date, CURRENT_DATE), $6, $7, $7) RETURNING *`,
        [tipo, valor, categoriaCanonica, args.descricao || '', args.data || null, ctx.empresa_id, ctx.usuario_id]
      );
      const t = result.rows[0];
      return {
        sucesso: true,
        id: t.id,
        tipo: t.tipo,
        valor: Number(t.valor),
        categoria: t.categoria,
        descricao: t.descricao,
        data: fmtData(t.data),
        _ui_refresh: ['transacoes', 'dashboard']
      };
    }

    // Caso com repetição
    const periodicidade = args.repetir.periodicidade;
    if (!['mensal', 'diaria'].includes(periodicidade)) {
      return { erro: 'Periodicidade deve ser "mensal" ou "diaria".' };
    }
    const datas = gerarDatasRepeticao(dataInicial, periodicidade, args.repetir.data_final);
    if (!datas || datas.length === 0) {
      return { erro: 'Data final inválida ou anterior à data inicial.' };
    }
    if (datas.length > 600) {
      return { erro: 'Repetição gera lançamentos demais (mais de 600). Reduza o intervalo.' };
    }

    const grupoId = crypto.randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const criadas = [];
      for (const dt of datas) {
        const r = await client.query(
          `INSERT INTO transacoes (tipo, valor, categoria, descricao, data, empresa_id, usuario_id, criado_por_usuario_id, grupo_id)
           VALUES ($1, $2, $3, $4, $5::date, $6, $7, $7, $8) RETURNING id, data`,
          [tipo, valor, categoriaCanonica, args.descricao || '', dt, ctx.empresa_id, ctx.usuario_id, grupoId]
        );
        criadas.push(r.rows[0]);
      }
      await client.query('COMMIT');
      return {
        sucesso: true,
        repeticao: true,
        total_criadas: criadas.length,
        periodicidade,
        primeira_data: fmtData(criadas[0].data),
        ultima_data: fmtData(criadas[criadas.length - 1].data),
        valor: valor,
        tipo,
        categoria: categoriaCanonica,
        descricao: args.descricao || '',
        _ui_refresh: ['transacoes', 'dashboard']
      };
    } catch (e) {
      await client.query('ROLLBACK');
      return { erro: `Falha ao criar lançamentos repetidos: ${e.message}` };
    } finally {
      client.release();
    }
  }
};

const listar_transacoes = {
  definition: {
    type: 'function',
    function: {
      name: 'listar_transacoes',
      description: 'Lista transações financeiras com filtros opcionais. Útil para "minhas últimas saídas", "transações de maio", etc. Retorna no máximo 30 itens (mais recentes primeiro).',
      parameters: {
        type: 'object',
        properties: {
          tipo: { type: 'string', enum: ['entrada', 'saída'] },
          categoria: { type: 'string', description: 'Filtra por categoria exata' },
          data_de: { type: 'string', description: 'YYYY-MM-DD (inclusivo)' },
          data_ate: { type: 'string', description: 'YYYY-MM-DD (inclusivo)' },
          busca: { type: 'string', description: 'Termo livre buscado em descricao ou categoria' },
          limit: { type: 'number', description: 'Máximo de resultados (padrão 10, máx 30)' }
        },
        additionalProperties: false
      }
    }
  },
  run: async (ctx, args) => {
    const params = [ctx.empresa_id];
    let where = 'WHERE empresa_id = $1';
    let i = 2;
    const tipo = normalizarTipoTransacao(args.tipo);
    if (tipo) { where += ` AND tipo = $${i++}`; params.push(tipo); }
    if (args.categoria) { where += ` AND LOWER(categoria) = LOWER($${i++})`; params.push(args.categoria); }
    if (args.data_de) { where += ` AND data >= $${i++}::date`; params.push(args.data_de); }
    if (args.data_ate) { where += ` AND data <= $${i++}::date`; params.push(args.data_ate); }
    if (args.busca) { where += ` AND (descricao ILIKE $${i} OR categoria ILIKE $${i})`; params.push(`%${args.busca}%`); i++; }

    const limit = Math.min(MAX_LIST_ROWS, Math.max(1, Number(args.limit) || 10));
    params.push(limit);

    const result = await pool.query(
      `SELECT id, tipo, valor, categoria, descricao, data
       FROM transacoes ${where}
       ORDER BY data DESC, id DESC
       LIMIT $${i}`,
      params
    );
    return {
      total: result.rows.length,
      transacoes: result.rows.map(r => ({
        id: r.id, tipo: r.tipo, valor: Number(r.valor),
        categoria: r.categoria, descricao: r.descricao, data: fmtData(r.data)
      }))
    };
  }
};

const consultar_saldo = {
  definition: {
    type: 'function',
    function: {
      name: 'consultar_saldo',
      description: 'Calcula o saldo total (entradas - saídas) em um período. Se nenhuma data for passada, usa o histórico completo.',
      parameters: {
        type: 'object',
        properties: {
          data_de: { type: 'string', description: 'YYYY-MM-DD' },
          data_ate: { type: 'string', description: 'YYYY-MM-DD' }
        },
        additionalProperties: false
      }
    }
  },
  run: async (ctx, args) => {
    const params = [ctx.empresa_id];
    let where = 'WHERE empresa_id = $1';
    let i = 2;
    if (args.data_de) { where += ` AND data >= $${i++}::date`; params.push(args.data_de); }
    if (args.data_ate) { where += ` AND data <= $${i++}::date`; params.push(args.data_ate); }

    const r = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN tipo='entrada' THEN valor ELSE 0 END), 0) AS entradas,
         COALESCE(SUM(CASE WHEN tipo='saída'   THEN valor ELSE 0 END), 0) AS saidas,
         COUNT(*) AS total
       FROM transacoes ${where}`,
      params
    );
    const row = r.rows[0];
    const entradas = Number(row.entradas);
    const saidas = Number(row.saidas);
    return {
      entradas, saidas, saldo: entradas - saidas, total_transacoes: Number(row.total),
      periodo: { data_de: args.data_de || null, data_ate: args.data_ate || null }
    };
  }
};

const resumo_periodo = {
  definition: {
    type: 'function',
    function: {
      name: 'resumo_periodo',
      description: 'Agrupa as transações por categoria em um período (top categorias de entrada e saída). Ideal para "onde gastei mais em maio?".',
      parameters: {
        type: 'object',
        properties: {
          data_de: { type: 'string', description: 'YYYY-MM-DD' },
          data_ate: { type: 'string', description: 'YYYY-MM-DD' }
        },
        additionalProperties: false
      }
    }
  },
  run: async (ctx, args) => {
    const params = [ctx.empresa_id];
    let where = 'WHERE empresa_id = $1';
    let i = 2;
    if (args.data_de) { where += ` AND data >= $${i++}::date`; params.push(args.data_de); }
    if (args.data_ate) { where += ` AND data <= $${i++}::date`; params.push(args.data_ate); }

    const r = await pool.query(
      `SELECT tipo, categoria, SUM(valor) AS total, COUNT(*) AS qtd
       FROM transacoes ${where}
       GROUP BY tipo, categoria
       ORDER BY tipo, total DESC`,
      params
    );
    return {
      periodo: { data_de: args.data_de || null, data_ate: args.data_ate || null },
      por_categoria: r.rows.map(x => ({
        tipo: x.tipo, categoria: x.categoria,
        total: Number(x.total), qtd: Number(x.qtd)
      }))
    };
  }
};

// ---------------------------------------------------------------------------
// TOOLS: categorias
// ---------------------------------------------------------------------------

const listar_categorias = {
  definition: {
    type: 'function',
    function: {
      name: 'listar_categorias',
      description: 'Lista as categorias de transação cadastradas. Use antes de criar uma transação se não tiver certeza do nome exato.',
      parameters: {
        type: 'object',
        properties: {
          tipo: { type: 'string', enum: ['entrada', 'saída'] }
        },
        additionalProperties: false
      }
    }
  },
  run: async (ctx, args) => {
    const params = [ctx.empresa_id];
    let where = 'WHERE empresa_id = $1 AND ativo = TRUE';
    const tipo = normalizarTipoTransacao(args.tipo);
    if (tipo) { where += ` AND tipo = $2`; params.push(tipo); }
    const r = await pool.query(
      `SELECT nome, tipo FROM categorias_transacao ${where} ORDER BY tipo, nome`,
      params
    );
    return { categorias: r.rows };
  }
};

const criar_categoria = {
  definition: {
    type: 'function',
    function: {
      name: 'criar_categoria',
      description: 'Cria uma nova categoria de transação. CRÍTICO: só chame APÓS o usuário confirmar explicitamente que quer criar (resposta tipo "sim", "pode", "vai", "claro"). Não crie sem confirmação afirmativa. Após criar a categoria, geralmente o próximo passo é chamar criar_transacao usando ela.',
      parameters: {
        type: 'object',
        properties: {
          nome: { type: 'string', description: 'Nome da categoria (ex: "Combustível", "Marketing")' },
          tipo: { type: 'string', enum: ['entrada', 'saída'] },
          descricao: { type: 'string', description: 'Opcional. Descrição livre da categoria.' },
          usuario_confirmou: {
            type: 'boolean',
            description: 'Marque true SOMENTE se o usuário respondeu de forma afirmativa à pergunta de confirmação no turno anterior. Se ainda não confirmou, não chame esta tool.'
          }
        },
        required: ['nome', 'tipo', 'usuario_confirmou'],
        additionalProperties: false
      }
    }
  },
  run: async (ctx, args) => {
    if (args.usuario_confirmou !== true) {
      return { erro: 'Criação de categoria requer confirmação explícita do usuário. Pergunte primeiro e só chame esta tool após resposta afirmativa.' };
    }
    const tipo = normalizarTipoTransacao(args.tipo);
    if (!tipo) return { erro: 'Tipo inválido. Use entrada ou saída.' };
    const nome = (args.nome || '').trim();
    if (!nome) return { erro: 'Nome da categoria é obrigatório.' };

    // Já existe? (case-insensitive)
    const existe = await pool.query(
      `SELECT id, nome FROM categorias_transacao
       WHERE empresa_id = $1 AND LOWER(nome) = LOWER($2) AND tipo = $3`,
      [ctx.empresa_id, nome, tipo]
    );
    if (existe.rows.length > 0) {
      return {
        sucesso: false,
        ja_existe: true,
        categoria: { nome: existe.rows[0].nome, tipo }
      };
    }

    try {
      const r = await pool.query(
        `INSERT INTO categorias_transacao (empresa_id, nome, tipo, descricao, criado_por_usuario_id, ativo)
         VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING id, nome, tipo`,
        [ctx.empresa_id, nome, tipo, args.descricao || null, ctx.usuario_id]
      );
      return {
        sucesso: true,
        categoria: r.rows[0],
        _ui_refresh: ['categorias-transacao']
      };
    } catch (err) {
      if (err.code === '23505') {
        return { erro: 'Categoria duplicada (já existe com esse nome e tipo).' };
      }
      return { erro: `Falha ao criar categoria: ${err.message}` };
    }
  }
};

// ---------------------------------------------------------------------------
// TOOLS: clientes
// ---------------------------------------------------------------------------

const listar_clientes = {
  definition: {
    type: 'function',
    function: {
      name: 'listar_clientes',
      description: 'Lista clientes da empresa (no máximo 30). Aceita filtro por nome.',
      parameters: {
        type: 'object',
        properties: {
          busca: { type: 'string', description: 'Termo buscado no nome/razão social' }
        },
        additionalProperties: false
      }
    }
  },
  run: async (ctx, args) => {
    const params = [ctx.empresa_id];
    let where = 'WHERE empresa_id = $1 AND ativo = TRUE';
    if (args.busca) {
      where += ` AND (razao_social ILIKE $2 OR nome ILIKE $2 OR nome_fantasia ILIKE $2)`;
      params.push(`%${args.busca}%`);
    }
    const r = await pool.query(
      `SELECT id, COALESCE(razao_social, nome) AS nome, nome_fantasia, cpf_cnpj, telefone, email, status
       FROM clientes ${where}
       ORDER BY COALESCE(razao_social, nome)
       LIMIT ${MAX_LIST_ROWS}`,
      params
    );
    return { total: r.rows.length, clientes: r.rows };
  }
};

const buscar_cliente = {
  definition: {
    type: 'function',
    function: {
      name: 'buscar_cliente',
      description: 'Busca um cliente específico por nome aproximado ou CPF/CNPJ. Retorna o melhor match com todos os dados.',
      parameters: {
        type: 'object',
        properties: {
          termo: { type: 'string', description: 'Nome, razão social ou documento' }
        },
        required: ['termo'],
        additionalProperties: false
      }
    }
  },
  run: async (ctx, args) => {
    const r = await pool.query(
      `SELECT id, COALESCE(razao_social, nome) AS nome, nome_fantasia, cpf_cnpj,
              email, telefone, celular, cidade, uf, status, segmento, porte
       FROM clientes
       WHERE empresa_id = $1 AND ativo = TRUE
         AND (razao_social ILIKE $2 OR nome ILIKE $2 OR nome_fantasia ILIKE $2 OR cpf_cnpj = $3)
       ORDER BY COALESCE(razao_social, nome)
       LIMIT 5`,
      [ctx.empresa_id, `%${args.termo}%`, args.termo.replace(/\D/g, '')]
    );
    if (r.rows.length === 0) return { encontrados: 0, clientes: [] };
    return { encontrados: r.rows.length, clientes: r.rows };
  }
};

const criar_cliente = {
  definition: {
    type: 'function',
    function: {
      name: 'criar_cliente',
      description: 'Cria um novo cliente. Apenas razao_social é obrigatório. CPF/CNPJ é validado se informado.',
      parameters: {
        type: 'object',
        properties: {
          razao_social: { type: 'string' },
          nome_fantasia: { type: 'string' },
          cpf_cnpj: { type: 'string' },
          email: { type: 'string' },
          telefone: { type: 'string' },
          celular: { type: 'string' },
          cidade: { type: 'string' },
          uf: { type: 'string', description: 'Sigla do estado, 2 letras' }
        },
        required: ['razao_social'],
        additionalProperties: false
      }
    }
  },
  run: async (ctx, args) => {
    if (args.cpf_cnpj && !validarDocumento(args.cpf_cnpj)) {
      return { erro: 'CPF/CNPJ inválido. Verifique os dígitos.' };
    }
    if (args.cpf_cnpj) {
      const dup = await pool.query(
        'SELECT id FROM clientes WHERE cpf_cnpj = $1 AND empresa_id = $2 AND ativo = TRUE',
        [args.cpf_cnpj, ctx.empresa_id]
      );
      if (dup.rows.length > 0) return { erro: 'CPF/CNPJ já cadastrado para outro cliente.' };
    }
    const r = await pool.query(
      `INSERT INTO clientes (empresa_id, nome, razao_social, nome_fantasia, cpf_cnpj,
        email, telefone, celular, cidade, uf, status, criado_por_usuario_id, ativo)
       VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9, 'ativo', $10, TRUE)
       RETURNING id, razao_social, nome_fantasia`,
      [ctx.empresa_id, args.razao_social, args.nome_fantasia || null, args.cpf_cnpj || null,
       args.email || null, args.telefone || null, args.celular || null,
       args.cidade || null, args.uf || null, ctx.usuario_id]
    );
    return { sucesso: true, cliente: r.rows[0], _ui_refresh: ['clientes'] };
  }
};

// ---------------------------------------------------------------------------
// TOOLS: fornecedores
// ---------------------------------------------------------------------------

const listar_fornecedores = {
  definition: {
    type: 'function',
    function: {
      name: 'listar_fornecedores',
      description: 'Lista fornecedores da empresa (máx 30). Filtro opcional por nome.',
      parameters: {
        type: 'object',
        properties: { busca: { type: 'string' } },
        additionalProperties: false
      }
    }
  },
  run: async (ctx, args) => {
    const params = [ctx.empresa_id];
    let where = 'WHERE empresa_id = $1 AND ativo = TRUE';
    if (args.busca) {
      where += ` AND (razao_social ILIKE $2 OR nome ILIKE $2 OR nome_fantasia ILIKE $2)`;
      params.push(`%${args.busca}%`);
    }
    const r = await pool.query(
      `SELECT id, COALESCE(razao_social, nome) AS nome, nome_fantasia, cnpj, ramo, telefone, email, status
       FROM fornecedores ${where}
       ORDER BY COALESCE(razao_social, nome)
       LIMIT ${MAX_LIST_ROWS}`,
      params
    );
    return { total: r.rows.length, fornecedores: r.rows };
  }
};

const buscar_fornecedor = {
  definition: {
    type: 'function',
    function: {
      name: 'buscar_fornecedor',
      description: 'Busca um fornecedor por nome aproximado ou CNPJ.',
      parameters: {
        type: 'object',
        properties: { termo: { type: 'string' } },
        required: ['termo'],
        additionalProperties: false
      }
    }
  },
  run: async (ctx, args) => {
    const r = await pool.query(
      `SELECT id, COALESCE(razao_social, nome) AS nome, nome_fantasia, cnpj,
              ramo, email, telefone, celular, cidade, uf, status
       FROM fornecedores
       WHERE empresa_id = $1 AND ativo = TRUE
         AND (razao_social ILIKE $2 OR nome ILIKE $2 OR nome_fantasia ILIKE $2 OR cnpj = $3)
       ORDER BY COALESCE(razao_social, nome)
       LIMIT 5`,
      [ctx.empresa_id, `%${args.termo}%`, args.termo.replace(/\D/g, '')]
    );
    return { encontrados: r.rows.length, fornecedores: r.rows };
  }
};

const criar_fornecedor = {
  definition: {
    type: 'function',
    function: {
      name: 'criar_fornecedor',
      description: 'Cria um novo fornecedor. Apenas razao_social é obrigatório. CNPJ é validado se informado.',
      parameters: {
        type: 'object',
        properties: {
          razao_social: { type: 'string' },
          nome_fantasia: { type: 'string' },
          cnpj: { type: 'string' },
          email: { type: 'string' },
          telefone: { type: 'string' },
          ramo: { type: 'string' },
          cidade: { type: 'string' },
          uf: { type: 'string' }
        },
        required: ['razao_social'],
        additionalProperties: false
      }
    }
  },
  run: async (ctx, args) => {
    if (args.cnpj && !validarCNPJ(args.cnpj)) return { erro: 'CNPJ inválido.' };
    if (args.cnpj) {
      const dup = await pool.query(
        'SELECT id FROM fornecedores WHERE cnpj = $1 AND empresa_id = $2 AND ativo = TRUE',
        [args.cnpj, ctx.empresa_id]
      );
      if (dup.rows.length > 0) return { erro: 'CNPJ já cadastrado.' };
    }
    const r = await pool.query(
      `INSERT INTO fornecedores (empresa_id, nome, razao_social, nome_fantasia, cnpj,
        email, telefone, ramo, cidade, uf, status, criado_por_usuario_id, ativo)
       VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9, 'ativo', $10, TRUE)
       RETURNING id, razao_social, nome_fantasia`,
      [ctx.empresa_id, args.razao_social, args.nome_fantasia || null, args.cnpj || null,
       args.email || null, args.telefone || null, args.ramo || null,
       args.cidade || null, args.uf || null, ctx.usuario_id]
    );
    return { sucesso: true, fornecedor: r.rows[0], _ui_refresh: ['fornecedores'] };
  }
};

// ---------------------------------------------------------------------------
// TOOLS: chamados
// ---------------------------------------------------------------------------

const listar_tecnologias_do_cliente = {
  definition: {
    type: 'function',
    function: {
      name: 'listar_tecnologias_do_cliente',
      description: 'Retorna as tecnologias (produtos) que o cliente da conta atual tem habilitadas para abrir chamados. Use ANTES de criar um chamado quando o usuário do portal não disser explicitamente qual tecnologia é, ou quando precisar confirmar se ele tem mais de uma. Cada tecnologia retornada tem id, nome e categoria.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  },
  run: async (ctx) => {
    if (ctx.tipo !== 'cliente') return { erro: 'Esta tool é apenas para usuários do portal do cliente.' };
    if (!ctx.cliente_id) return { erro: 'Sua conta não está vinculada a um cliente.' };
    const r = await pool.query(
      `SELECT t.id, t.nome, t.categoria
       FROM cliente_tecnologias ct
       JOIN tecnologias t ON t.id = ct.tecnologia_id
       WHERE ct.cliente_id = $1 AND ct.status = 'ativo' AND t.ativo = TRUE
       ORDER BY t.nome`,
      [ctx.cliente_id]
    );
    return { total: r.rows.length, tecnologias: r.rows };
  }
};

const listar_chamados = {
  definition: {
    type: 'function',
    function: {
      name: 'listar_chamados',
      description: 'Lista chamados da empresa (máx 30, mais recentes primeiro). Filtros por status, prioridade, cliente, busca textual.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['aberto', 'em_andamento', 'aguardando_cliente', 'resolvido', 'fechado'] },
          prioridade: { type: 'string', enum: ['baixa', 'media', 'alta', 'critica'] },
          cliente_id: { type: 'number' },
          busca: { type: 'string', description: 'Termo livre buscado em título/descrição' }
        },
        additionalProperties: false
      }
    }
  },
  run: async (ctx, args) => {
    const params = [ctx.empresa_id];
    let where = 'WHERE ch.empresa_id = $1 AND ch.ativo = TRUE';
    let i = 2;

    // Cliente: força filtro pelo cliente_id do JWT (não vê chamados de outros)
    if (ctx.tipo === 'cliente') {
      if (!ctx.cliente_id) return { erro: 'Sua conta não está vinculada a um cliente.' };
      where += ` AND ch.cliente_id = $${i++}`;
      params.push(ctx.cliente_id);
    } else if (args.cliente_id) {
      where += ` AND ch.cliente_id = $${i++}`;
      params.push(args.cliente_id);
    }

    if (args.status) { where += ` AND ch.status = $${i++}`; params.push(args.status); }
    if (args.prioridade) { where += ` AND ch.prioridade = $${i++}`; params.push(args.prioridade); }
    if (args.busca) {
      where += ` AND (ch.titulo ILIKE $${i} OR ch.descricao ILIKE $${i})`;
      params.push(`%${args.busca}%`); i++;
    }
    const r = await pool.query(
      `SELECT ch.id, ch.titulo, ch.status, ch.prioridade, ch.data_criacao,
              COALESCE(c.razao_social, c.nome) AS cliente_nome
       FROM chamados ch
       LEFT JOIN clientes c ON c.id = ch.cliente_id
       ${where}
       ORDER BY ch.data_criacao DESC
       LIMIT ${MAX_LIST_ROWS}`,
      params
    );
    return { total: r.rows.length, chamados: r.rows };
  }
};

const criar_chamado = {
  definition: {
    type: 'function',
    function: {
      name: 'criar_chamado',
      description: 'Abre um novo chamado. Para o tipo "cliente" o sistema vincula automaticamente ao cliente da conta (não passe cliente_id). Para admin/técnico, cliente_id é obrigatório (use buscar_cliente antes). Se a tecnologia for relevante para o chamado, passe tecnologia_id (no caso do cliente, ela precisa estar nas tecnologias liberadas para a conta dele).',
      parameters: {
        type: 'object',
        properties: {
          cliente_id: { type: 'number', description: 'Obrigatório para admin/técnico; ignorado para cliente (vem do JWT).' },
          tecnologia_id: { type: 'number', description: 'ID da tecnologia/produto do chamado. Para clientes do portal, OBRIGATÓRIO e deve vir de listar_tecnologias_do_cliente.' },
          titulo: { type: 'string' },
          descricao: { type: 'string', description: 'Telemedicina: use bloco estruturado (Paciente/Unidade/Exame/Problema). Outras tecnologias: descreva o que está acontecendo de forma clara.' },
          prioridade: { type: 'string', enum: ['baixa', 'media', 'alta', 'critica'] }
        },
        required: ['titulo'],
        additionalProperties: false
      }
    }
  },
  run: async (ctx, args) => {
    // Cliente: cliente_id sempre vem do JWT, ignora args
    let cliente_id;
    if (ctx.tipo === 'cliente') {
      if (!ctx.cliente_id) return { erro: 'Sua conta não está vinculada a um cliente. Contate o administrador.' };
      cliente_id = ctx.cliente_id;
    } else {
      cliente_id = args.cliente_id;
      if (!cliente_id) return { erro: 'cliente_id é obrigatório para admins/técnicos. Use buscar_cliente antes.' };
    }

    const cliExiste = await pool.query(
      'SELECT id FROM clientes WHERE id = $1 AND empresa_id = $2 AND ativo = TRUE',
      [cliente_id, ctx.empresa_id]
    );
    if (cliExiste.rows.length === 0) return { erro: 'Cliente não encontrado.' };

    // Valida tecnologia_id (se informada)
    let tecnologia_id = args.tecnologia_id || null;
    if (tecnologia_id) {
      const tecCheck = await pool.query(
        `SELECT t.id, t.nome FROM tecnologias t
         WHERE t.id = $1 AND t.empresa_id = $2 AND t.ativo = TRUE`,
        [tecnologia_id, ctx.empresa_id]
      );
      if (tecCheck.rows.length === 0) return { erro: 'Tecnologia não encontrada nesta empresa.' };

      // Cliente: tecnologia precisa estar vinculada à conta dele
      if (ctx.tipo === 'cliente') {
        const link = await pool.query(
          `SELECT 1 FROM cliente_tecnologias
           WHERE cliente_id = $1 AND tecnologia_id = $2 AND status = 'ativo'`,
          [cliente_id, tecnologia_id]
        );
        if (link.rows.length === 0) {
          return { erro: `Sua conta não está habilitada para abrir chamados da tecnologia "${tecCheck.rows[0].nome}". Solicite a liberação ao administrador.` };
        }
      }
    }

    // Cliente DEVE informar tecnologia (regra de negócio do portal)
    if (ctx.tipo === 'cliente' && !tecnologia_id) {
      return { erro: 'tecnologia_id é obrigatória para abrir chamados pelo portal. Use listar_tecnologias_do_cliente antes.' };
    }

    const r = await pool.query(
      `INSERT INTO chamados (empresa_id, cliente_id, tecnologia_id, aberto_por_usuario_id,
        titulo, descricao, prioridade, status, ativo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'aberto', TRUE)
       RETURNING id, titulo, status, prioridade, tecnologia_id`,
      [ctx.empresa_id, cliente_id, tecnologia_id, ctx.usuario_id,
       args.titulo, args.descricao || null, args.prioridade || 'media']
    );
    const chamado = r.rows[0];
    await pool.query(
      `INSERT INTO chamados_status_log (chamado_id, empresa_id, usuario_id, status_anterior, status_novo, observacao)
       VALUES ($1, $2, $3, NULL, 'aberto', 'Chamado aberto via assistente de voz')`,
      [chamado.id, ctx.empresa_id, ctx.usuario_id]
    );
    return { sucesso: true, chamado, _ui_refresh: ['chamados', 'dashboard'] };
  }
};

const criar_atendimento = {
  definition: {
    type: 'function',
    function: {
      name: 'criar_atendimento',
      description: 'Registra um atendimento (comentário, solução ou escalonamento) em um chamado existente. tipo="solucao" muda o chamado para resolvido.',
      parameters: {
        type: 'object',
        properties: {
          chamado_id: { type: 'number' },
          descricao: { type: 'string' },
          tipo: { type: 'string', enum: ['comentario', 'solucao', 'escalonamento'] },
          tempo_gasto_minutos: { type: 'number' }
        },
        required: ['chamado_id', 'descricao'],
        additionalProperties: false
      }
    }
  },
  run: async (ctx, args) => {
    if (ctx.tipo === 'cliente') args.tipo = 'comentario';

    // Cliente só pode comentar nos próprios chamados
    let q = 'SELECT id, status FROM chamados WHERE id = $1 AND empresa_id = $2 AND ativo = TRUE';
    const params = [args.chamado_id, ctx.empresa_id];
    if (ctx.tipo === 'cliente') {
      if (!ctx.cliente_id) return { erro: 'Sua conta não está vinculada a um cliente.' };
      q += ' AND cliente_id = $3';
      params.push(ctx.cliente_id);
    }
    const ch = await pool.query(q, params);
    if (ch.rows.length === 0) return { erro: 'Chamado não encontrado.' };

    const tipo = args.tipo || 'comentario';
    const r = await pool.query(
      `INSERT INTO atendimentos (chamado_id, usuario_id, tipo, descricao, tempo_gasto_minutos, data_atendimento)
       VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id`,
      [args.chamado_id, ctx.usuario_id, tipo, args.descricao, args.tempo_gasto_minutos || 0]
    );

    const statusAtual = ch.rows[0].status;
    if (tipo === 'solucao' && statusAtual !== 'resolvido') {
      await pool.query(
        `UPDATE chamados SET status = 'resolvido', data_fechamento = NOW() WHERE id = $1`,
        [args.chamado_id]
      );
    } else if (tipo !== 'solucao' && statusAtual === 'aberto') {
      await pool.query(
        `UPDATE chamados SET status = 'em_andamento' WHERE id = $1`,
        [args.chamado_id]
      );
    }
    return {
      sucesso: true, atendimento_id: r.rows[0].id, chamado_id: args.chamado_id, tipo,
      _ui_refresh: ['chamados']
    };
  }
};

// ---------------------------------------------------------------------------
// Catálogo + dispatcher
// ---------------------------------------------------------------------------

const TOOLS = {
  data_hoje,
  criar_transacao,
  listar_transacoes,
  consultar_saldo,
  resumo_periodo,
  listar_categorias,
  criar_categoria,
  listar_clientes,
  buscar_cliente,
  criar_cliente,
  listar_fornecedores,
  buscar_fornecedor,
  criar_fornecedor,
  listar_tecnologias_do_cliente,
  listar_chamados,
  criar_chamado,
  criar_atendimento
};

// Tools que clientes (usuários do portal) podem acessar via voz.
// Tudo mais é admin/técnico-only.
const TOOLS_PERMITIDAS_CLIENTE = new Set([
  'data_hoje',
  'listar_tecnologias_do_cliente',
  'criar_chamado',
  'listar_chamados',
  'criar_atendimento'
]);

function getToolDefinitions() {
  return Object.values(TOOLS).map(t => t.definition);
}

function getToolDefinitionsParaContexto(ctx) {
  if (ctx && ctx.tipo === 'cliente') {
    return Object.entries(TOOLS)
      .filter(([name]) => TOOLS_PERMITIDAS_CLIENTE.has(name))
      .map(([, t]) => t.definition);
  }
  return getToolDefinitions();
}

async function runTool(name, ctx, args) {
  const tool = TOOLS[name];
  if (!tool) return { erro: `Tool desconhecida: ${name}` };
  // Defense-in-depth: cliente só executa tools da whitelist
  if (ctx && ctx.tipo === 'cliente' && !TOOLS_PERMITIDAS_CLIENTE.has(name)) {
    return { erro: `Operação "${name}" não está disponível pelo portal do cliente.` };
  }
  try {
    return await tool.run(ctx, args || {});
  } catch (e) {
    return { erro: `Falha ao executar ${name}: ${e.message}` };
  }
}

module.exports = { getToolDefinitions, getToolDefinitionsParaContexto, runTool, TOOLS };
