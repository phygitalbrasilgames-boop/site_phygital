/* ==========================================================================
   PHYGITAL BRASIL — CAMADA HTTP

   Roteador mínimo, leitura de corpo, cookies e respostas em JSON. Substitui o
   Express: o que o projeto precisa cabe em um arquivo e não traz árvore de
   dependências para auditar.
   ========================================================================== */
'use strict';

const auth = require('./auth');

/* --------------------------------------------------------------------------
   LIMITES

   Corpo grande é vetor de negação de serviço: sem teto, um POST de 2 GB
   consome a memória do processo.
   -------------------------------------------------------------------------- */
const CORPO_MAX = 2 * 1024 * 1024;      /* 2 MB para JSON */
const CORPO_MAX_UPLOAD = 8 * 1024 * 1024; /* 8 MB quando a rota aceita arquivo */

/* Envelope de POST /api/upload, e SÓ dele: vídeo de banner passa longe dos
   8 MB acima. É constante separada de propósito — subir CORPO_MAX_UPLOAD
   afrouxaria junto todas as rotas que embutem foto em JSON. A sobra de 2 MB
   sobre o teto de vídeo cobre o invólucro do multipart. */
const CORPO_MAX_ARQUIVO = 52 * 1024 * 1024;

/* --------------------------------------------------------------------------
   ERRO DE APLICAÇÃO

   Lançar ErroHttp de qualquer profundidade devolve o status certo, sem cada
   rota ter que costurar tratamento de erro.
   -------------------------------------------------------------------------- */
class ErroHttp extends Error {
  constructor(status, mensagem, extra = {}) {
    super(mensagem);
    this.status = status;
    this.extra = extra;
  }
}

const erro400 = (m, extra) => new ErroHttp(400, m, extra);
const erro401 = (m = 'Faça login para continuar.') => new ErroHttp(401, m);
const erro403 = (m = 'Sua conta não tem permissão para esta ação.') => new ErroHttp(403, m);
const erro404 = (m = 'Não encontrado.') => new ErroHttp(404, m);
const erro409 = (m, extra) => new ErroHttp(409, m, extra);
const erro429 = (m = 'Muitas requisições. Tente de novo em instantes.') => new ErroHttp(429, m);

/* --------------------------------------------------------------------------
   RESPOSTAS
   -------------------------------------------------------------------------- */

function json(res, status, corpo, cabecalhos = {}) {
  const texto = JSON.stringify(corpo === undefined ? null : corpo);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    /* O navegador não deve adivinhar o tipo do que devolvemos. */
    'X-Content-Type-Options': 'nosniff',
    ...cabecalhos
  });
  res.end(texto);
}

const ok = (res, corpo, cabecalhos) => json(res, 200, corpo, cabecalhos);

function falha(res, e) {
  const status = e instanceof ErroHttp ? e.status : 500;
  const corpo = {
    ok: false,
    erro: status === 500 ? 'Erro interno no servidor.' : e.message,
    ...(e instanceof ErroHttp ? e.extra : {})
  };
  if (status === 500) console.error('[erro 500]', e);
  json(res, status, corpo);
}

/* --------------------------------------------------------------------------
   LEITURA DO CORPO
   -------------------------------------------------------------------------- */

function corpoBruto(req, limite = CORPO_MAX) {
  return new Promise((resolve, reject) => {
    const pedacos = [];
    let tamanho = 0;

    req.on('data', (p) => {
      tamanho += p.length;
      if (tamanho > limite) {
        reject(new ErroHttp(413, 'Conteúdo enviado é grande demais.'));
        req.destroy();
        return;
      }
      pedacos.push(p);
    });
    req.on('end', () => resolve(Buffer.concat(pedacos)));
    req.on('error', reject);
  });
}

async function corpoJson(req, limite = CORPO_MAX) {
  const bruto = await corpoBruto(req, limite);
  if (!bruto.length) return {};
  try {
    const v = JSON.parse(bruto.toString('utf8'));
    /* Só objeto: array ou escalar na raiz quebraria as rotas silenciosamente. */
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      throw erro400('O corpo da requisição deve ser um objeto JSON.');
    }
    return v;
  } catch (e) {
    if (e instanceof ErroHttp) throw e;
    throw erro400('JSON inválido no corpo da requisição.');
  }
}

/* --------------------------------------------------------------------------
   COOKIES
   -------------------------------------------------------------------------- */

function lerCookies(req) {
  const cru = req.headers.cookie;
  if (!cru) return {};
  const saida = {};
  for (const parte of cru.split(';')) {
    const i = parte.indexOf('=');
    if (i < 0) continue;
    saida[parte.slice(0, i).trim()] = decodeURIComponent(parte.slice(i + 1).trim());
  }
  return saida;
}

