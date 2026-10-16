/**
 * pacote-instalador.js — entrega o zip do instalador do conector com um arquivo a mais (licenca.json),
 * já configurado para a pessoa: o instalador lê a chave dali e pula a tela da chave.
 *
 * O zip publicado (~30 MB, com o Python embutido) não é carregado na memória: o servidor lê do storage
 * só o fim do arquivo (o índice do zip), repassa os bytes originais em streaming e acrescenta, no lugar
 * do índice antigo, o licenca.json (sem compressão) seguido do índice novo com uma entrada a mais.
 * Formato ZIP padrão (APPNOTE 6.3); zip64 não é suportado (o pacote tem bem menos de 4 GB).
 */
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const storage = require('./storage');

const SIG_EOCD = 0x06054b50;
const TAM_EOCD = 22;

async function lerTudo(stream) {
  const partes = [];
  for await (const p of stream) partes.push(p);
  return Buffer.concat(partes);
}

/** Acha o "fim do diretório central" nos últimos bytes do zip. */
function lerEocd(cauda) {
  for (let i = cauda.length - TAM_EOCD; i >= 0; i--) {
    if (cauda.readUInt32LE(i) !== SIG_EOCD) continue;
    const comentario = cauda.readUInt16LE(i + 20);
    if (i + TAM_EOCD + comentario !== cauda.length) continue; // assinatura falsa no meio dos dados
    const total = cauda.readUInt16LE(i + 10);
    const tamCd = cauda.readUInt32LE(i + 12);
    const offCd = cauda.readUInt32LE(i + 16);
    if (total === 0xffff || tamCd === 0xffffffff || offCd === 0xffffffff) throw new Error('Pacote em zip64 não suportado.');
    return { total, tamCd, offCd };
  }
  throw new Error('Pacote do instalador não é um zip válido.');
}

// Data/hora no formato do DOS (o que o zip guarda)
function dataDos(d = new Date()) {
  const hora = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const data = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { hora, data };
}

/** Cabeçalho local + dados, e a entrada do diretório central, de um arquivo sem compressão. */
function entradaArquivo(nome, conteudo, offsetLocal) {
  const nomeBuf = Buffer.from(nome, 'utf8');
  const crc = zlib.crc32(conteudo) >>> 0;
  const { hora, data } = dataDos();
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);        // versão necessária
  local.writeUInt16LE(0x0800, 6);    // nome em UTF-8
  local.writeUInt16LE(0, 8);         // sem compressão
  local.writeUInt16LE(hora, 10);
  local.writeUInt16LE(data, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(conteudo.length, 18);
  local.writeUInt32LE(conteudo.length, 22);
  local.writeUInt16LE(nomeBuf.length, 26);
  local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);      // feito por
  central.writeUInt16LE(20, 6);      // versão necessária
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(hora, 12);
  central.writeUInt16LE(data, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(conteudo.length, 20);
  central.writeUInt32LE(conteudo.length, 24);
  central.writeUInt16LE(nomeBuf.length, 28);
  // extra, comentário, disco, atributos internos/externos = 0
  central.writeUInt32LE(offsetLocal, 42);
  return { local: Buffer.concat([local, nomeBuf, conteudo]), central: Buffer.concat([central, nomeBuf]) };
}

/**
 * Envia em `res` o zip guardado em `key` com `nomeArquivo` = `conteudo` acrescentado na raiz.
 * nomeDownload = nome do arquivo para o navegador.
 */
async function enviarPacote(res, { key, nomeDownload, nomeArquivo, conteudo }) {
  const tam = await storage.tamanho(key);
  const ini = Math.max(0, tam - (TAM_EOCD + 0xffff));
  const eocd = lerEocd(await lerTudo(await storage.lerTrecho(key, ini, tam - 1)));
  const cd = await lerTudo(await storage.lerTrecho(key, eocd.offCd, eocd.offCd + eocd.tamCd - 1));
  const novo = entradaArquivo(nomeArquivo, Buffer.from(conteudo, 'utf8'), eocd.offCd);
  const fim = Buffer.alloc(TAM_EOCD);
  fim.writeUInt32LE(SIG_EOCD, 0);
  fim.writeUInt16LE(eocd.total + 1, 8);
  fim.writeUInt16LE(eocd.total + 1, 10);
  fim.writeUInt32LE(cd.length + novo.central.length, 12);
  fim.writeUInt32LE(eocd.offCd + novo.local.length, 16);
  fim.writeUInt16LE(0, 20);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${storage.sanitizarNome(nomeDownload)}"`);
  res.setHeader('Content-Length', eocd.offCd + novo.local.length + cd.length + novo.central.length + fim.length);
  res.setHeader('Cache-Control', 'no-store');
  if (eocd.offCd > 0) await pipeline(await storage.lerTrecho(key, 0, eocd.offCd - 1), res, { end: false });
  res.write(novo.local);
  res.write(cd);
  res.write(novo.central);
  res.end(fim);
}

module.exports = { enviarPacote, lerEocd, entradaArquivo };
