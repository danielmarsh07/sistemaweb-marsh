// Rotina periódica do marketing (roda dentro do próprio servidor, como a do financeiro):
//  - a cada 5 min: publica no Instagram os posts agendados cuja hora chegou (e marca como erro os que
//    ficaram travados em "publicando" por queda do servidor);
//  - 1 vez por dia (primeira passada após subir e depois a cada virada de dia em São Paulo):
//    renova o token perto de vencer, grava os seguidores do dia e as métricas dos posts dos últimos 30 dias.
// Desligar: MARKETING_JOBS=off (os testes chamam as funções direto).
const mk = require('./marketing');
const { registrarAlerta } = require('./alertas');

const CINCO_MIN = 5 * 60 * 1000;
let rodando = false;
let ultimoDiario = null; // data (AAAA-MM-DD, São Paulo) da última rotina diária

const hojeSp = () => new Date().toLocaleDateString('sv-SE', { timeZone: mk.FUSO });

async function ciclo() {
  if (rodando) return;
  rodando = true;
  try {
    await mk.liberarTravados();
    await mk.publicarPendentes();
    if (ultimoDiario !== hojeSp()) {
      ultimoDiario = hojeSp();
      await mk.rotinaDiaria();
    }
  } catch (err) {
    registrarAlerta({ chave: 'job:marketing', titulo: 'Rotina do marketing (Instagram) falhou', detalhe: err.stack || err.message });
  } finally {
    rodando = false;
  }
}

function iniciar() {
  if (String(process.env.MARKETING_JOBS || '').toLowerCase() === 'off') {
    console.log('Marketing: rotina de publicação desligada (MARKETING_JOBS=off)');
    return;
  }
  setTimeout(ciclo, 90 * 1000); // primeira passada 1,5 min após subir
  setInterval(ciclo, CINCO_MIN);
}

module.exports = {
  iniciar, ciclo,
  // expostas para os testes chamarem sem esperar o relógio
  publicarPendentes: mk.publicarPendentes,
  liberarTravados: mk.liberarTravados,
  rotinaDiaria: mk.rotinaDiaria
};
