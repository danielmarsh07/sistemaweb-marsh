// Espelho da NFS-e em HTML pronto para imprimir / salvar como PDF (no navegador).
// Usado para as notas do modo teste (QAS), que não têm o PDF da prefeitura, e como prévia de nota ainda não emitida.
// Nota emitida de verdade tem o PDF oficial (nfse_pdf_url): o botão da tela abre aquele, não este.
const fat = require('./faturamento');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const moeda = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const pct = v => `${String(Math.round(Number(v || 0) * 100) / 100).replace('.', ',')}%`;
const diaBr = iso => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '—');
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const mesAno = iso => `${MESES[Number(String(iso).slice(5, 7)) - 1]}/${String(iso).slice(0, 4)}`;
const ROTULOS_RET = { ret_ir: 'IRRF', ret_csll: 'CSLL', ret_pis: 'PIS', ret_cofins: 'COFINS', ret_inss: 'INSS' };

function endereco(c) {
  const linha1 = [c.logradouro, c.numero, c.complemento].filter(Boolean).join(', ');
  const linha2 = [c.bairro, [c.cidade, c.uf].filter(Boolean).join('/'), c.cep && `CEP ${c.cep}`].filter(Boolean).join(' · ');
  return [linha1, linha2].filter(Boolean).join('<br>') || esc(c.endereco) || '—';
}

function montarEspelho({ fatura: f, cliente: c, config: cfg }) {
  const emitida = f.nfse_status === 'emitida';
  const tarja = f.nfse_simulada
    ? 'MODO TESTE (QAS) — nota dada como emitida no sistema, sem envio à prefeitura. SEM VALOR FISCAL.'
    : emitida ? null : 'PRÉVIA — esta nota ainda não foi emitida na prefeitura. SEM VALOR FISCAL.';
  const numero = f.nfse_numero || (f.nfse_simulada ? `TESTE-${f.id}` : '—');
  const iss = f.valor * Number(f.aliquota_iss || 0) / 100;
  const retencoes = fat.RETENCOES.filter(r => Number(f[r]) > 0).map(r => ({ nome: ROTULOS_RET[r], pct: f[r], valor: f.valor * f[r] / 100 }));
  if (f.reter_iss && iss > 0) retencoes.push({ nome: 'ISS retido', pct: f.aliquota_iss, valor: iss });
  const liquido = f.valor_liquido ?? f.valor;
  const tomador = c.razao_social || c.nome_fantasia || c.nome;
  const linha = (rot, val) => `<tr><th>${rot}</th><td>${val}</td></tr>`;

  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>NFS-e ${esc(numero)} — ${esc(tomador)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #e2e8f0; color: #0f172a; font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .barra { position: sticky; top: 0; display: flex; gap: 8px; justify-content: flex-end; padding: 10px 16px; background: #0f172a; }
  .barra button { border: 0; border-radius: 8px; padding: 8px 14px; font: inherit; font-weight: 600; cursor: pointer; background: #fff; color: #0f172a; }
  .barra button.prim { background: #1d6fd8; color: #fff; }
  .folha { max-width: 820px; margin: 20px auto; padding: 28px 32px; background: #fff; box-shadow: 0 8px 30px rgba(15, 23, 42, .15); }
  .tarja { margin: 0 0 18px; padding: 10px 12px; border: 2px dashed #b45309; border-radius: 8px; background: #fef3c7; color: #92400e; font-weight: 700; text-align: center; }
  header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; border-bottom: 2px solid #0f172a; padding-bottom: 12px; }
  header h1 { margin: 0; font-size: 18px; letter-spacing: .02em; }
  header .num { text-align: right; }
  header .num strong { display: block; font-size: 20px; }
  h2 { margin: 18px 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #1d6fd8; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; vertical-align: top; padding: 5px 8px; border-bottom: 1px solid #e2e8f0; }
  th { width: 34%; color: #475569; font-weight: 600; }
  .valores td, .valores th { text-align: right; }
  .valores th { text-align: left; }
  .total th, .total td { font-size: 15px; font-weight: 800; border-top: 2px solid #0f172a; border-bottom: 0; }
  .discr { white-space: pre-line; padding: 8px; border: 1px solid #e2e8f0; border-radius: 6px; min-height: 48px; }
  footer { margin-top: 20px; color: #64748b; font-size: 11px; }
  @media print { body { background: #fff; } .barra { display: none; } .folha { margin: 0; box-shadow: none; max-width: none; padding: 0; } }
  @media (max-width: 600px) { .folha { margin: 0; padding: 18px 16px; } header { flex-direction: column; } header .num { text-align: left; } }
</style></head>
<body>
<div class="barra"><button type="button" onclick="window.close()">Fechar</button><button type="button" class="prim" onclick="window.print()">Imprimir / salvar PDF</button></div>
<main class="folha">
  ${tarja ? `<p class="tarja">${tarja}</p>` : ''}
  <header>
    <div><h1>NOTA FISCAL DE SERVIÇOS ELETRÔNICA</h1><div>Competência: ${esc(mesAno(f.competencia))}</div></div>
    <div class="num">Número<strong>${esc(numero)}</strong>Emissão: ${f.data_aprovacao ? new Date(f.data_aprovacao).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—'}</div>
  </header>

  <h2>Prestador do serviço</h2>
  <table>${linha('Razão social', esc(cfg.prop_razao_social || '—'))}${linha('CNPJ', esc(cfg.prop_cnpj || '—'))}${cfg.prop_contato ? linha('Contato', esc(cfg.prop_contato)) : ''}</table>

  <h2>Tomador do serviço</h2>
  <table>${linha('Razão social', esc(tomador))}${linha('CPF/CNPJ', esc(c.cpf_cnpj || '—'))}${c.inscricao_municipal ? linha('Inscrição municipal', esc(c.inscricao_municipal)) : ''}${linha('Endereço', endereco(c))}${linha('E-mail', esc(c.email_financeiro || c.email || '—'))}</table>

  <h2>Serviço</h2>
  <table>${linha('Código', esc(f.codigo_servico || '—'))}${linha('Descrição do serviço', esc(f.nome_servico || '—'))}</table>
  <h2>Discriminação</h2>
  <div class="discr">${esc([f.descricao, f.observacoes].filter(Boolean).join('\n\n'))}</div>

  <h2>Valores</h2>
  <table class="valores">
    ${linha('Valor do serviço', moeda(f.valor))}
    ${linha(`ISS (${pct(f.aliquota_iss)})${f.reter_iss ? ' — retido pelo tomador' : ''}`, moeda(iss))}
    ${retencoes.map(r => linha(`(−) ${r.nome} ${pct(r.pct)}`, moeda(r.valor))).join('')}
    <tr class="total"><th>Valor líquido</th><td>${moeda(liquido)}</td></tr>
  </table>
  <footer>Vencimento da fatura: ${diaBr(f.data_vencimento)}${f.nfse_codigo_verificacao ? ` · Código de verificação: ${esc(f.nfse_codigo_verificacao)}` : ''} · Gerado pelo Sistema Marsh.</footer>
</main>
</body></html>`;
}

async function espelhoDaFatura(fatura) {
  const [cliente, config] = await Promise.all([fat.carregarCliente(fatura.cliente_id), fat.carregarConfig(fatura.empresa_id)]);
  return montarEspelho({ fatura, cliente: cliente || {}, config });
}

module.exports = { montarEspelho, espelhoDaFatura };
