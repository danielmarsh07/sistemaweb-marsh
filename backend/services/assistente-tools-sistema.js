// ============================================================================
// Tools de "sistema inteiro" da Ivy (uso exclusivo do administrador dono do sistema):
//   estrutura_banco      → tabelas, colunas, tipos e ligações (information_schema)
//   consultar_banco      → SELECT livre escrito pela IA, em transação SÓ LEITURA
//   documentacao_sistema → trechos do README e de docs/*.md (como cada módulo funciona)
//
// Travas do consultar_banco: um único SELECT/WITH, sem comentários, transação READ ONLY
// (o Postgres recusa qualquer escrita, até dentro de CTE ou função), timeout de 5 s,
// no máximo 50 linhas e colunas sensíveis (senha, token, hash, chave...) mascaradas.
// ============================================================================

const fs = require('fs');
const path = require('path');
const pool = require('../db');

const MAX_LINHAS = 50;
const SENSIVEL = /(senha|password|token|secret|segredo|cifrad|hash|chave_privada|api_key|apikey)/i;

// ---------------------------------------------------------------------------
// estrutura_banco
// ---------------------------------------------------------------------------

const estrutura_banco = {
  definition: {
    type: 'function',
    function: {
      name: 'estrutura_banco',
      description: 'Estrutura do banco de dados do sistema. Sem "tabela": lista todas as tabelas com o número aproximado de linhas e os nomes das colunas. Com "tabela": colunas com tipo, obrigatoriedade, padrão e as ligações (chaves estrangeiras). Use antes de consultar_banco para saber os nomes certos, e para perguntas como "quais tabelas existem?", "como é guardado um chamado?".',
      parameters: {
        type: 'object',
        properties: { tabela: { type: 'string', description: 'Nome (ou parte do nome) da tabela.' } },
        additionalProperties: false
      }
    }
  },
  run: async (ctx, args) => {
    if (!args.tabela) {
      const r = await pool.query(
        `SELECT t.table_name AS tabela,
                COALESCE((SELECT c.reltuples::bigint FROM pg_class c WHERE c.oid = to_regclass('public.' || quote_ident(t.table_name))), 0) AS linhas_aprox,
                string_agg(col.column_name, ', ' ORDER BY col.ordinal_position) AS colunas
         FROM information_schema.tables t
         JOIN information_schema.columns col ON col.table_schema = t.table_schema AND col.table_name = t.table_name
         WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
         GROUP BY t.table_name ORDER BY t.table_name`);
      return { total_tabelas: r.rows.length, tabelas: r.rows.map(x => ({ ...x, linhas_aprox: Math.max(0, Number(x.linhas_aprox)) })) };
    }
    const achadas = (await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name ILIKE $1 ORDER BY length(table_name) LIMIT 5`,
      [`%${args.tabela}%`])).rows.map(x => x.table_name);
    if (!achadas.length) return { erro: `Não existe tabela parecida com "${args.tabela}". Chame estrutura_banco sem tabela para ver a lista.` };
    const tabela = achadas.find(t => t === args.tabela) || achadas[0];
    const [cols, fks, total] = await Promise.all([
      pool.query(
        `SELECT column_name AS coluna, data_type AS tipo, is_nullable = 'NO' AS obrigatoria, column_default AS padrao
         FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [tabela]),
      pool.query(
        `SELECT kcu.column_name AS coluna, ccu.table_name AS referencia_tabela, ccu.column_name AS referencia_coluna
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
         JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
         WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public' AND tc.table_name = $1`, [tabela]),
      pool.query(`SELECT COUNT(*)::int AS n FROM "${tabela.replace(/"/g, '')}"`)
    ]);
    return {
      tabela, outras_parecidas: achadas.filter(t => t !== tabela), linhas: total.rows[0].n,
      colunas: cols.rows.map(c => ({ ...c, padrao: c.padrao && c.padrao.length > 60 ? c.padrao.slice(0, 60) + '…' : c.padrao })),
      ligacoes: fks.rows
    };
  }
};

// ---------------------------------------------------------------------------
// consultar_banco
// ---------------------------------------------------------------------------

