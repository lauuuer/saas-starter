# SaaS Starter — Auth + Payments (Projeto 1)

Plataforma de assinaturas com **NextAuth (Auth.js v5)**, **Prisma**, **PostgreSQL (Supabase)** e **Stripe** (modo de teste).
Demonstra o fluxo completo de SaaS: login social, checkout de assinatura, webhooks idempotentes e dashboard com gating por plano.

## Stack

| Camada       | Ferramenta                          |
| ------------ | ----------------------------------- |
| Framework    | Next.js 15 (App Router) + TypeScript |
| Auth         | Auth.js v5 (NextAuth) — GitHub OAuth |
| ORM          | Prisma                              |
| DB           | Supabase (Postgres, free tier)      |
| Pagamentos   | Stripe (test mode)                  |
| UI           | Tailwind CSS                        |
| Deploy       | Vercel                              |

---

## Passo a passo

### 1. Pré-requisitos
- Node.js 18.18+ (recomendado 20+)
- Conta no GitHub, Supabase e Stripe (todas gratuitas)
- Stripe CLI instalada (para testar webhooks localmente)

### 2. Instalar dependências
```bash
npm install
```

### 3. Banco de dados (Supabase)
1. Crie um projeto em https://supabase.com
2. Em **Project Settings → Database → Connection string**, copie:
   - A **Connection pooling** string (porta 6543) → `DATABASE_URL` — **adicione** `?pgbouncer=true&connection_limit=1` ao final (essencial em serverless)
   - A **Direct connection** string (porta 5432) → `DIRECT_URL`
3. Cole no `.env` (veja `.env.example`)

### 4. Variáveis de ambiente
Copie `.env.example` para `.env` e preencha:
```bash
cp .env.example .env
```
Gere o `AUTH_SECRET`:
```bash
npx auth secret
```

### 5. GitHub OAuth (login)
1. https://github.com/settings/developers → **New OAuth App**
2. Homepage URL: `http://localhost:3000`
3. Callback URL: `http://localhost:3000/api/auth/callback/github`
4. Copie `Client ID` e `Client Secret` → `.env`

### 6. Stripe
1. https://dashboard.stripe.com (deixe em **Test mode**)
2. **Developers → API keys**: copie a Secret key → `STRIPE_SECRET_KEY`
3. Crie um produto com preço recorrente: **Product catalog → Add product**
   - Copie o `price_id` (começa com `price_`) → `STRIPE_PRICE_ID`

### 7. Migrar o banco
```bash
npx prisma migrate dev --name init_auth_billing_webhooks
npx prisma generate
```

### 8. Rodar localmente
```bash
npm run dev
```

### 9. Testar webhooks localmente
Em outro terminal:
```bash
stripe login
stripe listen --forward-to localhost:3000/api/stripe/webhook
```
A CLI imprime um `whsec_...` → cole em `STRIPE_WEBHOOK_SECRET` no `.env` e reinicie o dev server.

Para disparar um evento de teste:
```bash
stripe trigger checkout.session.completed
```

### 10. Fluxo de teste de pagamento
1. Faça login em `/login`
2. Vá em `/pricing` e assine
3. Use o cartão de teste: `4242 4242 4242 4242`, qualquer data futura, qualquer CVC
4. O webhook confirma a assinatura → o `/dashboard` libera o conteúdo premium

### 11. Testar o worker de reprocessamento localmente
Defina um `CRON_SECRET` no `.env` e chame a rota manualmente:
```bash
curl -H "Authorization: Bearer SEU_CRON_SECRET" \
  http://localhost:3000/api/cron/process-webhooks
```
Para simular o caminho de recuperação: force uma falha (ex.: derrube o banco momentaneamente durante um `stripe trigger`), confirme que o evento ficou em `failed` na tabela `WebhookEvent`, e rode o worker — ele deve reprocessar e marcar `processed`.

---

