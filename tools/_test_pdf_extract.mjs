import fs from "node:fs";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

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

const buffer = fs.readFileSync("fatura.pdf");
const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) })
  .promise;
let texto = "";
for (let i = 1; i <= doc.numPages; i++) {
  const pagina = await doc.getPage(i);
  const conteudo = await pagina.getTextContent();
  texto += linhasDaPaginaPDF(conteudo) + "\n";
}

const mVencimento = texto.match(
  /vencimento[^\d]{0,20}(\d{2})\/(\d{2})\/(\d{4})/i,
);
console.log("Vencimento encontrado:", mVencimento ? mVencimento[0] : null);
const mesFatura = mVencimento ? parseInt(mVencimento[2], 10) : null;
const anoFatura = mVencimento ? parseInt(mVencimento[3], 10) : null;
console.log("mesFatura/anoFatura:", mesFatura, anoFatura);

const REGEX_LANCAMENTO = /(\d{2}\/\d{2})\s+(.+?)\s+R\$?\s*(-?[\d.,]+)/g;
let m;
let total = 0;
let soma = 0;
let exemplos = [];
while ((m = REGEX_LANCAMENTO.exec(texto)) !== null) {
  const [, dataCompra, descricaoBruta, valorStr] = m;
  const descricao = descricaoBruta.trim();
  if (/SALDO|PGTO|PAGAMENTO|CASH/i.test(descricao)) continue;
  const valor = valorParaNumero(valorStr, true);
  if (valor <= 0) continue;
  total++;
  soma += valor;
  if (exemplos.length < 5) exemplos.push({ dataCompra, descricao, valor });
}
console.log("total:", total, "soma:", soma.toFixed(2));
console.log("exemplos:", exemplos);
