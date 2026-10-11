// Integração com o Asaas — emissão de NFS-e e, opcionalmente, cobrança PIX das faturas
// (sem PIX ligado, o pagamento é por transferência com baixa manual).
// O Asaas emite pelo Portal Nacional da NFS-e quando a conta está configurada nele.
// Variáveis: ASAAS_API_KEY (obrigatória p/ emitir), ASAAS_AMBIENTE = 'producao' | 'sandbox' (padrão sandbox),
//            ASAAS_WEBHOOK_TOKEN (confere o header asaas-access-token do webhook).
const pool = require('../db');

const BASES = {
  producao: 'https://api.asaas.com/v3',
  sandbox: 'https://api-sandbox.asaas.com/v3'
};

function ambiente() {
  return process.env.ASAAS_AMBIENTE === 'producao' ? 'producao' : 'sandbox';
}

function configurado() {
  return !!process.env.ASAAS_API_KEY;
}

async function chamar(metodo, caminho, corpo) {
  if (!configurado()) throw new Error('Asaas não configurado (defina ASAAS_API_KEY).');
  const res = await fetch(BASES[ambiente()] + caminho, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'sistemaweb-marsh',
      access_token: process.env.ASAAS_API_KEY
    },
    body: corpo ? JSON.stringify(corpo) : undefined
  });
  const texto = await res.text();
  let dados = null;
  try { dados = texto ? JSON.parse(texto) : null; } catch { dados = { bruto: texto }; }
  if (!res.ok) {
    const msg = dados && Array.isArray(dados.errors)
      ? dados.errors.map(e => e.description).join(' | ')
      : `HTTP ${res.status}`;
    const err = new Error(`Asaas: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return dados;
}

const soDigitos = s => String(s || '').replace(/\D/g, '');

function dadosCliente(cliente) {
  return {
    name: cliente.razao_social || cliente.nome,
    cpfCnpj: soDigitos(cliente.cpf_cnpj),
    email: cliente.email_financeiro || cliente.email || undefined,
    postalCode: soDigitos(cliente.cep) || undefined,
    address: cliente.logradouro || undefined,
    addressNumber: cliente.numero || undefined,
    complement: cliente.complemento || undefined,
    province: cliente.bairro || undefined,
    municipalInscription: cliente.inscricao_municipal || undefined,
    stateInscription: cliente.inscricao_estadual || undefined,
    notificationDisabled: true, // quem avisa o cliente é o Sistema Marsh
    externalReference: `cliente-${cliente.id}`
  };
}

// A NFS-e exige o endereço do tomador: avisa antes de mandar ao Asaas, com o que falta
function validarClienteParaNota(cliente) {
  const nome = cliente.nome_fantasia || cliente.razao_social || cliente.nome;
  const faltando = [
    !soDigitos(cliente.cpf_cnpj) && 'CPF/CNPJ',
    soDigitos(cliente.cep).length !== 8 && 'CEP',
    !String(cliente.logradouro || '').trim() && 'logradouro',
    !String(cliente.numero || '').trim() && 'número',
    !String(cliente.bairro || '').trim() && 'bairro'
  ].filter(Boolean);
  if (faltando.length) throw new Error(`Cadastro de "${nome}" incompleto para a nota fiscal: falta ${faltando.join(', ')}. Complete em Clientes e emita de novo.`);
}

// Garante o cliente no Asaas (procura pelo CPF/CNPJ antes de criar) e guarda o id em clientes.asaas_customer_id.
// Se já existe, reenvia os dados: um endereço corrigido no sistema passa a valer na próxima nota.
async function garantirCliente(cliente) {
  const dados = dadosCliente(cliente);
  if (!dados.cpfCnpj) throw new Error('Cliente sem CPF/CNPJ: obrigatório para emitir NFS-e.');
  if (cliente.asaas_customer_id) {
    try { await chamar('POST', `/customers/${cliente.asaas_customer_id}`, dados); }
    catch (err) { console.error('[Asaas] atualizar cliente:', err.message); }
    return cliente.asaas_customer_id;
  }
  const busca = await chamar('GET', `/customers?cpfCnpj=${dados.cpfCnpj}`);
  let id = busca && busca.data && busca.data[0] && busca.data[0].id;
  if (id) await chamar('POST', `/customers/${id}`, dados).catch(err => console.error('[Asaas] atualizar cliente:', err.message));
  else id = (await chamar('POST', '/customers', dados)).id;
  await pool.query('UPDATE clientes SET asaas_customer_id = $1 WHERE id = $2', [id, cliente.id]);
  return id;
}

// Prefeituras com lista própria de serviços (Bragança Paulista é uma) exigem o id do item da lista.
// Acha o item pelo código ("01.06" → "1.06 - ..."); sem lista ou sem item, segue com o código.
const _servicos = new Map();
async function resolverServico(codigo) {
  if (!codigo) return null;
  if (_servicos.has(codigo)) return _servicos.get(codigo);
  const curto = String(codigo).trim().replace(/^0+(?=\d)/, ''); // "01.06" → "1.06"
  let achado = null;
  try {
    const r = await chamar('GET', `/fiscalInfo/services?limit=100&description=${encodeURIComponent(curto)}`);
    achado = (r.data || []).find(s => {
      const d = String(s.description || '').trim();
      return d.startsWith(curto + ' ') || d.startsWith(curto + ' -') || d.startsWith(String(codigo) + ' ');
    }) || null;
  } catch (err) {
    // Portal Nacional não publica a lista: segue com o código
    console.error('[Asaas] lista de serviços indisponível:', err.message);
  }
  const res = achado ? { id: achado.id, nome: achado.description } : null;
  _servicos.set(codigo, res);
  return res;
}

// Agenda a NFS-e avulsa (sem cobrança vinculada) para hoje e pede a emissão imediata
async function emitirNotaFatura(fatura, cliente) {
  validarClienteParaNota(cliente);
  const customer = await garantirCliente(cliente);
  const servico = await resolverServico(fatura.codigo_servico);
  const hoje = new Date().toISOString().slice(0, 10);
  const aliquota = Number(fatura.aliquota_iss || 0);

  const nota = await chamar('POST', '/invoices', {
    customer,
    serviceDescription: fatura.descricao,
    observations: fatura.observacoes || `Fatura #${fatura.id} — competência ${String(fatura.competencia).slice(0, 7)}`,
    externalReference: `fatura-${fatura.id}`,
    value: Number(fatura.valor),
    deductions: 0,
    effectiveDate: hoje,
    municipalServiceId: servico ? servico.id : undefined,
    municipalServiceCode: servico ? undefined : fatura.codigo_servico,
    municipalServiceName: fatura.nome_servico || (servico && servico.nome) || undefined,
    // Alíquotas (%) das retenções federais feitas pelo tomador
    taxes: {
      retainIss: !!fatura.reter_iss,
      iss: aliquota,
      ir: Number(fatura.ret_ir || 0),
      csll: Number(fatura.ret_csll || 0),
      pis: Number(fatura.ret_pis || 0),
      cofins: Number(fatura.ret_cofins || 0),
      inss: Number(fatura.ret_inss || 0)
    }
  });

  let final = nota;
  try {
    final = await chamar('POST', `/invoices/${nota.id}/authorize`);
  } catch (err) {
    // Recusa de validação (4xx): a nota agendada também falharia. Cancela no Asaas e mostra o motivo na fatura.
    if (err.status >= 400 && err.status < 500) {
      await chamar('POST', `/invoices/${nota.id}/cancel`, {}).catch(e => console.error('[Asaas] cancelar nota recusada:', e.message));
      throw err;
    }
    // Instabilidade (5xx/rede): segue agendada para hoje; o Asaas emite sozinho e a rotina horária sincroniza
    console.error('[Asaas] authorize falhou, segue agendada:', err.message);
  }
  return final;
}

