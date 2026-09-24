import fs from "node:fs";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

const MESES = [
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
];

function linhasDaPaginaPDF(textContent) {
  const porLinha = new Map();
  textContent.items.forEach((item) => {
    const y = Math.round(item.transform[5]);
    if (!porLinha.has(y)) porLinha.set(y, []);
    porLinha.get(y).push(item);
  });
  const ys = Array.from(porLinha.keys()).sort((a, b) => b - a);
  return ys
    .map((y) =>
      porLinha
        .get(y)
        .sort((a, b) => a.transform[4] - b.transform[4])
        .map((item) => item.str)
        .join(" "),
    )
    .join("\n");
}

function valorParaNumero(str, formatoBanco) {
  if (str === undefined || str === null || str === "") return 0;
  let s = String(str).trim();
  if (formatoBanco) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    s = s.includes(",") && !s.includes(".") ? s.replace(",", ".") : s;
  }
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// Classificação heurística do TIPO (mesma lógica de js/app.js -> importarPDF).
function detectarTipo(desc) {
  const d = desc.toUpperCase();
  if (d.match(/UBER|99|TAXI|COMBUST|POSTO|SHELL|IPIRANGA/)) return "TRANSPORTE";
  if (d.match(/IFOOD|RAPPI|RESTAUR|LANCH|MERCADO|SUPERM|ATACADAO|ASSAI|PADARIA|ACAI/))
    return "ALIMENTAÇÃO";
  if (d.match(/FARMACIA|DROGASIL|DROGA|PAGUE MENOS/)) return "SAÚDE";
  if (d.match(/NETFLIX|SPOTIFY|GLOBOPLAY|PRIME|YOUTUBE|DISNEY|HBO|AMAZON PRIME/))
    return "LAZER";
  if (d.match(/LUZ|ENERGIA|AGUA|INTERNET|CLARO|VIVO|TIM|OI/))
    return "CONTAS FIXAS";
  if (d.match(/SHEIN|SHOPEE|MERCADO LIVRE|AMAZON|MAGALU|AMERICANAS/))
    return "COMPRAS";
  return "GASTOS VARIÁVEIS";
}

function normalizarDescricao(desc) {
  return desc.toUpperCase().trim().replace(/\s{2,}/g, " ");
}

const buffer = fs.readFileSync("fatura.pdf");
const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) })
  .promise;
let texto = "";
let bruto = ""; // ordem "de leitura" do PDF (mesma estratégia do app.js)
for (let i = 1; i <= doc.numPages; i++) {
  const pagina = await doc.getPage(i);
  const conteudo = await pagina.getTextContent();
  texto += linhasDaPaginaPDF(conteudo) + "\n";
  bruto += conteudo.items.map((item) => item.str).join(" ") + " ";
}

const hoje = new Date();
const mVencimento = bruto.match(
  /vencimento[^\d]{0,20}(\d{2})\/(\d{2})\/(\d{4})/i,
);
console.log("Vencimento encontrado:", mVencimento ? mVencimento[0] : null);
const mesFatura = mVencimento ? parseInt(mVencimento[2], 10) : hoje.getMonth() + 1;
const anoFatura = mVencimento ? parseInt(mVencimento[3], 10) : hoje.getFullYear();
console.log(
  "mesFatura/anoFatura:",
  mesFatura,
  anoFatura,
  mVencimento ? "(competência da fatura)" : "(fallback: mês atual)",
);

const REGEX_LANCAMENTO = /(\d{2}\/\d{2})\s+(.+?)\s+R\$?\s*(-?[\d.,]+)/g;
let m;
let total = 0;
let soma = 0;
const porTipo = {};
const exemplos = [];
while ((m = REGEX_LANCAMENTO.exec(texto)) !== null) {
  const [, dataCompra, descricaoBruta, valorStr] = m;
  const descricao = descricaoBruta.trim();
  if (/SALDO|PGTO|PAGAMENTO|CASH/i.test(descricao)) continue;
  const valor = valorParaNumero(valorStr, true);
  if (valor <= 0) continue;

  const [diaStr, mesStr] = dataCompra.split("/");
  const mesCompra = parseInt(mesStr, 10);
  // Compras parceladas antigas (mês da compra > mês de fechamento) são do ano anterior.
  const anoCompra = mesCompra > mesFatura ? anoFatura - 1 : anoFatura;
  const tipo = detectarTipo(descricao);

  total++;
  soma += valor;
  porTipo[tipo] = (porTipo[tipo] || 0) + valor;
  if (exemplos.length < 10) {
    exemplos.push({
      DATA: `${diaStr}/${mesStr}/${anoCompra}`,
      DISCRIMINACAO: normalizarDescricao(descricao),
      VALOR: valor,
      TIPO: tipo,
      VENCIMENTO: MESES[mesFatura - 1],
      ANO: anoFatura,
    });
  }
}
console.log("total:", total, "soma:", soma.toFixed(2));
console.log("competência (VENCIMENTO/ANO):", MESES[mesFatura - 1], anoFatura);
console.log("10 primeiros exemplos (com TIPO detectado):");
console.table(exemplos);
console.log("soma por TIPO:");
Object.entries(porTipo)
  .sort((a, b) => b[1] - a[1])
  .forEach(([tipo, v]) => console.log(`  ${tipo}: ${v.toFixed(2)}`));
