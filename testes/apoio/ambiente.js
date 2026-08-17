/* ==========================================================================
   PHYGITAL BRASIL — AMBIENTE DOS TESTES

   Tudo que os arquivos de testes/casos/ precisam para conversar com a API:
   o servidor de verdade, um cliente HTTP com pote de cookies e os atalhos de
   sessão.

   Quem carrega este módulo tem que ter definido PHYGITAL_DADOS ANTES — o
   server/db.js lê a variável no momento em que é exigido, e depois disso não
   dá mais para trocar de banco. testes/executar.js faz isso na primeira linha.

   Duas decisões que atravessam a suíte:

   · Cada cliente ganha um IP próprio, mandado em X-Forwarded-For (é o que
     server/http.js lê em ipDe). Sem isso, o freio de força bruta de um teste
     bloquearia o login de todos os outros — os freios do servidor são por IP.
   · A sessão normalmente é aberta direto por auth.abrirSessao, não por
     POST /api/auth/login. O login gasta um scrypt de ~100 ms para provar algo
     que só os testes de autenticação querem provar; o resto da suíte quer
     apenas estar logado.
   ========================================================================== */
'use strict';

const http = require('node:http');
const path = require('node:path');

/**
 * Cliente sem conexão persistente. Duas razões:
 *
 * · o executor do node:test encerra a rodada no `beforeExit` do processo, que
 *   nunca chega enquanto houver um soquete vivo — um pool keep-alive deixaria
 *   a suíte pendurada depois do último teste;
 * · cada requisição fecha o que abriu, então nenhum estado de conexão vaza de
 *   um teste para o outro.
 */
const AGENTE = new http.Agent({ keepAlive: false, maxSockets: 8 });

const RAIZ = path.join(__dirname, '..', '..');

const db = require(path.join(RAIZ, 'server', 'db'));
const auth = require(path.join(RAIZ, 'server', 'auth'));
const regras = require(path.join(RAIZ, 'server', 'regras'));
const mapa = require(path.join(RAIZ, 'server', 'mapa'));
const semente = require(path.join(RAIZ, 'server', 'semente'));
const api = require(path.join(RAIZ, 'server', 'index'));

/* Contas e senhas que a semente cria. As senhas passam pela política de
   server/auth.js, que recusa qualquer coisa contendo "phygital", "senha",
   "brasil", "123456" ou "qwerty". */
const SENHA_ADMIN = 'Arena2026Nacional';
const SENHA_COMPETIDOR = 'Quadra2026Digital';

const CONTAS = {
  master: { id: 'u1', email: 'inscricoes@phygitalgamesbr.com.br', senha: SENHA_ADMIN },
  gestor: { id: 'u2', email: 'ana@phygitalgamesbr.com.br' },
  operacao: { id: 'u3', email: 'carlos@phygitalgamesbr.com.br' },
  competidor: { id: 'comp1', email: 'phygitalbrasilgames@gmail.com', senha: SENHA_COMPETIDOR }
};

/* Ids que a semente garante e que os testes usam como ponto fixo. */
const SEMEADOS = {
  timeFutebol: 't1',            /* Tigres Phygital, 6 titulares + 1 reserva */
  timeShooter: 't2',            /* Alpha Squad BR */
  campeonatoFutebol: 'cbf-2026',
  campeonatoBasquete: 'cbb-2026',
  campeonatoShooter: 'cbs-2026',
  campeonatoEncerrado: 'cbf-2025',
  chamadoDoCompetidor: '2026-000091',
  chamadoEncerrado: '2026-000104',
  chamadoDeOutro: '2026-000118'
};

let servidor = null;
let PORTA = 0;
let BASE = '';

/* --------------------------------------------------------------------------
   DATAS

   As datas são calculadas a partir de hoje para a suíte não vencer: um
   campeonato "com prazo aberto" escrito à mão vira "prazo vencido" no ano que
   vem e derruba testes que estão certos.
   -------------------------------------------------------------------------- */

const emDias = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const hoje = () => emDias(0);

/* --------------------------------------------------------------------------
   SUBIDA E DESCIDA
   -------------------------------------------------------------------------- */

/** Roda `fn` sem deixar a semente imprimir o relatório dela no meio da suíte. */
function silenciar(fn) {
  const original = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = original; }
}