// A conta tem a configuração fiscal salva? (sem ela o Asaas não emite). Cache de 5 min.
let _fiscal = { em: 0, ok: null };
async function fiscalConfigurado() {
  if (!configurado()) return false;
  if (Date.now() - _fiscal.em < 5 * 60 * 1000) return _fiscal.ok;
  let ok = null;
  try { await chamar('GET', '/fiscalInfo'); ok = true; }
  catch (err) { ok = err.status === 404 ? false : null; } // outro erro = não sabemos
  _fiscal = { em: Date.now(), ok };
  return ok;
}

async function consultarNota(id) {
  return chamar('GET', `/invoices/${id}`);
}

async function cancelarNota(id) {
  return chamar('POST', `/invoices/${id}/cancel`, {});
}

// Status do Asaas → status interno de faturas.nfse_status
const STATUS_NFSE = {
  SCHEDULED: 'processando',
  SYNCHRONIZED: 'processando',
  AUTHORIZATION_PENDING: 'processando',
  AUTHORIZED: 'emitida',
  PROCESSING_CANCELLATION: 'cancelando',
  CANCELED: 'cancelada',
  CANCELLATION_DENIED: 'emitida',
  ERROR: 'erro'
};

// Grava na fatura o retrato atual da nota no Asaas
async function aplicarNotaNaFatura(faturaId, nota) {
  const status = STATUS_NFSE[nota.status] || 'processando';
  await pool.query(
    `UPDATE faturas SET
       nfse_status = $1, nfse_asaas_id = $2, nfse_numero = $3, nfse_codigo_verificacao = $4,
       nfse_pdf_url = $5, nfse_xml_url = $6,
       nfse_erro = $7, data_atualizacao = NOW()
     WHERE id = $8`,
    [status, nota.id, nota.number || null, nota.validationCode || null,
     nota.pdfUrl || null, nota.xmlUrl || null,
     status === 'erro' ? (nota.statusDescription || 'Erro na emissão') : null,
     faturaId]
  );
  return status;
}

