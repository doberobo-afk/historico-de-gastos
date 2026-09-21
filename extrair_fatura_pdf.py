"""CLI: extrai lançamentos de uma fatura de cartão BB/Ourocard em PDF e gera um
CSV compatível com automacaogastos.py (colunas: Data, Descrição, País, Valor,
Categoria).

A lógica de extração vive em `extrator_fatura.py`, o mesmo módulo usado pela
API serverless `api/extrair.py` (Vercel).

Uso:
    python extrair_fatura_pdf.py <arquivo.pdf> [ano_fatura] [mes_fechamento] [saida.csv]
"""
import csv
import os
import sys

from extrator_fatura import extrair_transacoes, soma_valores

COLUNAS = ["Data", "Descrição", "País", "Valor", "Categoria"]


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(
            "Uso: python extrair_fatura_pdf.py <arquivo.pdf> [ano_fatura] "
            "[mes_fechamento] [arquivo_saida.csv]"
        )
        sys.exit(1)

    caminho_pdf = sys.argv[1]
    ano_fatura = int(sys.argv[2]) if len(sys.argv) > 2 else 2026
    mes_fechamento = int(sys.argv[3]) if len(sys.argv) > 3 else 8
    saida = sys.argv[4] if len(sys.argv) > 4 else "fatura_extraida.csv"

    if not os.path.exists(caminho_pdf):
        print(f"[ERRO] Arquivo não encontrado: {caminho_pdf}")
        sys.exit(1)

    transacoes = extrair_transacoes(caminho_pdf, ano_fatura, mes_fechamento)

    if not transacoes:
        print("[ERRO] Nenhum lançamento foi extraído. Verifique o layout do PDF.")
        sys.exit(1)

    # utf-8-sig mantém a compatibilidade com o Excel (mesmo formato anterior)
    with open(saida, "w", newline="", encoding="utf-8-sig") as arquivo:
        escritor = csv.DictWriter(arquivo, fieldnames=COLUNAS, extrasaction="ignore")
        escritor.writeheader()
        escritor.writerows(transacoes)

    print(f"[OK] {len(transacoes)} lançamentos extraídos -> {saida}")
    print(
        "Soma total (deve bater com o 'Total' do PDF): "
        f"R$ {soma_valores(transacoes):.2f}"
    )