/* --------------------------------------------------------------------------
   CONTEXTO DA REQUISIÇÃO
   -------------------------------------------------------------------------- */

function ipDe(req) {
  /* Atrás de proxy (Codespaces, Render) o IP real vem no cabeçalho. Só o
     primeiro valor interessa; o resto é cadeia de proxies. */
  const encaminhado = req.headers['x-forwarded-for'];
  if (encaminhado) return String(encaminhado).split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

function ehSeguro(req) {
  return req.headers['x-forwarded-proto'] === 'https'
    || Boolean(req.socket.encrypted);
}

function criarContexto(req, res, url) {
  const cookies = lerCookies(req);
  const token = cookies[auth.NOME_COOKIE] || null;

  return {
    req, res, url, cookies, token,
    metodo: req.method,
    caminho: url.pathname,
    query: url.searchParams,
    ip: ipDe(req),
    agente: req.headers['user-agent'] || '',
    seguro: ehSeguro(req),
    params: {},

    /* Conta resolvida sob demanda e memorizada: uma consulta por requisição. */
    _conta: undefined,
    get conta() {
      if (this._conta === undefined) this._conta = auth.contaDaSessao(this.token);
      return this._conta;
    },

    /** Exige sessão. */
    exigirLogin() {
      const c = this.conta;
      if (!c) throw erro401();
      return c;
    },

    /** Exige sessão de competidor. */
    exigirCompetidor() {
      const c = this.exigirLogin();
      if (c.papel !== 'competidor') throw erro403('Esta área é do Painel do Competidor.');
      return c;
    },

    /** Exige admin e, se informada, a permissão. */
    exigirAdmin(permissao) {
      const c = this.exigirLogin();
      if (c.papel !== 'admin') throw erro403('Esta área é do Painel do Administrador.');
      if (permissao && !auth.podeFazer(c, permissao)) {
        throw erro403(`Seu nível de acesso (${c.nivel}) não permite: ${permissao}.`);
      }
      return c;
    },

    corpo(limite) { return corpoJson(this.req, limite); },
    ok(corpo, cab) { return ok(this.res, corpo, cab); },
    json(status, corpo, cab) { return json(this.res, status, corpo, cab); }
  };
}

/* --------------------------------------------------------------------------
   ROTEADOR

   Padrões no estilo '/api/times/:id'. Sem regex na mão em cada rota e sem
   dependência de roteamento.
   -------------------------------------------------------------------------- */

function criarRoteador() {
  const rotas = [];

  function registrar(metodo, padrao, handler) {
    const nomes = [];
    const regexTexto = padrao
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')     /* escapa literais */
      .replace(/\/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, nome) => {
        nomes.push(nome);
        return '/([^/]+)';
      });

    rotas.push({ metodo, regex: new RegExp(`^${regexTexto}$`), nomes, handler });
  }

  const api = {
    get: (p, h) => (registrar('GET', p, h), api),
    post: (p, h) => (registrar('POST', p, h), api),
    put: (p, h) => (registrar('PUT', p, h), api),
    patch: (p, h) => (registrar('PATCH', p, h), api),
    delete: (p, h) => (registrar('DELETE', p, h), api),

    /** Localiza a rota. Distingue "não existe" de "método errado". */
    achar(metodo, caminho) {
      let caminhoExiste = false;
      for (const r of rotas) {
        const m = r.regex.exec(caminho);
        if (!m) continue;
        caminhoExiste = true;
        if (r.metodo !== metodo) continue;
        const params = {};
        r.nomes.forEach((nome, i) => { params[nome] = decodeURIComponent(m[i + 1]); });
        return { handler: r.handler, params };
      }
      return caminhoExiste ? { metodoErrado: true } : null;
    },

    get total() { return rotas.length; }
  };

  return api;
}

/* --------------------------------------------------------------------------
   PROTEÇÃO CONTRA CSRF

   O cookie é SameSite=Lax, o que já barra o caso comum. Esta checagem cobre o
   resto: toda mutação precisa vir de uma origem que conhecemos.
   -------------------------------------------------------------------------- */

function conferirOrigem(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;

  const origem = req.headers.origin;
  if (!origem) return;   /* cliente não-navegador (curl, testes) não manda Origin */

  const anfitriao = req.headers.host;
  let origemHost;
  try { origemHost = new URL(origem).host; } catch (_) { throw erro403('Origem inválida.'); }

  if (origemHost !== anfitriao) {
    throw erro403('Requisição cruzada bloqueada.');
  }
}

module.exports = {
  ErroHttp, erro400, erro401, erro403, erro404, erro409, erro429,
  json, ok, falha,
  corpoBruto, corpoJson, CORPO_MAX, CORPO_MAX_UPLOAD, CORPO_MAX_ARQUIVO,
  lerCookies, ipDe, ehSeguro, criarContexto, criarRoteador, conferirOrigem
};