## Pontos que diferenciam este projeto (documente no README do seu portfólio)

### Webhook à prova de produção (`src/app/api/stripe/webhook/route.ts`)

Este é o coração do projeto e onde a maioria dos portfólios falha. Decisões:

1. **Verificação de assinatura com raw body.** O body é lido com `req.text()` **antes** de qualquer parse e validado com `stripe.webhooks.constructEvent`. Fazer `req.json()` antes quebra a verificação no App Router.

2. **Idempotência à prova de concorrência (claim-then-process).** Em vez de `findUnique` → processar → `create` (que tem uma janela de corrida entre o check e o act, furável por reentregas concorrentes do Stripe em ambiente serverless), o `event.id` é **inserido primeiro** numa tabela `WebhookEvent` com status `processing`. O `unique constraint` do banco **vira o lock**: se o insert falha com `P2002`, outra invocação já reivindicou o evento e esta retorna 2xx sem reprocessar. A barreira de concorrência é o banco, não uma checagem aplicacional tardia.

3. **Reprocessamento seguro de falhas.** Um evento que falhou fica com status `failed`. Quando o Stripe reentrega, o handler detecta o estado e faz *reclaim* via `updateMany` condicionado ao status (um compare-and-swap), evitando que dois retries concorrentes reprocessem ao mesmo tempo.

4. **Recuperação de eventos "presos".** Se uma invocação morre (cold-start kill, OOM) após reivindicar mas antes de finalizar, o evento ficaria eternamente em `processing`. Uma janela de *staleness* (`STALE_MS`) permite que um retry posterior recupere o evento.

5. **Timeout em toda chamada de rede.** Tanto `subscriptions.retrieve` quanto o processamento global têm timeout explícito (`withTimeout`). Sem isso, uma **lentidão** (não indisponibilidade) da API do Stripe seguraria o handler até estourar o tempo de resposta do webhook, gerando reentregas e uma *retry storm*. O timeout corta cedo e responde de forma previsível.

6. **Evita `retrieve` redundante.** Eventos `customer.subscription.*` já trazem o objeto `Subscription` no payload; o código usa `event.data.object` diretamente nesses casos, eliminando uma ida à rede desnecessária por evento.

7. **Resposta correta por tipo de falha.** Assinatura inválida → 400 (não reentregar; é lixo/ataque). Falha de banco ou de processamento → 500 (reentregar; é transitório). Evento não tratado → 2xx (registrado para auditoria, sem processar).

8. **Payload cru persistido.** A tabela `WebhookEvent` guarda o payload, deixando o sistema pronto para evoluir para **processamento 100% assíncrono** (worker/cron lendo eventos `failed`/`processing`) sem re-buscar no Stripe — o próximo passo natural de escala.

9. **Observabilidade.** Logs estruturados em JSON (`src/lib/logger.ts`) com `requestId` de correlação e serialização segura de erros (sem vazar PII/objetos gigantes), em vez de `console.error` solto.

### Decisão consciente sobre processamento assíncrono

O padrão de robustez máxima é responder 2xx imediatamente após persistir o evento e processar o efeito num worker/fila separada. Para manter o projeto **100% gratuito e sem infra extra**, optei pelo padrão intermediário: persistir o evento cru, processar inline **com timeout e claim atômico**, e deixar a tabela `WebhookEvent` pronta para um worker plugar depois. Trade-off documentado conscientemente — é exatamente o tipo de decisão que diferencia engenharia sênior de "fiz funcionar".

### Configuração de banco (crítico em serverless)

Em produção, a `DATABASE_URL` **deve** apontar para o pooler do Supabase em transaction mode com `?pgbouncer=true&connection_limit=1`. Cada invocação serverless é um processo efêmero; sem o pooler e um pool minúsculo por container, picos de concorrência (inclusive uma retry storm de webhook) esgotam o limite de conexões e derrubam **todas** as rotas que tocam o banco — não só o webhook. A `DIRECT_URL` (porta 5432) é usada apenas para migrations.

