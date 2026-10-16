// Usuários reais para os testes: o middleware autenticar confere no banco a cada requisição,
// então token de usuário inexistente (ex.: id 999999) agora recebe 401.
const criados = [];

async function usuarioTeste(pool, { tipo = 'cliente', cliente_id = null, papel = null } = {}) {
  const email = `teste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@teste.local`;
  const r = await pool.query(
    `INSERT INTO usuarios (nome, email, senha, empresa_id, tipo, cliente_id, portal_papel, ativo)
     VALUES ('TESTE usuário', $1, 'x', 1, $2, $3, $4, TRUE) RETURNING id`, [email, tipo, cliente_id, papel]);
  criados.push(r.rows[0].id);
  return r.rows[0].id;
}

// Apaga os criados; quem ganhou histórico (FK) fica só desativado
async function apagarUsuariosTeste(pool) {
  for (const id of criados.splice(0)) {
    await pool.query('DELETE FROM usuarios WHERE id = $1', [id])
      .catch(() => pool.query('UPDATE usuarios SET ativo = FALSE WHERE id = $1', [id]));
  }
}

module.exports = { usuarioTeste, apagarUsuariosTeste };
