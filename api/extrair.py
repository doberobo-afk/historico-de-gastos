"""Vercel Function (Python) - /api/extrair

Extrai os lançamentos de uma fatura de cartão (PDF) e devolve JSON.
Substitui o script local `extrair_fatura_pdf.py` em produção.

Formatos aceitos:
  POST /api/extrair            application/json  {"pdf_base64": "...", "ano_fatura": 2026, "mes_fechamento": 8}
  POST /api/extrair?ano=2026&mes=8   application/pdf (corpo = PDF bruto)
  GET  /api/extrair            health check

Resposta: {"ok": true, "total": 12, "soma": 1234.56, "lancamentos": [...]}

Variáveis de ambiente opcionais:
  EXTRAIR_TOKEN  -> se definida, exige o header "x-token" igual ao valor
"""
from __future__ import annotations

import base64
import binascii
import json
import os
import sys
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

# O núcleo de extração fica na raiz do projeto (ver functions.includeFiles no vercel.json)
RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if RAIZ not in sys.path:
    sys.path.insert(0, RAIZ)

from extrator_fatura import extrair_transacoes_de_bytes, soma_valores  # noqa: E402

TAMANHO_MAX = 6 * 1024 * 1024  # 6 MB (faturas reais ficam bem abaixo disso)


def _responder(handler: BaseHTTPRequestHandler, codigo: int, corpo: dict) -> None:
    payload = json.dumps(corpo, ensure_ascii=False).encode("utf-8")
    handler.send_response(codigo)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Length", str(len(payload)))
    handler.end_headers()
    handler.wfile.write(payload)


def _inteiro(valor, padrao: int, minimo: int, maximo: int) -> int:
    try:
        numero = int(valor)
    except (TypeError, ValueError):
        return padrao
    return numero if minimo <= numero <= maximo else padrao


def _autorizado(handler: BaseHTTPRequestHandler) -> bool:
    esperado = (os.environ.get("EXTRAIR_TOKEN") or "").strip()
    if not esperado:
        return True
    return (handler.headers.get("x-token") or "").strip() == esperado


def _parametros(handler) -> dict:
    return parse_qs(urlparse(handler.path).query)


class handler(BaseHTTPRequestHandler):
    """Entrypoint exigido pelo runtime Python da Vercel."""

    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # silencia o log padrão (a Vercel coleta stdout)
        return

    def do_GET(self):  # noqa: N802 (nome exigido pela stdlib)
        _responder(
            self,
            200,
            {
                "ok": True,
                "servico": "extrair-fatura",
                "uso": "POST application/json {pdf_base64, ano_fatura, mes_fechamento} "
                "ou POST application/pdf?ano=2026&mes=8",
            },
        )

    def do_POST(self):  # noqa: N802
        if not _autorizado(self):
            _responder(self, 401, {"ok": False, "erro": "token inválido"})
            return

        try:
            tamanho = int(self.headers.get("content-length") or 0)
        except ValueError:
            tamanho = 0
        if tamanho <= 0:
            _responder(self, 400, {"ok": False, "erro": "corpo da requisição vazio"})
            return
        if tamanho > TAMANHO_MAX:
            _responder(
                self,
                413,
                {
                    "ok": False,
                    "erro": f"arquivo maior que o limite de {TAMANHO_MAX // (1024 * 1024)} MB",
                },
            )
            return

        corpo = self.rfile.read(tamanho)
        parametros = _parametros(self)
        tipo = (self.headers.get("content-type") or "").lower()

        try:
            if "application/pdf" in tipo:
                conteudo_pdf = corpo
                ano_fatura = parametros.get("ano", [None])[0]
                mes_fechamento = parametros.get("mes", [None])[0]
            else:
                dados = json.loads(corpo.decode("utf-8") or "{}")
                pdf_base64 = str(dados.get("pdf_base64") or "")
                if "," in pdf_base64[:60] and "base64" in pdf_base64[:60]:
                    pdf_base64 = pdf_base64.split(",", 1)[1]  # aceita data URI
                conteudo_pdf = base64.b64decode(pdf_base64, validate=False)
                ano_fatura = dados.get("ano_fatura")
                mes_fechamento = dados.get("mes_fechamento")
        except (json.JSONDecodeError, UnicodeDecodeError):
            _responder(self, 400, {"ok": False, "erro": "JSON inválido"})
            return
        except (binascii.Error, ValueError):
            _responder(self, 400, {"ok": False, "erro": "base64 inválido"})
            return

        if not conteudo_pdf:
            _responder(self, 400, {"ok": False, "erro": "PDF não enviado"})
            return

        ano = _inteiro(ano_fatura, 2026, 2000, 2100)
        mes = _inteiro(mes_fechamento, 8, 1, 12)

        try:
            lancamentos = extrair_transacoes_de_bytes(conteudo_pdf, ano, mes)
        except Exception as erro:  # pragma: no cover - PDF corrompido/layout novo
            _responder(
                self,
                422,
                {
                    "ok": False,
                    "erro": "não foi possível ler o PDF",
                    "detalhe": str(erro)[:300],
                },
            )
            return

        if not lancamentos:
            _responder(
                self,
                422,
                {
                    "ok": False,
                    "erro": "nenhum lançamento encontrado (verifique o layout do PDF)",
                },
            )
            return

        _responder(
            self,
            200,
            {
                "ok": True,
                "total": len(lancamentos),
                "soma": soma_valores(lancamentos),
                "ano_fatura": ano,
                "mes_fechamento": mes,
                "lancamentos": lancamentos,
            },
        )
