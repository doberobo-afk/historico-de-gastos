"""Núcleo de extração de lançamentos de faturas de cartão em PDF.

Módulo puro (sem pandas) compartilhado por:
  - extrair_fatura_pdf.py  -> CLI local, gera CSV compatível com automacaogastos.py
  - api/extrair.py         -> Vercel Function serverless, devolve JSON

Layout suportado: fatura BB/Ourocard com as seções
"Lançamentos nesta fatura" ... "Total da Fatura" e linhas no formato
"dd/mm DESCRICAO [BR|FR] R$ 1.234,56".

Detecção de vencimento também cobre os rótulos usados por BB e Caixa
("Vencimento", "Data de Vencimento", "Vencimento da Fatura", "Venc. Fatura"),
inclusive quando a data aparece na linha seguinte ao rótulo.
"""
from __future__ import annotations

import io
import re
from typing import Dict, Iterable, List, Optional

CATEGORIAS_CONHECIDAS = {
    "PAGAMENTOS/CRÉDITOS": "Pagamentos",
    "BANCOS": "Bancos",
    "LAZER": "Lazer",
    "RESTAURANTES": "Restaurantes",
    "SAÚDE": "Saúde",
    "SERVIÇOS": "Serviços",
    "SUPERMERCADOS": "Supermercados",
    "VESTUÁRIO": "Vestuário",
    "OUTROS LANÇAMENTOS": "Outros",
    "COMPRAS PARCELADAS": "Compras parceladas",
}

# dd/mm opcional + descrição + país opcional (BR/FR) + R$ valor
LINHA_TRANSACAO = re.compile(
    r"^(?:(\d{2}/\d{2})\s+)?(.+?)\s+(?:(BR|FR)\s+)?R\$\s*(-?[\d.]+,\d{2})\s*$"
)

# Rótulos usados pelos diferentes bancos para a data de vencimento da fatura.
# A data costuma vir logo depois, às vezes na linha seguinte (por isso DOTALL).
PADRAO_ROTULO_VENCIMENTO = re.compile(
    r"(?:Data de Vencimento|Vencimento da Fatura|Venc\.\s*Fatura|Vencimento)",
    re.IGNORECASE,
)

# "Vencimento ... 01/10/2026" -> mes=10, ano=2026 (mes/ano da fatura, nao da compra)
PADRAO_DATA_BARRA = re.compile(r"(\d{2})/(\d{2})/(\d{4})", re.DOTALL | re.MULTILINE)

# Formato usado pela Caixa: "01 OUT 2026"
MESES_ABREV = {
    "JAN": 1, "FEV": 2, "MAR": 3, "ABR": 4, "MAI": 5, "JUN": 6,
    "JUL": 7, "AGO": 8, "SET": 9, "OUT": 10, "NOV": 11, "DEZ": 12,
}
PADRAO_DATA_MES_ABREV = re.compile(
    r"(\d{1,2})\s+([A-Za-zÇÃÕçãõ]{3})\.?\s+(\d{4})", re.DOTALL | re.MULTILINE
)

# Quantos caracteres após o rótulo de vencimento procurar a data
_JANELA_VENCIMENTO = 80


def ano_da_transacao(mes: int, mes_fechamento: int, ano_fatura: int) -> int:
    """Compras parceladas antigas (mês maior que o de fechamento) são do ano anterior."""
    if mes > mes_fechamento:
        return ano_fatura - 1
    return ano_fatura


def extrair_transacoes_de_paginas(
    paginas: Iterable[str],
    ano_fatura: int = 2026,
    mes_fechamento: int = 8,
) -> List[Dict]:
    """Extrai os lançamentos a partir do texto já extraído de cada página."""
    transacoes: List[Dict] = []
    categoria_atual = "Outros"
    dentro_lancamentos = False

    for texto in paginas:
        for linha in (texto or "").split("\n"):
            linha = linha.strip()
            if not linha:
                continue

            if "Lançamentos nesta fatura" in linha:
                dentro_lancamentos = True
                continue
            if "Total da Fatura" in linha:
                dentro_lancamentos = False
                continue
            if not dentro_lancamentos:
                continue
            if linha.startswith("Data") and "Descrição" in linha:
                continue
            if "Cartão" in linha and "R$" not in linha:
                continue

            if "R$" not in linha:
                chave = linha.upper().strip()
                if chave in CATEGORIAS_CONHECIDAS:
                    categoria_atual = CATEGORIAS_CONHECIDAS[chave]
                continue

            m = LINHA_TRANSACAO.match(linha)
            if not m:
                continue

            data_str, descricao, pais, valor_str = m.groups()
            valor = float(valor_str.replace(".", "").replace(",", "."))

            if data_str:
                dia, mes = data_str.split("/")
                ano = ano_da_transacao(int(mes), mes_fechamento, ano_fatura)
                data_completa = f"{dia}/{mes}/{ano}"
            else:
                # Linhas sem data (ex.: SALDO FATURA ANTERIOR) usam a data de fechamento
                data_completa = f"01/{mes_fechamento:02d}/{ano_fatura}"

            transacoes.append(
                {
                    "Data": data_completa,
                    "Descrição": descricao.strip(),
                    "País": pais or "BR",
                    "Valor": valor,
                    "Categoria": categoria_atual,
                }
            )

    return transacoes


