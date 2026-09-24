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

-- Dono do registro (autenticação real via Supabase Auth) — usado pelas
-- políticas de RLS abaixo para isolar os dados de cada conta.
alter table public.hg_dados
  add column if not exists user_id uuid references auth.users (id) on delete cascade;

create index if not exists hg_dados_user_id_idx on public.hg_dados (user_id);

-- Necessário para o upsert do front-end (onConflict: "user_id") — sem essa
-- UNIQUE o Postgres rejeita o upsert com o erro 42P10. ADD CONSTRAINT não
-- aceita IF NOT EXISTS, por isso o DO block abaixo.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'hg_dados_user_id_unique'
  ) then
    alter table public.hg_dados
      add constraint hg_dados_user_id_unique unique (user_id);
  end if;
end $$;

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
-- Segurança: RLS habilitado. A API (/api/sync) usa a service_role, que
-- ignora RLS por padrão — as políticas abaixo protegem qualquer acesso
-- direto que venha a usar a chave anon/autenticada do usuário (PostgREST).
-- ---------------------------------------------------------------------------
alter table public.hg_dados     enable row level security;
alter table public.hg_cron_log  enable row level security;

drop policy if exists hg_dados_select_own on public.hg_dados;
create policy hg_dados_select_own on public.hg_dados
  for select using (auth.uid() = user_id);

drop policy if exists hg_dados_insert_own on public.hg_dados;
create policy hg_dados_insert_own on public.hg_dados
  for insert with check (auth.uid() = user_id);

drop policy if exists hg_dados_update_own on public.hg_dados;
create policy hg_dados_update_own on public.hg_dados
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists hg_dados_delete_own on public.hg_dados;
create policy hg_dados_delete_own on public.hg_dados
  for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Migração: registros antigos (criados antes do login por e-mail/senha)
-- não tinham user_id. Troque '<uuid-do-admin>' pelo id (auth.users.id) da
-- conta que deve herdar esses dados, ou rode o DELETE para descartá-los.
-- ---------------------------------------------------------------------------
-- update public.hg_dados
--    set user_id = '<uuid-do-admin>'
--  where user_id is null;
--
-- delete from public.hg_dados where user_id is null;

-- ---------------------------------------------------------------------------
-- Exemplo de uso com a API (o usuário é identificado pelo token da sessão):
--   GET    /api/sync   Authorization: Bearer <access_token>
--   POST   /api/sync   {"dados": {"controle_financeiro": [], ...}}
--   DELETE /api/sync
-- ---------------------------------------------------------------------------

