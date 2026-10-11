// ===== CADASTROS: ficha 360° do cliente, contas e cartões, categorias de despesa =====
// Usa helpers do script.js (apiFetch, API_URL, escapeHtml, formatMoeda, diaBr, showModal, closeModal, iconSVG, showPage)
// e do financeiro.js (pill, botao, mesAnoBr, carregarContasFinanceiras, carregarCategoriasDespesa, abrirContasFinanceiras...).

// ----- Ficha do cliente -----
const STATUS_CHAMADO_FICHA = { aberto: ['Aberto', '#b42318'], em_andamento: ['Em andamento', '#b7791f'], resolvido: ['Resolvido', '#2e7d4f'], fechado: ['Fechado', '#64748b'] };
const ETAPA_FICHA = { lead: 'Lead', qualificacao: 'Qualificação', proposta: 'Proposta', negociacao: 'Negociação', ganha: 'Ganha', perdida: 'Perdida' };

function fichaCaixa(titulo, conteudo, link, extraClasse = '') {
  return `
    <section class="ficha-caixa ${extraClasse}">
      <header><h4>${titulo}</h4>${link ? `<a href="#" onclick="${link.acao}; return false;">${link.texto} →</a>` : ''}</header>
      ${conteudo}
    </section>`;
}

const fichaVazio = txt => `<p class="ficha-vazio">${txt}</p>`;
const fichaLinha = (rotulo, valor) => valor ? `<div class="ficha-campo"><span>${rotulo}</span><strong>${valor}</strong></div>` : '';

function irPara(pagina) {
  closeModal(document.getElementById('modal-ficha-cliente'));
  showPage(pagina);
}

