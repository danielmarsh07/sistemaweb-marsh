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
  window._fichaRetorno = null;
  closeModal(document.getElementById('modal-ficha-cliente'));
  showPage(pagina);
}

// A ficha é o painel de controle da empresa: clicar num item abre o editor dele e, ao fechar ou salvar,
// a ficha volta sozinha (atualizada). closeModal (script.js) reabre a ficha guardada em window._fichaRetorno.
let _fichaAtual = null;
function abrirDaFicha(acao) {
  const id = _fichaAtual;
  window._fichaRetorno = null;
  closeModal(document.getElementById('modal-ficha-cliente'));
  window._fichaRetorno = id;
  Promise.resolve().then(acao).catch(err => { console.error(err); window._fichaRetorno = null; abrirFichaCliente(id); });
}

const fichaEditarContrato = id => abrirDaFicha(async () => { await loadContratos(); editarContrato(id); });
// + Novo contrato: escolhe o tipo (serviço, licenças do Conector, cursos) já com este cliente
const fichaNovoContrato = () => abrirDaFicha(() => novoContrato(_fichaAtual));
const fichaConector = kid => abrirDaFicha(() => abrirContratoConector(kid));
const fichaContratoCursos = id => abrirDaFicha(() => abrirContratoCursos(id));
const fichaNovoContratoCursos = () => abrirDaFicha(() => abrirNovoContratoCursos(_fichaAtual));
const fichaEditarUsuario = (id, nome, email) => abrirDaFicha(() => abrirEditarUsuario(id, nome, email, 'cliente', _fichaAtual));

async function fichaAdicionarAdmin() {
  const email = prompt('E-mail do administrador da empresa (vê e distribui as licenças do Conector no portal):');
  if (!email) return;
  const nome = prompt('Nome (para quem ainda não tem acesso ao portal):', '') || '';
  const res = await apiFetch(`${API_URL}/contratos-conector/clientes/${_fichaAtual}/admins`, { method: 'POST', body: JSON.stringify({ email: email.trim(), nome: nome.trim() }) });
  if (!res) return;
  const r = await res.json();
  alert(r.mensagem || r.erro);
  if (res.ok) abrirFichaCliente(_fichaAtual);
}

async function fichaRemoverAdmin(usuarioId, nome) {
  if (!confirm(`Tirar ${nome} dos administradores da empresa? A conta continua.`)) return;
  const res = await apiFetch(`${API_URL}/contratos-conector/clientes/${_fichaAtual}/admins/${usuarioId}`, { method: 'DELETE' });
  if (!res) return;
  const r = await res.json();
  if (!res.ok) { alert(r.erro); return; }
  abrirFichaCliente(_fichaAtual);
}

const ACOES_ATIVIDADE = {
  'contrato.criado': 'Contrato criado', 'contrato.alterado': 'Contrato alterado', 'contrato.reajustado': 'Reajuste aplicado',
  'contrato.encerrado': 'Contrato encerrado', 'vaga.ocupada': 'Licença atribuída', 'vaga.convite_aceito': 'Convite aceito',
  'vaga.liberada': 'Licença revogada', 'vaga.convite_cancelado': 'Convite cancelado', 'vaga.convite_expirado': 'Convite expirou',
  'admin_corporativo.adicionado': 'Administrador adicionado', 'admin_corporativo.removido': 'Administrador removido',
  'usuario.alterado': 'Usuário alterado', 'usuario.desativado': 'Usuário desativado', 'usuario.senha_redefinida': 'Senha redefinida',
  'usuario.senha_definida_convite': 'Convite aceito (senha criada)', 'usuario.senha_definida_redefinir': 'Senha trocada pelo link',
  'contrato.renovado': 'Contrato renovado por mais 12 meses', 'contrato.aviso_vencimento': 'Aviso de vencimento enviado',
  'conector.suspenso_inadimplencia': 'Licenças suspensas por atraso', 'conector.reativado_pagamento': 'Licenças reativadas (fatura paga)'
};
const PERFIL_FICHA = { abap: 'ABAP', funcional: 'Funcional', ambos: 'ABAP + Funcional' };

