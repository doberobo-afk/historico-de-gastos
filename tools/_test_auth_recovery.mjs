// ==========================================================================
// Teste do HGAuth (js/auth-config.js) SEM navegador:
//   • detecção do link de recuperação de senha (type=recovery)
//   • limite/validação do fluxo de troca de senha (updateUser)
//   • limpeza do token da URL
//   • evento PASSWORD_RECOVERY chegando para o app
//
// Uso: node tools/_test_auth_recovery.mjs
// ==========================================================================
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const codigoAuth = fs.readFileSync(
  path.join(process.cwd(), "js", "auth-config.js"),
  "utf8",
);

let passou = 0;
const falhas = [];
function checar(descricao, condicao, extra) {
  if (condicao) {
    passou++;
    console.log(`  ok    ${descricao}`);
  } else {
    falhas.push(descricao);
    console.log(`  FALHA ${descricao}${extra ? " -> " + extra : ""}`);
  }
}

function criarAuth(opcoes) {
  const opt = opcoes || {};
  const registro = {
    senhaEnviada: null,
    urlLimpa: null,
    callbackSessao: null,
    updates: 0,
  };

  const cliente = {
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      signInWithPassword: async () => ({ data: { session: null }, error: null }),
      updateUser: async (payload) => {
        registro.updates++;
        if (opt.falhaUpdate)
          return { data: null, error: { message: "senha muito curta" } };
        registro.senhaEnviada = payload && payload.password;
        return { data: {}, error: null };
      },
      onAuthStateChange: (cb) => {
        registro.callbackSessao = cb;
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
    },
  };

  const janela = {
    location: {
      hash: opt.hash || "",
      search: opt.search || "",
      pathname: opt.pathname || "/",
      origin: "https://historico-de-gastos.vercel.app",
    },
    history: {
      replaceState: (_a, _b, url) => {
        registro.urlLimpa = url;
      },
    },
  };
  if (!opt.semSdk) janela.supabase = { createClient: () => cliente };

  const contexto = vm.createContext({ window: janela, console });
  vm.runInContext(codigoAuth, contexto);

  return { auth: janela.HGAuth, registro };
}

// 1) Link de recuperação chegando por e-mail
const comRecuperacao = criarAuth({
  hash: "#access_token=abc123&expires_in=3600&type=recovery",
});
console.log("\n1) Link de recuperação (type=recovery no hash)");
checar(
  "emRecuperacao() = true com o hash do e-mail",
  comRecuperacao.auth.emRecuperacao() === true,
);
comRecuperacao.auth.consumirRecuperacao();
checar(
  "consumirRecuperacao() desliga a flag",
  comRecuperacao.auth.emRecuperacao() === false,
);

const semRecuperacao = criarAuth({ hash: "#access_token=abc123&type=signup" });
console.log("\n2) Acesso normal (sem type=recovery)");
checar(
  "emRecuperacao() = false em um link de confirmação de cadastro",
  semRecuperacao.auth.emRecuperacao() === false,
);
checar(
  "emRecuperacao() = false sem hash nenhum",
  criarAuth({}).auth.emRecuperacao() === false,
);

// 3) limparUrlAuth tira o token da barra de endereços
console.log("\n3) limparUrlAuth() limpa o token da URL");
{
  const t = criarAuth({
    hash: "#access_token=abc123&type=recovery",
    search: "?code=xyz&type=recovery",
  });
  t.auth.limparUrlAuth();
  checar(
    "não sobra code/type na URL",
    t.registro.urlLimpa === "/",
    `url=${t.registro.urlLimpa}`,
  );
}

// 4) troca de senha (updateUser)
console.log("\n4) atualizarSenha() usa updateUser do Supabase");
{
  const t = criarAuth({ hash: "#access_token=abc&type=recovery" });
  const ok = await t.auth.atualizarSenha("nova-senha-123");
  checar("retorna true no sucesso", ok === true);
  checar(
    "envia exatamente a senha informada",
    t.registro.senhaEnviada === "nova-senha-123",
  );
}
{
  const t = criarAuth({ falhaUpdate: true });
  let mensagem = "";
  try {
    await t.auth.atualizarSenha("123");
  } catch (e) {
    mensagem = e.message;
  }
  checar(
    "erro do Supabase vira exceção com mensagem",
    /senha muito curta/.test(mensagem),
    mensagem,
  );
}
{
  const t = criarAuth({ semSdk: true });
  let mensagem = "";
  try {
    await t.auth.atualizarSenha("nova-senha-123");
  } catch (e) {
    mensagem = e.message;
  }
  checar(
    "sem SDK do Supabase, falha de forma clara",
    /indisponível/.test(mensagem),
    mensagem,
  );
}

// 5) evento PASSWORD_RECOVERY chega ao app (2º argumento do callback)
console.log("\n5) evento PASSWORD_RECOVERY é repassado ao app");
{
  const t = criarAuth({});
  let recebido = null;
  t.auth.aoMudarSessao((sessao, evento) => {
    recebido = { sessao, evento };
  });
  checar("callback registrado no onAuthStateChange", !!t.registro.callbackSessao);
  t.registro.callbackSessao("PASSWORD_RECOVERY", null);
  checar(
    "app recebe o nome do evento",
    recebido && recebido.evento === "PASSWORD_RECOVERY",
  );
  checar(
    "PASSWORD_RECOVERY liga emRecuperacao()",
    t.auth.emRecuperacao() === true,
  );
}

console.log(
  `\n${passou} verificações ok, ${falhas.length} falha(s)` +
    (falhas.length ? "\n- " + falhas.join("\n- ") : ""),
);
process.exit(falhas.length ? 1 : 0);
