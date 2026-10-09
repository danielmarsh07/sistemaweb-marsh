# Licenças do conector Claude ↔ SAP

Módulo do Sistema Marsh que controla o contrato de cada cliente do conector (projeto
`SAP\Integration ECC`). Painel: **Produtos SAP → Licenças**.

## Como funciona

```
Conector no cliente --(chave + SID + hash do usuário)--> /api/licencas-conector/validar
                    <--(licença assinada Ed25519, vale até 7 dias)--
Conector            --(só contadores por ferramenta)---> /api/licencas-conector/uso
```

- **Chave** `MRSH-XXXX-XXXX-XXXX`: aparece uma única vez (criar / gerar nova). No banco fica só o hash SHA-256.
- **Planos**: `leitura` (sem gravação), `desenvolvimento` e `empresa` (com gravação).
- **Recusas na hora**: chave inválida, licença suspensa/cancelada/vencida, SID fora da licença,
  limite de usuários (usuários distintos nos últimos 30 dias).
- **Servidor fora do ar**: o conector usa a licença em cache até expirar (7 dias), depois mais
  7 dias só leitura, depois bloqueia.
- **Privacidade**: o servidor nunca recebe código nem dados do SAP; o usuário SAP chega como hash.

## Colocar em produção (uma vez)

1. Gerar o par de chaves, localmente:
   ```
   node scripts/gerar-chaves-licenca.js
   ```
2. Render → serviço → **Environment** → `LICENCA_CHAVE_PRIVADA` = a linha da chave privada.
   Nunca no git. Sem ela, `/validar` responde 503.
3. A chave pública vai para `SAP\Integration ECC\src\mcp_sap_adt\chave_publica_licenca.pem`
   (fixa no conector: ele não aceita chave pública vinda do servidor).
4. No `.env` do conector de cada cliente:
   ```
   SAP_LICENSE_KEY=MRSH-....
   SAP_LICENSE_SERVER=https://<portal-marsh>/api/licencas-conector
   ```
   Sem `SAP_LICENSE_KEY` o conector roda em **modo interno Marsh** (uso próprio).

Trocar o par de chaves invalida as licenças em cache dos clientes — só se a privada vazar.

## Testes feitos (2026-10-09, banco descartável em Docker)

- Portal: 22/22 (criação, hash, perfis, assinatura, SID, limite de usuários, uso, suspensão,
  nova chave, vencimento, cancelamento, migração de tema única).
- Conector: 8/8 (validação, bloqueio de escrita no plano leitura, envio de uso, cache offline,
  cache adulterado recusado, SID recusado, modo interno).
