# Azure SQL timezone inventory

## Objetivo

Preparar a migracao do SQL Server local para Azure SQL Database sem deslocar regras de negocio em 3 horas.

Azure SQL Database usa UTC para `SYSDATETIME()`, `GETDATE()` e `CURRENT_TIMESTAMP`. O projeto local nasceu assumindo horario Brasil/Sao Paulo como horario implicito do SQL Server.

## Decisao

- Datas de regra de negocio continuam como `datetime`/`datetime2` naive em horario de Sao Paulo.
- Regras que comparam com "agora" devem receber `@AgoraBrasil` como parametro vindo do backend.
- O parametro deve ser produzido por `utils/appDateTime.js`, usando `Intl.DateTimeFormat` com `hourCycle: 'h23'` e `Date.UTC(...)`.
- Nao usar `new Date()` cru como parametro `DateTime2` para representar horario Brasil.

## Helper central

Arquivo: `utils/appDateTime.js`

Funcoes principais:

- `getAppTimeZone()`
- `getAppTimeZoneParts(date, timeZone)`
- `dateFromAppTimeZoneParts(parts)`
- `agoraAppDate(date, timeZone)`
- `agoraBrasilDate(date)`
- `formatAppDateTimeLocalIso(date, timeZone)`
- `formatBrasilDateTimeLocalIso(date)`

## Teste de fronteira JS -> SQL

Script:

```bash
node scripts/checkAgoraBrasilSql.js
```

Esperado no SQL local atual:

- `AgoraBrasilParam` aproximadamente igual a `AgoraSql`.
- `AgoraUtc` aproximadamente 3 horas a frente.

Esperado no Azure SQL Database:

- `AgoraBrasilParam` no horario de Brasilia/Sao Paulo.
- `AgoraSql` aproximadamente igual a `AgoraUtc`.
- `AgoraSql` e `AgoraUtc` aproximadamente 3 horas a frente de `AgoraBrasilParam`.

## Achados da Fase 1

### Confirmado

- Nao ha uso atual de `GETUTCDATE`, `SYSUTCDATETIME` ou `SYSDATETIMEOFFSET` no backend.
- `APP_TIME_ZONE = 'America/Sao_Paulo'` ja existe em `services/consultasService.js`, mas ainda nao e env var central.
- `services/consultasService.js` ja tem helpers locais para datetime naive (`extractSqlLocalDateTimeParts`, `localDateTimePartsToNaiveTimestamp`, `addMinutesToSqlLocalDateTime`, `getNowInAppTimeZoneParts`).
- `SP_VerificarConsultasExpiradas` nao foi encontrado no backend local. Se existir como SQL Agent job externo, precisa de plano proprio, pois Azure SQL Database nao suporta SQL Server Agent.

### P0 - regras de negocio sensiveis

Prioridade para substituicao de `SYSDATETIME()` / `GETDATE()` por `@AgoraBrasil`:

- `workers/consultasLembretesWorker.js`: janela de lembrete 24h.
- `workers/avaliacoesPendentesWorker.js`: lembrete apos `DataEncerramento`.
- `services/agendaService.js`: disponibilidade futura e consultas futuras.
- `services/consultasService.js`: cancelamento, arrependimento, check-in, token, no-show, encerramento.
- `services/repassesGatewayService.js`: elegibilidade por `DataPrevista`, processamento e reconciliacao de lotes.
- `services/recibosService.js`: janela de contestacao e geracao de recibos.
- `services/suporteService.js`: prazos/SLA, incluindo `PrazoLimiteResposta`.
- `services/pacotesService.js`: reflexao/cancelamento, pagamento e creditos.
- `services/pagamentosGatewayService.js`: cancelamento/reembolso e reconciliacao com consultas futuras.


### Stored procedures pendentes de auditoria

As chamadas abaixo aparecem no backend, mas as definicoes nao foram encontradas em `mvp-backend/sql/`. Antes do BACPAC/migracao para Azure SQL, extrair as definicoes do banco atual via SSMS/Azure Data Studio ou `sp_helptext` e revisar usos internos de `SYSDATETIME()`, `GETDATE()` e `CURRENT_TIMESTAMP`.

- `dbo.SP_Financeiro_RecalcularDecomposicaoGatewayAsaasV108`
- `dbo.SP_ConfirmarConsulta`
- `dbo.SP_ConfirmarConsultaAposPagamento`
- `dbo.SP_CriarTransacaoGatewayPendente`
- `dbo.SP_ConfirmarPagamentoGatewayAsaas`
- `dbo.SP_Pacote_GerarCreditos`
- `dbo.SP_Financeiro_RegistrarPacotePago`
- `dbo.SP_Financeiro_RegistrarDecomposicao`
- `dbo.SP_RegistrarClawbackSeRepassePago`

### P1 - filas, seguranca e retentativas

Ajustar depois dos P0, mantendo consistencia interna:

- `services/notificacoesService.js`: claim, reaper, backoff e timestamps da fila.
- `services/reembolsosGatewayFilaService.js`: claim, reaper, backoff e status.
- `services/verificacaoContatoService.js`: cooldown e expiracao de codigos.
- `services/redefinicaoSenhaService.js`: cooldown, expiracao e confirmacao de reset.
- `services/authService.js`: bloqueio de login, refresh tokens e blacklist.
- `services/emailSupressaoService.js`: timestamps de supressao.

### P2 - exibicao/frontend

Revisar parsing/exibicao sem mudar regra de negocio:

- `mvp-frontend/fisiohelp-mobile/src/services/backendDateTime.ts`
- `mvp-frontend/fisiohelp-mobile/src/utils/localDateTime.ts`
- `mvp-frontend/fisiohelp-admin/src/lib/format.ts`
- Paginas web/admin/mobile que usam `new Date(...)`, `toISOString()` ou `toLocaleString(...)` sem timezone explicito.

## Proxima fase

1. Rodar `node scripts/checkAgoraBrasilSql.js` no SQL local.
2. Rodar o mesmo script apontando `.env` para Azure SQL.
3. Ajustar P0 por arquivo, sempre passando `@AgoraBrasil` como parametro.
4. Validar P0 antes de iniciar P1.
