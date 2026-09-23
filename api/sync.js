/**
 * Vercel Function (Node.js) - /api/sync
 * -------------------------------------------------------------------------
 * Persiste os dados do app no Supabase via REST (PostgREST), sem dependências.
 *
 *   GET    /api/sync   -> { ok, usuario, dados: {controle_financeiro, ...} }
 *   POST   /api/sync   -> grava/atualiza o documento do usuário autenticado
 *   DELETE /api/sync   -> apaga o documento do usuário autenticado (reset)
 *
 * Autenticação: obrigatória em toda requisição via
 *   Authorization: Bearer <access_token da sessão Supabase>
 * O token é validado contra o Supabase Auth (GET /auth/v1/user) e o
 * user_id resultante é usado para filtrar/gravar SOMENTE os dados do
 * próprio usuário. Sem token válido a API responde 401.
 *
 * Variáveis de ambiente:
 *   SUPABASE_URL               -> https://xxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY  -> chave service_role (somente no servidor)
 *   SUPABASE_ANON_KEY          -> chave anon (usada só para validar o token)
 *
 * Sem Supabase configurado a função responde 501 e o front-end entra
 * automaticamente em modo local (localStorage), sem quebrar o app.
 *
 * SQL da tabela: ver docs/supabase.sql
 */
const TABELA = "hg_dados";
const LIMITE_BYTES = 4 * 1024 * 1024; // 4 MB por documento

function config() {
  return {
    url: String(process.env.SUPABASE_URL || "").replace(/\/+$/, ""),
    chaveServico: String(
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || "",
    ),
    chaveAnon: String(
      process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || "",
    ),
  };
}

function responder(res, codigo, corpo) {
  res.statusCode = codigo;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(corpo));
}

function tokenDe(req) {
  const cabecalho = String(req.headers["authorization"] || "").trim();
  const m = /^Bearer\s+(.+)$/i.exec(cabecalho);
  return m ? m[1].trim() : "";
}

// Valida o access_token da sessão do usuário direto no Supabase Auth e
// devolve { id, email } — ou null se o token for inválido/expirado.
async function usuarioAutenticado(cfg, token) {
  if (!token) return null;
  const resposta = await fetch(`${cfg.url}/auth/v1/user`, {
    headers: {
      apikey: cfg.chaveAnon || cfg.chaveServico,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!resposta.ok) return null;
  const usuario = await resposta.json().catch(() => null);
  if (!usuario || !usuario.id) return null;
  return { id: usuario.id, email: usuario.email || usuario.id };
}

async function supabase(cfg, metodo, caminho, corpo, prefer) {
  const resposta = await fetch(`${cfg.url}/rest/v1/${caminho}`, {
    method: metodo,
    headers: {
      apikey: cfg.chaveServico,
      Authorization: `Bearer ${cfg.chaveServico}`,
      "Content-Type": "application/json",
      Prefer: prefer || "return=minimal",
    },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });

  const texto = await resposta.text();
  if (!resposta.ok) {
    throw new Error(`Supabase ${resposta.status}: ${texto.slice(0, 200)}`);
  }
  return texto.trim() ? JSON.parse(texto) : [];
}

function corpoJson(req) {
  if (!req.body) return {};
  if (typeof req.body === "object") return req.body;
  try {
    return JSON.parse(String(req.body));
  } catch (erro) {
    return {};
  }
}

module.exports = async function handler(req, res) {
  const cfg = config();

  if (!cfg.url || !cfg.chaveServico) {
    return responder(res, 501, {
      ok: false,
      modo: "local",
      erro: "Supabase não configurado neste ambiente",
      dica: "defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY nas variáveis da Vercel",
    });
  }

  const token = tokenDe(req);
  if (!token) {
    return responder(res, 401, {
      ok: false,
      erro: "token de autenticação ausente",
    });
  }

  const usuarioAuth = await usuarioAutenticado(cfg, token).catch(() => null);
  if (!usuarioAuth) {
    return responder(res, 401, {
      ok: false,
      erro: "token de autenticação inválido",
    });
  }

  const usuario = usuarioAuth.email;
  const userId = usuarioAuth.id;

  try {
    if (req.method === "GET") {
      const linhas = await supabase(
        cfg,
        "GET",
        `${TABELA}?user_id=eq.${encodeURIComponent(userId)}&select=dados,atualizado_em&limit=1`,
      );
      const registro = Array.isArray(linhas) ? linhas[0] : null;
      return responder(res, 200, {
        ok: true,
        usuario,
        dados: (registro && registro.dados) || {},
        atualizado_em: (registro && registro.atualizado_em) || null,
      });
    }

    if (req.method === "POST") {
      const corpo = corpoJson(req);
      const dados = corpo && corpo.dados ? corpo.dados : corpo;
      if (!dados || typeof dados !== "object") {
        return responder(res, 400, {
          ok: false,
          erro: "campo 'dados' ausente",
        });
      }

      const serializado = JSON.stringify(dados);
      if (serializado.length > LIMITE_BYTES) {
        return responder(res, 413, {
          ok: false,
          erro: `documento maior que o limite de ${LIMITE_BYTES / (1024 * 1024)} MB`,
        });
      }

      await supabase(
        cfg,
        "POST",
        TABELA,
        [
          {
            usuario,
            user_id: userId,
            dados,
            atualizado_em: new Date().toISOString(),
          },
        ],
        "resolution=merge-duplicates,return=minimal",
      );

      return responder(res, 200, {
        ok: true,
        usuario,
        salvoEm: new Date().toISOString(),
        itens: {
          controle_financeiro: Array.isArray(dados.controle_financeiro)
            ? dados.controle_financeiro.length
            : 0,
          controle_dividas: Array.isArray(dados.controle_dividas)
            ? dados.controle_dividas.length
            : 0,
        },
      });
    }

    if (req.method === "DELETE") {
      await supabase(
        cfg,
        "DELETE",
        `${TABELA}?user_id=eq.${encodeURIComponent(userId)}`,
      );
      return responder(res, 200, { ok: true, usuario, apagado: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return responder(res, 405, { ok: false, erro: "método não suportado" });
  } catch (erro) {
    return responder(res, 502, {
      ok: false,
      erro: "falha ao falar com o Supabase",
      detalhe: String((erro && erro.message) || erro).slice(0, 300),
    });
  }
};
