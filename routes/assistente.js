// ============================================================================
// Rota POST /api/assistente/chat
// Recebe texto transcrito da fala do usuário, conversa com a OpenAI usando
// function calling, executa as tools internamente e devolve a resposta final
// em texto (o frontend faz TTS via Web Speech API).
// ============================================================================

const express = require('express');
const rateLimit = require('express-rate-limit');
const OpenAI = require('openai');
const { getToolDefinitions, runTool } = require('../services/assistente-tools');
const elevenLabs = require('../services/assistente-tts');

const router = express.Router();

// Detecta o "tom" da resposta pro frontend pintar o holograma na cor certa.
// 'alerta' quando houve algum erro nas tools OU a resposta menciona problemas.
function detectarTom(respostaTexto, acoes) {
  const erroNaTool = (acoes || []).some(a => a && a.resultado && a.resultado.erro);
  if (erroNaTool) return 'alerta';
  if (!respostaTexto) return 'normal';
  const t = respostaTexto.toLowerCase();
  const palavrasAlerta = [
    'erro', 'falha', 'não consegui', 'nao consegui', 'não foi possível', 'nao foi possivel',
    'atenção', 'atencao', 'cuidado', 'problema', 'inválid', 'invalid',
    'não encontr', 'nao encontr', 'não está cadastr', 'nao esta cadastr'
  ];
  return palavrasAlerta.some(p => t.includes(p)) ? 'alerta' : 'normal';
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODELO = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const MAX_TOOL_ITERATIONS = 6;

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// Rate limit: 20 conversas por minuto por IP (geralmente é por usuário, já que cada um tem seu token)
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas solicitações ao assistente. Aguarde um minuto.' }
});

function systemPrompt(ctx) {
  const hoje = new Date();
  const dataIso = hoje.toISOString().slice(0, 10);
  return `Você é o assistente de voz do Sistema Marsh, um ERP empresarial multi-empresa.
Você ajuda o usuário a registrar transações financeiras, abrir chamados, cadastrar clientes/fornecedores e consultar dados do sistema, tudo por voz.

Contexto do usuário atual:
- Nome: ${ctx.nome || 'usuário'}
- Tipo: ${ctx.tipo || 'usuario'}
- Data de hoje: ${dataIso}

Regras importantes:
1. Sempre que o usuário falar uma data relativa ("hoje", "ontem", "esse mês", "no dia 5"), resolva usando a data de hoje acima ou chamando data_hoje.
2. Antes de criar uma transação, se o usuário disse o nome da categoria mas você não tem certeza se está cadastrada com esse nome exato, chame listar_categorias filtrando pelo tipo. Use o nome exato retornado.
3. Antes de criar um chamado ou referenciar um cliente/fornecedor, use buscar_cliente/buscar_fornecedor pra pegar o id correto.
4. Valores monetários: o usuário fala em reais. "trezentos e cinquenta" = 350, "mil e duzentos" = 1200, "dois mil e quinhentos reais" = 2500.
5. Para a confirmação ao usuário no final, seja conciso, natural e amigável — como uma conversa. Diga o que foi feito sem listar campos técnicos. Exemplo: "Pronto! Lancei trezentos e cinquenta reais de saída na Padaria Central, categoria Alimentação." Evite ler ids/UUIDs em voz alta.
6. Se faltar informação obrigatória (ex: valor, categoria) pergunte ao usuário em vez de inventar. Não invente dados.
7. Se uma tool retornar erro, explique brevemente ao usuário em linguagem natural o que faltou e ofereça a correção.
8. Nunca exponha estrutura interna do banco, nomes de tabelas, IDs longos ou SQL ao falar com o usuário.
9. Responda sempre em português do Brasil.

REGRA DE ESCRITA NO BANCO (CRÍTICA):
Você só pode INSERIR dados nestas entidades: transações, categorias de transação, clientes, fornecedores, chamados e atendimentos.
Você NUNCA pode criar/cadastrar: tecnologias, usuários, empresas, temas ou qualquer outra entidade não listada acima.
Se o usuário pedir explicitamente pra criar algo fora dessas 6 entidades permitidas, recuse educadamente e oriente a fazer pela tela correspondente do dashboard.

FLUXO DE CONFIRMAÇÃO PARA CRIAR CATEGORIAS (OBRIGATÓRIO — 2 TURNOS):
A criação de categoria SEMPRE exige confirmação explícita do usuário antes de executar. Nunca crie no mesmo turno em que ela aparece pela primeira vez.

Caso 1 — usuário pede uma transação com categoria que não existe:
- Turno A (você): chame listar_categorias do tipo, mostre as disponíveis e pergunte: "A categoria <X> ainda não está cadastrada para <tipo>. Quer que eu crie e já lance essa <entrada/saída> de <valor> reais nela?" — PARE aqui, espere o usuário responder.
- Turno B (usuário): se responder afirmativamente ("sim", "pode", "claro", "vai", "isso", "manda ver"), execute na ordem: (1) criar_categoria com usuario_confirmou=true (2) criar_transacao. Se negativo ou se mencionar outra categoria, NÃO crie e siga o que ele pediu.

Caso 2 — usuário pede explicitamente para criar uma categoria ("cria uma categoria de saída chamada Combustível"):
- Turno A (você): "Vou criar a categoria <X> para <entrada/saída>. Confirma?"
- Turno B: só execute criar_categoria com usuario_confirmou=true após resposta afirmativa.

Regras anti-acidente:
- usuario_confirmou só pode ser true se houver no histórico do turno anterior uma pergunta sua de confirmação E uma resposta afirmativa clara do usuário.
- Se o reconhecimento de voz parecer ambíguo (ex: "sim, não sei", "talvez"), peça nova confirmação em vez de criar.
- Nunca crie mais de uma categoria por turno sem confirmação individual.`;
}

