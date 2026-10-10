// Integração com o Asaas — só emissão de NFS-e (o pagamento é por transferência, com baixa manual).
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

// Garante o cliente no Asaas (procura pelo CPF/CNPJ antes de criar) e guarda o id em clientes.asaas_customer_id
async function garantirCliente(cliente) {
  if (cliente.asaas_customer_id) return cliente.asaas_customer_id;
  const doc = soDigitos(cliente.cpf_cnpj);
  if (!doc) throw new Error('Cliente sem CPF/CNPJ: obrigatório para emitir NFS-e.');

  const busca = await chamar('GET', `/customers?cpfCnpj=${doc}`);
  let id = busca && busca.data && busca.data[0] && busca.data[0].id;
  if (!id) {
    const novo = await chamar('POST', '/customers', {
      name: cliente.razao_social || cliente.nome,
      cpfCnpj: doc,
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
    });
    id = novo.id;
  }
  await pool.query('UPDATE clientes SET asaas_customer_id = $1 WHERE id = $2', [id, cliente.id]);
  return id;
}

// Agenda a NFS-e avulsa (sem cobrança vinculada) para hoje e pede a emissão imediata
async function emitirNotaFatura(fatura, cliente) {
  const customer = await garantirCliente(cliente);
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
    municipalServiceCode: fatura.codigo_servico,
    municipalServiceName: fatura.nome_servico,
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
    // Agendada para hoje: o Asaas emite sozinho mesmo se a antecipação falhar
    console.error('[Asaas] authorize falhou, segue agendada:', err.message);
  }
  return final;
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

module.exports = {
  ambiente, configurado, garantirCliente, emitirNotaFatura,
  consultarNota, cancelarNota, aplicarNotaNaFatura, STATUS_NFSE
};
