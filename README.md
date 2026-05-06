# Teams Proactive Messaging

## Visão Geral

Este repositório contém código de exemplo / prova de conceito (PoC) com o objetivo de demonstrar como implementar envio de mensagens proativas 1:1 em massa via Microsoft Teams, utilizando Bot Framework, Azure Service Bus e Azure Table Storage.

Este projeto foi criado para fins de aprendizado, avaliação e experimentação.

## Aviso Importante

Este repositório contém **código de exemplo e não é destinado para uso em produção**.

Antes de utilizar qualquer parte deste projeto em um ambiente produtivo ou crítico, é essencial revisar, validar, proteger e adaptar o código conforme os requisitos da sua organização, incluindo:

- Segurança
- Escalabilidade
- Confiabilidade
- Monitoramento
- Observabilidade
- Custos
- Conformidade

Leia também:

- [DISCLAIMER.md](./DISCLAIMER.md)
- [SUPPORT.md](./SUPPORT.md)

## O que este exemplo demonstra

- Envio de mensagens proativas 1:1 em massa via Microsoft Teams
- Bot Framework Adapter com SingleTenant authentication
- Armazenamento de conversation references via Azure Table Storage
- Enfileiramento assíncrono de mensagens via Azure Service Bus
- Worker containerizado (Docker) para processamento da fila
- Script CLI para disparo em massa (`npm run send -- "mensagem"`)
- Testes de carga

## Pré-requisitos

- Node.js >= 18
- TypeScript 5.3+
- Azure Bot Registration (SingleTenant)
- Azure Service Bus
- Azure Table Storage
- Docker (para o worker)

## Como iniciar

1. Clone este repositório
2. Instale as dependências:
   ```bash
   npm install
   ```
3. Configure o `.env` a partir do exemplo:
   ```bash
   cp .env.example .env
   ```
   Preencha: `MICROSOFT_APP_ID`, `MICROSOFT_APP_PASSWORD`, `MICROSOFT_APP_TENANT_ID`, `SERVICE_BUS_CONNECTION`, `STORAGE_CONNECTION`
4. Execute em ambiente não produtivo:
   ```bash
   npm run dev
   ```
5. Para envio em massa:
   ```bash
   npm run send -- "Sua mensagem aqui"
   ```
6. Valide o comportamento antes de qualquer adaptação

## Suporte

Este projeto **não possui SLA nem suporte oficial**.

Veja [SUPPORT.md](./SUPPORT.md) para detalhes.

## Aviso Legal

O uso deste projeto está sujeito aos termos descritos em [DISCLAIMER.md](./DISCLAIMER.md).

## Contribuições

Contribuições podem ser aceitas a critério do mantenedor.

## Marcas Registradas (Trademarks)

Os nomes e serviços da Microsoft são utilizados apenas para fins descritivos.

Este projeto **não é afiliado, endossado ou suportado oficialmente pela Microsoft**.

O uso de marcas da Microsoft não deve sugerir qualquer tipo de parceria ou suporte oficial.