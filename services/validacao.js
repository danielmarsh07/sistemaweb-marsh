// Validação de CPF e CNPJ com dígito verificador.
// Aceita string com pontuação ou só números. Retorna boolean.

function apenasDigitos(s) {
  return String(s || '').replace(/\D/g, '');
}

function validarCPF(cpf) {
  const d = apenasDigitos(cpf);
  if (d.length !== 11) return false;
  if (/^(\d)\1+$/.test(d)) return false;

  let soma = 0;
  for (let i = 0; i < 9; i++) soma += parseInt(d[i]) * (10 - i);
  let dv1 = (soma * 10) % 11;
  if (dv1 === 10) dv1 = 0;
  if (dv1 !== parseInt(d[9])) return false;

  soma = 0;
  for (let i = 0; i < 10; i++) soma += parseInt(d[i]) * (11 - i);
  let dv2 = (soma * 10) % 11;
  if (dv2 === 10) dv2 = 0;
  return dv2 === parseInt(d[10]);
}

function validarCNPJ(cnpj) {
  const d = apenasDigitos(cnpj);
  if (d.length !== 14) return false;
  if (/^(\d)\1+$/.test(d)) return false;

  const pesos1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  let soma = 0;
  for (let i = 0; i < 12; i++) soma += parseInt(d[i]) * pesos1[i];
  let dv1 = soma % 11;
  dv1 = dv1 < 2 ? 0 : 11 - dv1;
  if (dv1 !== parseInt(d[12])) return false;

  const pesos2 = [6, ...pesos1];
  soma = 0;
  for (let i = 0; i < 13; i++) soma += parseInt(d[i]) * pesos2[i];
  let dv2 = soma % 11;
  dv2 = dv2 < 2 ? 0 : 11 - dv2;
  return dv2 === parseInt(d[13]);
}

// Aceita CPF (11 dígitos) ou CNPJ (14 dígitos). Vazio passa.
function validarDocumento(doc) {
  if (!doc) return true;
  const d = apenasDigitos(doc);
  if (d.length === 11) return validarCPF(d);
  if (d.length === 14) return validarCNPJ(d);
  return false;
}

module.exports = { validarCPF, validarCNPJ, validarDocumento, apenasDigitos };
