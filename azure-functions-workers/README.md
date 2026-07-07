# FisioHelp Workers Functions

Pacote de Azure Functions para executar os workers do backend fora do App Service HTTP.

Este pacote e separado do Function App de SQL jobs em `azure-functions/`.

## Fluxos

- `processarFilaNotificacoes`: chama `workers/notificacoesWorker.tick()`.
- `processarFilaReembolsosGateway`: chama `workers/reembolsosGatewayWorker.tick()`.
- `processarFilaRepassesGateway`: chama `workers/repassesGatewayWorker.tick()`.
- `enfileirarAvaliacoesPendentes`: chama `workers/avaliacoesPendentesWorker.tick()`.
- `enfileirarLembretesConsulta`: chama `workers/consultasLembretesWorker.tick()`.

## Deploy

O pacote de deploy precisa conter estes diretorios do backend:

- `workers`
- `services`
- `providers`
- `config`
- `utils`

Execute:

```bash
npm run prepare:package
```

O diretorio `dist/` resultante e a raiz a ser publicada no Function App de workers.

## App Settings

Este pacote usa o caminho de configuracao dos workers do backend, portanto usa `DB_*`
em vez de `SQL_*`.

As variaveis `*_WORKER_ENABLED` controlam apenas os timers internos do App Service
via `start*Worker()`. As Functions chamam `tick()` diretamente e nao dependem dessas
flags para executar.