// Contrato de licenças do Conector na ficha: perfis, uso e situação
const resumoLicencasFicha = k => [
  [k.abap && `${k.abap} ABAP`, k.funcional && `${k.funcional} Funcional`, k.ambos && `${k.ambos} ABAP + Funcional`].filter(Boolean).join(' · ') || 'nenhuma licença',
  `${k.em_uso} em uso`, k.convites ? `${k.convites} convite(s) pendente(s)` : '', `${k.livres} disponível(is)`
].filter(Boolean).join(' · ');
const statusConectorFicha = k => k.status === 'cancelado' ? pill('Cancelado', '#94a3b8')
  : k.status === 'suspenso' ? pill(k.suspenso_por_fatura_id ? `Suspenso por atraso (fatura #${k.suspenso_por_fatura_id})` : 'Suspenso', k.suspenso_por_fatura_id ? '#b42318' : '#b7791f')
  : k.vigente ? pill(`Ativo até ${diaBr(k.data_fim)}`, '#2e7d4f') : pill(`Vencido ${diaBr(k.data_fim)}`, '#b42318');

async function abrirFichaCliente(id) {
  _fichaAtual = id;
  window._fichaRetorno = null;
  const corpo = document.getElementById('ficha-corpo');
  corpo.innerHTML = '<p class="fin-muted">Carregando...</p>';
  document.getElementById('ficha-nome').textContent = 'Cliente';
  document.getElementById('ficha-sub').textContent = '';
  document.getElementById('ficha-btn-editar').onclick = () => abrirDaFicha(() => editarCliente(id));
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
      <div class="ficha-kpis ficha-kpis-4">
        <div><span>Recorrente / mês</span><strong>${formatMoeda(f.mensal_contratado)}</strong></div>
        <div><span>Anual (licenças)</span><strong>${formatMoeda(f.anual_contratado)}</strong></div>
        <div><span>Recebido (12 meses)</span><strong>${formatMoeda(f.recebido_12m)}</strong></div>
        <div class="${f.vencido > 0 ? 'ficha-kpi-alerta' : ''}"><span>Vencido</span><strong>${formatMoeda(f.vencido)}</strong></div>
      </div>`));

    // Todos os contratos numa lista só: serviço, licenças do Conector (com as licenças dentro) e cursos.
    // Contrato de licenças abre a tela das licenças (que mostra a cobrança); os outros, o contrato financeiro.
    const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
    const kPorId = Object.fromEntries((d.conector || []).map(k => [k.id, k]));
    const itemContrato = (ct, k) => {
      const abrir = k ? `fichaConector(${k.id})` : `fichaEditarContrato(${ct.id})`;
      const tipo = k ? 'Licenças do Conector' : ct.tipo === 'produto' ? 'Produto' : 'Serviço';
      return `
      <li class="ficha-clicavel" role="button" tabindex="0" title="Abrir o contrato" onclick="${abrir}" onkeydown="if(event.key==='Enter')${abrir}">
        <div><strong>${escapeHtml(ct.descricao)}</strong>
          <span>CT-${String(ct.id).padStart(4, '0')} · ${tipo} · desde ${diaBr(ct.data_inicio)}${ct.data_fim ? ` até ${diaBr(ct.data_fim)}` : ''} · vence dia ${ct.dia_vencimento}</span>
          ${k ? `<span>${resumoLicencasFicha(k)}</span>` : ''}</div>
        <div class="ficha-dir">${formatMoeda(ct.valor)}${ct.periodicidade === 'anual' ? `/ano (${MESES[ct.mes_cobranca - 1]})` : '/mês'} ${k ? statusConectorFicha(k) : pill(ct.status === 'ativo' ? 'Ativo' : ct.status === 'suspenso' ? 'Suspenso' : 'Encerrado',
          ct.status === 'ativo' ? '#2e7d4f' : ct.status === 'suspenso' ? '#b7791f' : '#94a3b8')}</div></li>`;
    };
    // Licenças sem contrato financeiro (sem cobrança) também aparecem aqui
    const semCobranca = (d.conector || []).filter(k => !k.contrato_financeiro_id).map(k => `
      <li class="ficha-clicavel" role="button" tabindex="0" title="Abrir as licenças" onclick="fichaConector(${k.id})" onkeydown="if(event.key==='Enter')fichaConector(${k.id})">
        <div><strong>Licenças do Conector nº ${k.id}</strong>
          <span>Licenças do Conector · <em>sem cobrança</em></span><span>${resumoLicencasFicha(k)}</span></div>
        <div class="ficha-dir">${statusConectorFicha(k)}</div></li>`);
    // Contratos de cursos (cortesia, pagamento único ou recorrente): um item por contrato, com os cursos
    const COB_CURSOS = { cortesia: 'cortesia', unica: 'pagamento único', mensal: '/mês', anual: '/ano' };
    const cursosItens = (d.contratos_cursos || []).map(k => `
      <li class="ficha-clicavel" role="button" tabindex="0" title="Abrir o contrato de cursos" onclick="fichaContratoCursos(${k.id})" onkeydown="if(event.key==='Enter')fichaContratoCursos(${k.id})">
        <div><strong>Contrato de cursos nº ${k.id}</strong>
          <span>Cursos · ${k.ocupadas} de ${k.vagas} vaga(s) ocupada(s) · desde ${diaBr(k.data_inicio)}${k.data_fim ? ` até ${diaBr(k.data_fim)}` : ' · sem prazo'}</span>
          <span>${escapeHtml(k.cursos.join(' · ') || 'nenhum curso')}</span></div>
        <div class="ficha-dir">${k.cobranca === 'cortesia' ? 'Cortesia' : `${formatMoeda(k.valor)} ${COB_CURSOS[k.cobranca]}`}
          ${k.status !== 'ativo' ? pill('Encerrado', '#94a3b8') : k.vigente ? pill('Ativo', '#2e7d4f') : pill(`Vencido ${diaBr(k.data_fim)}`, '#b42318')}</div></li>`);
    const itens = [...d.contratos.filter(ct => !ct.contrato_cursos_id).map(ct => itemContrato(ct, ct.contrato_conector_id && kPorId[ct.contrato_conector_id])),
      ...semCobranca, ...cursosItens];
    caixas.push(fichaCaixa('Contratos', (itens.length ? `<ul class="ficha-lista">${itens.join('')}</ul>` : fichaVazio('Nenhum contrato.'))
      + `<div class="ficha-botoes"><button type="button" class="btn btn-primary btn-sm" onclick="fichaNovoContrato()">+ Novo contrato</button></div>`,
      { texto: 'Contratos', acao: "irPara('contratos')" }, 'ficha-caixa-larga'));

    caixas.push(fichaCaixa('Faturas recentes', d.faturas.length ? `<ul class="ficha-lista">${d.faturas.map(ft => {
      const st = ft.status === 'paga' ? pill(`Paga ${diaBr(ft.data_pagamento)}`, '#2e7d4f') : ft.status === 'rascunho' ? pill('Rascunho', '#64748b')
        : ft.vencida ? pill('Vencida', '#b42318') : pill('Em aberto', '#1d6fd8');
      const nota = ft.nfse_numero ? (ft.nfse_pdf_url ? `<a href="${escapeHtml(ft.nfse_pdf_url)}" target="_blank" rel="noopener">NF ${escapeHtml(ft.nfse_numero)}</a>` : `NF ${escapeHtml(ft.nfse_numero)}`) : '';
      return `<li><div><strong>${mesAnoBr(ft.competencia)}</strong><span>vence ${diaBr(ft.data_vencimento)}${nota ? ' · ' + nota : ''}</span></div>
        <div class="ficha-dir">${formatMoeda(ft.valor)} ${st}</div></li>`;
    }).join('')}</ul>` : fichaVazio('Nenhuma fatura.'), { texto: 'Faturamento', acao: "irPara('faturamento')" }));
  }

  // Administradores da empresa no portal: veem e distribuem as licenças e os cursos da empresa
  if (d.admin) {
    const admins = d.usuarios.filter(u => u.admin_empresa);
    const listaAdmins = admins.length ? `<ul class="ficha-lista">${admins.map(a => `
      <li><div><strong>${escapeHtml(a.nome)}</strong><span>${escapeHtml(a.email)}${a.convite_pendente ? ' · convite pendente' : ''}</span></div>
        <div class="ficha-dir">${admins.length > 1 ? `<button type="button" class="btn btn-secondary btn-sm" onclick="fichaRemoverAdmin(${a.id}, '${escapeHtml(a.nome).replace(/'/g, '&#39;')}')">Remover</button>` : ''}</div></li>`).join('')}</ul>`
      : fichaVazio('Ninguém administra a empresa no portal ainda.');
    caixas.push(fichaCaixa('Administradores da empresa no portal', `
      <p class="ficha-resumo">Veem os contratos, distribuem as licenças do Conector e convidam pessoas pelo portal.</p>${listaAdmins}
      <div class="ficha-botoes"><button type="button" class="btn btn-secondary btn-sm" onclick="fichaAdicionarAdmin()">+ Administrador</button></div>`));
  }

  caixas.push(fichaCaixa('Usuários do portal', d.usuarios.length ? `<ul class="ficha-lista">${d.usuarios.map(u => {
    const papeis = [
      u.admin_empresa && pill('Admin da empresa', '#1d6fd8'),
      ...(u.licencas || []).map(l => pill(`${l.estado === 'convidada' ? 'Convite' : 'Licença'} ${PERFIL_FICHA[l.perfil] || l.perfil}`, l.estado === 'convidada' ? '#b7791f' : '#2e7d4f')),
      ...(u.vagas_cursos || []).map(v => pill(`${v.estado === 'convidada' ? 'Convite' : 'Cursos'} (contrato nº ${v.contrato_id})`, v.estado === 'convidada' ? '#b7791f' : '#1d6fd8')),
      !u.admin_empresa && !(u.licencas || []).length && !(u.vagas_cursos || []).length && u.portal_papel !== 'aluno' && pill('Acesso amplo', '#64748b')
    ].filter(Boolean).join(' ');
    return `<li class="ficha-clicavel" role="button" tabindex="0" title="Editar usuário"
        onclick="fichaEditarUsuario(${u.id}, '${escapeHtml(u.nome).replace(/'/g, '&#39;')}', '${escapeHtml(u.email)}')">
      <div><strong>${escapeHtml(u.nome)}</strong><span>${escapeHtml(u.email)}${u.convite_pendente ? ' · ainda não criou a senha' : ''}</span></div>
      <div class="ficha-dir">${papeis} ${u.ativo ? '' : pill('Inativo', '#94a3b8')}</div></li>`;
  }).join('')}</ul>`
    : fichaVazio('Ninguém acessa o portal ainda. Crie um usuário do tipo Cliente.'), { texto: 'Usuários', acao: "irPara('usuarios')" }));

  caixas.push(fichaCaixa('Chamados', `
    <p class="ficha-resumo">${d.chamados.abertos} aberto(s) de ${d.chamados.total}</p>
    ${d.chamados.lista.length ? `<ul class="ficha-lista">${d.chamados.lista.map(ch => {
      const [txt, cor] = STATUS_CHAMADO_FICHA[ch.status] || [ch.status, '#64748b'];
      return `<li><div><strong>#${ch.id} ${escapeHtml(ch.titulo)}</strong><span>${diaBr(ch.data_abertura)} · prioridade ${escapeHtml(ch.prioridade || '-')}</span></div>
        <div class="ficha-dir">${pill(txt, cor)}</div></li>`;
    }).join('')}</ul>` : fichaVazio('Nenhum chamado.')}`, { texto: 'Chamados', acao: "irPara('chamados')" }));

  // Chaves do modelo antigo (uma chave por empresa): só aparece se houver
  const chavesIndividuais = d.licencas.filter(l => !l.vaga_id);
  if (chavesIndividuais.length) {
    caixas.push(fichaCaixa('Chaves do Conector (modelo por empresa)', `<ul class="ficha-lista">${chavesIndividuais.map(l => `
      <li><div><strong>Plano ${escapeHtml(l.plano)}</strong><span>SIDs ${escapeHtml(String(l.sids || '').replace(/,/g, ', '))} · ${l.max_usuarios ? `até ${l.max_usuarios} usuários` : 'usuários ilimitados'}</span></div>
          <div class="ficha-dir">${l.vencida ? pill(`Venceu ${diaBr(l.data_fim)}`, '#b42318') : pill(`${l.status === 'ativa' ? 'Ativa' : l.status} até ${diaBr(l.data_fim)}`, l.status === 'ativa' ? '#2e7d4f' : '#b7791f')}</div></li>`).join('')}</ul>`,
      { texto: 'Licenças', acao: "irPara('licencas')" }));
  }

  // Cursos: liberados para a empresa e quantas pessoas têm cada curso agora, por origem
  const porCurso = new Map(d.cursos_acesso.map(x => [x.id, x]));
  const cursosLinhas = [...d.cursos.map(cu => ({ ...cu, ...(porCurso.get(cu.id) || {}) })),
    ...d.cursos_acesso.filter(x => !d.cursos.some(cu => cu.id === x.id))];
  caixas.push(fichaCaixa('Cursos', (cursosLinhas.length ? `<ul class="ficha-lista">${cursosLinhas.map(cu => {
    const origens = [cu.por_licenca && `${cu.por_licenca} pela licença do Conector`, cu.por_contrato && `${cu.por_contrato} pelo contrato de cursos`,
      cu.pela_empresa && `${cu.pela_empresa} pela empresa`,
      cu.individual && `${cu.individual} individual (compra na Loja ou concessão)`].filter(Boolean).join(' · ');
    const origem = cu.contrato_cursos_id ? pill(`Contrato de cursos nº ${cu.contrato_cursos_id}`, '#1d6fd8')
      : cu.aulas !== undefined ? pill('Liberado p/ empresa', '#64748b') : '';
    return `<li><div><strong>${escapeHtml(cu.titulo)}</strong><span>${origens || 'ninguém com acesso agora'}${cu.acesso_ate ? ` · liberado até ${diaBr(cu.acesso_ate)}` : ''}</span></div>
      <div class="ficha-dir">${origem}</div></li>`;
  }).join('')}</ul>` : fichaVazio('Nenhum curso liberado ou em uso.'))
    + (d.admin ? `<div class="ficha-botoes"><button type="button" class="btn btn-secondary btn-sm" onclick="fichaNovoContratoCursos()">+ Contrato de cursos (por pessoas)</button></div>` : ''),
    { texto: 'Treinamentos', acao: "irPara('treinamentos')" }));

  caixas.push(fichaCaixa('Tecnologias', d.tecnologias.length
    ? `<div class="ficha-tags">${d.tecnologias.map(t => `<span title="${escapeHtml(t.categoria || '')}${t.desde ? ' · desde ' + diaBr(t.desde) : ''}">${escapeHtml(t.nome)}</span>`).join('')}</div>`
    : fichaVazio('Nenhuma tecnologia vinculada (vincule em Editar cadastro).')));

  if (d.admin) {
    caixas.push(fichaCaixa('Oportunidades', d.oportunidades.length ? `<ul class="ficha-lista">${d.oportunidades.map(o => `
      <li><div><strong>${escapeHtml(o.titulo)}</strong><span>${[o.valor_mensal > 0 && `${formatMoeda(o.valor_mensal)}/mês`, o.valor_unico > 0 && `${formatMoeda(o.valor_unico)} único`].filter(Boolean).join(' + ') || 'sem valor'}</span></div>
          <div class="ficha-dir">${pill(ETAPA_FICHA[o.etapa] || o.etapa, o.etapa === 'ganha' ? '#2e7d4f' : o.etapa === 'perdida' ? '#94a3b8' : '#1d6fd8')}</div></li>`).join('')}</ul>`
      : fichaVazio('Nenhuma oportunidade.'), { texto: 'Funil', acao: "irPara('funil')" }));

    // O que mudou por último na empresa (contratos, licenças, administradores, usuários)
    const quando = v => new Date(v).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
    caixas.push(fichaCaixa('Atividade recente', d.atividade.length ? `<ul class="ficha-lista">${d.atividade.map(a => {
      const extra = (a.contrato_desc ? ` · ${escapeHtml(a.contrato_desc)}` : '')
        + (a.acao === 'contrato.reajustado' && a.depois ? ` ${formatMoeda(a.antes.valor)} → ${formatMoeda(a.depois.valor)}` : '')
        + (a.depois && a.depois.email ? ` · ${escapeHtml(a.depois.email)}` : '');
      return `<li><div><strong>${escapeHtml(ACOES_ATIVIDADE[a.acao] || a.acao)}${extra}</strong>
        <span>${quando(a.criado_em)} · ${a.feito_por ? escapeHtml(a.feito_por) : 'automático'}</span></div></li>`;
    }).join('')}</ul>` : fichaVazio('Nada registrado ainda.'), null, 'ficha-caixa-larga'));
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

// ----- Alertas do sistema -----
let _alertas = [];

async function loadAlertas() {
  const box = document.getElementById('alertas-lista');
  box.innerHTML = '<p class="fin-muted">Carregando...</p>';
  const todos = document.getElementById('alertas-todos').checked ? '?todos=1' : '';
  const res = await apiFetch(`${API_URL}/alertas${todos}`);
  if (!res) return;
  const d = await res.json();
  if (!res.ok) { box.innerHTML = `<p class="fin-muted">${escapeHtml(d.erro)}</p>`; return; }
  _alertas = d.alertas;
  atualizarBadgeAlertas(d.nao_lidos);
  const dataHora = v => new Date(v).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  box.innerHTML = _alertas.length ? _alertas.map(a => `
    <article class="alerta-item alerta-${escapeHtml(a.nivel)}${a.lido ? ' alerta-lido' : ''}">
      <div class="alerta-topo">
        <strong>${escapeHtml(a.titulo)}</strong>
        ${a.lido ? pill('Resolvido', '#64748b') : botao('check', 'Marcar como resolvido', `resolverAlerta(${a.id})`, 'btn-edit')}
      </div>
      <div class="alerta-meta">
        ${a.ocorrencias > 1 ? `${a.ocorrencias} ocorrências · primeira ${dataHora(a.primeira_em)} · ` : ''}última ${dataHora(a.ultima_em)}
        ${a.email_enviado_em ? ` · e-mail enviado ${dataHora(a.email_enviado_em)}` : ''}
      </div>
      ${a.detalhe ? `<details><summary>Detalhe técnico</summary><pre>${escapeHtml(a.detalhe)}</pre></details>` : ''}
    </article>`).join('') : '<p class="alertas-vazio">✓ Nenhum alerta em aberto. Tudo funcionando.</p>';
}

function atualizarBadgeAlertas(n) {
  const b = document.getElementById('badge-alertas');
  if (!b) return;
  b.textContent = n > 99 ? '99+' : String(n);
  b.hidden = !n;
}

// Contador no menu ao abrir o dashboard (só administradores enxergam a rota)
async function carregarContadorAlertas() {
  const u = JSON.parse(localStorage.getItem('usuario') || 'null');
  if (!u || !['admin_empresa', 'admin_sistema'].includes(u.tipo)) return;
  const res = await apiFetch(`${API_URL}/alertas`);
  if (res && res.ok) atualizarBadgeAlertas((await res.json()).nao_lidos);
}

async function resolverAlerta(id) {
  const res = await apiFetch(`${API_URL}/alertas/${id}/lido`, { method: 'POST' });
  if (res && res.ok) loadAlertas();
}

async function resolverTodosAlertas() {
  if (!confirm('Marcar todos os alertas em aberto como resolvidos?')) return;
  const res = await apiFetch(`${API_URL}/alertas/ler-todos`, { method: 'POST' });
  if (res && res.ok) loadAlertas();
}

document.addEventListener('DOMContentLoaded', () => { setTimeout(carregarContadorAlertas, 1500); });

// ----- Ficha do usuário (Usuários → olho) -----
// Dados da pessoa, acesso no portal (licença do Conector, vagas de cursos), cursos liberados agora (a mesma conta do
// "Meus cursos" do portal) e os chamados dela: cliente = os que abriu ou que o Conector abriu pela licença dele;
// equipe = abertos por ele ou atribuídos a ele.
const PERFIS_USUARIO_FICHA = { admin_sistema: 'Admin Sistema', admin_empresa: 'Administrador', tecnico: 'Técnico', cliente: 'Cliente' };
const PAPEL_PORTAL_FICHA = { gestor: 'Gestor do contrato', aluno: 'Usuário de licença' };

function fecharFichaUsuario() { closeModal(document.getElementById('modal-ficha-usuario')); }
function fichaUsuarioAbrirChamado(id) { fecharFichaUsuario(); abrirDetalheChamado(id); }
function fichaUsuarioAbrirCliente(id) { fecharFichaUsuario(); abrirFichaCliente(id); }

async function abrirFichaUsuario(id) {
  const corpo = document.getElementById('ficha-usuario-corpo');
  corpo.innerHTML = '<p class="fin-muted">Carregando...</p>';
  document.getElementById('ficha-usuario-nome').textContent = 'Usuário';
  document.getElementById('ficha-usuario-sub').textContent = '';
  const btnSimular = document.getElementById('ficha-usuario-simular');
  btnSimular.hidden = true;
  showModal('#modal-ficha-usuario');
  const res = await apiFetch(`${API_URL}/usuarios/${id}/ficha`);
  if (!res) return;
  const d = await res.json();
  if (!res.ok) { corpo.innerHTML = `<p class="fin-muted">${escapeHtml(d.erro)}</p>`; return; }
  const u = d.usuario;
  const cliente = u.tipo === 'cliente';

  document.getElementById('ficha-usuario-nome').textContent = u.nome;
  document.getElementById('ficha-usuario-sub').textContent = [u.email, PERFIS_USUARIO_FICHA[u.tipo] || u.tipo, u.cliente_nome].filter(Boolean).join(' · ');
  document.getElementById('ficha-usuario-editar').onclick = () => {
    fecharFichaUsuario();
    abrirEditarUsuario(u.id, u.nome, u.email, u.tipo, u.cliente_id || null);
  };
  if (u.id !== usuario?.id && u.ativo !== false && !u.super_usuario) {
    btnSimular.hidden = false;
    btnSimular.onclick = () => simularAcessoUsuario(u.id);
  }

  // Acesso no portal: o que a pessoa é ali (define o que ela vê)
  const acesso = !cliente ? 'Equipe Marsh (sistema interno)'
    : [u.admin_empresa && 'Administrador da empresa', PAPEL_PORTAL_FICHA[u.portal_papel]].filter(Boolean).join(' · ') || 'Usuário do portal (acesso amplo)';
  const caixas = [fichaCaixa('Dados do usuário', `
    <div class="ficha-campos">
      ${fichaLinha('Nome', escapeHtml(u.nome))}
      ${fichaLinha('E-mail', escapeHtml(u.email))}
      ${fichaLinha('Perfil', escapeHtml(PERFIS_USUARIO_FICHA[u.tipo] || u.tipo) + (u.super_usuario ? ' · super usuário' : ''))}
      ${fichaLinha('Situação', u.ativo !== false ? 'Ativo' : '<span style="color:#b42318">Inativo</span>')}
      ${cliente ? fichaLinha('Empresa', u.cliente_id
        ? `<a href="#" onclick="fichaUsuarioAbrirCliente(${u.cliente_id}); return false;">${escapeHtml(u.cliente_nome || 'cliente')}</a>`
        : '<span style="color:#b42318">sem vínculo com cliente</span>') : ''}
      ${fichaLinha('Acesso', escapeHtml(acesso))}
      ${fichaLinha('Cadastrado em', formatData(u.data_criacao))}
    </div>`, null, 'ficha-caixa-larga')];

  if (cliente) {
    // Licença do Conector (vaga) e vagas de contratos de cursos
    const itensLic = d.vagas.map(v => {
      const st = v.estado === 'convidada' ? pill('Convite pendente', '#b7791f')
        : v.vigente ? pill(`Ativa até ${diaBr(v.licenca_fim || v.data_fim)}`, '#2e7d4f')
        : v.contrato_status === 'suspenso' ? pill('Contrato suspenso', '#b7791f') : pill(`Vencida ${diaBr(v.data_fim)}`, '#b42318');
      return `<li><div><strong>Conector SAP · ${escapeHtml(PERFIL_FICHA[v.perfil] || v.perfil)}</strong>
        <span>Contrato nº ${v.contrato_id}${v.chave_prefixo ? ` · chave ${escapeHtml(v.chave_prefixo)}…` : ''}${v.sids ? ` · servidores ${escapeHtml(String(v.sids).replace(/,/g, ', '))}` : ''}</span></div>
        <div class="ficha-dir">${st}</div></li>`;
    }).concat(d.vagas_cursos.map(v => `<li><div><strong>Vaga de cursos</strong><span>Contrato de cursos nº ${v.contrato_id}</span></div>
        <div class="ficha-dir">${v.estado === 'convidada' ? pill('Convite pendente', '#b7791f') : pill('Ocupada', '#1d6fd8')}</div></li>`));
    caixas.push(fichaCaixa('Licenças e vagas', itensLic.length ? `<ul class="ficha-lista">${itensLic.join('')}</ul>`
      : fichaVazio('Sem licença do Conector nem vaga de cursos.')));

    // Cursos liberados agora, com a origem e o progresso
    caixas.push(fichaCaixa(`Cursos liberados (${d.cursos.length})`, d.cursos.length ? `<ul class="ficha-lista">${d.cursos.map(c => {
      const origens = [c.via_beneficio && 'licença do Conector', c.via_contrato && 'contrato de cursos', c.via_liberacao && 'liberado p/ empresa',
        c.via_compra && (c.compra_sem_fim ? 'compra/concessão' : `compra até ${diaBr(c.compra_fim)}`)].filter(Boolean).join(' · ');
      const pct = c.total_aulas ? Math.round((c.concluidas / c.total_aulas) * 100) : 0;
      return `<li><div><strong>${escapeHtml(c.titulo)}</strong><span>${escapeHtml(origens || 'liberado')}${c.ultima_conclusao ? ` · última aula em ${diaBr(c.ultima_conclusao)}` : ''}</span></div>
        <div class="ficha-dir">${pill(`${c.concluidas}/${c.total_aulas} aulas · ${pct}%`, pct >= 100 ? '#2e7d4f' : pct > 0 ? '#1d6fd8' : '#64748b')}</div></li>`;
    }).join('')}</ul>` : fichaVazio('Nenhum curso liberado para esta pessoa.'), { texto: 'Treinamentos', acao: "fecharFichaUsuario(); showPage('treinamentos')" }));
  }

  // Chamados da pessoa (clique abre o chamado)
  const ch = d.chamados;
  caixas.push(fichaCaixa(cliente ? 'Chamados abertos pela pessoa' : 'Chamados abertos ou atribuídos', `
    <p class="ficha-resumo">${ch.abertos} em aberto de ${ch.total}${ch.total > ch.lista.length ? ` · mostrando os ${ch.lista.length} mais recentes` : ''}</p>
    ${ch.lista.length ? `<ul class="ficha-lista">${ch.lista.map(c => {
      const [txt, cor] = STATUS_CHAMADO_FICHA[c.status] || [String(c.status || '').replace(/_/g, ' '), '#64748b'];
      const detalhes = [formatData(c.data_abertura), !cliente && c.cliente_nome, c.sid && `servidor ${c.sid}${c.modulo ? ' · ' + c.modulo : ''}`,
        c.origem === 'conector' && 'pelo Conector', `prioridade ${({ baixa: 'baixa', media: 'média', alta: 'alta', critica: 'crítica' })[c.prioridade] || '-'}`, !cliente && c.atribuido && 'atribuído a ele'].filter(Boolean);
      return `<li class="ficha-clicavel" role="button" tabindex="0" title="Abrir o chamado" onclick="fichaUsuarioAbrirChamado(${c.id})" onkeydown="if(event.key==='Enter')fichaUsuarioAbrirChamado(${c.id})">
        <div><strong>#${c.id} ${escapeHtml(c.titulo)}</strong><span>${detalhes.map(escapeHtml).join(' · ')}</span></div>
        <div class="ficha-dir">${pill(txt, cor)}</div></li>`;
    }).join('')}</ul>` : fichaVazio('Nenhum chamado.')}`, { texto: 'Chamados', acao: "fecharFichaUsuario(); showPage('chamados')" }, 'ficha-caixa-larga'));

  corpo.innerHTML = caixas.join('');
}