### Worker assíncrono de reprocessamento (`src/app/api/cron/process-webhooks/route.ts`)

Segunda linha de defesa para eventos que falharam. O Stripe reentrega eventos com erro por algumas horas, mas eventualmente desiste. Quando isso acontece, o estado de billing ficaria permanentemente dessincronizado. O worker resolve isso:

- **Acionamento:** Vercel Cron (gratuito), configurado em `vercel.json`.
- **Fonte de trabalho:** a tabela `WebhookEvent` já guarda o payload cru de cada evento. O worker varre eventos em `failed` (cujo `nextRetryAt` já passou) e `processing` presos (stale), sem precisar re-buscar nada no Stripe.
- **Claim atômico por evento:** cada evento é reivindicado via `updateMany` condicionado ao status observado (compare-and-swap), então duas execuções do cron — ou o cron concorrendo com o handler — nunca reprocessam o mesmo evento ao mesmo tempo.
- **Backoff exponencial com jitter** (`src/lib/retry-policy.ts`): falhas repetidas afastam progressivamente a próxima tentativa, e o jitter evita *thundering herd* quando muitos eventos falham juntos (ex.: Stripe fora do ar).
- **Dead-letter:** após `MAX_ATTEMPTS`, o evento vai para `dead_letter` em vez de tentar para sempre. Esse estado emite log de erro e deve disparar um alarme — significa que um usuário pode estar com billing dessincronizado e requer intervenção manual.
- **Guarda de tempo:** o loop respeita um deadline (`LOOP_DEADLINE_MS`) abaixo do `maxDuration` da função, para não ser morto no meio de um evento.
- **Lógica compartilhada:** handler e worker usam o mesmo `processEvent` (`src/lib/webhook-processor.ts`), garantindo comportamento idêntico nos dois caminhos.

> **Limite do plano grátis (documentado conscientemente):** o Vercel Cron no plano Hobby roda **no máximo 1x/dia** e **não faz retry** de invocações falhas. Por isso o worker usa um batch generoso (50) para drenar o backlog numa passada. Como o Stripe já cobre as primeiras horas de retry, um worker diário é suficiente como rede de segurança final. Em produção real (plano Pro), basta reduzir o batch e mudar o `schedule` em `vercel.json` para algo como `*/5 * * * *`.

### Observabilidade e alarmes (`src/app/api/health/webhooks/route.ts`)

Endpoint de health que expõe a saúde do pipeline de webhooks sem vazar PII — apenas contagens agregadas e timestamps. Projetado para ser consumido por um monitor HTTP externo gratuito (UptimeRobot, BetterStack, Pingdom):

- **`counts`**: quantidade de eventos por status (`processing`, `processed`, `failed`, `dead_letter`).
- **`oldestPendingAgeMs`**: idade do evento pendente mais antigo. Se cresce, é sinal de worker parado (cron não rodou).
- **`status`** derivado: `healthy` / `degraded` / `unhealthy`.
  - Qualquer `dead_letter` > 0 → **unhealthy** (billing dessincronizado para algum usuário; exige intervenção). Retorna **HTTP 503** para que monitores que só olham status code também alertem.
  - Backlog de `failed` acima do limiar, ou evento pendente muito antigo → **degraded**.

**Como configurar o alarme (grátis):** crie um monitor HTTP apontando para `https://SEU-DOMINIO/api/health/webhooks?token=<HEALTH_TOKEN>` e alerte quando o status code for 503 ou o corpo contiver `"unhealthy"`. O endpoint é protegido por `HEALTH_TOKEN`; o token é aceito via header `Authorization: Bearer` ou querystring `?token=` (para monitores que não permitem custom headers no free tier).

O worker e o handler também emitem o log estruturado `webhook.dead_letter` / `worker.dead_letter` (nível error) — se você usar um coletor de logs (Axiom, Datadog), pode alarmar diretamente nesse evento.

