// Abstração de storage S3-compatível (AWS S3 ou Cloudflare R2).
// Inicialização lazy: se as env vars não estiverem configuradas, `disponivel` fica false
// e os endpoints retornam 503 — o resto do app continua funcionando.

const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, CopyObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');

const BUCKET = process.env.S3_BUCKET;
const ENDPOINT = process.env.S3_ENDPOINT || undefined; // R2 precisa, S3 padrão deixa vazio
const REGION = process.env.S3_REGION || 'auto';
const ACCESS_KEY = process.env.S3_ACCESS_KEY_ID;
const SECRET_KEY = process.env.S3_SECRET_ACCESS_KEY;
const URL_TTL_SECONDS = parseInt(process.env.S3_URL_TTL || '300', 10); // presigned URL = 5min default

const disponivel = Boolean(BUCKET && ACCESS_KEY && SECRET_KEY);

let _client = null;
function client() {
  if (!disponivel) return null;
  if (_client) return _client;
  _client = new S3Client({
    region: REGION,
    endpoint: ENDPOINT,
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
    forcePathStyle: !!ENDPOINT // R2 e MinIO usam path-style
  });
  return _client;
}

// Sanitiza um nome de arquivo para uso em key (sem path traversal e sem caracteres problemáticos)
function sanitizarNome(nome) {
  return String(nome || 'arquivo')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove acentos
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 200);
}

function gerarKey(chamadoId, nomeOriginal) {
  const id = crypto.randomBytes(8).toString('hex');
  return `chamados/${chamadoId}/${id}-${sanitizarNome(nomeOriginal)}`;
}

async function upload({ chamadoId, nomeOriginal, buffer, mimeType }) {
  if (!disponivel) throw new Error('Storage não configurado');
  const key = gerarKey(chamadoId, nomeOriginal);
  await client().send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: mimeType || 'application/octet-stream'
  }));
  return key;
}

// Grava numa key já definida (ex.: instalador do conector em conector/...)
async function uploadNaKey({ key, buffer, mimeType }) {
  if (!disponivel) throw new Error('Storage não configurado');
  await client().send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: mimeType || 'application/octet-stream'
  }));
  return key;
}

// nomeArquivo (opcional): força o download com esse nome em vez de abrir no navegador
// ttlSegundos (opcional): validade do link; padrão S3_URL_TTL (5 min). O Instagram usa 1 h para buscar a imagem.
async function getDownloadUrl(key, nomeArquivo, ttlSegundos) {
  if (!disponivel) throw new Error('Storage não configurado');
  const cmd = { Bucket: BUCKET, Key: key };
  if (nomeArquivo) cmd.ResponseContentDisposition = `attachment; filename="${sanitizarNome(nomeArquivo)}"`;
  return getSignedUrl(client(), new GetObjectCommand(cmd), {
    expiresIn: ttlSegundos || URL_TTL_SECONDS
  });
}

// Copia um objeto dentro do bucket (ex.: duplicar post do marketing com as mesmas imagens)
async function copiar(keyOrigem, keyDestino) {
  if (!disponivel) throw new Error('Storage não configurado');
  await client().send(new CopyObjectCommand({
    Bucket: BUCKET,
    Key: keyDestino,
    CopySource: `${BUCKET}/${keyOrigem.split('/').map(encodeURIComponent).join('/')}`
  }));
  return keyDestino;
}

async function remove(key) {
  if (!disponivel) throw new Error('Storage não configurado');
  await client().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

module.exports = { disponivel, upload, uploadNaKey, getDownloadUrl, copiar, remove, sanitizarNome };
