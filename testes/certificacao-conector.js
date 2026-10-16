require('./_ambiente-local');
// Certificado + licença individual do Conector (etapa 2 da venda por vagas):
// concluir todas as aulas do perfil emite certificado (validação pública) e licença (1 máquina, plano do perfil,
// SIDs/validade do contrato, chave visível só para a pessoa); a licença acompanha o contrato (SIDs, suspensão),
// liberar a vaga cancela e voltar reativa a mesma chave; o instalador baixado traz licenca.json dentro do zip.
// Servidor local com cifra e storage (s3mock), por exemplo:
//   docker run -d --name marsh-s3mock -p 9090:9090 -e initialBuckets=marsh-teste adobe/s3mock
//   MARKETING_CHAVE_CIFRA=abab...(64 hex) LICENCA_CHAVE_PRIVADA="$(cat .licenca_chave_privada.txt)" \
//   S3_BUCKET=marsh-teste S3_ENDPOINT=http://localhost:9090 S3_REGION=us-east-1 S3_ACCESS_KEY_ID=teste \
//   S3_SECRET_ACCESS_KEY=teste npm run dev:local
// O zip do teste é montado e conferido com o Compress-Archive/Expand-Archive do Windows (o mesmo do montar_pacote.ps1).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const jwt = require('jsonwebtoken');
const pool = require('../backend/db');
const BASE = 'http://localhost:3000/api';

let falhas = 0;
const ok = (c, msg) => { if (!c) falhas++; console.log(c ? 'OK  ' : 'FAIL', msg); };
const tok = p => jwt.sign({ empresa_id: 1, ...p }, process.env.JWT_SECRET, { expiresIn: '5m' });
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const ps = cmd => execFileSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' });