// ===== Cobrança PIX =====
// Cria a cobrança no valor que o cliente paga (líquido das retenções) e busca o QR code.
// Vencimento no passado vira hoje (o Asaas não aceita dueDate retroativo).
async function criarCobrancaPix({ fatura, cliente, valor, descricao }) {
  const customer = await garantirCliente(cliente);
  const hoje = new Date().toISOString().slice(0, 10);
  const venc = String(fatura.data_vencimento).slice(0, 10);
  const cobranca = await chamar('POST', '/payments', {
    customer,
    billingType: 'PIX',
    value: Number(valor),
    dueDate: venc < hoje ? hoje : venc,
    description: String(descricao || '').slice(0, 500),
    externalReference: `cobranca-fatura-${fatura.id}`
  });
  try {
    const qr = await chamar('GET', `/payments/${cobranca.id}/pixQrCode`);
    return { cobranca, qr };
  } catch (err) {
    // Sem QR code a cobrança não serve: apaga para não ficar órfã no Asaas
    await chamar('DELETE', `/payments/${cobranca.id}`).catch(() => {});
    throw err;
  }
}

const consultarCobranca = id => chamar('GET', `/payments/${id}`);
const cancelarCobranca = id => chamar('DELETE', `/payments/${id}`);
const alterarVencimentoCobranca = (id, dueDate) => chamar('POST', `/payments/${id}`, { dueDate });

// Status do Asaas → faturas.pix_status
const STATUS_PIX = {
  PENDING: 'pendente', OVERDUE: 'pendente', AWAITING_RISK_ANALYSIS: 'pendente',
  RECEIVED: 'pago', CONFIRMED: 'pago', RECEIVED_IN_CASH: 'pago',
  REFUNDED: 'estornado', REFUND_REQUESTED: 'estornado', REFUND_IN_PROGRESS: 'estornado',
  DELETED: 'cancelado'
};

module.exports = {
  ambiente, configurado, fiscalConfigurado, garantirCliente, emitirNotaFatura,
  consultarNota, cancelarNota, aplicarNotaNaFatura, STATUS_NFSE,
  criarCobrancaPix, consultarCobranca, cancelarCobranca, alterarVencimentoCobranca, STATUS_PIX
};