async function subir() {
  db.abrir();
  silenciar(() => semente.semear({ recriar: true }));

  if (api.falhados.length) {
    throw new Error(
      'Módulos de rota com falha: '
      + api.falhados.map((f) => `${f.modulo} (${f.erro})`).join(', ')
    );
  }

  servidor = http.createServer((req, res) => {
    api.atender(req, res).catch((e) => {
      console.error('[servidor de teste] erro não tratado:', e);
      if (!res.headersSent) res.writeHead(500).end('{"ok":false}');
    });
  });

  await new Promise((pronto) => servidor.listen(0, '127.0.0.1', pronto));
  PORTA = servidor.address().port;
  BASE = `http://127.0.0.1:${PORTA}`;

  /* Servidor à espera é um handle vivo, e handle vivo adia o `beforeExit` —
     que é justamente o momento em que o executor do node:test fecha a rodada.
     Com unref ele continua atendendo, mas deixa de segurar o processo. */
  servidor.unref();

  return BASE;
}

async function descer() {
  if (servidor) await new Promise((pronto) => servidor.close(pronto));
  servidor = null;
  db.fechar();
}

/* --------------------------------------------------------------------------
   CLIENTE HTTP
   -------------------------------------------------------------------------- */

let contadorIp = 0;

/** Um IP por cliente, para isolar os freios de força bruta e de ritmo. */
function ipUnico() {
  contadorIp += 1;
  return `10.20.${Math.floor(contadorIp / 250) + 1}.${(contadorIp % 250) + 1}`;
}

/** Uma requisição HTTP de verdade, sem conexão persistente. */
function requisitar({ metodo, caminho, cabecalhos, carga }) {
  return new Promise((resolver, rejeitar) => {
    const pedido = http.request({
      host: '127.0.0.1', port: PORTA, path: caminho, method: metodo,
      agent: AGENTE, headers: cabecalhos
    }, (resposta) => {
      const pedacos = [];
      resposta.on('data', (p) => pedacos.push(p));
      resposta.on('end', () => resolver({
        status: resposta.statusCode,
        cabecalhos: resposta.headers,
        texto: Buffer.concat(pedacos).toString('utf8')
      }));
    });

    pedido.on('error', rejeitar);
    if (carga !== null) pedido.write(carga);
    pedido.end();
  });
}

/**
 * Cliente HTTP com pote de cookies. `corpo` undefined não manda corpo nem
 * Content-Type — é assim que uma requisição sem carga chega de verdade.
 */
function cliente({ ip, cookie } = {}) {
  const estado = { ip: ip || ipUnico(), cookie: cookie || null };

  const eu = {
    get ip() { return estado.ip; },
    get cookie() { return estado.cookie; },
    set cookie(valor) { estado.cookie = valor; },

    async pedir(metodo, caminho, corpo, extra = {}) {
      const carga = corpo === undefined
        ? null
        : Buffer.from(extra.cru ? String(corpo) : JSON.stringify(corpo), 'utf8');

      const bruta = await requisitar({
        metodo,
        caminho,
        carga,
        cabecalhos: {
          'x-forwarded-for': estado.ip,
          'user-agent': 'suite-de-testes',
          ...(estado.cookie ? { cookie: estado.cookie } : {}),
          ...(carga ? { 'content-type': 'application/json', 'content-length': carga.length } : {}),
          ...(extra.cabecalhos || {})
        }
      });

      /* Guardamos só o par nome=valor de cada Set-Cookie, que é o que o
         navegador manda de volta. Cookie apagado (valor vazio) esvazia o pote. */
      const postos = bruta.cabecalhos['set-cookie'] || [];
      if (postos.length) {
        const par = postos.map((c) => c.split(';')[0]).join('; ');
        estado.cookie = par.endsWith('=') ? null : par;
      }

      let json = null;
      try { json = JSON.parse(bruta.texto); } catch (_) { json = null; }

      return {
        status: bruta.status,
        corpo: json,
        texto: bruta.texto,
        /* Mesmo acesso por nome que o fetch dá, para o teste não precisar
           lembrar que aqui o cabeçalho é um objeto simples. */
        cabecalhos: { get: (nome) => bruta.cabecalhos[String(nome).toLowerCase()] },
        cookies: postos
      };
    },

    get: (caminho, extra) => eu.pedir('GET', caminho, undefined, extra),
    post: (caminho, corpo, extra) => eu.pedir('POST', caminho, corpo, extra),
    put: (caminho, corpo, extra) => eu.pedir('PUT', caminho, corpo, extra),
    apagar: (caminho, corpo, extra) => eu.pedir('DELETE', caminho, corpo, extra)
  };

  return eu;
}

