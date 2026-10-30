# Runbook técnico — encerramento da operação

Data de encerramento: **30/11/2026**  
Suporte: **até 30/12/2026**

## Estado seguro antes da ativação

As três flags são lidas a cada requisição e mantêm o comportamento atual quando ausentes ou `true`:

- `NOVOS_CADASTROS_ENABLED`
- `NOVOS_AGENDAMENTOS_ENABLED`
- `NOVAS_CONTRATACOES_ENABLED`

Datas públicas:

- `PLATFORM_CLOSING_DATE=2026-11-30`
- `PLATFORM_SUPPORT_END_DATE=2026-12-30`

Não usar `WEB_BOOKING_ENABLED` como chave de encerramento: ela também desligaria o BFF e impediria login/área do paciente.

## Ordem de implantação

1. Confirmar que o SHA implantado da API contém os commits da campanha de ativação que estavam à frente de `prod/main` (`a858441` e `b7a13d8`).
2. Publicar o backend com as três flags ausentes ou `true`.
3. Publicar o site e validar o estado aberto.
4. Rodar `npm run encerramento:pendencias -- --expected-database <banco> --require-zero-checkouts`.
5. Desligar os workers incompatíveis e manter BCMED/Jalecos:
   - `PACIENTE_ATIVACAO_WORKER_ENABLED=false`
   - `PROGRAMA_INDICACAO_WORKER_ENABLED=false`
   - `PERFIL_LEMBRETE_WORKER_ENABLED=false`
   - `BCMED_BENEFICIO_WORKER_ENABLED=true`
   - `JALECOS_CONFORTO_WORKER_ENABLED=true`
6. Fazer o dry-run das filas e, após conferir, executar a limpeza:
   - `npm run encerramento:filas -- --expected-database <banco>`
   - `npm run encerramento:filas -- --expected-database <banco> --execute --confirm=ENCERRAMENTO-2026-11-30`
7. Alterar as três flags para `false` e as duas datas **na mesma atualização de App Settings**. Essa operação reinicia a API uma vez.
8. Só enviar o comunicado depois do smoke test.

O convite de pré-cadastro feito por um fisioterapeuta é enviado diretamente pelo provider; não há uma fila persistida nesse fluxo atual. O script ainda procura defensivamente itens de pré-cadastro em `FilaContatoTransacional`, sem tocar OTP, redefinição de senha ou verificação de contato.

## Matriz mínima do smoke test

Deve retornar `403` com código estável:

- criação de paciente e fisioterapeuta;
- OAuth de identidade que ainda não possui conta;
- sessões/códigos em `/api/cadastro/*`;
- ativação de pré-cadastro e fisioterapeuta cadastrando paciente;
- nova consulta, reagendamento e decisão de no-show `Reagendar`;
- opções de pagamento, pagamentos por crédito/pacote/fora da plataforma;
- checkout de consulta/pacote, pré-compra, compra e confirmação manual.

Deve continuar funcionando:

- login por senha e social de conta existente, refresh e logout;
- recuperação de senha;
- verificação de e-mail/telefone em `/pacientes/:id/contato/*` e `/fisioterapeutas/:id/contato/*`;
- leitura de perfil, consultas, recibos e prontuários;
- cancelamento, crédito e reembolso de contratação existente;
- webhooks Asaas, abandono/expiração de checkout e workers de reembolso/repasse;
- BCMED e Jalecos Conforto.

O app não precisa de nova versão: as rotas antigas recebem o mesmo `403` controlado da API.

## Prontuários

1. Gerar o inventário local (nenhum e-mail é enviado):
   - `npm run encerramento:prontuarios:inventario -- --expected-database <banco> --output-dir <pasta-local>`
   - IDs de testes conhecidos podem ser informados por `--test-fisio-ids=...` e `--test-paciente-ids=...`.
2. Revisar cada item. Marcadores de nome/e-mail viram `RevisaoManual`, nunca exclusão automática. Somente itens reais devem ficar com `classificacao: "Real"` e `aprovadoParaExportacao: true`.
3. Gerar os PDFs:
   - `npm run encerramento:prontuarios:exportar -- --expected-database <banco> --selection <inventario.json> --output-dir <nova-pasta-local>`
4. Conferir o SHA-256, abrir amostras em Adobe Reader, navegador e leitor móvel, e confirmar que senha incorreta falha.
5. A senha é o CPF ou CNPJ do fisioterapeuta, somente números. A senha completa não é gravada no manifesto.
6. O manifesto separa lotes com até 6,5 MB de PDFs por mensagem, abaixo do limite total do ACS. Um PDF individual acima desse teto exige canal protegido alternativo.

Os arquivos são gerados somente na máquina do operador. Não há cópia automática para qualquer endereço e nenhum script deste pacote envia e-mail.