function validarSql(sql) {
  let s = String(sql || '').trim().replace(/;\s*$/, '');
  if (!s) return { erro: 'Consulta vazia.' };
  if (s.length > 4000) return { erro: 'Consulta longa demais (máx. 4000 caracteres).' };
  if (/--|\/\*/.test(s)) return { erro: 'Tire os comentários da consulta.' };
  if (s.includes(';')) return { erro: 'Uma consulta por vez (sem ";").' };
  if (!/^(select|with)\b/i.test(s)) return { erro: 'Só consultas de leitura: comece com SELECT ou WITH.' };
  if (/\b(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke|copy|vacuum|call|do|lock|set|reset|listen|notify)\b/i.test(s.replace(/'[^']*'/g, "''"))) {
    return { erro: 'A consulta tem um comando de escrita ou administração; só leitura é permitida.' };
  }
  if (/\b(pg_read|pg_ls|pg_stat_file|lo_import|lo_export|dblink|pg_sleep|pg_terminate|pg_cancel|set_config)\w*/i.test(s)) {
    return { erro: 'Função não permitida na consulta.' };
  }
  return { sql: s };
}

function limparValor(v) {
  if (v === null || v === undefined) return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') v = JSON.stringify(v);
  if (typeof v === 'string' && v.length > 300) return v.slice(0, 300) + '…';
  return v;
}

const consultar_banco = {
  definition: {
    type: 'function',
    function: {
      name: 'consultar_banco',
      description: 'Executa uma consulta SQL de LEITURA (PostgreSQL) no banco do sistema e devolve até 50 linhas. Use para qualquer pergunta sobre os dados que as outras tools não cobrem ("quantos clientes cadastrei este ano?", "qual cliente tem mais chamados?", "quanto paguei de AWS em 2026?"). Antes, confira nomes de tabelas e colunas com estrutura_banco. Regras: um único SELECT (ou WITH ... SELECT), sem comentários; filtre empresa_id = a empresa do usuário quando a tabela tiver essa coluna; agregue (COUNT, SUM, GROUP BY) em vez de trazer linhas soltas. Colunas de senha, token e hash vêm mascaradas.',
      parameters: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'A consulta SELECT.' },
          objetivo: { type: 'string', description: 'Em uma frase, o que a consulta responde (fica no log).' }
        },
        required: ['sql'],
        additionalProperties: false
      }
    }
  },
  run: async (ctx, args) => {
    const v = validarSql(args.sql);
    if (v.erro) return { erro: v.erro };
    const client = await pool.connect();
    try {
      await client.query('BEGIN TRANSACTION READ ONLY');
      await client.query(`SET LOCAL statement_timeout = '5s'`);
      const r = await client.query(`SELECT * FROM (${v.sql}) AS consulta_ivy LIMIT ${MAX_LINHAS + 1}`);
      const mascaradas = r.fields.map(f => f.name).filter(n => SENSIVEL.test(n));
      const linhas = r.rows.slice(0, MAX_LINHAS).map(row => Object.fromEntries(
        Object.entries(row).map(([k, val]) => [k, SENSIVEL.test(k) && val !== null ? '[oculto]' : limparValor(val)])));
      console.log(`[Ivy consultar_banco] usuario=${ctx.usuario_id} linhas=${linhas.length} objetivo="${(args.objetivo || '').slice(0, 120)}"`);
      return {
        colunas: r.fields.map(f => f.name),
        linhas,
        quantidade: linhas.length,
        cortado_em_50: r.rows.length > MAX_LINHAS,
        colunas_mascaradas: mascaradas.length ? mascaradas : undefined
      };
    } catch (e) {
      return { erro: `O banco recusou a consulta: ${e.message}. Confira os nomes com estrutura_banco e tente de novo.` };
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  }
};

// ---------------------------------------------------------------------------
// documentacao_sistema
// ---------------------------------------------------------------------------

const RAIZ = path.join(__dirname, '..', '..');
const ARQUIVOS_DOC = ['README.md', 'docs/prd.md', 'docs/licencas-conector.md', 'docs/avaliacao-e-proximos-passos.md', 'testes/README.md'];
let _secoes = null;

// Quebra os .md em seções por título (#, ##, ###), com o caminho de títulos para dar contexto
function secoes() {
  if (_secoes) return _secoes;
  _secoes = [];
  for (const arq of ARQUIVOS_DOC) {
    let texto;
    try { texto = fs.readFileSync(path.join(RAIZ, arq), 'utf8'); } catch { continue; }
    const trilha = [];
    let atual = null;
    for (const linha of texto.split(/\r?\n/)) {
      const h = /^(#{1,3})\s+(.*)/.exec(linha);
      if (h) {
        const nivel = h[1].length;
        trilha.length = nivel - 1;
        trilha[nivel - 1] = h[2].trim();
        atual = { arquivo: arq, titulo: trilha.filter(Boolean).join(' › '), texto: '' };
        _secoes.push(atual);
      } else if (atual) {
        atual.texto += linha + '\n';
      }
    }
  }
  return _secoes;
}

const semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const documentacao_sistema = {
  definition: {
    type: 'function',
    function: {
      name: 'documentacao_sistema',
      description: 'Documentação do Sistema Marsh (README, PRD, licenças do conector, backlog): como cada módulo funciona, regras de negócio, rotas, variáveis de ambiente, testes e próximos passos. Sem "busca": o índice de seções (mapa do sistema). Com "busca": as seções mais relevantes. Use para "como funciona o faturamento?", "o que falta fazer no sistema?", "que variáveis o marketing usa?".',
      parameters: {
        type: 'object',
        properties: { busca: { type: 'string', description: 'Palavras-chave (ex.: "fluxo de caixa", "NFS-e", "conector aprovação").' } },
        additionalProperties: false
      }
    }
  },
  run: async (ctx, args) => {
    const todas = secoes();
    if (!args.busca) return { indice: todas.map(s => `${s.arquivo}: ${s.titulo}`) };
    const termos = semAcento(args.busca).split(/\s+/).filter(t => t.length > 2);
    if (!termos.length) return { erro: 'Busca curta demais.' };
    const pontuadas = todas.map(s => {
      const titulo = semAcento(s.titulo), corpo = semAcento(s.texto);
      const pontos = termos.reduce((p, t) => p + (titulo.includes(t) ? 5 : 0) + Math.min(5, corpo.split(t).length - 1), 0);
      return { s, pontos };
    }).filter(x => x.pontos > 0).sort((a, b) => b.pontos - a.pontos).slice(0, 3);
    if (!pontuadas.length) return { erro: `Nada na documentação sobre "${args.busca}". Tente outras palavras ou consulte o banco.` };
    return {
      secoes: pontuadas.map(({ s }) => ({
        arquivo: s.arquivo, titulo: s.titulo,
        texto: s.texto.trim().length > 2500 ? s.texto.trim().slice(0, 2500) + '…' : s.texto.trim()
      }))
    };
  }
};

const TOOLS_SISTEMA = { estrutura_banco, consultar_banco, documentacao_sistema };

module.exports = { TOOLS_SISTEMA, validarSql };
