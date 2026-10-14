// Histórico de versões (frontend/comum/changelog.js): confere as regras de numeração e de data.
// Não precisa de banco nem de servidor. Rode antes de cada commit: node testes/versoes.js
const { CHANGELOG, VERSAO_ATUAL } = require('../frontend/comum/changelog');

const ok = (c, msg) => { console.log(c ? 'OK  ' : 'FAIL', msg); if (!c) process.exitCode = 1; };
const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const num = v => { const m = /^v(\d+)\.(\d)$/.exec(v); return m ? Number(m[1]) * 10 + Number(m[2]) : null; };

ok(Array.isArray(CHANGELOG) && CHANGELOG.length > 0, `${CHANGELOG.length} versões no histórico`);
ok(VERSAO_ATUAL === CHANGELOG[0].versao, `versão atual = primeira da lista (${VERSAO_ATUAL})`);
ok(CHANGELOG.every(v => num(v.versao) !== null), 'todas no formato vN.D (de .0 a .9, nunca .10)');
ok(new Set(CHANGELOG.map(v => v.versao)).size === CHANGELOG.length, 'nenhuma versão repetida');
ok(CHANGELOG.every((v, i) => i === 0 || num(CHANGELOG[i - 1].versao) > num(v.versao)), 'ordem decrescente: a mais nova no topo');
ok(CHANGELOG.every(v => /^\d{4}-\d{2}-\d{2}$/.test(v.data) && !isNaN(Date.parse(v.data))), 'datas no formato AAAA-MM-DD');
ok(CHANGELOG.every((v, i) => i === 0 || CHANGELOG[i - 1].data >= v.data), 'datas não voltam no tempo');
ok(CHANGELOG[0].data <= hoje, `versão atual não está no futuro (${CHANGELOG[0].data}, hoje ${hoje} em Brasília)`);
ok(CHANGELOG.every(v => Array.isArray(v.destaques) && v.destaques.length > 0 && v.destaques.every(d => typeof d === 'string' && d.trim().length > 10)),
  'toda versão tem destaques escritos');
