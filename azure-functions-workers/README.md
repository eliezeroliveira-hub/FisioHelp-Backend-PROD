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
- `enfileirarProgramaIndicacaoFisioterapeuta`: chama workers/programaIndicacaoFisioterapeutaWorker.tick() no primeiro dia de cada mês, às 12:00 UTC (09:00 em São Paulo).
- `enfileirarBeneficioBcmedFisioterapeuta`: chama `workers/beneficioBcmedFisioterapeutaWorker.tick()` diariamente, às 12:00 UTC (09:00 em São Paulo), sem execução no startup.

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

O fluxo `enfileirarOrientacaoCheckinFisio` é independente do lembrete de consulta de
24 horas. Ele valida `CHECKIN_ORIENTACAO_WORKER_ENABLED` dentro do próprio `tick()` e
enfileira uma única orientação por consulta/canal quando a consulta entra na janela de
60 minutos antes do atendimento. Configurações:

- `CHECKIN_ORIENTACAO_WORKER_ENABLED=false`
- `CHECKIN_ORIENTACAO_EMAIL_ENABLED=true`
- `CHECKIN_ORIENTACAO_WHATSAPP_ENABLED=true`
- `CHECKIN_ORIENTACAO_MINUTOS_ANTES=60`
- `CHECKIN_ORIENTACAO_MINIMO_MINUTOS_ANTES=50`
- `CHECKIN_ORIENTACAO_BATCH_SIZE=50`
- `CHECKIN_ORIENTACAO_CONSULTA_ID=` (opcional; restringe o teste HML a uma consulta)

O lembrete existente `enfileirarLembretesConsulta` e o tipo
`consulta_lembrete_24h` não são alterados por esse fluxo.
O fluxo `enfileirarLembretePerfilFisioterapeuta` valida `PERFIL_LEMBRETE_WORKER_ENABLED`
dentro do proprio `tick()` e permanece inativo por padrao. Configuracoes:

- `PERFIL_LEMBRETE_WORKER_ENABLED=false`
- `PERFIL_LEMBRETE_DELAY_HOURS=48`
- `PERFIL_LEMBRETE_RECURRENCE_MONTHS=3`
- `PERFIL_LEMBRETE_BATCH_SIZE=20`
- `PERFIL_LEMBRETE_FISIOTERAPEUTA_ID=` (opcional; restringe o processamento a um fisioterapeuta)

Para um teste controlado em HML, defina `PERFIL_LEMBRETE_FISIOTERAPEUTA_ID` com o ID
do fisioterapeuta. Remova a configuracao ao voltar ao processamento geral.

O fluxo `enfileirarProgramaIndicacaoFisioterapeuta` valida a flag de ativação dentro do
próprio `tick()` e usa uma chave idempotente por fisioterapeuta, canal e competência
`AAAA-MM`. Configurações:

- `PROGRAMA_INDICACAO_WORKER_ENABLED=false`
- `PROGRAMA_INDICACAO_BATCH_SIZE=50`
- `PROGRAMA_INDICACAO_MAX_BATCHES=20`
- `PROGRAMA_INDICACAO_FISIOTERAPEUTA_ID=` (opcional; obrigatório no teste controlado de HML)
- `PROGRAMA_INDICACAO_LANCAMENTO_COMPETENCIA=` (opcional; permite somente o lançamento fora do primeiro dia)

A Function usa `runOnStartup`, mas o worker só executa no primeiro dia do mês ou quando
a competência de lançamento coincide com o mês atual. Remova a competência de lançamento
após confirmar o envio inaugural.

O fluxo `enfileirarBeneficioBcmedFisioterapeuta` valida todas as configurações dentro
do próprio `tick()`, confere os dois links antes de enfileirar e usa uma chave
idempotente por campanha, data inicial, fisioterapeuta, canal e ciclo. O dia previsto e
os três dias seguintes são válidos, sem ultrapassar a data final. Configurações:

- `BCMED_BENEFICIO_WORKER_ENABLED=false`
- `BCMED_BENEFICIO_EMAIL_ENABLED=true`
- `BCMED_BENEFICIO_PUSH_ENABLED=true`
- `BCMED_BENEFICIO_CAMPANHA_ID=`
- `BCMED_BENEFICIO_DATA_INICIAL=` e `BCMED_BENEFICIO_DATA_FINAL=` (YYYY-MM-DD)
- `BCMED_BENEFICIO_EMAIL_INTERVAL_DAYS=20`
- `BCMED_BENEFICIO_PUSH_INTERVAL_DAYS=10`
- `BCMED_BENEFICIO_TOLERANCIA_DIAS=3`
- `BCMED_BENEFICIO_BATCH_SIZE=50` e `BCMED_BENEFICIO_MAX_BATCHES=20`
- `BCMED_BENEFICIO_FISIOTERAPEUTA_ID=` (piloto controlado)
- `BCMED_BENEFICIO_FISIOTERAPEUTA_EMAIL=` (alternativa ao ID para piloto controlado)
- `BCMED_BENEFICIO_FISIOTERAPEUTA_IDS_EXCLUIDOS=[]`
- `BCMED_BENEFICIO_BCMED_URL=https://www.bcmed.com.br/fisioterapia`
- `BCMED_BENEFICIO_URL=https://seudia.de/FisioHelp`
- `BCMED_BENEFICIO_WHATSAPP_HOSTS=api.whatsapp.com,wa.me,web.whatsapp.com`
- `BCMED_BENEFICIO_WHATSAPP_PHONE_SHA256=` (obrigatório quando ativado)
- `BCMED_BENEFICIO_WHATSAPP_MESSAGE_TOKEN=FisioHelp`
- `BCMED_BENEFICIO_LINK_CHECK_TIMEOUT_MS=5000`

O push não carrega URL e só é criado depois que já existe um e-mail enviado na mesma
campanha. Somente o push do ciclo inicial é gravado na caixa interna de notificações.
Desabilitar o worker ou um canal impede que itens BCMED pendentes sejam reivindicados;
isso não afeta as demais notificações.

Para cancelar itens pendentes, primeiro desligue as flags, espere mais que o prazo de
recuperação de itens travados (10 minutos) e execute duas rodadas do script, sempre
começando por dry-run:

```bash
node scripts/notificacoes/cancelarBeneficioBcmedPendentes.mjs --campaign-id beneficio-bcmed-2026 --expected-database mvpdb-hml --dry-run
node scripts/notificacoes/cancelarBeneficioBcmedPendentes.mjs --campaign-id beneficio-bcmed-2026 --expected-database mvpdb-hml --execute --confirm-campaign-id beneficio-bcmed-2026
```

O empacotamento recusa uma árvore Git suja e grava `BUILD_INFO.json` com repositório
sanitizado, branch, upstream, commit e horário do build. A inicialização registra esse
marcador sem impedir o host caso o arquivo esteja indisponível.
