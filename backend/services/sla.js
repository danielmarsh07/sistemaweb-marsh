// Calcula informações de SLA para um chamado.
// Regras (calendário, sem horário comercial — para iteração futura):
//   crítica → 2h • alta → 8h • média → 24h • baixa → 72h
//
// sla_status:
//   'ok'        → ainda há mais de 25% do prazo restante
//   'alerta'    → restam menos de 25% (mas não estourou)
//   'estourado' → prazo passou e chamado não foi resolvido/fechado
//   'concluido' → chamado já resolvido/fechado (não conta SLA)

const HORAS_POR_PRIORIDADE = {
  critica: 2,
  alta: 8,
  media: 24,
  baixa: 72
};

function calcularSla(chamado) {
  if (!chamado || !chamado.data_abertura) return null;
  const horas = HORAS_POR_PRIORIDADE[chamado.prioridade] || HORAS_POR_PRIORIDADE.media;
  const abertura = new Date(chamado.data_abertura);
  const prazo = new Date(abertura.getTime() + horas * 3600 * 1000);

  const concluido = chamado.status === 'resolvido' || chamado.status === 'fechado';
  if (concluido) {
    return {
      prazo_resposta: prazo.toISOString(),
      horas_sla: horas,
      sla_status: 'concluido',
      restante_minutos: null
    };
  }

  const agora = new Date();
  const restanteMs = prazo.getTime() - agora.getTime();
  const restanteMin = Math.round(restanteMs / 60000);
  const totalMs = horas * 3600 * 1000;

  let status;
  if (restanteMs <= 0) status = 'estourado';
  else if (restanteMs / totalMs <= 0.25) status = 'alerta';
  else status = 'ok';

  return {
    prazo_resposta: prazo.toISOString(),
    horas_sla: horas,
    sla_status: status,
    restante_minutos: restanteMin
  };
}

module.exports = { calcularSla, HORAS_POR_PRIORIDADE };