/** Cliente já logado, com a sessão aberta direto no banco. */
function sessao(contaId, opcoes = {}) {
  const cli = cliente(opcoes);
  const aberta = auth.abrirSessao(contaId, { ip: cli.ip, agente: 'suite-de-testes' });
  cli.cookie = `${auth.NOME_COOKIE}=${aberta.token}`;
  return cli;
}

const comoMaster = () => sessao(CONTAS.master.id);
const comoGestor = () => sessao(CONTAS.gestor.id);
const comoOperacao = () => sessao(CONTAS.operacao.id);
const comoCompetidor = () => sessao(CONTAS.competidor.id);
const anonimo = () => cliente();

/** Login de verdade, passando pelo scrypt e pelo Set-Cookie. */
async function entrar(email, senha, opcoes = {}) {
  const cli = cliente(opcoes);
  const resposta = await cli.post('/api/auth/login', { email, senha });
  return { cliente: cli, resposta };
}

/* --------------------------------------------------------------------------
   FIXTURES

   Criadas direto no banco quando o que interessa é o estado, não o caminho
   até ele — cadastrar uma conta pela API custa dois scrypts e um código de
   verificação que o teste em questão não está avaliando.
   -------------------------------------------------------------------------- */

let contadorConta = 0;

/** Competidor novo, com e-mail confirmado e sessão pronta. */
function novoCompetidor(nome = 'Competidor de Teste') {
  contadorConta += 1;
  const id = `teste-comp-${contadorConta}`;
  const email = `competidor.teste.${contadorConta}@exemplo.com`;
  const senha = `Litoral${contadorConta}Nacional`;
  const credencial = auth.criarSenha(senha);

  db.executar(
    `INSERT INTO contas (id, nome, email, senha_hash, senha_salt, papel,
                         email_verificado, senha_provisoria, criado_em)
     VALUES (?, ?, ?, ?, ?, 'competidor', 1, 0, ?)`,
    id, nome, email, credencial.senha_hash, credencial.senha_salt, db.agora()
  );

  return { id, nome, email, senha, cliente: sessao(id) };
}

/** Administrador novo no nível pedido, com e-mail confirmado e sessão pronta. */
function novoAdmin(nivel = 'master', nome = 'Admin de Teste') {
  contadorConta += 1;
  const id = `teste-adm-${contadorConta}`;
  const email = `admin.teste.${contadorConta}@exemplo.com`;
  const senha = `Cordilheira${contadorConta}Norte`;
  const credencial = auth.criarSenha(senha);

  db.executar(
    `INSERT INTO contas (id, nome, email, senha_hash, senha_salt, papel, nivel,
                         email_verificado, senha_provisoria, criado_em)
     VALUES (?, ?, ?, ?, ?, 'admin', ?, 1, 0, ?)`,
    id, nome, email, credencial.senha_hash, credencial.senha_salt, nivel, db.agora()
  );

  return { id, nome, email, senha, nivel, cliente: sessao(id) };
}

/**
 * Campeonato pronto para receber inscrição. `prazo: 'vencido'` devolve um
 * campeonato publicado cujo encerramento já passou — o cenário do briefing em
 * que a inscrição é recusada e a alteração passa a exigir chamado.
 */
async function novoCampeonato(mestre, {
  nome, modalidade = 'futebol', vagas = 8, prazo = 'aberto', publicar = true
} = {}) {
  const datas = prazo === 'vencido'
    ? { abertura: emDias(-60), encerramento: emDias(-10), realizacao: emDias(-5) }
    : { abertura: emDias(-10), encerramento: emDias(30), realizacao: emDias(40) };

  const criado = await mestre.post('/api/campeonatos', {
    nome: nome || `Copa de Teste ${Date.now().toString(36)}`,
    modalidade,
    vagas,
    data: datas.realizacao,
    dataFim: datas.realizacao,
    local: 'Arena de Teste',
    aberturaInscricoes: datas.abertura,
    encerramentoInscricoes: datas.encerramento,
    termos: 'Termos de teste.'
  });

  if (criado.status !== 201) {
    throw new Error(`Não consegui criar o campeonato: ${criado.status} ${criado.texto}`);
  }

  if (publicar) {
    const publicado = await mestre.post(`/api/campeonatos/${criado.corpo.campeonato.id}/status`,
      { status: 'inscricoes' });
    if (publicado.status !== 200) {
      throw new Error(`Não consegui publicar o campeonato: ${publicado.status} ${publicado.texto}`);
    }
    return publicado.corpo.campeonato;
  }

  return criado.corpo.campeonato;
}