async function abrirFichaCliente(id) {
  const corpo = document.getElementById('ficha-corpo');
  corpo.innerHTML = '<p class="fin-muted">Carregando...</p>';
  document.getElementById('ficha-nome').textContent = 'Cliente';
  document.getElementById('ficha-sub').textContent = '';
  document.getElementById('ficha-btn-editar').onclick = () => { closeModal(document.getElementById('modal-ficha-cliente')); editarCliente(id); };
  showModal('#modal-ficha-cliente');
  const res = await apiFetch(`${API_URL}/clientes/${id}/ficha`);
  if (!res) return;
  const d = await res.json();
  if (!res.ok) { corpo.innerHTML = `<p class="fin-muted">${escapeHtml(d.erro)}</p>`; return; }
  const c = d.cliente;

  document.getElementById('ficha-nome').textContent = c.razao_social || c.nome;
  document.getElementById('ficha-sub').textContent = [c.nome_fantasia, c.cpf_cnpj, c.cidade && `${c.cidade}${c.uf ? '/' + c.uf : ''}`].filter(Boolean).join(' · ');

  // Endereço: a NFS-e exige CEP, logradouro, número e bairro
  const faltaEndereco = ['cep', 'logradouro', 'numero', 'bairro'].filter(k => !String(c[k] || '').trim());
  const endereco = [c.logradouro && `${c.logradouro}${c.numero ? ', ' + c.numero : ''}${c.complemento ? ' — ' + c.complemento : ''}`,
    c.bairro, c.cidade && `${c.cidade}${c.uf ? '/' + c.uf : ''}`, c.cep && `CEP ${c.cep}`].filter(Boolean).map(escapeHtml).join(' · ');
  const dados = `
    <div class="ficha-campos">
      ${fichaLinha('CNPJ / CPF', escapeHtml(c.cpf_cnpj || ''))}
      ${fichaLinha('Inscrição municipal', escapeHtml(c.inscricao_municipal || ''))}
      ${fichaLinha('E-mail', escapeHtml(c.email || ''))}
      ${fichaLinha('E-mail financeiro', escapeHtml(c.email_financeiro || ''))}
      ${fichaLinha('Telefone', escapeHtml(c.telefone || c.celular || ''))}
      ${fichaLinha('Responsável', escapeHtml([c.responsavel_nome, c.responsavel_email, c.responsavel_telefone].filter(Boolean).join(' · ')))}
      ${fichaLinha('Endereço', endereco)}
      ${fichaLinha('Segmento / porte', escapeHtml([c.segmento, c.porte].filter(Boolean).join(' · ')))}
      ${fichaLinha('Observações', escapeHtml(c.observacoes || ''))}
    </div>
    ${faltaEndereco.length ? `<p class="fin-aviso ficha-aviso">Para emitir nota fiscal falta: ${faltaEndereco.map(k => ({ cep: 'CEP', logradouro: 'logradouro', numero: 'número', bairro: 'bairro' }[k])).join(', ')}.</p>` : ''}
    ${!c.email_financeiro && !c.email ? '<p class="fin-aviso ficha-aviso">Sem e-mail: as faturas não serão enviadas.</p>' : ''}`;

  const caixas = [fichaCaixa('Dados do cliente', dados, null, 'ficha-caixa-larga')];

  if (d.admin && d.financeiro) {
    const f = d.financeiro;
    caixas.push(fichaCaixa('Financeiro', `
      <div class="ficha-kpis">
        <div><span>Contratado / mês</span><strong>${formatMoeda(f.mensal_contratado)}</strong></div>
        <div><span>Recebido (12 meses)</span><strong>${formatMoeda(f.recebido_12m)}</strong></div>
        <div class="${f.vencido > 0 ? 'ficha-kpi-alerta' : ''}"><span>Vencido</span><strong>${formatMoeda(f.vencido)}</strong></div>
      </div>`));

    caixas.push(fichaCaixa('Contratos', d.contratos.length ? `<ul class="ficha-lista">${d.contratos.map(ct => `
      <li><div><strong>${escapeHtml(ct.descricao)}</strong><span>desde ${diaBr(ct.data_inicio)}${ct.data_fim ? ` até ${diaBr(ct.data_fim)}` : ''} · vence dia ${ct.dia_vencimento}</span></div>
          <div class="ficha-dir">${formatMoeda(ct.valor)}/mês ${pill(ct.status === 'ativo' ? 'Ativo' : ct.status === 'suspenso' ? 'Suspenso' : 'Encerrado',
            ct.status === 'ativo' ? '#2e7d4f' : ct.status === 'suspenso' ? '#b7791f' : '#94a3b8')}</div></li>`).join('')}</ul>`
      : fichaVazio('Nenhum contrato.'), { texto: 'Contratos', acao: "irPara('contratos')" }));

    caixas.push(fichaCaixa('Faturas recentes', d.faturas.length ? `<ul class="ficha-lista">${d.faturas.map(ft => {
      const st = ft.status === 'paga' ? pill(`Paga ${diaBr(ft.data_pagamento)}`, '#2e7d4f') : ft.status === 'rascunho' ? pill('Rascunho', '#64748b')
        : ft.vencida ? pill('Vencida', '#b42318') : pill('Em aberto', '#1d6fd8');
      const nota = ft.nfse_numero ? (ft.nfse_pdf_url ? `<a href="${escapeHtml(ft.nfse_pdf_url)}" target="_blank" rel="noopener">NF ${escapeHtml(ft.nfse_numero)}</a>` : `NF ${escapeHtml(ft.nfse_numero)}`) : '';
      return `<li><div><strong>${mesAnoBr(ft.competencia)}</strong><span>vence ${diaBr(ft.data_vencimento)}${nota ? ' · ' + nota : ''}</span></div>
        <div class="ficha-dir">${formatMoeda(ft.valor)} ${st}</div></li>`;
    }).join('')}</ul>` : fichaVazio('Nenhuma fatura.'), { texto: 'Faturamento', acao: "irPara('faturamento')" }));
  }

  caixas.push(fichaCaixa('Usuários do portal', d.usuarios.length ? `<ul class="ficha-lista">${d.usuarios.map(u => `
    <li><div><strong>${escapeHtml(u.nome)}</strong><span>${escapeHtml(u.email)}</span></div>
        <div class="ficha-dir">${u.ativo ? pill('Ativo', '#2e7d4f') : pill('Inativo', '#94a3b8')}</div></li>`).join('')}</ul>`
    : fichaVazio('Ninguém acessa o portal ainda. Crie um usuário do tipo Cliente.'), { texto: 'Usuários', acao: "irPara('usuarios')" }));

  caixas.push(fichaCaixa('Chamados', `
    <p class="ficha-resumo">${d.chamados.abertos} aberto(s) de ${d.chamados.total}</p>
    ${d.chamados.lista.length ? `<ul class="ficha-lista">${d.chamados.lista.map(ch => {
      const [txt, cor] = STATUS_CHAMADO_FICHA[ch.status] || [ch.status, '#64748b'];
      return `<li><div><strong>#${ch.id} ${escapeHtml(ch.titulo)}</strong><span>${diaBr(ch.data_abertura)} · prioridade ${escapeHtml(ch.prioridade || '-')}</span></div>
        <div class="ficha-dir">${pill(txt, cor)}</div></li>`;
    }).join('')}</ul>` : fichaVazio('Nenhum chamado.')}`, { texto: 'Chamados', acao: "irPara('chamados')" }));

  caixas.push(fichaCaixa('Licenças do conector SAP', d.licencas.length ? `<ul class="ficha-lista">${d.licencas.map(l => `
    <li><div><strong>Plano ${escapeHtml(l.plano)}</strong><span>SIDs ${escapeHtml(String(l.sids || '').replace(/,/g, ', '))} · ${l.max_usuarios ? `até ${l.max_usuarios} usuários` : 'usuários ilimitados'}</span></div>
        <div class="ficha-dir">${l.vencida ? pill(`Venceu ${diaBr(l.data_fim)}`, '#b42318') : pill(`${l.status === 'ativa' ? 'Ativa' : l.status} até ${diaBr(l.data_fim)}`, l.status === 'ativa' ? '#2e7d4f' : '#b7791f')}</div></li>`).join('')}</ul>`
    : fichaVazio('Sem licença.'), { texto: 'Licenças', acao: "irPara('licencas')" }));

  caixas.push(fichaCaixa('Cursos liberados', d.cursos.length ? `<ul class="ficha-lista">${d.cursos.map(cu => `
    <li><div><strong>${escapeHtml(cu.titulo)}</strong><span>${cu.aulas} aula(s) · ${cu.alunos} aluno(s) com progresso${cu.acesso_ate ? ` · até ${diaBr(cu.acesso_ate)}` : ''}</span></div>
        <div class="ficha-dir">${cu.status === 'publicado' ? pill('Publicado', '#2e7d4f') : pill('Rascunho', '#64748b')}</div></li>`).join('')}</ul>`
    : fichaVazio('Nenhum curso liberado.'), { texto: 'Treinamentos', acao: "irPara('treinamentos')" }));

  caixas.push(fichaCaixa('Tecnologias', d.tecnologias.length
    ? `<div class="ficha-tags">${d.tecnologias.map(t => `<span title="${escapeHtml(t.categoria || '')}${t.desde ? ' · desde ' + diaBr(t.desde) : ''}">${escapeHtml(t.nome)}</span>`).join('')}</div>`
    : fichaVazio('Nenhuma tecnologia vinculada (vincule em Editar cadastro).')));

  if (d.admin) {
    caixas.push(fichaCaixa('Oportunidades', d.oportunidades.length ? `<ul class="ficha-lista">${d.oportunidades.map(o => `
      <li><div><strong>${escapeHtml(o.titulo)}</strong><span>${[o.valor_mensal > 0 && `${formatMoeda(o.valor_mensal)}/mês`, o.valor_unico > 0 && `${formatMoeda(o.valor_unico)} único`].filter(Boolean).join(' + ') || 'sem valor'}</span></div>
          <div class="ficha-dir">${pill(ETAPA_FICHA[o.etapa] || o.etapa, o.etapa === 'ganha' ? '#2e7d4f' : o.etapa === 'perdida' ? '#94a3b8' : '#1d6fd8')}</div></li>`).join('')}</ul>`
      : fichaVazio('Nenhuma oportunidade.'), { texto: 'Funil', acao: "irPara('funil')" }));
  }

  corpo.innerHTML = `<div class="ficha-grade">${caixas.join('')}</div>
    <p class="ficha-rodape">${c.criado_por_nome ? `Cadastrado por ${escapeHtml(c.criado_por_nome)}` : ''}${c.data_criacao ? ` em ${new Date(c.data_criacao).toLocaleDateString('pt-BR')}` : ''}${c.atualizado_por_nome ? ` · última alteração por ${escapeHtml(c.atualizado_por_nome)}` : ''}</p>`;
}