(async () => {
  const sufixo = Date.now();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pacote-'));
  const cli = (await pool.query(
    `INSERT INTO clientes (nome, razao_social, email, empresa_id, ativo)
     VALUES ('TESTE Cert', 'TESTE CERTIFICACAO LTDA', 'cert@exemplo.com', 1, TRUE) RETURNING id`)).rows[0].id;
  const cursos = {}, aulas = {};
  for (const t of ['abap', 'funcional', 'portal', 'conector']) {
    cursos[t] = (await pool.query(
      `INSERT INTO cursos (empresa_id, titulo, status, trilha, ordem, carga_horaria) VALUES (1, $1, 'publicado', $2, 998, '~1 h') RETURNING id`,
      [`TESTE cert ${t} ${sufixo}`, t])).rows[0].id;
    aulas[t] = [];
    for (let i = 0; i < 2; i++) {
      aulas[t].push((await pool.query('INSERT INTO cursos_aulas (curso_id, titulo, ordem) VALUES ($1, $2, $3) RETURNING id',
        [cursos[t], `Aula ${i + 1}`, i])).rows[0].id);
    }
  }
  // Outros cursos publicados do banco local também contam para o perfil: o teste conclui todos eles
  const extras = (await pool.query(
    `SELECT a.id, c.trilha FROM cursos_aulas a JOIN cursos c ON c.id = a.curso_id
     WHERE a.ativo AND c.ativo AND c.status = 'publicado' AND c.trilha IS NOT NULL AND NOT (c.id = ANY($1))`, [Object.values(cursos)])).rows;
  for (const e of extras) aulas[e.trilha].push(e.id);
  const idsInstAntes = (await pool.query('SELECT COALESCE(MAX(id), 0) AS m FROM conector_instaladores')).rows[0].m;

  const tokAdmin = tok({ id: 1, tipo: 'admin_empresa' });
  const api = async (t, p, m = 'GET', body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (t) headers.Authorization = `Bearer ${t}`;
    const r = await fetch(BASE + p, { method: m, headers, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const usuario = async e => (await pool.query('SELECT * FROM usuarios WHERE LOWER(email) = LOWER($1)', [e])).rows[0];
  const concluir = (t, aula) => api(t, `/treinamentos/aulas/${aula}/concluir`, 'POST', {});
  const fim = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
  const cx = s => ({ sid: s, descricao: s, url: `https://${s.toLowerCase()}.exemplo:8000`, mandante: '100', idioma: 'PT' });

  try {
    // Contrato: 1 ABAP + 1 Funcional, SIDs DEV e QAS
    const k = await api(tokAdmin, '/contratos-conector', 'POST', { cliente_id: cli, gestor_nome: 'Gestor Cert',
      gestor_email: `gestor-cert-${sufixo}@teste.com`, vagas: { abap: 1, funcional: 1 }, data_fim: fim });
    ok(k.status === 201, 'contrato criado');
    const kid = k.body.id;
    await api(tokAdmin, `/contratos-conector/${kid}/conexoes`, 'PUT', { conexoes: [cx('DEV'), cx('QAS')] });
    const det = (await api(tokAdmin, `/contratos-conector/${kid}`)).body;
    const vAbap = det.vagas.find(v => v.perfil === 'abap'), vFunc = det.vagas.find(v => v.perfil === 'funcional');
    await api(tokAdmin, `/contratos-conector/${kid}/vagas/${vAbap.id}/ocupar`, 'POST', { nome: 'Ana ABAP', email: `ana-${sufixo}@teste.com` });
    await api(tokAdmin, `/contratos-conector/${kid}/vagas/${vFunc.id}/ocupar`, 'POST', { nome: 'Fabio Func', email: `fabio-${sufixo}@teste.com` });
    const ana = await usuario(`ana-${sufixo}@teste.com`), fabio = await usuario(`fabio-${sufixo}@teste.com`);
    const tokAna = tok({ id: ana.id, tipo: 'cliente', cliente_id: cli });
    const tokFabio = tok({ id: fabio.id, tipo: 'cliente', cliente_id: cli });

    // --- Antes de concluir ---
    let eu = (await api(tokAna, '/contratos-conector/eu')).body;
    let vaga = eu.vagas[0];
    ok(vaga && !vaga.certificado && !vaga.licenca && vaga.progresso.trilhas.map(t => t.trilha).join() === 'abap,portal,conector',
      '/eu: perfil ABAP com 3 trilhas, sem certificado nem licença');
    ok((await api(tokAna, `/contratos-conector/eu/vagas/${vAbap.id}/pacote`)).status === 403, 'sem licença: instalador bloqueado');

    // --- Conclui tudo menos a última aula: nada; a última emite ---
    const todas = [...aulas.abap, ...aulas.portal, ...aulas.conector];
    for (const a of todas.slice(0, -1)) await concluir(tokAna, a);
    ok(!(await pool.query('SELECT 1 FROM certificados WHERE usuario_id = $1', [ana.id])).rows.length, 'faltando 1 aula: sem certificado');
    const ultima = await concluir(tokAna, todas[todas.length - 1]);
    ok(ultima.status === 200 && ultima.body.certificados?.length === 1, `última aula emite o certificado (${JSON.stringify(ultima.body)})`);
    const codigo = ultima.body.certificados[0];
    ok(/^MC-[A-Z0-9]{8}$/.test(codigo), `código no formato MC-XXXXXXXX (${codigo})`);
    ok((await concluir(tokAna, todas[0])).body.certificados.length === 0, 'concluir de novo não emite outro certificado');

    // --- Certificado público ---
    const pub = await api(null, `/publico/certificado/${codigo}`);
    ok(pub.status === 200 && pub.body.nome === 'Ana ABAP' && pub.body.perfil_nome === 'ABAP' && pub.body.cursos.length >= 3,
      'validação pública mostra nome, perfil e cursos');
    ok((await api(null, '/publico/certificado/MC-AAAAAAAA')).status === 404, 'código inexistente: 404');
    ok((await api(null, '/publico/certificado/qualquer')).status === 404, 'código fora do formato: 404');

    // --- Licença ---
    const lic = (await pool.query('SELECT * FROM licencas WHERE usuario_id = $1', [ana.id])).rows[0];
    ok(lic && lic.plano === 'desenvolvimento' && lic.max_maquinas === 1 && lic.sids === 'DEV,QAS' && lic.status === 'ativa'
      && lic.vaga_id === vAbap.id && lic.titular_email === ana.email, 'licença: desenvolvimento, 1 máquina, SIDs do contrato, titular');
    const fimLic = (await pool.query(`SELECT to_char(data_fim, 'YYYY-MM-DD') AS f FROM licencas WHERE id = $1`, [lic.id])).rows[0].f;
    ok(fimLic === fim, `licença com o fim do contrato (${fimLic})`);
    ok(lic.chave_cifrada && !lic.chave_cifrada.includes('MRSH'), 'chave guardada cifrada');
    eu = (await api(tokAna, '/contratos-conector/eu')).body;
    vaga = eu.vagas[0];
    const chave = vaga.licenca?.chave;
    ok(/^MRSH-/.test(chave || '') && hash(chave) === lic.chave_hash, 'portal mostra a chave completa só para a pessoa');
    ok(vaga.certificado?.codigo === codigo, '/eu traz o certificado');
    const gestorTok = tok({ id: (await usuario(`gestor-cert-${sufixo}@teste.com`)).id, tipo: 'cliente', cliente_id: cli });
    const meus = (await api(gestorTok, '/contratos-conector/meus')).body[0];
    const vg = meus.vagas.find(v => v.id === vAbap.id);
    ok(vg.certificado?.codigo === codigo && vg.licenca?.chave_prefixo && !JSON.stringify(meus).includes(chave),
      'gestor vê certificado e prefixo da licença, nunca a chave');

    // A chave ativa 1 máquina e recusa a segunda
    const ativar = (m) => api(null, '/licencas-conector/ativar', 'POST', { chave, maquina_hash: hash(m), nome_maquina: m });
    const a1 = await ativar(`PC-ANA-${sufixo}`);
    ok(a1.status === 200 && a1.body.plano === 'desenvolvimento' && a1.body.conexoes.length === 2, `ativa a 1ª máquina com as conexões (${a1.status})`);
    const a2 = await ativar(`PC-OUTRO-${sufixo}`);
    ok(a2.status === 403 && a2.body.motivo === 'maquinas', `recusa a 2ª máquina (${a2.body?.motivo})`);

    // Funcional: plano leitura
    for (const a of [...aulas.funcional, ...aulas.portal, ...aulas.conector]) await concluir(tokFabio, a);
    const licF = (await pool.query('SELECT plano FROM licencas WHERE usuario_id = $1', [fabio.id])).rows[0];
    ok(licF && licF.plano === 'leitura', 'perfil Funcional: licença Leitura');

    // --- A licença acompanha o contrato ---
    await api(gestorTok, `/contratos-conector/meus/${kid}/conexoes`, 'PUT', { conexoes: [cx('DEV'), cx('QAS'), cx('HML')] });
    ok((await pool.query('SELECT sids FROM licencas WHERE id = $1', [lic.id])).rows[0].sids === 'DEV,QAS,HML', 'SID novo do gestor chega na licença');
    await api(tokAdmin, `/contratos-conector/${kid}`, 'PUT', { status: 'suspenso' });
    ok((await pool.query('SELECT status FROM licencas WHERE id = $1', [lic.id])).rows[0].status === 'suspensa', 'contrato suspenso: licença suspensa');
    ok((await ativar(`PC-ANA-${sufixo}`)).body?.motivo === 'suspensa', 'conector recusa licença suspensa');
    await api(tokAdmin, `/contratos-conector/${kid}`, 'PUT', { status: 'ativo' });
    ok((await pool.query('SELECT status FROM licencas WHERE id = $1', [lic.id])).rows[0].status === 'ativa', 'contrato reativado: licença ativa');

    // --- Liberar e voltar ---
    await api(tokAdmin, `/contratos-conector/${kid}/vagas/${vAbap.id}/liberar`, 'POST');
    ok((await pool.query('SELECT status FROM licencas WHERE id = $1', [lic.id])).rows[0].status === 'cancelada', 'vaga liberada: licença cancelada');
    await api(tokAdmin, `/contratos-conector/${kid}/vagas/${vAbap.id}/ocupar`, 'POST', { email: ana.email });
    const volta = (await pool.query('SELECT status, chave_hash FROM licencas WHERE usuario_id = $1 AND vaga_id = $2', [ana.id, vAbap.id])).rows;
    ok(volta.length === 1 && volta[0].status === 'ativa' && volta[0].chave_hash === lic.chave_hash, 'mesma pessoa volta: a mesma licença reativa');

    // --- Instalador já configurado ---
    const pasta = path.join(tmp, 'pacote');
    fs.mkdirSync(path.join(pasta, 'app', 'src'), { recursive: true });
    fs.writeFileSync(path.join(pasta, 'Instalar.cmd'), '@echo off\r\necho teste\r\n');
    fs.writeFileSync(path.join(pasta, 'pacote.json'), JSON.stringify({ versao: '9.8.7', servidor_licenca: 'http://localhost' }));
    fs.writeFileSync(path.join(pasta, 'app', 'src', 'modulo.py'), '# conector\n'.repeat(5000));
    const zipBase = path.join(tmp, 'MarshSAP-Conector-9.8.7.zip');
    ps(`Compress-Archive -Path '${pasta}\\*' -DestinationPath '${zipBase}'`);
    const form = new FormData();
    form.append('arquivo', new Blob([fs.readFileSync(zipBase)], { type: 'application/zip' }), 'MarshSAP-Conector-9.8.7.zip');
    const pubInst = await fetch(`${BASE}/licencas/instaladores`, { method: 'POST', headers: { Authorization: `Bearer ${tokAdmin}` }, body: form });
    ok(pubInst.status === 201, `admin publica o instalador de teste (${pubInst.status})`);

    const link = await api(tokAna, `/contratos-conector/eu/vagas/${vAbap.id}/pacote`);
    ok(link.status === 200 && link.body.configurado && /^\/api\/publico\/pacote\//.test(link.body.url), 'portal devolve o link do pacote configurado');
    ok((await api(tokFabio, `/contratos-conector/eu/vagas/${vAbap.id}/pacote`)).status === 403, 'outra pessoa não baixa o pacote da vaga');
    const down = await fetch(`http://localhost:3000${link.body.url}`);
    const buf = Buffer.from(await down.arrayBuffer());
    ok(down.status === 200 && Number(down.headers.get('content-length')) === buf.length, `download com Content-Length correto (${buf.length} bytes)`);
    const zipBaixado = path.join(tmp, 'baixado.zip');
    fs.writeFileSync(zipBaixado, buf);
    const destino = path.join(tmp, 'extraido');
    ps(`Expand-Archive -Path '${zipBaixado}' -DestinationPath '${destino}'`);
    const licJson = JSON.parse(fs.readFileSync(path.join(destino, 'licenca.json'), 'utf8'));
    ok(licJson.chave === chave && licJson.titular === 'Ana ABAP', 'zip abre no Windows e traz licenca.json com a chave da pessoa');
    ok(fs.readFileSync(path.join(destino, 'app', 'src', 'modulo.py'), 'utf8') === '# conector\n'.repeat(5000)
      && fs.existsSync(path.join(destino, 'Instalar.cmd')) && fs.existsSync(path.join(destino, 'pacote.json')),
      'arquivos originais do pacote intactos');
    ok((await fetch(`http://localhost:3000/api/publico/pacote/token-invalido`)).status === 410, 'link inválido/vencido: 410');
    const vencido = jwt.sign({ uso: 'pacote', licenca_id: lic.id, usuario_id: ana.id }, process.env.JWT_SECRET, { expiresIn: -10 });
    ok((await fetch(`http://localhost:3000/api/publico/pacote/${vencido}`)).status === 410, 'link expirado: 410');
  } finally {
    const users = (await pool.query('SELECT id FROM usuarios WHERE cliente_id = $1', [cli])).rows.map(u => u.id);
    const lics = (await pool.query('SELECT id FROM licencas WHERE cliente_id = $1', [cli])).rows.map(l => l.id);
    await pool.query('DELETE FROM licencas_ativacoes WHERE licenca_id = ANY($1)', [lics]);
    await pool.query('DELETE FROM licencas_uso WHERE licenca_id = ANY($1)', [lics]);
    await pool.query('DELETE FROM licencas WHERE id = ANY($1)', [lics]);
    await pool.query('DELETE FROM certificados WHERE usuario_id = ANY($1)', [users]);
    await pool.query('DELETE FROM cursos_progresso WHERE usuario_id = ANY($1)', [users]);
    await pool.query('DELETE FROM contratos_conector_vagas WHERE contrato_id IN (SELECT id FROM contratos_conector WHERE cliente_id = $1)', [cli]);
    await pool.query('DELETE FROM contratos_conector WHERE cliente_id = $1', [cli]);
    await pool.query('DELETE FROM usuarios_tokens WHERE usuario_id = ANY($1)', [users]);
    await pool.query('DELETE FROM usuarios WHERE id = ANY($1)', [users]);
    await pool.query('DELETE FROM cursos_aulas WHERE curso_id = ANY($1)', [Object.values(cursos)]);
    await pool.query('DELETE FROM cursos WHERE id = ANY($1)', [Object.values(cursos)]);
    await pool.query('DELETE FROM clientes WHERE id = $1', [cli]);
    await pool.query('DELETE FROM conector_instaladores WHERE id > $1', [idsInstAntes]);
    await pool.end();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTudo certo.');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