### Achados da 3ª revisão (correções de alto impacto)

1. **Teto de tentativas agora é respeitado nos DOIS caminhos.** Antes, só o worker aplicava `MAX_ATTEMPTS`; o handler do webhook reprocessava inline a cada reentrega do Stripe. Como o Stripe reentrega por até **3 dias** (confirmado na doc), um evento com falha determinística seria reprocessado dezenas de vezes — desperdiçando invocação, conexão de banco e uma chamada à API do Stripe a cada vez. Agora handler e worker compartilham `decideFailureOutcome` (`src/lib/retry-policy.ts`): ao exceder o teto, o evento vira `dead_letter` e o handler responde **200** (não 500), fazendo o Stripe parar de insistir num evento que já abandonamos para inspeção manual.

2. **Política de falha unificada (DRY + corretude).** A decisão "failed com backoff vs dead_letter" estava duplicada e com semântica divergente entre handler (`>=`) e worker (`>`). Centralizada numa única função, eliminando a divergência.

3. **Query a menos no hot path de erro.** O handler relia `attempts` do banco no catch (query extra). Agora o valor é carregado uma vez no claim/reclaim e reusado.

4. **Import órfão removido.** Um `import { Prisma }` não utilizado no worker quebraria o build do Next com lint estrito. Varredura de imports órfãos feita em todos os arquivos.

### Achados de robustez corrigidos (histórico de code review)

Documentado para mostrar o raciocínio de engenharia, não só o resultado:

1. **Idempotência à prova de concorrência (claim-then-process).** Substituiu o padrão check-then-act, que tinha janela de corrida furável por reentregas concorrentes do Stripe em serverless. O `unique constraint` virou o lock.

2. **Compatibilidade com a API Basil do Stripe.** A partir de 2025-03-31, o Stripe **removeu** `current_period_end` do nível da Subscription e moveu para os itens (`items.data[].current_period_end`). Código que lê o campo antigo recebe `undefined` silenciosamente — e em billing isso nega acesso a quem pagou. O `extractCurrentPeriodEnd` lê o item-level com fallback para o top-level, cobrindo Acacia e Basil.

3. **Race na criação do Stripe Customer.** Dois checkouts concorrentes podiam criar dois Customers (dual-write sem proteção), deixando um órfão. Resolvido com `idempotencyKey` derivada do `userId`: o Stripe retorna o mesmo Customer.

4. **Reconciliação resiliente no webhook.** O `syncSubscription` reconcilia primeiro pelo `stripeCustomerId`; se não achar (ex.: o vínculo no DB falhou ao gravar), cai para o `userId` propagado via `metadata` (gravado na checkout session **e** na própria subscription via `subscription_data.metadata`), e repara o vínculo (self-healing). Sem isso, uma subscription paga poderia ser silenciosamente ignorada.

5. **Status mapeado com falha explícita.** Status desconhecido do Stripe lança erro (e cai no fluxo de retry) em vez de virar dado inválido no banco via `as any`.

6. **Edge cases de data.** `current_period_end` ausente vira `null` tratado (sem `Invalid Date`); o `billing.ts` nega acesso conservadoramente quando a data é nula.

7. **Defesa de superfície.** Teto de tamanho de body (em bytes reais via `Buffer.byteLength`) no endpoint público; worker protegido por `CRON_SECRET`.

8. **Observabilidade.** Logs estruturados JSON com correlação por `requestId`/`eventId` e serialização de erro sem vazar PII.


## Deploy na Vercel
1. Push para o GitHub e importe na Vercel
2. Configure as mesmas env vars (use as keys de produção do Stripe quando for ao vivo)
3. No Stripe Dashboard, crie um endpoint de webhook apontando para `https://SEU-DOMINIO/api/stripe/webhook` e use o novo `whsec_` em produção
4. Atualize a callback URL do GitHub OAuth para o domínio de produção
