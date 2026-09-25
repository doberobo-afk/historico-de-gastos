// ============================================================================
// Visão Anual — tabela no estilo do print Excel (Resumo / js/visaoAnual.js)
// ----------------------------------------------------------------------------
// Receitas, parcelados, fixos e variáveis por mês. DESPESA TOTAL e SALDO se
// calculam automáticamente (nunca são valores fixos). Render no DOMContentLoaded
// e expone window.recalcularAnual() para atualizar quando se lanza um gasto.
(function () {
  "use strict";

  // Dados de entrada (fonte). Se queres integrar com o STATE do app, atualiza
  // este objeto por série/mês e chama recalcularAnual().
  const DATOS = {
    anio: 2026,
    meses: ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"],
    receita: [
      6114.31, 5971.37, 6691.03, 6691.03, 7157.66, 7150,
      7150, 7150, 8150, 8150, 8150, 8150,
    ],
    parcelados: [
      3034.77, 3375.11, 3364.26, 3108.23, 2962.73, 2558.05,
      2732.53, 2681.67, 2223.41, 2169.41, 2116.26, 2116.26,
    ],
    gastosFixos: [
      1005.5, 1046.87, 1086.89, 1009.49, 989.39, 989.39,
      989.39, 984.4, 969.4, 969.4, 969.4, 969.4,
    ],
    gastosVariaveis: [
      6687.2, 5998.28, 2625.19, 4608.31, 5463.44, 3676.58,
      3772.49, 5008.46, 20, 0, 0, 0,
    ],
  };

  // "R$ 6.114,31" (milares com ponto, decimais com vírgula). Negativos: "-R$ …"
  function brl(v) {
    const neg = v < 0;
    const [int, dec] = Math.abs(v).toFixed(2).split(".");
    const intG = int.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    return (neg ? "-" : "") + "R$ " + intG + "," + dec;
  }

  function suma(arr) {
    return arr.reduce((acc, x) => acc + x, 0);
  }

  // Cálculos automáticos (nunca valores fixos):
  //   DESPESA TOTAL = PARCELADOS + GASTOS FIXOS + GASTOS VARIABLES
  //   SALDO         = RECEITA - DESPESA TOTAL
  function calcular() {
    const meses = DATOS.meses;
    const DESPESA_TOTAL = meses.map((_, i) =>
      DATOS.parcelados[i] + DATOS.gastosFixos[i] + DATOS.gastosVariaveis[i],
    );
    const SALDO = meses.map((_, i) => DATOS.receita[i] - DESPESA_TOTAL[i]);
    return {
      RECEITA: DATOS.receita.slice(),
      PARCELADOS: DATOS.parcelados.slice(),
      GASTOS_FIXOS: DATOS.gastosFixos.slice(),
      GASTOS_VARIABLES: DATOS.gastosVariaveis.slice(),
      DESPESA_TOTAL,
      SALDO,
    };
  }

  // Degradê vermelho -> verde dos gastos variáveis segundo o valor:
  //   > 4000 -> vermelho #fca5a5 · < 1000 -> verde #86efac · entre eles, mezcla
  function colorVariavel(v) {
    const MIN = 1000;
    const MAX = 4000;
    if (v <= MIN) return "#86efac";
    if (v >= MAX) return "#fca5a5";
    const t = (v - MIN) / (MAX - MIN);
    const rI = [252, 165, 165]; // #fca5a5
    const gI = [134, 239, 172]; // #86efac
    const rgb = [0, 1, 2].map((k) =>
      Math.round(rI[k] + (gI[k] - rI[k]) * t),
    );
    return `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]})`;
  }

  // Saldo: próximo de cero -> amarelo; negativo -> vermelho; positivo -> verde
  function claseSaldo(v) {
    if (Math.abs(v) < 200) return "va-saldo-cero";
    return v < 0 ? "va-saldo-neg" : "va-saldo-pos";
  }

  function render() {
    const tabla = document.getElementById("tabelaAnualExcel");
    if (!tabla) return;

    const D = calcular();
    const meses = DATOS.meses;

    const td = (html, cls, style) =>
      `<td class="${cls}"${style ? ` style="${style}"` : ""}>${html}</td>`;
    const th = (html, cls) => `<th class="${cls}">${html}</th>`;

    // Fila genérica: etiqueta + 12 meses + columna TOTAL. `clase` dá o fundo a
    // toda a fila (incluida a etiqueta fixa). `getCelda` sobre-escribe as celdas
    // dos meses (fondo por valor: gastos variáveis/saldo).
    const fila = (label, clase, valores, getCelda) => {
      const mes = getCelda
        ? valores.map((v, i) => getCelda(v, i)).join("")
        : valores.map((v) => td(brl(v), `va-cel ${clase}`)).join("");
      return (
        `<tr>` +
        td(label, `va-etiqueta ${clase}`) +
        mes +
        td(brl(suma(valores)), `va-total ${clase}`) +
        `</tr>`
      );
    };

    let htmlRows = "";
    // Cabecera ANO 2026 (fila combinada) + meses
    htmlRows +=
      `<tr><td class="va-ano" colspan="${meses.length + 2}">ANO ${DATOS.anio}</td></tr>`;
    htmlRows += `<tr>${th("", "va-hdr va-corner")}`;
    meses.forEach((m) => {
      htmlRows += th(m, "va-hdr");
    });
    htmlRows += `${th("TOTAL", "va-hdr")}</tr>`;

    // Filas
    htmlRows += fila("RECEITA", "va-receita", D.RECEITA);
    htmlRows += fila("PARCELADOS", "va-parcelados", D.PARCELADOS);
    htmlRows += fila("GASTOS FIXOS", "va-fixos", D.GASTOS_FIXOS);
    htmlRows += fila("GASTOS VARIABLES", "va-etq", D.GASTOS_VARIABLES, (v) =>
      td(brl(v), "va-cel", `background:${colorVariavel(v)}`),
    );
    htmlRows += fila("DESPESA TOTAL", "va-despesa", D.DESPESA_TOTAL);
    htmlRows += fila("SALDO", "va-etq", D.SALDO, (v) =>
      td(brl(v), "va-cel " + claseSaldo(v)),
    );

    tabla.innerHTML = htmlRows;
  }

  function recalcularAnual() {
    render();
    return true;
  }

  // Render no DOMContentLoaded (e de imediato se já cargou)
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render, { once: true });
  } else {
    render();
  }

  window.recalcularAnual = recalcularAnual;
  window.visaoAnual = {
    DATOS,
    calcular,
    brl,
    colorVariavel,
    claseSaldo,
    render,
    recalcularAnual,
  };
})();