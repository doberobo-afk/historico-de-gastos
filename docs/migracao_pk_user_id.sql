-- ===========================================================================
-- MIGRAÇÃO RECOMENDADA: user_id como PRIMARY KEY
-- ---------------------------------------------------------------------------
-- Rode no SQL Editor do Supabase (uma vez) para deixar de usar o E-MAIL como
-- chave da tabela. O front-end não precisa de nenhuma alteração: o upsert já
-- usa onConflict: "user_id" (js/store.js).
--
-- Por que trocar:
--   • hoje `usuario` (e-mail) é a chave primária. Um usuário mal-intencionado
--     pode inserir uma linha com o e-mail de OUTRA pessoa (e o user_id dele);
--     quando a vítima tentar salvar, o upsert dela falha por violação de chave
--     (erro opaco, "não consigo salvar");
--   • ao mudar o e-mail de um cliente, a chave primária muda junto — o que
--     gera registros duplicados/erros em migrações de conta.
--
-- Passo 1 (obrigatório) — resolva as linhas antigas sem dono, senão o NOT NULL
-- do passo 2 vai falhar. Confira antes:
--   select usuario, user_id, atualizado_em from public.hg_dados where user_id is null;
-- e então, escolha UMA das opções:
--   -- (a) adotar as linhas legadas para uma conta sua:
--   update public.hg_dados set user_id = '<uuid-do-dono>' where user_id is null;
--   -- (b) ou descartar (elas não são acessíveis por ninguém via RLS):
--   -- delete from public.hg_dados where user_id is null;
--
-- Passo 2 — troca da chave:
-- ===========================================================================

alter table public.hg_dados alter column user_id set not null;

alter table public.hg_dados drop constraint if exists hg_dados_pkey;
alter table public.hg_dados add constraint hg_dados_pkey primary key (user_id);

-- O e-mail deixa de ser chave: vira apenas informativo (o app continua gravando)
alter table public.hg_dados alter column usuario drop not null;

-- A UNIQUE(user_id) fica redundante quando user_id é a própria PK
alter table public.hg_dados drop constraint if exists hg_dados_user_id_unique;

-- Conferência final (deve listar 1 linha por usuário e nenhum user_id nulo):
--   select usuario, user_id, jsonb_array_length(coalesce(dados->'controle_financeiro','[]'::jsonb)) as lancamentos,
--          atualizado_em
--     from public.hg_dados order by atualizado_em desc;
--   select count(*) as sem_dono from public.hg_dados where user_id is null;