// ----- Contas e cartões (página) -----
async function loadPaginaContasFinanceiras() {
  const tbody = document.getElementById('contas-financeiras-tbody');
  tbody.innerHTML = skeletonRows(6);
  await carregarContasFinanceiras();
  renderPaginaContasFinanceiras();
}

function renderPaginaContasFinanceiras() {
  const tbody = document.getElementById('contas-financeiras-tbody');
  if (!tbody) return;
  tbody.innerHTML = _contasFinanceiras.length ? _contasFinanceiras.map(c => `
    <tr class="${c.ativo ? '' : 'fin-linha-cancelada'}">
      <td data-label="Nome"><strong>${escapeHtml(c.nome)}</strong></td>
      <td data-label="Tipo">${c.tipo === 'cartao' ? 'Cartão de crédito' : 'Conta bancária'}</td>
      <td data-label="Fatura">${c.tipo === 'cartao' ? `vence dia ${c.dia_vencimento}${c.dia_fechamento ? ` · fecha dia ${c.dia_fechamento}` : ''}` : '—'}</td>
      <td data-label="Lançamentos">${c.total_uso}</td>
      <td data-label="Status">${c.ativo ? pill('Ativo', '#2e7d4f') : pill('Inativo', '#94a3b8')}</td>
      <td data-label="Ações" class="td-acoes">
        ${botao('edit', 'Editar', `abrirContasFinanceiras().then(() => editarContaFinanceira(${c.id}))`, 'btn-edit')}
        ${botao(c.ativo ? 'ban' : 'refresh', c.ativo ? 'Desativar' : 'Reativar', `alternarContaFinanceira(${c.id})`)}
      </td>
    </tr>`).join('') : '<tr><td colspan="6" class="text-center">Nenhuma conta ou cartão. Use "+ Nova conta ou cartão".</td></tr>';
}

