// ==========================================================================
// HGAuth - autenticação real via Supabase Auth (e-mail + senha)
// --------------------------------------------------------------------------
// Requer o SDK supabase-js (UMD) carregado antes deste arquivo (ver
// index.html) e as chaves públicas abaixo. SUPABASE_ANON_KEY é uma chave
// PUBLICÁVEL (não é a service_role) — pode ficar exposta no front-end.
// ==========================================================================
(function (global) {
  "use strict";

  // TODO: preencha com os dados do seu projeto Supabase (Project Settings > API).
  var SUPABASE_URL = "https://kzqzhwcyzkyptljnckik.supabase.co";
  var SUPABASE_ANON_KEY = "sb_publishable_KsHtFPV2FmNu0JbMQUuEKQ_AE-oe4rZ";

  var client = null;
  function cliente() {
    if (client) return client;
    if (
      !global.supabase ||
      typeof global.supabase.createClient !== "function"
    ) {
      console.warn("[HGAuth] SDK supabase-js não carregado.");
      return null;
    }
    client = global.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    return client;
  }

  // ---------------------------------------------------------------------
  // Link de redefinição de senha
  // ---------------------------------------------------------------------
  // O supabase-js consome e limpa a URL ao criar o cliente, então a detecção
  // precisa acontecer aqui, no carregamento do script (quando a URL ainda tem
  // o hash com type=recovery enviado pelo e-mail do Supabase).
  var recuperacaoPendente = (function () {
    try {
      var hash = global.location ? String(global.location.hash || "") : "";
      var busca = global.location ? String(global.location.search || "") : "";
      return (
        /type=recovery/i.test(hash) ||
        /type=recovery/i.test(busca) ||
        /error_description=/i.test(hash)
      );
    } catch (e) {
      return false;
    }
  })();

  function emRecuperacao() {
    return recuperacaoPendente;
  }

  function consumirRecuperacao() {
    recuperacaoPendente = false;
  }

  // Tira o token da barra de endereços (evita deixá-lo visível/histórico).
  function limparUrlAuth() {
    try {
      if (global.history && global.history.replaceState) {
        var limpa = global.location.pathname + global.location.search;
        limpa = limpa.replace(/[?&](code|error|error_description|type)=[^&]*/g, "");
        limpa = limpa.replace(/[?&]$/, "");
        global.history.replaceState(null, "", limpa || "/");
      }
    } catch (e) {
      /* ignora */
    }
  }

  // Troca a senha do usuário logado (usada tanto na recuperação por e-mail
  // quanto no botão "Alterar senha" dentro do app).
  async function atualizarSenha(novaSenha) {
    var c = cliente();
    if (!c) throw new Error("autenticação indisponível");
    var resp = await c.auth.updateUser({ password: novaSenha });
    if (resp.error)
      throw new Error(resp.error.message || "falha ao alterar a senha");
    return true;
  }

  function sessaoParaUsuario(sessao) {
    if (!sessao || !sessao.access_token || !sessao.user) return null;
    return {
      id: sessao.user.id,
      usuario: sessao.user.email || sessao.user.id,
      token: sessao.access_token,
    };
  }

  // Sessão atual (persistida pelo supabase-js no localStorage), ou null.
  async function obterSessao() {
    var c = cliente();
    if (!c) return null;
    var resp = await c.auth.getSession();
    return sessaoParaUsuario(resp && resp.data && resp.data.session);
  }

  async function entrar(email, senha) {
    var c = cliente();
    if (!c) throw new Error("autenticação indisponível");
    var resp = await c.auth.signInWithPassword({
      email: email,
      password: senha,
    });
    if (resp.error) throw new Error(resp.error.message || "falha ao entrar");
    return sessaoParaUsuario(resp.data && resp.data.session);
  }

  async function criarConta(email, senha) {
    var c = cliente();
    if (!c) throw new Error("autenticação indisponível");
    var resp = await c.auth.signUp({ email: email, password: senha });
    if (resp.error)
      throw new Error(resp.error.message || "falha ao criar conta");
    // Se a confirmação por e-mail estiver ativa, session vem nula aqui.
    return sessaoParaUsuario(resp.data && resp.data.session);
  }

  async function esqueciSenha(email) {
    var c = cliente();
    if (!c) throw new Error("autenticação indisponível");
    var resp = await c.auth.resetPasswordForEmail(email, {
      redirectTo: global.location ? global.location.origin : undefined,
    });
    if (resp.error)
      throw new Error(resp.error.message || "falha ao enviar e-mail");
    return true;
  }

  async function sair() {
    var c = cliente();
    if (c) await c.auth.signOut();
    return true;
  }

  function aoMudarSessao(cb) {
    var c = cliente();
    if (!c || typeof cb !== "function") return function () {};
    var assinatura = c.auth.onAuthStateChange(function (evento, sessao) {
      if (evento === "PASSWORD_RECOVERY") recuperacaoPendente = true;
      cb(sessaoParaUsuario(sessao), evento);
    });
    return function () {
      try {
        assinatura.data.subscription.unsubscribe();
      } catch (e) {
        /* ignora */
      }
    };
  }

  global.HGAuth = {
    obterSessao: obterSessao,
    entrar: entrar,
    criarConta: criarConta,
    esqueciSenha: esqueciSenha,
    atualizarSenha: atualizarSenha,
    sair: sair,
    aoMudarSessao: aoMudarSessao,
    emRecuperacao: emRecuperacao,
    consumirRecuperacao: consumirRecuperacao,
    limparUrlAuth: limparUrlAuth,
    // Exposto para o HGStore falar direto com o Supabase (sem /api/sync).
    client: cliente,
  };
})(window);
