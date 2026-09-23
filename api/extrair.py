"""Vercel Function (Python) - /api/extrair

Extrai os lançamentos de uma fatura de cartão (PDF ou CSV) e devolve JSON.
Substitui o script local `extrair_fatura_pdf.py` em produção.

Formatos aceitos:
  POST /api/extrair   multipart/form-data  campo "arquivo" (.pdf ou .csv) + "ano"/"mes" opcionais
  POST /api/extrair   application/json     {"arquivoBase64": "...", "filename": "fatura.pdf", "ano": 2026, "mes": 8}
  POST /api/extrair   application/json     {"pdf_base64": "...", "ano_fatura": 2026, "mes_fechamento": 8}  (legado)
  POST /api/extrair?ano=2026&mes=8   application/pdf (corpo = PDF bruto, legado)
  GET  /api/extrair   health check

Resposta: {"ok": true, "tipo": "pdf"|"csv", "total": 12, "soma": 1234.56, "lancamentos": [...]}

Todo o processamento acontece em memória — nenhum arquivo é salvo em disco.

Variáveis de ambiente opcionais:
  EXTRAIR_TOKEN  -> se definida, exige o header "x-token" igual ao valor
"""
from __future__ import annotations

import base64
import binascii
import csv
import io
import json
import os
import re
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

# O núcleo de extração fica na raiz do projeto (ver functions.includeFiles no vercel.json)
RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if RAIZ not in sys.path:
    sys.path.insert(0, RAIZ)

from extrator_fatura import extrair_fatura_de_bytes, soma_valores  # noqa: E402

TAMANHO_MAX = 6 * 1024 * 1024  # 6 MB (faturas reais ficam bem abaixo disso)


def _responder(handler: BaseHTTPRequestHandler, codigo: int, corpo: dict) -> None:
    payload = json.dumps(corpo, ensure_ascii=False).encode("utf-8")
    handler.send_response(codigo)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Length", str(len(payload)))
    handler.send_header("Access-Control-Allow-Origin", "*")
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


def _parse_multipart(corpo: bytes, boundary: str) -> dict:
    """Parser mínimo de multipart/form-data (sem dependências externas).

    Devolve {nome_do_campo: str} para campos texto e
    {nome_do_campo: {"filename": str, "content": bytes}} para arquivos.
    """
    marcador = ("--" + boundary).encode("utf-8")
    campos: dict = {}
    for parte in corpo.split(marcador):
        parte = parte.strip(b"\r\n")
        if not parte or parte in (b"--", b""):
            continue
        if b"\r\n\r\n" not in parte:
            continue
        cabecalhos_raw, conteudo = parte.split(b"\r\n\r\n", 1)
        conteudo = conteudo.rstrip(b"\r\n")
        cabecalhos_texto = cabecalhos_raw.decode("utf-8", errors="ignore")
        m_nome = re.search(r'name="([^"]+)"', cabecalhos_texto)
        if not m_nome:
            continue
        nome = m_nome.group(1)
        m_arquivo = re.search(r'filename="([^"]*)"', cabecalhos_texto)
        if m_arquivo and m_arquivo.group(1):
            campos[nome] = {"filename": m_arquivo.group(1), "content": conteudo}
        else:
            campos[nome] = conteudo.decode("utf-8", errors="ignore")
    return campos


def _eh_pdf(nome_arquivo: str, conteudo: bytes) -> bool:
    if nome_arquivo.lower().endswith(".pdf"):
        return True
    if nome_arquivo.lower().endswith(".csv"):
        return False
    return conteudo[:5] == b"%PDF-"


def _extrair_csv(conteudo: bytes) -> list[dict]:
    for codificacao in ("utf-8-sig", "utf-8", "latin-1"):
        try:
            texto = conteudo.decode(codificacao)
            break
        except UnicodeDecodeError:
            continue
    else:
        texto = conteudo.decode("utf-8", errors="ignore")
    leitor = csv.DictReader(io.StringIO(texto))
    return [dict(linha) for linha in leitor]


