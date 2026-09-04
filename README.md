# pharma-agent

Mastra agents for the MedMost cabinet: company onboarding and product intake by
conversation instead of a form.

**Date:** 2 September 2026.
Product context lives in [`pharma_cert/portal/view`](https://github.com/SinopticsAI/pharma_cert);
the cabinet system of record is [`pharma-edge`](https://github.com/SinopticsAI/pharma-edge);
document OCR is [`pharma-plane`](https://github.com/SinopticsAI/pharma-plane).

## What this service is allowed to do

It prepares drafts. That is the whole mandate, and it is a product rule rather
than a limitation to be engineered around:

- it **never files** anything with a government body;
- it **never signs** a contract;
- it **never spends** the client's money without a confirmation;
- every action it takes is written to the audit with the model and prompt
  version behind it.

Regulatory choices go through people twice: a specialist confirms the
classification first, the client second, and only then does a case get a
roadmap.

## Where it runs

A Yandex Serverless Container behind the `pharma-edge` API gateway. The browser
never talks to this service directly — it calls `POST /chat/{agentId}` on the
cabinet origin and the gateway forwards it.

One platform property shapes the design: **a serverless container cannot
stream**. It has to finish the turn before returning, and the whole response,
headers included, must fit in 3.5 MB. So:

- the cabinet shows an explicit "reading the document" state instead of a
  typing effect;
- tool payloads stay small, and anything bulky is passed as a reference into
  Edge rather than inlined.

Streaming would require the WebSocket extension of the gateway and a custom
runtime adapter. That is a separate wave, not this one.

## Identity

The gateway runs a JWT authorizer against realm `pharma` on
`auth.sinoptics.ru`, so by the time a request reaches this container the
signature, issuer and audience are already checked. The container reads
`requestContext.authorizer.jwt` and does not verify anything itself.

The account is **not** in the token. Keycloak owns the identity, the product
owns tenancy: Edge resolves `sub` through `account_users`. Roles come from the
realm — `client`, `specialist`, `operator`, `admin`.

## Storage

Threads, working memory and workflow snapshots go to database `pharma_agent` in
the managed cluster, over the pooler on port **6432**.

Business data is not here. The agent reaches companies, products, documents and
cases **only through Edge tools**, even though the cluster is shared with
`pharma_cabinet`. A shared cluster must not become shared access, or the
invariants that live in the Edge functions stop being enforced.

The journal of a dialog is written to `chat_messages` in `pharma_cabinet`
through `append-chat-message`: that is the record the client receives with the
case, separate from the agent's working memory.

## Layout

```
src/mastra/
  index.ts            Mastra instance, chatRoute, identity middleware
  model.ts            Yandex AI Studio through the OpenAI-compatible endpoint
  agents/company.ts   companyIntake  -> POST /chat/companyIntake
  agents/product.ts   productIntake  -> POST /chat/productIntake
  tools/edge.ts       the only path to business data
  tools/cards.ts      what the cabinet renders: draft, options, upload, map
  auth/claims.ts      reading the identity the gateway already verified
docker/agent/         Node image, includes the Yandex root certificate
scripts/              deploy a container revision
```

## Local development

Needs Node 22.13 or newer (`@mastra/*` engines).

```bash
cp .env.example .env      # fill PG_PASSWORD, EDGE_API_KEY, AI_STUDIO_API_KEY
npm install
npm run dev               # mastra dev on :4111
```

The managed cluster has no public host, so local runs need a tunnel from a VM
inside the network. Set `AGENT_DEV_ACCOUNT_ID` to stand in for the gateway
identity; in the cloud those variables are ignored because a request without a
token never reaches the container.

## Deploy

Push and CI/CD are **operator-owned**. The coding agent must not `git push`,
trigger GitHub Actions, push images, or run the deploy script. Use the VS Code
task **Git: auto add+commit+push** (or your own git) when you want a change on
`main`. Actions always typechecks. On `main`, after typecheck CI publishes the
image and then deploys a container revision (same tag). Manual
**deploy-containers** is still there to roll a specific tag.
Image publish runs only when `YC_SA_JSON` and `REGISTRY_ID` are set in the
repo secrets; until then those steps are skipped so an empty `docker login`
does not fail the run.

1. `scripts/deploy_containers.sh` builds nothing — CI already pushed the image.
2. First time only: take `CONTAINER_AGENT_ID` from the deploy summary into
   `pharma-edge/infra/account.env`.
3. Re-render and apply the gateway spec so `/chat/{agentId}` points at the
   container. Later revisions keep the same id; the gateway stays as is.

The container is not public. Only the gateway service account may invoke it.