router.post('/chat', chatLimiter, async (req, res) => {
  if (!openai) {
    return res.status(503).json({
      erro: 'Assistente de voz não configurado. Variável OPENAI_API_KEY ausente no servidor.'
    });
  }

  const { texto, historico } = req.body;
  if (!texto || typeof texto !== 'string' || texto.trim().length === 0) {
    return res.status(400).json({ erro: 'Campo "texto" é obrigatório.' });
  }
  if (texto.length > 2000) {
    return res.status(400).json({ erro: 'Texto muito longo (máx 2000 caracteres).' });
  }

  const ctx = {
    empresa_id: req.usuario.empresa_id || 1,
    usuario_id: req.usuario.id,
    tipo: req.usuario.tipo,
    nome: req.usuario.nome
  };

  // Reconstrói o histórico curto (últimas 6 mensagens) se enviado pelo cliente,
  // pra dar continuidade entre turnos sem persistir nada no servidor.
  const historicoSeguro = Array.isArray(historico)
    ? historico.slice(-6).filter(m => m && typeof m.role === 'string' && typeof m.content === 'string')
    : [];

  const messages = [
    { role: 'system', content: systemPrompt(ctx) },
    ...historicoSeguro,
    { role: 'user', content: texto }
  ];

  const tools = getToolDefinitions();
  const acoes = [];
  const uiRefresh = new Set();

  try {
    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      const completion = await openai.chat.completions.create({
        model: MODELO,
        messages,
        tools,
        tool_choice: 'auto',
        temperature: 0.3,
        max_tokens: 800
      });

      const msg = completion.choices[0].message;
      messages.push(msg);

      // Sem chamada de tool: é a resposta final ao usuário.
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        const resposta = msg.content || '';
        return res.json({
          resposta,
          tom: detectarTom(resposta, acoes),
          tts_disponivel: elevenLabs.isConfigured(),
          acoes,
          ui_refresh: Array.from(uiRefresh),
          mensagens_para_proximo_turno: [
            { role: 'user', content: texto },
            { role: 'assistant', content: resposta }
          ]
        });
      }

      // Executa cada tool call e devolve o resultado pro modelo no próximo turno.
      for (const tc of msg.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = {}; }
        const resultado = await runTool(tc.function.name, ctx, args);

        acoes.push({ tool: tc.function.name, args, resultado });
        if (Array.isArray(resultado?._ui_refresh)) {
          resultado._ui_refresh.forEach(p => uiRefresh.add(p));
        }

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(resultado).slice(0, 8000) // hard cap pro contexto
        });
      }
    }

    return res.status(500).json({
      erro: 'Assistente não chegou a uma resposta após várias iterações.',
      acoes
    });
  } catch (err) {
    console.error('[assistente/chat]', err);
    return res.status(500).json({
      erro: 'Falha ao processar mensagem.',
      detalhe: err.message
    });
  }
});

// ----------------------------------------------------------------------------
// POST /api/assistente/tts — sintetiza texto em áudio MP3 via ElevenLabs
// ----------------------------------------------------------------------------
const ttsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas solicitações de TTS. Aguarde um minuto.' }
});

router.post('/tts', ttsLimiter, async (req, res) => {
  if (!elevenLabs.isConfigured()) {
    return res.status(503).json({
      erro: 'TTS não configurado. ELEVENLABS_API_KEY ausente no servidor.'
    });
  }
  const { texto } = req.body || {};
  if (!texto || typeof texto !== 'string') {
    return res.status(400).json({ erro: 'Campo "texto" é obrigatório.' });
  }
  if (texto.length > 1500) {
    return res.status(400).json({ erro: 'Texto muito longo para TTS (máx 1500 caracteres).' });
  }
  try {
    const audioBuffer = await elevenLabs.sintetizar(texto);
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'no-store');
    res.send(audioBuffer);
  } catch (err) {
    console.error('[assistente/tts]', err);
    res.status(500).json({ erro: 'Falha ao gerar áudio.', detalhe: err.message });
  }
});

module.exports = router;
