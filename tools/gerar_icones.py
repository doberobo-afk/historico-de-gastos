"""Gera os ícones do PWA (webapp/icons/*.png) — sem dependências além do Pillow.

Uso:
    python tools/gerar_icones.py
"""
from __future__ import annotations

import os

from PIL import Image, ImageDraw

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DESTINO = os.path.join(RAIZ, "webapp", "icons")

# Paleta do app (mesma do CSS: --db-accent-start / --db-accent-end / --db-bg-1)
LARANJA = (255, 107, 61)
ROSA = (255, 59, 107)
FUNDO = (11, 7, 16)
BRANCO = (255, 255, 255)


def gradiente(tamanho: int) -> Image.Image:
    """Fundo com gradiente diagonal laranja -> rosa."""
    base = Image.new("RGB", (tamanho, tamanho), FUNDO)
    pixels = base.load()
    for y in range(tamanho):
        for x in range(tamanho):
            t = (x + y) / (2 * (tamanho - 1))
            pixels[x, y] = (
                int(LARANJA[0] + (ROSA[0] - LARANJA[0]) * t),
                int(LARANJA[1] + (ROSA[1] - LARANJA[1]) * t),
                int(LARANJA[2] + (ROSA[2] - LARANJA[2]) * t),
            )
    return base


def desenhar_icone(tamanho: int, margem: float = 0.16, cantos: bool = True) -> Image.Image:
    """Ícone quadrado: fundo com gradiente + 3 barras e uma linha crescente."""
    imagem = gradiente(tamanho).convert("RGBA")

    if cantos:  # cantos arredondados (ícones "any")
        mascara = Image.new("L", (tamanho, tamanho), 0)
        ImageDraw.Draw(mascara).rounded_rectangle(
            [0, 0, tamanho - 1, tamanho - 1],
            radius=int(tamanho * 0.22),
            fill=255,
        )
        imagem.putalpha(mascara)

    desenho = ImageDraw.Draw(imagem)

    area = int(tamanho * (1 - 2 * margem))  # área útil do glifo
    base_y = int(tamanho * (1 - margem))
    largura_barra = int(area * 0.16)
    espaco = int(area * 0.10)
    iniciais = [
        int(area * 0.30),
        int(area * 0.50),
        int(area * 0.38),
    ]

    x = int(tamanho * margem)
    for altura in iniciais:
        desenho.rounded_rectangle(
            [x, base_y - altura, x + largura_barra, base_y],
            radius=max(2, largura_barra // 4),
            fill=BRANCO + (235,),
        )
        x += largura_barra + espaco

    # linha de tendência por cima das barras
    pontos = [
        (int(tamanho * margem + area * 0.08), int(base_y - area * 0.42)),
        (int(tamanho * margem + area * 0.48), int(base_y - area * 0.62)),
        (int(tamanho * margem + area * 0.92), int(base_y - area * 0.86)),
    ]
    desenho.line(pontos, fill=BRANCO, width=max(3, int(tamanho * 0.022)), joint="curve")
    raio = max(3, int(tamanho * 0.026))
    for px, py in pontos:
        desenho.ellipse([px - raio, py - raio, px + raio, py + raio], fill=BRANCO)

    return imagem


def salvar(imagem: Image.Image, nome: str) -> str:
    caminho = os.path.join(DESTINO, nome)
    imagem.save(caminho, format="PNG", optimize=True)
    return caminho


def main() -> None:
    os.makedirs(DESTINO, exist_ok=True)

    # Ícones "any" (cantos arredondados como no tema escuro do app)
    for tamanho in (192, 512):
        salvar(desenhar_icone(tamanho), f"icon-{tamanho}.png")

    # Maskable: sem cantos arredondados e com glifo centralizado na "safe zone"
    salvar(
        desenhar_icone(512, margem=0.26, cantos=False),
        "icon-maskable-512.png",
    )

    # iOS (apple-touch-icon) usa 180x180
    salvar(desenhar_icone(180, margem=0.18), "apple-touch-icon-180.png")

    # Favicon simples
    salvar(desenhar_icone(64, margem=0.14), "favicon-64.png")

    print(f"[OK] ícones gerados em {DESTINO}")


if __name__ == "__main__":
    main()