class handler(BaseHTTPRequestHandler):
    """Entrypoint exigido pelo runtime Python da Vercel."""

    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # silencia o log padrão (a Vercel coleta stdout)
        return

    def do_OPTIONS(self):  # noqa: N802 (CORS preflight)
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, x-token")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):  # noqa: N802 (nome exigido pela stdlib)
        _responder(
            self,
            200,
            {
                "ok": True,
                "servico": "extrair-fatura",
                "uso": "POST multipart/form-data campo 'arquivo' (.pdf ou .csv) + ano/mes",
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
        tipo_conteudo = (self.headers.get("content-type") or "").lower()
        agora = datetime.now(timezone.utc)

        nome_arquivo = ""
        conteudo_arquivo = b""
        ano_fatura = None
        mes_fechamento = None

        try:
            if "multipart/form-data" in tipo_conteudo:
                m_boundary = re.search(r"boundary=(?:\"([^\"]+)\"|([^;]+))", tipo_conteudo)
                boundary = (m_boundary.group(1) or m_boundary.group(2)).strip() if m_boundary else ""
                if not boundary:
                    _responder(self, 400, {"ok": False, "erro": "boundary do multipart não encontrado"})
                    return
                campos = _parse_multipart(corpo, boundary)
                arquivo = campos.get("arquivo")
                if not isinstance(arquivo, dict):
                    _responder(self, 400, {"ok": False, "erro": "campo 'arquivo' não enviado"})
                    return
                nome_arquivo = arquivo.get("filename") or ""
                conteudo_arquivo = arquivo.get("content") or b""
                ano_fatura = campos.get("ano")
                mes_fechamento = campos.get("mes")
            elif "application/pdf" in tipo_conteudo:
                conteudo_arquivo = corpo
                nome_arquivo = "fatura.pdf"
                ano_fatura = parametros.get("ano", [None])[0]
                mes_fechamento = parametros.get("mes", [None])[0]
            else:
                dados = json.loads(corpo.decode("utf-8") or "{}")
                arquivo_base64 = str(dados.get("arquivoBase64") or dados.get("pdf_base64") or "")
                if "," in arquivo_base64[:60] and "base64" in arquivo_base64[:60]:
                    arquivo_base64 = arquivo_base64.split(",", 1)[1]  # aceita data URI
                conteudo_arquivo = base64.b64decode(arquivo_base64, validate=False)
                nome_arquivo = str(dados.get("filename") or "fatura.pdf")
                ano_fatura = dados.get("ano") or dados.get("ano_fatura")
                mes_fechamento = dados.get("mes") or dados.get("mes_fechamento")
        except (json.JSONDecodeError, UnicodeDecodeError):
            _responder(self, 400, {"ok": False, "erro": "JSON inválido"})
            return
        except (binascii.Error, ValueError):
            _responder(self, 400, {"ok": False, "erro": "base64 inválido"})
            return

        if not conteudo_arquivo:
            _responder(self, 400, {"ok": False, "erro": "arquivo não enviado"})
            return

        ano = _inteiro(ano_fatura, agora.year, 2000, 2100)
        mes = _inteiro(mes_fechamento, agora.month, 1, 12)
        vencimento_detectado = None

        if _eh_pdf(nome_arquivo, conteudo_arquivo):
            try:
                resultado_pdf = extrair_fatura_de_bytes(conteudo_arquivo, ano, mes)
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
            lancamentos = resultado_pdf["transacoes"]
            vencimento_detectado = resultado_pdf["vencimento"]
            ano = resultado_pdf["ano_fatura"]
            mes = resultado_pdf["mes_fechamento"]
            tipo_resultado = "pdf"
        else:
            try:
                lancamentos = _extrair_csv(conteudo_arquivo)
            except Exception as erro:  # pragma: no cover - CSV malformado
                _responder(
                    self,
                    422,
                    {
                        "ok": False,
                        "erro": "não foi possível ler o CSV",
                        "detalhe": str(erro)[:300],
                    },
                )
                return
            tipo_resultado = "csv"

        if not lancamentos:
            _responder(
                self,
                422,
                {
                    "ok": False,
                    "erro": "nenhum lançamento encontrado (verifique o layout do arquivo)",
                },
            )
            return

        _responder(
            self,
            200,
            {
                "ok": True,
                "tipo": tipo_resultado,
                "total": len(lancamentos),
                "soma": soma_valores(lancamentos) if tipo_resultado == "pdf" else None,
                "ano_fatura": ano,
                "mes_fechamento": mes,
                "vencimento_detectado": vencimento_detectado is not None,
                "vencimento": vencimento_detectado,
                "lancamentos": lancamentos,
            },
        )
