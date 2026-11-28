// E-mail no domínio marshconsultoria.com.br (chamado #116): remetente, Reply-To e contato vêm das variáveis
// EMAIL_FROM / EMAIL_RESPOSTA / EMAIL_CONTATO. Não precisa de banco nem de servidor: o Resend e o banco
// são trocados por dublês. Rode: node testes/email-dominio.js
const path = require('path');

const ok = (c, msg) => { console.log(c ? 'OK  ' : 'FAIL', msg); if (!c) process.exitCode = 1; };
const enviados = [];

function carregar(env) {
  for (const k of ['EMAIL_FROM', 'EMAIL_RESPOSTA', 'EMAIL_CONTATO', 'RENDER']) delete process.env[k];
  Object.assign(process.env, { RESEND_API_KEY: 'teste' }, env);
  const raiz = path.join(__dirname, '..');
  const resendPath = require.resolve('resend', { paths: [raiz] });
  const dbPath = require.resolve('../backend/db');
  const emailPath = require.resolve('../backend/services/email');
  const comercialPath = require.resolve('../backend/services/comercial');
  for (const p of [emailPath, comercialPath]) delete require.cache[p];
  require.cache[resendPath] = { id: resendPath, filename: resendPath, loaded: true,
    exports: { Resend: class { constructor() { this.emails = { send: async m => { enviados.push(m); return { data: { id: 'x' } }; } }; } } } };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true,
    exports: { query: async () => ({ rows: [] }) } };
  return require(emailPath);
}

(async () => {
  // 1) Sem variáveis: remetente noreply@ do domínio, resposta e contato na caixa da Locaweb
  let email = carregar({});
  await email.enviarRespostaSolicitante({ para: 'cliente@exemplo.com', chamado: { id: 1, titulo: 'T' },
    assinatura: 'Equipe', texto: 'Oi' });
  let m = enviados.pop();
  ok(m && m.from === 'Marsh Consultoria <noreply@marshconsultoria.com.br>', `remetente padrão: ${m && m.from}`);
  ok(m && m.replyTo === 'daniel.marsh@marshconsultoria.com.br', `Reply-To padrão (não se perde no noreply@): ${m && m.replyTo}`);
  ok(m && m.html.includes('mailto:daniel.marsh@marshconsultoria.com.br'), 'rodapé com o contato padrão');

  // 2) Reply-To do consultor no cliente continua tendo prioridade
  await email.enviarRespostaSolicitante({ para: 'cliente@exemplo.com', chamado: { id: 2, titulo: 'T' },
    assinatura: 'Equipe', texto: 'Oi', replyTo: 'consultor@cliente.com.br' });
  m = enviados.pop();
  ok(m && m.replyTo === 'consultor@cliente.com.br', 'Reply-To informado no envio é mantido');

  // 3) Com variáveis: tudo sai dos endereços configurados
  email = carregar({ EMAIL_FROM: 'Marsh <comunicacao@marshconsultoria.com.br>',
    EMAIL_RESPOSTA: 'contato@marshconsultoria.com.br', EMAIL_CONTATO: 'contato@marshconsultoria.com.br' });
  await email.enviarRespostaSolicitante({ para: 'cliente@exemplo.com', chamado: { id: 3, titulo: 'T' },
    assinatura: 'Equipe', texto: 'Oi' });
  m = enviados.pop();
  ok(m && m.from === 'Marsh <comunicacao@marshconsultoria.com.br>', 'EMAIL_FROM define o remetente');
  ok(m && m.replyTo === 'contato@marshconsultoria.com.br', 'EMAIL_RESPOSTA define o Reply-To');
  ok(m && m.html.includes('mailto:contato@marshconsultoria.com.br') && !m.html.includes('daniel.marsh@'),
    'EMAIL_CONTATO define o rodapé');
  const { PADRAO_PROPOSTA } = require('../backend/services/comercial');
  if (PADRAO_PROPOSTA) ok(PADRAO_PROPOSTA.prop_contato.startsWith('contato@marshconsultoria.com.br'), 'proposta usa EMAIL_CONTATO');

  ok(enviados.length === 0, 'nenhum envio sobrando');
})().catch(e => { console.error(e); process.exitCode = 1; });
