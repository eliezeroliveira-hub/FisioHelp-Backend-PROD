# FisioHelp Workers Functions

Pacote de Azure Functions para executar os workers do backend fora do App Service HTTP.

Este pacote e separado do Function App de SQL jobs em `azure-functions/`.

## Fluxos

- `processarFilaNotificacoes`: chama `workers/notificacoesWorker.tick()`.
- `processarFilaReembolsosGateway`: chama `workers/reembolsosGatewayWorker.tick()`.
- `processarFilaRepassesGateway`: chama `workers/repassesGatewayWorker.tick()`.
- `enfileirarAvaliacoesPendentes`: chama `workers/avaliacoesPendentesWorker.tick()`.
- `enfileirarLembretesConsulta`: chama `workers/consultasLembretesWorker.tick()`.
- `enfileirarLembretePerfilFisioterapeuta`: chama `workers/perfilFisioterapeutaLembreteWorker.tick()` a cada 15 minutos.

## Deploy

O pacote de deploy precisa conter estes diretorios do backend:

- `workers`
- `services`
- `providers`
- `config`
- `utils`
- `templates`

Execute:

```bash
npm run prepare:package
```

O diretorio `dist/` resultante e a raiz a ser publicada no Function App de workers.

## App Settings

Este pacote usa o caminho de configuracao dos workers do backend, portanto usa `DB_*`
em vez de `SQL_*`.

As variaveis `*_WORKER_ENABLED` dos fluxos legados controlam apenas os timers internos do App Service
via `start*Worker()`. As Functions legadas chamam `tick()` diretamente e nao dependem dessas
flags para executar.

O fluxo `enfileirarLembretePerfilFisioterapeuta` valida `PERFIL_LEMBRETE_WORKER_ENABLED`
dentro do proprio `tick()` e permanece inativo por padrao. Configuracoes:

- `PERFIL_LEMBRETE_WORKER_ENABLED=false`
- `PERFIL_LEMBRETE_DELAY_HOURS=48`
- `PERFIL_LEMBRETE_RECURRENCE_MONTHS=3`
- `PERFIL_LEMBRETE_BATCH_SIZE=20`