/** Dados de um jogador válido para a modalidade — shooter exige Steam e Faceit. */
function jogadorValido(modalidade, indice, reserva = false) {
  const base = { nome: `Atleta Teste ${indice}`, reserva };

  if (regras.MODALIDADES[modalidade] && regras.MODALIDADES[modalidade].temSteam) {
    base.steam = `7656119${String(1000000000 + indice)}`;
    base.faceit = `https://www.faceit.com/br/players/atleta${indice}`;
  } else {
    base.numero = indice;
  }

  return base;
}

/** Time com elenco no mínimo exigido pela modalidade — pronto para inscrever. */
async function novoTime(dono, { modalidade = 'futebol', nome, titulares, reservas = 0 } = {}) {
  const limites = regras.MODALIDADES[modalidade];
  const quantos = titulares === undefined ? limites.jogadoresMin : titulares;

  const criado = await dono.post('/api/times', {
    nome: nome || `Time de Teste ${Date.now().toString(36)}-${Math.floor(Math.random() * 1000)}`,
    modalidade,
    ...(limites.temCategoria ? { categoria: 'Amador' } : {})
  });

  if (criado.status !== 201) {
    throw new Error(`Não consegui criar o time: ${criado.status} ${criado.texto}`);
  }

  const time = criado.corpo.time;

  for (let i = 1; i <= quantos; i += 1) {
    const r = await dono.post(`/api/times/${time.id}/jogadores`, jogadorValido(modalidade, i));
    if (r.status !== 201) throw new Error(`Não consegui incluir o titular ${i}: ${r.texto}`);
  }
  for (let i = 1; i <= reservas; i += 1) {
    const r = await dono.post(`/api/times/${time.id}/jogadores`,
      jogadorValido(modalidade, 90 + i, true));
    if (r.status !== 201) throw new Error(`Não consegui incluir a reserva ${i}: ${r.texto}`);
  }

  return time;
}

/* --------------------------------------------------------------------------
   CONSULTAS DE APOIO
   -------------------------------------------------------------------------- */

/** Contagem de inscrições direto da tabela — o gabarito do que a API devolve. */
function contagensNoBanco(campeonatoId) {
  const l = db.um(
    `SELECT SUM(CASE WHEN status <> 'cancelada' THEN 1 ELSE 0 END) AS inscritos,
            SUM(CASE WHEN status =  'oficial'   THEN 1 ELSE 0 END) AS oficial,
            SUM(CASE WHEN status =  'espera'    THEN 1 ELSE 0 END) AS espera,
            SUM(CASE WHEN status =  'triagem'   THEN 1 ELSE 0 END) AS triagem,
            SUM(CASE WHEN status =  'cancelada' THEN 1 ELSE 0 END) AS canceladas
       FROM inscricoes WHERE campeonato_id = ?`,
    campeonatoId
  ) || {};

  return {
    inscritos: l.inscritos || 0,
    oficial: l.oficial || 0,
    espera: l.espera || 0,
    triagem: l.triagem || 0,
    canceladas: l.canceladas || 0
  };
}

/** O e-mail mais recente gravado em emails_enviados. */
const ultimoEmail = () => db.um('SELECT * FROM emails_enviados ORDER BY data DESC, rowid DESC LIMIT 1');

/** Os `n` e-mails mais recentes, do mais novo para o mais antigo. */
const ultimosEmails = (n = 5) => db.todos(
  'SELECT * FROM emails_enviados ORDER BY data DESC, rowid DESC LIMIT ?', n
);

/** Último registro de auditoria de uma área. */
const ultimaAuditoria = (area) => db.um(
  'SELECT * FROM auditoria WHERE area = ? ORDER BY id DESC LIMIT 1', area
);

module.exports = {
  /* módulos do servidor, para os testes que precisam olhar o banco */
  db, auth, regras, mapa, api, RAIZ,

  /* ciclo de vida */
  subir, descer,
  get base() { return BASE; },

  /* clientes */
  cliente, sessao, entrar, anonimo,
  comoMaster, comoGestor, comoOperacao, comoCompetidor,
  ipUnico,

  /* fixtures */
  novoCompetidor, novoAdmin, novoCampeonato, novoTime, jogadorValido,

  /* consultas */
  contagensNoBanco, ultimoEmail, ultimosEmails, ultimaAuditoria,

  /* constantes */
  CONTAS, SEMEADOS, SENHA_ADMIN, SENHA_COMPETIDOR,
  emDias, hoje
};
