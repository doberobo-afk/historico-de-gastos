"""Vercel Cron (Python) - /api/cron

Executado pelo agendador da Vercel (ver a chave "crons" no vercel.json).
Manutenção periódica do SaaS, sem depender do Excel local:

1. valida o CRON_SECRET enviado automaticamente pela Vercel;
2. atualiza o mês/ano corrente de cada usuário (resumo_meta) no Supabase;
3. registra a execução na tabela hg_cron_log;
4. responde JSON com o resumo (usuários verificados/atualizados).

Variáveis de ambiente:
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY -> persistência (obrigatórias)
  CRON_SECRET                             -> proteção do endpoint (recomendada)

SQL das tabelas: ver docs/supabase.sql
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler

MESES = [
    "JANEIRO",
    "FEVEREIRO",
    "MARÇO",
    "ABRIL",
    "MAIO",
    "JUNHO",
    "JULHO",
    "AGOSTO",
    "SETEMBRO",
    "OUTUBRO",
    "NOVEMBRO",
    "DEZEMBRO",
]
TABELA_DADOS = "hg_dados"
TABELA_LOG = "hg_cron_log"


def _responder(handler: BaseHTTPRequestHandler, codigo: int, corpo: dict) -> None:
    payload = json.dumps(corpo, ensure_ascii=False).encode("utf-8")
    handler.send_response(codigo)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Length", str(len(payload)))
    handler.end_headers()
    handler.wfile.write(payload)


def _config_supabase() -> tuple[str, str]:
    url = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
    chave = (
        os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        or os.environ.get("SUPABASE_KEY")
        or ""
    )
    return url, chave


def _rest(url: str, chave: str, metodo: str, caminho: str, corpo=None, prefer: str = ""):
    """Chamada REST (PostgREST) usando apenas a stdlib."""
    requisicao = urllib.request.Request(
        f"{url}/rest/v1/{caminho}",
        method=metodo,
        data=json.dumps(corpo).encode("utf-8") if corpo is not None else None,
        headers={
            "apikey": chave,
            "Authorization": f"Bearer {chave}",
            "Content-Type": "application/json",
            "Prefer": prefer or "return=minimal",
        },
    )
    with urllib.request.urlopen(requisicao, timeout=15) as resposta:
        texto = resposta.read().decode("utf-8")
    return json.loads(texto) if texto.strip() else []


def _autorizado(handler: BaseHTTPRequestHandler) -> bool:
    """A Vercel envia 'Authorization: Bearer $CRON_SECRET' nas chamadas de cron."""
    esperado = (os.environ.get("CRON_SECRET") or "").strip()
    if not esperado:
        return True  # sem segredo configurado, o rollover é idempotente e seguro
    enviado = (handler.headers.get("authorization") or "").strip()
    if enviado.lower().startswith("bearer "):
        enviado = enviado[7:].strip()
    if enviado != esperado:
        consulta = urllib.parse.parse_qs(urllib.parse.urlparse(handler.path).query)
        enviado = (consulta.get("token") or [""])[0]
    return enviado == esperado


def executar_manutencao() -> dict:
    """Atualiza o mês corrente de cada usuário e registra a execução."""
    url, chave = _config_supabase()
    agora = datetime.now(timezone.utc)
    mes_atual = MESES[agora.month - 1]
    ano_atual = agora.year

    if not url or not chave:
        return {
            "ok": True,
            "modo": "local",
            "aviso": "SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY não configurados",
            "executado_em": agora.isoformat(),
        }

    linhas = _rest(url, chave, "GET", f"{TABELA_DADOS}?select=usuario,dados&limit=1000")

    verificados = 0
    atualizados = 0
    erros = 0

    for linha in linhas if isinstance(linhas, list) else []:
        usuario = linha.get("usuario")
        dados = linha.get("dados") or {}
        if not usuario or not isinstance(dados, dict):
            continue
        verificados += 1

        meta = dados.get("resumo_meta")
        if not isinstance(meta, dict):
            meta = {}
        if (
            str(meta.get("ano_atual")) == str(ano_atual)
            and str(meta.get("mes_atual")) == mes_atual
        ):
            continue  # já está no mês corrente

        meta["ano_atual"] = ano_atual
        meta["mes_atual"] = mes_atual
        dados["resumo_meta"] = meta

        try:
            _rest(
                url,
                chave,
                "PATCH",
                f"{TABELA_DADOS}?usuario=eq.{urllib.parse.quote(str(usuario), safe='')}",
                {"dados": dados, "atualizado_em": agora.isoformat()},
            )
            atualizados += 1
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError):
            erros += 1

    resultado = {
        "ok": erros == 0,
        "modo": "nuvem",
        "executado_em": agora.isoformat(),
        "mes_atual": mes_atual,
        "ano_atual": ano_atual,
        "usuarios_verificados": verificados,
        "usuarios_atualizados": atualizados,
        "erros": erros,
    }

    try:
        _rest(
            url,
            chave,
            "POST",
            TABELA_LOG,
            {
                "executado_em": agora.isoformat(),
                "usuarios_verificados": verificados,
                "usuarios_atualizados": atualizados,
                "erros": erros,
                "detalhes": resultado,
            },
        )
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError):
        resultado["aviso"] = "não foi possível gravar o log no Supabase"

    return resultado


class handler(BaseHTTPRequestHandler):
    """Entrypoint chamado pela Vercel (user-agent: vercel-cron/1.0)."""

    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # silencia o log padrão
        return

    def do_GET(self):  # noqa: N802
        if not _autorizado(self):
            _responder(self, 401, {"ok": False, "erro": "não autorizado"})
            return
        try:
            _responder(self, 200, executar_manutencao())
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as erro:
            _responder(
                self,
                502,
                {"ok": False, "erro": "falha ao falar com o Supabase: " + str(erro)[:300]},
            )
        except Exception as erro:  # pragma: no cover
            _responder(self, 500, {"ok": False, "erro": str(erro)[:300]})