// ----- Categorias de despesa (página) -----
async function loadPaginaCategoriasDespesa() {
  const tbody = document.getElementById('categorias-despesa-tbody');
  tbody.innerHTML = skeletonRows(5);
  await carregarCategoriasDespesa();
  renderPaginaCategoriasDespesa();
}

function renderPaginaCategoriasDespesa() {
  const tbody = document.getElementById('categorias-despesa-tbody');
  if (!tbody) return;
  const nomeGrupo = id => (_gruposDre.find(g => g.id === id) || {}).nome || id;
  // Na ordem da DRE, para ler de cima para baixo como o demonstrativo
  const ordem = Object.fromEntries(_gruposDre.map((g, i) => [g.id, i]));
  const lista = [..._categoriasDespesa].sort((a, b) => (ordem[a.grupo_dre] ?? 99) - (ordem[b.grupo_dre] ?? 99) || a.nome.localeCompare(b.nome, 'pt-BR'));
  tbody.innerHTML = lista.length ? lista.map(c => `
    <tr class="${c.ativo ? '' : 'fin-linha-cancelada'}">
      <td data-label="Categoria"><strong>${escapeHtml(c.nome)}</strong></td>
      <td data-label="Linha da DRE">${escapeHtml(nomeGrupo(c.grupo_dre))}</td>
      <td data-label="Lançamentos">${c.total_uso}</td>
      <td data-label="Status">${c.ativo ? pill('Ativa', '#2e7d4f') : pill('Inativa', '#94a3b8')}</td>
      <td data-label="Ações" class="td-acoes">
        ${botao('edit', 'Editar', `abrirCategoriasDespesa().then(() => editarCategoriaDespesa(${c.id}))`, 'btn-edit')}
        ${botao(c.ativo ? 'ban' : 'refresh', c.ativo ? 'Desativar' : 'Reativar', `alternarCategoriaDespesa(${c.id})`)}
      </td>
    </tr>`).join('') : '<tr><td colspan="5" class="text-center">Nenhuma categoria.</td></tr>';
}
