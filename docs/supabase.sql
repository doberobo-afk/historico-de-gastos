-- ===========================================================================
-- Supabase — esquema do Controle Financeiro (SaaS)
-- Rode este script no SQL Editor do Supabase (uma vez por projeto).
-- ===========================================================================

-- Documento único por usuário: { controle_financeiro, controle_dividas,
-- cadastros, resumo_meta }
create table if not exists public.hg_dados (
  usuario       text        primary key,
  dados         jsonb       not null default '{}'::jsonb,
  atualizado_em timestamptz not null default now()
);

-- Log das execuções do cron (/api/cron)
create table if not exists public.hg_cron_log (
  id                   bigserial   primary key,
  executado_em         timestamptz not null default now(),
  usuarios_verificados integer     not null default 0,
  usuarios_atualizados integer     not null default 0,
  erros                integer     not null default 0,
  detalhes             jsonb       not null default '{}'::jsonb
);

create index if not exists hg_cron_log_executado_em_idx
  on public.hg_cron_log (executado_em desc);

-- ---------------------------------------------------------------------------
-- Segurança: RLS habilitado e SEM políticas públicas.
-- Somente a service_role (usada pelas Vercel Functions) acessa as tabelas —
-- a chave anon do front-end não consegue ler nem escrever nada diretamente.
-- ---------------------------------------------------------------------------
alter table public.hg_dados     enable row level security;
alter table public.hg_cron_log  enable row level security;

-- ---------------------------------------------------------------------------
-- Exemplo de uso com a API (cabeçalho X-Usuario define o documento):
--   GET    /api/sync
--   POST   /api/sync   {"dados": {"controle_financeiro": [], ...}}
--   DELETE /api/sync
-- ---------------------------------------------------------------------------