def extrair_transacoes_de_texto(
    texto: str, ano_fatura: int = 2026, mes_fechamento: int = 8
) -> List[Dict]:
    """Mesma extração, a partir de um único texto (usado em testes)."""
    return extrair_transacoes_de_paginas([texto], ano_fatura, mes_fechamento)


def detectar_vencimento(paginas: Iterable[str]) -> Optional[Dict[str, object]]:
    """Procura a data de vencimento impressa na fatura, aceitando os rótulos usados
    por BB e Caixa ("Vencimento", "Data de Vencimento", "Vencimento da Fatura",
    "Venc. Fatura") mesmo quando a data cai na linha seguinte ao rótulo.

    Tenta primeiro o formato DD/MM/AAAA e depois o formato "01 OUT 2026" (Caixa).
    Devolve {"data": "01/10/2026", "dia": 1, "mes": 10, "ano": 2026} ou None.
    """
    paginas = list(paginas)
    for texto in paginas:
        texto = texto or ""
        for m_rotulo in PADRAO_ROTULO_VENCIMENTO.finditer(texto):
            trecho = texto[m_rotulo.end(): m_rotulo.end() + _JANELA_VENCIMENTO]

            m_data = PADRAO_DATA_BARRA.search(trecho)
            if m_data:
                dia, mes, ano = (int(x) for x in m_data.groups())
                if 1 <= mes <= 12:
                    data_str = f"{dia:02d}/{mes:02d}/{ano}"
                    return {"data": data_str, "dia": dia, "mes": mes, "ano": ano}
                continue

            m_mes = PADRAO_DATA_MES_ABREV.search(trecho)
            if m_mes:
                dia_str, mes_abrev, ano_str = m_mes.groups()
                mes = MESES_ABREV.get(mes_abrev.upper())
                if mes:
                    dia = int(dia_str)
                    ano = int(ano_str)
                    data_str = f"{dia:02d}/{mes:02d}/{ano}"
                    return {"data": data_str, "dia": dia, "mes": mes, "ano": ano}

    # Debug: nenhum rótulo/data de vencimento reconhecido em nenhuma página
    print("DEBUG detectar_vencimento: vencimento não encontrado. Início do texto extraído:")
    print((paginas[0] if paginas else "")[:1000])
    return None


def _pdfplumber():  # pragma: no cover - import tardio evita dependência em testes
    import pdfplumber  # type: ignore

    return pdfplumber


def extrair_transacoes_de_bytes(
    dados: bytes, ano_fatura: int = 2026, mes_fechamento: int = 8
) -> List[Dict]:
    """Extrai lançamentos de um PDF em memória (usado pela API serverless)."""
    pdfplumber = _pdfplumber()
    with pdfplumber.open(io.BytesIO(dados)) as pdf:
        paginas = [page.extract_text() or "" for page in pdf.pages]
    return extrair_transacoes_de_paginas(paginas, ano_fatura, mes_fechamento)


def extrair_fatura_de_bytes(
    dados: bytes, ano_fatura: int = 2026, mes_fechamento: int = 8
) -> Dict:
    """Como `extrair_transacoes_de_bytes`, mas detecta o vencimento real impresso
    na fatura e usa o mês/ano dele (em vez do mês da compra) para classificar
    os lançamentos. Devolve {"transacoes", "vencimento", "ano_fatura", "mes_fechamento"}.
    """
    pdfplumber = _pdfplumber()
    with pdfplumber.open(io.BytesIO(dados)) as pdf:
        paginas = [page.extract_text() or "" for page in pdf.pages]
    vencimento = detectar_vencimento(paginas)
    if vencimento:
        ano_fatura = vencimento["ano"]
        mes_fechamento = vencimento["mes"]
    transacoes = extrair_transacoes_de_paginas(paginas, ano_fatura, mes_fechamento)
    return {
        "transacoes": transacoes,
        "vencimento": vencimento,
        "ano_fatura": ano_fatura,
        "mes_fechamento": mes_fechamento,
    }


def extrair_transacoes(
    caminho_pdf: str, ano_fatura: int = 2026, mes_fechamento: int = 8
) -> List[Dict]:
    """Extrai lançamentos de um PDF em disco (usado pela CLI)."""
    pdfplumber = _pdfplumber()
    with pdfplumber.open(caminho_pdf) as pdf:
        paginas = [page.extract_text() or "" for page in pdf.pages]
    return extrair_transacoes_de_paginas(paginas, ano_fatura, mes_fechamento)


def soma_valores(transacoes: Iterable[Dict]) -> float:
    """Soma segura dos valores extraídos (deve bater com o 'Total' do PDF)."""
    total: Optional[float] = 0.0
    for t in transacoes:
        try:
            total += float(t.get("Valor") or 0)
        except (TypeError, ValueError):
            continue
    return round(total or 0.0, 2)
