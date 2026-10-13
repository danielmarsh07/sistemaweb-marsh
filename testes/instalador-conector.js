require('./_ambiente-local');
// Instalador do conector publicado pelo painel: upload do zip para o storage (S3/R2), recusas,
// e download no portal por link temporário só para cliente com licença ativa.
// Precisa de storage S3-compatível no servidor local, por exemplo (Docker):
//   docker run -d --name marsh-s3mock -p 9090:9090 -e initialBuckets=marsh-teste adobe/s3mock
//   S3_BUCKET=marsh-teste S3_ENDPOINT=http://localhost:9090 S3_REGION=us-east-1 \
//   S3_ACCESS_KEY_ID=teste S3_SECRET_ACCESS_KEY=teste npm run dev:local
// Uso: node testes/instalador-conector.js [caminho do MarshSAP-Conector-x.y.z.zip]
// (sem caminho, gera um zip mínimo válido só para o teste)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pool = require('../backend/db');
const BASE = 'http://localhost:3000/api';

const ok = (c, msg) => console.log(c ? 'OK  ' : 'FAIL', msg);
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

// Zip vazio válido começa com PK\5\6; o servidor exige PK\3\4 (zip com arquivo): monta um mínimo
function zipMinimo() {
  const nome = Buffer.from('leia.txt'), dados = Buffer.from('teste');
  const crc = (() => { let c, crcT = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
    let x = 0xFFFFFFFF; for (const b of dados) x = crcT[(x ^ b) & 0xFF] ^ (x >>> 8); return (x ^ 0xFFFFFFFF) >>> 0; })();
  const loc = Buffer.alloc(30); loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(10, 4); loc.writeUInt32LE(crc, 14);
  loc.writeUInt32LE(dados.length, 18); loc.writeUInt32LE(dados.length, 22); loc.writeUInt16LE(nome.length, 26);
  const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(10, 6);
  cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(dados.length, 20); cen.writeUInt32LE(dados.length, 24); cen.writeUInt16LE(nome.length, 28);
  const tamLoc = 30 + nome.length + dados.length;
  const fim = Buffer.alloc(22); fim.writeUInt32LE(0x06054b50, 0); fim.writeUInt16LE(1, 8); fim.writeUInt16LE(1, 10);
  fim.writeUInt32LE(46 + nome.length, 12); fim.writeUInt32LE(tamLoc, 16);
  return Buffer.concat([loc, nome, dados, cen, nome, fim]);
}

(async () => {
  const arg = process.argv[2];
  const zip = arg ? fs.readFileSync(arg) : zipMinimo();
  const nomeZip = arg ? path.basename(arg) : 'MarshSAP-Conector-9.9.9.zip';
  const versao = /(\d+\.\d+\.\d+)/.exec(nomeZip)[1];

  const cliCom = (await pool.query(`INSERT INTO clientes (nome, razao_social, email, empresa_id, ativo)
    VALUES ('TESTE Inst A','TESTE INSTALADOR A LTDA','inst-a@exemplo.com',1,TRUE) RETURNING id`)).rows[0].id;
  const cliSem = (await pool.query(`INSERT INTO clientes (nome, razao_social, email, empresa_id, ativo)
    VALUES ('TESTE Inst B','TESTE INSTALADOR B LTDA','inst-b@exemplo.com',1,TRUE) RETURNING id`)).rows[0].id;
  const fim = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
  await pool.query(`INSERT INTO licencas (empresa_id, cliente_id, plano, sids, data_fim, status, chave_hash, chave_prefixo)
    VALUES (1, $1, 'leitura', 'DEV', $2, 'ativa', $3, 'MRSH-TEST')`, [cliCom, fim, sha('inst-' + Date.now())]);
  const idsAntes = (await pool.query('SELECT COALESCE(MAX(id), 0) AS m FROM conector_instaladores')).rows[0].m;

  const tok = p => jwt.sign(p, process.env.JWT_SECRET, { expiresIn: '5m' });
  const tokAdmin = tok({ id: 1, tipo: 'admin_empresa', empresa_id: 1 });
  const tokTecnico = tok({ id: 1, tipo: 'tecnico', empresa_id: 1 });
  const tokCom = tok({ id: 999996, tipo: 'cliente', empresa_id: 1, cliente_id: cliCom });
  const tokSem = tok({ id: 999995, tipo: 'cliente', empresa_id: 1, cliente_id: cliSem });

  const enviar = async (t, buffer, nome) => {
    const form = new FormData();
    form.append('arquivo', new Blob([buffer], { type: 'application/zip' }), nome);
    const r = await fetch(`${BASE}/licencas/instaladores`, { method: 'POST', headers: { Authorization: `Bearer ${t}` }, body: form });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const get = async (t, p) => {
    const r = await fetch(BASE + p, { headers: { Authorization: `Bearer ${t}` } });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  try {
    let r = await get(tokAdmin, '/licencas/instaladores');
    ok(r.status === 200 && r.body.storage === true, 'GET /instaladores: storage configurado');
    if (!r.body?.storage) { console.log('     Suba o servidor com as variáveis S3_* (ver topo do arquivo).'); return; }

    r = await enviar(tokAdmin, zip, 'instalador.zip');
    ok(r.status === 400, `nome fora do padrão recusado (${r.status})`);
    r = await enviar(tokAdmin, Buffer.from('não sou zip'), 'MarshSAP-Conector-1.0.0.zip');
    ok(r.status === 400, `conteúdo que não é zip recusado (${r.status})`);
    r = await enviar(tokTecnico, zip, nomeZip);
    ok(r.status === 403, `técnico não publica (${r.status})`);

    const t0 = Date.now();
    r = await enviar(tokAdmin, zip, nomeZip);
    ok(r.status === 201 && r.body.instalador.versao === versao && r.body.instalador.sha256 === sha(zip),
      `admin publica ${nomeZip} (${(zip.length / 1048576).toFixed(1)} MB em ${Date.now() - t0} ms)`);

    r = await get(tokAdmin, '/licencas/instaladores');
    ok(r.body.instaladores[0]?.versao === versao, 'lista mostra a versão publicada em primeiro');

    r = await get(tokCom, '/licencas/download');
    ok(r.status === 200 && r.body.versao === versao && r.body.temporario === true && /X-Amz-Signature=/.test(r.body.url),
      'cliente com licença recebe link assinado temporário');
    const baixado = Buffer.from(await (await fetch(r.body.url)).arrayBuffer());
    ok(sha(baixado) === sha(zip), `download pelo link confere byte a byte (SHA-256 ${sha(zip).slice(0, 12)}…)`);

    r = await get(tokSem, '/licencas/download');
    ok(r.status === 403, `cliente sem licença não baixa (${r.status})`);
    r = await fetch(`${BASE}/licencas/download`);
    ok(r.status === 401, `sem login não baixa (${r.status})`);
  } catch (e) {
    ok(false, 'erro inesperado: ' + e.message);
  } finally {
    await pool.query('DELETE FROM conector_instaladores WHERE id > $1', [idsAntes]);
    await pool.query('DELETE FROM licencas WHERE cliente_id IN ($1, $2)', [cliCom, cliSem]);
    await pool.query('DELETE FROM clientes WHERE id IN ($1, $2)', [cliCom, cliSem]);
    await pool.end();
  }
})();
