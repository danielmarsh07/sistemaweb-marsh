# Sistema Marsh — regras do projeto

## Versionamento (OBRIGATÓRIO a cada commit enviado ao GitHub)

Todo push em `main` vai para produção (auto-deploy do Render) e **toda atualização ganha uma versão nova**, no mesmo commit:

1. Adicione uma entrada **no topo** do array em [`frontend/comum/changelog.js`](frontend/comum/changelog.js):
   ```js
   { versao: 'v2.8', data: 'AAAA-MM-DD', destaques: ['...', '...'] },
   ```
2. **Numeração:** o número depois do ponto vai de `.0` a `.9`, e depois de `v2.9` vem `v3.0` (nunca `v2.10`). Módulo novo ou visual novo pode pular para o próximo inteiro.
3. **Data:** dia da publicação **no horário de Brasília**:
   `new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' })`.
4. **Destaques** em linguagem de usuário: o que mudou para quem usa, não como foi feito. Correção pequena também conta (ex.: "Corrigida a voz da Ivy, que ainda saía masculina").
5. Rode `node testes/versoes.js` antes do commit (confere número, ordem e datas).
6. Mencione a versão na mensagem do commit (ex.: `v2.8: ...`).

A versão aparece no rodapé do menu, na tela de login, na página **Sistema → Versões** e em `GET /api/saude` (campo `versao`, para conferir se o deploy subiu).

## Outras regras

- `.env` aponta para **produção**; teste sempre com `npm run dev:local` (banco Docker na porta 5545). Os testes em `testes/` abortam fora do banco local.
- Commits com a identidade do dono: `git -c user.email="daniel.marsh.sap@gmail.com" -c user.name="danielmarsh07" commit ...`.
- Estrutura: `backend/` (rotas e serviços), `frontend/{site,sistema,comum}` (servidas na raiz), `docs/`, `testes/`. Detalhes de cada módulo no [README](README.md).
